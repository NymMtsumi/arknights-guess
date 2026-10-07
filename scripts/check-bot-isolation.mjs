/**
 * 人机隔离哨兵
 * =============
 * 人机对战是**纯客户端**玩法：谜底就躺在同一个进程的内存里（`/bot` 页的
 * `roundRef.current.target`）。所以「人机读不到答案」不能靠约定，只能靠**结构**：
 * 人机的每一步都只吃「一行与玩家棋盘逐字相同的反馈」，永远拿不到那个对象。
 *
 * 🔴 为什么必须有这条哨兵：**破坏它是静默的，且方向是好的**。
 *    谁「顺手」把目标传进 `botPick` / `botLearn`，人机的候选集会瞬间从 429 收到 1，
 *    准确率从 40/60/78.5% 变成接近 100%，落子变快 —— 面板上没有任何异常，测试也不会红
 *    （准确率测试断言的是「与定标目标相差 ±6pt 以内」，超上限是红的，但**常量反馈**那条
 *    路走的是另一个方向，见下）。
 *
 * 因此这里钉七条**可机械验证**的不变量：
 *   1. `src/lib/bot-engine.ts` 的**代码**里（注释剥掉后）不出现 target/answer/secret
 *      等承载答案的标识符 —— 大小写不敏感的**子串**匹配；
 *   2. 该文件的 import 面被限制死 —— 只允许 `./game-engine`（纯函数）与
 *      type-only 的 `@/types/character`。**尤其不许 import 任何 store**：
 *      `game-store` 的 state 里就有 target，import 进来就再没有东西能拦住它；
 *   3. 该文件不碰**全局后门**（globalThis / window / self / process / document / eval /
 *      Function / global / require）与**动态 import(**）—— 那是绕过第 1、2 条的后门：
 *      `globalThis.__botTarget` 这种写法不带 import、也不带 target 字样的**参数**，
 *      却能把答案递进来。`Function` / `global` / `require` / `import(` 是第 3 轮补的：
 *      `new Function(...)` 与 `global` 都不需要 import，`require('@/stores/game-store')`
 *      与动态 `import(...)` 则绕开了第 2 条只认 import **语句**的白名单；
 *   4. `botPick` 的形参个数受限（最多 brain + rng）；
 *   5. `/bot` 页调用 `botPick(...)` / `botLearn(...)` 的**实参**逐个过白名单 ——
 *      `botPick` 只许传 1 个 `*.brain`；`botLearn` 的第 2 参必须是**接收 `botPick`
 *      返回值的那同一个变量**，第 3 参必须是**由 `makeGuess(答案, 同一个猜测)` 产生**
 *      的那一行。且这个「猜测变量」必须**不可重绑定**（`const` 声明、`botPick(...)`
 *      右括号后不接 `??`/`||`/`?:`、全页只赋值一次）—— 否则 `botPick(...) ?? r.target`
 *      或 `let guess = ...; guess = r.target` 会让**名字仍然是那个名字**、装的东西变成答案；
 *   6. `/bot` 页**不得提到候选集**（`candidates`）、不得对 `*.brain` 做**成员写入**
 *      （`.brain` 后不许紧跟 `.` / `[`）、不得用 `Object.assign` / `defineProperty` /
 *      `setPrototypeOf` / `Reflect.set` / `__proto__` 改写它，且交给 `createBrain` 的
 *      必须是**整份 roster** —— 「把候选集改成 [答案]」和「从 [答案] 建脑」都能在不出现
 *      一个 target 字样的情况下把答案喂进去。**光查关键词不够**（第 3 轮实测：
 *      `r.brain['cand'+'idates'] = [r.target]` 穿过关键词黑名单），所以按**形状**钉；
 *   7. `/bot` 页抽谜底时把「人机的名字（`botIdentity.id`）」与「本场已用过的谜底
 *      （`pastTargets`）」**展开**进排除集；且排除集必须是**数组字面量**、每个顶层元素
 *      都必须是**直接展开**（展开的目标只能是成员表达式，或「两边都是数组字面量」的三元）
 *      —— 第 3 轮实测四种改法在保留 `...` 字样的前提下把数组弄空全部穿过旧版：
 *      `...m.pastTargets.slice(0, 0)`、`...(x ? [x.id] : []).slice(0, 0)`、
 *      `...(x ? [] : [])`、`...m.pastTargets.filter(() => false)`。
 *
 * ⚠️ 第 7 条不是「另一件事」，它是**反方向的那半条隔离**。前六条保证人机**读不到**答案，
 *    第 7 条保证人机**不会成为**答案 —— 抽到同一个人时，对面板上会同时写着人机的名字和
 *    「答案：<同一个名字>」，一眼穿帮，而且那条对局人机只要报自己的名字就赢了。
 *    它同样是**静默**的：删掉排除列表，页面照跑、棋盘照画、h1 不报错，只在 1/429 的对局里
 *    偶然露馅。所以钉在这里，不靠 UI 冒烟的抽样。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 本文件的演化史（别把它当成「一开始就写对了」）
 *
 * 第一版只做「字符串形状」检查（不出现 target / 形参个数 / 子串包含），结果三条绕过
 * **实测全绿**、而隔离已经破了：
 *
 *   A. `botLearn(r.brain, guess, FEEDBACK_ALL_CORRECT)` —— 把整行反馈换成一个「永远说对」
 *      的常量。实参里没有 target（过第 5 条），engine 没动（过第 1、2 条），形参没变
 *      （过第 4 条）。
 *      ⚠️ 它的后果**不是我一开始写的「准确率 100%」**（那是错的，见 M6）：常量全对反馈会让
 *      `botLearn` 的筛选条件与真答案的签名不符，候选集塌到 1 人**且真答案掉出去** ——
 *      人机从此稳定猜错。所以这是**反方向**的静默破坏（面板上人机突然变笨），
 *      同样是「没人会去看」的那种。
 *   B. `const tgt = r.target; botPick(r.brain, Math.random, tgt)` —— `\btarget\b` 对 `tgt`
 *      不命中；而第一版的形参正则 `\(([^)]*)\)` 会在 `() => number` 的括号处截断，
 *      看不见末尾追加的形参。
 *   C. `pickTarget(roster, D, m.botIdentity ? [] : m.pastTargets.slice(0, 0))` ——
 *      第 7 条只问「这两个词在不在实参文本里」，两个词都在，于是**满足**它，
 *      但一个都没排除。
 *
 * 现在这几条就是照着这三条绕过重写的：第 5 条从「不出现 target」升级成「实参必须长成
 * 白名单里的形状」（A、B 都成了红的），第 4 条换成平衡括号扫描，第 7 条要求**展开形态**。
 *
 * 改完之后**又跑了一轮**反事实对照，当场又抓出第四条 —— 这次是**假阴性**（方向相反）：
 *
 *   D. 第 7 条一开始是「扫整页找展开形态」，于是 C 那条改法**只红一半**：
 *      `pastTargets` 那半边仍是绿的，因为「把本场谜底记进历史」那条无关语句
 *      `m.pastTargets = [...m.pastTargets, drawn.id]`
 *      （把本场谜底记进历史，与排除无关）也含 `...m.pastTargets`，把这一半喂饱了。
 *      即「删掉排除、留下记录」这种最像顺手重构的改法只红一半。
 *      所以第 7 条现在**只认排除集那一份实参**（数组被提成变量时顺着变量名跟一层）。
 *
 * 代码审查第 2 轮又抓出三条，都在这份文件里修掉了（每条都有反事实对照）：
 *
 *   E. 第 1 条原来是 `\btarget\b`（大小写敏感 + 两侧词边界）→ `targetId` / `myTarget` /
 *      `Target` / `_target` 四种写法**全部穿过**。实测确认后才改成大小写不敏感的子串匹配
 *      （保留字符串内容一起扫，宁可误报）。子串匹配在引擎上零误报 —— 实测引擎里没有任何
 *      合法标识符含这些词。
 *   F. 没有第 3 条 → `(globalThis as any).__botTarget` 是条真后门（演示过：不带 import、
 *      不传形参，直接读页面闭包外的全局）。
 *   G. 没有第 6 条 → 两条不吃实参白名单的喂答案路径：`r.brain.candidates = [r.target]`
 *      （候选集只剩答案）、`createBrain(m.tier, [drawn])`（从单人数组建脑）。
 *      实测页面当前**零** `candidates` 字样、`createBrain` 只吃 `roster`，所以这两条不误报。
 *
 代码审查第 3 轮又抓出六条，同样都修掉了（每条都有反事实对照，见自测脚本 P11–P23）：

   H. 第 7 条只查展开的**文本前缀** → 任何「让数组变空的尾巴」都能穿过。四种改法全部实测
      **exit=0**：`.slice(0, 0)` 挂在展开结果上、`.filter(() => false)`、以及三元的两个分支
      都写 `[]`（`...m.botIdentity ? [] : []` —— `botIdentity` 这个词还在，却什么都没排除）。
      现在要求「数组字面量 + 每个元素都是直接展开 + 真的取了 `.botIdentity.id`」。
   I. 第 5 条只认**声明处** → `const guess = botPick(r.brain) ?? r.target`（看着就是个空值
      兜底）与 `let guess = botPick(r.brain); guess = r.target` 两种改法实测 **exit=0**。
      变量的**名字**还是那个，装的东西成了答案。现在要求 `const` + 右括号后不接运算符
      + 全页只赋值一次。
   J. 第 6 条的关键词黑名单**可以拆** → `r.brain['cand' + 'idates'] = [r.target]` 实测
      **exit=0**（拼出来的成员名不含 `candidates` 这个词），反倒 `const K = 'candidates'`
      那种是红的（字面量在字符串里）。词可以拆、**形状拆不了**，所以补了成员写入的形状规则。
   K. 第 3 条的黑名单漏了 `Function` / `global` / `require` / 动态 `import(` —— 四条都是
      「不需要 import 语句」的后门。实测引擎里这几个词当前出现 0 次，不误报。

 ⚠️ 它防的是**顺手**，不是防**蓄意**。真要绕，`botPick(r.brain, Math.random, encode(answer))`
 *    这种写法本哨兵依然拦不住 —— 但那种改动已经不像「顺手」了。
 *
 * 已知边界（都是**有意**的取舍，别当成 bug）：
 *   · `stripComments` 会保留字符串内容（早期版本见 `//` 就砍掉整行剩余，于是字符串里塞
 *     一个 `//` 就能把 target 藏起来）。代价是字符串里的 target 也会报 —— 那是**该报**的。
 *   · 不识别**正则字面量**：`/target/` 里的 `/` 会被当成除号，若正则里含 `'` 或 `"`
 *     会让状态机错位。引擎里目前没有正则字面量，真加了请人工复核。
 *   · 字符串里含 `)` 或 `,` 会让第 4、5 条的平衡括号扫描**提前截断**（只在引擎/页面里
 *     写这种字符串时才可能发生）。
 *   · 变量解引用**只跟一层**（`const a = r.brain; botPick(a)` 可以，两层不行）——
 *     有意的偏紧，见第 7 条注释。
 *   · `export * from './x'` 的形式**不被当成 import**，会漏过第 2 条白名单。
 *
 * 这七条不变量都不是想出来的，是**改完就跑反事实**跑出来的。改本文件时请沿用同一套：
 * 每加一条不变量，都要有一份「故意写坏 → 必须红」的对照；反向的假阳性也要有一份
 * 「合法重构 → 必须绿」的对照（例：把排除数组提成变量传进去）。
 * `scripts/check-bot-isolation-selftest.mjs` 把这两类对照**固化成了脚本**（33 个用例，
 * 改这份文件后必须重跑它）。
 *
 * 退出码：0 = 通过；1 = 隔离被破坏。
 * `--root <dir>`：把根目录指到别处（自测脚本用它对着临时副本跑）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const rootIdx = argv.indexOf('--root');
// 长提示信息用 `${eol}` 手工换行 —— 与下面的 `\n` 等价，但改起来只需动一处。
const eol = '\n';
const ROOT = rootIdx !== -1 && argv[rootIdx + 1]
  ? resolve(argv[rootIdx + 1])
  : join(dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = join(ROOT, 'src/lib/bot-engine.ts');
const PAGE = join(ROOT, 'src/app/bot/page.tsx');

const fails = [];

/**
 * 剥掉注释，返回 `[{ line, text }]`（行号从 1 起，便于报错定位）。
 *
 * **字符串感知**：`'` `"` 反引号 内的内容原样保留（含转义），只有注释被丢弃。
 * 这一点是有意的 —— 早期版本「见 `//` 就砍掉整行剩余、见 `/*` 就清空后续若干行」，
 * 于是在字符串里写一个 `//` 就能把同一行的 `target` 一起抹掉，见文件头的 C 条。
 * 保留字符串内容的代价是：字符串里出现 `target` 也会被第 1 条报出来 —— 那是**该报**的，
 * 宁可误报也不放过（引擎里本就没有任何承载答案的字符串）。
 */
