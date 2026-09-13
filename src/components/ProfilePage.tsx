'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { fetchMe, updateProfile, AuthError, clearAuth, logout } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';

export function ProfilePage() {
  const router = useRouter();
  const { t } = useI18n();
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
        setError(t('profile.sessionExpired'));
        clearAuth();
      } else {
        setError(err.message || t('profile.loadFailed'));
      }
    } finally {
      setLoading(false);
    }
  }, [t]);

  // 首次加载
  useEffect(() => { loadProfile(); }, [loadProfile]);

  // 保存修改
  const handleSave = async () => {
    setSaving(true); setMsg(''); setError('');
    try {
      const result = await updateProfile({ nickname: nickname.trim() || undefined });
      setUserState(result);
      setMsg(t('profile.saveSuccess'));
      setEditing(false);
    } catch (err: any) {
      setError(err.message || t('profile.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  // ===== 加载中 =====
  if (loading) {
    return (
      <div className="card" style={{ maxWidth: 480, margin: '40px auto' }}>
        <div className="empty">
          <div className="etx">{t('profile.loading')}</div>
        </div>
      </div>
    );
  }

  // ===== 未登录 =====
  if (error && !user) {
    return (
      <div className="card" style={{ maxWidth: 480, margin: '40px auto' }}>
        <div className="empty">
          <div className="alert alert-dan">{error}</div>
          <div className="bar-actions" style={{ justifyContent: 'center' }}>
            <button className="btn-p" onClick={() => window.location.reload()}>
              {t('profile.refresh')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!user) return null;

  // ===== 已登录 → 渲染个人信息 =====
  return (
    <div className="card" style={{ maxWidth: 480, margin: '40px auto' }}>
      {/* 返回首页 */}
      <Link href="/" className="btn-o" style={{ display: 'inline-block', marginBottom: '20px' }}>
        {t('profile.backHome')}
      </Link>

      {/* 头像和用户名 */}
      <div className="prof" style={{ marginBottom: '24px' }}>
        {/* 首字母头像 */}
        <div className="ava">
          {(user.nickname || user.username || '?').charAt(0).toUpperCase()}
        </div>

        <div>
          <div className="nm">{user.nickname || user.username}</div>
          <div className="id">
            @{user.username}
            {user.displayId && (
              <span className="mchip">#{user.displayId}</span>
            )}
          </div>
        </div>
      </div>

      {/* 详情 */}
      <div style={{ marginBottom: '20px' }}>
        <div className="kv">
          <span className="lb">{t('profile.email')}</span>
          <span className="vl">
            {user.email || t('profile.notBound')}
            {user.email_verified ? (
              <span className="bdg bdg-ok">{t('profile.verified')}</span>
            ) : user.email ? (
              <span className="bdg bdg-warn">{t('profile.unverified')}</span>
            ) : null}
          </span>
        </div>
        <div className="kv">
          <span className="lb">{t('profile.registeredAt')}</span>
          <span className="vl mono">{user.created_at?.slice(0, 10) || '-'}</span>
        </div>
      </div>

      {/* 游戏统计 */}
      {stats && (
        <div className="stats stats-3" style={{ marginBottom: '20px' }}>
          <div className="stat">
            <div className="lb">{t('profile.totalGames')}</div>
            <div className="vl">{stats.totalGames}</div>
          </div>
          <div className="stat">
            <div className="lb">{t('profile.wins')}</div>
            <div className="vl">{stats.wins}</div>
          </div>
          <div className="stat">
            <div className="lb">{t('profile.losses')}</div>
            <div className="vl">{stats.losses}</div>
          </div>
        </div>
      )}

      {/* 编辑模式 */}
      {editing ? (
        <div>
          <div className="cfg-row">
            <label className="cfg-lb">{t('profile.nickname')}</label>
            <input
              className="search-input bare"
              value={nickname}
              onChange={e => setNickname(e.target.value)}
              placeholder={t('profile.nicknamePlaceholder')}
              maxLength={30}
            />
          </div>
          {msg && <p className="alert alert-ok">{msg}</p>}
          {error && <p className="alert alert-dan">{error}</p>}
          <div className="bar-actions">
            <button className="btn-p" onClick={handleSave} disabled={saving}>
              {saving ? t('profile.saving') : t('profile.save')}
            </button>
            <button className="btn-o" onClick={() => { setEditing(false); setError(''); setMsg(''); }}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <div className="bar-actions">
          <button className="btn-p" onClick={() => setEditing(true)}>
            {t('profile.editProfile')}
          </button>
          <button className="btn-o btn-dan" onClick={() => { logout().finally(() => router.push('/')); }}>
            {t('profile.logout')}
          </button>
        </div>
      )}
    </div>
  );
}
