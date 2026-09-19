'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { ScrollSlider } from '@/components/ScrollSlider';
import { useI18n } from '@/lib/i18n';
import type { StatsData } from '@/lib/stats';
import type { HistoryRecord, GameRecord, MultiGameRecord } from '@/lib/stats';
import { loadStats, loadHistory, fetchHistoryFromServer, mergeHistories } from '@/lib/stats';
import { getUser, apiCall } from '@/lib/auth';
import type { ServerStats } from '@/lib/auth';

function toStatsData(s: ServerStats): StatsData {
  return {
    totalGames: s.totalGames,
    wins: s.wins,
    losses: s.losses,
    totalGuesses: s.totalGuesses,
    bestScore: s.bestScore,
  };
}

function isMultiRecord(r: HistoryRecord): r is MultiGameRecord {
  const m = (r as any).mode;
  return m === 'multi' || m === 'custom';
}

export default function StatsPage() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [serverSynced, setServerSynced] = useState(false);
  const [stats, setStats] = useState<StatsData>({ totalGames: 0, wins: 0, losses: 0, totalGuesses: 0, bestScore: 0 });
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  // 服务端口径明细（经典/多人/每日）。只有登录且服务端返回时才有值 ——
  // 本地那份统计只涵盖经典模式，拿它拆模式是没有意义的。
  const [byMode, setByMode] = useState<ServerStats['byMode'] | null>(null);

  const loadFromLocal = () => {
    setStats(loadStats());
    setHistory(loadHistory());
    setServerSynced(false);
    setByMode(null);
  };

  const fetchFromServer = useCallback(async () => {
    if (!getUser()) return;
    setLoading(true);
    // 先从本地加载一份作为基础数据
    const localHistory = loadHistory();
    const localStats = loadStats();
    try {
      const data = await apiCall('/api/me');
      // 登录用户一律以服务端为准，本地那份只在服务端不可用时兜底（见下方 catch）。
      // 原先这里是 Math.max(本地, 服务端)：两个量根本不可比 ——
      // 本地只统计经典（saveGameStats 的唯一调用点 game/page.tsx 永远传默认 mode='single'），
      // 服务端是经典+多人+每日且不含自定义。取大值是在比大小，不是合并；
      // 本地若因含自定义场次而反超，总场次就会被抬高到与排行榜更对不上。
      setStats(toStatsData(data.stats));
      setByMode(data.stats?.byMode ?? null);
      setServerSynced(true);
      // 拉取服务端历史记录并合并
      const serverHistory = await fetchHistoryFromServer(80);
      if (serverHistory.length > 0) {
        const merged = mergeHistories(localHistory, serverHistory);
        setHistory(merged);
        // 写回本地保持同步
        if (merged.length > 0) {
          try { localStorage.setItem('arknights-guess-history', JSON.stringify(merged)); } catch {}
        }
      } else {
        // 服务端无历史时，保持本地数据不变
        // setHistory 只在首次 mounted 时调用 loadHistory，这里不覆盖
        if (localHistory.length > 0) {
          setHistory(localHistory);
        }
      }
    } catch {
      // 服务端不可用 → 退回本地那份（只含经典模式，所以不展示口径明细）
      setStats(localStats);
      setByMode(null);
      setServerSynced(false);
      // 不覆盖 history —— 保持上次加载的数据
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const localHistory = loadHistory();
    setHistory(localHistory);
    setMounted(true);
    if (getUser()) {
      fetchFromServer();
    } else {
      loadFromLocal();
    }
  }, [fetchFromServer]);

  const refresh = () => {
    const freshHistory = loadHistory();
    setHistory(freshHistory);
    if (getUser()) {
      fetchFromServer();
    } else {
      loadFromLocal();
    }
  };

  const toggleExpand = (idx: number) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const winRate = stats.totalGames > 0 ? Math.round((stats.wins / stats.totalGames) * 100) : 0;
  const avgGuesses = stats.wins > 0 ? (stats.totalGuesses / stats.wins).toFixed(1) : '-';

  // 指标卡。总场次卡额外挂一条口径明细：聚合口径是「经典+多人+每日」，
  // 而排行榜的经典/多人 tab 各自只算其中一个 —— 不拆开的话玩家会看到两个
  // 不一致的「场次」而不知道谁对。
  // 标签复用排行榜 tab 的同名 i18n 键（措辞逐字相同，便于按模式对上），但注意：
  //   · 经典 / 多人 两栏与排行榜 tab 的「场次」列口径一致（同为 mode = ? 聚合）；
  //   · 每日那栏**对不上**排行榜的「每日」tab —— 那个 tab 走 /api/daily/leaderboard，
  //     算的是「当日、且仅胜局、按猜测次数排名」，与这里的「全时段每日场次」不是一个量。
  // 界面上只呈现数字、不做「对应排行榜」的声明，避免给出一个对不上的对照关系。
  type StatCard = {
    label: string; value: string; icon: string;
    breakdown?: { key: string; label: string; value: number }[];
  };
  const cards: StatCard[] = [
    {
      label: t('stats.totalGames'), value: String(stats.totalGames), icon: '🎮',
      ...(byMode ? {
        breakdown: [
          { key: 'single', label: t('leaderboard.modeSingle'), value: byMode.single },
          { key: 'multi', label: t('leaderboard.modeMulti'), value: byMode.multi },
          { key: 'daily', label: t('leaderboard.modeDaily'), value: byMode.daily },
        ],
      } : {}),
    },
    { label: t('stats.wins'), value: String(stats.wins), icon: '🏆' },
    { label: t('stats.losses'), value: String(stats.losses), icon: '💔' },
    { label: t('stats.winRate'), value: `${winRate}%`, icon: '📈' },
    { label: t('stats.avgGuesses'), value: String(avgGuesses), icon: '📊' },
    { label: t('stats.bestScore'), value: stats.bestScore > 0 ? t('stats.bestScoreValue', { count: stats.bestScore }) : '-', icon: '⭐' },
  ];

  const historyScrollRef = useRef<HTMLDivElement>(null);

  return (
    <div className="page">
      <Header />
      <div className="page-scroll">
        <div style={{ maxWidth: 'var(--content-max)', margin: '0 auto' }}>
          <div className="panel-hd">
            <div>
              <h1>{t('stats.title')}</h1>
            </div>
            <div className="bar-actions">
              <button className="btn-o" onClick={refresh}>
                🔄 {t('common.refresh')}
              </button>
              {loading && <span className="bdg bdg-no">{t('common.loading')}</span>}
              {serverSynced && !loading && (
                <span className="bdg bdg-ok">
                  ☁️ {t('common.synced')}
                </span>
              )}
            </div>
          </div>

          {!mounted ? (
            <div className="gate" style={{ marginTop: 16 }}>
              <div className="spin" />
              <p>...</p>
            </div>
          ) : stats.totalGames === 0 ? (
            <div className="gate" style={{ marginTop: 16 }}>
              <div className="gic">📭</div>
              <p>{t('stats.noData')}</p>
              <div className="bar-actions" style={{ justifyContent: 'center' }}>
                <button className="btn-p" onClick={() => router.push('/game')}>
                  {t('menu.classic')}
                </button>
              </div>
            </div>
          ) : (
            <div className="stats stats-3" style={{ marginTop: 16 }}>
              {cards.map(item => (
                <div key={item.label} className="stat">
                  <div className="lb">{item.icon} {item.label}</div>
                  <div className="vl">{item.value}</div>
                  {item.breakdown && (
                    <div className="bd">
                      {item.breakdown.map(b => (
                        <span key={b.key}>{b.label} <b>{b.value}</b></span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* 最近战绩 */}
          {mounted && (
            <div className="card">
              <div className="card-hd">
                <h2>📋 {t('stats.recentGames', { count: 80 })}</h2>
              </div>
              {history.length === 0 ? (
                <div className="empty">
                  <div className="etx">{t('stats.emptyHistory')}</div>
                </div>
              ) : (
              <>
              <div ref={historyScrollRef} style={{ scrollBehavior: 'smooth' }} className="table-wrap scroll-slider-container">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th className="num">#</th>
                      <th>{t('stats.table.targetOpponent')}</th>
                      <th>{t('stats.table.mode')}</th>
                      <th>{t('stats.table.result')}</th>
                      <th>{t('stats.table.details')}</th>
                      <th>{t('stats.table.time')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((rec, i) => {
                      const multi = isMultiRecord(rec);
                      const isCustom = multi && rec.mode === 'custom';
                      return (
                        <>
                          <tr
                            key={rec.timestamp + '-' + i}
                            onClick={() => multi && toggleExpand(i)}
                            style={{ cursor: multi ? 'pointer' : 'default' }}
                          >
                            <td className="num">{i + 1}</td>
                            <td className="k">
                              {multi ? (
                                <span>{rec.opponentName} <span className="mono">(BO{rec.bestOf})</span></span>
                              ) : (
                                (rec as GameRecord).targetName
                              )}
                            </td>
                            <td>
                              <span className={multi && !isCustom ? 'bdg bdg-mc' : 'bdg bdg-no'}>
                                {isCustom ? t('stats.diffCustom') : multi ? t('stats.diffMulti') : t((rec as GameRecord).difficulty === 'easy' ? 'stats.diffEasy' : (rec as GameRecord).difficulty === 'medium' ? 'stats.diffMedium' : 'stats.diffHard')}
                              </span>
                            </td>
                            <td>
                              <span className={rec.won ? 'bdg bdg-ok' : 'bdg bdg-dan'}>
                                {rec.won ? '✅' : '❌'}
                              </span>
                            </td>
                            <td>
                              {multi ? (
                                <span>
                                  {rec.myScore}:{rec.opponentScore}
                                  {expanded.has(i) ? ' ▲' : ' ▼'}
                                </span>
                              ) : (
                                t('stats.table.guessesCount', { count: (rec as GameRecord).guessCount })
                              )}
                            </td>
                            <td className="num mono">
                              {new Date(rec.timestamp).toLocaleDateString(locale === 'zh-CN' ? 'zh-CN' : 'en-US')}
                            </td>
                          </tr>
                          {/* 展开的小局详情 */}
                          {multi && expanded.has(i) && (
                            <tr key={`exp-${i}`}>
                              <td colSpan={6} style={{ padding: 0 }}>
                                <div className="row-detail">
                                  {isCustom && rec.custom && (
                                    <div className="kv-row">
                                      <span>🎨 {t('stats.custom.attributes')}: {rec.custom.attributes.map(a => t(`table.${a === 'releaseYear' ? 'year' : a}`)).join(' / ')}</span>
                                      <span>{t('stats.custom.maxGuesses')}: {rec.custom.maxGuesses}</span>
                                      <span>{t('stats.custom.roundTime')}: {Math.round(rec.custom.roundTime / 1000)}s</span>
                                    </div>
                                  )}
                                  {rec.rounds.map((rd, ri) => (
                                    <div key={ri} className="kv-row">
                                      <span>{t('stats.table.round', { n: ri + 1 })}</span>
                                      <span className={rd.won ? 'bdg bdg-ok' : 'bdg bdg-dan'}>
                                        {rd.won ? '✅' : '❌'}
                                      </span>
                                      <span>{rd.targetName}</span>
                                      <span>{t('stats.table.guessNTimes', { count: rd.guessCount })}</span>
                                    </div>
                                  ))}
                                </div>
                              </td>
                            </tr>
                          )}
                        </>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <ScrollSlider containerRef={historyScrollRef} />
              </>
              )}
            </div>
          )}

          <div className="bar-actions" style={{ justifyContent: 'center' }}>
            <button className="btn-o" onClick={() => router.push('/')}>
              {t('game.back')}
            </button>
          </div>
          <Footer />
        </div>
      </div>
    </div>
  );
}
