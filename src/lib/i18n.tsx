'use client';

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import zhCN from '@/messages/zh-CN.json';
import en from '@/messages/en.json';

export type Locale = 'zh-CN' | 'en';

const translations: Record<Locale, Record<string, string>> = {
  'zh-CN': zhCN,
  'en': en,
};

interface I18nContextType {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
  mounted: boolean;
}

const I18nContext = createContext<I18nContextType>({
  locale: 'zh-CN',
  setLocale: () => {},
  t: (key: string) => key,
  mounted: false,
});

const STORAGE_KEY = 'ui-locale';

function getStoredLocale(): Locale {
  if (typeof window === 'undefined') return 'zh-CN';
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'zh-CN' || stored === 'en') return stored;
  } catch { /* ignore */ }
  // 检测浏览器语言
  const navLang = navigator.language;
  return navLang.startsWith('zh') ? 'zh-CN' : 'en';
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('zh-CN');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setLocaleState(getStoredLocale());
    setMounted(true);
  }, []);

  const setLocale = useCallback((newLocale: Locale) => {
    setLocaleState(newLocale);
    try { localStorage.setItem(STORAGE_KEY, newLocale); } catch { /* ignore */ }
    document.documentElement.lang = newLocale === 'zh-CN' ? 'zh-CN' : 'en';
  }, []);

  const t = useCallback((key: string, params?: Record<string, string | number>): string => {
    const template = translations[locale]?.[key];
    if (!template) {
      // 回退到英文
      const enTemplate = translations['en']?.[key];
      if (!enTemplate) return key;
      return interpolate(enTemplate, params);
    }
    return interpolate(template, params);
  }, [locale]);

  return (
    <I18nContext.Provider value={{ locale, setLocale, t, mounted }}>
      {children}
    </I18nContext.Provider>
  );
}

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(params[key] ?? `{{${key}}}`));
}

export function useI18n() {
  return useContext(I18nContext);
}
