'use client';

import { useState, useRef, useCallback } from 'react';
import { Header } from '@/components/Header';
import { HeroSection } from '@/components/HeroSection';
import { MenuCard } from '@/components/MenuCard';
import { RulesDialog } from '@/components/RulesDialog';
import { ChangelogDialog } from '@/components/ChangelogDialog';
import { CreditsDialog } from '@/components/CreditsDialog';
import { Footer } from '@/components/Footer';
import { useI18n } from '@/lib/i18n';

export default function HomePage() {
  const { t } = useI18n();
  const [rulesOpen, setRulesOpen] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [devCreditsOpen, setDevCreditsOpen] = useState(false);
  const [thanksOpen, setThanksOpen] = useState(false);
  const rulesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const changelogTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const devTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const thanksTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const makeClickHandler = useCallback((timer: typeof rulesTimer, setter: (v: boolean) => void) => {
    return (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setter(true), 80);
    };
  }, []);

  return (
    <div className="page home-page">
      <Header />

      <div className="page-scroll" style={{ paddingTop: 'clamp(22px, 4vw, 44px)' }}>
        {/* 英雄区 */}
        <HeroSection />

        {/* 大卡片 — 主要游戏入口 */}
        <div className="menu-grid" style={{ marginBottom: '36px' }}>
          <MenuCard
            href="/game"
            icon="🎯"
            label={t('menu.classic')}
            description={t('menu.classicDesc')}
            color="var(--primary)"
          />
          <MenuCard
            href="/multiplayer"
            icon="⚔️"
            label={t('menu.multiplayer')}
            description={t('menu.multiplayerDesc')}
            color="#ff6b6b"
          />
          <MenuCard
            href="/stats"
            icon="📊"
            label={t('menu.stats')}
            description={t('menu.statsDesc')}
            color="#4d94ff"
          />
        </div>

        {/* 小卡片 — 信息与链接 */}
        <p className="menu-grid-title" style={{ textAlign: 'center', marginBottom: '10px' }}>
          {t('hero.kicker')}
        </p>
        <div className="menu-grid" style={{ marginBottom: '24px' }}>
          <MenuCard
            href="/leaderboard"
            icon="🏆"
            label={t('menu.leaderboard')}
            description={t('menu.leaderboardDesc')}
            color="#ffb347"
            small
          />
          <MenuCard
            href="#"
            icon="📋"
            label={t('menu.changelog')}
            description={t('menu.changelogDesc')}
            color="#f0a040"
            small
            onClick={makeClickHandler(changelogTimer, setChangelogOpen)}
          />
          <MenuCard
            href="#"
            icon="📖"
            label={t('menu.rules')}
            description={t('menu.rulesDesc')}
            color="var(--accent)"
            small
            onClick={makeClickHandler(rulesTimer, setRulesOpen)}
          />
          <MenuCard
            href="#"
            icon="👨‍💻"
            label={t('menu.developers')}
            description={t('menu.developersDesc')}
            color="#6a48d7"
            small
            onClick={makeClickHandler(devTimer, setDevCreditsOpen)}
          />
          <MenuCard
            href="#"
            icon="💚"
            label={t('menu.acknowledgements')}
            description={t('menu.acknowledgementsDesc')}
            color="#e040a0"
            small
            onClick={makeClickHandler(thanksTimer, setThanksOpen)}
          />
          <MenuCard
            href="https://github.com/NymMtsumi/arknights-guess"
            icon="🐙"
            label={t('menu.github')}
            description={t('menu.githubDesc')}
            color="#888888"
            small
            external
          />
          <MenuCard
            href="https://space.bilibili.com/1327884464"
            icon="📺"
            label={t('menu.bilibili')}
            description={t('menu.bilibiliDesc')}
            color="#00a1d6"
            small
            external
          />
        </div>
      </div>

      <Footer />

      {/* 弹窗 */}
      <RulesDialog open={rulesOpen} onClose={() => setRulesOpen(false)} />
      <ChangelogDialog open={changelogOpen} onClose={() => setChangelogOpen(false)} />
      <CreditsDialog open={devCreditsOpen} onClose={() => setDevCreditsOpen(false)} type="developers" />
      <CreditsDialog open={thanksOpen} onClose={() => setThanksOpen(false)} type="acknowledgements" />
    </div>
  );
}
