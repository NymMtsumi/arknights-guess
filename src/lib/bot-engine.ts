import type { Character, Difficulty, GuessComparisons } from '@/types/character';
import { compareGuess } from './game-engine';

/**
 * 人机对手的大脑 —— 纯逻辑，不依赖服务端、不依赖 React。
 *
 * ## 🔴 最要紧的一条：人机**不可能**读到答案
 *
 * 这不是靠自觉，是靠**接口形状**：
 *   · `botPick(brain)` 的入参只有 brain，**没有 target**；
 *   · `botLearn(brain, guess, feedback)` 的第三个参数是一行**反馈**（`GuessComparisons`），
 *     也就是玩家在自己棋盘上看到的那三色格 —— 和真人拿到的信息**逐字相同**。
 *
 * 真答案在本模式下确实躺在浏览器的内存里（方案 A 是纯客户端玩法，谜底由浏览器选），
 * 但人机拿不到它：它没有那个参数，也没有那条引用。源码级的不变量由
 * `scripts/check-bot-isolation.mjs` 钉住（禁止本文件出现 target/answer/secret 等标识符），
 * 挂在 deploy.yml 的 review gate 上。**别把那条哨兵当形式主义** ——
 * 一旦有人「顺手」把 target 传进来，准确率会立刻变成 100%，而面板上毫无异常。
 *
 * ## 难度是怎么定标的（实测，不是拍脑袋）
 *
 * 两个旋钮合成一档难度：
 *   ① **注意到几列** —— 它只用 `TIER_ATTRS` 里那几条去筛候选集，其余当作不存在；
 *   ② **怎么选下一个要猜的人** —— 见 `botPick`：不是随便挑一个候选，而是挑
 *      「能把当前候选集切得最开」的那个（信息增益，前 2 名里再随机取一个）。
 *
 * ②是这一版新加的，因为旧版是**在候选集里均匀随机取一个**。候选集本身一直是准的
 * （`botLearn` 按整行反馈的完整签名筛），但从不挑「最能一刀切开的那个」意味着
 * 拿 8 次预算去撞一个还剩几十人的集合 —— 表现就是「明明掌握了信息却猜得像个新人」。
 * 单换策略提升有限（同样 4 列：5.30 → 4.73 次），**列数才是主旋钮**；两者叠加才够。
 *
 * 定标方法：对**全部 429 个可能答案**穷举，走真实调用路径
 * （`createBrain → botPick → compareGuess → botLearn`），多种子取均值。
 * **可复现的那一份住在 `tests/bot-engine-test.mjs`** —— 下面是它跑的实测值
 * （6 种子与 20 种子两次跑出来的数只差 0.01，已是很紧的估计），不是另写一份仿真的结果。
 *
 * | 档 | 注意到的列 | 单局命中率(K=8) | 平均猜中次数 |
 * |---|---|---|---|
 * | 低 | race + faction + gender | 54.9% | 6.52 |
 * | 中 | + class + subclass | 96.6% | 4.91 |
 * | 高 | + releaseYear | 100.0% | 3.87 |
 *
 * ⚠️ 「平均猜中次数」的口径**含没猜中的那些局**（它们按用满 8 次计）—— 所以低档的
 *    6.52 不是「猜中时平均要 6.5 次」（那是 5.30），而是「把所有局摊平」。这与排行榜上
 *    那个（`总猜测数 / 总场次`，见 `leaderboard/page.tsx`）**是同一个口径**，
 *    也正是需求①要拿来比较的数。
 *
 * 🔴 **高档的目标是「平均约 3.8 次」**，2026-10-07 由用户拍板下修 —— 上一版**超调**了：
 *    它注意到全部 8 列、实测 2.98 次，比原定目标还强出一大截，人机其实是碾压级的。
 *
 *    ⚠️ 落地值是 **3.87** 而不是 3.80：**列数是离散旋钮，做不到连续逼近**。
 *       实测可达的只有 7 列 3.57 / 6 列 3.87 两级，3.8 正落在中间 —— 取更近的 6 列。
 *       **别想用「选点随机化」补这 0.07**：那条路的天花板就是「在候选集里均匀随机」，
 *       8 列下也才 3.45 次（已实测），够不到 3.8；而且它正是用户最初报的那个
 *       「明明掌握了信息却不用」的毛病。下修难度只有一条正路：**减少人机注意到的列**。
 *
 *    外部对照（这个数字的意义所在）：2026-10-07 生产环境困难榜第 1 名
 *    （1325 局 / 1319 胜 / 5602 次总猜测）= 4.228 次 —— 3.87 仍比他快 0.36，
 *    即**困难人机依然强于最强的人类玩家，只是不再碾压**。
 *    该榜打的是困难模式，而困难模式本来就隐藏星级列 —— 所以人机删掉星级后
 *    （见 `TIER_ATTRS`）两边是**在同一可见信息下**比较的，基准干净。
 *    `tests/bot-engine-test.mjs` 的 `b5` 把这条需求本身钉成了断言。
 *    （原文这里写的 `e1` 是笔误 —— `e1` 验的是候选集，需求那条一直是 `b5`。）
 *
 * ⚠️ **准确率与答案池强相关**：同一个高档人机，池子越小越准。所以本模式
 *    **把答案池固定为全量 429**（见 `BOT_POOL_DIFFICULTY`），否则「人机难度」
 *    会跟着玩家的池子选择漂。
 *
 * ⚠️ 「中档只用 5 个词条就跳到 96.8%」不是笔误：低档那三条（种族/阵营/性别）里
 *    种族与性别各只有两三种取值，**一次猜测最多只能切成 12 堆**，所以收窄得极慢；
 *    中档补上职业与分支后切分空间陡增，一步就收得住。这不是「凑数字」，
 *    是这两组词条的信息量本身差着一个数量级。
 */

