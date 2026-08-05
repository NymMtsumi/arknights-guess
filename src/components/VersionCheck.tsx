'use client';

import { useEffect, useRef } from 'react';
import { getServerUrl } from '@/lib/auth';

const VERSION_STORAGE_KEY = 'arknights-app-version';

/**
 * 版本检测组件 — 每次页面加载时检查服务器版本，
 * 如果与本地存储的版本不同，说明浏览器缓存了旧代码，
 * 强制 hard reload 绕过缓存加载最新版本。
 */
export function VersionCheck() {
  const checkedRef = useRef(false);

  useEffect(() => {
    // 只检查一次（React StrictMode 会 double-mount）
    if (checkedRef.current) return;
    checkedRef.current = true;

    const checkVersion = async () => {
      try {
        const base = getServerUrl();
        const res = await fetch(`${base}/api/version`, {
          cache: 'no-store', // 强制跳过缓存
          headers: { 'Cache-Control': 'no-cache' },
        });
        if (!res.ok) return;

        const data = await res.json();
        const serverVersion = data.version;
        if (!serverVersion) return;

        const storedVersion = localStorage.getItem(VERSION_STORAGE_KEY);

        if (!storedVersion) {
          // 首次访问：记录版本号
          localStorage.setItem(VERSION_STORAGE_KEY, serverVersion);
          return;
        }

        if (storedVersion !== serverVersion) {
          // 版本不匹配 → 旧缓存！更新版本号并强制刷新
          console.log(`[VersionCheck] ${storedVersion} → ${serverVersion}, 强制刷新...`);
          localStorage.setItem(VERSION_STORAGE_KEY, serverVersion);
          // 使用 location.reload() 并跳过浏览器缓存
          window.location.reload();
        }
      } catch {
        // 服务器不可达 → 静默跳过，不影响正常使用
      }
    };

    // 延迟 1 秒检查，避免阻塞首屏渲染
    const timer = setTimeout(checkVersion, 1000);
    return () => clearTimeout(timer);
  }, []);

  // 不渲染任何 UI
  return null;
}
