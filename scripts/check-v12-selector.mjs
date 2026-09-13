/**
 * V12 选择器哨兵
 * ===============
 * 断言 src/app/v12.css 里的应用层选择器保持 `html[data-ui="v12"] .ui-v12` 形式。
 *
 * 为什么需要它：
 *   `.ui-v12` 单独用特异性只有 (0,1,0)，与 globals.css 的 `:root` 打平；
 *   而 `@import` 必须位于文件顶部 → v12.css 在 globals.css 之后 →
 *   特异性打平时后出现的输 → 整块变量重绑**静默失效**，不报任何错。
 *   这是最容易被 review 当成「冗余前缀」简化掉的一行，故机器把关。
 *
 * 退出码：0 = 正常；1 = 被改坏。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const V12 = join(ROOT, 'src/app/v12.css');
const GLOBALS = join(ROOT, 'src/app/globals.css');
const LAYOUT = join(ROOT, 'src/app/layout.tsx');

const REQUIRED_SELECTOR = 'html[data-ui="v12"] .ui-v12';
const fails = [];

const v12 = readFileSync(V12, 'utf8');

// 1. 应用层选择器必须存在且带 html[...] 前缀
if (!v12.includes(REQUIRED_SELECTOR)) {
  fails.push(`v12.css 缺少选择器：${REQUIRED_SELECTOR}`);
}

// 2. 除必需的那个之外，不得再出现 .ui-v12 选择器
//    （注释里提到不算，故先剥注释；再把合法选择器摘掉，剩下的一律视为裸选择器）
const stripped = v12.replace(/\/\*[\s\S]*?\*\//g, '');
const leftovers = stripped.split(REQUIRED_SELECTOR).join('').match(/\.ui-v12\b/g);
if (leftovers) {
  fails.push(`v12.css 出现裸 .ui-v12 选择器 ${leftovers.length} 处（特异性不足，会静默失效）`);
}

// 3. @import 必须紧跟 globals.css 首行，否则 PostCSS 会丢弃
const globals = readFileSync(GLOBALS, 'utf8').split(/\r?\n/);
if (globals[0].trim() !== '@import "tailwindcss";' || globals[1].trim() !== '@import "./v12.css";') {
  fails.push('globals.css 前两行应为 @import "tailwindcss"; 与 @import "./v12.css";');
}

// 4. data-ui 必须是 <html> 上的**字面量**，且**不能**由脚本设置。
//    （反过来了：早先由 theme-init 脚本设置，而 next/script 在静态导出里只是
//      往 __next_s 队列塞字符串，执行在首帧之后 → 首帧落回旧 UI →
//      用户看到「新 UI 闪一下变回旧 UI」。字面量从第一个字节就成立，无此窗口。）
const layout = readFileSync(LAYOUT, 'utf8');
const htmlTag = layout.match(/<html\b[^>]*>/);
if (!htmlTag || !/\bdata-ui="v12"/.test(htmlTag[0])) {
  fails.push('layout.tsx 的 <html> 必须带字面量 data-ui="v12" —— 交给脚本设置会在首帧前失效');
}
if (/dataset\.ui\s*=/.test(layout)) {
  fails.push('layout.tsx 不应再用脚本设置 data-ui（脚本执行晚于首帧，会复现闪动）');
}

// 5. 全站表面层（第 5 节）：覆盖 --bg/--card/--text* 的每个暗色块都必须是 (0,2,1)。
//    只写 html[data-ui="v12"] 的话特异性是 (0,1,1)，与 globals.css 的
//    html[data-theme="blast"] 打平 → globals 后置胜出 → 暗色令牌整块失效。
//    每个暗色主题都要有显式块，漏一个不报错、只是那个主题不生效。
// ⚠️ 不能只判断「字符串在文件里出现过」：第 5.4 节的光晕环选择器列表里也有这两个
//    选择器名，只是不带 --border 声明。用 includes 会把它当成「块还在」而漏检。
//    必须要求匹配到一个**真的声明了 --border 的块**。
for (const theme of ['blast']) {
  const sel = `html[data-ui="v12"][data-theme="${theme}"]`;
  const blocks = [...stripped.matchAll(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g'))];
  if (!blocks.some(b => /--border\s*:/.test(b[1]))) {
    fails.push(`v12.css 缺少定义表面令牌的暗色块：${sel}（缺了会让 "${theme}" 主题回退到浅色令牌）`);
  }
}

// 6. @supports 里的 --shadow-lg 光晕环必须把每个主题都列进选择器列表。
//    5.2 的 (0,2,1) 高于单个 html[data-ui="v12"] 的 (0,1,1)，
//    只写基选择器时浅色有环、暗色没环 —— 静默的半失效。
//    （这条是实测产物 CSS 才发现的，不是推出来的。）
// ⚠️ 文件里有**两个** @supports(color-mix) 块（第 1 节的 --mc-soft 与第 5.4 节的光晕环），
//    用不带 /g 的 match 只会拿到第一个 —— 那样这条检查会「通过」却什么都没验。
//    必须遍历全部块，挑出含 --shadow-lg 的那个。
// ⚠️ 条件里含**嵌套括号**（color-mix(in srgb, …)），所以不能用 \([^)]*\) 这种写法：
//    它会在内层 ')' 处停下，导致整条正则匹配不上、检查恒失败。
//    改用 [^{]* 一路吃到第一个 '{'，只要求条件里没有花括号（CSS 条件确实不会有）。
const supportsBlocks = [...stripped.matchAll(/@supports[^{]*\{([\s\S]*?)\n\}/g)];
const ringBlock = supportsBlocks.find(b => b[1].includes('--shadow-lg'));
if (!ringBlock) {
  fails.push('v12.css 找不到 @supports(color-mix) 光晕环块（--shadow-lg 的环定义）');
} else {
  for (const sel of ['html[data-ui="v12"]', 'html[data-ui="v12"][data-theme="blast"]']) {
    if (!ringBlock[1].includes(sel)) fails.push(`光晕环的选择器列表漏了：${sel}（该主题将没有环）`);
  }
}

// 7. theme-init 必须与 use-theme.ts 的 getStoredTheme() 对齐 —— 否则会闪错主题。
//    最容易漏的是**已删除主题的遗留存值**：老用户 localStorage 里可能还是
//    'blast-wine'，theme-init 若不认它，两个分支都不匹配 → 落到媒体查询 →
//    系统偏好浅色的人每次加载都会先闪一下白（use-theme.ts 里也保留了同一条归并分支，
//    两边必须同时改，这条断言就是防止只改一边）。
// 用带引号的精确读法，不用裸子串 —— 裸子串会被 'ui-theme-DISABLED' 这类改动骗过
if (!/getItem\('ui-theme'\)/.test(layout)) {
  fails.push("layout.tsx 的 theme-init 未读取 ui-theme —— 主题会退化成跟随系统偏好");
}
if (!/s==='blast'\|\|s==='blast-wine'/.test(layout)) {
  fails.push("layout.tsx 的 theme-init 未把遗留值 'blast-wine' 归并到 blast —— 老用户每次加载会先闪白");
}
if (!/t==='light'\?'#f3f0ea':'#0c1517'/.test(layout)) {
  fails.push("layout.tsx 的 theme-init 未按主题设置 <html> 底色（浅色 #f3f0ea / 暗色 #0c1517）");
}
// ui-dark-variant 是随酒红主题一起删除的死键：再读它说明改动没做干净
// （读了也不会错，但会让人以为还存在第二套暗色变体）。
if (/getItem\('ui-dark-variant'\)/.test(layout)) {
  fails.push("layout.tsx 的 theme-init 仍在读 ui-dark-variant —— 该键已随酒红主题删除");
}

if (fails.length) {
  console.error('✗ V12 选择器哨兵失败：');
  for (const f of fails) console.error('   - ' + f);
  process.exit(1);
}
console.log('✓ V12 选择器哨兵通过：应用层选择器、表面层特异性、@import 位置与首帧主题均完好');
