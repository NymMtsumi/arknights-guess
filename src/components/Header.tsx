'use client';

import { useState, useEffect, useLayoutEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { ThemeToggle } from './ThemeToggle';
import { LanguageSwitcher } from './LanguageSwitcher';
import { AuthDialog } from './AuthDialog';
import { getUser, getServerUrl } from '@/lib/auth';

// useLayoutEffect 在服务端预渲染时会告警（"does nothing on the server"），
// 浏览器用 layout、Node 用 effect 的同构写法回避。每次调用都读到同一个模块级常量。
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export function Header() {
  const { t } = useI18n();
  const router = useRouter();
  const [authOpen, setAuthOpen] = useState(false);
  const [guestName, setGuestName] = useState('');

  // ⚠️ 登录态**不能**在渲染期直接读 localStorage。
  //    静态导出时服务端预渲染这棵组件树，Node 里没有 localStorage → 首屏 HTML 渲染成
  //    「未登录」；浏览器首帧读到已登录 → 两边 HTML 不一致 → React 报 #418
  //    （实测 8 条路由里 7 条中招，见 tests/_probe-hydration.mjs）。
  //    改成「首屏一律按未登录渲染，挂载后再补」。
  //
  //    用 layout effect 而不是普通 effect：它在水合提交后、浏览器**首次绘制前**执行，
  //    所以已登录用户不会多看到一帧「登录」按钮 —— 与修复前的观感一致。
  const [user, setUser] = useState<ReturnType<typeof getUser>>(null);
  useIsoLayoutEffect(() => { setUser(getUser()); }, []);

  // Stable boolean to avoid re-running the effect on every render
  // (getUser() returns a new object reference each call via JSON.parse)
  const isLoggedIn = !!user;

  useEffect(() => {
    if (isLoggedIn) return;
    const controller = new AbortController();
    fetch(`${getServerUrl()}/api/guest-identity`, { signal: controller.signal })
      .then(res => res.json())
      .then(data => {
        if (data.displayName) setGuestName(data.displayName);
      })
      .catch(() => {}); // Silently fail (aborted requests included)
    return () => controller.abort();
  }, [isLoggedIn]);

  return (
    <header className="header-bar">
      {/* 左侧：标题 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
        <Link
          href="/"
          className="no-underline text-[var(--text)] flex items-center gap-2 hover:text-[var(--primary)] transition-colors"
        >
          <span
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: '1.125rem',
              fontWeight: 800,
              fontStyle: 'italic',
              letterSpacing: '0.06em',
            }}
          >
            {t('game.nameShort')}
          </span>
        </Link>
        {/* 导航链接 */}
        <nav style={{ display: 'flex', gap: '8px' }}>
        </nav>
      </div>

      {/* 右侧：语言切换 + 主题切换 + Admin + 登录按钮 */}
      <div className="flex items-center gap-4">
        <LanguageSwitcher />
        <ThemeToggle />
        {user?.role === 'admin' && (
          <Link
            href="/admin"
            style={{
              background: 'transparent',
              color: 'var(--text-light)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              padding: '6px 12px',
              fontSize: '0.85rem',
              fontWeight: 700,
              cursor: 'pointer',
              textDecoration: 'none',
            }}
          >
            ⚙️
          </Link>
        )}
        <button
          onClick={() => { user ? router.push('/profile') : setAuthOpen(true); }}
          style={{
            background: user ? 'var(--primary-soft)' : 'transparent',
            color: user ? 'var(--primary-strong)' : 'var(--text-light)',
            border: user ? 'none' : '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            padding: '6px 14px',
            fontSize: '0.85rem',
            fontWeight: 700,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {user ? user.username : (guestName || '登录')}
        </button>
      </div>

      <AuthDialog open={authOpen} onClose={() => setAuthOpen(false)} />
    </header>
  );
}
