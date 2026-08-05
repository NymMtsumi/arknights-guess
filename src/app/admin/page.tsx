'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { fetchMe, getUser, AuthError, clearAuth } from '@/lib/auth';
import AdminAnnouncements from '@/components/admin/AdminAnnouncements';
import AdminUsers from '@/components/admin/AdminUsers';
import AdminGuests from '@/components/admin/AdminGuests';
import AdminOnline from '@/components/admin/AdminOnline';

type Tab = 'announcements' | 'users' | 'guests' | 'online';

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>('announcements');
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    checkAdmin();
  }, []);

  const checkAdmin = async () => {
    setLoading(true);
    try {
      const data = await fetchMe();
      if (data.role === 'admin') {
        setIsAdmin(true);
      } else {
        setError('无管理员权限');
      }
    } catch (err: any) {
      if (err instanceof AuthError) {
        setError('请先登录');
      } else {
        setError(err.message || '验证失败');
      }
    } finally {
      setLoading(false);
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
        <p style={{ textAlign: 'center', color: 'var(--text-light)' }}>验证权限中...</p>
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
          <h2 style={{ margin: '0 0 8px' }}>无权限访问</h2>
          <p style={{ color: 'var(--text-light)', margin: '0 0 20px' }}>{error || '此页面仅限管理员访问'}</p>
          <a href="/" style={{
            display: 'inline-block',
            padding: '10px 24px',
            background: 'var(--primary)',
            color: 'var(--bg)',
            textDecoration: 'none',
            borderRadius: 'var(--radius)',
            fontWeight: 700,
          }}>
            返回首页
          </a>
        </div>
      </div>
    );
  }

  // ===== 管理员面板 =====
  return (
    <div style={pageStyle}>
      <div style={headerStyle}>
        <h1 style={titleStyle}>⚙️ 管理面板</h1>
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
          ← 返回首页
        </Link>
      </div>

      <div style={tabsStyle}>
        <button style={tab === 'announcements' ? tabBtnActive : tabBtnBase} onClick={() => setTab('announcements')}>
          📢 更新日志
        </button>
        <button style={tab === 'users' ? tabBtnActive : tabBtnBase} onClick={() => setTab('users')}>
          👤 用户管理
        </button>
        <button style={tab === 'guests' ? tabBtnActive : tabBtnBase} onClick={() => setTab('guests')}>
          🎭 游客管理
        </button>
        <button style={tab === 'online' ? tabBtnActive : tabBtnBase} onClick={() => setTab('online')}>
          🟢 在线玩家
        </button>
      </div>

      {tab === 'announcements' && <AdminAnnouncements />}
      {tab === 'users' && <AdminUsers />}
      {tab === 'guests' && <AdminGuests />}
      {tab === 'online' && <AdminOnline />}
    </div>
  );
}
