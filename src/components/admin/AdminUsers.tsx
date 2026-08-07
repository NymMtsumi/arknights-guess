'use client';

import { useState, useEffect, useCallback } from 'react';
import { getServerUrl, getToken } from '@/lib/auth';

interface AdminUser {
  id: number;
  username: string;
  displayId: string;
  nickname: string | null;
  email: string | null;
  emailVerified: boolean;
  role: string;
  banned: boolean;
  createdAt: string;
}

interface UserPage {
  users: AdminUser[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export default function AdminUsers() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [editingNickname, setEditingNickname] = useState<{ id: number; nickname: string } | null>(null);
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
      const res = await fetch(`${baseUrl}/api/admin/users?${params}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || '加载失败');
      }
      const data: UserPage = await res.json();
      setUsers(data.users);
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

  // 搜索防抖
  useEffect(() => {
    const timer = setTimeout(() => {
      setPage(1);
      setSearch(searchInput.trim());
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const toggleBan = async (userId: number, currentBanned: boolean) => {
    const action = currentBanned ? '解封' : '封禁';
    if (!window.confirm(`确定${action}该用户？`)) return;
    setMsg(''); setError('');
    try {
      const token = getToken();
      const res = await fetch(`${baseUrl}/api/admin/users/${userId}/ban`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ banned: !currentBanned }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '操作失败');
      setMsg(`${action}成功`);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const saveNickname = async () => {
    if (!editingNickname) return;
    setMsg(''); setError('');
    try {
      const token = getToken();
      const res = await fetch(`${baseUrl}/api/admin/users/${editingNickname.id}/nickname`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ nickname: editingNickname.nickname.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '修改失败');
      setMsg('昵称已修改');
      setEditingNickname(null);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const toggleRole = async (userId: number, currentRole: string) => {
    const newRole = currentRole === 'admin' ? 'user' : 'admin';
    const action = newRole === 'admin' ? '提权为管理员' : '降级为普通用户';
    if (!window.confirm(`确定将 #${userId} ${action}？`)) return;
    setMsg(''); setError('');
    try {
      const token = getToken();
      const res = await fetch(`${baseUrl}/api/admin/users/${userId}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ role: newRole }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '操作失败');
      setMsg(`${action}成功`);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const maskEmail = (email: string): string => {
    if (!email || !email.includes('@')) return email || '—';
    const [name, domain] = email.split('@');
    if (!name || name.length === 0) return `***@${domain}`;
    if (name.length <= 2) return `${name[0]}***@${domain}`;
    return `${name[0]}***${name[name.length - 1]}@${domain}`;
  };

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
            placeholder="搜索用户名 / 显示ID / 邮箱..."
            maxLength={64}
            style={{ ...inpStyle, flex: 1 }}
          />
          <span style={{ fontSize: '0.8rem', color: 'var(--text-light)', whiteSpace: 'nowrap' }}>
            共 {total} 人
          </span>
        </div>
      </div>

      {/* 消息 */}
      {msg && <p style={{ color: 'var(--correct)', fontSize: '0.8rem', marginBottom: '10px' }}>{msg}</p>}
      {error && <p style={{ color: 'var(--danger)', fontSize: '0.8rem', marginBottom: '10px' }}>{error}</p>}

      {/* 用户列表 */}
      <div style={{ ...cardStyle, overflowX: 'auto' }}>
        {loading ? (
          <p style={{ textAlign: 'center', color: 'var(--text-light)', padding: '40px' }}>加载中...</p>
        ) : users.length === 0 ? (
          <p style={{ textAlign: 'center', color: 'var(--text-light)', padding: '40px' }}>无匹配用户</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--border)' }}>
                <th style={thStyle}>用户</th>
                <th style={thStyle}>显示ID</th>
                <th style={thStyle}>昵称</th>
                <th style={thStyle}>邮箱</th>
                <th style={thStyle}>角色</th>
                <th style={thStyle}>状态</th>
                <th style={thStyle}>操作</th>
              </tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id} style={{
                  borderBottom: '1px solid var(--border)',
                  opacity: u.banned ? 0.5 : 1,
                }}>
                  <td style={tdStyle}>
                    <strong>{u.username}</strong>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-light)' }}>#{u.id}</div>
                  </td>
                  <td style={tdStyle}>
                    <code style={{ fontSize: '0.8rem' }}>{u.displayId || '-'}</code>
                  </td>
                  <td style={tdStyle}>
                    {editingNickname?.id === u.id ? (
                      <div style={{ display: 'flex', gap: '4px' }}>
                        <input
                          value={editingNickname.nickname}
                          onChange={e => setEditingNickname({ ...editingNickname, nickname: e.target.value })}
                          maxLength={30}
                          style={{ width: '100px', padding: '4px 6px', fontSize: '0.8rem', background: 'var(--input-bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: '3px' }}
                        />
                        <button onClick={saveNickname} style={smallBtn}>✓</button>
                        <button onClick={() => setEditingNickname(null)} style={{ ...smallBtn, background: 'transparent', color: 'var(--text-light)', border: '1px solid var(--border)' }}>✗</button>
                      </div>
                    ) : (
                      <span style={{ cursor: 'pointer' }} onClick={() => setEditingNickname({ id: u.id, nickname: u.nickname || '' })} title="点击编辑">
                        {u.nickname || <span style={{ color: 'var(--text-light)' }}>—</span>}
                      </span>
                    )}
                  </td>
                  <td style={tdStyle}>
                    <span style={{ fontSize: '0.8rem' }}>{u.email ? maskEmail(u.email) : '—'}</span>
                    {u.email && (
                      <span style={{ marginLeft: '4px', fontSize: '0.65rem', color: u.emailVerified ? 'var(--correct)' : '#f0ad4e' }}>
                        {u.emailVerified ? '✓' : '!'}
                      </span>
                    )}
                  </td>
                  <td style={tdStyle}>
                    <span style={{
                      fontSize: '0.7rem',
                      padding: '2px 6px',
                      borderRadius: '3px',
                      background: u.role === 'admin' ? 'var(--primary-soft)' : 'var(--input-bg)',
                      color: u.role === 'admin' ? 'var(--primary-hover)' : 'var(--text-light)',
                    }}>
                      {u.role === 'admin' ? '管理员' : '用户'}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <span style={{ color: u.banned ? 'var(--danger)' : 'var(--correct)', fontSize: '0.8rem' }}>
                      {u.banned ? '已封禁' : '正常'}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                      <button
                        onClick={() => toggleRole(u.id, u.role)}
                        style={{
                          padding: '4px 8px',
                          fontSize: '0.7rem',
                          background: u.role === 'admin' ? '#f0ad4e' : 'var(--primary)',
                          color: u.role === 'admin' ? '#000' : '#fff',
                          border: 'none',
                          borderRadius: '3px',
                          cursor: 'pointer',
                          fontWeight: 600,
                        }}
                      >
                        {u.role === 'admin' ? '降级' : '提权'}
                      </button>
                      <button
                        onClick={() => toggleBan(u.id, u.banned)}
                        style={{
                          padding: '4px 8px',
                          fontSize: '0.7rem',
                          background: u.banned ? 'var(--correct)' : 'var(--danger)',
                          color: '#fff',
                          border: 'none',
                          borderRadius: '3px',
                          cursor: 'pointer',
                          fontWeight: 600,
                        }}
                      >
                        {u.banned ? '解封' : '封禁'}
                      </button>
                    </div>
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

const smallBtn: React.CSSProperties = {
  padding: '3px 6px',
  fontSize: '0.7rem',
  background: 'var(--primary)',
  color: 'var(--bg)',
  border: 'none',
  borderRadius: '3px',
  cursor: 'pointer',
  fontWeight: 700,
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
