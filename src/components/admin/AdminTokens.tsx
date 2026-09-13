'use client';

import { useState, useEffect, useCallback } from 'react';
import { getServerUrl, getToken } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';

interface TokenInfo {
  id: number;
  name: string;
  /** 迁移前创建的令牌没有前缀，服务端返回 null */
  prefix: string | null;
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
}

export default function AdminTokens() {
  const { t } = useI18n();
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
      if (!res.ok) throw new Error(t('admin.common.loadFailed'));
      const data = await res.json();
      setTokens(data.tokens || data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [baseUrl, t]);

  useEffect(() => { load(); }, [load]);

  const createToken = async () => {
    if (!name.trim()) { setError(t('admin.tokens.nameRequired')); return; }
    setCreating(true); setMsg(''); setError('');
    try {
      const token = getToken();
      const res = await fetch(`${baseUrl}/api/admin/tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ name: name.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('admin.tokens.createFailed'));
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
    if (!window.confirm(t('admin.tokens.revokeConfirm'))) return;
    setMsg(''); setError('');
    try {
      const token = getToken();
      const res = await fetch(`${baseUrl}/api/admin/tokens/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('admin.tokens.revokeFailed'));
      setMsg(t('admin.tokens.revoked'));
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div>
      {/* 新令牌展示 —— 安全不变量：只在创建后展示一次，关闭即清空（原样保留） */}
      {newToken && (
        <div className="card once">
          <div className="card-hd">
            <h2>{t('admin.tokens.newTitle')}</h2>
          </div>
          <div className="once-tok">
            <code>{newToken}</code>
            <button className="btn-o" onClick={() => {
              try { navigator.clipboard.writeText(newToken); } catch {}
              setNewToken(''); setMsg(t('admin.tokens.copied'));
            }}>
              {t('admin.tokens.copyAndClose')}
            </button>
          </div>
          <p className="once-hint">{t('admin.tokens.newHint')}</p>
        </div>
      )}

      {/* 创建表单 */}
      <div className="card">
        <div className="card-hd">
          <h2>{t('admin.tokens.createTitle')}</h2>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={t('admin.tokens.namePlaceholder')}
            maxLength={64}
            className="search-input bare"
          />
          <button onClick={createToken} className="btn-p" disabled={creating}>
            {creating ? t('admin.tokens.creating') : t('admin.tokens.create')}
          </button>
        </div>
      </div>

      {msg && <p className="alert alert-ok">{msg}</p>}
      {error && <p className="alert alert-dan">{error}</p>}

      {/* 令牌列表 */}
      <div className="card">
        <div className="card-hd">
          <h2>{t('admin.tokens.existing', { count: tokens.length })}</h2>
        </div>
        {loading ? (
          <div className="sk"><i /><i /><i /><i /></div>
        ) : tokens.length === 0 ? (
          <div className="empty">
            <div className="etx">{t('admin.tokens.empty')}</div>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('admin.tokens.colName')}</th>
                  <th>{t('admin.tokens.colToken')}</th>
                  <th>{t('admin.tokens.colCreatedBy')}</th>
                  <th>{t('admin.tokens.colCreatedAt')}</th>
                  <th>{t('admin.tokens.colLastUsed')}</th>
                  <th>{t('admin.tokens.colStatus')}</th>
                  <th>{t('admin.tokens.colActions')}</th>
                </tr>
              </thead>
              <tbody>
                {tokens.map(tok => (
                  <tr key={tok.id} className={tok.revoked ? 'dim' : undefined}>
                    <td className="k">{tok.name}</td>
                    {/* 真实前缀（atk_ + 8 位十六进制），管理员可拿手里的令牌按位比对。
                        迁移前创建的令牌没存前缀 → 显示「旧令牌」，而不是编一个像前缀的假值：
                        假前缀比没前缀更糟，管理员会拿它去比对然后永远对不上。
                        旧令牌不套 .mono —— 等宽字体会让它看起来像个真前缀。 */}
                    <td>
                      {tok.prefix || <span>{t('admin.tokens.legacyPrefix')}</span>}
                    </td>
                    <td>{tok.createdBy}</td>
                    <td><span className="mono">{tok.createdAt?.slice(0, 16)?.replace('T', ' ')}</span></td>
                    <td><span className="mono">{tok.lastUsedAt ? tok.lastUsedAt.slice(0, 16).replace('T', ' ') : '—'}</span></td>
                    <td>
                      <span className={'bdg ' + (tok.revoked ? 'bdg-dan' : 'bdg-ok')}>
                        {tok.revoked ? t('admin.tokens.statusRevoked') : t('admin.tokens.statusActive')}
                      </span>
                    </td>
                    <td>
                      {!tok.revoked && (
                        <button onClick={() => revokeToken(tok.id)} className="btn-sm dan">
                          {t('admin.tokens.revoke')}
                        </button>
                      )}
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
