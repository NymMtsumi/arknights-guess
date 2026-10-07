#!/usr/bin/env node
// 人机对手「引擎 + 定标」— 纯逻辑确定性验证。
//
// 不需要浏览器、不需要 build：用 tests/_ts-load.mjs 把 .ts 直接加载进 node。
//
// 🔴 本文件存在的理由有两条：
//    ① 证明「低 < 中 < 高」这条难度梯度真的落地了，且**高档真的落在 3.8 次附近**
//       （用户 2026-10-07 下修的目标，见 b5）—— 它不是「跑一遍看看」，是拿**全部 429 个可能答案**
//       穷举、多种子取均值，跑的是**真实调用路径**（createBrain → botPick → compareGuess
//       → botLearn），不是另写一份仿真；
//    ② 证明引擎里那张**两两签名缓存**没有说谎（见 g 段）—— 缓存把低档的耗时从 92s
//       压到 8s，代价是多了一份「可能与现场重算不一致」的状态，所以拿真 compareGuess
//       当场重算一遍逐名对照。
//    任何对 TIER_ATTRS / 选点策略 / 候选集筛选的改动都会在这里现形。
//
// ⚠️ 这里用**客户端**引擎（src/lib/game-engine.ts）而不是服务端的：
//    方案 A 是纯客户端玩法，人机吃到的反馈行由客户端引擎产出（`/bot` 走 `makeGuess`）。
//    定标必须量**跑在页面上的那一个**引擎，否则量的是另一套判定。
//    两者确有一处真漂移：`compareTags` 在「双方词条都为空」时客户端判 wrong、服务端判
//    correct —— 但三档组合里没有 tags，够不到它。`compareYear` 两边写法不同
//    （客户端 `=== 1`、服务端 `<= 1`），不过那是在**已判过相等之后**才走到的一步，
//    二者等价，不是漂移 —— 高档本轮起包含 releaseYear，特意重新核实过这一点。
//
// 运行：node tests/bot-engine-test.mjs
//       SEEDS=20 node tests/bot-engine-test.mjs   # 更紧的置信区间

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { check, finish, ROOT } from './helpers.mjs';
import { loadTsModule } from './_ts-load.mjs';

/** 每种子的重复次数。429 个目标 × SEEDS 个种子 = 样本量；SEEDS=6 时标准误约 1.0pt */
const SEEDS = Number(process.env.SEEDS || 6);

/**
 * 定标目标 —— **本文件自己跑出来的实测值**（6 种子与 20 种子两次跑出来的数只差 0.01）。
 *
 * ⚠️ `meanIdx` 的口径**含没猜中的局**（按用满 8 次计），与 `/api/leaderboard` 的
 *    `总猜测数 / 总场次` 同口径 —— 这正是需求①要拿来比较的那个数。
 */
const TARGETS = {
  easy: { hit: 54.9, meanIdx: 6.52 },
  medium: { hit: 96.6, meanIdx: 4.91 },
  hard: { hit: 100.0, meanIdx: 3.87 },
};

/**
 * 🔴 需求本身的锚点：最高档人机的平均猜测次数 **≈ 3.8 次**（用户 2026-10-07 拍板下修）。
 *
 * 为什么不「钉住实测值就够了」：`TARGETS.hard.meanIdx` 只是**我们自己的**测量，
 * 谁把 `TOL_IDX` 放宽（或把 TARGETS 改成任何实测值）都能让它静默通过。
 * 这一条才钉得住需求。
 *
 * ⚠️ 为什么是**双侧带**、不是原来那种「≤ 上限」：上一版的毛病恰恰是**超调** ——
 *    实现注意到全 8 列、实测 2.98，比目标强出一大截，人机是碾压级的。只钉上限
 *    就永远拦不住这类「越改越强」，而「困难人机比最强玩家还快一大截」并不是要的效果。
 *
 * ⚠️ 容差 0.15 掐的是旋钮的**半格**：列数离散，相邻两级差约 0.3
 *    （7 列 3.57 ↔ 6 列 3.87），±0.15 刚好只放进当前这一级 —— 把 `TIER_ATTRS.hard`
 *    改回 7 列（→3.57）或砍到 5 列（→≈4.9）都会立刻红。
 */
const HARD_MEAN_IDX_TARGET = 3.8;
const HARD_MEAN_IDX_TOL = 0.15;

/** 外部对照，只用于说明这份定标的意义，不参与断言 */
const LEADERBOARD_TOP_MEAN_IDX = 4.228;
const LEADERBOARD_TOP_NOTE = '生产困难榜第 1 名 1325 局 / 1319 胜 / 5602 次总猜测 = 4.228 次';

