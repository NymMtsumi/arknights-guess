'use client';

import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'blast' | 'blast-wine';

const STORAGE_KEY = 'ui-theme';
const DARK_VARIANT_KEY = 'ui-dark-variant';
const DEFAULT_THEME: Theme = 'blast';

function getSystemTheme(): 'light' | 'blast' {
  if (typeof window === 'undefined') return 'blast';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'blast';
}

function getStoredDarkVariant(): 'blast' | 'blast-wine' {
  if (typeof window === 'undefined') return 'blast';
  try {
    const stored = localStorage.getItem(DARK_VARIANT_KEY);
    if (stored === 'blast' || stored === 'blast-wine') return stored;
  } catch { /* ignore */ }
  return 'blast';
}

function getStoredTheme(): Theme {
  if (typeof window === 'undefined') return DEFAULT_THEME;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light') return 'light';
    if (stored === 'blast' || stored === 'blast-wine') return getStoredDarkVariant();
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
    document.documentElement.style.background = theme === 'blast-wine' ? '#160a13' : '#0c1517';
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
      // 记住暗色变体偏好
      if (newTheme === 'blast' || newTheme === 'blast-wine') {
        localStorage.setItem(DARK_VARIANT_KEY, newTheme);
      }
    } catch { /* ignore */ }
  }, []);

  const toggleTheme = useCallback(() => {
    // 循环：light → blast → blast-wine → light → ...
    const order: Theme[] = ['light', 'blast', 'blast-wine'];
    const idx = order.indexOf(theme);
    const next = order[(idx + 1) % order.length];
    setTheme(next);
  }, [theme, setTheme]);

  /** 仅在暗色模式间切换（blast ⇄ blast-wine），保持 light 时不变 */
  const toggleDarkVariant = useCallback(() => {
    if (theme === 'light') return;
    setTheme(theme === 'blast' ? 'blast-wine' : 'blast');
  }, [theme, setTheme]);

  const isDark = theme !== 'light';

  return { theme, setTheme, toggleTheme, toggleDarkVariant, isDark, mounted };
}
