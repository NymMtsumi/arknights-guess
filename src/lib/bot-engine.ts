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
 * 定标方法：对**全部 432 个可能答案**穷举，走真实调用路径
 * （`createBrain → botPick → compareGuess → botLearn`），多种子取均值。
 * **可复现的那一份住在 `tests/bot-engine-test.mjs`** —— 下面是它跑的实测值。
 *
 * 🔴 2026-10-17 起，难度是**两把旋钮**，不再是单一「注意到几列」：
 *   ① `TIER_ATTRS`（注意到几列）—— 准确率的**天花板**，离散、只能跳级；
 *   ② `BOT_TIER_MAX_GUESSES`（本局出手几次）—— 在格子之间**连续**填缝。
 *   起因：用户要求三档覆盖 50 / 75 / 95，而列数离散，5 列的地板就已经 83%，
 *   50 与 75 根本不在任何一档的取值范围内（实测见 `BOT_TIER_MAX_GUESSES` 的注释表）。
 *
 * | 档 | 注意到的列 | 本局出手 | 单局命中率 | 平均猜中次数 |
 * |---|---|---|---|---|
 * | 低 | race + faction + gender（3 列） | 7 | 59.4% | 5.80 |
 * | 中 | + class（4 列，**不含 subclass**） | 8 | 90.1% | 5.23 |
 * | 高 | + subclass + releaseYear（6 列） | 8 | 100.0% | 3.86 |
 * | **噩梦** | **全部 9 列（含隐藏的 rarity）** | 8 | **100.0%** | **2.65** |
 *
 * ⚠️ 中档从 5 列砍到 4 列是**故意的**：5 列 + 8 次 = 96.5%，命中率太高，
 *    配 4.0s 步时打出来的是「above hard」而不是中档。
 *    嵌套关系 easy ⊂ medium ⊂ hard ⊂ nightmare 仍然成立
 *    （噩梦是超集 + 最优策略，所以「更强」是结构性的，不靠调参）。
 *
 * ⚠️ 「平均猜中次数」的口径**含没猜中的那些局**（它们按**本档的出手次数**计）—— 所以低档的
 *    5.80 不是「猜中时平均要 5.8 次」，而是「把所有局摊平」。这与排行榜上
 *    那个（`总猜测数 / 总场次`，见 `leaderboard/page.tsx`）**是同一个口径**，
 *    也正是需求①要拿来比较的数。
 *    ⚠️ 因此**跨档的 meanIdx 不能直接比**：easy 没猜中按 7 次计、其余按 8 次计。
 *    噩梦与 hard 同为 100% 命中、同按 8 次计，所以 **2.65 vs 3.86 是可比的** ——
 *    这正是「噩梦比困难强」的量化证据。
 *
 * 🔴 **高档的目标是「平均约 3.8 次」**，2026-10-07 由用户拍板下修 —— 上一版**超调**了：
 *    它注意到全部 8 列、实测 2.98 次，比原定目标还强出一大截，人机其实是碾压级的。
 *
 *    ⚠️ 落地值是 **3.86** 而不是 3.80：**列数是离散旋钮，做不到连续逼近**。
 *       **别想用「选点随机化」补这 0.06**：那条路的天花板就是「在候选集里均匀随机」，
 *       而且它正是用户最初报的那个「明明掌握了信息却不用」的毛病。
 *       下修难度只有两条正路：**减少人机注意到的列**，或**少给它几次出手**。
 *
 *    外部对照（这个数字的意义所在）：2026-10-07 生产环境困难榜第 1 名
 *    （1325 局 / 1319 胜 / 5602 次总猜测）= 4.228 次 —— 3.86 仍比他快 0.37，
 *    即**困难人机依然强于最强的人类玩家，只是不再碾压**。
 *    该榜打的是困难模式，而困难模式本来就隐藏星级列 —— 所以人机删掉星级后
 *    （见 `TIER_ATTRS`）两边是**在同一可见信息下**比较的，基准干净。
 *    `tests/bot-engine-test.mjs` 的 `b5` 把这条需求本身钉成了断言。
 *
 * ⚠️ **准确率与答案池强相关**：同一个高档人机，池子越小越准。所以本模式
 *    **把答案池固定为全量 432**（见 `BOT_POOL_DIFFICULTY`），否则「人机难度」
 *    会跟着玩家的池子选择漂。
 *
 * ⚠️ 「低档三条词条只切成十几堆」是结构性的：种族与性别各只有两三种取值，
 *    **一次猜测最多只能切成 12 堆**，所以收窄得极慢；中档补上职业后切分空间陡增。
 *    这不是「凑数字」，是这两组词条的信息量本身差着一个数量级。
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
 *
 * ## 🔴 2026-10-18：新增第 4 档「噩梦人机」`nightmare`
 *
 * 用户要求「在困难之上添加、不覆盖」，且明确**不考虑玩家体验**：
 *   · 用**全部 9 条词条**（含棋盘上隐藏的星级 —— 这正是「不考虑体验」的那一条，
 *     它看得见玩家看不见的信号）；
 *   · **完全最优策略**：永远取信息增益最大的那个（不做 hard 那种「前 2 名随机」），
 *     终局候选 ≤3 时直接点名；
 *   · 步时 **5.0s、零抖动**（确定性）；**首猜不由计时器触发**，而是「玩家落下第一猜后立刻落子」；
 *   · 8 次出手（与玩家同额 —— 测试钉住「人机不许比玩家猜得多」）。
 *
 * ⚠️ 为什么 `BotTier` 是 `Difficulty | 'nightmare'` 而不是把 `nightmare` 塞进 `Difficulty`：
 *    `Difficulty` 是**题库难度**的全局类型，被单人/多人/每日/排行榜的池子与文案消费；
 *    往里加一档会逼所有 `switch (difficulty)` 去处理一个它们根本不认识的档位。
 *    这里只在**人机**这一条线上扩展，代价是服务端存 `games.difficulty='nightmare'` 时要
 *    在 bot 分支单独放行（见 `server/routes/game.js` 的难度校验）。
 */
