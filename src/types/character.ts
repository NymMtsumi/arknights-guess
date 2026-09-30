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
  /**
   * 画师（中/日/英混排，如「唯@W」「Liduke」「竜崎いち」）。
   * 取自上游 skin_table.json 的「<id>#1」基础皮（不是 @sale 皮肤），与 PRTS 同名。
   * ⚠️ 可选词条：只有自建房（单人/多人）能把它选进棋盘；经典单人/每日/多人永不渲染此列。
   */
  artist: string;
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
  /**
   * 画师对比结果。**可选**，且不在 PARTY_ATTR_KEYS 里。
   *
   * 为什么是可选用而非必填：必填会迫使 daily-store 的 toGuessComparisons 与
   * party-handlers 的 ALL_WRONG 也各补一个值 —— 那等于把画师推进「每日」与
   * 「派对」两条路径，而它只该被自建房消费。
   * 留空时 GuessTable.tsx:176 的 `statusKey in guess.comparisons` 为 false →
   * 该列直接不渲染；而经典/每日/派对本来就没有画师列，所以是安全兜底。
   */
  artist?: GuessStatus;
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
