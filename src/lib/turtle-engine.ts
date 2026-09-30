import type { Character, GuessStatus } from '../types/character';
import { compareGuess } from './game-engine';

/**
 * 海龟汤（盲盒变体）— 纯逻辑。
 *
 * 玩法：谜底是一个干员，玩家不知道是谁。每回合可以**提问**（选一个维度 + 一个取值，
 * 得到「准确 / 接近 / 错误」）或**直接点名猜测**（中 / 不中）。
 * 提问与猜测**共用一个次数池** —— 这是照搬弗一把的核心约束
 * （`csgofriberg/server/src/services/turtleSoup.ts`：`MAX_ATTEMPTS = 24`，
 *  `remainingQuestions = MAX_ATTEMPTS - questionCount - guessCount`）。
 *
 * 🔴 本文件最要紧的一条：**「接近」的定义不在这里，在 `compareGuess` 里**。
 *    实现方式是「复制谜底、只改被问的那一维，再走一遍 `compareGuess`」——
 *    于是海龟汤的准确/接近判定与经典模式**逐字同一份代码**，不存在两套口径漂移的可能。
 *    弗一把也是这么做的（`compareQuestion` 就是个 switch，转手调用 compareGuess 用的
 *    同一批 teamAttr / nationalityAttr / numberAttr）。
 *
 * ⚠️ 纯函数，**不 import 干员数据**（池子当参数传入）—— 照 `game-engine.ts` 的形状。
 *    所以本文件可以被 `tests/_ts-load.mjs` 直接加载做确定性测试。
 */

/** 提问与猜测**共享**的次数池。24 = 锁死 9 个维度最少 9 次 + 1 次点名，留 14 次容错。 */
export const MAX_ATTEMPTS = 24;

/**
 * 可提问的维度 = 九个标准词条。
 *
 * 🔴 **不含 `artist`** —— 用户决策：画师只是自建房间的可选词条，不得进入海龟汤
 *    （与「经典单人/每日/多人不出现画师列」同一条约束）。
 *    注意这与 `server/constants.js` 的 `ATTR_KEYS` 不是 import 关系而是**重复**：
 *    前者是前后端契约、动不得；这里是一份独立的玩法清单，故意的。
 */
export const QUESTION_FIELDS = [
  'class', 'subclass', 'faction', 'rarity', 'race', 'gender', 'releaseYear', 'position', 'tags',
] as const;
export type QuestionField = typeof QUESTION_FIELDS[number];

/**
 * 数值维：非「准确」时额外给 ↑/↓ 方向提示。
 *
 * ⚠️ 方向指的是**目标相对你所问的值**，不是你该往哪猜 —— 沿弗一把 numberAttr 的语义
 *    （`hint: targetVal > guessVal ? 'higher' : 'lower'`，由服务端算好后原样下发）。
 *    写反了玩家会一路往反方向问，所以 `tests/turtle-store-test.mjs` 的 a9 专测方向。
 */
const NUMERIC_FIELDS = new Set<string>(['rarity', 'releaseYear']);

/** 提问的一次记录（用于日志与 UI 渲染） */
export interface TurtleQuestion {
  field: QuestionField;
  value: string | number;
  level: GuessStatus;
  hint?: 'higher' | 'lower';
}

/** 点名猜测的一次记录 */
export interface TurtleGuess {
  /** 干员 id —— 供页面拼 `guessedIds` 传给 GameSearch，已猜过的名字在下拉里不再出现 */
  id: string;
  name: string;
  correct: boolean;
}

/** 提问的答复 */
export interface QuestionAnswer {
  level: GuessStatus;
  hint?: 'higher' | 'lower';
}

/** 次数池只认这两个计数，其余字段与它无关 */
export interface AttemptCounters {
  questionCount: number;
  guessCount: number;
}

/** 剩余次数（提问与猜测共享） */
export function remainingAttempts(c: AttemptCounters): number {
  return Math.max(0, MAX_ATTEMPTS - c.questionCount - c.guessCount);
}

/** 次数是否已耗尽 —— 耗尽即判负，无需玩家再做任何动作 */
export function isExhausted(c: AttemptCounters): boolean {
  return c.questionCount + c.guessCount >= MAX_ATTEMPTS;
}

/** `tags` 是数组维，问句传的是单个词缀，比较时包成单元素数组 */
function toGuessValue(field: QuestionField, value: string | number): unknown {
  return field === 'tags' ? [String(value)] : value;
}

