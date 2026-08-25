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

/** 单行高度（px），与 CSS 中 --lb-row-height 保持一致 */
const ROW_HEIGHT = 44;
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

  const getRankStyle = (rank: number): React.CSSProperties => {
    if (rank === 1) return { color: '#ffd700', fontWeight: 900, fontSize: '1.1rem' };
    if (rank === 2) return { color: '#c0c0c0', fontWeight: 900, fontSize: '1.1rem' };
    if (rank === 3) return { color: '#cd7f32', fontWeight: 900, fontSize: '1.1rem' };
    return {};
  };

  // 斑马纹 + 前三名背景
  const getRowBackground = (rank: number, index: number): string => {
    if (rank === 1) return 'var(--leaderboard-gold-bg, rgba(255,215,0,0.12))';
    if (rank === 2) return 'var(--leaderboard-silver-bg, rgba(192,192,192,0.10))';
    if (rank === 3) return 'var(--leaderboard-bronze-bg, rgba(205,127,50,0.10))';
    return index % 2 === 0 ? 'transparent' : 'var(--card-soft)';
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

      <div
        className="page-scroll"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          paddingTop: 'clamp(28px, 5vw, 52px)',
        }}
      >
        {/* 返回按钮 */}
        <div style={{ maxWidth: 'min(700px, 100%)', margin: '0 auto 8px', width: '100%' }}>
          <button onClick={() => router.push('/')} style={{
            padding: '6px 14px',
            background: 'transparent',
            color: 'var(--text-light)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            cursor: 'pointer',
            fontSize: '0.85rem',
          }}>
            ← {t('game.back')}
          </button>
        </div>

        {/* 标题 */}
        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'clamp(2rem, 4vw, 3rem)',
            fontStyle: 'italic',
            fontWeight: 900,
            letterSpacing: '0.06em',
            marginBottom: '24px',
            textAlign: 'center',
          }}
        >
          🏆 {t('leaderboard.title')}
        </h1>

        {/* 模式切换 */}
        <div className="leaderboard-mode-tabs" role="tablist">
          {MODES.map((m) => (
            <button
              key={m.key}
              type="button"
              role="tab"
              aria-selected={mode === m.key}
              onClick={() => handleModeChange(m.key)}
              className={mode === m.key ? 'active' : ''}
            >
              {t(m.labelKey)}
            </button>
          ))}
        </div>

        {/* 难度筛选 — 多人和每日模式不显示 */}
        {mode !== 'multi' && mode !== 'daily' && (
          <div className="leaderboard-difficulty-bar">
            {DIFFICULTIES.map((d) => (
              <button
                key={d.key}
                onClick={() => handleDifficultyChange(d.key)}
                className={difficulty === d.key ? 'active' : ''}
              >
                {t(d.labelKey)}
              </button>
            ))}
          </div>
        )}

        {/* 排行榜卡片 */}
        <div className="leaderboard-card">
          {loading ? (
            <div style={{ padding: '12px 0' }}>
              {Array.from({ length: VISIBLE_ROWS }).map((_, i) => (
                <div
                  key={i}
                  className="skeleton"
                  style={{
                    height: `${ROW_HEIGHT - 4}px`,
                    marginBottom: '4px',
                    width: '100%',
                    opacity: 1 - i * 0.08, // 越往下越淡
                    animationDelay: `${i * 0.08}s`,
                  }}
                />
              ))}
            </div>
          ) : error ? (
            <div className="leaderboard-empty">
              <p style={{ color: 'var(--danger)', fontSize: '1rem', marginBottom: '16px' }}>
                {t('leaderboard.loadError')}：{error}
              </p>
              <button
                onClick={() => fetchLeaderboard(difficulty, mode)}
                style={{
                  padding: '8px 20px',
                  background: 'var(--primary)',
                  color: 'var(--bg)',
                  border: 'none',
                  borderRadius: 'var(--radius)',
                  fontWeight: 700,
                  cursor: 'pointer',
                  fontSize: '0.9rem',
                }}
              >
                {t('common.retry')}
              </button>
            </div>
          ) : (isDaily ? dailyEntries.length === 0 : entries.length === 0) ? (
            <div className="leaderboard-empty">
              <p style={{ fontSize: '3rem', marginBottom: '16px' }}>📭</p>
              <p style={{ fontSize: '1.1rem' }}>{isDaily ? t('leaderboard.noDataToday') : t('leaderboard.noData')}</p>
            </div>
          ) : isDaily ? (
            <div className="leaderboard-table-wrap">
              {/* 粘性表头 — daily */}
              <div className="leaderboard-table-header">
                <table>
                  <colgroup>
                    <col style={{ width: '10%' }} />
                    <col />
                    <col style={{ width: '18%' }} />
                    <col style={{ width: '22%' }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th className="lb-th-left">{t('leaderboard.player')}</th>
                      <th>{t('leaderboard.guessCount')}</th>
                      <th>{t('leaderboard.submitTime')}</th>
                    </tr>
                  </thead>
                </table>
              </div>

              <div className="leaderboard-table-body">
                <table>
                  <colgroup>
                    <col style={{ width: '10%' }} />
                    <col />
                    <col style={{ width: '18%' }} />
                    <col style={{ width: '22%' }} />
                  </colgroup>
                  <tbody>
                    {dailyEntries.map((entry, index) => (
                      <tr
                        key={entry.rank}
                        className={entry.rank <= 3 ? `lb-row lb-row-top${entry.rank}` : 'lb-row'}
                        style={{
                          backgroundColor: getRowBackground(entry.rank, index),
                          animationDelay: `${Math.min(index * 30, 600)}ms`,
                        }}
                      >
                        <td className="lb-rank">
                          <span style={getRankStyle(entry.rank)}>
                            {getRankEmoji(entry.rank)} {entry.rank}
                          </span>
                        </td>
                        <td className="lb-player">{entry.displayName}</td>
                        <td className="lb-stat">{entry.guessCount}</td>
                        <td className="lb-stat">{formatTime(entry.timestamp)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="leaderboard-footer">
                {dailyDate && <span>{dailyDate} · </span>}
                {t('leaderboard.footer', { count: dailyEntries.length })}
                {dailyEntries.length >= MAX_ROWS ? t('leaderboard.footerLimit', { count: MAX_ROWS }) : ''}
              </div>
            </div>
          ) : (
            <div className="leaderboard-table-wrap">
              {/* 粘性表头 */}
              <div className="leaderboard-table-header">
                <table>
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
                      <th className="lb-th-left">{t('leaderboard.player')}</th>
                      <th>{t('leaderboard.wins')}</th>
                      <th>{t('leaderboard.totalGames')}</th>
                      <th>{t('leaderboard.winRate')}</th>
                      {showAvgGuesses && <th>{t('leaderboard.avgGuesses')}</th>}
                    </tr>
                  </thead>
                </table>
              </div>

              {/* 整表铺开由页面滚动，保证全部名次可见（与移动端一致） */}
              <div className="leaderboard-table-body">
                <table>
                  <colgroup>
                    <col style={{ width: colWidths.rank }} />
                    <col />
                    <col style={{ width: colWidths.wins }} />
                    <col style={{ width: colWidths.total }} />
                    <col style={{ width: colWidths.winRate }} />
                    {showAvgGuesses && <col style={{ width: colWidths.avgGuess }} />}
                  </colgroup>
                  <tbody>
                    {entries.map((entry, index) => (
                      <tr
                        key={entry.rank}
                        className={entry.rank <= 3 ? `lb-row lb-row-top${entry.rank}` : 'lb-row'}
                        style={{
                          backgroundColor: getRowBackground(entry.rank, index),
                          animationDelay: `${Math.min(index * 30, 600)}ms`,
                        }}
                      >
                        <td className="lb-rank">
                          <span style={getRankStyle(entry.rank)}>
                            {getRankEmoji(entry.rank)} {entry.rank}
                          </span>
                        </td>
                        <td className="lb-player">{getDisplayName(entry)}</td>
                        <td className="lb-stat">{entry.wins}</td>
                        <td>{entry.totalGames}</td>
                        <td className="lb-stat">{(entry.winRate ?? 0).toFixed(1)}%</td>
                        {showAvgGuesses && (
                          <td className="lb-stat">{formatAvgGuesses(entry)}</td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* 总数提示 */}
              <div className="leaderboard-footer">
                {t('leaderboard.footer', { count: entries.length })}
                {entries.length >= MAX_ROWS ? t('leaderboard.footerLimit', { count: MAX_ROWS }) : ''}
              </div>
            </div>
          )}
        </div>

        <Footer />
      </div>

      {/* 内联样式 */}
      <style>{`
        /* ===== 模式切换标签 ===== */
        .leaderboard-mode-tabs {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          width: min(400px, 100%);
          margin: 0 auto 14px;
          padding: 3px;
          border: 1px solid var(--border);
          border-radius: var(--radius);
          background: var(--card-soft);
        }
        .leaderboard-mode-tabs button {
          min-width: 0;
          padding: 9px 12px;
          border: 0;
          border-radius: calc(var(--radius) - 1px);
          background: transparent;
          color: var(--text-sec);
          cursor: pointer;
          font: inherit;
          font-weight: 650;
          font-size: 0.88rem;
          transition: background 0.15s, color 0.15s, box-shadow 0.15s;
        }
        .leaderboard-mode-tabs button.active {
          background: var(--card);
          color: var(--text);
          box-shadow: var(--shadow-sm);
        }

        /* ===== 难度筛选 ===== */
        .leaderboard-difficulty-bar {
          display: flex;
          gap: 6px;
          justify-content: center;
          margin-bottom: 24px;
          flex-wrap: wrap;
        }
        .leaderboard-difficulty-bar button {
          padding: 5px 14px;
          font-size: 0.82rem;
          background: transparent;
          color: var(--text);
          border: 1px solid var(--border);
          border-radius: var(--radius);
          cursor: pointer;
          font-weight: 400;
          transition: all 0.15s;
        }
        .leaderboard-difficulty-bar button.active {
          background: var(--primary);
          color: var(--bg);
          border-color: var(--primary);
          font-weight: 700;
        }

        /* ===== 排行榜卡片 ===== */
        .leaderboard-card {
          width: min(700px, 100%);
          margin: 0 auto;
          background: var(--card);
          border: 1px solid var(--border);
          border-radius: var(--radius);
          /* 卡片是 page-scroll 的 flex 子项：禁止压缩 + 去掉裁剪，
             让整表自然铺开、由页面滚动，确保全部名次可见可达（否则尾部名次被裁掉） */
          flex-shrink: 0;
          overflow: visible;
        }
        .leaderboard-empty {
          text-align: center;
          padding: 56px 20px;
          color: var(--text-light);
        }

        /* ===== 表格包裹层 ===== */
        .leaderboard-table-wrap {
          position: relative;
        }

        /* ===== 表头 ===== */
        .leaderboard-table-header {
          position: static;
          background: var(--card-soft);
          border-bottom: 2px solid var(--border);
        }
        .leaderboard-table-header table {
          width: 100%;
          table-layout: fixed;
          border-collapse: collapse;
        }
        .leaderboard-table-header th {
          padding: 10px 8px;
          text-align: center;
          font-weight: 700;
          font-size: 0.78rem;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: var(--text-light);
          white-space: nowrap;
          line-height: 1.3;
        }
        .leaderboard-table-header th.lb-th-left {
          text-align: left;
          padding-left: 14px;
        }
        html[data-theme="blast"] .leaderboard-table-header th {
          color: var(--primary);
        }

        /* ===== 表体 ===== */
        .leaderboard-table-body {
          overflow: visible;
        }
        .leaderboard-table-body table {
          width: 100%;
          table-layout: fixed;
          border-collapse: collapse;
          font-size: 0.85rem;
        }
        .leaderboard-table-body td {
          padding: 11px 8px;
          text-align: center;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          line-height: 1.3;
          border-bottom: 1px solid var(--border);
        }

        /* ===== 单元格 ===== */
        .lb-rank { font-weight: 700; }
        .lb-player {
          text-align: left !important;
          padding-left: 14px !important;
          font-weight: 600;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .lb-stat { font-weight: 700; font-variant-numeric: tabular-nums; }

        /* ===== 行样式 ===== */
        .lb-row {
          animation: lb-row-enter 0.35s ease both;
          transition: background 0.15s;
        }
        .lb-row:hover {
          filter: brightness(1.04);
        }

        /* ===== 前三名奖牌行 ===== */
        .lb-row-top1 {
          border-left: 3px solid #ffd700;
          font-weight: 700;
        }
        .lb-row-top2 {
          border-left: 3px solid #c0c0c0;
          font-weight: 700;
        }
        .lb-row-top3 {
          border-left: 3px solid #cd7f32;
          font-weight: 700;
        }
        /* Blast 主题下前三名额外发光 */
        html[data-theme="blast"] .lb-row-top1 {
          box-shadow: inset 0 0 18px rgba(255,215,0,0.08);
        }
        html[data-theme="blast"] .lb-row-top2 {
          box-shadow: inset 0 0 14px rgba(192,192,192,0.06);
        }
        html[data-theme="blast"] .lb-row-top3 {
          box-shadow: inset 0 0 12px rgba(205,127,50,0.06);
        }

        @keyframes lb-row-enter {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }

        /* ===== 底部计数 ===== */
        .leaderboard-footer {
          padding: 9px 16px;
          text-align: center;
          font-size: 0.78rem;
          color: var(--text-light);
          border-top: 1px solid var(--border);
          background: var(--card-soft);
        }

        /* ===== 移动端适配 ===== */
        @media (max-width: 640px) {
          .leaderboard-card {
            border-radius: var(--radius-sm);
          }
          .leaderboard-table-header th,
          .leaderboard-table-body td {
            padding: 8px 3px;
            font-size: 0.72rem;
          }
          /* 数值列（胜率/猜测）移动端不裁剪，保证 "100.0%" 完整显示 */
          .leaderboard-table-body td.lb-stat {
            white-space: nowrap;
            overflow: visible;
            text-overflow: clip;
          }
          .leaderboard-table-header th.lb-th-left,
          .lb-player {
            padding-left: 8px !important;
          }
          .leaderboard-mode-tabs {
            width: 100%;
          }
          .leaderboard-mode-tabs button {
            padding: 8px 8px;
            font-size: 0.82rem;
          }
        }

        @media (max-width: 380px) {
          .leaderboard-table-header th,
          .leaderboard-table-body td {
            font-size: 0.65rem;
            padding: 6px 1px;
          }
          .leaderboard-table-header th.lb-th-left,
          .lb-player {
            padding-left: 4px !important;
          }
        }
      `}</style>
    </div>
  );
}