/**
 * 人机档位 = 该局的难度。
 *
 * **直接复用 `Difficulty`**（easy=低级人机 / medium=中级 / hard=高级），而不是另起
 * 'low'|'medium'|'high'。理由是**会静默错配**：档位要落进 `games.difficulty` 列，
 * 而 `/api/leaderboard` 的难度过滤写死了 `['easy','medium','hard'].includes(difficulty)`。
 * 若用 low/high，难度='low' 会落进白名单外 → 退化成「全部档位混在一起」；
 * 而难度='medium' 又会歪打正着地匹配到中档人机 —— 一半对一半错，最难查的那种。
 * 复用 Difficulty 后，排行榜按档位分组是**零改动**的白拿。
 *
 * ⚠️ 别把这里的 difficulty 读成「题库难度」：人机模式的题库**恒定是全量**
 *    （见 BOT_POOL_DIFFICULTY），这个字段纯粹是**人机强度**。
 */
export type BotTier = Difficulty;

/** 标准房的棋盘列数 —— 人机只在这 9 条里「注意到」几条（不含自建房的画师） */
type AttrKey = Exclude<keyof GuessComparisons, 'artist'>;

/**
 * 每档「注意到」的词条。**改这里就是改难度**，改完必须重跑定标测试
 * （`tests/bot-engine-test.mjs` 会在准确率偏离目标 ±6pt 时直接失败）。
 *
 * 三个集合**严格嵌套**（低 ⊂ 中 ⊂ 高）：「高档会的东西是低档的超集」。
 * 这样三档的强弱关系可归因到一个方向（注意到几列），而不是「低档擅长 A、高档擅长 B」
 * 那种互相不可比的口径 —— 后者在调参时无法预测改动的效果。
 *
 * ⚠️ **不含 rarity**：人机页的棋盘已把星级列删掉（用户需求②），
 *    人机内部也不许读它 —— 「玩家看不见的信号，人机也不许用」。
 *    星级是单条最强的信号：实测把它加回现高档（6 列 → 7 列）能从 3.86 掉到 3.35 次。
 *    所以这里删掉它同时也是**难度下修**，不是因为它在棋盘上没地方放。
 *    （标准房的棋盘本来也没有星级列 —— 它是榜上可见、棋盘上不可见的那种信号。）
 */
