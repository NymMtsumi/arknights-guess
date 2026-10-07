/**
 * 人机隔离哨兵 —— **自测**（把反事实对照固化成脚本）
 * ====================================================
 * 项目规矩：「探针全绿 ≠ 修复成立，必须做反事实对照」。
 * `scripts/check-bot-isolation.mjs` 是我方唯一一条**靠正则结构**而不是靠运行时行为
 * 来保证「人机读不到答案」的东西 —— 它的正确性本身没有运行时能证伪。
 * 于是把对照固化在这里：**每一条不变量**都配一份「故意写坏 → 哨兵必须红」的用例，
 * 关键几条再配一份「合法重构 → 哨兵必须绿」的假阳性对照。
 *
 * 为什么必须自动化：我（以及下一个人）每次手改 `check-bot-isolation.mjs` 之后，
 * 都得重新验一遍这七条；靠记性迟早漏。这份脚本 **33 个用例、约 3 秒**，
 * 已在 `deploy.yml` 的 review gate 里（紧跟哨兵本体）。
 *
 * 每个用例的 `from` 都要求**在源文件里恰好命中 1 次** —— 命中 0 次说明
 * 「被保护的那行被人改了」，命中多次说明锚点不唯一。两种情况都**直接判失败**，
 * 而不是静默变成「对照组恰好也是绿的」。（这条是这份脚本最重要的一行代码。）
 *
 * 用法：node scripts/check-bot-isolation-selftest.mjs
 * 退出码：0 = 全部符合预期；1 = 有用例不符（或锚点漂移）。
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SENTINEL = join(ROOT, 'scripts/check-bot-isolation.mjs');
const TMP = join(ROOT, '.bot-isolation-selftest');
const ENGINE_REL = 'src/lib/bot-engine.ts';
const PAGE_REL = 'src/app/bot/page.tsx';

const ENGINE_SRC = readFileSync(join(ROOT, ENGINE_REL), 'utf8');
const PAGE_SRC = readFileSync(join(ROOT, PAGE_REL), 'utf8');

/** 把 `from` 转成容忍 CRLF/LF 的正则，并返回命中次数。`\n` → `\r?\n`。 */
function findCount(src, from) {
  const pat = from.split('\n').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\r?\\n');
  return [...src.matchAll(new RegExp(pat, 'g'))].length;
}
function applyMutation(src, from, to) {
  const pat = from.split('\n').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\r?\\n');
  return src.replace(new RegExp(pat), () => to);
}

