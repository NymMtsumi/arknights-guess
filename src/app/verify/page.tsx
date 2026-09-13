'use client';

import { useEffect, useState } from 'react';
import { getServerUrl, setToken, setUser } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';

/* ⚠️ 提示文案**不能在 useEffect 里用 t() 拼好再塞进 state**。
   I18nProvider 的 locale 首次渲染固定是 'zh-CN'，挂载后才切到 localStorage 里的值
   （见 src/lib/i18n.tsx 的注释：初值必须是 SSR 值，否则 React #418）。
   而下面这个 effect 的依赖是 [] —— 它捕获的是**首次渲染**的 t，也就是 zh-CN 的那份。
   于是英文用户点开验证链接会看到中文提示，且不报任何错。
   把 t 加进依赖又会重新发一次请求 —— 验证 token 可能是一次性的，绝不能重放。
   所以这里只存「键 + 参数」，渲染期再解析，见下面的 msg()。 */
type Msg = { key: string; params?: Record<string, string> } | { text: string } | null;

export default function VerifyPage() {
  const { t } = useI18n();
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');
  const [msg, setMsg] = useState<Msg>(null);
  const [username, setUsername] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    if (!token) { setStatus('error'); setMsg({ key: 'verify.missingToken' }); return; }

    const apiBase = getServerUrl();
    fetch(`${apiBase}/api/verify-email?token=${encodeURIComponent(token)}`)
      .then(r => r.json())
      .then(d => {
        if (d.ok) {
          setStatus('ok');
          setMsg({ key: 'verify.emailVerified', params: { email: d.email || '' } });
          setUsername(d.username || '');

          // 自动登录：存储 token 和用户信息
          if (d.token) {
            setToken(d.token);
            setUser({
              username: d.username,
              userId: d.userId,
              displayId: d.displayId,
              email: d.email,
              nickname: d.nickname,
              role: d.role || 'user',
            });
            // 存储 player_key
            if (d.player_key) {
              try { localStorage.setItem('player_key', d.player_key); } catch {}
            }
            // 清除旧的 verify-success 标记（不再需要）
            try { localStorage.removeItem('arknights-verify-success'); } catch {}
            // 2 秒后跳转首页
            setTimeout(() => { window.location.href = '/'; }, 2000);
          }
        } else {
          setStatus('error');
          // 服务端返回的 error 已经是可直接展示的字符串，优先原样用
          setMsg(d.error ? { text: d.error } : { key: 'verify.failed' });
        }
      })
      .catch(() => { setStatus('error'); setMsg({ key: 'verify.networkError' }); });
  }, []);

  const msgText = msg && ('text' in msg ? msg.text : t(msg.key, msg.params));

  return (
    <div className="gate" style={{ maxWidth: 480, margin: '48px auto', position: 'relative', zIndex: 1 }}>
      {status === 'loading' && <p>{t('verify.verifying')}</p>}
      {status === 'ok' && (
        <div>
          <h2 className="alert-ok">✅ {msgText}</h2>
          {username && (
            <p>
              {t('verify.accountCreated', { username })}
            </p>
          )}
          <p>
            {t('verify.autoLoginRedirect')}
          </p>
          <a href="/" className="btn-p" style={{ display: 'inline-block', marginTop: 18 }}>{t('verify.goNow')}</a>
        </div>
      )}
      {status === 'error' && (
        <div>
          <h2 className="alert-dan">❌ {msgText}</h2>
          <a href="/" className="btn-o" style={{ display: 'inline-block', marginTop: 18 }}>{t('verify.backHome')}</a>
        </div>
      )}
    </div>
  );
}
