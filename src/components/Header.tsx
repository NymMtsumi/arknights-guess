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
  // Stable boolean to avoid re-running the effect on every render
  // (getUser() returns a new object reference each call via JSON.parse)
  const isLoggedIn = !!user;

  useEffect(() => {
    if (isLoggedIn) return;
    fetch(`${getServerUrl()}/api/guest-identity`)
      .then(res => res.json())
      .then(data => {
        if (data.displayName) setGuestName(data.displayName);
      })
      .catch(() => {}); // Silently fail
  }, [isLoggedIn]);

  return (
    <header className="header-bar">
      {/* 左侧：标题 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
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
        {/* 导航链接 */}
        <nav style={{ display: 'flex', gap: '8px' }}>
          <Link
            href="/multiplayer"
            style={{
              background: 'transparent', color: 'var(--text-light)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius)',
              padding: '4px 10px', fontSize: '0.8rem', fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            ⚔️ {t('menu.multiplayer')}
          </Link>
          <Link
            href="/party"
            style={{
              background: 'transparent', color: 'var(--accent)',
              border: '1px solid var(--accent)', borderRadius: 'var(--radius)',
              padding: '4px 10px', fontSize: '0.8rem', fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            🎉 {t('menu.party')}
          </Link>
          <Link
            href="/daily"
            style={{
              background: 'transparent', color: 'var(--text-light)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius)',
              padding: '4px 10px', fontSize: '0.8rem', fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            📅 {t('menu.daily')}
          </Link>
        </nav>
      </div>

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
