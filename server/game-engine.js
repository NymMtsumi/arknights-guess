// 服务端游戏引擎：干员对比逻辑（与客户端 src/lib/game-engine.ts 保持一致）
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let ALL_CHARS = [];
let _loaded = false;

export function loadGameEngine() {
  if (_loaded) return;
  try {
    const data = JSON.parse(readFileSync(join(__dirname, 'characters.json'), 'utf-8'));
    ALL_CHARS = data;
    _loaded = true;
    console.log(`[game-engine] Loaded ${ALL_CHARS.length} characters for server-side comparison`);
  } catch (err) {
    console.error('[game-engine] Failed to load characters.json:', err.message);
  }
}

/** 获取全量干员数据（供 characters.js 复用，避免重复读取 characters.json） */
export function getAllCharacters() {
  return ALL_CHARS;
}

/** 按名称查找角色（支持中文名和英文名） */
export function findCharByName(name) {
  const trimmed = name.trim();
  return ALL_CHARS.find(
    c => c.name === trimmed || (c.nameEn && c.nameEn.toLowerCase() === trimmed.toLowerCase())
  ) || null;
}

// ===== 对比函数（与客户端 src/lib/game-engine.ts 一致） =====

function compareAttribute(targetVal, guessVal) {
  return targetVal === guessVal ? 'correct' : 'wrong';
}

function compareRarity(target, guess) {
  if (target === guess) return 'correct';
  if (Math.abs(target - guess) === 1) return 'close';
  return 'wrong';
}

function compareSubclass(tSub, tClass, gSub, gClass) {
  if (tSub === gSub) return 'correct';
  if (tClass === gClass) return 'close';
  return 'wrong';
}

function compareFaction(tFaction, gFaction) {
  const t = (tFaction || '').trim();
  const g = (gFaction || '').trim();
  if (t === g) return 'correct';

  const targetParts = t.split(/[,，]/).map(s => s.trim()).filter(Boolean);
  const guessParts = g.split(/[,，]/).map(s => s.trim()).filter(Boolean);

  const targetIsSimple = targetParts.length === 1;
  const guessIsSimple = guessParts.length === 1;

  if (targetIsSimple && guessParts.includes(t)) return 'close';
  if (guessIsSimple && targetParts.includes(g)) return 'close';
  if (targetParts[0] === guessParts[0]) return 'close';

  const factionGroups = [
    ['罗德岛', '巴别塔'],
    ['炎', '龙门'],
    ['深海猎人', '阿戈尔'],
    ['乌萨斯'],
    ['维多利亚', '塔拉'],
    ['哥伦比亚', '汐斯塔', '莱茵生命', '黑钢国际'],
    ['叙拉古'],
    ['卡西米尔'],
    ['谢拉格', '喀兰贸易'],
  ];

  for (const group of factionGroups) {
    const targetIn = targetParts.some(p => group.includes(p));
    const guessIn = guessParts.some(p => group.includes(p));
    if (targetIn && guessIn) return 'close';
  }

  return 'wrong';
}

function comparePosition(tPos, gPos) {
  if (!tPos || !gPos) return 'wrong';
  if (tPos === gPos) return 'correct';
  if (tPos === '皆可' || gPos === '皆可') return 'close';
  return 'wrong';
}

function compareTags(tTags, gTags) {
  if (!tTags.length && !gTags.length) return 'correct';
  if (!tTags.length || !gTags.length) return 'wrong';
  const overlap = tTags.filter(t => gTags.includes(t));
  if (overlap.length === tTags.length && overlap.length === gTags.length) return 'correct';
  if (overlap.length > 0) return 'close';
  return 'wrong';
}

function compareYear(tYear, gYear) {
  if (!tYear || !gYear) return 'wrong';
  if (tYear === gYear) return 'correct';
  if (Math.abs(tYear - gYear) <= 1) return 'close';
  return 'wrong';
}

/** 核心对比：返回所有属性的 GuessStatus */
export function compareGuess(target, guess) {
  return {
    class: compareAttribute(target.class, guess.class),
    subclass: compareSubclass(target.subclass, target.class, guess.subclass, guess.class),
    faction: compareFaction(target.faction, guess.faction),
    rarity: compareRarity(target.rarity, guess.rarity),
    race: compareAttribute(target.race, guess.race),
    gender: compareAttribute(target.gender, guess.gender),
    releaseYear: compareYear(target.releaseYear || 0, guess.releaseYear || 0),
    tags: compareTags(target.tags || [], guess.tags || []),
    position: comparePosition(target.position, guess.position),
  };
}

/** 是否猜中（id 匹配或 name 匹配） */
export function isWin(target, guess) {
  return target.id === guess.id || target.name === guess.name;
}

/** 是否为异格关系（与客户端 src/lib/game-engine.ts 一致） */
export function isAlterRelation(target, guess) {
  if (!target || !guess) return false;
  if (guess.alterBase && guess.alterBase === target.name) return true;
  if (target.alterBase && target.alterBase === guess.name) return true;
  if (guess.alterBase && target.alterBase && guess.alterBase === target.alterBase) return true;
  if (target._alters) {
    const alters = target._alters.split(',').map(s => s.trim()).filter(Boolean);
    if (alters.includes(guess.name)) return true;
  }
  if (guess._alters) {
    const alters = guess._alters.split(',').map(s => s.trim()).filter(Boolean);
    if (alters.includes(target.name)) return true;
  }
  return false;
}