export type BotTier = Difficulty | 'nightmare';

/** 标准房的棋盘列数 —— 人机只在这 9 条里「注意到」几条（不含自建房的画师） */
type AttrKey = Exclude<keyof GuessComparisons, 'artist'>;

/**
 * 每档「注意到」的词条。**改这里就是改难度**，改完必须重跑定标测试
 * （`tests/bot-engine-test.mjs` 会在准确率偏离目标 ±6pt 时直接失败）。
 *
 * 四个集合**严格嵌套**（低 ⊂ 中 ⊂ 高 ⊂ 噩梦）：「高档会的东西是低档的超集」。
 * 这样各档的强弱关系可归因到一个方向（注意到几列），而不是「低档擅长 A、高档擅长 B」
 * 那种互相不可比的口径 —— 后者在调参时无法预测改动的效果。
 *
 * ⚠️ **easy/medium/hard 一律不含 rarity**：人机页的棋盘已把星级列删掉（用户需求②），
 *    这三档内部也不许读它 —— 「玩家看不见的信号，人机也不许用」。
 *    星级是单条最强的信号：实测把它加回现高档（6 列 → 7 列）能从 3.86 掉到 3.35 次。
 *    所以这里删掉它同时也是**难度下修**，不是因为它在棋盘上没地方放。
 *    （标准房的棋盘本来也没有星级列 —— 它是榜上可见、棋盘上不可见的那种信号。）
 *
 * 🔴 **噩梦是唯一的例外，而且是故意的**：用户明确要求它「不考虑玩家体验 + 使用全部词条」，
 *    所以它包含 rarity（玩家看不见）、tags、position。别照着上面那条不变量去"修"它 ——
 *    那条不放宽「玩家看不见的信号」，而噩梦的定位就是「不跟玩家讲公平」。
 */
