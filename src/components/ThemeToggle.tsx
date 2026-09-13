'use client';

import { useTheme } from '@/hooks/use-theme';
import { useI18n } from '@/lib/i18n';

export function ThemeToggle() {
  const { theme, toggleTheme, isDark, mounted } = useTheme();
  const { t } = useI18n();

  if (!mounted) {
    return <span className="w-5 h-5" />;
  }

  // 只剩 light / blast 两个主题，按钮从「两个并列切换」合并成了一个循环切换，
  // 所以 title 要说**切过去之后是哪个主题**，不是当前主题 ——
  // 写成当前主题的话，人 hover 时看到的是自己已经在的那一档，等于没提示。
  // 原先这里还按主题写死英文 'Cyan' / 'Wine'，现在统一走 i18n 键，
  // 万一以后再加主题也不会再漏掉翻译。
  const themeLabel = isDark ? t('theme.light') : t('theme.blast');

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
      {/* 主切换：light ↔ blast */}
      <button
        onClick={toggleTheme}
        className="text-[var(--text-light)] hover:text-[var(--text)] transition-colors text-sm font-semibold tracking-wide uppercase"
        title={themeLabel}
        aria-label={themeLabel}
      >
        {isDark ? '☾' : '☀'}
      </button>
    </div>
  );
}
