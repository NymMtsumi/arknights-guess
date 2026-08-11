'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { fetchMe, AuthError } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import AdminAnnouncements from '@/components/admin/AdminAnnouncements';
import AdminUsers from '@/components/admin/AdminUsers';
import AdminGuests from '@/components/admin/AdminGuests';
import AdminOnline from '@/components/admin/AdminOnline';
import AdminDashboard from '@/components/admin/AdminDashboard';
import AdminCharacters from '@/components/admin/AdminCharacters';
import AdminTokens from '@/components/admin/AdminTokens';
import AdminAuditLog from '@/components/admin/AdminAuditLog';

type Tab = 'dashboard' | 'characters' | 'announcements' | 'users' | 'guests' | 'online' | 'tokens' | 'auditLog';

export default function AdminPage() {
  const { t } = useI18n();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('dashboard');
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    checkAdmin();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const checkAdmin = async () => {
    setLoading(true);
    try {
      const data = await fetchMe();
      if (data.role === 'admin') {
        setIsAdmin(true);
      } else {
        setError(t('admin.noPermission'));
      }
    } catch (err: any) {
      if (err instanceof AuthError) {
        setError(t('admin.pleaseLogin'));
      } else {
        setError(err.message || t('admin.verifyFailed'));
      }
    } finally {
      setLoading(false);
    }
  };

  // Re-verify admin status on every tab switch; redirect home on failure
  // useRef guard prevents concurrent verifications on rapid tab switching
  const tabVerifyingRef = useRef(false);
  const handleTabChange = async (newTab: Tab) => {
    if (tabVerifyingRef.current) return;
    tabVerifyingRef.current = true;
    try {
      const data = await fetchMe();
      if (data.role === 'admin') {
        setTab(newTab);
      } else {
        setIsAdmin(false);
        setError(t('admin.permissionExpired'));
        router.push('/');
      }
    } catch (err: any) {
      setIsAdmin(false);
      setError(err instanceof AuthError ? t('admin.loginExpired') : t('admin.verifyFailed'));
      router.push('/');
    } finally {
      tabVerifyingRef.current = false;
    }
  };

  // ===== 样式 =====
  const pageStyle: React.CSSProperties = {
    maxWidth: '960px',
    margin: '40px auto',
    padding: '24px',
  };

  const headerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: '24px',
  };

  const titleStyle: React.CSSProperties = {
    fontFamily: 'var(--font-display)',
    fontSize: '1.5rem',
    fontStyle: 'italic',
    fontWeight: 900,
    margin: 0,
  };

  const tabsStyle: React.CSSProperties = {
    display: 'flex',
    gap: '4px',
    marginBottom: '24px',
    borderBottom: '2px solid var(--border)',
    overflowX: 'auto',
    flexWrap: 'nowrap',
    WebkitOverflowScrolling: 'touch',
  };

  const tabBtnBase: React.CSSProperties = {
    padding: '10px 20px',
    border: 'none',
    background: 'transparent',
    color: 'var(--text-light)',
    fontSize: '0.9rem',
    fontWeight: 600,
    cursor: 'pointer',
    borderBottom: '2px solid transparent',
    marginBottom: '-2px',
    transition: 'all 0.15s',
  };

  const tabBtnActive: React.CSSProperties = {
    ...tabBtnBase,
    color: 'var(--text)',
    borderBottomColor: 'var(--primary)',
  };

  const btnStyle: React.CSSProperties = {
    padding: '8px 16px',
    background: 'var(--primary)',
    color: 'var(--bg)',
    border: 'none',
    borderRadius: 'var(--radius)',
    fontSize: '0.85rem',
    fontWeight: 700,
    cursor: 'pointer',
  };

  // ===== 加载中 =====
  if (loading) {
    return (
      <div style={pageStyle}>
        <p style={{ textAlign: 'center', color: 'var(--text-light)' }}>{t('admin.verifying')}</p>
      </div>
    );
  }

  // ===== 无权限 =====
  if (!isAdmin) {
    return (
      <div style={pageStyle}>
        <div style={{
          textAlign: 'center',
          padding: '60px 20px',
          background: 'var(--card)',
          borderRadius: 'var(--radius)',
        }}>
          <p style={{ fontSize: '3rem', margin: '0 0 16px' }}>🔒</p>
          <h2 style={{ margin: '0 0 8px' }}>{t('admin.accessDenied')}</h2>
          <p style={{ color: 'var(--text-light)', margin: '0 0 20px' }}>{error || t('admin.accessDeniedDesc')}</p>
          <a href="/" style={{
            display: 'inline-block',
            padding: '10px 24px',
            background: 'var(--primary)',
            color: 'var(--bg)',
            textDecoration: 'none',
            borderRadius: 'var(--radius)',
            fontWeight: 700,
          }}>
            {t('game.back')}
          </a>
        </div>
      </div>
    );
  }

  // ===== 管理员面板 =====
  return (
    <div style={pageStyle}>
      <div style={headerStyle}>
        <h1 style={titleStyle}>⚙️ {t('admin.panelTitle')}</h1>
        <Link href="/" style={{
          padding: '8px 16px',
          background: 'var(--input-bg)',
          color: 'var(--text)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          textDecoration: 'none',
          fontSize: '0.85rem',
          fontWeight: 600,
        }}>
          ← {t('game.back')}
        </Link>
      </div>

      <div style={tabsStyle}>
        <button style={tab === 'dashboard' ? tabBtnActive : tabBtnBase} onClick={() => handleTabChange('dashboard')}>
          📊 {t('admin.tabDashboard')}
        </button>
        <button style={tab === 'characters' ? tabBtnActive : tabBtnBase} onClick={() => handleTabChange('characters')}>
          🎮 {t('admin.tabCharacters')}
        </button>
        <button style={tab === 'announcements' ? tabBtnActive : tabBtnBase} onClick={() => handleTabChange('announcements')}>
          📢 {t('admin.tabAnnouncements')}
        </button>
        <button style={tab === 'users' ? tabBtnActive : tabBtnBase} onClick={() => handleTabChange('users')}>
          👤 {t('admin.tabUsers')}
        </button>
        <button style={tab === 'guests' ? tabBtnActive : tabBtnBase} onClick={() => handleTabChange('guests')}>
          🎭 {t('admin.tabGuests')}
        </button>
        <button style={tab === 'online' ? tabBtnActive : tabBtnBase} onClick={() => handleTabChange('online')}>
          🟢 {t('admin.tabOnline')}
        </button>
        <button style={tab === 'tokens' ? tabBtnActive : tabBtnBase} onClick={() => handleTabChange('tokens')}>
          🔑 {t('admin.tabTokens')}
        </button>
        <button style={tab === 'auditLog' ? tabBtnActive : tabBtnBase} onClick={() => handleTabChange('auditLog')}>
          📋 {t('admin.tabAuditLog')}
        </button>
      </div>

      {tab === 'dashboard' && <AdminDashboard />}
      {tab === 'characters' && <AdminCharacters />}
      {tab === 'announcements' && <AdminAnnouncements />}
      {tab === 'users' && <AdminUsers />}
      {tab === 'guests' && <AdminGuests />}
      {tab === 'online' && <AdminOnline />}
      {tab === 'tokens' && <AdminTokens />}
      {tab === 'auditLog' && <AdminAuditLog />}
    </div>
  );
}
