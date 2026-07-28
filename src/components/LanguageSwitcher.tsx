'use client';

import { useI18n } from '@/lib/i18n';

export function LanguageSwitcher() {
  const { locale, setLocale, mounted, t } = useI18n();

  if (!mounted) {
    return <span className="w-8 h-5" />;
  }

  return (
    <button
      onClick={() => setLocale(locale === 'zh-CN' ? 'en' : 'zh-CN')}
      className="text-[var(--text-light)] hover:text-[var(--text)] transition-colors text-sm font-semibold tracking-wide uppercase"
      aria-label="Switch language"
    >
      {t('lang.switch')}
    </button>
  );
}
