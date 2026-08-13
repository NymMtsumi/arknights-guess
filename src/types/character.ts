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
  factionEn: string;      // 阵营（英）— 注意：此字段来自 PRTS wiki 抓取，约 37% 条目含中文，且代码中未使用（UI 始终用 faction）
  rarity: number;         // 星级 1-6
  race: string;           // 种族（中）
  raceEn: string;         // 种族（英）— 注意：此字段来自 PRTS wiki 抓取，约 83% 条目含中文，且代码中未使用（UI 始终用 race）
  gender: string;         // 性别（中）
  genderEn: string;       // 性别（英）
  releaseYear: number;    // 上线年份
  tags: string[];          // 标签/词缀
  alterBase: string;       // 异格原型（空=非异格）
  _alters?: string;        // 该原型的异格形态列表(逗号分隔)
  position: string;        // 部署位：高台/地面/皆可
  positionEn: string;      // Ranged/Melee/Both
  popularity?: string;     // 热度：hot/normal/cold
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
  tags: GuessStatus;
  position: GuessStatus;
}

/** 一次猜测的完整结果 */
export interface GuessResult {
  character: Character;
  comparisons: GuessComparisons;
  timestamp: number;
  /** 服务端判定：本猜测即为答案（派对模式，服务端不下发目标，改由该标记驱动胜者行高亮） */
  correct?: boolean;
  /** 服务端判定：本猜测与答案为异格关系（派对模式） */
  isAlter?: boolean;
}

/** 难度等级 */
export type Difficulty = 'easy' | 'medium' | 'hard';

/** 游戏状态 */
export type GameStatus = 'idle' | 'playing' | 'won' | 'lost';
