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
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * 每日固定种子（基于日期字符串）
 */
export function dailySeed(): number {
  const today = new Date();
  const seed = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
  return seed;
}

/**
 * 基于种子的伪随机数生成器
 */
export function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

/**
 * 格式化星级显示
 */
export function formatRarity(rarity: number): string {
  return '★'.repeat(rarity) + '☆'.repeat(6 - rarity);
}
