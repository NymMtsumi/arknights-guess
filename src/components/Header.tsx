'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { ThemeToggle } from './ThemeToggle';
import { LanguageSwitcher } from './LanguageSwitcher';
import { AuthDialog } from './AuthDialog';
import { getUser, getServerUrl } from '@/lib/auth';

export function Header() {
  const { t } = useI18n();
  const [authOpen, setAuthOpen] = useState(false);
  const [guestName, setGuestName] = useState('');
  const user = typeof window !== 'undefined' ? getUser() : null;

  useEffect(() => {
    if (user) return;
    fetch(`${getServerUrl()}/api/guest-identity`)
      .then(res => res.json())
      .then(data => {
        if (data.displayName) setGuestName(data.displayName);
      })
      .catch(() => {}); // Silently fail
  }, [user]);

  return (
    <header className="header-bar">
      {/* 左侧：标题 */}
      <Link
        href="/"
        className="no-underline text-[var(--text)] flex items-center gap-2 hover:text-[var(--primary)] transition-colors"
      >
        <span
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: '1.125rem',
            fontWeight: 800,
            fontStyle: 'italic',
            letterSpacing: '0.06em',
          }}
        >
          {t('game.nameShort')}
        </span>
      </Link>

      {/* 右侧：语言切换 + 主题切换 + Admin + 登录按钮 */}
      <div className="flex items-center gap-4">
        <LanguageSwitcher />
        <ThemeToggle />
        {user?.role === 'admin' && (
          <Link
            href="/admin"
            style={{
              background: 'transparent',
              color: 'var(--text-light)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              padding: '6px 12px',
              fontSize: '0.85rem',
              fontWeight: 700,
              cursor: 'pointer',
              textDecoration: 'none',
            }}
          >
            ⚙️
          </Link>
        )}
        <button
          onClick={() => { user ? window.location.href = '/profile' : setAuthOpen(true); }}
          style={{
            background: user ? 'var(--primary-soft)' : 'transparent',
            color: user ? 'var(--primary-strong)' : 'var(--text-light)',
            border: user ? 'none' : '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            padding: '6px 14px',
            fontSize: '0.85rem',
            fontWeight: 700,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {user ? user.username : (guestName || '登录')}
        </button>
      </div>

      <AuthDialog open={authOpen} onClose={() => setAuthOpen(false)} />
    </header>
  );
}