/**
 * 子职业 → 所属职业。
 *
 * 🔴 为什么必须有这个反查：`compareSubclass` 是**两字段**判定 ——
 *    `compareSubclass(targetSubclass, targetClass, guessSubclass, guessClass)`。
 *    「克隆谜底、只覆盖被问的那一维」这招对它**不成立**：class 没被覆盖，
 *    于是它与 targetClass 恒等，`targetClass === guessClass` 恒真 →
 *    **问任何非谜底的子职业都返回 close**，整个维度退化成常量回答
 *    （实测 400 随机对里 345/3200 处漂移全部出自这一处，见 tests a2）。
 *    所以问一个子职业时，必须**连同它隐含的职业一起给出**。
 *
 * 方舟的子职业严格嵌在唯一职业之下（72 个子职业 0 冲突，由 tests b6 钉住），
 * 所以这个反查是函数而非多值。池子里找不到该子职业时返回 undefined，
 * 调用方据此退回「职业对不上」→ 诚实答 wrong（取值域外的值本就不可能是谜底）。
 */
function classOfSubclass(pool: Character[], subclass: string): string | undefined {
  for (const c of pool) if (c.subclass === subclass) return c.class;
  return undefined;
}

/**
 * 回答一次提问。**不改任何状态**（计数由调用方推进）。
 *
 * @param target 谜底干员。本函数是纯函数，既不持久化也不下发；**局中**谜底只活在内存里
 *               （结算时由页面另上报 targetName，见 `stores/turtle-store.ts` 文件头）
 * @param field  被问的维度
 * @param value  所问的取值（应来自 `buildQuestionOptions`）
 * @param pool   取值域来源。**必填、不给默认值** —— 只有它能反查子职业隐含的职业
 *               （见 `classOfSubclass`）；给个默认值等于留一条静默退化的后门。
 */
export function askQuestion(
  target: Character,
  field: QuestionField,
  value: string | number,
  pool: Character[],
): QuestionAnswer {
  // 复制谜底、只覆盖被问的那一维 → 复用 compareGuess 的全部 close 分支。
  // 这样 faction 的主阵营/大组、position 的同位置、tags 的集合关系、
  // rarity/releaseYear 的 ±1 全部自动与经典模式一致，一行判断都不用重写。
  const guessed: Character = { ...target };
  const rec = guessed as unknown as Record<string, unknown>;
  rec[field] = toGuessValue(field, value);

  // 子职业：把隐含的职业一并覆盖（唯一一个跨字段依赖，见 classOfSubclass）
  if (field === 'subclass') {
    rec.class = classOfSubclass(pool, String(value)) ?? '';
  }

  // ⚠️ 这里**不加 `as keyof …` 断言**：`QuestionField` 的 9 个字面量与 `GuessComparisons`
  //    里 9 个**必填**键完全同集，直接索引就是 `GuessStatus`。
  //    写成 `as keyof GuessComparisons` 反而把可选的 `artist?: GuessStatus` 拉进来，
  //    索引结果变成 `GuessStatus | undefined` → 两处 TS2322（第一版就栽在这）。
  const level = compareGuess(target, guessed)[field];

  if (level !== 'correct' && NUMERIC_FIELDS.has(field)) {
    return { level, hint: Number(target[field as 'rarity' | 'releaseYear']) > Number(value) ? 'higher' : 'lower' };
  }
  return { level };
}

/**
 * 某维度的**取值域** = 池子里该维度出现过的所有取值（去重）。
 *
 * 这是弗一把 `SoupOptions` 的同构物（它也把 teams / countries 预先抽成白名单，
 * 非法取值直接 `SOUP_INVALID_OPTION`）—— 玩家只能从下拉里选，不出现自由文本输入。
 * 数值维（rarity / releaseYear）升序，其余保持首次出现顺序（沿用数据里的自然排序）。
 */
export function buildQuestionOptions(pool: Character[], field: QuestionField): (string | number)[] {
  if (field === 'tags') {
    const seen = new Set<string>();
    for (const c of pool) for (const t of c.tags || []) seen.add(t);
    return [...seen];
  }
  const seen = new Set<string | number>();
  for (const c of pool) {
    const v = (c as unknown as Record<string, unknown>)[field];
    if (typeof v === 'string' && v) seen.add(v);
    else if (typeof v === 'number' && (v !== 0 || field === 'rarity')) seen.add(v);
  }
  const out = [...seen];
  if (NUMERIC_FIELDS.has(field)) out.sort((a, b) => Number(a) - Number(b));
  return out;
}
