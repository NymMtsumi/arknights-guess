import { clsx, type ClassValue } from "clsx";

/**
 * 合并 Tailwind 类名，处理冲突
 * 简单实现，避免额外依赖
 */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}

/**
 * 从数组中随机选取一个元素
 */
export function pickRandom<T>(arr: T[]): T {
  if (arr.length === 0) throw new Error('pickRandom: array is empty');
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * 每日固定种子（基于日期字符串）
 */
export function dailySeed(): number {
  const now = new Date();
  return now.getUTCFullYear() * 10000 + (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
}

/**
 * 基于种子的伪随机数生成器
 */
export function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0x100000000;
  };
}

/**
 * 格式化星级显示
 */
export function formatRarity(rarity: number): string {
  const r = Math.max(0, Math.min(6, rarity));
  return '★'.repeat(r) + '☆'.repeat(6 - r);
}