const TIER_ATTRS: Record<BotTier, readonly AttrKey[]> = {
  easy: ['race', 'faction', 'gender'],
  medium: ['class', 'subclass', 'race', 'faction', 'gender'],
  hard: ['class', 'subclass', 'race', 'faction', 'gender', 'releaseYear'],
};

/**
 * 每次猜测之间的「思考」延迟（ms）。
 *
 * 反推方式：目标耗时 ÷ 平均猜中次数 ≈ 低 69000/6.88≈10000、中 54284/6.62≈8200、
 * 高 39372/5.79≈6800，再取整到百位。三档的目标耗时分别是 69s / 54s / 39s。
 *
 * ⚠️ **这两个数仍是上一版定标反推出来的，本轮没动**（准确率那一轮改的是「注意到几列」
 *    与选点策略，与节奏正交）。副作用是人机的**实际**单局耗时会跟着新的平均猜中次数
 *    一起缩短（高档 2.98 次 × 6.8s ≈ 20s，旧版 5.79 次 ≈ 39s）—— 这是**有意的**：
 *    变强的人机本来就该更早结束，而不是被拉长节奏去凑那 39 秒。
 *    要动节奏请改这里，别去动 `BOT_MAX_GUESSES`。
 *
 * 🔴 **硬约束（含 tick 开销）**：
 *      `(base + 抖动上限 + BOT_TICK_MS) × BOT_MAX_GUESSES ≤ BOT_ROUND_TIME`
 *    人机不是用 setTimeout 精确定时落子的，而是在一个固定周期的 tick 里「到点就猜」
 *    （面板同时还要跑计时器，一个 tick 干两件事，省掉一个会互相打架的定时器）。
 *    于是每次落子都可能晚最多一个 tick —— 这个开销**会累加 8 次**，必须算进预算。
 *
 *    只要超了单局时长，人机就会在最后一猜之前被计时器掐掉 —— 表现是「偶尔少猜一次」，
 *    而那会静默地把实测准确率拉低几个点，且极难归因。
 *    第一版设的抖动（低档 ±2200）踩过这条线（(10170+2200)×8 = 98.9s > 90s）；
 *    第二版把抖动收到 ±1000 但**没算 tick 开销**，低档最坏 88.8s + 8×100ms = 89.6s，
 *    只剩 400ms 余量 —— 后台标签页被浏览器把定时器节流到 1s 就会翻车。
 *    现在的余量（低档 3.6s）才扛得住几次节流。
 *    `tests/bot-engine-test.mjs` 有一条断言钉住这个不等式。
 *
 * ⚠️ 这三个值**只影响耗时，不影响准确率** —— 两个指标是正交的旋钮，
 *    这也是为什么耗时不靠「让低级人机猜得慢一点」去凑。
 */
const TIER_DELAY_MS: Record<BotTier, number> = {
  easy: 10_000,
  medium: 8_200,
  hard: 6_800,
};

/**
 * 延迟抖动幅度（±，ms）。**没有它，每档的节奏会像节拍器** ——
 * 每 10 秒准点落子，一眼就能看出对面是程序。抖动必须是**有界且非负**的：
 * 下限不能小于 0，否则一次大抖动会让延迟变成负数（`botDelayMs` 另有一层钳制兜底）。
 *
 * 上限受上面那条硬约束压制，见 TIER_DELAY_MS 的注释。
 */
const TIER_JITTER_MS: Record<BotTier, number> = {
  easy: 700,
  medium: 1_200,
  hard: 1_200,
};

/**
 * **每小局第一猜**的等待时长（ms）。之后每一猜仍走 `botDelayMs`（`TIER_DELAY_MS`）。
 *
 * 用户需求③：真人的第一猜不需要思考 —— 随手点一个熟悉的干员就开局了。人机要像真人，
 * 就不能在开局时先「想」10 秒再落子；那一猜**本来也不消耗任何信息**（第一猜的候选集
 * 恒为全量，与答案无关），所以那段沉默既不像人、也没有信息学上的理由。
 *
 * 三档取同一个值：这条是**像不像真人**，不是难度旋钮 —— 让低级人机开局更快没有任何意义，
 * 只会多一个要定标的参数。（第一猜之后的节奏差异已经由 `TIER_DELAY_MS` 表达了。）
 *
 * ⚠️ 它**不参与** `(base + 抖动 + tick) × BOT_MAX_GUESSES ≤ BOT_ROUND_TIME` 那条硬约束 ——
 *    那个不等式算的是「8 次都按最慢节奏落子」的最坏情况，而第一猜只会**更早**落子，
 *    所以这条改动只会让余量变大。`tests/bot-engine-test.mjs` 的 c 段仍按 8 次最慢算。
 */
