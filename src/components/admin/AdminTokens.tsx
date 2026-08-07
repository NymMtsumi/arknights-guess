'use client';

import { useState, useEffect, useCallback } from 'react';
import { getServerUrl, getToken } from '@/lib/auth';

interface TokenInfo {
  id: number;
  name: string;
  prefix: string;
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
}

const cardStyle: React.CSSProperties = {
  background: 'var(--card)',
  borderRadius: 'var(--radius)',
  padding: '20px',
  marginBottom: '16px',
};

const inpStyle: React.CSSProperties = {
  padding: '8px 12px',
  background: 'var(--input-bg)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
  fontSize: '0.9rem',
};

const btnStyle: React.CSSProperties = {
  padding: '8px 16px',
  background: 'var(--primary)',
  color: 'var(--bg)',
  border: 'none',
  borderRadius: 'var(--radius)',
  fontSize: '0.85rem',
  fontWeight: 700,
  cursor: 'pointer',
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
};

export default function AdminTokens() {
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [newToken, setNewToken] = useState(''); // 一次性展示

  const baseUrl = getServerUrl();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const token = getToken();
      const res = await fetch(`${baseUrl}/api/admin/tokens`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('加载失败');
      const data = await res.json();
      setTokens(data.tokens || data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [baseUrl]);

  useEffect(() => { load(); }, [load]);

  const createToken = async () => {
    if (!name.trim()) { setError('令牌名称不能为空'); return; }
    setCreating(true); setMsg(''); setError('');
    try {
      const token = getToken();
      const res = await fetch(`${baseUrl}/api/admin/tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ name: name.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '创建失败');
      setNewToken(data.token);
      setName('');
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const revokeToken = async (id: number) => {
    if (!window.confirm('确定吊销此令牌？吊销后所有使用此令牌的 API 调用将立即失效。')) return;
    setMsg(''); setError('');
    try {
      const token = getToken();
      const res = await fetch(`${baseUrl}/api/admin/tokens/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '吊销失败');
      setMsg('令牌已吊销');
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div>
      {/* 新令牌展示 */}
      {newToken && (
        <div style={{ ...cardStyle, border: '2px solid #f0ad4e', marginBottom: '16px' }}>
          <h4 style={{ margin: '0 0 8px', color: '#f0ad4e' }}>⚠️ 新令牌已生成（仅显示一次）</h4>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-light)', margin: '0 0 8px' }}>
            请立即复制并安全保存此令牌。关闭此提示后，完整令牌将不再可见。
          </p>
          <code style={{
            display: 'block', padding: '10px', background: 'var(--input-bg)',
            borderRadius: 'var(--radius)', wordBreak: 'break-all', fontSize: '0.85rem',
            fontFamily: 'monospace', marginBottom: '8px',
          }}>
            {newToken}
          </code>
          <button onClick={() => {
            try { navigator.clipboard.writeText(newToken); } catch {}
            setNewToken(''); setMsg('令牌已复制到剪贴板');
          }} style={btnStyle}>
            复制并关闭
          </button>
        </div>
      )}

      {/* 创建表单 */}
      <div style={cardStyle}>
        <h3 style={{ margin: '0 0 12px', fontSize: '1rem' }}>生成新令牌</h3>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="令牌名称（如 VPS Deploy、Discord Bot）"
            maxLength={64}
            style={{ ...inpStyle, flex: 1 }}
          />
          <button onClick={createToken} style={btnStyle} disabled={creating}>
            {creating ? '生成中...' : '生成'}
          </button>
        </div>
      </div>

      {msg && <p style={{ color: 'var(--correct)', fontSize: '0.8rem', marginBottom: '10px' }}>{msg}</p>}
      {error && <p style={{ color: 'var(--danger)', fontSize: '0.8rem', marginBottom: '10px' }}>{error}</p>}

      {/* 令牌列表 */}
      <div style={{ ...cardStyle, overflowX: 'auto' }}>
        <h3 style={{ margin: '0 0 12px', fontSize: '1rem' }}>已有令牌 ({tokens.length})</h3>
        {loading ? (
          <p style={{ textAlign: 'center', color: 'var(--text-light)', padding: '20px' }}>加载中...</p>
        ) : tokens.length === 0 ? (
          <p style={{ textAlign: 'center', color: 'var(--text-light)', padding: '20px' }}>暂无令牌</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--border)' }}>
                <th style={thStyle}>名称</th>
                <th style={thStyle}>令牌</th>
                <th style={thStyle}>创建者</th>
                <th style={thStyle}>创建时间</th>
                <th style={thStyle}>最后使用</th>
                <th style={thStyle}>状态</th>
                <th style={thStyle}>操作</th>
              </tr>
            </thead>
            <tbody>
              {tokens.map(t => (
                <tr key={t.id} style={{ borderBottom: '1px solid var(--border)', opacity: t.revoked ? 0.5 : 1 }}>
                  <td style={tdStyle}><strong>{t.name}</strong></td>
                  <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: '0.75rem', color: 'var(--text-light)' }}>{t.prefix}</td>
                  <td style={tdStyle}>{t.createdBy}</td>
                  <td style={{ ...tdStyle, fontSize: '0.75rem', color: 'var(--text-light)' }}>
                    {t.createdAt?.slice(0, 16)?.replace('T', ' ')}
                  </td>
                  <td style={{ ...tdStyle, fontSize: '0.75rem', color: 'var(--text-light)' }}>
                    {t.lastUsedAt ? t.lastUsedAt.slice(0, 16).replace('T', ' ') : '—'}
                  </td>
                  <td style={tdStyle}>
                    <span style={{
                      fontSize: '0.7rem', padding: '2px 6px', borderRadius: '3px',
                      background: t.revoked ? 'rgba(255,101,120,0.15)' : 'rgba(74,222,128,0.15)',
                      color: t.revoked ? 'var(--danger)' : 'var(--correct)',
                      fontWeight: 700,
                    }}>
                      {t.revoked ? '已吊销' : '活跃'}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    {!t.revoked && (
                      <button onClick={() => revokeToken(t.id)} style={{
                        padding: '4px 10px', fontSize: '0.75rem', background: 'var(--danger)', color: '#fff',
                        border: 'none', borderRadius: '3px', cursor: 'pointer', fontWeight: 600,
                      }}>
                        吊销
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
