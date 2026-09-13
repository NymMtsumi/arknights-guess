// 服务端游戏引擎：干员对比逻辑（与客户端 src/lib/game-engine.ts 保持一致）
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 允许覆盖数据文件路径（生产不设 → 与原来完全一致）。
// 冒烟测试用它指向临时文件：否则「管理员增删干员」这类用例会改写 git 跟踪的
// characters.json，与 src/data/characters.json 出现字节差异 → 直接挂掉 CI 的
// check-characters.mjs 一致性 gate。admin.js 用的是同名变量，两者必须一致。
export const CHARACTERS_PATH = process.env.CHARACTERS_PATH || join(__dirname, 'characters.json');

let ALL_CHARS = [];
let _loaded = false;

function readCharactersFile() {
  const data = JSON.parse(readFileSync(CHARACTERS_PATH, 'utf-8'));
  // 空数组/非数组一律视为读失败。否则一次「内容被清空」的写入会让池子变空，
  // 之后每一局 randomTarget 都返回 { id:'', name:'?' }，且不报任何错。
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('characters.json 为空或不是数组');
  }
  return data;
}

export function loadGameEngine() {
  if (_loaded) return;
  try {
    ALL_CHARS = readCharactersFile();
    _loaded = true;
    console.log(`[game-engine] Loaded ${ALL_CHARS.length} characters for server-side comparison`);
  } catch (err) {
    console.error('[game-engine] Failed to load characters.json:', err.message);
  }
}

/**
 * 强制重读 characters.json —— 管理员增删干员后必须走这条。
 *
 * ⚠️ 这就是原先的 bug：管理员写入成功后调用的 `reloadCharacters` 接到的是
 *    `loadCharacters`，而它内部的 `loadGameEngine()` 被上面那个 `_loaded` 守卫挡掉，
 *    于是 `getAllCharacters()` 原样返回**旧数组**。控制台会照打「已加载 N 干员」，
 *    看起来像成功了，实际新干员在服务端根本不存在 —— 具体后果：
 *      · randomTarget / pickDailyTarget 抽不到新干员；
 *      · findCharByName 找不到新干员 → /api/save-game 的 target 校验（game.js:122）
 *        直接把「猜中新干员」的这局判为非法请求。
 *
 * 失败时**保留旧池**（不清空）：宁可少几个新干员，也不能让全站无干员可用。
 * 注意这里是**换引用**而不是原地清空 —— 各调用点每次都用模块变量取值，
 * 原地清空会在换入新数据前留出一个「池子为空」的窗口。
 *
 * @returns {boolean} 是否成功换入新数据
 */
export function reloadGameEngine() {
  try {
    const data = readCharactersFile();
    ALL_CHARS = data;
    _loaded = true;
    console.log(`[game-engine] Reloaded ${ALL_CHARS.length} characters`);
    return true;
  } catch (err) {
    console.error(`[game-engine] reload 失败，继续沿用旧的 ${ALL_CHARS.length} 个干员:`, err.message);
    return false;
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