export const BOT_FIRST_DELAY_MS: Record<BotTier, number> = {
  easy: 1_500,
  medium: 1_500,
  hard: 1_500,
};

/**
 * 驱动人机的 tick 周期（ms）。
 *
 * 页面用它同时跑两件事：推进单局计时器、以及「到点就替人机落子」。两者共用一个
 * interval 是**有意的** —— 拆成两个定时器后，「人机落子」与「时间到」会在同一瞬间
 * 竞争谁先执行，落在那条缝里的那一猜会被吞掉，且只在极偶然的时序下复现。
 *
 * 取值理由：100ms 对 ±700ms 起的抖动足够细（量化误差 <15%），又不会让面板每秒重渲染十几次。
 * 🔴 它**同时是时间预算的一部分**（每次落子最多晚一个 tick），改小无害、改大要先算账，
 *    见 TIER_DELAY_MS 的硬约束。
 */
export const BOT_TICK_MS = 100;

/**
 * 三档的完整配置（只读导出）。
 *
 * 存在意义是让**测试**能断言上面那条硬约束，而不必把 10000/700 这些魔法数字
 * 抄进测试文件 —— 抄一份就会漂一份，而漂了之后测试仍然"通过"，只是不再检查任何东西。
 */
export const BOT_TIERS: Record<BotTier, { attrs: readonly AttrKey[]; delayMs: number; jitterMs: number }> =
  Object.freeze({
    easy: { attrs: TIER_ATTRS.easy, delayMs: TIER_DELAY_MS.easy, jitterMs: TIER_JITTER_MS.easy },
    medium: { attrs: TIER_ATTRS.medium, delayMs: TIER_DELAY_MS.medium, jitterMs: TIER_JITTER_MS.medium },
    hard: { attrs: TIER_ATTRS.hard, delayMs: TIER_DELAY_MS.hard, jitterMs: TIER_JITTER_MS.hard },
  });

/** 猜测次数上限。**锁定，不可由玩家配置** —— 它是上面那套定标的锚点（见文件头） */
export const BOT_MAX_GUESSES = 8;

/**
 * 单局时长（ms）。取多人房 `ROUND_TIME_PRESETS` 里的一档（90 秒）——
 * **不是**多人的默认时长（`server/constants.js` 的 `ROUND_TIME` 是 120 秒）。
 * 三档的最坏用时都得装得下（硬约束见文件头）。
 */
export const BOT_ROUND_TIME = 90_000;

/**
 * 答案池固定为「全量」。
 *
 * 用字面量而不是复用 `getPoolByDifficulty`：后者的 medium 与 hard **返回同一个池子**，
 * 而这里要的是一个**与轮次难度无关的常量**。写死能把「有人日后改了那个函数」这件事
 * 与我们的定标解耦 —— 这份定标是拿 429 人测出来的，池子一变它就作废。
 */
export const BOT_POOL_DIFFICULTY = 'hard' as const;