function stripComments(src) {
  const out = [];
  let text = '';
  let inBlock = false;
  let inLine = false;
  let inStr = null;
  const push = () => out.push({ line: out.length + 1, text });
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '\n') { push(); text = ''; inLine = false; continue; }
    if (inLine) continue;
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
    if (inStr) {
      text += c;
      if (c === '\\') { text += n ?? ''; i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '/' && n === '/') { inLine = true; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    if (c === "'" || c === '"' || c === '`') { inStr = c; text += c; continue; }
    text += c;
  }
  push();
  return out;
}

/** 行号 = 该下标之前有几个换行 + 1 */
const lineAt = (code, index) => code.slice(0, index).split('\n').length;

/**
 * 取出 `name(` 的**每一次**调用的实参原文，附行号（第 4、5 条报错要用）。
 * 用平衡括号扫描而不是 `\(([^)]*)\)` —— 后者会在 `rng: () => number` 这种
 * 函数类型的括号处提前截断，看不见后面追加的形参（文件头 B 条）。
 */
function callArgs(code, name) {
  const out = [];
  const re = new RegExp(`\\b${name}\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(code)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < code.length && depth > 0) {
      const c = code[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      i++;
    }
    out.push({ text: code.slice(start, i - 1), line: lineAt(code, m.index) });
  }
  return out;
}

/** 按**顶层**逗号切开实参串（括号/方括号/花括号内的逗号不切）。 */
function splitArgs(s) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const c of s) {
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map(p => p.trim()).filter(Boolean);
}

/** `name(` 的**声明**处的形参原文（同样是平衡括号）。找不到声明返回 null。 */
function declParams(code, name, exportPrefix = true) {
  const re = new RegExp(`${exportPrefix ? 'export\\s+function\\s+' : ''}${name}\\s*\\(`);
  const m = re.exec(code);
  if (!m) return null;
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  while (i < code.length && depth > 0) {
    const c = code[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    i++;
  }
  return code.slice(start, i - 1);
}

/**
 * 变量解引用**一层**：裸标识符 → 它的初始化式；否则原样返回。
 *
 * ⚠️ 只在第 5、7 条用，且**只跟一层**。写 `const a = r.brain; const b = a; botPick(b)`
 * 会报红 —— 这是**有意的偏紧**：误红只花人看一眼，误绿则等于这条保证不存在。
 * 正则里 `(?::[^=;]*?)?` 那段是允许**类型标注**（`const g: Character | null = ...`）——
 * 漏了它会让「加个类型标注」这种纯装饰性改动被误报成隔离破坏（M3）。
 */
function derefOneLevel(code, expr) {
  const t = expr.trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(t)) return t;
  const decl = new RegExp(`(?:const|let|var)\\s+${t}\\s*(?::[^=;]*?)?=\\s*([^;]*);`).exec(code);
  return decl ? decl[1].trim() : t;
}

const engineSrc = readFileSync(ENGINE, 'utf8');
const engineLines = stripComments(engineSrc);
const code = engineLines.map(l => l.text).join('\n');
const rel = (p) => p.slice(ROOT.length + 1).replace(/\\/g, '/');

// ── 1. 代码里不出现承载答案的标识符 ──────────────────────────────
// 🔴 **大小写不敏感的子串**匹配，不是 `\bword\b`。
//    后者（第 2 轮审查抓出的 E 条）实测漏掉 `targetId` / `myTarget` / `Target` / `_target`
//    四种写法 —— 而 `targetId` 正是最像顺手命名的那个。
//    子串匹配在本文件上的误报风险：实测引擎里**没有任何**合法标识符含这几个词
//    （`grep -iE 'target|answer|secret|solution|truth'` 命中数为 0），所以是安全的；
//    将来若真加了，宁可报红让人看一眼。
const FORBIDDEN = /(target|answer|secret|solution|truth)/i;
for (const { line, text } of engineLines) {
  const m = FORBIDDEN.exec(text);
  if (m) {
    fails.push(`${rel(ENGINE)}:${line} 代码里出现 \`${m[0]}\`（匹配 \`${m[1]}\`）—— `
      + `人机不得接触承载答案的标识符\n       ${text.trim()}`);
  }
}

// ── 2. import 面被限制死 ────────────────────────────────────────
// 从「剥掉注释后的代码」里取，避免把文档注释里举例的 import 也算进来。
// 🔴 按**语句**取（`^import ... ;`，跨行），不是按行 —— 后者会把
//    `import {\n  a, b\n} from '...'` 这种多行写法误报成白名单外（M4）。
const importStmts = [...code.matchAll(/^import\b[^;]*;/gm)]
  .map(m => ({ line: lineAt(code, m.index), text: m[0].replace(/\s+/g, ' ').trim() }));
const ALLOWED = [
  { re: /^import type \{[^}]*\} from ['"]@\/types\/character['"];$/, why: 'type-only: 类型在编译后被擦除，不携带任何运行时对象' },
  { re: /^import \{[^}]*\} from ['"]\.\/game-engine['"];$/, why: '纯函数：只导出比较/查找，没有状态' },
];
if (!importStmts.length) {
  fails.push(`${rel(ENGINE)} 一条 import 都没有 —— 锚点没了（本哨兵需要同步更新）`);
}
for (const { line, text } of importStmts) {
  if (!ALLOWED.some(a => a.re.test(text))) {
    fails.push(`${rel(ENGINE)}:${line} 出现了白名单外的 import：\n       ${text}\n       —— 尤其别 import 任何 store：state 里就可能带着谜底`);
  }
}
// 正向断言：那两条**必须**都在。白名单只拦「多了什么」，拦不住「game-engine 被摘掉后
// 改用别的等价物」—— 那种改动会让上面那条正则同时失效。
for (const a of ALLOWED) {
  if (!importStmts.some(s => a.re.test(s.text))) {
    fails.push(`${rel(ENGINE)} 缺少预期的 import（${a.why}）—— 本哨兵的白名单需要同步复核`);
  }
}

// ── 3. 不碰全局对象 ─────────────────────────────────────────────
// 🔴 第 2 轮审查演示过的真后门：`(globalThis as any).__botTarget`。
//    它不带 import（过第 2 条）、不带形参（过第 4 条）、实参里没有 target（过第 5 条），
//    却能读到页面闭包外的任何东西。把这几扇门一起焊死。
// 🔴 第 3 轮审查补：原先漏了**几条不需要 import** 的后门。
//    · `const f = new Function('...')` —— 同 eval 一类，实参里可以没有任何答案字样；
//    · `const g = global` —— `globalThis` 的别名，而 `\bglobal\b` 不会误伤 `globalThis`；
//    · `require('@/stores/game-store')` —— 同步拿到 store，里面有 target；
//    · 动态 `import('...')` —— 同理。
//    实测引擎里这几个词的出现数均为 0，所以黑名单不会误报。
//    （`\bimport\b` 不能整个进黑名单 —— 引擎自己就有 import **语句**；只钉 `import(` 这种**调用**形态。）
const GLOBAL_ESCAPE = /\b(globalThis|window|self|process|document|eval|Function|global|require)\b/;
const DYNAMIC_IMPORT = /\bimport\s*\(/;
for (const { line, text } of engineLines) {
  const m = GLOBAL_ESCAPE.exec(text) ?? DYNAMIC_IMPORT.exec(text);
  if (m) {
    fails.push(`${rel(ENGINE)}:${line} 代码里出现全局后门 \`${m[0]}\` —— `
      + `人机是纯逻辑，不碰全局：这是绕过 import 白名单把答案递进来的后门\n       ${text.trim()}`);
  }
}

// ── 4. botPick 的形参个数 ───────────────────────────────────────
{
  const raw = declParams(code, 'botPick');
  if (raw === null) {
    fails.push(`${rel(ENGINE)} 找不到 botPick 的声明 —— 锚点没了（本哨兵需要同步更新）`);
  } else {
    const params = splitArgs(raw).map(s => s.replace(/\?$/, '').split(/[:=]/)[0].trim()).filter(Boolean);
    if (params.length > 2) {
      fails.push(`botPick 有 ${params.length} 个形参（${params.join(', ')}）—— 预期最多 2 个（brain, rng）；多出来的那个参数需要人工确认`);
    }
    // 形参名本身也不许承载答案（`secretAnswer` 这类名字会从第 1 条的子串匹配漏过去才怪 ——
    // 但留着这道口子防的是「以后把第 1 条改回词边界」的那种回退）
    const bad = params.filter(p => /answer|secret|truth|solution|target/i.test(p));
    if (bad.length) fails.push(`botPick 的形参名里有 ${bad.join('/')} —— 换个名字也还是那扇门`);
  }
}

// ── 5. 页面调用 botPick / botLearn 的实参逐个过白名单 ─────────────
// 🔴 这一条是**语义**的，不是「不出现某个词」。原因见文件头 A 条。
//    ⚠️ 且**第 3 参不是「长得像 comparisons」就够**（M1）：`const r = makeGuess(r.target, r.target)`
//       也长成 `r.comparisons`，但那一行是用答案自己比自己产生的 —— 每一栏都是 correct，
//       人机下一猜必中。所以第 3 参必须回溯到**那个赋值语句本身**，且它的 makeGuess
//       第 2 参必须与 botLearn 的第 2 参是同一个变量。
const BRAIN = /^[A-Za-z_$][\w$]*\.brain$/;
const COMPARISONS = /^[A-Za-z_$][\w$]*\.comparisons$/;

const pageSrc = readFileSync(PAGE, 'utf8');
const pageLines = stripComments(pageSrc);
const pageCode = pageLines.map(l => l.text).join('\n');

/**
 * 反馈行的**来源**校验（M1）。返回 null 表示合法，否则返回一句原因。
 * `guessVar` = botLearn 的第 2 参（猜测变量名）。
 */
function feedbackOrigin(pageCode, guessVar, fbArg) {
  const m = /^([A-Za-z_$][\w$]*)\.comparisons$/.exec(fbArg.trim());
  if (!m) return `不是「某变量.comparisons」的形状（${fbArg}）`;
  const v = m[1];
  const call = new RegExp(`(?:const|let|var)\\s+${v}\\s*(?::[^=;]*?)?=\\s*makeGuess\\s*\\(([^;]*)\\)`).exec(pageCode);
  if (!call) return `${v} 不是 makeGuess(...) 的赋值结果 —— 这行反馈是伪造的`;
  const args = splitArgs(call[1]);
  if (args.length !== 2) return `${v} 的 makeGuess 不是 2 个实参（${args.join(', ')}）`;
  if (!/^[A-Za-z_$][\w$]*\.target$/.test(args[0])) {
    return `makeGuess 的第 1 参不是「某对象.target」（${args[0]}）`;
  }
  if (args[1] !== guessVar) {
    return `makeGuess 的第 2 参（${args[1]}）与交给 botLearn 的猜测（${guessVar}）不是同一个变量`;
  }
  return null;
}

// 「botPick 的返回值被赋给了哪个变量」—— 它就应该是 botLearn 的第 2 参。
// `(?::[^=;]*?)?` 允许类型标注（M3），否则 `const guess: Character | null = botPick(...)`
// 会被漏掉，进而把一条合法调用误判成「猜测不是 botPick 的返回值」。
//
// 🔴 第 3 轮审查抓出的绕过（两条都实测 exit=0）：只认**声明**是不够的 —— 这个变量之后
//    被赋成什么，此前无人过问。两种改法都能让**答案**流进 botLearn 的第 2 参：
//      · `const guess = botPick(r.brain) ?? r.target;`   ← 看着就是个空值兜底
//      · `let guess = botPick(r.brain); guess = r.target;`
//    而 feedbackOrigin 只比**变量名**（名字叫 guess 就够，当时装着什么不管），
//    于是 isWin(答案, 猜测) 立刻为真、人机必胜。补三条把变量钉成不可重绑定：
//      ① 只许 `const`；② `botPick(...)` 收尾的 `)` 之后不许再接运算符（`??`/`||`/`?:`…）；
//      ③ 该变量在本页只能被赋值一次（即声明那次）。
const pickedVars = new Set();
/** 返回与 `(`（下标 open）配对的 `)` 的下标；扫不通返回 -1。 */
function matchParen(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}
for (const m of pageCode.matchAll(/(const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*?)?=\s*botPick\s*\(/g)) {
  const kw = m[1];
  const name = m[2];
  pickedVars.add(name);
  const at = `${rel(PAGE)}:${lineAt(pageCode, m.index)}`;
  // ① 只许 const
  if (kw !== 'const') {
    fails.push(`${at} 猜测变量 \`${name}\` 用 \`${kw}\` 声明 —— 必须是 \`const\`${eol}       —— 可重绑定的猜测变量可以被改成答案（\`${name} = r.target\`），而第 5 条只认「这个名字来自 botPick」，名字不动就骗过去了`);
  }
  // ② botPick(...) 之后必须直接结束（`, ; )` 或换行）
  const close = matchParen(pageCode, m.index + m[0].length - 1);
  if (close === -1) {
    fails.push(`${at} 配不出 botPick(...) 的右括号 —— 锚点异常，请人工复核`);
  } else {
    const next = pageCode.slice(close + 1).match(/^\s*(\S)/)?.[1] ?? '';
    if (next && ';,)\n'.includes(next) === false) {
      fails.push(`${at} \`botPick(...)\` 之后还接着 \`${next}\` —— 猜测变量只能直接取 botPick 的返回值${eol}       —— \`botPick(...) ?? r.target\`、\`|| r.target\` 这类兜底会把**答案**接到猜测位置`);
    }
  }
  // ③ 只能被赋值一次
  // `(?::[^=;]*?)?` 是给类型标注留的口子：`const guess: Character | null = botPick(...)`
  // 里名字与 `=` 中间隔着一整个类型，不放它的话「声明那一次」根本不计入，
  // 于是合法的类型标注会被算成「被赋值 0 次」而误红。
  const assigns = [...pageCode.matchAll(new RegExp(`(?<![\\w$.])${name}\\s*(?::[^=;]*?)?=(?!=)`, 'g'))];
  if (assigns.length !== 1) {
    fails.push(`${at} 猜测变量 \`${name}\` 在本页被赋值 ${assigns.length} 次（应恰 1 次，即声明那次）${eol}       —— 多出来的那次多半是 \`${name} = r.target\`：变量名没变，装的东西变成了答案`);
  }
}
/** 与 BRAIN / COMPARISONS 匹配时允许解一层变量引用（M2）。 */
const matchesOneLevel = (re, arg) => re.test(arg.trim()) || re.test(derefOneLevel(pageCode, arg));

let pickCalls = 0;
let learnCalls = 0;
for (const { text: raw, line } of callArgs(pageCode, 'botPick')) {
  pickCalls++;
  const args = splitArgs(raw);
  if (args.length !== 1 || !matchesOneLevel(BRAIN, args[0])) {
    fails.push(`${rel(PAGE)}:${line} botPick 的实参不是「恰好 1 个 *.brain」：(${args.join(', ')})`
      + `\n       —— 多出来的实参就是「顺手传答案」的那扇门（人机只要拿到答案，准确率直奔 100%）`);
  }
}
for (const { text: raw, line } of callArgs(pageCode, 'botLearn')) {
  learnCalls++;
  const args = splitArgs(raw);
  if (args.length !== 3) {
    fails.push(`${rel(PAGE)}:${line} botLearn 的实参不是 3 个：(${args.join(', ')})`);
    continue;
  }
  if (!matchesOneLevel(BRAIN, args[0])) {
    fails.push(`${rel(PAGE)}:${line} botLearn 第 1 参不是 *.brain：${args[0]}`);
  }
  if (!pickedVars.has(args[1])) {
    fails.push(`${rel(PAGE)}:${line} botLearn 第 2 参（猜测）不是 botPick 的返回值`
      + `（${args[1]}；botPick 的返回值赋给了 ${[...pickedVars].join(', ') || '（没找到）'}）`
      + `\n       —— 猜测位置放任何别的东西都可能直接命中：「isWin(答案, 猜测) 为真」就赢了`);
  }
  const why = feedbackOrigin(pageCode, args[1], args[2]);
  if (why) {
    fails.push(`${rel(PAGE)}:${line} botLearn 第 3 参（反馈行）来源不合法：${why}`
      + `\n       —— 反馈行必须是把 makeGuess(答案, 「同一个猜测」) 的结果原样交出去；`
      + `常量、对象字面量、以及「答案自己比自己」产生的行都会让人机直接命中，`
      + `而后者连一个 target 字样都不出现在实参里`);
  }
}
// 两条路都得在。只数「总数」的话，把 botLearn 整个摘掉（人机不再学习、变成纯随机）
// 也只会让总数从 2 变 1 而照常通过 —— 那是另一种「顺手」：删掉一行看着像清理死代码。
if (!pickCalls || !learnCalls) {
  fails.push(`${rel(PAGE)} 里 botPick / botLearn 的调用不齐（botPick ${pickCalls} 次、`
    + `botLearn ${learnCalls} 次）—— 缺的那条路要么被摘掉了（锚点没了），要么本哨兵需要同步更新`);
}

// ── 6. 不得提到候选集；建脑必须吃整份 roster ──────────────────────
// 🔴 第 2 轮审查抓出的 G 条：有两条路径能在**不出现一个 target 字样**的情况下把答案喂进去
//      · `r.brain.candidates = [r.target]` —— 候选集只剩答案，人机下一猜必中；
//      · `createBrain(m.tier, [drawn])`      —— 从一个只有答案的数组建脑。
//    第 5 条拦不住它们：前者不是调用、后者实参里只有 drawn。所以在这里单独钉。
//    实测页面当前 `candidates` 出现 0 次、`createBrain` 只有 1 处且吃 `roster`，二者均不误报。
const candHits = [...pageCode.matchAll(/\bcandidates\b/gi)].map(m => lineAt(pageCode, m.index));
if (candHits.length) {
  fails.push(`${rel(PAGE)}:${candHits.join(',')} 页面里出现了 \`candidates\` —— 候选集是`
    + `引擎的内部状态，页面不该碰它（把候选集改成 [答案] 是喂答案最隐蔽的一条路）`);
}
// 🔴🔴 第 3 轮审查：上面那条**关键词**黑名单两下就能绕过去 ——
//     `r.brain['cand' + 'idates'] = [r.target]` 实测 exit=0（拼出来的成员名不含
//     `candidates` 这个词），而 `const K = 'candidates'; r.brain[K] = ...` 反倒是红的
//     —— 因为那个字面量在字符串里。**词可以拆，形状拆不了**，所以补一条形状规则：
//     禁止对 `*.brain` 做**成员写入**，即 `.brain` 后面不许紧跟 `.` 或 `[`。
//     合法的两处是「整体把 brain 传出去」（`botPick(r.brain)` / `botLearn(r.brain, …)`）
//     与「整体赋值」（`r.brain = botLearn(...)`）—— 它们后面跟的都是 `,` `)` ` =`。
//     实测页面当前 `\.brain\s*[.\[]` 命中 0 处，不会误报。
const brainMember = [...pageCode.matchAll(/\.brain\s*[.\[]/g)].map(m => lineAt(pageCode, m.index));
if (brainMember.length) {
  fails.push(`${rel(PAGE)}:${brainMember.join(',')} 出现对 \`*.brain\` 的**成员写入**（\`.brain\` 后紧跟 \`.\` 或 \`[\`）${eol}       —— 把 \`brain.candidates\` 换成只含答案的数组（哪怕用 \`['cand'+'idates']\` 拼出成员名）等于让人机下一猜必中；brain 只该被**整体**传给 botPick / botLearn，或整体赋值`);
}
// 同一扇门的另外几把钥匙：不写成员名也能改掉 brain 的内容。
// 实测页面里这几样当前均为 0 处，故不会误报；留着防的是「以后顺手 Object.assign 合并一下」。
for (const [label, re] of [
  ['Object.assign', /Object\s*\.\s*assign\s*\(/],
  ['Object.defineProperty', /Object\s*\.\s*defineProperty\s*\(/],
  ['Object.setPrototypeOf', /Object\s*\.\s*setPrototypeOf\s*\(/],
  ['Reflect.set', /Reflect\s*\.\s*set\s*\(/],
  ['__proto__', /__proto__/],
]) {
  const hit = re.exec(pageCode);
  if (hit) {
    fails.push(`${rel(PAGE)}:${lineAt(pageCode, hit.index)} 页面里出现 \`${label}\`${eol}       —— 它能在不出现任何成员名的前提下改掉 brain 的内部状态（例如把候选集换成 [答案]）`);
  }
}
const brainCalls = callArgs(pageCode, 'createBrain');
if (!brainCalls.length) {
  fails.push(`${rel(PAGE)} 找不到 createBrain(...) 调用 —— 锚点没了（本哨兵需要同步更新）`);
}
for (const { text: raw, line } of brainCalls) {
  const args = splitArgs(raw);
  if (!args.some(a => a === 'roster')) {
    fails.push(`${rel(PAGE)}:${line} createBrain 的实参里没有 \`roster\`：(${args.join(', ')})`
      + `\n       —— 人机的候选集必须是**整份干员表**，从一个子集（尤其只含答案的数组）建脑`
      + `等于直接告诉它答案`);
  }
}

// ── 7. 抽谜底时必须排除「人机的名字」+「本场已用过的谜底」 ──────────
// 🔴 要求**展开形态**（`...`）而不是「这两个词出现过」。原因见文件头 C 条：
//    `m.botIdentity ? [] : m.pastTargets.slice(0, 0)` 两个词都在、却一个都没排除。
//    「排除」这件事在源码里的唯一形态就是把它们展开进那个数组，所以直接钉展开。
//
// 🔴🔴 且**只认排除集那一份实参**，不扫整页。第一版扫整页，反事实对照当场抓出假阴性：
//    把排除集换成 `m.pastTargets.slice(0, 0)`（一个都没排除）后，`pastTargets` 这半边
//    仍然是绿的 —— 因为第 295 行的 `m.pastTargets = [...m.pastTargets, drawn.id]`
//    （「把本场谜底记进历史」那条无关语句）也含 `...m.pastTargets`，把这一半喂饱了。
//    于是「删掉排除、留下记录」这种最像顺手重构的改法**只红一半**。现在把范围收到实参上。
//
// 合法重构的出路：把数组提成变量再传（`const pool = [...]; pickTarget(roster, D, pool)`）
// 时，顺着那个变量名往下找一层它的初始化式 —— 只跟一层，够用且行为可预期。
// 跟不动就报红并要求人工复核，这是**有意的偏紧**：误红只花人看一眼，
// 误绿则等于这条保证不存在。
const spread = (name) => new RegExp(`\\.\\.\\.\\s*\\(?\\s*(?:[A-Za-z_$][\\w$]*\\.)?${name}\\b`);
function exclusionText(arg) {
  const t = arg.trim();
  if (/^[A-Za-z_$][\w$]*$/.test(t)) {
    const decl = new RegExp(`(?:const|let|var)\\s+${t}\\s*(?::[^=;]*?)?=\\s*([\\s\\S]*?);`).exec(pageCode);
    if (decl) return decl[1];
  }
  return t;
}
const drawCalls = callArgs(pageCode, 'pickTarget');
if (drawCalls.length !== 1) {
  fails.push(`${rel(PAGE)} 里出现 ${drawCalls.length} 处 pickTarget(...) 调用（预期恰 1 处）`
    + ` —— 锚点变了（本哨兵需要同步复核）`);
} else if (splitArgs(drawCalls[0].text).length !== 3) {
  fails.push(`${rel(PAGE)} 的 pickTarget(...) 不是 3 个实参 —— 排除集那一项没了？`);
} else {
  const exclude = exclusionText(splitArgs(drawCalls[0].text)[2]);
  const at = `${rel(PAGE)}:${drawCalls[0].line}`;
  // 拆出数组字面量的**顶层元素**（顶层逗号分隔）。
  // 元素若是「只含一个裸标识符的展开」（`...pool`），顺着一层变量找到它的初始化式；
  // 若那是个数组字面量就**摊平**（把它的元素接上来），否则原样保留成 `...pool`。
  const elemsOf = (txt) => {
    const t = txt.trim();
    if (!/^\[[\s\S]*\]$/.test(t)) return null;
    const out = [];
    for (const raw of splitArgs(t.slice(1, -1))) {
      let e = raw.trim();
      if (!e) continue;
      const bare = /^\.\.\.\s*([A-Za-z_$][\w$]*)\s*$/.exec(e);
      if (bare) {
        const inner = exclusionText(bare[1]).trim();
        if (/^\[[\s\S]*\]$/.test(inner)) {
          for (const n of splitArgs(inner.slice(1, -1))) { if (n.trim()) out.push(n.trim()); }
          continue;
        }
        e = '...' + inner;
      }
      out.push(e);
    }
    return out;
  };
  // 每个顶层元素都必须是**直接展开**，且展开的目标只允许两种：
  //   (A) 一个成员表达式（`m.pastTargets`）；
  //   (B) 一个「两边都是数组字面量」的三元（`m.botIdentity ? [m.botIdentity.id] : []`，
  //       带不带最外层括号都行 —— 不带也合法，因为 `...` 吃任意 AssignmentExpression）。
  // 除此之外一律报红。第 3 轮实测的四种绕过全都落在外面（全是 exit=0）：
  //   `...m.pastTargets.slice(0, 0)` / `...(x ? [x.id] : []).slice(0, 0)` /
  //   `...(x ? [] : [])` / `...m.pastTargets.filter(() => false)`。
  // 它们的共同点是**保留了 `...` 字样却什么都没排除**，所以只认前缀是不够的。
  const spreadTarget = (e) => {
    const t = e.trim();
    if (!t.startsWith('...')) return null;
    let r = t.slice(3).trim();
    if (r.startsWith('(')) {
      const close = matchParen(r, 0);
      // 括号没包住整个表达式 = 后面还挂着东西（`.slice(0, 0)` / `.filter(…)`）
      if (close !== r.length - 1) return null;
      r = r.slice(1, -1).trim();
    }
    return r;
  };
  const isMemberExpr = (x) => /^[A-Za-z_$][\w$]*(\s*\.\s*[A-Za-z_$][\w$]*)*$/.test(x);
  const isTernaryOfArrays = (x) => {
    const q = x.indexOf('?');
    const c = q === -1 ? -1 : x.indexOf(':', q);
    if (q === -1 || c === -1) return false;
    return /^\[[\s\S]*\]$/.test(x.slice(q + 1, c).trim())
      && /^\[[\s\S]*\]$/.test(x.slice(c + 1).trim());
  };
  const isDirectSpread = (e) => {
    const r = spreadTarget(e);
    return r !== null && (isMemberExpr(r) || isTernaryOfArrays(r));
  };
  const elems = elemsOf(exclude);

  if (elems === null) {
    fails.push(`${at} 抽谜底时的排除集不是数组字面量：${eol}       ${exclude.trim().slice(0, 160)}${eol}       —— 排除集必须是 \`[...(人机名), ...本场已用谜底]\` 这种**直接在字面量里展开**的形态，换成 \`m.pastTargets.slice(0, 0)\` 之类就一个都不排除`);
  } else {
    const badShape = elems.filter((e) => !isDirectSpread(e));
    if (badShape.length) {
      fails.push(`${at} 排除集的顶层元素里有不是「直接展开」的：${badShape.join(' | ').slice(0, 160)}${eol}       —— 每个元素都必须以 \`...\` 开头，且展开的必须是一个成员表达式或「两边都是数组字面量的三元」；在展开结果上再挂 \`.slice(0, 0)\`、\`.filter(() => false)\`、\`.map(…)\`，或写 \`...(cond ? [] : [])\`，都能**保留 \`...\` 字样**却一个都不排除（第 3 轮实测四种改法全绿）`);
    }
    const joined = elems.join('\n');
    const missing = ['botIdentity', 'pastTargets'].filter((n) => !spread(n).test(joined));
    // `.botIdentity` 光出现还不够 —— `...(m.botIdentity ? [] : [])` 里它也在，却什么都没排除。
    // 真正干活的形态是取它的 id。
    if (!/\.botIdentity\s*\.\s*id/.test(joined)) {
      missing.push('botIdentity.id');
    }
    if (missing.length) {
      fails.push(`${at} 抽谜底时的排除集里没有把 ${missing.map((n) => '`' + n + '`').join('、')} 展开：${eol}       ${exclude.trim().slice(0, 160)}${eol}       —— 少 \`botIdentity\`（\`.id\`）：人机的名字可能变成谜底（对面板上会同时出现人机名与「答案：<同一个名字>」），而且那条对局人机只要报自己的名字就赢了；\`(m.botIdentity ? [] : [])\` 这种也过不了本检查${eol}       —— 少 \`pastTargets\`：本场谜底会重复，同一个人被问两次${eol}       （若你只是把排除数组提成了变量，本检查会跟一层变量名；再绕一层就报红，请人工复核）`);
    }
  }
}

if (fails.length) {
  console.error('✗ 人机隔离哨兵失败：');
  for (const f of fails) console.error('   - ' + f);
  process.exit(1);
}
console.log(`✓ 人机隔离完好：${rel(ENGINE)} 代码零答案标识符、零全局对象、import 面 ${importStmts.length} 条受限；`
  + `${rel(PAGE)} 的 ${pickCalls + learnCalls} 处调用实参均过白名单（botPick ${pickCalls} 处只收 brain，`
  + `botLearn ${learnCalls} 处的猜测来自 botPick、反馈行回溯到 makeGuess(答案, 同一个猜测)）；`
  + `页面不提候选集、${brainCalls.length} 处 createBrain 均吃整份 roster；`
  + `抽谜底时的排除集是数组字面量、每个元素都是直接展开，且真的排除了人机名与本场已用谜底`);
