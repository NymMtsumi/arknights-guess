'use client';

import { useState, useEffect, useCallback } from 'react';
import { getServerUrl, getToken } from '@/lib/auth';

interface OnlinePlayer {
  playerKey: string;
  displayName: string;
  username: string | null;
  type: 'multi' | 'single' | 'idle';
  roomCode: string | null;
  ip: string | null;
  lastSeen: string;
}

interface OnlineStats {
  totalOnline: number;
  inMultiplayer: number;
  inSinglePlayer: number;
  idle: number;
  players: OnlinePlayer[];
}

const cardStyle: React.CSSProperties = {
  background: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
  padding: '20px',
  marginBottom: '16px',
};

const statBox: React.CSSProperties = {
  flex: 1,
  minWidth: '120px',
  padding: '14px 16px',
  borderRadius: 'var(--radius)',
  border: '1px solid var(--border)',
  textAlign: 'center',
};

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '8px 12px',
  borderBottom: '1px solid var(--border)',
  fontWeight: 700,
  fontSize: '0.82rem',
  color: 'var(--text-light)',
};

const tdStyle: React.CSSProperties = {
  padding: '8px 12px',
  borderBottom: '1px solid var(--border)',
  fontSize: '0.85rem',
};

function typeBadge(type: string): React.CSSProperties {
  const colors: Record<string, { bg: string; text: string }> = {
    multi: { bg: 'rgba(255,101,120,0.15)', text: '#ff6578' },
    single: { bg: 'rgba(77,148,255,0.15)', text: '#4d94ff' },
    idle: { bg: 'rgba(149,129,143,0.15)', text: '#95818f' },
  };
  const c = colors[type] || colors.idle;
  return {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: 'var(--radius-sm)',
    background: c.bg,
    color: c.text,
    fontSize: '0.78rem',
    fontWeight: 700,
  };
}

function typeLabel(type: string): string {
  const labels: Record<string, string> = { multi: '对战', single: '单人', idle: '浏览' };
  return labels[type] || type;
}

export default function AdminOnline() {
  const [stats, setStats] = useState<OnlineStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const baseUrl = getServerUrl();

  const load = useCallback(async () => {
    try {
      const token = getToken();
      const res = await fetch(`${baseUrl}/api/admin/online`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || '加载失败');
      }
      const data: OnlineStats = await res.json();
      setStats(data);
      setError('');
    } catch (err: any) {
      setError(err.message);
    }
    setLoading(false);
  }, [baseUrl]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [load]);

  if (loading && !stats) {
    return <p style={{ textAlign: 'center', color: 'var(--text-light)', padding: '40px' }}>加载中...</p>;
  }

  return (
    <div>
      {error && (
        <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginBottom: '12px' }}>{error}</p>
      )}

      {/* 统计卡片 */}
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '20px' }}>
        {[
          { label: '总在线', value: stats?.totalOnline ?? 0, color: 'var(--primary)' },
          { label: '多人对战', value: stats?.inMultiplayer ?? 0, color: '#ff6578' },
          { label: '单人模式', value: stats?.inSinglePlayer ?? 0, color: '#4d94ff' },
          { label: '仅浏览', value: stats?.idle ?? 0, color: '#95818f' },
        ].map(s => (
          <div key={s.label} style={{ ...statBox, borderLeft: `3px solid ${s.color}` }}>
            <div style={{ fontSize: '1.8rem', fontWeight: 900, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-light)', marginTop: '4px' }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* 玩家列表 */}
      <div style={cardStyle}>
        <h3 style={{ fontFamily: 'var(--font-display)', fontSize: '1.1rem', fontStyle: 'italic', fontWeight: 800, margin: '0 0 14px' }}>
          在线玩家 ({stats?.totalOnline ?? 0})
        </h3>

        {(!stats || stats.players.length === 0) ? (
          <p style={{ color: 'var(--text-light)', textAlign: 'center', padding: '20px' }}>暂无在线玩家</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={thStyle}>显示名</th>
                  <th style={thStyle}>用户名</th>
                  <th style={thStyle}>状态</th>
                  <th style={thStyle}>房间码</th>
                  <th style={thStyle}>IP</th>
                  <th style={thStyle}>最后活跃</th>
                </tr>
              </thead>
              <tbody>
                {stats.players.map(p => (
                  <tr key={p.playerKey}>
                    <td style={tdStyle}>{p.displayName}</td>
                    <td style={{ ...tdStyle, color: 'var(--text-light)' }}>{p.username || '-'}</td>
                    <td style={tdStyle}><span style={typeBadge(p.type)}>{typeLabel(p.type)}</span></td>
                    <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: '0.82rem' }}>{p.roomCode || '-'}</td>
                    <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: '0.72rem', color: 'var(--text-light)' }}>{p.ip || '—'}</td>
                    <td style={{ ...tdStyle, color: 'var(--text-light)', fontSize: '0.78rem' }}>
                      {p.lastSeen ? new Date(p.lastSeen).toLocaleTimeString('zh-CN') : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
