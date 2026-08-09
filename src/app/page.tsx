'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import Link from 'next/link';
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

  // Cleanup all pending dialog timers on unmount
  useEffect(() => {
    return () => {
      if (rulesTimer.current) clearTimeout(rulesTimer.current);
      if (changelogTimer.current) clearTimeout(changelogTimer.current);
      if (devTimer.current) clearTimeout(devTimer.current);
      if (thanksTimer.current) clearTimeout(thanksTimer.current);
    };
  }, []);

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
            href="/daily"
            icon="📅"
            label={t('menu.daily')}
            description={t('menu.dailyDesc')}
            color="#ff9500"
          />
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
        </div>

        {/* 底部快捷链接 — 紧凑按钮行，参考弗一把设计 */}
        <div className="bottom-bar">
          <Link href="/leaderboard" className="bottom-bar-btn">
            🏆 {t('menu.leaderboard')}
          </Link>
          <Link href="/stats" className="bottom-bar-btn">
            📊 {t('menu.stats')}
          </Link>
          <button
            className="bottom-bar-btn"
            onClick={makeClickHandler(rulesTimer, setRulesOpen)}
          >
            📋 {t('menu.rules')}
          </button>
          <button
            className="bottom-bar-btn"
            onClick={makeClickHandler(changelogTimer, setChangelogOpen)}
          >
            📝 {t('menu.changelog')}
          </button>
          <button
            className="bottom-bar-btn"
            onClick={makeClickHandler(devTimer, setDevCreditsOpen)}
          >
            👨‍💻 {t('menu.developers')}
          </button>
          <button
            className="bottom-bar-btn"
            onClick={makeClickHandler(thanksTimer, setThanksOpen)}
          >
            💚 {t('menu.acknowledgements')}
          </button>
          <a
            href="https://github.com/NymMtsumi/arknights-guess"
            className="bottom-bar-btn"
            target="_blank"
            rel="noopener noreferrer"
          >
            🐙 GitHub
          </a>
          <a
            href="https://space.bilibili.com/1327884464"
            className="bottom-bar-btn"
            target="_blank"
            rel="noopener noreferrer"
          >
            📺 B站
          </a>
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
