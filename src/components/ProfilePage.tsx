'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { fetchMe, updateProfile, AuthError, clearAuth, logout } from '@/lib/auth';

export function ProfilePage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [user, setUserState] = useState<any>(null);
  const [stats, setStats] = useState<any>(null);
  const [editing, setEditing] = useState(false);
  const [nickname, setNickname] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  // 加载用户信息
  const loadProfile = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const data = await fetchMe();
      setUserState(data);
      setStats(data.stats);
      setNickname(data.nickname || '');
    } catch (err: any) {
      if (err instanceof AuthError) {
        setError('登录已过期，请重新登录');
        clearAuth();
      } else {
        setError(err.message || '加载失败');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // 首次加载
  useEffect(() => { loadProfile(); }, [loadProfile]);

  // 保存修改
  const handleSave = async () => {
    setSaving(true); setMsg(''); setError('');
    try {
      const result = await updateProfile({ nickname: nickname.trim() || undefined });
      setUserState(result);
      setMsg('保存成功');
      setEditing(false);
    } catch (err: any) {
      setError(err.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  // ===== 样式 =====
  const cardStyle: React.CSSProperties = {
    maxWidth: '480px',
    margin: '40px auto',
    padding: '28px',
    background: 'var(--card)',
    borderRadius: 'var(--radius)',
    boxShadow: 'var(--shadow-lg)',
  };

  const btnStyle: React.CSSProperties = {
    padding: '8px 18px',
    background: 'var(--primary)',
    color: 'var(--bg)',
    border: 'none',
    borderRadius: 'var(--radius)',
    fontSize: '0.9rem',
    fontWeight: 700,
    cursor: 'pointer',
    marginRight: '10px',
  };

  const inpStyle: React.CSSProperties = {
    width: '100%',
    padding: '8px 12px',
    background: 'var(--input-bg)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    fontSize: '0.95rem',
  };

  const avatarSize = 80;

  // ===== 加载中 =====
  if (loading) {
    return (
      <div style={cardStyle}>
        <p style={{ textAlign: 'center', color: 'var(--text-light)' }}>加载中...</p>
      </div>
    );
  }

  // ===== 未登录 =====
  if (error && !user) {
    return (
      <div style={cardStyle}>
        <p style={{ textAlign: 'center', color: 'var(--danger)', marginBottom: '16px' }}>{error}</p>
        <div style={{ textAlign: 'center' }}>
          <button onClick={() => window.location.reload()} style={btnStyle}>
            刷新页面
          </button>
        </div>
      </div>
    );
  }

  if (!user) return null;

  // ===== 已登录 → 渲染个人信息 =====
  return (
    <div style={cardStyle}>
      {/* 返回首页 */}
      <Link href="/" style={{
        display: 'inline-block',
        color: 'var(--text-light)',
        fontSize: '0.85rem',
        textDecoration: 'none',
        marginBottom: '20px',
      }}>
        ← 返回首页
      </Link>

      {/* 头像和用户名 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '24px' }}>
        {/* 首字母头像 */}
        <div style={{
          width: avatarSize,
          height: avatarSize,
          borderRadius: '50%',
          background: 'var(--primary-soft)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '2rem',
          color: 'var(--primary-strong)',
          fontWeight: 900,
          border: '2px solid var(--border)',
        }}>
          {(user.nickname || user.username || '?').charAt(0).toUpperCase()}
        </div>

        <div>
          <h2 style={{
            fontFamily: 'var(--font-display)',
            fontSize: '1.3rem',
            fontStyle: 'italic',
            fontWeight: 900,
            margin: '0 0 4px 0',
          }}>
            {user.nickname || user.username}
          </h2>
          <p style={{ color: 'var(--text-light)', fontSize: '0.85rem', margin: 0 }}>
            @{user.username}
            {user.displayId && (
              <span style={{ marginLeft: '8px', fontSize: '0.78rem', color: 'var(--text-light)', background: 'var(--input-bg)', padding: '1px 6px', borderRadius: '3px' }}>
                #{user.displayId}
              </span>
            )}
          </p>
        </div>
      </div>

      {/* 详情 */}
      <div style={{ marginBottom: '20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
          <span style={{ color: 'var(--text-light)', fontSize: '0.85rem' }}>邮箱</span>
          <span style={{ fontSize: '0.85rem' }}>
            {user.email || '未绑定'}
            {user.email_verified ? (
              <span style={{ color: 'var(--correct)', marginLeft: '6px', fontSize: '0.75rem' }}>已验证</span>
            ) : user.email ? (
              <span style={{ color: '#f0ad4e', marginLeft: '6px', fontSize: '0.75rem' }}>未验证</span>
            ) : null}
          </span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
          <span style={{ color: 'var(--text-light)', fontSize: '0.85rem' }}>注册时间</span>
          <span style={{ fontSize: '0.85rem' }}>{user.created_at?.slice(0, 10) || '-'}</span>
        </div>
      </div>

      {/* 游戏统计 */}
      {stats && (
        <div style={{
          background: 'var(--input-bg)',
          borderRadius: 'var(--radius)',
          padding: '12px 16px',
          marginBottom: '20px',
          display: 'grid',
          gridTemplateColumns: '1fr 1fr 1fr',
          gap: '8px',
          textAlign: 'center',
        }}>
          <div>
            <div style={{ fontSize: '1.2rem', fontWeight: 800 }}>{stats.totalGames}</div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-light)' }}>总局数</div>
          </div>
          <div>
            <div style={{ fontSize: '1.2rem', fontWeight: 800, color: 'var(--correct)' }}>{stats.wins}</div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-light)' }}>胜利</div>
          </div>
          <div>
            <div style={{ fontSize: '1.2rem', fontWeight: 800, color: 'var(--danger)' }}>{stats.losses}</div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-light)' }}>失败</div>
          </div>
        </div>
      )}

      {/* 编辑模式 */}
      {editing ? (
        <div>
          <div style={{ marginBottom: '12px' }}>
            <label style={{ fontSize: '0.8rem', color: 'var(--text-light)', marginBottom: '4px', display: 'block' }}>昵称</label>
            <input
              value={nickname}
              onChange={e => setNickname(e.target.value)}
              placeholder="输入新昵称 (1-30字符)"
              style={inpStyle}
              maxLength={30}
            />
          </div>
          {msg && <p style={{ color: 'var(--correct)', fontSize: '0.8rem', marginBottom: '8px' }}>{msg}</p>}
          {error && <p style={{ color: 'var(--danger)', fontSize: '0.8rem', marginBottom: '8px' }}>{error}</p>}
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={handleSave} style={btnStyle} disabled={saving}>
              {saving ? '保存中...' : '保存'}
            </button>
            <button onClick={() => { setEditing(false); setError(''); setMsg(''); }} style={{
              ...btnStyle,
              background: 'transparent',
              color: 'var(--text-light)',
              border: '1px solid var(--border)',
            }}>
              取消
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: '8px' }}>
          <button onClick={() => setEditing(true)} style={btnStyle}>
            编辑资料
          </button>
          <button onClick={() => { logout().finally(() => router.push('/')); }} style={{
            ...btnStyle,
            background: 'transparent',
            color: 'var(--danger)',
            border: '1px solid var(--danger)',
          }}>
            退出登录
          </button>
        </div>
      )}
    </div>
  );
}
