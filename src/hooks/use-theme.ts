'use client';

import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'blast';

const STORAGE_KEY = 'ui-theme';
const DEFAULT_THEME: Theme = 'blast';

function getSystemTheme(): Theme {
  if (typeof window === 'undefined') return DEFAULT_THEME;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'blast';
}

function getStoredTheme(): Theme {
  if (typeof window === 'undefined') return DEFAULT_THEME;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'blast') return stored;
  } catch { /* ignore */ }
  return getSystemTheme();
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme === 'blast' ? 'dark' : 'light';
  document.documentElement.style.background = theme === 'blast' ? '#160a13' : '#f3f0ea';
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
    setTheme(theme === 'blast' ? 'light' : 'blast');
  }, [theme, setTheme]);

  return { theme, setTheme, toggleTheme, mounted };
}
