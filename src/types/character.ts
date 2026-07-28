/** 干员角色数据结构 */
export interface Character {
  id: string;
  name: string;           // 中文名
  nameEn: string;         // 英文名
  class: string;          // 职业（中）
  classEn: string;        // 职业（英）
  subclass: string;       // 子职业（中）
  subclassEn: string;     // 子职业（英）
  faction: string;        // 阵营（中）
  factionEn: string;      // 阵营（英）
  rarity: number;         // 星级 1-6
  race: string;           // 种族（中）
  raceEn: string;         // 种族（英）
  gender: string;         // 性别（中）
  genderEn: string;       // 性别（英）
  releaseYear: number;    // 上线年份
}

/** 猜测状态：正确 / 接近 / 错误 */
export type GuessStatus = 'correct' | 'close' | 'wrong';

/** 单次猜测的属性对比结果 */
export interface GuessComparisons {
  class: GuessStatus;
  subclass: GuessStatus;
  faction: GuessStatus;
  rarity: GuessStatus;
  race: GuessStatus;
  gender: GuessStatus;
  releaseYear: GuessStatus;
}

/** 一次猜测的完整结果 */
export interface GuessResult {
  character: Character;
  comparisons: GuessComparisons;
  timestamp: number;
}

/** 难度等级 */
export type Difficulty = 'easy' | 'medium' | 'hard';

/** 游戏状态 */
export type GameStatus = 'idle' | 'playing' | 'won' | 'lost';