// ── 用例表 ───────────────────────────────────────────────────────
// want: 'red' = 哨兵必须失败（隔离被破坏却没被抓住 = 漏报）
//       'green' = 哨兵必须通过（合法/无关改动被误判 = 误报）
const CASES = [
  // ── 引擎：第 1 条（零答案标识符，大小写不敏感子串）──
  {
    name: 'E1 targetId 这种驼峰命名必须被抓（第 2 轮审查的 E 条：\\btarget\\b 漏掉它）',
    file: 'engine', want: 'red',
    from: `/** 猜测次数上限。**锁定，不可由玩家配置** —— 它是上面那套定标的锚点（见文件头） */`,
    to: `const targetId = 'x';\n\n/** 猜测次数上限。**锁定，不可由玩家配置** —— 它是上面那套定标的锚点（见文件头） */`,
  },
  {
    name: 'E2 字符串字面量里藏 target 也要报（stripComments 保留字符串内容，宁可误报）',
    file: 'engine', want: 'red',
    from: `export const BOT_POOL_DIFFICULTY = 'hard' as const;`,
    to: `export const BOT_POOL_DIFFICULTY = 'hard' as const;\nconst HIDDEN = 'target';`,
  },
  {
    name: 'E3 注释里出现 target 必须**不**报（注释剥掉后不参与匹配）',
    file: 'engine', want: 'green',
    from: `export const BOT_MAX_GUESSES = 8;`,
    to: `export const BOT_MAX_GUESSES = 8;\n// 这里顺手提一句 target，注释里的词不该触发哨兵`,
  },

  // ── 引擎：第 2 条（import 白名单）──
  {
    name: 'E4 偷 import 一个 store 必须红',
    file: 'engine', want: 'red',
    from: `import { compareGuess } from './game-engine';`,
    to: `import { compareGuess } from './game-engine';\nimport { useGameStore } from '@/stores/game-store';`,
  },
  {
    name: 'E5 摘掉 ./game-engine 的 import 必须红（正向断言）',
    file: 'engine', want: 'red',
    from: `import { compareGuess } from './game-engine';`,
    to: ``,
  },
  {
    name: 'E6 把 type import 改写成多行必须**不**报（M4：按语句取 import，不按行）',
    file: 'engine', want: 'green',
    from: `import type { Character, Difficulty, GuessComparisons } from '@/types/character';`,
    to: `import type {\n  Character,\n  Difficulty,\n  GuessComparisons,\n} from '@/types/character';`,
  },

  // ── 引擎：第 3 条（不碰全局对象）──
  {
    name: 'E7 globalThis 后门必须红（第 2 轮审查的 F 条）',
    file: 'engine', want: 'red',
    from: `export const BOT_MAX_GUESSES = 8;`,
    to: `export const BOT_MAX_GUESSES = 8;\nconst leak = (globalThis as any).__leak;`,
  },
  {
    name: 'E8 process.env 也必须红',
    file: 'engine', want: 'red',
    from: `export const BOT_MAX_GUESSES = 8;`,
    to: `export const BOT_MAX_GUESSES = 8;\nconst e = process.env.X;`,
  },

  // ── 引擎：第 4 条（botPick 形参个数）──
  {
    name: 'E9 给 botPick 追加第 3 个形参（传答案）必须红',
    file: 'engine', want: 'red',
    from: `export function botPick(brain: BotBrain, rng: () => number = Math.random): Character | null {`,
    to: `export function botPick(brain: BotBrain, rng: () => number = Math.random, tgt: Character): Character | null {`,
  },

  // ── 页面：第 5 条（实参白名单）──
  {
    name: 'P1 给 botPick 多传一个实参（答案）必须红',
    file: 'page', want: 'red',
    from: `const guess = botPick(r.brain);`,
    to: `const guess = botPick(r.brain, r.target);`,
  },
  {
    name: 'P2 把答案塞进「猜测」位置必须红（isWin(答案, 猜测) 立刻为真）',
    file: 'page', want: 'red',
    from: `r.brain = botLearn(r.brain, guess, result.comparisons);`,
    to: `r.brain = botLearn(r.brain, r.target, result.comparisons);`,
  },
  {
    name: 'P3 用常量反馈行顶替必须红（文件头 A 条）',
    file: 'page', want: 'red',
    from: `r.brain = botLearn(r.brain, guess, result.comparisons);`,
    to: `r.brain = botLearn(r.brain, guess, FEEDBACK_ALL_CORRECT);`,
  },
  {
    name: 'P4 用「答案自己比自己」产生的反馈行必须红（M1：形状是 *.comparisons、内容是伪装）',
    file: 'page', want: 'red',
    from: `const result = makeGuess(r.target, guess);   // 谜底在这里，但只用来产出**反馈行**`,
    to: `const result = makeGuess(r.target, r.target);   // 谜底在这里，但只用来产出**反馈行**`,
  },
  {
    name: 'P5 给猜测变量加类型标注必须**不**报（M3：允许 `: T` 再 `=`）',
    file: 'page', want: 'green',
    from: `const guess = botPick(r.brain);`,
    to: `const guess: Character | null = botPick(r.brain);`,
  },
  {
    name: 'P6 把 brain 提成局部变量再传必须**不**报（M2：解一层变量引用）',
    file: 'page', want: 'green',
    from: `const guess = botPick(r.brain);`,
    to: `const __b = r.brain;\n    const guess = botPick(__b);\n    void __b;`,
    also: [{ from: `botLearn(r.brain, guess, result.comparisons)`, to: `botLearn(__b, guess, result.comparisons)` }],
  },

  // ── 页面：第 6 条（不碰候选集 / createBrain 吃整份 roster）──
  {
    name: 'P7 页面直接改候选集必须红（第 2 轮审查的 G 条）',
    file: 'page', want: 'red',
    from: `const guess = botPick(r.brain);`,
    to: `const guess = botPick(r.brain);\n    r.brain.candidates = [r.target];`,
  },
  {
    name: 'P8 用只含答案的数组建脑必须红',
    file: 'page', want: 'red',
    from: `brain: createBrain(m.tier, roster),`,
    to: `brain: createBrain(m.tier, [r.target]),`,
  },

  // ── 页面：第 7 条（排除集必须展开）──
  {
    name: 'P9 排除集换成 slice(0,0)（一个都不排除）必须红（文件头 C 条）',
    file: 'page', want: 'red',
    from: `    const drawn = pickTarget(roster, BOT_POOL_DIFFICULTY, [\n      ...(m.botIdentity ? [m.botIdentity.id] : []),\n      ...m.pastTargets,\n    ]);`,
    to: `    const drawn = pickTarget(roster, BOT_POOL_DIFFICULTY, m.pastTargets.slice(0, 0));`,
  },
  {
    name: 'P10 只把排除集提成变量（合法重构）必须**不**报',
    file: 'page', want: 'green',
    from: `    const drawn = pickTarget(roster, BOT_POOL_DIFFICULTY, [\n      ...(m.botIdentity ? [m.botIdentity.id] : []),\n      ...m.pastTargets,\n    ]);`,
    to: `    const __ex = [\n      ...(m.botIdentity ? [m.botIdentity.id] : []),\n      ...m.pastTargets,\n    ];\n    const drawn = pickTarget(roster, BOT_POOL_DIFFICULTY, __ex);`,
  },
  // ── 第 3 轮审查新增：每条新规则各自的「写坏必红」对照 ──
  // 下面 P11–P14 是第 3 轮实测**全部 exit=0（绿）**的四种绕过：
  // 都保留 `...` 字样却什么都没排除 —— 旧版只查 `...pastTargets` 这个**文本前缀**，
  // 所以任何让数组变空的尾巴都能骗过它。
  {
    name: 'P11 在展开结果上挂 .slice(0, 0) 必须红（第 3 轮 H1 绕过①）',
    file: 'page', want: 'red',
    from: `    const drawn = pickTarget(roster, BOT_POOL_DIFFICULTY, [
      ...(m.botIdentity ? [m.botIdentity.id] : []),
      ...m.pastTargets,
    ]);`,
    to: `    const drawn = pickTarget(roster, BOT_POOL_DIFFICULTY, [
      ...(m.botIdentity ? [m.botIdentity.id] : []),
      ...m.pastTargets.slice(0, 0),
    ]);`,
  },
  {
    name: 'P12 三元两个分支都写空数组必须红（绕过②：`botIdentity` 在，却什么都没排除）',
    file: 'page', want: 'red',
    from: `    const drawn = pickTarget(roster, BOT_POOL_DIFFICULTY, [
      ...(m.botIdentity ? [m.botIdentity.id] : []),
      ...m.pastTargets,
    ]);`,
    to: `    const drawn = pickTarget(roster, BOT_POOL_DIFFICULTY, [
      ...(m.botIdentity ? [] : []),
      ...m.pastTargets,
    ]);`,
  },
  {
    name: 'P13 整个三元展开后再 .slice(0, 0) 必须红（绕过③）',
    file: 'page', want: 'red',
    from: `    const drawn = pickTarget(roster, BOT_POOL_DIFFICULTY, [
      ...(m.botIdentity ? [m.botIdentity.id] : []),
      ...m.pastTargets,
    ]);`,
    to: `    const drawn = pickTarget(roster, BOT_POOL_DIFFICULTY, [
      ...(m.botIdentity ? [m.botIdentity.id] : []).slice(0, 0),
      ...m.pastTargets,
    ]);`,
  },
  {
    name: 'P14 在展开结果上挂 .filter(() => false) 必须红（绕过④）',
    file: 'page', want: 'red',
    from: `    const drawn = pickTarget(roster, BOT_POOL_DIFFICULTY, [
      ...(m.botIdentity ? [m.botIdentity.id] : []),
      ...m.pastTargets,
    ]);`,
    to: `    const drawn = pickTarget(roster, BOT_POOL_DIFFICULTY, [
      ...(m.botIdentity ? [m.botIdentity.id] : []),
      ...m.pastTargets.filter(() => false),
    ]);`,
  },
  {
    name: 'P15 把排除集一半提成变量再展开必须**不**报（合法重构 —— 元素级解一层变量）',
    file: 'page', want: 'green',
    from: `    const drawn = pickTarget(roster, BOT_POOL_DIFFICULTY, [
      ...(m.botIdentity ? [m.botIdentity.id] : []),
      ...m.pastTargets,
    ]);`,
    to: `    const __who = m.botIdentity ? [m.botIdentity.id] : [];
    const drawn = pickTarget(roster, BOT_POOL_DIFFICULTY, [
      ...__who,
      ...m.pastTargets,
    ]);`,
  },
  // ── 第 6 条的新形状规则：成员写入不许靠关键词黑名单（词可以拆，形状拆不了）──
  {
    name: 'P16 用字符串拼出 candidates 成员名再写必须红（第 3 轮 H 绕过：旧版黑名单 exit=0）',
    file: 'page', want: 'red',
    from: `const guess = botPick(r.brain);`,
    to: `const guess = botPick(r.brain);\n    r.brain['cand' + 'idates'] = [r.target];`,
  },
  {
    name: 'P17 用 Object.assign 改写 brain 内部状态必须红',
    file: 'page', want: 'red',
    from: `const guess = botPick(r.brain);`,
    to: `const guess = botPick(r.brain);\n    Object.assign(r.brain, { ['cand' + 'idates']: [r.target] });`,
  },
  // ── 第 5 条的新规则：猜测变量必须不可重绑定（第 3 轮 H2 两种改法实测 exit=0）──
  {
    name: 'P18 给猜测加 `?? 答案` 兜底必须红（第 3 轮 H2 绕过①：看着只是个空值兜底）',
    file: 'page', want: 'red',
    from: `const guess = botPick(r.brain);`,
    to: `const guess = botPick(r.brain) ?? r.target;`,
  },
  {
    name: 'P19 声明成 let 再把答案回填进猜测变量必须红（绕过②：变量名没变，装的东西变成答案）',
    file: 'page', want: 'red',
    from: `const guess = botPick(r.brain);`,
    to: `let guess = botPick(r.brain);\n    guess = r.target;`,
  },
  // ── 第 3 条的黑名单扩展：每条替代项都要单独可证伪 ──
  {
    name: 'P20 引擎里出现 new Function(...) 必须红（不带 import、不带答案字样的后门）',
    file: 'engine', want: 'red',
    from: `export const BOT_MAX_GUESSES = 8;`,
    to: `export const BOT_MAX_GUESSES = 8;\nconst f = new Function('return 1');`,
  },
  {
    name: 'P21 引擎里出现 global（globalThis 的别名）必须红',
    file: 'engine', want: 'red',
    from: `export const BOT_MAX_GUESSES = 8;`,
    to: `export const BOT_MAX_GUESSES = 8;\nconst g = global;`,
  },
  {
    name: 'P22 引擎里出现 require(...) 必须红（同步拿到 store 里就有 target）',
    file: 'engine', want: 'red',
    from: `export const BOT_MAX_GUESSES = 8;`,
    to: `export const BOT_MAX_GUESSES = 8;\nconst x = require('@/stores/game-store');`,
  },
  {
    name: 'P23 引擎里出现动态 import(...) 必须红（不是 import 语句，第 2 条白名单拦不住）',
    file: 'engine', want: 'red',
    from: `export const BOT_MAX_GUESSES = 8;`,
    to: `export const BOT_MAX_GUESSES = 8;\nconst m = await import('@/stores/game-store');`,
  },
].filter((c) => !c.skip);

