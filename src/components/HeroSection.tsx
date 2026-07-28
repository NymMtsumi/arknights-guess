'use client';

import { useI18n } from '@/lib/i18n';

export function HeroSection() {
  const { t } = useI18n();

  return (
    <div className="home-hero">
      {/* Kick 标签 */}
      <div
        style={{
          position: 'relative',
          marginBottom: '14px',
          padding: '5px 10px',
          borderLeft: '3px solid var(--primary)',
          color: 'var(--primary)',
          fontFamily: "Bahnschrift, 'Arial Narrow', sans-serif",
          fontSize: 'var(--fs-xs)',
          fontWeight: 800,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          animation: 'kicker-enter 0.55s 0.08s cubic-bezier(0.2, 0.72, 0.25, 1) both',
        }}
      >
        {t('hero.kicker')}
      </div>

      {/* 主标题 */}
      <h1>{t('hero.title')}</h1>

      {/* 副标题 */}
      <p className="hero-subtitle">{t('hero.subtitle')}</p>

      {/* 描述 */}
      <p className="muted">{t('hero.description')}</p>
    </div>
  );
}
