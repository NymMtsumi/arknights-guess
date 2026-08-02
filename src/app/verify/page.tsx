'use client';

import { useEffect, useState } from 'react';

export default function VerifyPage() {
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    if (!token) { setStatus('error'); setMsg('缺少验证 token'); return; }

    const apiBase = window.location.hostname === 'localhost' ? 'http://localhost:3001' : 'https://arknights-guess.online';
    fetch(`${apiBase}/api/verify-email?token=${encodeURIComponent(token)}`)
      .then(r => r.json())
      .then(d => {
        if (d.ok) { setStatus('ok'); setMsg(`邮箱 ${d.email} 验证成功！`); }
        else { setStatus('error'); setMsg(d.error || '验证失败'); }
      })
      .catch(() => { setStatus('error'); setMsg('网络错误，请重试'); });
  }, []);

  return (
    <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text)' }}>
      {status === 'loading' && <p>验证中...</p>}
      {status === 'ok' && <div><p style={{ fontSize: '1.5rem', color: 'var(--correct)' }}>✅ {msg}</p><p style={{ color: 'var(--text-light)', marginTop: '16px' }}>现在可以关闭本页面了</p></div>}
      {status === 'error' && <div><p style={{ fontSize: '1.2rem', color: 'var(--danger)' }}>❌ {msg}</p></div>}
    </div>
  );
}
