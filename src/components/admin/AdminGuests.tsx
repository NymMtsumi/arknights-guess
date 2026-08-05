'use client';

import { useState, useEffect, useCallback } from 'react';
import { getServerUrl, getToken } from '@/lib/auth';

interface GuestInfo {
  playerKey: string;
  displayName: string;
  totalGames: number;
  wins: number;
  lastSeen: string;
}

interface GuestPage {
  guests: GuestInfo[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export default function AdminGuests() {
  const [guests, setGuests] = useState<GuestInfo[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  const pageSize = 30;
  const baseUrl = getServerUrl();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const token = getToken();
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (search) params.set('search', search);
      const res = await fetch(`${baseUrl}/api/admin/guests?${params}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || '加载失败');
      }
      const data: GuestPage = await res.json();
      setGuests(data.guests);
      setTotal(data.total);
      setPage(data.page);
      setTotalPages(data.totalPages);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [baseUrl, page, search]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setPage(1);
      setSearch(searchInput.trim());
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // ===== 样式 =====
  const cardStyle: React.CSSProperties = {
    background: 'var(--card)',
    borderRadius: 'var(--radius)',
    padding: '20px',
  };

  const inpStyle: React.CSSProperties = {
    width: '100%',
    padding: '8px 12px',
    background: 'var(--input-bg)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    fontSize: '0.9rem',
  };

  return (
    <div>
      {/* 搜索 + 统计 */}
      <div style={{ ...cardStyle, marginBottom: '16px' }}>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <input
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            placeholder="搜索游客显示名..."
            maxLength={64}
            style={{ ...inpStyle, flex: 1 }}
          />
          <span style={{ fontSize: '0.8rem', color: 'var(--text-light)', whiteSpace: 'nowrap' }}>
            共 {total} 名游客
          </span>
        </div>
      </div>

      {msg && <p style={{ color: 'var(--correct)', fontSize: '0.8rem', marginBottom: '10px' }}>{msg}</p>}
      {error && <p style={{ color: 'var(--danger)', fontSize: '0.8rem', marginBottom: '10px' }}>{error}</p>}

      {/* 游客列表 */}
      <div style={{ ...cardStyle, overflowX: 'auto' }}>
        {loading ? (
          <p style={{ textAlign: 'center', color: 'var(--text-light)', padding: '40px' }}>加载中...</p>
        ) : guests.length === 0 ? (
          <p style={{ textAlign: 'center', color: 'var(--text-light)', padding: '40px' }}>无匹配游客</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--border)' }}>
                <th style={thStyle}>显示名</th>
                <th style={thStyle}>总局数</th>
                <th style={thStyle}>胜场</th>
                <th style={thStyle}>胜率</th>
                <th style={thStyle}>最近活跃</th>
              </tr>
            </thead>
            <tbody>
              {guests.map((g, i) => (
                <tr key={g.playerKey} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={tdStyle}>
                    <strong>{g.displayName}</strong>
                  </td>
                  <td style={tdStyle}>{g.totalGames}</td>
                  <td style={tdStyle}>
                    <span style={{ color: 'var(--correct)', fontWeight: 700 }}>{g.wins}</span>
                  </td>
                  <td style={tdStyle}>
                    {g.totalGames > 0
                      ? `${Math.round((g.wins / g.totalGames) * 100)}%`
                      : '—'}
                  </td>
                  <td style={tdStyle}>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-light)' }}>
                      {g.lastSeen?.slice(0, 16)?.replace('T', ' ') || '—'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* 分页 */}
        {totalPages > 1 && (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '12px', marginTop: '16px' }}>
            <button
              disabled={page <= 1}
              onClick={() => setPage(p => Math.max(1, p - 1))}
              style={{ ...pageBtn, opacity: page <= 1 ? 0.3 : 1 }}
            >
              上一页
            </button>
            <span style={{ fontSize: '0.85rem', color: 'var(--text-light)' }}>
              {page} / {totalPages}
            </span>
            <button
              disabled={page >= totalPages}
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              style={{ ...pageBtn, opacity: page >= totalPages ? 0.3 : 1 }}
            >
              下一页
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  padding: '10px 8px',
  textAlign: 'left',
  fontSize: '0.75rem',
  fontWeight: 700,
  color: 'var(--text-light)',
  textTransform: 'uppercase',
  whiteSpace: 'nowrap',
};

const tdStyle: React.CSSProperties = {
  padding: '8px',
  verticalAlign: 'middle',
};

const pageBtn: React.CSSProperties = {
  padding: '6px 14px',
  background: 'var(--input-bg)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
  cursor: 'pointer',
  fontSize: '0.8rem',
};