const TIER_ATTRS: Record<BotTier, readonly AttrKey[]> = {
  easy: ['race', 'faction', 'gender'],
  // 🔴 2026-10-17 起，中档砍掉 subclass（5 列 → 4 列）。
  //   5 列 + 8 次的命中率实测 96.5%：命中率太高，靠出手次数压不到「中档」的档位上
  //   （5 列 6 次 = 80.1%）。4 列是命中率上限 91.2% 的档位，配上 8 次出手后
//   **回合胜率**才落在中档（见 TIER_DELAY_MS 的胜率表）。
  //   嵌套关系仍是**严格**的：easy ⊂ medium ⊂ hard 不变。
  medium: ['race', 'faction', 'gender', 'class'],
  hard: ['class', 'subclass', 'race', 'faction', 'gender', 'releaseYear'],
  // 🔴 噩梦：**全部 9 条**。这里故意包含 `rarity` —— 它不在 /bot 棋盘上
  //    （棋盘删掉了星级列），也就是说噩梦人机看得见玩家看不见的信号。
  //    这正是用户「不考虑玩家体验」那条要求的落地方式。别再照着
  //    「玩家看不见的信号人机也不许用」去"修"它 —— 那条不变量的适用范围是 easy/medium/hard。
  //    也不含 `artist`：标准房棋盘根本没有画师列，猜的东西不在表里没有意义。
  nightmare: ['class', 'subclass', 'faction', 'rarity', 'race', 'gender', 'releaseYear', 'tags', 'position'],
};

/**
 * 每档人机本局**允许出手几次** —— 第二把难度旋钮（2026-10-17 落地）。
 *
 * ## 为什么需要它
 *
 * 只靠「注意到几列」调难度是**跳级**的：8 次预算下 3/4/5/6 列的命中率实测是
 * 69.9 / 91.2 / 97.9 / 100%（穷举全部 432 个答案），相邻两级差 7~21 个点 ——
 * 而需求要的是 50 / 75 / 95，正好落在格子之间，靠列数永远够不到。
 *
 * 「出手次数」把格子之间填成连续：同一副脑子少给几次，命中率就从它的天花板平滑掉下来，
 * 且**失败形态是人类本来就有的那一种**（次数用完），不是「明明看见线索还乱猜」——
 * 后者正是用户报的「降智」观感，不能拿来当难度旋钮（实测：漏看率 0.3 时 easy 命中
 * 54.2%，但它的表现是「看着红格子再点一次」）。
 *
 * ## 实测（1 种子 × 全部 432 个答案，走真实调用路径）
 *
 * | 列数 \ 出手 | 4 次 | 5 次 | 6 次 | 8 次 |
 * |---|---|---|---|---|
 * | 3 列 | 23.8 | 37.0 | 48.6 | 69.9 |
 * | 4 列 | 38.7 | 59.0 | 74.1 | 91.2 |
 * | 5 列 | 47.0 | 65.0 | 80.1 | 97.9 |
 * | 6 列 | 73.8 | 91.7 | 98.1 | 100.0 |
 *
 * ⚠️ 玩家的次数**不跟着变**（仍是 `BOT_MAX_GUESSES` = 8）：这是「人机变弱」，
 *    不是「规则变短」。所以别把这张表的数字当成 `BOT_MAX_GUESSES` 的依据。
 */
export const BOT_TIER_MAX_GUESSES: Record<BotTier, number> = {
  easy: 7,
  medium: 8,
  hard: 8,
  // 噩梦与玩家同额（8 次）。不给更多：多给也提不上去（它 ~3 步就解完），
  // 而「人机不许比玩家猜得多」是一条被测试钉住的口径（bot-engine-test 的 a8）。
  nightmare: 8,
};

