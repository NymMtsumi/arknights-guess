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

        {/* 大卡片 — 主要游戏入口
            插画与英文副标来自稿子 index-v12.html:923-943；卡色变体类（c-daily 等）
            决定 --mc（v12-components.css §21.4）。
            iconFallback 是稿子 data-fb 的等价物：图片挂掉时退回原来的 emoji。 */}
        <div className="menu-grid" style={{ marginBottom: '36px' }}>
          <MenuCard
            href="/daily"
            icon="/icons/menu-daily.png"
            iconFallback="📅"
            label={t('menu.daily')}
            tag={t('menu.dailyTag')}
            variant="c-daily"
            color="#ff9500"
          />
          <MenuCard
            href="/game"
            icon="/icons/menu-classic.png"
            iconFallback="🎯"
            label={t('menu.classic')}
            tag={t('menu.classicTag')}
            variant="c-classic"
            color="var(--primary)"
          />
          <MenuCard
            href="/multiplayer"
            icon="/icons/menu-multi.png"
            iconFallback="⚔️"
            label={t('menu.multiplayer')}
            tag={t('menu.multiplayerTag')}
            variant="c-multi"
            color="#ff6b6b"
          />
          <MenuCard
            href="/party"
            icon="/icons/menu-party.png"
            iconFallback="🎉"
            label={t('menu.party')}
            tag={t('menu.partyTag')}
            variant="c-party"
            color="#7c5cff"
          />
        </div>

        {/* 底部快捷链接 — 稿子 index-v12.html:949-958 的玻璃胶囊行 */}
        <div className="bottom-bar">
          <Link href="/leaderboard" className="bchip">
            <span className="enu">🏆</span> {t('menu.leaderboard')}
          </Link>
          <Link href="/stats" className="bchip">
            <span className="enu">📊</span> {t('menu.stats')}
          </Link>
          <button
            className="bchip"
            onClick={makeClickHandler(rulesTimer, setRulesOpen)}
          >
            <span className="enu">📋</span> {t('menu.rules')}
          </button>
          <button
            className="bchip"
            onClick={makeClickHandler(changelogTimer, setChangelogOpen)}
          >
            <span className="enu">📝</span> {t('menu.changelog')}
          </button>
          <button
            className="bchip"
            onClick={makeClickHandler(devTimer, setDevCreditsOpen)}
          >
            <span className="enu">👨‍💻</span> {t('menu.developers')}
          </button>
          <button
            className="bchip"
            onClick={makeClickHandler(thanksTimer, setThanksOpen)}
          >
            <span className="enu">💚</span> {t('menu.acknowledgements')}
          </button>
          <a
            href="https://github.com/NymMtsumi/arknights-guess"
            className="bchip"
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="enu">🐙</span> GitHub
          </a>
          <a
            href="https://space.bilibili.com/1327884464"
            className="bchip"
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="enu">📺</span> B站
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
