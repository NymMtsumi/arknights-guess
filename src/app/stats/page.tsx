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

const DIFF_LABEL: Record<string, string> = { easy: '简单', medium: '普通', hard: '困难', multi: '多人' };

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
  return (r as any).mode === 'multi';
}

export default function StatsPage() {
  const { t } = useI18n();
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [serverSynced, setServerSynced] = useState(false);
  const [stats, setStats] = useState<StatsData>({ totalGames: 0, wins: 0, losses: 0, totalGuesses: 0, bestScore: 0 });
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const loadFromLocal = () => {
    setStats(loadStats());
    setHistory(loadHistory());
    setServerSynced(false);
  };

  const fetchFromServer = useCallback(async () => {
    if (!getUser()) return;
    setLoading(true);
    // 先从本地加载一份作为基础数据
    const localHistory = loadHistory();
    const localStats = loadStats();
    try {
      const data = await apiCall('/api/me');
      // 合并服务端统计：以更完整的为准
      const serverStats = toStatsData(data.stats);
      const mergedStats: StatsData = {
        totalGames: Math.max(localStats.totalGames, serverStats.totalGames),
        wins: Math.max(localStats.wins, serverStats.wins),
        losses: Math.max(localStats.losses, serverStats.losses),
        totalGuesses: Math.max(localStats.totalGuesses, serverStats.totalGuesses),
        bestScore: serverStats.bestScore > 0
          ? (localStats.bestScore > 0 ? Math.min(localStats.bestScore, serverStats.bestScore) : serverStats.bestScore)
          : localStats.bestScore,
      };
      setStats(mergedStats);
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
      // 服务端有数据则使用，否则保留本地
      setStats(localStats);
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

  const thStyle: React.CSSProperties = { padding: '8px 10px', textAlign: 'center', fontWeight: 700, fontSize: '0.8rem', color: 'var(--text-light)', borderBottom: '2px solid var(--border)', whiteSpace: 'nowrap' };
  const tdStyle: React.CSSProperties = { padding: '8px 10px', textAlign: 'center', whiteSpace: 'nowrap' };
  const historyScrollRef = useRef<HTMLDivElement>(null);

  return (
    <div className="page">
      <Header />
      <div className="page-scroll" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 'clamp(32px, 6vw, 60px)' }}>
        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'clamp(2rem, 4vw, 3rem)',
            fontStyle: 'italic',
            fontWeight: 900,
            letterSpacing: '0.06em',
            marginBottom: '32px',
            textAlign: 'center',
          }}
        >
          {t('stats.title')}
        </h1>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '20px' }}>
          <button onClick={refresh} style={{
            padding: '4px 14px', background: 'transparent',
            color: 'var(--text-light)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius)', cursor: 'pointer', fontSize: '0.8rem',
          }}>
            🔄 刷新数据
          </button>
          {loading && <span style={{ color: 'var(--text-light)', fontSize: '0.8rem' }}>加载中...</span>}
          {serverSynced && !loading && (
            <span style={{
              fontSize: '0.78rem', color: 'var(--accent)',
              background: 'var(--accent-soft, rgba(0,180,216,0.1))',
              padding: '2px 10px', borderRadius: 'var(--radius)',
            }}>
              ☁️ 已同步
            </span>
          )}
        </div>

        {!mounted ? (
          <div style={{ color: 'var(--text-light)' }}>...</div>
        ) : stats.totalGames === 0 ? (
          <div style={{ textAlign: 'center', color: 'var(--text-light)' }}>
            <p style={{ fontSize: '3rem', marginBottom: '16px' }}>📭</p>
            <p style={{ fontSize: '1.1rem' }}>{t('stats.noData')}</p>
            <button
              onClick={() => router.push('/game')}
              style={{
                marginTop: '20px',
                padding: '10px 24px',
                background: 'var(--primary)',
                color: 'var(--bg)',
                border: 'none',
                borderRadius: 'var(--radius)',
                fontWeight: 700,
                cursor: 'pointer',
                fontSize: '1rem',
              }}
            >
              {t('menu.classic')}
            </button>
          </div>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: '16px',
            maxWidth: '600px',
            width: '100%',
          }}>
            {[
              { label: t('stats.totalGames'), value: String(stats.totalGames), icon: '🎮' },
              { label: t('stats.wins'), value: String(stats.wins), icon: '🏆' },
              { label: t('stats.losses'), value: String(stats.losses), icon: '💔' },
              { label: t('stats.winRate'), value: `${winRate}%`, icon: '📈' },
              { label: t('stats.avgGuesses'), value: String(avgGuesses), icon: '📊' },
              { label: t('stats.bestScore'), value: stats.bestScore > 0 ? `${stats.bestScore} 次` : '-', icon: '⭐' },
            ].map(item => (
              <div
                key={item.label}
                className="menu-card"
                style={{
                  '--menu-color': 'var(--accent)',
                  textAlign: 'center',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '20px',
                  minHeight: 'auto',
                } as React.CSSProperties}
              >
                <span style={{ fontSize: '2rem' }}>{item.icon}</span>
                <span style={{ fontSize: 'clamp(1.5rem, 3vw, 2rem)', fontWeight: 900, color: 'var(--text)' }}>
                  {item.value}
                </span>
                <span style={{ fontSize: '0.85rem', color: 'var(--text-light)' }}>{item.label}</span>
              </div>
            ))}
          </div>
        )}

        {/* 最近战绩 */}
        {mounted && (
          <div style={{ maxWidth: '720px', width: '100%', marginTop: '32px' }}>
            <h2 style={{
              fontFamily: 'var(--font-display)',
              fontSize: 'clamp(1.2rem, 2vw, 1.5rem)',
              fontStyle: 'italic',
              fontWeight: 800,
              letterSpacing: '0.04em',
              marginBottom: '14px',
              color: 'var(--text)',
            }}>
              📋 最近 80 局
            </h2>
            {history.length === 0 ? (
              <p style={{ color: 'var(--text-light)', fontSize: '0.9rem' }}>暂无记录，完成一局游戏后自动记录</p>
            ) : (
            <>
            <div ref={historyScrollRef} style={{ overflowX: 'auto', scrollBehavior: 'smooth' }} className="scroll-slider-container">
              <table className="game-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                <thead>
                  <tr>
                    <th style={thStyle}>#</th>
                    <th style={{ ...thStyle, textAlign: 'left' }}>目标/对手</th>
                    <th style={thStyle}>模式</th>
                    <th style={thStyle}>结果</th>
                    <th style={thStyle}>详情</th>
                    <th style={thStyle}>时间</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((rec, i) => {
                    const multi = isMultiRecord(rec);
                    return (
                      <>
                        <tr
                          key={rec.timestamp + '-' + i}
                          onClick={() => multi && toggleExpand(i)}
                          style={{
                            background: rec.won ? 'var(--primary-soft)' : 'transparent',
                            borderBottom: '1px solid var(--border)',
                            cursor: multi ? 'pointer' : 'default',
                          }}
                        >
                          <td style={tdStyle}>{i + 1}</td>
                          <td style={{ ...tdStyle, textAlign: 'left', fontWeight: 600 }}>
                            {multi ? (
                              <span>{rec.opponentName} <span style={{ color: 'var(--text-light)', fontSize: '0.75rem' }}>(BO{rec.bestOf})</span></span>
                            ) : (
                              (rec as GameRecord).targetName
                            )}
                          </td>
                          <td style={tdStyle}>
                            <span style={{
                              fontSize: '0.7rem',
                              padding: '1px 6px',
                              borderRadius: '3px',
                              background: multi ? 'var(--accent-soft, rgba(0,180,216,0.1))' : 'var(--input-bg)',
                              color: multi ? 'var(--accent)' : 'var(--text-light)',
                            }}>
                              {multi ? '多人' : DIFF_LABEL[(rec as GameRecord).difficulty] || '单人'}
                            </span>
                          </td>
                          <td style={{ ...tdStyle, color: rec.won ? 'var(--correct)' : 'var(--danger)', fontWeight: 700 }}>
                            {rec.won ? '✅' : '❌'}
                          </td>
                          <td style={tdStyle}>
                            {multi ? (
                              <span style={{ fontSize: '0.8rem' }}>
                                {rec.myScore}:{rec.opponentScore}
                                {expanded.has(i) ? ' ▲' : ' ▼'}
                              </span>
                            ) : (
                              `${(rec as GameRecord).guessCount}次`
                            )}
                          </td>
                          <td style={{ ...tdStyle, color: 'var(--text-light)', fontSize: '0.78rem' }}>
                            {new Date(rec.timestamp).toLocaleDateString('zh-CN')}
                          </td>
                        </tr>
                        {/* 展开的小局详情 */}
                        {multi && expanded.has(i) && (
                          <tr key={`exp-${i}`}>
                            <td colSpan={6} style={{ padding: '0' }}>
                              <div style={{
                                background: 'var(--input-bg)',
                                padding: '8px 16px',
                                borderBottom: '2px solid var(--accent-soft, rgba(0,180,216,0.15))',
                              }}>
                                {rec.rounds.map((rd, ri) => (
                                  <div key={ri} style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '12px',
                                    padding: '4px 0',
                                    fontSize: '0.8rem',
                                    borderBottom: ri < rec.rounds.length - 1 ? '1px solid var(--border)' : 'none',
                                  }}>
                                    <span style={{ fontWeight: 700, minWidth: '40px' }}>第{ri + 1}局</span>
                                    <span style={{ color: rd.won ? 'var(--correct)' : 'var(--danger)', fontWeight: 700 }}>
                                      {rd.won ? '✅' : '❌'}
                                    </span>
                                    <span style={{ flex: 1 }}>{rd.targetName}</span>
                                    <span style={{ color: 'var(--text-light)' }}>猜测 {rd.guessCount} 次</span>
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

        <button
          onClick={() => router.push('/')}
          style={{
            marginTop: '28px',
            padding: '8px 20px',
            background: 'transparent',
            color: 'var(--text-light)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            cursor: 'pointer',
          }}
        >
          {t('game.back')}
        </button>
        <Footer />
      </div>
    </div>
  );
}
