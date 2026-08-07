'use client';

import { useState, useEffect, useCallback } from 'react';
import { getServerUrl, getToken } from '@/lib/auth';

interface DashboardData {
  totalUsers: number;
  newUsersToday: number;
  totalGames: number;
  onlineNow: number;
  recentUsers: Array<{ id: number; username: string; displayId: string; createdAt: string }>;
  recentGames: Array<{ id: number; playerKey: string; playerName: string; won: boolean; guessCount: number; difficulty: string; targetName: string; mode: string; timestamp: string }>;
  dbSize: number;
  uptime: number;
  version: string;
}

// ===== 样式 =====
const cardStyle: React.CSSProperties = {
  background: 'var(--card)',
  borderRadius: 'var(--radius)',
  padding: '20px',
  marginBottom: '16px',
};

const statBox: React.CSSProperties = {
  flex: 1,
  minWidth: '130px',
  padding: '16px 18px',
  borderRadius: 'var(--radius)',
  border: '1px solid var(--border)',
  textAlign: 'center',
};

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '8px 10px',
  borderBottom: '1px solid var(--border)',
  fontWeight: 700,
  fontSize: '0.78rem',
  color: 'var(--text-light)',
};

const tdStyle: React.CSSProperties = {
  padding: '7px 10px',
  borderBottom: '1px solid var(--border)',
  fontSize: '0.82rem',
};

export default function AdminDashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const baseUrl = getServerUrl();

  const load = useCallback(async () => {
    try {
      const token = getToken();
      const res = await fetch(`${baseUrl}/api/admin/dashboard`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || '加载失败');
      }
      const d: DashboardData = await res.json();
      setData(d);
    } catch (err: any) {
      setError(err.message);
    }
    setLoading(false);
  }, [baseUrl]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return <p style={{ textAlign: 'center', color: 'var(--text-light)', padding: '40px' }}>加载中...</p>;
  }

  if (error) {
    return <p style={{ textAlign: 'center', color: 'var(--danger)', padding: '40px' }}>{error}</p>;
  }

  if (!data) return null;

  const fmtUptime = (sec: number) => {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d > 0) return `${d}天 ${h}时`;
    if (h > 0) return `${h}时 ${m}分`;
    return `${m}分`;
  };

  const modeLabel = (mode: string, difficulty: string) => {
    if (mode === 'multi') return '多人';
    if (difficulty === 'hard') return '困难';
    if (difficulty === 'easy') return '简单';
    return difficulty || '—';
  };

  return (
    <div>
      {/* 统计卡片 */}
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '20px' }}>
        {[
          { label: '总用户', value: data.totalUsers, color: 'var(--primary)' },
          { label: '今日新增', value: data.newUsersToday, color: 'var(--correct)' },
          { label: '总游戏', value: data.totalGames, color: 'var(--primary-hover)' },
          { label: '当前在线', value: data.onlineNow, color: '#ff6578' },
        ].map(s => (
          <div key={s.label} style={{ ...statBox, borderLeft: `3px solid ${s.color}` }}>
            <div style={{ fontSize: '1.8rem', fontWeight: 900, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-light)', marginTop: '4px' }}>{s.label}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
        {/* 最近注册 */}
        <div style={cardStyle}>
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: '1rem', fontStyle: 'italic', fontWeight: 800, margin: '0 0 12px' }}>
            最近注册
          </h3>
          {data.recentUsers.length === 0 ? (
            <p style={{ color: 'var(--text-light)', fontSize: '0.8rem' }}>暂无数据</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={thStyle}>用户</th>
                  <th style={thStyle}>ID</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>注册时间</th>
                </tr>
              </thead>
              <tbody>
                {data.recentUsers.map(u => (
                  <tr key={u.id}>
                    <td style={tdStyle}><strong>{u.username}</strong></td>
                    <td style={{ ...tdStyle, color: 'var(--text-light)', fontFamily: 'monospace', fontSize: '0.75rem' }}>{u.displayId || '—'}</td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontSize: '0.72rem', color: 'var(--text-light)' }}>
                      {u.createdAt?.slice(0, 16)?.replace('T', ' ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* 最近游戏 */}
        <div style={cardStyle}>
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: '1rem', fontStyle: 'italic', fontWeight: 800, margin: '0 0 12px' }}>
            最近游戏
          </h3>
          {data.recentGames.length === 0 ? (
            <p style={{ color: 'var(--text-light)', fontSize: '0.8rem' }}>暂无数据</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={thStyle}>玩家</th>
                  <th style={thStyle}>结果</th>
                  <th style={thStyle}>目标</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>模式</th>
                </tr>
              </thead>
              <tbody>
                {data.recentGames.map(g => (
                  <tr key={g.id}>
                    <td style={tdStyle}>{g.playerName || g.playerKey || '—'}</td>
                    <td style={{ ...tdStyle, color: g.won ? 'var(--correct)' : 'var(--danger)', fontWeight: 700 }}>
                      {g.won ? '✓' : '✗'} {g.guessCount}次
                    </td>
                    <td style={{ ...tdStyle, color: 'var(--text-light)', fontSize: '0.78rem' }}>{g.targetName}</td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>
                      <span style={{
                        fontSize: '0.68rem', padding: '2px 5px', borderRadius: '3px',
                        background: g.mode === 'multi' ? 'rgba(255,101,120,0.15)' : 'rgba(77,148,255,0.15)',
                        color: g.mode === 'multi' ? '#ff6578' : '#4d94ff',
                        fontWeight: 700,
                      }}>
                        {modeLabel(g.mode || 'single', g.difficulty)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* 系统信息 */}
      <div style={{ ...cardStyle, marginTop: '16px' }}>
        <h3 style={{ fontFamily: 'var(--font-display)', fontSize: '1rem', fontStyle: 'italic', fontWeight: 800, margin: '0 0 10px' }}>
          系统信息
        </h3>
        <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap', fontSize: '0.8rem', color: 'var(--text-light)' }}>
          <span>版本: <code style={{ color: 'var(--text)' }}>{data.version}</code></span>
          <span>运行时间: <code style={{ color: 'var(--text)' }}>{fmtUptime(data.uptime)}</code></span>
          <span>数据库: <code style={{ color: 'var(--text)' }}>{data.dbSize} KB</code></span>
        </div>
      </div>
    </div>
  );
}