/** 容差：样本标准误约 1.0pt，取 ±6pt ≈ 6σ —— 只拦真错，不拦抖动 */
const TOL_HIT = 6.0;
const TOL_IDX = 0.7;

/**
 * 已加载的 ts-load 临时目录清理器（`node_modules/.cache/ts-load-<pid>`，按 pid 命名、不自清）。
 *
 * ⚠️ 收在模块级是为了**崩溃路径也能清**：本文件底部的 catch 拿不到 main 里的局部变量，
 *    而「跑到一半抛异常」恰恰是最容易反复重跑的场景 —— 只清成功路径等于清了半个。
 */
const tsCleanups = [];

/** 加载一个 .ts 模块并登记它的清理器 */
async function loadTs(rel) {
  const loaded = await loadTsModule(rel);
  tsCleanups.push(loaded.cleanup);
  return loaded.mod;
}

async function cleanupTsLoads() {
  // 多次 load 共用同一个 outDir（同一 pid），重复 rm 是幂等的
  await Promise.all(tsCleanups.map((fn) => fn().catch(() => {})));
}

/** 确定性伪随机（避免 Math.random 让失败不可复现） */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

async function main() {
  const roster = JSON.parse(await readFile(join(ROOT, 'src', 'data', 'characters.json'), 'utf8'));

  const bot = await loadTs('src/lib/bot-engine.ts');
  // ⚠️ compareGuess 要单独加载：bot-engine 只是 import 它、并不 re-export
  //    （照 turtle-store-test 的教训 —— 那边第一版就栽在这）。
  const gameEngine = await loadTs('src/lib/game-engine.ts');

  const { createBrain, botPick, botLearn, botDelayMs, pickBotIdentity, BOT_MAX_GUESSES, BOT_ROUND_TIME, BOT_TICK_MS, BOT_TIERS, BOT_FIRST_DELAY_MS } = bot;
  const { compareGuess } = gameEngine;

  /**
   * 档位清单**从引擎推**，不写字面量。
   *
   * 🔴 写死 `['easy', 'medium', 'hard']` 的后果是**静默漏测**：将来谁给 BOT_TIERS 加了
   *    第四档，b/c 两组循环会若无其事地跳过它 —— 全绿，而新档位一根毛都没验过。
   *    从 BOT_TIERS 推之后新档位立刻被带进循环：`TARGETS[tier]` 是 undefined，
   *    `Math.abs(hit - undefined)` 得 NaN → 断言红，逼人补定标（a5 把它写成显式对照）。
   */
  const TIERS = Object.keys(BOT_TIERS);

  console.log(`干员 ${roster.length}；每档 ${SEEDS} 个种子 × 全部目标；K=${BOT_MAX_GUESSES}；单局 ${BOT_ROUND_TIME / 1000}s\n`);

  // ══════════════ a. 结构不变量：人机拿不到答案 ══════════════
  console.log('[a] 「人机不读答案」的结构保证');

  check('a1.botPick 的形参不超过 2 个（brain + rng），无 target', botPick.length <= 2, `arity=${botPick.length}`);
  check('a2.botLearn 的形参恰为 3 个（brain, guess, feedback）', botLearn.length === 3, `arity=${botLearn.length}`);
  check('a3.createBrain 起点是**全量**候选集（证明它不预先排除答案）',
    createBrain('high', roster).candidates.length === roster.length,
    `${createBrain('high', roster).candidates.length}/${roster.length}`);
  check('a4.各档的候选集起点逐字相同',
    new Set(TIERS.map(t => createBrain(t, roster).candidates.length)).size === 1);
  check('a5.档位清单与定标表的键一致（新增档位必须补定标，否则此处即红）',
    TIERS.slice().sort().join(',') === Object.keys(TARGETS).sort().join(','),
    `引擎 [${TIERS.join(',')}] / 定标 [${Object.keys(TARGETS).join(',')}]`);
  // 引擎那张两两签名缓存靠 `id → 下标` 定位（见 TierCache）。id 重复时后者会覆盖前者，
  // 于是缓存整行读错 —— 表现是「换个池子排序就变了」，而单看数字看不出来。这是缓存的前置条件。
  const idCount = new Set(roster.map(c => c.id)).size;
  check('a6.干员 id 唯一（两两签名缓存按 id 定位，重名会让它读错行）',
    idCount === roster.length, `${idCount}/${roster.length}`);

  // ══════════════ b. 定标：40 / 60 / 80 ══════════════
  console.log('\n[b] 难度梯度定标（全部 429 个答案穷举，走真实调用路径）');

  // 实测值留痕：b4 要断言的是**跑出来的梯度**，不是上面那张写死的定标表。
  const measured = {};

  for (const tier of TIERS) {
    const t0 = Date.now();
    let hitSum = 0, idxSum = 0, samples = 0;

    for (let s = 0; s < SEEDS; s++) {
      const rng = makeRng(1_000_003 * (s + 1));
      for (const target of roster) {
        let brain = createBrain(tier, roster);
        let solved = null;
        for (let n = 1; n <= BOT_MAX_GUESSES; n++) {
          const guess = botPick(brain, rng);
          if (!guess) break;
          if (guess.id === target.id) { solved = n; break; }
          brain = botLearn(brain, guess, compareGuess(target, guess));
        }
        if (solved !== null) hitSum++;
        idxSum += solved ?? BOT_MAX_GUESSES;
        samples++;
      }
    }

    const hit = (hitSum / samples) * 100;
    const meanIdx = idxSum / samples;
    measured[tier] = { hit, meanIdx };
    const want = TARGETS[tier];
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    check(`b.${tier} 准确率 ${hit.toFixed(1)}%（目标 ${want.hit}%，容差 ±${TOL_HIT}pt）`,
      Math.abs(hit - want.hit) <= TOL_HIT, `${SEEDS} 种子 / ${samples} 样本，用时 ${elapsed}s`);
    check(`b.${tier} 平均猜中次数 ${meanIdx.toFixed(2)}（目标 ${want.meanIdx}，容差 ±${TOL_IDX}）`,
      Math.abs(meanIdx - want.meanIdx) <= TOL_IDX);
  }

  // 🔴 b4 断言的是**实测**梯度，不是 `TARGETS` 那张写死的定标表。
  //    早先这行写的是 `TARGETS.easy.hit < TARGETS.medium.hit < TARGETS.hard.hit`，
  //    三个数都是第 30-32 行手写的字面量 —— 量的是常量之间的关系，**永远为真**，
  //    引擎怎么改都不会红。那等于这条「梯度递增」的保证压根不存在。
  //    改成实测值后它是可证伪的：把三档的 TIER_ATTRS 调成同一份（梯度塌掉），
  //    三个实测值打平 → 这就是一条真的红了（已做反事实对照，实测 79.1 / 79.1 / 79.1%）。
  //
  //    ⚠️ 但别把它当成补上了覆盖空白：那个场景里 b.easy / b.medium 的**绝对目标**
  //    （各自 40.2 / 60.9，容差 ±6pt）本来也会红。三档目标相距 20pt、容差只有 6pt，
  //    所以「梯度」这件事其实已被那六条绝对断言覆盖。b4 的价值在于**把意图写成一行**，
  //    将来若有人放宽 TOL_HIT（比如放到 ±25pt），那六条会失去对顺序的约束，
  //    而这一行还在管着。
  check('b4.实测梯度严格递增 低 < 中 < 高',
    measured.easy.hit < measured.medium.hit && measured.medium.hit < measured.hard.hit,
    `实测 ${measured.easy.hit.toFixed(1)} / ${measured.medium.hit.toFixed(1)} / ${measured.hard.hit.toFixed(1)}%`);

  // 🔴 b5 是**需求本身**，不是定标表。上面那几条 b.* 断言的是「实测 ≈ 我们自己写的目标」，
  //    谁把 TARGETS.hard 改成任何实测值、或放宽 TOL_IDX，它们都照样绿。
  //    这一条钉的是用户拍板的那个数，改不动 —— 也正因如此它才是能证伪的。
  check(`b5.最高档平均猜测次数 ${measured.hard.meanIdx.toFixed(2)} ≈ ${HARD_MEAN_IDX_TARGET}`
    + `（容差 ±${HARD_MEAN_IDX_TOL}）`,
  Math.abs(measured.hard.meanIdx - HARD_MEAN_IDX_TARGET) <= HARD_MEAN_IDX_TOL,
  `实测 ${measured.hard.meanIdx.toFixed(2)} 次/局；对照 ${LEADERBOARD_TOP_NOTE}`
    + `，人机仍快 ${(LEADERBOARD_TOP_MEAN_IDX - measured.hard.meanIdx).toFixed(2)} 次`);

  // ══════════════ c. 耗时 ══════════════
  console.log('\n[c] 耗时与单局预算');

  for (const tier of TIERS) {
    const cfg = BOT_TIERS[tier];
    // 硬约束：最坏情况（每次都抖到上限）也必须装得进单局，否则人机会被计时器掐掉一猜。
    // 🔴 每次落子最多晚一个 tick（人机是 tick 驱动、不是 setTimeout 精确定时），
    //    这个开销**累加 8 次**，所以必须并进最坏值 —— 漏掉它就会在林余量里骗自己。
    const worst = (cfg.delayMs + cfg.jitterMs + BOT_TICK_MS) * BOT_MAX_GUESSES;
    // 余量下限 2s：后台标签页被浏览器把定时器节流到 1s 时，靠的就是这点余量。
    // ⚠️ 这里**只留一条**断言。原先还并列着一条 `worst <= BOT_ROUND_TIME`，但
    //    `slack = BOT_ROUND_TIME - worst`，所以 `slack >= 2000` 严格蕴含它 ——
    //    两条并列时后者永远不会单独红，是一条恒真的装饰（放久了会让人以为有两层保护）。
    const slack = BOT_ROUND_TIME - worst;
    check(`c.${tier} 最坏耗时 ${(worst / 1000).toFixed(1)}s ≤ 单局 ${(BOT_ROUND_TIME / 1000)}s，余量不少于 2s（抗后台节流）`,
      slack >= 2_000, `worst=${(worst / 1000).toFixed(1)}s slack=${(slack / 1000).toFixed(1)}s`);
  }

  const rngD = makeRng(42);
  for (const tier of TIERS) {
    const cfg = BOT_TIERS[tier];
    const samples = Array.from({ length: 2000 }, () => botDelayMs(tier, rngD));
    const lo = cfg.delayMs - cfg.jitterMs, hi = cfg.delayMs + cfg.jitterMs;
    check(`c.${tier} 延迟恒为正且落在 [${lo}, ${hi}] 内`,
      samples.every(d => d > 0 && d >= lo && d <= hi),
      `min=${Math.min(...samples)} max=${Math.max(...samples)}`);
    // 抖动必须真的在动 —— 否则「每档节奏像节拍器」这个坑会静默复发
    check(`c.${tier} 抖动生效（2000 次采样出现了多种取值）`, new Set(samples).size > 100);
  }

  check('c4.延迟随难度递减（低级人机最慢）',
    BOT_TIERS.easy.delayMs > BOT_TIERS.medium.delayMs && BOT_TIERS.medium.delayMs > BOT_TIERS.hard.delayMs);

  // 需求③：人机的**第一猜**要像真人一样立刻落子。它不参与上面那条时间预算
  //（第一猜只会更早落子），所以单独钉两条：必须存在、且必须比常规节奏快。
  for (const tier of TIERS) {
    const first = BOT_FIRST_DELAY_MS[tier];
    check(`c5.${tier} 首猜延迟 ${first}ms 是正数且短于常规节奏 ${BOT_TIERS[tier].delayMs}ms`,
      Number.isFinite(first) && first > 0 && first < BOT_TIERS[tier].delayMs);
  }
  check('c6.三档的首猜延迟取同一个值（这条是「像不像真人」，不是难度旋钮）',
    new Set(Object.values(BOT_FIRST_DELAY_MS)).size === 1,
    `[${Object.values(BOT_FIRST_DELAY_MS).join(', ')}]`);

  // ══════════════ d. 人机 ID ══════════════
  console.log('\n[d] 人机 ID 抽取');

  const rngI = makeRng(7);
  const ids = Array.from({ length: 500 }, () => pickBotIdentity(roster, rngI));
  check('d1.抽得到（不返回 undefined）', ids.every(c => c !== undefined && c !== null));
  check('d2.抽取有分布（500 次不总是同一个）', new Set(ids.map(c => c.id)).size > 50);
  check('d3.返回的是干员表里的真对象',
    ids.every(c => roster.some(r => r.id === c.id)));
  // 集齐问题：500 次抽取覆盖 429 项，期望不同项数 = 429×(1−e^(−500/429)) ≈ 295。
  // 断言按理论值放宽到 250 —— 卡在 295 附近会让测试变成对随机数的复读；
  // 低于 250 才说明分布出了问题（比如伪随机退化）。
  const distinct = new Set(ids.map(c => c.id)).size;
  check('d4.抽取覆盖接近集齐问题理论值（429 项抽 500 次 ≈ 295 个不同）', distinct > 250,
    `${distinct}/${roster.length}`);

  // ══════════════ e. 不变量：答案永不被筛掉 ══════════════
  console.log('\n[e] 候选集不变量：真答案永不被筛掉');

  let survived = 0, total = 0;
  for (const tier of TIERS) {
    const rng = makeRng(99);
    for (const target of roster.slice(0, 60)) {
      let brain = createBrain(tier, roster);
      for (let n = 1; n <= BOT_MAX_GUESSES; n++) {
        const guess = botPick(brain, rng);
        if (!guess) break;
        brain = botLearn(brain, guess, compareGuess(target, guess));
        // 每一轮之后，答案都必须还在候选集里 —— 否则说明筛选口径与真引擎不一致
        if (brain.candidates.some(c => c.id === target.id)) survived++;
        total++;
      }
    }
  }
  check(`e1.${total} 次收窄后答案全部仍在候选集内（筛选与真引擎同口径）`,
    survived === total, `${survived}/${total}`);

  // ══════════════ f. 选人策略 ══════════════
  console.log('\n[f] 人机猜过的人');
  const rngG = makeRng(5);
  let brain = createBrain('easy', roster);
  const seen = new Set();
  for (let n = 0; n < 3; n++) {
    const g = botPick(brain, rngG);
    seen.add(g.id);
    brain = botLearn(brain, g, compareGuess(roster[10], g));
  }
  check('f1.guessed 如实记录了每一次猜测', brain.guessed.length === 3, brain.guessed.length);

  // ══════════════ g. 缓存 vs 现场重算 ══════════════
  // 🔴 引擎为了让低档跑得动，把 `signature(compareGuess(c, g))` 按 (c, g) 存进了一张
  //    两两缓存（见 bot-engine.ts 的 TierCache）。缓存一旦索引错位，人机会静默地按
  //    **另一对干员**的签名排序 —— 面板上看不出任何异常，只有定标数字会漂。
  //    所以这里用**真 compareGuess** 把「信息增益选点」当场重算一遍，逐名对照。
  //    这段刻意不复用引擎的任何内部函数（只借 BOT_TIERS 的 attrs 与公开的
  //    createBrain / botPick / botLearn）—— 复用就等于拿缓存验缓存。
  console.log('\n[g] 选点策略：缓存路径 vs 用真 compareGuess 现场重算');

  /** 独立复现「按切分代价升序」——签名口径与引擎的 signature() 逐字相同 */
  function freshRank(pool, attrs) {
    const cost = (g) => {
      const buckets = new Map();
      for (const c of pool) {
        const cmp = compareGuess(c, g);
        let s = '';
        for (const a of attrs) s += cmp[a] + '|';
        buckets.set(s, (buckets.get(s) ?? 0) + 1);
      }
      let sum = 0;
      for (const n of buckets.values()) sum += n * n;
      return sum;
    };
    return pool.map(g => ({ g, cost: cost(g) })).sort((a, b) => a.cost - b.cost).map(r => r.g);
  }

  // 第一猜的池子恒为全量，逐档只重算一次（429² 次 compareGuess），不放进目标循环里。
  const freshOpening = {};
  for (const tier of TIERS) freshOpening[tier] = freshRank(roster, BOT_TIERS[tier].attrs);

  for (const tier of TIERS) {
    const attrs = BOT_TIERS[tier].attrs;
    let same = 0, diff = 0, firstBad = '';
    for (const target of roster.slice(0, 12)) {
      let brain = createBrain(tier, roster);
      for (let n = 1; n <= 3; n++) {
        const want = n === 1 ? freshOpening[tier] : freshRank(brain.candidates, attrs);
        // rng 是确定的：0.1 → 恒取第 1 名，0.9 → 恒取第 2 名（见 botPick 的实现）
        const got1st = botPick(brain, () => 0.1);
        const got2nd = botPick(brain, () => 0.9);
        const want2nd = want[1] ?? want[0];
        if (got1st?.id === want[0].id && got2nd?.id === want2nd.id) same++;
        else {
          diff++;
          if (!firstBad) firstBad = `目标 ${target.name} 第 ${n} 猜：期望 ${want[0].name}／${want2nd.name}，`
            + `实际 ${got1st?.name}／${got2nd?.name}`;
        }
        if (!got1st) break;
        brain = botLearn(brain, got1st, compareGuess(target, got1st));
      }
    }
    check(`g.${tier} 缓存选点与现场重算逐名一致`, diff === 0,
      `${same}/${same + diff} 次比对${firstBad ? '；首个不一致：' + firstBad : ''}`);
  }

  // ⚠️ 必须写在 finish() **之前**：finish 走的是 process.exit，写在它后面（或 finally 里）
  //    都不会执行。
  await cleanupTsLoads();

  finish(0);
}

main().catch(async (e) => {
  console.error('❌ 测试抛异常：', e);
  await cleanupTsLoads();
  process.exit(1);
});
