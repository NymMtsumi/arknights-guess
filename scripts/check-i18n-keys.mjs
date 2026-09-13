/**
 * i18n 键哨兵
 * ============
 * 两件事：
 *   1. zh-CN.json 与 en.json 的键集合必须**完全一致**（缺一边 = 该语言下显示原始键名）
 *   2. 报出**没有任何代码引用**的键（死键），以及**引用了但两边都没有**的键（幽灵键）
 *
 * 为什么需要「死键」检查：
 *   死键不报错、不影响运行，只是文本量。但它是**回归的信号**——
 *   删功能时漏删文案，下次有人看到这个键会以为功能还在。
 *   theme.blastWine / theme.blastTeal 就是这么留下的（酒红主题删除后没人发现）。
 *
 * ⚠️ 为什么不能简单地 grep `t('key')`：
 *   仓库里有**间接引用**——键名存在映射表里再传进去，例如
 *     t(tb.label) / t(ATTR_LABEL_KEYS[a]) / t(m.labelKey) / t(`difficulty.${diff}`)
 *   只认 t() 的实参会把它们全判成死键，产出大量假阳性。
 *   所以这里退一步：**扫描 src 下所有「长得像 i18n 键」的字符串字面量**
 *   （含点号、小写字母开头、每段只含字母数字），只要在 src 里出现过就不算死键。
 *   宁可漏报（某个键确实没人用、但它在别处被当普通字符串提过），不可误报。
 *
 * 用法：node scripts/check-i18n-keys.mjs [--verbose]
 * 退出码：0 = 无问题；1 = 键集合不一致 / 有幽灵键
 *         （死键只报告、不判失败 —— 它不影响运行，是否删由人决定）
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const verbose = process.argv.includes('--verbose');

const zh = JSON.parse(readFileSync(join(SRC, 'messages/zh-CN.json'), 'utf8'));
const en = JSON.parse(readFileSync(join(SRC, 'messages/en.json'), 'utf8'));

// ── 1. 键集合一致性 ──────────────────────────────────────────
const zhKeys = Object.keys(zh);
const enKeys = Object.keys(en);
const onlyZh = zhKeys.filter((k) => !(k in en));
const onlyEn = enKeys.filter((k) => !(k in zh));

// ── 2. 收集 src 下所有源码文本 ────────────────────────────────
const walk = (dir) => {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (['.ts', '.tsx', '.js', '.jsx'].includes(extname(p))) out.push(p);
  }
  return out;
};

const files = walk(SRC);
// ⚠️ 不能用「键的形状」去筛字符串字面量 —— 第一版就是这么写的，结果
//    guessCorrect / playAgain / searchHint 这几个**不带点**的键被全判成死键：
//    形状正则要求至少一个 '.'，它们根本进不了 referenced 集合。
//    改为「把所有字符串字面量都收进来」，再拿键去查表 —— 不带点的自然命中。
//    唯一代价是可能漏报（某个键恰好在别处被当普通字符串提过），不会误报。
const referenced = new Set();
for (const f of files) {
  if (f.includes(join('src', 'messages'))) continue;   // 别把 JSON 自己算进去
  const text = readFileSync(f, 'utf8');
  // 单/双引号与不含 ${} 的模板字面量
  for (const m of text.matchAll(/(['"`])((?:[^'"`\\\n]|\\.)*?)\1/g)) referenced.add(m[2]);
  // 模板字面量前缀：t(`difficulty.${diff}`) → 记下 'difficulty.'
  // ⚠️ 前缀必须**非空**。写成 `*?` 时模板 `${x}` 会产出空前缀 ''，
  //    而 isDynamicallyCovered 用的是 key.startsWith(p) —— 任何键都以 '' 开头，
  //    于是全部键都算「被动态覆盖」，死键检查整个变成空转（一次都没报出来）。
  for (const m of text.matchAll(/[`]([A-Za-z0-9._]+?)\$\{/g)) referenced.add('PREFIX:' + m[1]);
}

const prefixes = [...referenced].filter((s) => s.startsWith('PREFIX:')).map((s) => s.slice(7));
const isDynamicallyCovered = (key) => prefixes.some((p) => key.startsWith(p));

const dead = zhKeys.filter((k) => !referenced.has(k) && !isDynamicallyCovered(k));
const ghost = zhKeys.filter((k) => referenced.has(k) && !(k in zh) && !(k in en) && !isDynamicallyCovered(k));

// 「幽灵键」需要扫的字符串不一定长得像键（可能在 t('...') 里），单独再收一遍
const tArgs = new Set();
for (const f of files) {
  if (f.includes(join('src', 'messages'))) continue;
  const text = readFileSync(f, 'utf8');
  for (const m of text.matchAll(/\bt\(\s*['"`]([^'"`$]+)['"`]/g)) tArgs.add(m[1]);
}
const missing = [...tArgs].filter((k) => !(k in zh) && !(k in en) && !isDynamicallyCovered(k));

// ── 3. 输出 ──────────────────────────────────────────────────
// --json：只吐机器可读的结果，给清理脚本消费（免得解析人类可读输出）
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({
    zhKeys: zhKeys.length, enKeys: enKeys.length, onlyZh, onlyEn, dead, missing,
  }));
  process.exit(onlyZh.length || onlyEn.length ? 1 : 0);
}

let fail = false;

if (onlyZh.length || onlyEn.length) {
  fail = true;
  console.error('✗ 两份语言文件的键集合不一致：');
  if (onlyZh.length) console.error(`   仅 zh-CN 有 ${onlyZh.length} 个：${onlyZh.join(', ')}`);
  if (onlyEn.length) console.error(`   仅 en 有 ${onlyEn.length} 个：${onlyEn.join(', ')}`);
} else {
  console.log(`✓ 键集合一致（zh-CN 与 en 各 ${zhKeys.length} 个）`);
}

if (missing.length) {
  fail = true;
  console.error(`✗ t() 里引用了但两份 JSON 都没有的键 ${missing.length} 个：${missing.join(', ')}`);
} else {
  console.log(`✓ t('…') 直接引用的键（${tArgs.size} 个）全部存在`);
}

if (dead.length) {
  console.log(`\n⚠ 疑似死键 ${dead.length} 个（没有任何代码引用；只报告，不判失败）：`);
  for (const k of dead) console.log(`   ${k}   → zh: ${JSON.stringify(zh[k]).slice(0, 50)}`);
} else {
  console.log('✓ 无死键');
}
if (verbose) console.log(`\n（扫描源文件 ${files.length} 个，模板前缀 ${prefixes.length} 个）`);

if (fail) process.exit(1);
