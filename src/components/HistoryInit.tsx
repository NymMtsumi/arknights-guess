'use client';

import { useEffect } from 'react';

/**
 * 应用初始化时运行一次数据迁移。
 * 必须在 Providers 之前挂在 client component 中执行，确保在 SSR hydration 后立即运行。
 *
 * 功能：
 * 1. 触发 stats.ts 中的 migrateData()（版本升级、格式修复）
 * 2. 如果已登录，将本地游客数据关联到账号 player_key
 */
export function HistoryInit() {
  useEffect(() => {
    // 延迟执行避免阻塞页面渲染
    const timer = setTimeout(async () => {
      try {
        // 触发数据版本迁移（stats.ts 模块顶层已自动执行，这里兜底）
        const { loadHistory } = await import('@/lib/stats');
        const { getUser, getPlayerKey, linkPlayerKey } = await import('@/lib/auth');

        // 如果已登录且用户有 player_key，但本地数据可能关联的是旧游客 player_key
        // 把本地缓存的 player_key 与服务器端的绑定
        const user = getUser();
        if (user) {
          const cookiePk = getPlayerKey();
          if (cookiePk && cookiePk !== '') {
            await linkPlayerKey(cookiePk).catch(() => {});
          }
        }

        // 确保 loadHistory 清洗后的数据已回写
        loadHistory();
      } catch {
        // 静默失败，不影响主流程
      }
    }, 300);

    return () => clearTimeout(timer);
  }, []);

  return null;
}
