'use client';

import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';

// 干员生日横幅。位置：首页 HeroSection 与 .menu-grid 之间（page.tsx）。
// 样式见 v12-components.css §21.7。
//
// ⚠️ 设计稿（Desktop/NEW/index-v12*.html）**没有这个形态**，版式是本轮定的，
//    取值依据写在 §21.7 的注释里（卡面走双主题同族的青绿，不另起色相）。
//
// 插画复用 /icons/draw-2.png —— 就是多人对战「平局 / 超时」随机插图里的第 2 张，
// 画的正是真理。它在这里不再是随机插图，所以不走 drawArtIndex()，是定图。

const BIRTHDAY_MONTH = 8; // 9 月（0 基）
const BIRTHDAY_DAY = 22;

export function BirthdayBanner() {
  const { t } = useI18n();
  const [isBirthday, setIsBirthday] = useState(false);

  // ⚠️ 日期判断必须放在挂载之后，**不能**写在渲染里。
  //    本页是 output:"export" 静态导出：构建时预渲染成 HTML，构建机的日期与
  //    访问者本地日期不是同一天，渲染期 new Date() 会产出
  //    「构建当天有横幅、次日客户端渲染没有」的水合不一致（React 报 recoverable error）。
  //    先渲染 null、挂载后按本地日期开 —— 服务端与首帧客户端都是 null，完全一致。
  useEffect(() => {
    const now = new Date();
    setIsBirthday(now.getMonth() === BIRTHDAY_MONTH && now.getDate() === BIRTHDAY_DAY);
  }, []);

  // 插画加载失败时整块收起，不留破图（同 ModeArt 的处理）。
  const [artFailed, setArtFailed] = useState(false);

  if (!isBirthday) return null;

  const sealDate = `${String(BIRTHDAY_MONTH + 1).padStart(2, '0')} / ${String(BIRTHDAY_DAY).padStart(2, '0')}`;

  return (
    <section className="bday-banner">
      <div className="bday-copy">
        <div className="bday-eyebrow">
          <span className="bday-dot" aria-hidden="true" />
          {t('bday.eyebrow')}
        </div>

        <div className="bday-head">
          <h2 className="bday-title">{t('bday.title')}</h2>
          {/* 日期印戳 —— 本横幅的signature，见 §21.7 */}
          <span className="bday-seal">
            <b>{sealDate}</b>
            <span>{t('bday.seal')}</span>
          </span>
        </div>

        <p className="bday-msg">{t('bday.message')}</p>
      </div>

      {!artFailed && (
        <div className="bday-art">
          <img
            src="/icons/draw-2.png"
            alt={t('bday.alt')}
            width={407}
            height={448}
            onError={() => setArtFailed(true)}
          />
        </div>
      )}
    </section>
  );
}
