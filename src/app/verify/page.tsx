'use client';

import { useEffect, useState } from 'react';

function getApiBase(): string {
  if (typeof window === 'undefined') return 'http://localhost:3001';
  if (window.location.hostname === 'localhost') {
    return 'http://localhost:3001';
  }
  // 用 NEXT_PUBLIC_WS_URL 推导 API 地址（与 auth.ts 中 getServerUrl 逻辑一致）
  const wsUrl = process.env.NEXT_PUBLIC_WS_URL;
  if (wsUrl && wsUrl.startsWith('https://ws.')) {
    return wsUrl;
  }
  return `${window.location.protocol}//${window.location.hostname}`;
}

export default function VerifyPage() {
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');
  const [msg, setMsg] = useState('');
  const [username, setUsername] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    if (!token) { setStatus('error'); setMsg('缺少验证 token'); return; }

    const apiBase = getApiBase();
    fetch(`${apiBase}/api/verify-email?token=${encodeURIComponent(token)}`)
      .then(r => r.json())
      .then(d => {
        if (d.ok) {
          setStatus('ok');
          setMsg(`邮箱 ${d.email} 验证成功！`);
          setUsername(d.username || ''); try { localStorage.setItem('arknights-verify-success', JSON.stringify({ email: d.email, username: d.username, ts: Date.now() })); } catch {} 
        } else {
          setStatus('error');
          setMsg(d.error || '验证失败');
        }
      })
      .catch(() => { setStatus('error'); setMsg('网络错误，请重试'); });
  }, []);

  return (
    <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text)' }}>
      {status === 'loading' && <p>验证中...</p>}
      {status === 'ok' && (
        <div>
          <p style={{ fontSize: '1.5rem', color: 'var(--correct)' }}>✅ {msg}</p>
          {username && (
            <p style={{ color: 'var(--text-light)', marginTop: '12px', fontSize: '1rem' }}>
              账号 <strong>{username}</strong> 已创建成功
            </p>
          )}
          <p style={{ color: 'var(--text-light)', marginTop: '16px' }}>
            现在可以关闭本页面，返回游戏登录了
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
        </div>
      )}
    </div>
  );
}