/**
 * 每次猜测之间的「思考」延迟（ms）。
 *
 * ⚠️ 历史：这三个值原是按「目标单局耗时 ÷ 平均猜中次数」反推的（低 10000 / 中 8200 /
 *    高 6800，对应 69s / 54s / 39s），也就是**用步速承担难度**。2026-10-17 晚指标改成
 *    回合胜率后，这条路被推翻了 —— 见下方「三档步时压到 4.0 / 4.0 / 3.5s」。
 *
 * 🔴 **硬约束（含 tick 开销）**：
 *      `(base + 抖动上限 + BOT_TICK_MS) × BOT_TIER_MAX_GUESSES[档] ≤ BOT_ROUND_TIME`
 *    人机不是用 setTimeout 精确定时落子的，而是在一个固定周期的 tick 里「到点就猜」
 *    （面板同时还要跑计时器，一个 tick 干两件事，省掉一个会互相打架的定时器）。
 *    于是每次落子都可能晚最多一个 tick —— 这个开销**会按出手次数累加**，必须算进预算。
 *
 *    只要超了单局时长，人机就会在最后一猜之前被计时器掐掉 —— 表现是「偶尔少猜一次」，
 *    而那会静默地把实测准确率拉低几个点，且极难归因。
 *    第一版设的抖动（低档 ±2200）踩过这条线（(10170+2200)×8 = 98.9s > 90s）；
 *    第二版把抖动收到 ±1000 但**没算 tick 开销**，低档最坏 88.8s + 8×100ms = 89.6s，
 *    只剩 400ms 余量 —— 后台标签页被浏览器把定时器节流到 1s 就会翻车。
 *    现在余量很大：easy (4000+700+100)×7 = 33.6s、medium (4000+600+100)×8 = 37.6s、
 *    hard (3500+600+100)×8 = 33.6s。
 *    `tests/bot-engine-test.mjs` 有一条断言钉住这个不等式。
 *
 * ⚠️ 这三个值**只影响耗时，不影响准确率** —— 两个指标是正交的旋钮，
 *    这也是为什么耗时不靠「让低级人机猜得慢一点」去凑。
 *
 * ## 🔴 2026-10-17 晚：三档步时压到 **4.0 / 4.0 / 3.5s**（难度主要由命中率承担）
 *
 * 起因是难度指标改了口径：用户要的是**回合胜率** 50 / 75 / 95，而不是命中率。
 * 回合胜率是「墙钟赛跑」——人机第 j 步落子的时刻 vs 玩家第 k 步猜中的时刻，
 * 所以**步速直接进公式**，而命中率不进（命中率只是上限）。
 *
 * 实测（`_verify/botlab/pace-frontier.mjs` + 生产库 single/hard 的猜中步数分布，
 * 参考玩家 P=6 秒/步；432 个答案穷举 + 30 万局蒙特卡洛交叉验证）：
 *
 * | 三档步时 | easy | medium | hard |
 * |---|---|---|---|
 * | 旧 10 / 8.2 / 6.8 s | 17.0% | ~37% | 75.4% |
 * | 5.0 s 统一 | 42.8% | 66.0% | 88.6% |
 * | 4.0 s 统一 | 49.2% | 75.5% | 93.2% |
 * | **4.0 / 4.0 / 3.5 s（现值）** | **49.2%** | **75.5%** | **95.4%** |
 * | 3.5 s 统一 | 52.7% | 80.0% | 95.4% |
 *
 * 用户先在体验红线上定 4.0s（再快人机就"像机器"），hard 单独 3.5s 是**补 95% 的最低代价**：
 * 4.0s 时 hard 只有 93.2%，3.5s 才到 95.4%；再快没有收益、只会更伤体验。
 * 三档差的**主体**仍是命中率（3/4/6 列 × 7/8/8 次），步时只承担这 0.5s 的微调。
 *
 * ⚠️ 别再为了「区分三档」把步时改回 10/8.2/6.8 那种递增：那会让 easy 的回合胜率掉到 17%（实测）。
 * ⚠️ 也别把 hard 压到 3.5s 以下 —— `tests/bot-engine-test.mjs` 的 c4 钉了体验底线。
 */
