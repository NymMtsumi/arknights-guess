'use client';

import { useEffect, useState } from 'react';
import { resetPassword, clearAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';

/* ⚠️ 与 /verify 同理：挂载期 effect 里不能用 t() 拼好文案再存进 state。
   locale 首次渲染固定是 'zh-CN'，挂载后才切到 localStorage 的值，
   而依赖为 [] 的 effect 捕获的是首次渲染的 t —— 英文用户会看到中文。
   所以存「键 + 参数」，渲染期再解析。
   （表单提交路径本来就在交互期执行，t 是最新的，但两边统一成一种形状更好维护。） */
type Msg = { key: string; params?: Record<string, string> } | { text: string } | null;

export default function ResetPasswordPage() {
  const { t } = useI18n();
  const [status, setStatus] = useState<'loading' | 'form' | 'ok' | 'error'>('loading');
  const [msg, setMsg] = useState<Msg>(null);
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    // ⚠️ 局部变量不能叫 t —— 会和 i18n 的翻译函数重名并把它在整个作用域里遮蔽掉
    const tok = params.get('token');
    if (!tok) { setStatus('error'); setMsg({ key: 'reset.missingToken' }); return; }
    setToken(tok);
    setStatus('form');
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || password.length < 8) {
      setMsg({ key: 'reset.passwordTooShort' });
      return;
    }
    setLoading(true);
    try {
      const result = await resetPassword(token, password);
      setStatus('ok');
      setMsg(result.message ? { text: result.message } : { key: 'reset.success' });
      // 清除旧登录状态（token_version 已递增，旧 token 失效）
      clearAuth();
    } catch (err: any) {
      setMsg(err.message ? { text: err.message } : { key: 'reset.failed' });
    } finally {
      setLoading(false);
    }
  };

  const msgText = msg && ('text' in msg ? msg.text : t(msg.key, msg.params));

  return (
    <div className="gate" style={{ maxWidth: 480, margin: '48px auto', position: 'relative', zIndex: 1 }}>
      {status === 'loading' && <p>{t('profile.loading')}</p>}

      {status === 'form' && (
        <div>
          <div className="gic">🔒</div>
          <h2>
            {t('reset.title')}
          </h2>
          <p>
            {t('reset.subtitle')}
          </p>
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column' }}>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder={t('reset.passwordPlaceholder')}
              className="search-input"
              minLength={8}
              maxLength={100}
              autoComplete="new-password"
              autoFocus
            />
            {msgText && (
              <p className="formmsg err">{msgText}</p>
            )}
            <button type="submit" className="btn-p" style={{ marginTop: 14 }} disabled={loading}>
              {loading ? t('auth.processing') : t('reset.submit')}
            </button>
          </form>
        </div>
      )}

      {status === 'ok' && (
        <div>
          <h2 className="alert-ok">✅ {msgText}</h2>
          <p>
            {t('reset.canLoginNow')}
          </p>
          <a href="/" className="btn-p" style={{ display: 'inline-block', marginTop: 18 }}>{t('reset.goLogin')}</a>
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
