// 敌方单位数据加载与游戏引擎
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let ALL_ENEMIES = [], EASY_POOL = [], NORMAL_POOL = [];

export function loadEnemies() {
  try {
    const data = JSON.parse(readFileSync(join(__dirname, 'enemy-characters.json'), 'utf-8'));
    ALL_ENEMIES = data.map(e => ({
      id: e.id,
      name: e.name,
      race: e.race,
      raceRaw: e.raceRaw,
      level: e.level,
      attackType: e.attackType,
      damageType: e.damageType,
      motion: e.motion,
      endure: e.endure,
      attack: e.attack,
      defence: e.defence,
      moveSpeed: e.moveSpeed,
      attackSpeed: e.attackSpeed,
      resistance: e.resistance,
    }));
    // 难度池
    EASY_POOL = data.filter(e => e.isBoss).map(e => ({ id: e.id, name: e.name }));
    NORMAL_POOL = data.filter(e => e.isBoss || e.isElite).map(e => ({ id: e.id, name: e.name }));
    console.log(`[enemy] 已加载 ${ALL_ENEMIES.length} 敌方单位 (EASY=${EASY_POOL.length}, NORMAL=${NORMAL_POOL.length}, HARD=${ALL_ENEMIES.length})`);
    if (ALL_ENEMIES.length === 0) console.error('[enemy] Failed to load enemies — ALL_ENEMIES is empty');
  } catch (err) {
    console.error(`[ERROR] 无法加载敌方数据: ${join(__dirname, 'enemy-characters.json')}`, err.message);
  }
}

/** 随机目标（单人模式） */
export function randomEnemyTarget(diff = 'hard') {
  const pool = diff === 'easy' ? EASY_POOL : diff === 'normal' ? NORMAL_POOL : ALL_ENEMIES;
  if (!pool.length) return { id: 0, name: '?' };
  return pool[Math.floor(Math.random() * pool.length)];
}

// ===== 每日挑战：确定性目标算法（与客户端共享） =====

/** 每日固定种子（djb2 hash of UTC date） */
export function enemyDailySeed() {
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
export function enemySeededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0x100000000;
  };
}

/** 每日固定目标（基于 UTC 日期确定性选择） */
export function pickDailyEnemy(difficulty = 'hard') {
  const pool = difficulty === 'easy' ? EASY_POOL : difficulty === 'normal' ? NORMAL_POOL : ALL_ENEMIES;
  if (!pool.length) return { id: 0, name: '?' };
  const rng = enemySeededRandom(enemyDailySeed());
  for (let i = 0; i < 5; i++) rng();
  return pool[Math.floor(rng() * pool.length)];
}

// ===== 猜测判定（服务端验证用） =====

const RATING_ORDER = ['SS', 'S+', 'S', 'A+', 'A', 'B+', 'B', 'C', 'D', 'E'];

/**
 * 判断两个评级是否相邻（±1 级 → 黄色）
 */
export function isRatingClose(a, b) {
  if (a === b) return false; // 相同是绿色，不是黄色
  const ai = RATING_ORDER.indexOf(a);
  const bi = RATING_ORDER.indexOf(b);
  if (ai === -1 || bi === -1) return false;
  return Math.abs(ai - bi) === 1;
}

/**
 * 验证两个敌人是否为同一个（每日模式服务端校验用）
 */
export function isSameEnemy(a, b) {
  return a.name === b.name || a.id === b.id;
}
