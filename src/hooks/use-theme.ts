'use client';

import { useCallback, useEffect, useState } from 'react';

// 主题只剩两个：light 与 blast（青黑）。
// 曾经有第三个 blast-wine（酒红），已整体删除 —— 见下方 LEGACY_WINE 的迁移说明。
export type Theme = 'light' | 'blast';

const STORAGE_KEY = 'ui-theme';
const DEFAULT_THEME: Theme = 'blast';

// 已删除的酒红主题的遗留存值。老用户 localStorage 里可能还留着 'blast-wine'，
// 必须继续认它并归并到 blast —— 否则下面的 'light' / 'blast' 两个分支都不匹配
// → 掉到系统偏好 → 系统偏好是浅色的酒红用户每次加载都会莫名变成浅色主题。
// ⚠️ layout.tsx 的 theme-init 内联脚本里有一份逐字对应的判断，改这里必须同步改那里。
const LEGACY_WINE = 'blast-wine';

function getSystemTheme(): 'light' | 'blast' {
  if (typeof window === 'undefined') return 'blast';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'blast';
}

function getStoredTheme(): Theme {
  if (typeof window === 'undefined') return DEFAULT_THEME;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light') return 'light';
    // 含遗留的 'blast-wine'：它是暗色，归并到 blast，不能让它掉进系统偏好分支
    if (stored === 'blast' || stored === LEGACY_WINE) return 'blast';
  } catch { /* ignore */ }
  return getSystemTheme();
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  if (theme === 'light') {
    document.documentElement.style.colorScheme = 'light';
    document.documentElement.style.background = '#f3f0ea';
  } else {
    document.documentElement.style.colorScheme = 'dark';
    document.documentElement.style.background = '#0c1517';
  }
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(DEFAULT_THEME);
  const [mounted, setMounted] = useState(false);

  // 初始化主题（客户端执行一次）
  useEffect(() => {
    const current = getStoredTheme();
    setThemeState(current);
    applyTheme(current);
    setMounted(true);
  }, []);

  const setTheme = useCallback((newTheme: Theme) => {
    setThemeState(newTheme);
    applyTheme(newTheme);
    try {
      localStorage.setItem(STORAGE_KEY, newTheme);
    } catch { /* ignore */ }
  }, []);

  const toggleTheme = useCallback(() => {
    // 循环：light → blast → light → ...
    const order: Theme[] = ['light', 'blast'];
    const idx = order.indexOf(theme);
    const next = order[(idx + 1) % order.length];
    setTheme(next);
  }, [theme, setTheme]);

  const isDark = theme !== 'light';

  return { theme, setTheme, toggleTheme, isDark, mounted };
}
