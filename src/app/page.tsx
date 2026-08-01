'use client';

import { useState, useRef, useCallback } from 'react';
import { Header } from '@/components/Header';
import { HeroSection } from '@/components/HeroSection';
import { MenuCard } from '@/components/MenuCard';
import { RulesDialog } from '@/components/RulesDialog';
import { ChangelogDialog } from '@/components/ChangelogDialog';
import { Footer } from '@/components/Footer';
import { useI18n } from '@/lib/i18n';

export default function HomePage() {
  const { t } = useI18n();
  const [rulesOpen, setRulesOpen] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const rulesTimer = useRef<NodeJS.Timeout | null>(null);
  const changelogTimer = useRef<NodeJS.Timeout | null>(null);

  const handleRulesClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (rulesTimer.current) clearTimeout(rulesTimer.current);
    rulesTimer.current = setTimeout(() => setRulesOpen(true), 80);
  }, []);

  const handleChangelogClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (changelogTimer.current) clearTimeout(changelogTimer.current);
    changelogTimer.current = setTimeout(() => setChangelogOpen(true), 80);
  }, []);

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
          <MenuCard
            href="#"
            icon="📖"
            label={t('menu.rules')}
            description={t('menu.rulesDesc')}
            color="var(--accent)"
            onClick={handleRulesClick}
          />

          {/* 统计记录 */}
          <MenuCard
            href="/stats"
            icon="📊"
            label={t('menu.stats')}
            description={t('menu.statsDesc')}
            color="#4d94ff"
          />

          {/* 多人对战 */}
          <MenuCard
            href="/multiplayer"
            icon="⚔️"
            label="多人对战"
            description="创建或加入房间，与好友实时对战，看看谁是GOAT"
            color="#ff6b6b"
          />

          {/* 更新日志 */}
          <MenuCard
            href="#"
            icon="📋"
            label="更新日志"
            description="查看网站历次更新内容与时间"
            color="#f0a040"
            onClick={handleChangelogClick}
          />
        </div>
      </div>

<Footer />

      {/* 规则弹窗 */}
      <RulesDialog open={rulesOpen} onClose={() => setRulesOpen(false)} />
      {/* 更新日志 */}
      <ChangelogDialog open={changelogOpen} onClose={() => setChangelogOpen(false)} />
    </div>
  );
}