export interface BotBrain {
  readonly tier: BotTier;
  readonly attrs: readonly AttrKey[];
  /**
   * 建脑时吃进来的**整份干员表**（人机只拿它当索引，不用来筛选）。
   *
   * ⚠️ 它存在的唯一理由是给 `botPick` 一个**稳定的坐标原点**：`candidates` 每一步都被
   *    `.filter()` 换成新数组，而两两签名缓存必须按「同一张表」索引 —— 拿每步的
   *    `candidates` 当键会让缓存每步重建一次（等于没有缓存）。
   *    它**不是**「答案的候选范围」之类的语义：能不能猜到只由 `candidates` 决定，
   *    把这个字段当成「缩小搜索范围」的开关是理解错了。
   */
  readonly roster: readonly Character[];
  /**
   * 人机认为「还有可能是答案」的干员。**完全由反馈行驱动**，与真答案无关。
   *
   * 不变量：真答案**永远**在这个集合里 —— 因为筛选条件是「与 feedback 同签名」，
   * 而 feedback 本身就是真答案产生的。所以这个集合不会空。
   */
  readonly candidates: Character[];
  /**
   * 已猜过的 id（按序）。**不参与筛选** —— 见下方 botLearn 的注释。
   *
   * ⚠️ 说清楚它的消费者：**只有测试读它**（`tests/bot-engine-test.mjs` 验「猜了 3 次
   *    就记 3 条」）。页面**不读** —— `/bot` 页的「已猜过」灰显用的是它自己的
   *    `guessedIds`（页面里那个 `Set`），与本字段无关。
   *    （早先这里写着「只用于 UI 去重展示」，但 UI 从来没接过线 —— 正是本文件
   *     `botCandidateCount` 被删的同一种毛病。留着这句话会让人以为有人在读。）
   */
  readonly guessed: readonly string[];
}

/** 一个词条组合下，一行反馈的「指纹」 */
function signature(c: GuessComparisons, attrs: readonly AttrKey[]): string {
  // ⚠️ 用**完整状态串**，不能用 `status[0]`：'correct'[0] 与 'close'[0] 都是 'c'，
  //    取首字母会把「差 1」当成「完全相同」，等于白送人机一条信息（实测低估约 10pt）。
  //    分隔符 '|' 是必要的 —— 两个状态直接拼接会产生歧义。
  let s = '';
  for (const a of attrs) s += c[a] + '|';
  return s;
}

export function createBrain(tier: BotTier, roster: Character[]): BotBrain {
  return { tier, attrs: TIER_ATTRS[tier], roster, candidates: roster, guessed: [] };
}

/**
 * 每档一张的**两两签名缓存**。
 *
 * ## 为什么必须有它（不是提前优化）
 *
 * `botPick` 每一步要对候选集里**每个**候选算一次「它能把池子切成什么样」，那是 |池|²
 * 次 `compareGuess`。而低档的词条只有三种状态、最多切出 12 堆，池子收窄得极慢
 * （第一猜之后仍有两百来人）—— 于是低档一局要跑四万次比较，`tests/bot-engine-test.mjs`
 * 穷举 429 个答案 × 6 个种子时会从 1 秒涨到 90 秒。CI 的 review gate 里跑不动。
 *
 * 而 `signature(compareGuess(c, g), attrs)` **只取决于 (c, g) 这一对**，与当前池子、
 * 与哪一局、与真答案都无关 —— 所以算过一次就该记住。缓存后每步只剩查表，
 * `SEEDS=20` 那档也更跑得动。
 *
 * ⚠️ **不能说它「换了个算法」**：缓存里存的就是 `signature(compareGuess(...))` 的
 *    原样字符串，`splitCost` 拿它当分桶键 —— 与不缓存时逐字相同。`tests/bot-engine-test.mjs`
 *    的 `g` 段拿真 `compareGuess` 抽样对照，证明这张表没有说谎。
 *
 * ⚠️ 键里带着 `roster` 引用：同一档换了干员表就得重建，否则表停留在旧对象上
 *    （干员 id 一样但内容不同的话，会静默复用过期签名）。
 */
interface TierCache {
  roster: readonly Character[];
  /** 干员 id → 它在 roster 里的下标（池子是 roster 的子集，靠它换算成扁平下标） */
  idx: Map<string, number>;
  /** 两两签名：`pairs[ci * n + gi]`；没算过的是 undefined（不预先铺满，省内存） */
  pairs: (string | undefined)[];
  /** 全量候选集下的开局排序，惰性算一次（见 openingOrder） */
  order: readonly Character[] | null;
}

const TIER_CACHES = new Map<BotTier, TierCache>();

