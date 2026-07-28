'use client';

import { useTheme } from '@/hooks/use-theme';
import { useI18n } from '@/lib/i18n';

export function ThemeToggle() {
  const { theme, toggleTheme, mounted } = useTheme();
  const { t } = useI18n();

  if (!mounted) {
    return <span className="w-5 h-5" />;
  }

  return (
    <button
      onClick={toggleTheme}
      className="text-[var(--text-light)] hover:text-[var(--text)] transition-colors text-sm font-semibold tracking-wide uppercase"
      title={theme === 'blast' ? t('theme.light') : t('theme.blast')}
      aria-label={theme === 'blast' ? t('theme.light') : t('theme.blast')}
    >
      {theme === 'blast' ? '☀' : '☾'}
    </button>
  );
}
