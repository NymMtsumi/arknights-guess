'use client';

import { useState } from 'react';
import { register, login, syncGames, linkPlayerKey, getUser, getPlayerKey, logout } from '@/lib/auth';
import { loadHistory } from '@/lib/stats';

interface AuthDialogProps {
  open: boolean;
  onClose: () => void;
}

export function AuthDialog({ open, onClose }: AuthDialogProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const currentUser = typeof window !== 'undefined' ? getUser() : null;

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!username.trim() || !password) {
      setError('请填写用户名和密码');
      return;
    }

    setLoading(true);
    try {
      if (mode === 'register') {
        await register(username.trim(), password);
      } else {
        await login(username.trim(), password);
      }

      // After login/register, try to sync existing game history
      const pk = getPlayerKey();
      if (pk) {
        setSyncing(true);
        try {
          await linkPlayerKey(pk);
          const history = loadHistory();
          if (history.length > 0) {
            await syncGames(pk, history);
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
            {currentUser ? `你好, ${currentUser.username}` : (mode === 'login' ? '登录' : '注册')}
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

            <input
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="用户名 (2-20个字符)"
              style={inpStyle}
              maxLength={20}
              autoComplete="username"
            />
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="密码 (至少4个字符)"
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
          </form>
        )}
      </div>
    </div>
  );
}