function tierCache(tier: BotTier, roster: readonly Character[]): TierCache {
  const hit = TIER_CACHES.get(tier);
  if (hit && hit.roster === roster) return hit;
  const idx = new Map<string, number>();
  roster.forEach((c, i) => idx.set(c.id, i));
  const fresh: TierCache = { roster, idx, pairs: [], order: null };
  TIER_CACHES.set(tier, fresh);
  return fresh;
}

/**
 * 一个猜测对当前候选集的**切分代价** —— 按签名把候选分桶后，各桶大小的平方和。
 *
 * 语义：若这就是答案会给出的那一行，则人机收窄后平均还要面对 `Σ nᵢ² / Σ nᵢ` 个候选
 * （就是俗称的「期望剩余候选数」，越小越好）。平方和不必除以总数 —— 同一次比较里
 * 总数是常量，排序不受影响。
 *
 * ⚠️ `compareGuess(c, g)` 的参数顺序与 `botLearn` 里那句**必须一致**（候选当答案、猜测
 *    当猜测）。`compareFaction` 是**不对称**的，顺序反了会得到另一个分桶 —— 表现是
 *    人机「变笨」但不会报错，只有定标测试会红。
 */
function splitCost(cache: TierCache, tier: BotTier, pool: readonly Character[], g: Character): number {
  const n = cache.roster.length;
  const gi = cache.idx.get(g.id);
  // 不在表里的干员（池子不是 roster 子集）—— 理论不发生；返回 Infinity 让它永远排最后，
  // 而不是抛异常把整局打断。
  if (gi === undefined) return Infinity;

  const hist = new Map<string, number>();
  for (const c of pool) {
    const ci = cache.idx.get(c.id);
    if (ci === undefined) continue;
    const slot = ci * n + gi;
    let s = cache.pairs[slot];
    if (s === undefined) {
      s = signature(compareGuess(c, g), TIER_ATTRS[tier]);
      cache.pairs[slot] = s;
    }
    hist.set(s, (hist.get(s) ?? 0) + 1);
  }
  let cost = 0;
  for (const k of hist.values()) cost += k * k;
  return cost;
}

/** 把池子里的候选按「切分代价」升序排好（榜首 = 切得最开的那个）。 */
function rankBySplit(cache: TierCache, tier: BotTier, pool: readonly Character[]): Character[] {
  return pool
    .map(g => ({ g, cost: splitCost(cache, tier, pool, g) }))
    .sort((a, b) => a.cost - b.cost)
    .map(r => r.g);
}

/**
 * 全量候选集下的**开局排序**（每档只算一次，之后 O(1)）。
 *
 * 第一猜的候选集恒为全量（429 人），而「猜 g 会把 429 人切成什么样」**只取决于 g**、
 * 与真答案无关 —— 所以这个排序每档算一次就够，每局重算等于每局白烧 429² ≈ 18 万次比较。
 * 而那正是 `BOT_FIRST_DELAY_MS` 想要它**快**的那一猜。
 */
function openingOrder(cache: TierCache, tier: BotTier): readonly Character[] {
  if (!cache.order) cache.order = rankBySplit(cache, tier, cache.roster);
  return cache.order;
}

/**
 * 挑一个要猜的人。候选集为空时返回 null（**理论上不会发生**，见 BotBrain.candidates 的不变量；
 * 留着是防御，不是正常路径）。
 *
 * ## 选点策略：信息增益，前 2 名里随机取一个
 *
 * 旧版是**在候选集里均匀随机取一个**，于是「候选集已经准到只剩 3 个人，却还在里面瞎撞」
 * —— 用户报的「会出现不使用已有信息的情况」就是它。现在对每个候选算出它能把当前
 * 候选集切成什么样，挑切得最开的那个（见 `splitCost`）。
 *
 * 前 2 名里随机取一个（而不是永远取第 1 名）是为了**开局多样性**：只取第 1 名时每局
 * 第一猜永远是同一个人，几局就看腻了。实测代价只有 0.02 次（2.953 → 2.976），
 * 换来 2 种起手而不是 1 种。
 *
 * ⚠️ 这里**故意不做「排除已猜过的」**：候选集的筛选口径就是「按签名收窄」，
 *    没有额外的已猜集合。被猜过的人只有在「与答案在该档词条上完全一致」时才会留在
 *    候选集里 —— 那种情况下人机确实分不清，再猜一次正是真人的表现。
 *    加了排除会让人机**比定标时更强**，那份定标就不再成立。
 *    （实测也确实如此：高档 100% 命中 / 2.98 次，已无排除的必要。）
 *
 * 🔴 `brain.guessed.length === 0` 就是「这是本局第一猜」—— 用它判开局，而不是比
 *    `candidates.length === 全量`：后者需要把 roster 传进来，而这个函数**只能吃 brain**
 *    （哨兵第 4 条钉死了形参个数，那正是「不许顺手把答案传进来」的那道门）。
 */
