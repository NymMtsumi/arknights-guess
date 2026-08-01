'use client';

import Link from 'next/link';

interface MenuCardProps {
  href: string;
  icon: string;
  label: string;
  description: string;
  color: string;
  onClick?: (e: React.MouseEvent) => void;
}

export function MenuCard({ href, icon, label, description, color, onClick }: MenuCardProps) {
  const style = { '--menu-color': color } as React.CSSProperties;
  if (onClick) {
    return (
      <div
        className="menu-card"
        style={{ ...style, cursor: 'pointer' }}
        onClick={onClick}
      >
      {/* 图标 */}
      <span className="menu-icon">{icon}</span>

      {/* 文字区域 */}
      <span style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1, minWidth: 0 }}>
        <span className="menu-label">{label}</span>
        <span className="menu-description">{description}</span>
      </span>

      {/* 箭头 */}
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
    </div>
  );
  }
  return (
    <Link
      href={href}
      className="menu-card"
      style={style}
    >
      {/* 图标 */}
      <span className="menu-icon">{icon}</span>

      {/* 文字区域 */}
      <span style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1, minWidth: 0 }}>
        <span className="menu-label">{label}</span>
        <span className="menu-description">{description}</span>
      </span>

      {/* 箭头 */}
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
    </Link>
  );
}
