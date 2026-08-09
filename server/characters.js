// 干员数据加载
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let ALL_CHARS = [], EASY_CHARS = [], MED_CHARS = [];

export function loadCharacters() {
  try {
    const data = JSON.parse(readFileSync(join(__dirname, 'characters.json'), 'utf-8'));
    ALL_CHARS = data.map(c => ({ id: c.id, name: c.name }));
    EASY_CHARS = data.filter(c => c.popularity === 'hot' || c.rarity >= 6).map(c => ({ id: c.id, name: c.name }));
    MED_CHARS = data.filter(c => c.popularity === 'hot' || c.popularity === 'normal').map(c => ({ id: c.id, name: c.name }));
    console.log(`已加载 ${ALL_CHARS.length} 干员`);
  } catch (err) {
    const charPath = join(__dirname, 'characters.json');
    console.error(`[FATAL] 无法加载干员数据: ${charPath}`, err.message);
    process.exit(1);
  }
}

export function randomTarget(diff = 'hard') {
  const pool = diff === 'easy' ? EASY_CHARS : diff === 'medium' ? MED_CHARS : ALL_CHARS;
  if (!pool.length) return { id: '', name: '?' };
  return pool[Math.floor(Math.random() * pool.length)];
}

// ===== 每日挑战：与客户端共享的确定性目标算法 =====

/** 每日固定种子（基于 UTC 日期） */
export function dailySeed() {
  const now = new Date();
  return now.getUTCFullYear() * 10000 + (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
}

/** 基于种子的伪随机数生成器（LCG） */
export function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0x100000000;
  };
}

/** 根据日期种子确定性地选择一个干员作为每日挑战目标 */
export function pickDailyTarget(difficulty = 'hard') {
  const pool = difficulty === 'easy' ? EASY_CHARS : difficulty === 'medium' ? MED_CHARS : ALL_CHARS;
  if (!pool.length) return { id: '', name: '?' };
  const rng = seededRandom(dailySeed());
  return pool[Math.floor(rng() * pool.length)];
}