export function botPick(brain: BotBrain, rng: () => number = Math.random): Character | null {
  const pool = brain.candidates;
  if (pool.length === 0) return null;
  if (pool.length === 1) return pool[0];

  // ⚠️ 用 `brain.roster`（建脑时那张表）而不是 `pool` 去找缓存 —— pool 每一步都是新数组，
  //    拿它当键会让两两签名缓存每步重建一次，等于白缓存。
  const cache = tierCache(brain.tier, brain.roster);
  const ranked = brain.guessed.length === 0
    ? openingOrder(cache, brain.tier)
    : rankBySplit(cache, brain.tier, pool);

  return (rng() < 0.5 ? ranked[0] : (ranked[1] ?? ranked[0]));
}

/**
 * 用一条反馈收窄候选集。**返回新对象**（纯函数）—— 便于测试，也便于 store 直接放进 state。
 *
 * `feedback` 是**本局游戏引擎产出的那一行**，不是人机自己算的：人机拿到的信息
 * 与玩家在自己棋盘上看到的完全一致。
 */
export function botLearn(
  brain: BotBrain,
  guess: Character,
  feedback: GuessComparisons,
): BotBrain {
  const want = signature(feedback, brain.attrs);
  // 把 guess 当作「目标」去比每个候选：留下来的是「若我是答案，也会给出同样反馈」的人
  const candidates = brain.candidates.filter(
    c => signature(compareGuess(c, guess), brain.attrs) === want,
  );
  return {
    ...brain,
    candidates,
    guessed: [...brain.guessed, guess.id],
  };
}

/**
 * 抽一个人机 ID：从干员表里随机取一个名字，**整场固定**（用户需求③）。
 *
 * ⚠️ **防撞谜底不在这里做，而在抽谜底那一侧**。人机的名字整场只抽一次，而谜底每小局
 *    换一个 —— 所以「抽人机时排除谜底」这个方向是错的：它只挡得住抽签那一刻的那一局，
 *    人机的名字照样会撞上后面某一局的谜底，而那时玩家一眼就能看穿（对面板上写着答案）。
 *    正确方向是**每小局抽谜底时把人机的名字从池子里剔掉**
 *    （见 `/bot` 页 `newRound` 里的 `pickTarget(roster, …, [...])`，它把
 *      `m.botIdentity` 与 `m.pastTargets` 一起展开进排除集）。
 */
export function pickBotIdentity(roster: Character[], rng: () => number = Math.random): Character {
  return roster[Math.floor(rng() * roster.length)];
}

/** 本次猜测要等多久（含抖动）。下限钳到 1ms —— 抖动是 ±，不钳会出现负延迟 */
export function botDelayMs(tier: BotTier, rng: () => number = Math.random): number {
  const base = TIER_DELAY_MS[tier];
  const jitter = TIER_JITTER_MS[tier];
  return Math.max(1, Math.round(base + (rng() * 2 - 1) * jitter));
}

// （原有的 `botCandidateCount` / `resolveGuessByName` 两个导出已删 —— 全库零引用。
//   前者曾写着「供 UI 展示」，但页面从来没接过线；后者号称「让 UI 只 import 一处」，
//   而页面本来就是直接从 game-engine 取 findCharacterByName 的。
//   留着它们的代价是：注释描述了一个不存在的用法，下一个读代码的人会被误导。
//   将来真要显示「它已收窄到 N 人」，再加回来是三行的事。）
