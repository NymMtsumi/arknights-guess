'use client';

import { useI18n } from '@/lib/i18n';

// 首页英雄区。版式来自稿子 index-v12.html:900-917（.home-hero / .orb / .sweep / .hero-inner），
// 样式在 v12-components.css §21.3。
//
// 与稿子的差异（不做自创形态，只列已确认的取舍）：
//   1. 稿子的 .kicker 由「英文 Rhodes Island HR + .kcn 中文」两段拼成，线上只有
//      hero.kicker 一个键（zh「罗德岛人事部」/ en「RHODES ISLAND HR DEPT」），
//      所以只保留一颗 .kdot 装饰点，不做两段拆分。
//   2. 稿子的 .home-title 拆成 .c c1/c2/c3 逐字弹入；线上标题自带空格
//      （zh「理 一 把」/ en「LI  YI  BA」），拆字会破坏断行，故不拆。
//   3. 稿子额外有一行 .hero-en（英文副标）。线上没有对应键，不新增。
export function HeroSection() {
  const { t } = useI18n();

  return (
    <div className="home-hero">
      {/* 装饰层：漂浮光斑 ×3 + 循环斜扫光（稿子 index-v12.html:901-904） */}
      <span className="orb orb-a" aria-hidden="true" />
      <span className="orb orb-b" aria-hidden="true" />
      <span className="orb orb-c" aria-hidden="true" />
      <span className="sweep" aria-hidden="true" />

      <div className="hero-inner">
        {/* Kick 标签 */}
        <div className="hero-kicker">
          <span className="kdot" aria-hidden="true" />
          {t('hero.kicker')}
        </div>

        {/* 主标题 */}
        <h1 className="home-title">{t('hero.title')}</h1>

        {/* 副标题 */}
        <p className="hero-subtitle">{t('hero.subtitle')}</p>

        {/* 描述 */}
        <p className="muted">{t('hero.description')}</p>
      </div>
    </div>
  );
}
