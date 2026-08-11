/** 敌方单位数据类型 */
export interface Enemy {
  id: number;
  name: string;
  nameEn: string;
  race: string;         // 分组后的种类
  raceRaw: string;      // 原始种类（PRTS 数据）
  level: string;        // 地位：普通/精英/领袖
  attackType: string;   // 攻击方式：近战/远程/不攻击/近战 远程
  damageType: string;   // 伤害类型：物理/法术/治疗/无/物理 法术
  motion: string;       // 行动方式：地面/飞行/未知
  endure: string;       // 生命值评级 SS~E
  attack: string;       // 攻击力评级 SS~E
  defence: string;      // 防御力评级 SS~E
  moveSpeed: string;    // 移动速度评级 SS~E
  attackSpeed: string;  // 攻击速度评级 SS~E
  resistance: string;   // 法术抗性评级 SS~E
  ability: string;      // 能力描述（纯文本）
  assetName: string;    // 头像文件名
  wikiUrl: string;      // PRTS 页面链接
  isBoss: boolean;
  isElite: boolean;
}

export type EnemyDifficulty = 'easy' | 'normal' | 'hard';

export type GuessStatus = 'correct' | 'close' | 'wrong';

/** 单次猜测的属性对比结果 */
export interface EnemyGuessComparisons {
  race: GuessStatus;
  level: GuessStatus;
  attackType: GuessStatus;
  damageType: GuessStatus;
  motion: GuessStatus;
  endure: GuessStatus;
  attack: GuessStatus;
  defence: GuessStatus;
  moveSpeed: GuessStatus;
  attackSpeed: GuessStatus;
  resistance: GuessStatus;
}

/** 一次猜测的完整结果 */
export interface EnemyGuessResult {
  enemy: Enemy;
  comparisons: EnemyGuessComparisons;
  timestamp: number;
}
