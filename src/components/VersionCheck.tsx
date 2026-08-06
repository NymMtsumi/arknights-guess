'use client';

import { useEffect, useRef, useState } from 'react';
import { getServerUrl } from '@/lib/auth';

const VERSION_STORAGE_KEY = 'arknights-app-version';

/**
 * 版本检测组件 — 每次页面加载时检查服务器版本，
 * 如果与本地存储的版本不同，显示更新提示 banner 而不是强制刷新，
 * 避免中断用户正在进行的游戏。
 */
export function VersionCheck() {
  const checkedRef = useRef(false);
  const [showUpdate, setShowUpdate] = useState(false);

  useEffect(() => {
    // 只检查一次（React StrictMode 会 double-mount）
    if (checkedRef.current) return;
    checkedRef.current = true;

    const checkVersion = async () => {
      try {
        const base = getServerUrl();
        const res = await fetch(`${base}/api/version`, {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache' },
        });
        if (!res.ok) return;

        const data = await res.json();
        const serverVersion = data.version;
        if (!serverVersion) return;

        const storedVersion = localStorage.getItem(VERSION_STORAGE_KEY);

        if (!storedVersion) {
          localStorage.setItem(VERSION_STORAGE_KEY, serverVersion);
          return;
        }

        if (storedVersion !== serverVersion) {
          console.log(`[VersionCheck] ${storedVersion} → ${serverVersion}, 提示用户更新...`);
          localStorage.setItem(VERSION_STORAGE_KEY, serverVersion);
          setShowUpdate(true);
        }
      } catch {
        // 服务器不可达 → 静默跳过
      }
    };

    // 延迟 1 秒检查，避免阻塞首屏渲染
    const timer = setTimeout(checkVersion, 1000);
    return () => clearTimeout(timer);
  }, []);

  if (!showUpdate) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 9999,
        background: 'var(--primary)',
        color: 'var(--bg)',
        padding: '10px 20px',
        textAlign: 'center',
        fontWeight: 700,
        fontSize: '0.9rem',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '8px',
      }}
      onClick={() => window.location.reload()}
    >
      <span>New version available! Click to refresh.</span>
      <span style={{ fontSize: '0.8rem', opacity: 0.8 }}>新版本可用，点击刷新</span>
    </div>
  );
}
