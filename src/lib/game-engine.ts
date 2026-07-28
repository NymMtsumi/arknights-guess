import type { Character, Difficulty, GuessComparisons, GuessResult, GuessStatus } from '@/types/character';
import { pickRandom } from './utils';

/**
 * 按难度筛选角色池
 */
export function getPoolByDifficulty(characters: Character[], difficulty: Difficulty): Character[] {
  switch (difficulty) {
    case 'easy':
      // 简单：仅 5-6 星角色（更知名）
      return characters.filter(c => c.rarity >= 5);
    case 'medium':
      // 普通：3-6 星
      return characters.filter(c => c.rarity >= 3);
    case 'hard':
    default:
      // 困难：全部
      return characters;
  }
}

/**
 * 从角色池中随机选择目标
 */
export function pickTarget(characters: Character[], difficulty: Difficulty): Character {
  const pool = getPoolByDifficulty(characters, difficulty);
  return pickRandom(pool);
}

/**
 * 对比两个属性，返回 GuessStatus
 */
function compareAttribute(targetVal: string, guessVal: string): GuessStatus {
  return targetVal === guessVal ? 'correct' : 'wrong';
}

/**
 * 对比星级
 */
function compareRarity(target: number, guess: number): GuessStatus {
  if (target === guess) return 'correct';
  if (Math.abs(target - guess) === 1) return 'close';
  return 'wrong';
}

/**
 * 对比子职业：相同=correct，同职业大类=close，不同=wrong
 */
function compareSubclass(
  targetSubclass: string, targetClass: string,
  guessSubclass: string, guessClass: string
): GuessStatus {
  if (targetSubclass === guessSubclass) return 'correct';
  if (targetClass === guessClass) return 'close';
  return 'wrong';
}

/**
 * 对比阵营：相同=correct，同阵营大组=close，不同=wrong
 */
function compareFaction(targetFaction: string, guessFaction: string): GuessStatus {
  if (targetFaction === guessFaction) return 'correct';
  // 罗德岛系：罗德岛、巴别塔
  const rhodesGroup = ['罗德岛', '巴别塔'];
  // 龙门系
  const lungmenGroup = ['龙门'];
  // 深海系
  const abyssalGroup = ['深海猎人', '阿戈尔'];
  // 乌萨斯系
  const ursusGroup = ['乌萨斯'];
  // 维多利亚系
  const victoriaGroup = ['维多利亚'];

  const groups = [rhodesGroup, lungmenGroup, abyssalGroup, ursusGroup, victoriaGroup];
  for (const group of groups) {
    if (group.includes(targetFaction) && group.includes(guessFaction)) return 'close';
  }
  return 'wrong';
}

/**
 * 根据名字查找角色
 */
export function findCharacterByName(characters: Character[], name: string): Character | undefined {
  const trimmed = name.trim();
  return characters.find(
    c => c.name === trimmed || c.nameEn.toLowerCase() === trimmed.toLowerCase()
  );
}

/**
 * 核心游戏逻辑：对比猜测和目标
 */
export function compareGuess(target: Character, guess: Character): GuessComparisons {
  return {
    class: compareAttribute(target.class, guess.class),
    subclass: compareSubclass(target.subclass, target.class, guess.subclass, guess.class),
    faction: compareFaction(target.faction, guess.faction),
    rarity: compareRarity(target.rarity, guess.rarity),
    race: compareAttribute(target.race, guess.race),
    gender: compareAttribute(target.gender, guess.gender),
  };
}

/**
 * 检查是否获胜（名字匹配）
 */
export function isWin(target: Character, guess: Character): boolean {
  return target.id === guess.id;
}

/**
 * 创建猜测结果
 */
export function makeGuess(
  target: Character,
  guessedChar: Character,
): GuessResult {
  return {
    character: guessedChar,
    comparisons: compareGuess(target, guessedChar),
    timestamp: Date.now(),
  };
}

/**
 * 获取所有可能的属性值列表（用于搜索建议）
 */
export function getAllNames(characters: Character[]): string[] {
  const names: string[] = [];
  for (const c of characters) {
    names.push(c.name);
    if (c.nameEn !== c.name) names.push(c.nameEn);
  }
  return names;
}

/**
 * 搜索匹配的角色（中英文模糊匹配）
 */
export function searchCharacters(characters: Character[], query: string): Character[] {
  if (!query.trim()) return [];
  const q = query.trim().toLowerCase();
  return characters.filter(
    c => c.name.toLowerCase().includes(q) || c.nameEn.toLowerCase().includes(q)
  ).slice(0, 8); // 最多返回 8 个结果
}
