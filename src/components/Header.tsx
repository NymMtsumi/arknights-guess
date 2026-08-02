'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { ThemeToggle } from './ThemeToggle';
import { LanguageSwitcher } from './LanguageSwitcher';
import { AuthDialog } from './AuthDialog';
import { getUser } from '@/lib/auth';
import type { AuthUser } from '@/lib/auth';

export function Header() {
  const { t } = useI18n();
  const [authOpen, setAuthOpen] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    setUser(getUser());
  }, []);

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

      {/* 右侧：账号 + 语言切换 + 主题切换 */}
      <div className="flex items-center gap-4">
        {user ? (
          <button
            onClick={() => setAuthOpen(true)}
            style={{
              background: 'var(--primary-soft)',
              color: 'var(--primary-strong)',
              border: '1px solid var(--primary)',
              borderRadius: 'var(--radius)',
              padding: '4px 12px',
              fontSize: '0.85rem',
              fontWeight: 700,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {user.username}
          </button>
        ) : (
          <button
            onClick={() => setAuthOpen(true)}
            style={{
              background: 'transparent',
              color: 'var(--text-light)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              padding: '4px 12px',
              fontSize: '0.8rem',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            登录
          </button>
        )}
        <LanguageSwitcher />
        <ThemeToggle />
      </div>

      <AuthDialog open={authOpen} onClose={() => setAuthOpen(false)} />
    </header>
  );
}
