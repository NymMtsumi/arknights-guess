'use client';

import { useState } from 'react';
import Link from 'next/link';

interface MenuCardProps {
  href: string;
  /** 插画路径（以 / 开头，取自 public/icons/），或直接传 emoji */
  icon: string;
  /** 图片加载失败时回退显示的表情 —— 稿子 data-fb 的等价物（index-v12.html:923） */
  iconFallback?: string;
  label: string;
  /** 卡片副标，对应稿子的 .menu-tag（首页四张卡是英文赛制名） */
  tag?: string;
  /** 卡片强调色，仍在 --menu-color 上 —— 由 globals.css 的 .menu-card 系列消费 */
  color: string;
  /** 稿子的卡色变体类：c-daily / c-classic / c-multi / c-party */
  variant?: string;
  onClick?: (e: React.MouseEvent) => void;
  small?: boolean;
  external?: boolean;
}

export function MenuCard({
  href, icon, iconFallback, label, tag, color, variant, onClick, small, external,
}: MenuCardProps) {
  const [imgFailed, setImgFailed] = useState(false);

  const style = { '--menu-color': color } as React.CSSProperties;
  const cardClass = ['menu-card', small && 'menu-card-sm', variant].filter(Boolean).join(' ');
  const extProps = external ? { target: '_blank', rel: 'noopener noreferrer' } : {};

  // 传进来的是路径（/…）才走图片；否则当成 emoji 直接用。
  const isPath = icon.startsWith('/');
  const showImg = isPath && !imgFailed;
  // 路径但加载失败 → 回退表情；本来就不是路径 → 就是那个 emoji。
  const glyph = isPath ? (iconFallback ?? '') : icon;

  const content = (
    <>
      {/* 图标槽位：有图时 .has-img 让出 12px 呼吸边（v12-components.css §21.2） */}
      <span className={showImg ? 'menu-icon has-img' : 'menu-icon'}>
        {showImg ? (
          <img
            className="artimg"
            src={icon}
            alt=""
            aria-hidden="true"
            onError={() => setImgFailed(true)}
          />
        ) : (
          glyph
        )}
      </span>

      {/* 文字区域 */}
      <span className="menu-title">{label}</span>
      {tag ? <span className="menu-tag">{tag}</span> : null}

      {/* 箭头 —— 属于旧横排形态，V12 竖排版式下由 CSS 收起。 */}
      <span
        className="menu-arrow"
        style={{
          position: 'absolute',
          right: 'clamp(14px, 2vw, 20px)',
          bottom: 'clamp(14px, 2vw, 20px)',
          transition: 'transform 0.3s ease',
        }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M7 17L17 7M17 7H7M17 7V17" />
        </svg>
      </span>
    </>
  );

  if (onClick) {
    return (
      <div
        className={cardClass}
        style={{ ...style, cursor: 'pointer' }}
        onClick={onClick}
      >
        {content}
      </div>
    );
  }
  return (
    <Link
      href={href}
      className={cardClass}
      style={style}
      {...extProps}
    >
      {content}
    </Link>
  );
}
