'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { useI18n } from '@/lib/i18n';
import { getServerUrl } from '@/lib/auth';

interface LeaderboardEntry {
  rank: number;
  username: string;
  nickname: string | null;
  displayName: string;
  wins: number;
  totalGames: number;
  totalGuesses: number;
  winRate: number; // 0-100
}

interface DailyEntry {
  rank: number;
  username: string;
  displayName: string;
  guessCount: number;
  timestamp: string;
}

const DIFFICULTIES = [
  { key: '', labelKey: 'leaderboard.difficultyAll' },
  { key: 'easy', labelKey: 'leaderboard.difficultyEasy' },
  { key: 'medium', labelKey: 'leaderboard.difficultyMedium' },
  { key: 'hard', labelKey: 'leaderboard.difficultyHard' },
] as const;

const MODES = [
  { key: 'single', labelKey: 'leaderboard.modeSingle' },
  { key: 'multi', labelKey: 'leaderboard.modeMulti' },
  { key: 'daily', labelKey: 'leaderboard.modeDaily' },
] as const;

/** 单屏展示条数 */
const VISIBLE_ROWS = 7;
/** 最大加载条数 */
const MAX_ROWS = 50;

export default function LeaderboardPage() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [dailyEntries, setDailyEntries] = useState<DailyEntry[]>([]);
  const [dailyDate, setDailyDate] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [difficulty, setDifficulty] = useState('');
  const [mode, setMode] = useState('single');

  // 支持 URL 参数 ?mode=daily 直接跳转到每日排行榜
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const modeParam = params.get('mode');
      if (modeParam === 'daily') setMode('daily');
    }
  }, []);

  const fetchLeaderboard = useCallback(async (diff: string, m: string, signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const base = getServerUrl();

      if (m === 'daily') {
        const res = await fetch(`${base}/api/daily/leaderboard?limit=${MAX_ROWS}`, { signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setDailyEntries((data.leaderboard || []).slice(0, MAX_ROWS));
        setDailyDate(data.date || '');
        setEntries([]);
      } else {
        const params = new URLSearchParams({ limit: String(MAX_ROWS), mode: m });
        if (diff) params.set('difficulty', diff);
        const res = await fetch(`${base}/api/leaderboard?${params.toString()}`, { signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setEntries((data.leaderboard || []).slice(0, MAX_ROWS));
        setDailyEntries([]);
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') return; // ignore aborted requests
      setError(err?.message || 'Failed to fetch leaderboard');
      setEntries([]);
      setDailyEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchLeaderboard(difficulty, mode, controller.signal);
    return () => controller.abort();
  }, [difficulty, mode, fetchLeaderboard]);

  const handleDifficultyChange = (diff: string) => {
    setDifficulty(diff);
  };

  const handleModeChange = (m: string) => {
    setMode(m);
    setDifficulty('');
  };

  // Display name with graceful fallback chain: nickname → username → displayName.
  // Redundant lookups are intentional for robustness against partial API responses.
  const getDisplayName = (entry: LeaderboardEntry) => {
    return entry.nickname || entry.username || entry.displayName;
  };

  /** 计算平均猜测数，0局兜底为 "--" */
  const formatAvgGuesses = (e: LeaderboardEntry): string => {
    if (!e.totalGames || e.totalGames <= 0) return '--';
    return (e.totalGuesses / e.totalGames).toFixed(2);
  };

  const getRankEmoji = (rank: number) => {
    if (rank === 1) return '🥇';
    if (rank === 2) return '🥈';
    if (rank === 3) return '🥉';
    return '';
  };

  // 是否显示 avgGuesses 列（单人与多人模式均显示，服务端两种模式都返回 totalGuesses/totalGames）
  const showAvgGuesses = mode === 'single' || mode === 'multi';
  const isDaily = mode === 'daily';

  // 格式化时间戳
  const formatTime = (ts: string): string => {
    try {
      const d = new Date(ts);
      return d.toLocaleTimeString(locale === 'zh-CN' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch { return '--'; }
  };

  // 列宽分配（百分比）
  // 单人与多人模式均展示「平均猜测」列，故经典排行榜固定 6 列：
  //   rank 给足宽度容纳 🥇+名次，winRate/avgGuess 给足宽度容纳 "100.0%" / "11.84"，
  //   避免移动端被 text-overflow: ellipsis 截断成 "100.…"。
  const colWidths = { rank: '16%', wins: '11%', total: '11%', winRate: '17%', avgGuess: '17%' };

  // ===== 渲染 =====
  return (
    <div className="page">
      <Header />

      <div className="page-scroll">
        <div style={{ maxWidth: 'min(700px, 100%)', margin: '0 auto' }}>
          {/* 返回按钮 */}
          <div style={{ marginBottom: '8px' }}>
            <button className="btn-o" onClick={() => router.push('/')}>
              ← {t('game.back')}
            </button>
          </div>

          {/* 标题 */}
          <div className="panel-hd">
            <div>
              <h1>🏆 {t('leaderboard.title')}</h1>
            </div>
          </div>

          {/* 模式切换 */}
          <div style={{ display: 'flex', justifyContent: 'center', margin: '20px 0 14px' }}>
            <div className="seg" role="tablist">
              {MODES.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  role="tab"
                  aria-selected={mode === m.key}
                  onClick={() => handleModeChange(m.key)}
                  className={mode === m.key ? 'on' : ''}
                >
                  {t(m.labelKey)}
                </button>
              ))}
            </div>
          </div>

          {/* 难度筛选 — 多人和每日模式不显示 */}
          {mode !== 'multi' && mode !== 'daily' && (
            /* leaderboard-difficulty-bar 仅为 tests/solo-smoke.mjs 的探针保留，无对应 CSS */
            <div className="cfg-ct leaderboard-difficulty-bar" style={{ justifyContent: 'center', marginBottom: '24px' }}>
              {DIFFICULTIES.map((d) => (
                <button
                  key={d.key}
                  onClick={() => handleDifficultyChange(d.key)}
                  className={difficulty === d.key ? 'tchip on' : 'tchip off'}
                >
                  {t(d.labelKey)}
                </button>
              ))}
            </div>
          )}

          {/* 排行榜卡片 */}
          <div className="card">
            {loading ? (
              <div className="sk">
                {Array.from({ length: VISIBLE_ROWS }).map((_, i) => (
                  <i key={i} />
                ))}
              </div>
            ) : error ? (
              /* leaderboard-empty 仅为 tests/solo-smoke.mjs 的探针保留（错误态与空态共用），无对应 CSS */
              <div className="empty leaderboard-empty">
                <div className="alert alert-dan">
                  {t('leaderboard.loadError')}：{error}
                </div>
                <div className="bar-actions" style={{ justifyContent: 'center' }}>
                  <button className="btn-o" onClick={() => fetchLeaderboard(difficulty, mode)}>
                    {t('common.retry')}
                  </button>
                </div>
              </div>
            ) : (isDaily ? dailyEntries.length === 0 : entries.length === 0) ? (
              <div className="empty leaderboard-empty">
                <div className="etx">
                  📭 {isDaily ? t('leaderboard.noDataToday') : t('leaderboard.noData')}
                </div>
              </div>
            ) : isDaily ? (
              <>
              <div className="table-wrap">
                <table className="tbl">
                  <colgroup>
                    <col style={{ width: '10%' }} />
                    <col />
                    <col style={{ width: '18%' }} />
                    <col style={{ width: '22%' }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>{t('leaderboard.player')}</th>
                      <th className="num">{t('leaderboard.guessCount')}</th>
                      <th className="num">{t('leaderboard.submitTime')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dailyEntries.map((entry) => (
                      <tr key={entry.rank}>
                        <td className="k">
                          {getRankEmoji(entry.rank)} {entry.rank}
                        </td>
                        <td className="k">{entry.displayName}</td>
                        <td className="num">{entry.guessCount}</td>
                        <td className="num">{formatTime(entry.timestamp)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="pager">
                <span className="meta">
                  {dailyDate && <span>{dailyDate} · </span>}
                  {t('leaderboard.footer', { count: dailyEntries.length })}
                  {dailyEntries.length >= MAX_ROWS ? t('leaderboard.footerLimit', { count: MAX_ROWS }) : ''}
                </span>
              </div>
              </>
            ) : (
              <>
              <div className="table-wrap">
                {/* 整表铺开由页面滚动，保证全部名次可见（与移动端一致） */}
                <table className="tbl">
                  <colgroup>
                    <col style={{ width: colWidths.rank }} />
                    <col />
                    <col style={{ width: colWidths.wins }} />
                    <col style={{ width: colWidths.total }} />
                    <col style={{ width: colWidths.winRate }} />
                    {showAvgGuesses && <col style={{ width: colWidths.avgGuess }} />}
                  </colgroup>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>{t('leaderboard.player')}</th>
                      <th className="num">{t('leaderboard.wins')}</th>
                      <th className="num">{t('leaderboard.totalGames')}</th>
                      <th className="num">{t('leaderboard.winRate')}</th>
                      {showAvgGuesses && <th className="num">{t('leaderboard.avgGuesses')}</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry) => (
                      <tr key={entry.rank}>
                        <td className="k">
                          {getRankEmoji(entry.rank)} {entry.rank}
                        </td>
                        <td className="k">{getDisplayName(entry)}</td>
                        <td className="num">{entry.wins}</td>
                        <td className="num">{entry.totalGames}</td>
                        <td className="num">{(entry.winRate ?? 0).toFixed(1)}%</td>
                        {showAvgGuesses && (
                          <td className="num">{formatAvgGuesses(entry)}</td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* 总数提示 */}
              <div className="pager">
                <span className="meta">
                  {t('leaderboard.footer', { count: entries.length })}
                  {entries.length >= MAX_ROWS ? t('leaderboard.footerLimit', { count: MAX_ROWS }) : ''}
                </span>
              </div>
              </>
            )}
          </div>

          <Footer />
        </div>
      </div>
    </div>
  );
}
