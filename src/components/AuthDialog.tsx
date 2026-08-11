'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { register, login, forgotPassword, syncGames, linkPlayerKey, getUser, getPlayerKey, logout, apiCall } from '@/lib/auth';
import { loadHistory } from '@/lib/stats';

interface AuthDialogProps {
  open: boolean;
  onClose: () => void;
}

export function AuthDialog({ open, onClose }: AuthDialogProps) {
  const router = useRouter();
  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(false);
  const [sendingVerify, setSendingVerify] = useState(false);
  const [syncing, setSyncing] = useState(false);
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
            setVerifySuccessMsg(`✅ 邮箱 ${data.email || ''} 验证成功！请用账号 ${data.username} 登录`);
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
      setMsg('验证邮件已发送，请查收。如未收到请检查垃圾邮件箱');
    } catch (e: any) { setError(e.message); }
    setSendingVerify(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setMsg('');

    if (!username.trim() || (!password && mode !== 'forgot')) {
      setError(mode === 'forgot' ? '请填写邮箱' : '请填写邮箱和密码');
      return;
    }
    // Client-side password length check (server-side enforces >= 8 as well)
    if ((mode === 'register' || mode === 'login') && password.length < 8) {
      setError('密码至少需要8个字符');
      return;
    }
    if (mode === 'register' && !email.trim()) {
      setError('请填写邮箱');
      return;
    }

    setLoading(true);
    try {
      if (mode === 'register') {
        // 先发验证邮件再创建账号（新流程）
        const result = await register(username.trim(), password, email.trim());
        setMsg(result.message || '验证邮件已发送，请查收邮件并点击链接完成注册。如未收到请检查垃圾邮件箱');
        setLoading(false);
        return; // 不关闭弹窗，不自动登录
      } else if (mode === 'forgot') {
        const result = await forgotPassword(username.trim());
        setMsg(result.message || '如果该邮箱已注册，重置邮件已发送，请查收。如未收到请检查垃圾邮件箱');
        setLoading(false);
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
          // 只同步无 pk 标签的记录（有 pk 标签的记录已在游玩时通过 saveGameToServer 保存到服务器）
          const singleGames = history.filter(r => !r.player_key && !('mode' in r && r.mode === 'multi'));
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
      setError(err.message || '操作失败');
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = () => {
    logout();
    onClose();
    window.location.reload();
  };

  const inpStyle: React.CSSProperties = {
    width: '100%',
    padding: '10px',
    background: 'var(--input-bg)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    fontSize: '1rem',
    marginBottom: '10px',
  };

  const btnStyle: React.CSSProperties = {
    width: '100%',
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }}>
      <div style={{
        background: 'var(--card)',
        padding: '28px',
        borderRadius: 'var(--radius)',
        boxShadow: 'var(--shadow-lg)',
        maxWidth: '380px',
        width: '100%',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <h2 style={{
            fontFamily: 'var(--font-display)',
            fontSize: '1.3rem',
            fontStyle: 'italic',
            fontWeight: 900,
            margin: 0,
          }}>
            {currentUser ? `你好, ${currentUser.username}` : (mode === 'login' ? '登录' : mode === 'register' ? '注册' : '忘记密码')}
          </h2>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-light)',
              fontSize: '1.4rem',
              cursor: 'pointer',
              padding: '4px 8px',
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>

        {currentUser ? (
          <div>
            <p style={{ color: 'var(--text-light)', fontSize: '0.9rem', marginBottom: '16px' }}>
              已登录账号 · 游戏数据自动同步
            </p>
            {/* 邮箱未验证提示 */}
            {currentUser.email && loginEmailVerified !== true && (
              <div style={{
                background: '#fff8e1',
                color: '#8a6d14',
                padding: '10px 12px',
                borderRadius: 'var(--radius)',
                marginBottom: '14px',
                fontSize: '0.82rem',
                lineHeight: 1.5,
              }}>
                ⚠ 邮箱尚未验证。
                <button
                  type="button"
                  onClick={handleSendVerify}
                  disabled={sendingVerify}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--primary)',
                    cursor: 'pointer',
                    fontWeight: 700,
                    padding: 0,
                    marginLeft: '4px',
                    fontSize: '0.82rem',
                    textDecoration: 'underline',
                  }}
                >
                  {sendingVerify ? '发送中...' : '发送验证邮件'}
                </button>
              </div>
            )}
            {msg && (
              <p style={{ color: 'var(--correct)', fontSize: '0.82rem', marginBottom: '10px', textAlign: 'center' }}>
                {msg}
              </p>
            )}
            {/* 个人中心 */}
            <button onClick={() => { router.push('/profile'); }} style={{
              ...btnStyle,
              marginBottom: '10px',
            }}>
              个人中心
            </button>
            <button onClick={handleLogout} style={{
              ...btnStyle,
              background: 'transparent',
              color: 'var(--danger)',
              border: '1px solid var(--danger)',
            }}>
              退出登录
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            {verifySuccessMsg && (
              <p style={{
                color: 'var(--correct)',
                fontSize: '0.9rem',
                marginBottom: '14px',
                textAlign: 'center',
                padding: '10px',
                background: 'rgba(25, 154, 96, 0.1)',
                borderRadius: 'var(--radius)',
                border: '1px solid var(--correct)',
                whiteSpace: 'pre-line',
              }}>{verifySuccessMsg}</p>
            )}
            <div style={{ display: 'flex', gap: '0', marginBottom: '16px' }}>
              <button
                type="button"
                onClick={() => setMode('login')}
                style={{
                  flex: 1,
                  padding: '8px',
                  background: mode === 'login' ? 'var(--primary-soft)' : 'transparent',
                  color: mode === 'login' ? 'var(--primary-strong)' : 'var(--text-light)',
                  border: `1px solid ${mode === 'login' ? 'var(--primary)' : 'var(--border)'}`,
                  borderRadius: 'var(--radius) 0 0 var(--radius)',
                  fontWeight: mode === 'login' ? 700 : 400,
                  cursor: 'pointer',
                  fontSize: '0.9rem',
                }}
              >
                登录
              </button>
              <button
                type="button"
                onClick={() => setMode('register')}
                style={{
                  flex: 1,
                  padding: '8px',
                  background: mode === 'register' ? 'var(--primary-soft)' : 'transparent',
                  color: mode === 'register' ? 'var(--primary-strong)' : 'var(--text-light)',
                  border: `1px solid ${mode === 'register' ? 'var(--primary)' : 'var(--border)'}`,
                  borderRadius: '0 var(--radius) var(--radius) 0',
                  fontWeight: mode === 'register' ? 700 : 400,
                  cursor: 'pointer',
                  fontSize: '0.9rem',
                }}
              >
                注册
              </button>
            </div>

            {mode === 'forgot' ? (
              // ===== 忘记密码模式 =====
              <>
                <p style={{ color: 'var(--text-light)', fontSize: '0.85rem', marginBottom: '16px', textAlign: 'center' }}>
                  输入注册邮箱，我们将发送密码重置链接
                </p>
                <input
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  placeholder="注册邮箱"
                  style={inpStyle}
                  maxLength={320}
                  autoComplete="email"
                  type="email"
                  autoFocus
                />

                {error && (
                  <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginBottom: '10px' }}>{error}</p>
                )}
                {msg && (
                  <p style={{ color: 'var(--correct)', fontSize: '0.85rem', marginBottom: '10px', textAlign: 'center' }}>
                    {msg}
                  </p>
                )}

                <button type="submit" style={btnStyle} disabled={loading}>
                  {loading ? '发送中...' : '发送重置邮件'}
                </button>

                <p style={{ color: 'var(--text-light)', fontSize: '0.75rem', marginTop: '12px', textAlign: 'center' }}>
                  记起来了？
                  <button
                    type="button"
                    onClick={() => { setMode('login'); setError(''); setMsg(''); }}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--primary)',
                      cursor: 'pointer',
                      fontWeight: 700,
                      padding: '0 4px',
                      fontSize: '0.75rem',
                    }}
                  >
                    返回登录
                  </button>
                </p>
              </>
            ) : (
              // ===== 登录/注册模式 =====
              <>
            {mode === 'register' && (
              <input
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="邮箱（用于验证）"
                style={inpStyle}
                autoComplete="email"
                type="email"
              />
            )}
            <input
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder={mode === 'register' ? '用户名 (2-20个字符)' : '邮箱'}
              style={inpStyle}
              maxLength={mode === 'register' ? 20 : 320}
              autoComplete={mode === 'register' ? 'username' : 'email'}
            />
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="密码 (至少8个字符)"
              style={inpStyle}
              maxLength={100}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />

            {error && (
              <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginBottom: '10px' }}>{error}</p>
            )}

            {syncing && (
              <p style={{ color: 'var(--text-light)', fontSize: '0.8rem', marginBottom: '10px' }}>
                正在同步历史数据...
              </p>
            )}

            {msg && (
              <p style={{ color: 'var(--correct)', fontSize: '0.85rem', marginBottom: '10px', textAlign: 'center' }}>
                {msg}
              </p>
            )}

            <button type="submit" style={btnStyle} disabled={loading}>
              {loading ? '处理中...' : (mode === 'login' ? '登录' : '注册')}
            </button>

            <p style={{ color: 'var(--text-light)', fontSize: '0.75rem', marginTop: '12px', textAlign: 'center' }}>
              {mode === 'login' ? '还没有账号？' : '已有账号？'}
              <button
                type="button"
                onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--primary)',
                  cursor: 'pointer',
                  fontWeight: 700,
                  padding: '0 4px',
                  fontSize: '0.75rem',
                }}
              >
                {mode === 'login' ? '立即注册' : '去登录'}
              </button>
            </p>

            {mode === 'login' && (
              <p style={{ textAlign: 'center', marginTop: '6px' }}>
                <button
                  type="button"
                  onClick={() => { setMode('forgot'); setError(''); setMsg(''); }}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--text-light)',
                    cursor: 'pointer',
                    fontSize: '0.75rem',
                    textDecoration: 'underline',
                    padding: 0,
                  }}
                >
                  忘记密码？
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