const TIER_DELAY_MS: Record<BotTier, number> = {
  easy: 4_000,
  medium: 4_000,
  // 🔴 2026-10-17 晚（第二轮）：hard 单独压到 3.5s。
  //    原因：4.0s 统一时 hard 只到 93.2%，用户要求「全部修复」把 95% 也补上（P=6 参考玩家）。
  //    实测（`_verify/botlab/out/pace-sweep.csv`，6 列@8 次、P=6）：
  //      delay 4000ms → 93.2% / 3750ms → 94.6% / **3500ms → 95.4%** / 3000ms → 97.6%
  //    3.5s 是「刚好够 95%」的最慢值；再快没有必要（且更伤体验）。
  //    ⚠️ 这三档不再是同一个数：easy/medium 4.0s、hard 3.5s。
  //    `tests/bot-engine-test.mjs` 的 c4 已改成「easy=medium，且 hard 不比它们慢、
  //    也不低于 3.5s 的体验底线」——这条边界别放宽。
  hard: 3_500,
  // 🔴 噩梦：用户指定 **步时 5.0s**，且「不做玩家体验让步」——所以零抖动、精确 5s。
  //    ⚠️ 首猜**不走这个值**：噩梦的首猜由「玩家落下第一猜」触发（见 BOT_FIRST_MOVE_ON_PLAYER_GUESS）。
  nightmare: 5_000,
};

/**
 * ⚠️ 2026-10-17 起 `TIER_JITTER_MS` 的 medium/hard 已从 1200 收到 600。
 * 上面那条硬约束的余量随之变大（不再是 3.6s / 14.0s / 25.2s 的旧值），
 * `tests/bot-engine-test.mjs` 的 c 段按新值重新断言。
 */

/**
 * 延迟抖动幅度（±，ms）。**没有它，每档的节奏会像节拍器** ——
 * 每 4 秒准点落子，一眼就能看出对面是程序。抖动必须是**有界且非负**的：
 * 下限不能小于 0，否则一次大抖动会让延迟变成负数（`botDelayMs` 另有一层钳制兜底）。
 *
 * 上限受上面那条硬约束压制，见 TIER_DELAY_MS 的注释。
 */
