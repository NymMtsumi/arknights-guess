'use client';

import { useI18n } from '@/lib/i18n';

export function Footer() {
  const { t } = useI18n();

  return (
    <footer
      style={{
        textAlign: 'center',
        padding: 'clamp(24px, 4vw, 40px) 0 clamp(16px, 3vw, 24px)',
        color: 'var(--text-light)',
        fontSize: 'var(--fs-2xs)',
      }}
    >
      <span>制作人：{t('footer.credit')}</span>
      <span style={{ margin: '0 8px', color: 'var(--border)' }}>·</span>
      <a
        href="https://space.bilibili.com/1327884464"
        target="_blank"
        rel="noopener noreferrer"
        style={{ color: 'var(--primary)', textDecoration: 'none', fontWeight: 600 }}
      >
        {t('footer.bilibili')}
      </a>
    </footer>
  );
}
