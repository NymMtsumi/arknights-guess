'use client';

import { useState } from 'react';
import { Header } from '@/components/Header';
import { HeroSection } from '@/components/HeroSection';
import { MenuCard } from '@/components/MenuCard';
import { RulesDialog } from '@/components/RulesDialog';
import { useI18n } from '@/lib/i18n';

export default function HomePage() {
  const { t } = useI18n();
  const [rulesOpen, setRulesOpen] = useState(false);

  return (
    <div className="page home-page">
      <Header />

      <div className="page-scroll" style={{ paddingTop: 'clamp(22px, 4vw, 44px)' }}>
        {/* 英雄区 */}
        <HeroSection />

        {/* 菜单卡片网格 */}
        <div
          className="menu-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))',
            gap: '14px',
            maxWidth: 'var(--content-max)',
            margin: '0 auto',
          }}
        >
          {/* 经典模式 */}
          <MenuCard
            href="/game"
            icon="🎯"
            label={t('menu.classic')}
            description={t('menu.classicDesc')}
            color="var(--primary)"
          />

          {/* 游戏规则 */}
          <div onClick={() => setRulesOpen(true)} style={{ cursor: 'pointer' }}>
            <MenuCard
              href="#"
              icon="📖"
              label={t('menu.rules')}
              description={t('menu.rulesDesc')}
              color="var(--accent)"
            />
          </div>

          {/* 统计记录 */}
          <MenuCard
            href="/stats"
            icon="📊"
            label={t('menu.stats')}
            description={t('menu.statsDesc')}
            color="#4d94ff"
          />
        </div>
      </div>

      {/* 规则弹窗 */}
      <RulesDialog open={rulesOpen} onClose={() => setRulesOpen(false)} />
    </div>
  );
}
