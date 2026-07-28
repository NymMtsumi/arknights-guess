'use client';

import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { ThemeToggle } from './ThemeToggle';
import { LanguageSwitcher } from './LanguageSwitcher';

export function Header() {
  const { t } = useI18n();

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

      {/* 右侧：语言切换 + 主题切换 */}
      <div className="flex items-center gap-4">
        <LanguageSwitcher />
        <ThemeToggle />
      </div>
    </header>
  );
}