/** 把基线两份源文件写进临时目录（含 `--root` 需要的目录结构） */
function writeBaseline() {
  mkdirSync(join(TMP, 'src/lib'), { recursive: true });
  mkdirSync(join(TMP, 'src/app/bot'), { recursive: true });
  writeFileSync(join(TMP, ENGINE_REL), ENGINE_SRC);
  writeFileSync(join(TMP, PAGE_REL), PAGE_SRC);
}

/** 跑一次哨兵，返回退出码（spawn 失败返回 null） */
function runSentinel() {
  const r = spawnSync(process.execPath, [SENTINEL, '--root', TMP], { encoding: 'utf8' });
  return r.status;
}

const bad = [];
let ran = 0;
try {
  rmSync(TMP, { recursive: true, force: true });

  // 基线：源文件未改动时必须绿（同时充当「哨兵本身没被改坏」的冒烟）
  writeBaseline();
  {
    const st = runSentinel();
    ran++;
    if (st !== 0) {
      bad.push(`基线（未改动）预期 green，实得 exit=${st} —— 哨兵对真实源文件已经报红，`
        + `先修哨兵；下面的用例结果不可信`);
    } else {
      console.log('✓ 基线（未改动）→ green');
    }
  }

  for (const c of CASES) {
    const target = c.file === 'engine' ? ENGINE_SRC : PAGE_SRC;
    const replacements = [{ from: c.from, to: c.to }, ...(c.also ?? [])];

    // 锚点体检：每条 from 必须恰好命中 1 次
    let anchorErr = null;
    for (const r of replacements) {
      const n = findCount(target, r.from);
      if (n !== 1) {
        anchorErr = `锚点命中 ${n} 次（预期 1 次）：${r.from.split('\n')[0].trim().slice(0, 70)}`;
        break;
      }
    }
    if (anchorErr) {
      bad.push(`${c.name}\n      → ${anchorErr}\n      → 被保护的那行被人改了，请同步更新本脚本`);
      continue;
    }

    let mutated = target;
    for (const r of replacements) mutated = applyMutation(mutated, r.from, r.to);
    writeBaseline();
    writeFileSync(join(TMP, c.file === 'engine' ? ENGINE_REL : PAGE_REL), mutated);

    const st = runSentinel();
    ran++;
    const got = st === 0 ? 'green' : st === 1 ? 'red' : `crash(exit=${st})`;
    const ok = got === c.want;
    if (!ok) bad.push(`${c.name}\n      → 预期 ${c.want}，实得 ${got}${got.startsWith('crash') ? '（哨兵自己抛异常了）' : ''}`);
    else console.log(`✓ ${c.want === 'red' ? '红' : '绿'} ← ${c.name}`);
  }
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

if (bad.length) {
  console.error(`\n✗ 哨兵自测失败（${bad.length}/${ran} 条不符）：`);
  for (const b of bad) console.error('   - ' + b);
  process.exit(1);
}
console.log(`\n✓ 哨兵自测通过：${ran} 个用例（1 基线 + ${CASES.length} 反事实）全部符合预期 —— `
  + `七条不变量各有「写坏必红」对照，其中 M2/M3/M4 与注释剥除另有「合法重构必绿」对照；`
  + `第 3 轮补的 P11–P23 覆盖了那六个实测过的绕过（四种「保留 ... 却什么都没排除」、`
  + `六条「关键词黑名单靠拆分绕过」与「猜测变量被回填成答案」，以及两条合法重构的假阳性对照）`);
