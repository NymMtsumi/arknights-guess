'use client';

import { useI18n } from '@/lib/i18n';

export function HeroSection() {
  const { t } = useI18n();

  return (
    <div className="home-hero">
      {/* Kick 标签 */}
      <div className="hero-kicker">{t('hero.kicker')}</div>

      {/* 主标题 */}
      <h1>{t('hero.title')}</h1>

      {/* 副标题 */}
      <p className="hero-subtitle">{t('hero.subtitle')}</p>

      {/* 描述 */}
      <p className="muted">{t('hero.description')}</p>
    </div>
  );
}
