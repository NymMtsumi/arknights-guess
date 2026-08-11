import type { Enemy, EnemyDifficulty, EnemyGuessComparisons, EnemyGuessResult, GuessStatus } from '@/types/enemy';
import { enemyDailySeed, enemySeededRandom } from './enemy-utils';
import { pinyin } from 'pinyin-pro';
import enemiesData from '@/data/enemy-characters.json';

// 预计算拼音索引（模块级缓存，仅计算一次）
const allEnemies: Enemy[] = enemiesData as Enemy[];
const pinyinCache = new Map<number, { py: string; initials: string }>();
function getEnemyPinyin(e: Enemy): { py: string; initials: string } {
  const cached = pinyinCache.get(e.id);
  if (cached) return cached;
  const pyArr = pinyin(e.name, { toneType: 'none', type: 'array' }) as string[];
  const py = pyArr.join('');
  const initials = pyArr.map(s => s[0] || '').join('');
  const result = { py, initials };
  pinyinCache.set(e.id, result);
  return result;
}

// 评级序列（SS→E）
const RATING_ORDER = ['SS', 'S+', 'S', 'A+', 'A', 'B+', 'B', 'C', 'D', 'E'];

/** 按难度筛选敌人池 */
export function getEnemyPoolByDifficulty(enemies: Enemy[], difficulty: EnemyDifficulty): Enemy[] {
  switch (difficulty) {
    case 'easy':
      return enemies.filter(e => e.isBoss);
    case 'normal':
      return enemies.filter(e => e.isBoss || e.isElite);
    case 'hard':
    default:
      return enemies;
  }
}

/** 每日目标：基于 UTC 日期确定性选择 */
export function pickDailyEnemy(enemies: Enemy[], difficulty: EnemyDifficulty): Enemy {
  const pool = getEnemyPoolByDifficulty(enemies, difficulty);
  if (pool.length === 0) throw new Error('pickDailyEnemy: no enemies available');
  const rng = enemySeededRandom(enemyDailySeed());
  for (let i = 0; i < 5; i++) rng();
  return pool[Math.floor(rng() * pool.length)];
}

// ===== 属性对比函数 =====

function compareExact(a: string, b: string): GuessStatus {
  return a === b ? 'correct' : 'wrong';
}

function compareRating(a: string, b: string): GuessStatus {
  if (a === b) return 'correct';
  const ai = RATING_ORDER.indexOf(a);
  const bi = RATING_ORDER.indexOf(b);
  if (ai === -1 || bi === -1) return 'wrong';
  if (Math.abs(ai - bi) === 1) return 'close';
  return 'wrong';
}

/** 地位对比：相同=correct, 相邻=close */
function compareLevel(a: string, b: string): GuessStatus {
  if (a === b) return 'correct';
  const order = ['普通', '精英', '领袖'];
  const ai = order.indexOf(a);
  const bi = order.indexOf(b);
  if (ai === -1 || bi === -1) return 'wrong';
  if (Math.abs(ai - bi) === 1) return 'close';
  return 'wrong';
}

/** 攻击方式对比：复合型对单一型 = close */
function compareAttackType(a: string, b: string): GuessStatus {
  if (a === b) return 'correct';
  const aParts = a.split(/\s+/);
  const bParts = b.split(/\s+/);
  // 一方是复合型（包含另一方）→ close
  const overlap = aParts.filter(p => bParts.includes(p));
  if (overlap.length > 0) return 'close';
  return 'wrong';
}

/** 伤害类型对比 */
function compareDamageType(a: string, b: string): GuessStatus {
  if (a === b) return 'correct';
  const aParts = a.split(/\s+/);
  const bParts = b.split(/\s+/);
  const overlap = aParts.filter(p => bParts.includes(p));
  if (overlap.length > 0) return 'close';
  return 'wrong';
}

/** 对比两个敌方单位的所有属性 */
export function compareEnemies(target: Enemy, guess: Enemy): EnemyGuessComparisons {
  return {
    race: compareExact(target.race, guess.race),
    level: compareLevel(target.level, guess.level),
    attackType: compareAttackType(target.attackType, guess.attackType),
    damageType: compareDamageType(target.damageType, guess.damageType),
    motion: compareExact(target.motion, guess.motion),
    endure: compareRating(target.endure, guess.endure),
    attack: compareRating(target.attack, guess.attack),
    defence: compareRating(target.defence, guess.defence),
    moveSpeed: compareRating(target.moveSpeed, guess.moveSpeed),
    attackSpeed: compareRating(target.attackSpeed, guess.attackSpeed),
    resistance: compareRating(target.resistance, guess.resistance),
  };
}

/** 是否猜中 */
export function isEnemyWin(target: Enemy, guess: Enemy): boolean {
  return target.id === guess.id;
}

/** 创建猜测结果 */
export function makeEnemyGuess(target: Enemy, guess: Enemy): EnemyGuessResult {
  return {
    enemy: guess,
    comparisons: compareEnemies(target, guess),
    timestamp: Date.now(),
  };
}

/** 按名称查找敌人 */
export function findEnemyByName(enemies: Enemy[], name: string): Enemy | undefined {
  const trimmed = name.trim();
  return enemies.find(
    e => e.name === trimmed || (e.nameEn && e.nameEn.toLowerCase() === trimmed.toLowerCase())
  );
}

/** 搜索敌人（拼音优先，带评分排序） */
export function searchEnemies(enemies: Enemy[], query: string): Enemy[] {
  if (!query.trim()) return [];
  const q = query.trim().toLowerCase();

  const ranked: { enemy: Enemy; score: number }[] = [];

  for (const e of enemies) {
    const nameLow = e.name.toLowerCase();
    const nameEnLow = (e.nameEn || '').toLowerCase();
    const { py, initials } = getEnemyPinyin(e);

    // 精确匹配：中文名
    if (nameLow === q) { ranked.push({ enemy: e, score: 100 }); continue; }
    // 精确匹配：英文名
    if (nameEnLow === q) { ranked.push({ enemy: e, score: 100 }); continue; }
    // 拼音全拼精确匹配
    if (py === q) { ranked.push({ enemy: e, score: 95 }); continue; }
    // 中文名开头匹配
    if (nameLow.startsWith(q)) { ranked.push({ enemy: e, score: 80 }); continue; }
    // 英文名开头匹配
    if (nameEnLow.startsWith(q)) { ranked.push({ enemy: e, score: 80 }); continue; }
    // 拼音开头匹配
    if (py.startsWith(q)) { ranked.push({ enemy: e, score: 75 }); continue; }
    // 首字母精确匹配
    if (initials === q) { ranked.push({ enemy: e, score: 70 }); continue; }
    // 首字母开头匹配
    if (initials.startsWith(q)) { ranked.push({ enemy: e, score: 65 }); continue; }
    // 中文名包含
    if (nameLow.includes(q)) { ranked.push({ enemy: e, score: 50 }); continue; }
    // 英文名包含
    if (nameEnLow.includes(q)) { ranked.push({ enemy: e, score: 50 }); continue; }
    // 拼音包含
    if (py.includes(q)) { ranked.push({ enemy: e, score: 45 }); continue; }
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, 8).map(r => r.enemy);
}
