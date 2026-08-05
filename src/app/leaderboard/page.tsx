'use client';

import { useEffect, useState, useCallback } from 'react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { useI18n } from '@/lib/i18n';

interface LeaderboardEntry {
  rank: number;
  username: string;
  nickname: string | null;
  displayName: string;
  wins: number;
  totalGames: number;
  winRate: number; // 0-100
}

function getApiBaseUrl(): string {
  if (typeof window === 'undefined') return 'http://localhost:3001';
  const wsUrl = process.env.NEXT_PUBLIC_WS_URL;
  if (wsUrl) {
    return wsUrl.replace('wss://', 'https://').replace('ws://', 'http://');
  }
  return 'http://localhost:3001';
}

const DIFFICULTIES = [
  { key: '', label: '全部' },
  { key: 'easy', label: '简单' },
  { key: 'medium', label: '普通' },
  { key: 'hard', label: '困难' },
] as const;

const MODES = [
  { key: 'single', label: '单人' },
  { key: 'multi', label: '多人' },
] as const;

export default function LeaderboardPage() {
  const { t } = useI18n();
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [difficulty, setDifficulty] = useState('');
  const [mode, setMode] = useState('single');

  const fetchLeaderboard = useCallback(async (diff: string, m: string) => {
    setLoading(true);
    setError(null);
    try {
      const base = getApiBaseUrl();
      const params = new URLSearchParams({ limit: '50', mode: m });
      if (diff) params.set('difficulty', diff);
      const res = await fetch(`${base}/api/leaderboard?${params.toString()}`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      setEntries(data.leaderboard || []);
    } catch (err: any) {
      setError(err?.message || 'Failed to fetch leaderboard');
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLeaderboard(difficulty, mode);
  }, [difficulty, mode, fetchLeaderboard]);

  const handleDifficultyChange = (diff: string) => {
    setDifficulty(diff);
  };

  const handleModeChange = (m: string) => {
    setMode(m);
    setDifficulty(''); // 切换模式时重置难度
  };

  const getDisplayName = (entry: LeaderboardEntry) => {
    return entry.nickname || entry.username || entry.displayName;
  };

  const getRankEmoji = (rank: number) => {
    if (rank === 1) return '🥇';
    if (rank === 2) return '🥈';
    if (rank === 3) return '🥉';
    return '';
  };

  const getRankStyle = (rank: number): React.CSSProperties => {
    if (rank === 1) return { color: '#ffd700', fontWeight: 900 };
    if (rank === 2) return { color: '#c0c0c0', fontWeight: 900 };
    if (rank === 3) return { color: '#cd7f32', fontWeight: 900 };
    return {};
  };

  const thStyle: React.CSSProperties = {
    padding: '10px 14px',
    textAlign: 'center',
    fontWeight: 700,
    fontSize: '0.8rem',
    color: 'var(--text-light)',
    borderBottom: '2px solid var(--border)',
    whiteSpace: 'nowrap',
  };

  const tdStyle: React.CSSProperties = {
    padding: '10px 14px',
    textAlign: 'center',
    whiteSpace: 'nowrap',
  };

  let content: React.ReactNode;

  if (loading) {
    content = (
      <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--text-light)' }}>
        <p style={{ fontSize: '1.1rem' }}>加载中...</p>
      </div>
    );
  } else if (error) {
    content = (
      <div style={{ textAlign: 'center', padding: '48px 0' }}>
        <p style={{ color: 'var(--danger)', fontSize: '1rem', marginBottom: '16px' }}>
          加载失败：{error}
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
          重试
        </button>
      </div>
    );
  } else if (entries.length === 0) {
    content = (
      <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--text-light)' }}>
        <p style={{ fontSize: '3rem', marginBottom: '16px' }}>📭</p>
        <p style={{ fontSize: '1.1rem' }}>暂无排行数据</p>
      </div>
    );
  } else {
    content = (
      <div style={{ overflowX: 'auto', width: '100%' }}>
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: '0.85rem',
            minWidth: '520px',
          }}
        >
          <thead>
            <tr>
              <th style={{ ...thStyle, width: '60px' }}>#</th>
              <th style={{ ...thStyle, textAlign: 'left' }}>玩家</th>
              <th style={thStyle}>胜场</th>
              <th style={thStyle}>总局数</th>
              <th style={thStyle}>胜率</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr
                key={entry.rank}
                style={{
                  borderBottom: '1px solid var(--border)',
                  background:
                    entry.rank <= 3 ? 'var(--primary-soft)' : 'transparent',
                  animation: 'surface-enter 0.35s ease both',
                }}
              >
                <td style={{ ...tdStyle, fontWeight: 700 }} {...(entry.rank <= 3 ? { 'data-rank-top': 'true' } : {})}>
                  <span style={{ ...getRankStyle(entry.rank), fontSize: entry.rank <= 3 ? '1.1rem' : '0.85rem' }}>
                    {getRankEmoji(entry.rank)} {entry.rank}
                  </span>
                </td>
                <td style={{ ...tdStyle, textAlign: 'left', fontWeight: 600 }}>
                  {getDisplayName(entry)}
                </td>
                <td style={{ ...tdStyle, fontWeight: 700 }}>{entry.wins}</td>
                <td style={tdStyle}>{entry.totalGames}</td>
                <td style={{ ...tdStyle, fontWeight: 700 }}>
                  {entry.winRate.toFixed(1)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

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
          🏆 排行榜
        </h1>

        {/* 模式切换 */}
        <div
          style={{
            display: 'flex',
            gap: '4px',
            justifyContent: 'center',
            marginBottom: '16px',
            background: 'var(--input-bg)',
            borderRadius: 'var(--radius)',
            padding: '3px',
          }}
        >
          {MODES.map((m) => (
            <button
              key={m.key}
              onClick={() => handleModeChange(m.key)}
              style={{
                padding: '6px 20px',
                fontSize: '0.85rem',
                fontWeight: mode === m.key ? 700 : 400,
                background: mode === m.key ? 'var(--primary)' : 'transparent',
                color: mode === m.key ? 'var(--bg)' : 'var(--text)',
                border: 'none',
                borderRadius: 'var(--radius)',
                cursor: 'pointer',
                transition: 'all 0.15s',
              }}
            >
              {m.label}
            </button>
          ))}
        </div>

        {/* 难度筛选 — 多人模式不显示（多人难度未区分存储） */}
        {mode !== 'multi' && (
          <div
            style={{
              display: 'flex',
              gap: '8px',
              justifyContent: 'center',
              marginBottom: '28px',
              flexWrap: 'wrap',
            }}
          >
            {DIFFICULTIES.map((d) => (
              <button
                key={d.key}
                onClick={() => handleDifficultyChange(d.key)}
                style={{
                  padding: '6px 16px',
                  fontSize: '0.85rem',
                  background:
                    difficulty === d.key ? 'var(--primary)' : 'transparent',
                  color:
                    difficulty === d.key ? 'var(--bg)' : 'var(--text)',
                  border: `1px solid ${difficulty === d.key ? 'var(--primary)' : 'var(--border)'}`,
                  borderRadius: 'var(--radius)',
                  cursor: 'pointer',
                  fontWeight: difficulty === d.key ? 700 : 400,
                  transition: 'all 0.2s ease',
                }}
              >
                {d.label}
              </button>
            ))}
          </div>
        )}

        {/* 排行榜内容 */}
        <div
          style={{
            maxWidth: '700px',
            width: '100%',
            background: 'var(--card)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            overflow: 'hidden',
          }}
        >
          {content}
        </div>

        <Footer />
      </div>
    </div>
  );
}
