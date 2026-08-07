'use client';

import { useEffect, useState } from 'react';
import { getServerUrl, resetPassword, clearAuth } from '@/lib/auth';

export default function ResetPasswordPage() {
  const [status, setStatus] = useState<'loading' | 'form' | 'ok' | 'error'>('loading');
  const [msg, setMsg] = useState('');
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get('token');
    if (!t) { setStatus('error'); setMsg('缺少重置 token'); return; }
    setToken(t);
    setStatus('form');
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || password.length < 8) {
      setMsg('密码至少需要 8 个字符');
      return;
    }
    setLoading(true);
    try {
      const result = await resetPassword(token, password);
      setStatus('ok');
      setMsg(result.message || '密码重置成功');
      // 清除旧登录状态（token_version 已递增，旧 token 失效）
      clearAuth();
    } catch (err: any) {
      setMsg(err.message || '重置失败');
    } finally {
      setLoading(false);
    }
  };

  const inpStyle: React.CSSProperties = {
    width: '100%',
    maxWidth: '360px',
    padding: '10px',
    background: 'var(--input-bg)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    fontSize: '1rem',
    marginBottom: '12px',
  };

  const btnStyle: React.CSSProperties = {
    width: '100%',
    maxWidth: '360px',
    padding: '10px',
    background: 'var(--primary)',
    color: 'var(--bg)',
    border: 'none',
    borderRadius: 'var(--radius)',
    fontSize: '1rem',
    fontWeight: 700,
    cursor: loading ? 'wait' : 'pointer',
    opacity: loading ? 0.7 : 1,
  };

  return (
    <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text)' }}>
      {status === 'loading' && <p>加载中...</p>}

      {status === 'form' && (
        <div>
          <h2 style={{
            fontFamily: 'var(--font-display)',
            fontSize: '1.4rem',
            fontStyle: 'italic',
            fontWeight: 900,
            marginBottom: '20px',
          }}>
            重置密码
          </h2>
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="新密码（至少 8 个字符）"
              style={inpStyle}
              minLength={8}
              maxLength={100}
              autoComplete="new-password"
              autoFocus
            />
            {msg && (
              <p style={{
                color: 'var(--danger)',
                fontSize: '0.85rem',
                marginBottom: '10px',
                maxWidth: '360px',
              }}>{msg}</p>
            )}
            <button type="submit" style={btnStyle} disabled={loading}>
              {loading ? '处理中...' : '重置密码'}
            </button>
          </form>
        </div>
      )}

      {status === 'ok' && (
        <div>
          <p style={{ fontSize: '1.5rem', color: 'var(--correct)' }}>✅ {msg}</p>
          <p style={{ color: 'var(--text-light)', marginTop: '12px', fontSize: '1rem' }}>
            现在可以使用新密码登录了
          </p>
          <a href="/" style={{
            display: 'inline-block',
            marginTop: '20px',
            padding: '12px 32px',
            background: 'var(--primary)',
            color: 'var(--bg)',
            border: 'none',
            borderRadius: 'var(--radius)',
            fontSize: '1.05rem',
            fontWeight: 700,
            textDecoration: 'none',
            cursor: 'pointer',
          }}>前往登录</a>
        </div>
      )}

      {status === 'error' && (
        <div>
          <p style={{ fontSize: '1.2rem', color: 'var(--danger)' }}>❌ {msg}</p>
          <a href="/" style={{
            display: 'inline-block',
            marginTop: '20px',
            padding: '12px 32px',
            background: 'var(--primary)',
            color: 'var(--bg)',
            border: 'none',
            borderRadius: 'var(--radius)',
            fontSize: '1.05rem',
            fontWeight: 700,
            textDecoration: 'none',
            cursor: 'pointer',
          }}>返回首页</a>
        </div>
      )}
    </div>
  );
}