const TIER_JITTER_MS: Record<BotTier, number> = {
  easy: 700,
  // 2026-10-17：medium/hard 原为 1200，占 base 的 29% / 35%，相邻间隔比最高 1.45。
  // 用户报「步时改变」，实测就是这个摆幅。收到 600 后分别为 7.3% / 8.8%，
  // 仍保留「不规律」的观感，但不再让人误以为节奏在漂。改这里不影响准确率（只影响耗时）。
  medium: 600,
  hard: 600,
  // 噩梦零抖动：用户要求「步时 5s」且明确不考虑体验 —— 精确 5s 比「像人」更重要。
  nightmare: 0,
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
 * ⚠️ 它**不参与** `(base + 抖动 + tick) × BOT_TIER_MAX_GUESSES[档] ≤ BOT_ROUND_TIME` 那条硬约束 ——
 *    那个不等式算的是「8 次都按最慢节奏落子」的最坏情况，而第一猜只会**更早**落子，
 *    所以这条改动只会让余量变大。`tests/bot-engine-test.mjs` 的 c 段按**本档次数**最慢算。
 */
export const BOT_FIRST_DELAY_MS: Record<BotTier, number> = {
  easy: 1_500,
  medium: 1_500,
  hard: 1_500,
  // 噩梦**不用这个值**：它的首猜由「玩家落下第一猜」触发（见 BOT_FIRST_MOVE_ON_PLAYER_GUESS）。
  // 这里填 0 是为了让类型表完整；页面在 trigger==='player-first-guess' 时不会读它。
  nightmare: 0,
};

/**
 * 哪些档位的**首猜不用计时器**，而是「玩家落下本局第一猜后立刻落子」。
 *
 * 用户对噩梦的要求原话：「第一步执行的时间在玩家输入完第一条后立刻执行，之后遵循步时」。
 * 所以噩梦是 true：玩家不猜，它就一直不动（这也天然防了「玩家挂机、人机自己打完」）。
 * 其余三档仍是 1.5s 计时（需求③：首猜像真人一样随手落子）。
 *
 * ⚠️ 页面必须同时改 tick 与 botMove 两条路径才能真生效：tick 不能用 `nextBotAt` 卡住它，
 *    botMove 之后要把 `nextBotAt` 从 Infinity 接回「now + 步时」（见 page.tsx 的注释）。
 */
export const BOT_FIRST_MOVE_ON_PLAYER_GUESS: Record<BotTier, boolean> = {
  easy: false,
  medium: false,
  hard: false,
  nightmare: true,
};

/**
 * 选点策略。
 *   · `'random2'`：信息增益前 2 名里随机取一个（三档现役策略，为了开局多样性）；
 *   · `'optimal'` ：**永远取增益最大的那一个**、终局候选 ≤3 时直接点名 ——
 *                   这是用户对噩梦要求的「完全遵循最优策略」，不做任何随机让步。
 *
 * ⚠️ 这里只影响**选点**，不影响准确率上限（候选集筛选口径三档/四档完全相同）。
 */
export const BOT_TIER_POLICY: Record<BotTier, 'random2' | 'optimal'> = {
  easy: 'random2',
  medium: 'random2',
  hard: 'random2',
  nightmare: 'optimal',
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
 * 四档的完整配置（只读导出）。
 *
 * 存在意义是让**测试**能断言上面那条硬约束，而不必把 10000/700 这些魔法数字
 * 抄进测试文件 —— 抄一份就会漂一份，而漂了之后测试仍然"通过"，只是不再检查任何东西。
 */
export const BOT_TIERS: Record<
  BotTier,
  { attrs: readonly AttrKey[]; delayMs: number; jitterMs: number; policy: 'random2' | 'optimal'; firstMoveOnPlayerGuess: boolean }
> = Object.freeze({
  easy: {
    attrs: TIER_ATTRS.easy, delayMs: TIER_DELAY_MS.easy, jitterMs: TIER_JITTER_MS.easy,
    policy: BOT_TIER_POLICY.easy, firstMoveOnPlayerGuess: BOT_FIRST_MOVE_ON_PLAYER_GUESS.easy,
  },
  medium: {
    attrs: TIER_ATTRS.medium, delayMs: TIER_DELAY_MS.medium, jitterMs: TIER_JITTER_MS.medium,
    policy: BOT_TIER_POLICY.medium, firstMoveOnPlayerGuess: BOT_FIRST_MOVE_ON_PLAYER_GUESS.medium,
  },
  hard: {
    attrs: TIER_ATTRS.hard, delayMs: TIER_DELAY_MS.hard, jitterMs: TIER_JITTER_MS.hard,
    policy: BOT_TIER_POLICY.hard, firstMoveOnPlayerGuess: BOT_FIRST_MOVE_ON_PLAYER_GUESS.hard,
  },
  nightmare: {
    attrs: TIER_ATTRS.nightmare, delayMs: TIER_DELAY_MS.nightmare, jitterMs: TIER_JITTER_MS.nightmare,
    policy: BOT_TIER_POLICY.nightmare, firstMoveOnPlayerGuess: BOT_FIRST_MOVE_ON_PLAYER_GUESS.nightmare,
  },
});

/** 猜测次数上限。**锁定，不可由玩家配置** —— 它是上面那套定标的锚点（见文件头） */
export const BOT_MAX_GUESSES = 8;

/**
 * 单局时长（ms）。取多人房 `ROUND_TIME_PRESETS` 里的一档（90 秒）——
 * **不是**多人的默认时长（`server/constants.js` 的 `ROUND_TIME` 是 120 秒）。
 * 四档的最坏用时都得装得下（硬约束见文件头；噩梦最坏 40.8s，余量最大）。
 */
export const BOT_ROUND_TIME = 90_000;

/**
 * 答案池固定为「全量」。
 *
 * 用字面量而不是复用 `getPoolByDifficulty`：后者的 medium 与 hard **返回同一个池子**，
 * 而这里要的是一个**与轮次难度无关的常量**。写死能把「有人日后改了那个函数」这件事
 * 与我们的定标解耦 —— 这份定标是拿 432 人测出来的，池子一变它就作废。
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
 * 穷举 432 个答案 × 6 个种子时会从 1 秒涨到 90 秒。CI 的 review gate 里跑不动。
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
 * 第一猜的候选集恒为全量（432 人），而「猜 g 会把 432 人切成什么样」**只取决于 g**、
 * 与真答案无关 —— 所以这个排序每档算一次就够，每局重算等于每局白烧 432² ≈ 18.7 万次比较。
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
 * ⚠️ **现在排除已猜过的**（2026-10-17 改）：原先这里写着「故意不做排除」，理由是
 *    「被猜过的人只有在与答案完全一致时才留在候选集里」。那只对高档成立 ——
 *    低档只有三列，签名很粗，同一个人会**反复留在候选集里**：实测 easy 有 **24.7%** 的局
 *    出现过重复猜测（864 局里 213 局，重复总次 611）。玩家棋盘上那一行早就红了，
 *    人机又点一次 —— 这就是「降智」最直观的那一幕。
 *
 *    排除的代价是「人机比定标时更强」：easy 55.3 → 69.9。所以**不能只改这一处**，
 *    必须同时用 `BOT_TIER_MAX_GUESSES` 把难度拉回目标（见那张标定表）。
 *
 * 终局另加一步：候选只剩 ≤3 人时**直接点名**，不再算信息增益。
 *    那时「从候选里点一个」的命中概率是 1/3、1/2 甚至 1，继续探路等于白花一步。
 *
 * 🔴 `brain.guessed.length === 0` 就是「这是本局第一猜」—— 用它判开局，而不是比
 *    `candidates.length === 全量`：后者需要把 roster 传进来，而这个函数**只能吃 brain**
 *    （哨兵第 4 条钉死了形参个数，那正是「不许顺手把答案传进来」的那道门）。
 */
/**
 * 预热某档的**开局排序**（`openingOrder`，每档一次 432x432 全量排序，实测约 0.25s）。
 *
 * 存在的唯一目的：把这笔一次性开销从**首局首猜的那一拍**挪到**菜单期**。
 * 不预热时，玩家看到的是「开局后 1.5s 卡一下」（低端机可到 1.2s，还伴随一次 GC）。
 *
 * ⚠️ 它**不产生任何语义副作用** —— 只是把惰性缓存 `cache.order` 提前填上，
 *    与「真实对局里第一次 botPick 触发它」逐字等价（同一张表、同一个函数）。
 *    也正因如此，它**不该**被做成 `botPick` 的一个参数或变体：
 *    那两扇门由 `scripts/check-bot-isolation.mjs` 第 4、5 条钉死（botPick 只收 brain）。
 */
export function warmUp(tier: BotTier, roster: Character[]): void {
  openingOrder(tierCache(tier, roster), tier);
}

export function botPick(brain: BotBrain, rng: () => number = Math.random): Character | null {
  const pool = brain.candidates;
  if (pool.length === 0) return null;
  if (pool.length === 1) return pool[0];

  // 本局已猜过的不再出手 —— 理由见上方注释（easy 有 24.7% 的局会重复）
  const seen = new Set(brain.guessed);
  const fresh = pool.filter(c => !seen.has(c.id));
  const usable = fresh.length > 0 ? fresh : pool;

  // 终局点名：候选够小就别再算增益了
  if (usable.length <= 3) return usable[Math.floor(rng() * usable.length)];

  // ⚠️ 用 `brain.roster`（建脑时那张表）而不是 `pool` 去找缓存 —— pool 每一步都是新数组，
  //    拿它当键会让两两签名缓存每步重建一次，等于白缓存。
  const cache = tierCache(brain.tier, brain.roster);
  const ranked = brain.guessed.length === 0
    ? openingOrder(cache, brain.tier)
    : rankBySplit(cache, brain.tier, usable);

  // 噩梦：完全最优 —— 永远取增益最大的那个，不做「前 2 名随机」。
  // （用户原话「完全遵循最优策略」；随机化是给人类档位制造开局多样性的，这里不要。）
  if (BOT_TIER_POLICY[brain.tier] === 'optimal') return ranked[0];

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
