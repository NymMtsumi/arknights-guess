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
        // ⚠️ 不要在这里加任何自定义请求头（曾经有一行 headers:{'Cache-Control':'no-cache'}）。
        // 前端与 API 跨域（生产 www.* → ws.*，本地 :3000 → :3001），GET 只要带自定义头
        // 就**不再是简单请求**，浏览器会先发 OPTIONS 预检，而服务端
        // Access-Control-Allow-Headers 只放行 Content-Type / Authorization
        // → 预检失败、请求被拦在浏览器里，版本提示永远不弹，且只在 control 台留一行 CORS。
        // 防 HTTP 缓存用下面的 fetch 选项 cache:'no-store' 就够了 —— 那是浏览器层语义，
        // 不占请求头、不触发预检。
        const res = await fetch(`${base}/api/version`, { cache: 'no-store' });
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
