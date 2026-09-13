'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { register, login, forgotPassword, syncGames, linkPlayerKey, getUser, getPlayerKey, logout, apiCall } from '@/lib/auth';
import { loadHistory } from '@/lib/stats';
import { useI18n } from '@/lib/i18n';

interface AuthDialogProps {
  open: boolean;
  onClose: () => void;
}

export function AuthDialog({ open, onClose }: AuthDialogProps) {
  const router = useRouter();
  const { t } = useI18n();
  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(false);
  const [sendingVerify, setSendingVerify] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);
  const currentUser = typeof window !== 'undefined' ? getUser() : null;
  // 本次登录时返回的 email_verified，避免重新调用 fetchMe
  const [loginEmailVerified, setLoginEmailVerified] = useState<boolean | null>(null);
  // 检测验证成功跳转回来的标记
  const [verifySuccessMsg, setVerifySuccessMsg] = useState('');
  // 检测验证成功跳转回来的标记（在 useEffect 中执行，避免 render 期内副作用）
  useEffect(() => {
    if (open && !currentUser) {
      try {
        const raw = localStorage.getItem('arknights-verify-success');
        if (raw) {
          const data = JSON.parse(raw);
          if (Date.now() - data.ts < 600_000 && data.username) { // 10分钟内有效
            setVerifySuccessMsg(t('auth.verifySuccess', { email: data.email || '', username: data.username }));
            setMode('login');
          }
          localStorage.removeItem('arknights-verify-success');
        }
      } catch {}
    }
  }, [open]);

  if (!open) return null;

  // 登录成功后更新 email 状态
  const handleLoginSuccess = (data: any) => {
    if (data.email) {
      setLoginEmailVerified(data.email_verified ?? false);
    }
  };

  // 重新发送验证邮件
  const handleSendVerify = async () => {
    setSendingVerify(true); setMsg(''); setError('');
    try {
      await apiCall('/api/send-verification', { method: 'POST', body: JSON.stringify({ email: currentUser?.email || '' }) });
      setMsg(t('auth.verifySent'));
    } catch (e: any) { setError(e.message); }
    setSendingVerify(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setMsg('');

    if (!username.trim() || (!password && mode !== 'forgot')) {
      setError(mode === 'forgot' ? t('auth.emailRequired') : t('auth.emailPasswordRequired'));
      return;
    }
    // Client-side password length check (server-side enforces >= 8 as well)
    if ((mode === 'register' || mode === 'login') && password.length < 8) {
      setError(t('auth.passwordTooShort'));
      return;
    }
    if (mode === 'register' && !email.trim()) {
      setError(t('auth.emailRequired'));
      return;
    }

    setLoading(true);
    try {
      if (mode === 'register') {
        // 先发验证邮件再创建账号（新流程）
        const result = await register(username.trim(), password, email.trim());
        setMsg(result.message || t('auth.verifySentRegister'));
        setLoading(false);
        return; // 不关闭弹窗，不自动登录
      } else if (mode === 'forgot') {
        await forgotPassword(username.trim());
        setForgotSent(true);
        return;
      } else {
        const loginData = await login(username.trim(), password);
        handleLoginSuccess(loginData);
      }

      // After login/register, try to sync existing game history
      const pk = getPlayerKey();
      if (pk) {
        setSyncing(true);
        try {
          await linkPlayerKey(pk);
          const history = loadHistory();
          // 只同步无 pk 标签的单人记录（multi/custom 已由 login() 内的 migrateGuestDataToAccount 处理）
          const singleGames = history.filter(r => !r.player_key && !('mode' in r && (r.mode === 'multi' || r.mode === 'custom')));
          if (singleGames.length > 0) {
            await syncGames(pk, singleGames as any[]);
          }
          // Clear local game history after syncing (server is now the source of truth)
          try {
            localStorage.removeItem('arknights-guess-history');
            localStorage.removeItem('arknights-guess-stats');
          } catch {}
        } catch (syncErr: any) {
          console.warn('[Auth] Sync failed:', syncErr.message);
        }
        setSyncing(false);
      }

      onClose();
      // Force reload to update UI across components
      window.location.reload();
    } catch (err: any) {
      setError(err.message || t('auth.opFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = () => {
    logout();
    onClose();
    window.location.reload();
  };

  return (
    <div className="modal-mask">
      <div className="dlg mc">
        <div className="card-hd">
          <h2>
            {currentUser ? t('auth.hello', { name: currentUser.username }) : (mode === 'login' ? t('auth.login') : mode === 'register' ? t('auth.register') : t('auth.forgot'))}
          </h2>
          <button
            onClick={onClose}
            className="btn-sm"
          >
            ✕
          </button>
        </div>

        {currentUser ? (
          <div className="db">
            <p className="sec-note">
              {t('auth.loggedInHint')}
            </p>
            {/* 邮箱未验证提示 */}
            {currentUser.email && loginEmailVerified !== true && (
              <div className="formmsg warn">
                {t('auth.emailUnverified')}
                <button
                  type="button"
                  onClick={handleSendVerify}
                  disabled={sendingVerify}
                  className="lnk"
                >
                  {sendingVerify ? t('auth.sending') : t('auth.sendVerifyEmail')}
                </button>
              </div>
            )}
            {msg && (
              <p className="formmsg ok">
                {msg}
              </p>
            )}
            {/* 个人中心 */}
            <button onClick={() => { router.push('/profile'); }} className="btn-p" style={{ width: '100%', marginBottom: 10 }}>
              {t('auth.profile')}
            </button>
            <button onClick={handleLogout} className="btn-o btn-dan" style={{ width: '100%' }}>
              {t('auth.logout')}
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="db" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {verifySuccessMsg && (
              <p className="formmsg ok" style={{ whiteSpace: 'pre-line' }}>{verifySuccessMsg}</p>
            )}
            <div className="seg">
              <button
                type="button"
                onClick={() => setMode('login')}
                className={mode === 'login' ? 'on' : undefined}
              >
                {t('auth.login')}
              </button>
              <button
                type="button"
                onClick={() => setMode('register')}
                className={mode === 'register' ? 'on' : undefined}
              >
                {t('auth.register')}
              </button>
            </div>

            {mode === 'forgot' ? (
              // ===== 忘记密码模式 =====
              forgotSent ? (
                <div>
                  <div className="di">📧</div>
                  <p className="formmsg ok">
                    {t('auth.resetSentTitle')}
                  </p>
                  <p className="sec-note">
                    {t('auth.resetSentBody', { email: username.trim() })}
                  </p>
                  <button
                    type="button"
                    onClick={() => { setMode('login'); setForgotSent(false); setError(''); setMsg(''); }}
                    className="btn-p"
                  >
                    {t('auth.backToLogin')}
                  </button>
                </div>
              ) : (
                <>
                  <div>
                    <div className="di">🔑</div>
                    <p className="sec-note">
                      {t('auth.resetHint')}
                    </p>
                  </div>

                  <input
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    placeholder={t('auth.resetEmailPlaceholder')}
                    className="search-input"
                    maxLength={320}
                    autoComplete="email"
                    type="email"
                    autoFocus
                  />

                  {error && (
                    <p className="formmsg err">{error}</p>
                  )}

                  <button type="submit" className="btn-p" disabled={loading}>
                    {loading ? t('auth.sending') : t('auth.sendResetEmail')}
                  </button>

                  <button
                    type="button"
                    onClick={() => { setMode('login'); setForgotSent(false); setError(''); setMsg(''); }}
                    className="lnk"
                  >
                    {t('auth.backToLoginArrow')}
                  </button>
                </>
              )
            ) : (
              // ===== 登录/注册模式 =====
              <>
            {mode === 'register' && (
              <input
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder={t('auth.emailForVerifyPlaceholder')}
                className="search-input"
                autoComplete="email"
                type="email"
              />
            )}
            <input
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder={mode === 'register' ? t('auth.usernamePlaceholder') : t('auth.emailPlaceholder')}
              className="search-input"
              maxLength={mode === 'register' ? 20 : 320}
              autoComplete={mode === 'register' ? 'username' : 'email'}
            />
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder={t('auth.passwordPlaceholder')}
              className="search-input"
              maxLength={100}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />

            {error && (
              <p className="formmsg err">{error}</p>
            )}

            {syncing && (
              <p className="sec-note">
                {t('auth.syncingHistory')}
              </p>
            )}

            {msg && (
              <p className="formmsg ok">
                {msg}
              </p>
            )}

            <button type="submit" className="btn-p" disabled={loading}>
              {loading ? t('auth.processing') : (mode === 'login' ? t('auth.login') : t('auth.register'))}
            </button>

            <p className="sec-note">
              {mode === 'login' ? t('auth.noAccount') : t('auth.hasAccount')}
              <button
                type="button"
                onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}
                className="lnk"
              >
                {mode === 'login' ? t('auth.registerNow') : t('auth.goLogin')}
              </button>
            </p>

            {mode === 'login' && (
              <p className="sec-note">
                <button
                  type="button"
                  onClick={() => { setMode('forgot'); setForgotSent(false); setError(''); setMsg(''); }}
                  className="lnk"
                >
                  {t('auth.forgotLink')}
                </button>
              </p>
            )}
            </>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
