/**
 * 敌方单位工具函数（客户端/服务端共享算法）
 */

/** 每日固定种子：UTC 日期 → djb2 hash → 32-bit unsigned */
export function enemyDailySeed(): number {
  const now = new Date();
  const dateStr = [
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
  ].join('-');
  let hash = 5381;
  for (let i = 0; i < dateStr.length; i++) {
    hash = ((hash << 5) + hash + dateStr.charCodeAt(i)) | 0;
  }
  return (hash >>> 0);
}

/** LCG 伪随机数生成器 */
export function enemySeededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0x100000000;
  };
}
