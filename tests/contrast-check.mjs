/* 主题对比度回归：实心按钮 = background:var(--primary) + color:var(--bg)。
   直接解析 globals.css 里的真实令牌值，避免手算和文档漂移。
   运行：node tests/contrast-check.mjs   （AA 正文阈值 4.5:1） */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// 可选参数覆盖被测文件，便于对拍「改动前后」而不必真的去改源码
const target = process.argv[2] || join(root, 'src/app/globals.css');
const css = readFileSync(target, 'utf8');

const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const lum = h => {
  const r = parseInt(h.slice(1, 3), 16), g = parseInt(h.slice(3, 5), 16), b = parseInt(h.slice(5, 7), 16);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (a, b) => {
  const l1 = lum(a), l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

// 取选择器后面第一个 {...} 块，抽出 --bg / --primary
function tokens(selector) {
  const i = css.indexOf(selector);
  if (i < 0) return null;
  const open = css.indexOf('{', i);
  const close = css.indexOf('}', open);
  const body = css.slice(open, close);
  const get = name => {
    const m = body.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
    return m ? m[1] : null;
  };
  return { bg: get('bg'), primary: get('primary') };
}

const THEMES = [
  ['浅色 Light', ':root {'],
  ['Blast', 'html[data-theme="blast"] {'],
];

const AA = 4.5;
let failures = 0;

for (const [name, selector] of THEMES) {
  const tk = tokens(selector);
  if (!tk || !tk.bg || !tk.primary) {
    console.log(`✗ ${name.padEnd(12)} 解析不到令牌 (${selector}) — 断言无效，按失败计`);
    failures++;
    continue;
  }
  const cr = contrast(tk.bg, tk.primary);
  const ok = cr >= AA;
  if (!ok) failures++;
  console.log(
    `${ok ? '✓' : '✗'} ${name.padEnd(12)} --bg=${tk.bg}  --primary=${tk.primary}  ` +
    `按钮文字对比度 ${cr.toFixed(2)}:1  ${ok ? '≥ AA' : `< ${AA} 不达标`}`
  );
}

// --primary 反过来当文字用在 --bg 上，浅色主题同样要过
const rootTk = tokens(':root {');
if (rootTk) {
  const cr = contrast(rootTk.primary, rootTk.bg);
  const ok = cr >= AA;
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} 浅色 --primary 作为文字 on --bg  对比度 ${cr.toFixed(2)}:1`);
}

console.log('');
if (failures) {
  console.log(`✗ ${failures} 项未达标`);
  process.exit(1);
}
console.log('✓ 全部主题按钮对比度达标 (WCAG AA 4.5:1)');
