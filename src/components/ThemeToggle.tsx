'use client';

import { useTheme } from '@/hooks/use-theme';
import { useI18n } from '@/lib/i18n';

export function ThemeToggle() {
  const { theme, toggleTheme, toggleDarkVariant, isDark, mounted } = useTheme();
  const { t } = useI18n();

  if (!mounted) {
    return <span className="w-5 h-5" />;
  }

  const themeLabel = theme === 'light' ? t('theme.light') : (theme === 'blast' ? 'Cyan' : 'Wine');

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
      {/* 主切换：light ↔ dark */}
      <button
        onClick={toggleTheme}
        className="text-[var(--text-light)] hover:text-[var(--text)] transition-colors text-sm font-semibold tracking-wide uppercase"
        title={themeLabel}
        aria-label={themeLabel}
      >
        {theme === 'light' ? '☀' : '☾'}
      </button>

      {/* 暗色变体切换：仅在暗色模式下显示 */}
      {isDark && (
        <button
          onClick={toggleDarkVariant}
          className="text-[var(--text-light)] hover:text-[var(--text)] transition-colors text-xs font-bold uppercase px-1"
          title={theme === 'blast' ? t('theme.blastWine') : t('theme.blastTeal')}
          aria-label={theme === 'blast' ? t('theme.blastWine') : t('theme.blastTeal')}
          style={{
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            padding: '0 5px',
            lineHeight: '18px',
          }}
        >
          {theme === 'blast' ? '🍷' : '🩵'}
        </button>
      )}
    </div>
  );
}
