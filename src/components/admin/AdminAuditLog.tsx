'use client';

import { useState, useEffect, useCallback } from 'react';
import { getServerUrl, getToken } from '@/lib/auth';

interface LogEntry {
  id: number;
  adminName: string;
  action: string;
  targetType: string;
  targetId: string;
  detail: string;
  ip: string;
  createdAt: string;
}

interface LogPage {
  logs: LogEntry[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

const cardStyle: React.CSSProperties = {
  background: 'var(--card)',
  borderRadius: 'var(--radius)',
  padding: '20px',
  overflowX: 'auto',
};

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
  fontSize: '0.82rem',
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

const actionLabels: Record<string, { label: string; color: string; bg: string }> = {
  create_announcement: { label: '创建公告', color: '#4ade80', bg: 'rgba(74,222,128,0.12)' },
  update_announcement: { label: '编辑公告', color: '#60a5fa', bg: 'rgba(96,165,250,0.12)' },
  delete_announcement: { label: '删除公告', color: '#f87171', bg: 'rgba(248,113,113,0.12)' },
  ban_user: { label: '封禁用户', color: '#f87171', bg: 'rgba(248,113,113,0.12)' },
  unban_user: { label: '解封用户', color: '#4ade80', bg: 'rgba(74,222,128,0.12)' },
  change_nickname: { label: '修改昵称', color: '#60a5fa', bg: 'rgba(96,165,250,0.12)' },
  change_role: { label: '角色变更', color: '#fbbf24', bg: 'rgba(251,191,36,0.12)' },
  create_token: { label: '生成令牌', color: '#a78bfa', bg: 'rgba(167,139,250,0.12)' },
  revoke_token: { label: '吊销令牌', color: '#f87171', bg: 'rgba(248,113,113,0.12)' },
  create_character: { label: '新增干员', color: '#4ade80', bg: 'rgba(74,222,128,0.12)' },
  update_character: { label: '编辑干员', color: '#60a5fa', bg: 'rgba(96,165,250,0.12)' },
  delete_character: { label: '删除干员', color: '#f87171', bg: 'rgba(248,113,113,0.12)' },
  import_characters: { label: '导入干员', color: '#a78bfa', bg: 'rgba(167,139,250,0.12)' },
  deploy: { label: '部署', color: '#fbbf24', bg: 'rgba(251,191,36,0.12)' },
};

const actionOptions = Object.entries(actionLabels).map(([value, info]) => ({
  value,
  label: info.label,
}));
actionOptions.unshift({ value: '', label: '全部操作' });

export default function AdminAuditLog() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [actionFilter, setActionFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const pageSize = 30;
  const baseUrl = getServerUrl();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const token = getToken();
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (actionFilter) params.set('action', actionFilter);
      const res = await fetch(`${baseUrl}/api/admin/audit-log?${params}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('加载失败');
      const data: LogPage = await res.json();
      setLogs(data.logs);
      setTotal(data.total);
      setPage(data.page);
      setTotalPages(data.totalPages);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [baseUrl, page, actionFilter]);

  useEffect(() => { load(); }, [load]);

  const getActionBadge = (action: string) => {
    const info = actionLabels[action];
    if (!info) return <span style={{ fontSize: '0.7rem', color: 'var(--text-light)' }}>{action}</span>;
    return (
      <span style={{
        fontSize: '0.7rem', padding: '3px 8px', borderRadius: '3px',
        background: info.bg, color: info.color, fontWeight: 700, whiteSpace: 'nowrap',
      }}>
        {info.label}
      </span>
    );
  };

  return (
    <div>
      {/* 筛选栏 */}
      <div style={{ ...cardStyle, marginBottom: '16px' }}>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            value={actionFilter}
            onChange={e => { setActionFilter(e.target.value); setPage(1); }}
            style={{
              padding: '8px 12px', background: 'var(--input-bg)', color: 'var(--text)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: '0.85rem',
            }}
          >
            {actionOptions.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-light)' }}>共 {total} 条记录</span>
        </div>
      </div>

      {error && <p style={{ color: 'var(--danger)', fontSize: '0.8rem', marginBottom: '10px' }}>{error}</p>}

      {/* 日志列表 */}
      <div style={cardStyle}>
        {loading ? (
          <p style={{ textAlign: 'center', color: 'var(--text-light)', padding: '40px' }}>加载中...</p>
        ) : logs.length === 0 ? (
          <p style={{ textAlign: 'center', color: 'var(--text-light)', padding: '40px' }}>暂无操作记录</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--border)' }}>
                <th style={thStyle}>时间</th>
                <th style={thStyle}>管理员</th>
                <th style={thStyle}>操作</th>
                <th style={thStyle}>目标</th>
                <th style={thStyle}>详情</th>
                <th style={thStyle}>IP</th>
              </tr>
            </thead>
            <tbody>
              {logs.map(l => (
                <tr key={l.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ ...tdStyle, fontSize: '0.75rem', color: 'var(--text-light)', whiteSpace: 'nowrap' }}>
                    {l.createdAt?.slice(0, 16)?.replace('T', ' ')}
                  </td>
                  <td style={tdStyle}><strong>{l.adminName}</strong></td>
                  <td style={tdStyle}>{getActionBadge(l.action)}</td>
                  <td style={{ ...tdStyle, fontSize: '0.75rem', color: 'var(--text-light)' }}>
                    {l.targetType ? `${l.targetType}${l.targetId ? ` #${l.targetId}` : ''}` : '—'}
                  </td>
                  <td style={{ ...tdStyle, fontSize: '0.75rem', maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {l.detail || '—'}
                  </td>
                  <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: '0.7rem', color: 'var(--text-light)' }}>
                    {l.ip || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* 分页 */}
        {totalPages > 1 && (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '12px', marginTop: '16px' }}>
            <button disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))} style={{ ...pageBtn, opacity: page <= 1 ? 0.3 : 1 }}>
              上一页
            </button>
            <span style={{ fontSize: '0.85rem', color: 'var(--text-light)' }}>{page} / {totalPages}</span>
            <button disabled={page >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))} style={{ ...pageBtn, opacity: page >= totalPages ? 0.3 : 1 }}>
              下一页
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
