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

/** tab 表 —— 顺序即展示顺序。图标只做辨识，不承载语义。 */
const TABS: { id: Tab; icon: string; label: string }[] = [
  { id: 'dashboard', icon: '📊', label: 'admin.tabDashboard' },
  { id: 'characters', icon: '🎮', label: 'admin.tabCharacters' },
  { id: 'announcements', icon: '📢', label: 'admin.tabAnnouncements' },
  { id: 'users', icon: '👤', label: 'admin.tabUsers' },
  { id: 'guests', icon: '🎭', label: 'admin.tabGuests' },
  { id: 'online', icon: '🟢', label: 'admin.tabOnline' },
  { id: 'tokens', icon: '🔑', label: 'admin.tabTokens' },
  { id: 'auditLog', icon: '📋', label: 'admin.tabAuditLog' },
];

export default function AdminPage() {
  const { t } = useI18n();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('dashboard');
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminName, setAdminName] = useState('');
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
        setAdminName(data.nickname || data.username);
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
  // useRef guard prevents concurrent verifications on rapid tab switching.
  // The ref resets on remount (page navigation), so no cleanup effect is needed.
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
      // 仅认证错误时重定向；网络错误仅提示（不踢出管理面板）
      if (err instanceof AuthError) {
        setIsAdmin(false);
        setError(t('admin.loginExpired'));
        router.push('/');
      } else {
        setError(err.message || t('admin.verifyFailed'));
      }
    } finally {
      tabVerifyingRef.current = false;
    }
  };

  const renderTab = (which: Tab) => {
    switch (which) {
      case 'dashboard': return <AdminDashboard />;
      case 'characters': return <AdminCharacters />;
      case 'announcements': return <AdminAnnouncements />;
      case 'users': return <AdminUsers />;
      case 'guests': return <AdminGuests />;
      case 'online': return <AdminOnline />;
      case 'tokens': return <AdminTokens />;
      case 'auditLog': return <AdminAuditLog />;
    }
  };

  // ===== 校验中 =====
  if (loading) {
    return (
      <div className="ui-v12 ui-admin" style={shell}>
        <div className="gate">
          <div className="spin" />
          <p>{t('admin.verifying')}</p>
        </div>
      </div>
    );
  }

  // ===== 无权限 =====
  if (!isAdmin) {
    return (
      <div className="ui-v12 ui-admin" style={shell}>
        <div className="gate">
          <div className="gic">🔒</div>
          <h2>{t('admin.accessDenied')}</h2>
          <p>{error || t('admin.accessDeniedDesc')}</p>
          <Link href="/" className="btn-p" style={{ display: 'inline-block', marginTop: 20, textDecoration: 'none' }}>
            {t('game.back')}
          </Link>
        </div>
      </div>
    );
  }

  // ===== 管理员面板 =====
  return (
    <div className="ui-v12 ui-admin" style={shell}>
      <div className="panel-hd">
        <div>
          <h1>⚙️ {t('admin.panelTitle')}</h1>
          <div className="sub">{t('admin.panelSub')}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div className="whoami">
            <span className="pulse" />
            <b>{adminName}</b>
          </div>
          <Link href="/" className="btn-o" style={{ textDecoration: 'none' }}>
            ← {t('game.back')}
          </Link>
        </div>
      </div>

      <div className="console" style={{ marginTop: 18 }}>
        <nav className="rail">
          <div className="rail-hd">{t('admin.panelTitle')}</div>
          {TABS.map((tb) => (
            <button
              key={tb.id}
              type="button"
              className={tab === tb.id ? 'on' : undefined}
              aria-current={tab === tb.id ? 'page' : undefined}
              onClick={() => handleTabChange(tb.id)}
            >
              <span aria-hidden="true">{tb.icon}</span>
              <span>{t(tb.label)}</span>
            </button>
          ))}
        </nav>

        <div className="panes">
          {TABS.map((tb) => (
            <div key={tb.id} className={'view' + (tab === tb.id ? ' on' : '')}>
              {tab === tb.id && renderTab(tb.id)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 面板外壳。比公开页宽 —— 216px 的 rail 之外还要放得下多列表格。 */
const shell: React.CSSProperties = {
  maxWidth: '1200px',
  margin: '40px auto',
  padding: '24px',
};
