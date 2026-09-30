/**
 * 词条契约哨兵（前后端 + colorRows 槽位）
 * =======================================
 * 干员词条清单在前后端各有一份（`server/constants.js` 与 `src/lib/party-constants.ts`），
 * 而 `colorRows` 是**定长位置数组** —— 前端 `rowToComparisons` 靠**下标**取值：
 *
 *     row[0]=name, row[1..9]=9 个标准词条, row[10]=artist
 *
 * 于是这三样东西必须同时成立，且**任一处改动都不会报错、只会静默错位**：
 *   1. 两份词条清单逐字同序（不同 → 自己与对手的棋盘两列对调）
 *   2. `artist` 恒在**最后**（插到中间 → 下标 10 不再是 artist）
 *   3. 写入端 `server/socket/game.js` 的行序与读取端 `multiplayer/page.tsx`
 *      的下标表一一对应
 *
 * 这类错位的表现是「格子颜色不对」而不是崩溃，人工 review 极难发现
 * （尤其前后端**分别部署**时，新前端配旧服务端是常规状态），故机器把关。
 *
 * 退出码：0 = 通过；1 = 契约被改坏。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// ⚠️ 必须在**动态 import 之前** chdir：`tests/_ts-load.mjs` 在模块顶层就把
//    SRC_DIR 定死成 `join(process.cwd(), 'src')`，用静态 import 的话它先求值、
//    chdir 已经晚了。chdir 到脚本所在仓库根，哨兵就不再依赖「从哪调用」——
//    与另外两个哨兵（check-characters / check-v12-selector）的约定一致。
process.chdir(ROOT);
const { loadTsModule } = await import('../tests/_ts-load.mjs');

// ── 两侧都按**真实模块**加载，不做正则解析常量（正则会被 `as const` / 换行骗过）──
const serv = await import(pathToFileURL(resolve(ROOT, 'server/constants.js')).href);
const { mod: front, cleanup } = await loadTsModule('src/lib/party-constants.ts');

const S = {
  ATTR_KEYS: serv.ATTR_KEYS,
  OPTIONAL_ATTR_KEYS: serv.OPTIONAL_ATTR_KEYS,
  ALL_ATTR_KEYS: serv.ALL_ATTR_KEYS,
};
const F = {
  ATTR_KEYS: front.PARTY_ATTR_KEYS,
  OPTIONAL_ATTR_KEYS: front.OPTIONAL_ATTR_KEYS,
  ALL_ATTR_KEYS: front.ALL_ATTR_KEYS,
};

// 1. 三份清单逐字同序
for (const k of Object.keys(S)) {
  if (!Array.isArray(S[k]) || !Array.isArray(F[k])) {
    fails.push(`${k} 在某一侧不是数组（server=${typeof S[k]} / front=${typeof F[k]}）`);
  } else if (!eq(S[k], F[k])) {
    fails.push(`${k} 前后端不一致：\n     server = ${JSON.stringify(S[k])}\n     front  = ${JSON.stringify(F[k])}`);
  }
}

// 2. artist 必须恒为**最后一项** —— colorRows 的槽位下标由它决定
const ALL = F.ALL_ATTR_KEYS;
const artistIdx = ALL.indexOf('artist');
if (artistIdx === -1) {
  fails.push('ALL_ATTR_KEYS 里没有 artist（画师列会整列消失，且不报错）');
} else if (artistIdx !== ALL.length - 1) {
  fails.push(`artist 不在 ALL_ATTR_KEYS 末尾（在下标 ${artistIdx}，长度 ${ALL.length}）—— 插在中间会让 row 下标整体错位`);
}
// 标准九项必须原样是 ALL 的前缀：经典房靠这个前缀拿不到画师
if (!eq(ALL.slice(0, F.ATTR_KEYS.length), F.ATTR_KEYS)) {
  fails.push('ALL_ATTR_KEYS 的前 9 项必须逐字等于 PARTY_ATTR_KEYS（否则经典房会渲染出自建房才有的列）');
}
// colorRows 行长 = name 列 + 全部词条列
const ROW_LEN = 1 + ALL.length;

// 3. 读取端：每个 `xxx: s(row?.[n])` 的下标必须与 ALL_ATTR_KEYS 的顺序对齐
const mp = readFileSync(join(ROOT, 'src/app/multiplayer/page.tsx'), 'utf8');
const readerBlock = mp.match(/function rowToComparisons[\s\S]*?\n\}/);
if (!readerBlock) {
  fails.push('src/app/multiplayer/page.tsx 找不到 rowToComparisons（读取端锚点没了，本哨兵需要同步更新）');
} else {
  const pairs = [...readerBlock[0].matchAll(/(\w+):\s*s\(row\?\.\[(\d+)\]\)/g)]
    .map(([, key, idx]) => [key, Number(idx)]);
  if (pairs.length !== ALL.length) {
    fails.push(`rowToComparisons 映射了 ${pairs.length} 项，ALL_ATTR_KEYS 有 ${ALL.length} 项 —— 多一项/少一项都会错位`);
  }
  for (const [key, idx] of pairs) {
    const want = ALL.indexOf(key) + 1; // +1：row[0] 是 name
    if (ALL.indexOf(key) === -1) fails.push(`rowToComparisons 出现了不在 ALL_ATTR_KEYS 里的键：${key}`);
    else if (idx !== want) fails.push(`rowToComparisons 的 ${key} 读了下标 ${idx}，按 ALL_ATTR_KEYS 应为 ${want}`);
  }
  // 行长：多读一位会拿到 undefined（被 s() 兜成 wrong，静默），少读一位等于整列没还原
  const maxIdx = Math.max(...pairs.map(p => p[1]));
  if (maxIdx + 1 !== ROW_LEN) {
    fails.push(`rowToComparisons 最大下标 ${maxIdx} → 按 ${ROW_LEN} 槽的行长应读到 ${ROW_LEN - 1}`);
  }
}

// 4. 写入端：server/socket/game.js 的 row 字面量必须按 ALL_ATTR_KEYS 的顺序、且一项不多不少
const gj = readFileSync(join(ROOT, 'server/socket/game.js'), 'utf8');
const writerBlock = gj.match(/const row = \[[\s\S]*?\n\s*\];/);
if (!writerBlock) {
  fails.push('server/socket/game.js 找不到 `const row = [...]`（写入端锚点没了，本哨兵需要同步更新）');
} else {
  // 按出现顺序取 comparisons.<key>，与 ALL_ATTR_KEYS 逐项比对
  const got = [...writerBlock[0].matchAll(/comparisons\.(\w+)/g)].map(m => m[1]);
  if (!eq(got, ALL)) {
    fails.push(`colorRows 写入顺序与 ALL_ATTR_KEYS 不符：\n     写入 = ${JSON.stringify(got)}\n     应为 = ${JSON.stringify(ALL)}`);
  }
  // 第 11 槽必须是 `?? null` 兜底：房间没开画师时 comparisons 里**没有**这个键，
  // 少了兜底会写进 undefined → 序列化后变成数组空洞 —— 行长仍是 11 但内容不是字符串，
  // 且重连载荷经 JSON 往返后 undefined 会变成 null（前端 s() 兜成 wrong），
  // 两种表示混在一份数据里，排查时极难定位。
  if (!/comparisons\.artist \?\? null/.test(writerBlock[0])) {
    fails.push('colorRows 的 artist 槽没有 `?? null` 兜底（标准房该槽会是 undefined，与 null 两种表示混用）');
  }
}

// 5. 每个词条都要有 i18n 标签、且**两份**语言文件都有 —— 缺一边会在该语言下显示原始键名
//    （label 是动态键 `t(ATTR_LABEL_KEYS[a])`，check-i18n-keys.mjs 的静态扫描覆盖不到，
//      所以这条得由本哨兵兜住）
const labelKeys = front.ATTR_LABEL_KEYS;
const dicts = Object.fromEntries(
  ['zh-CN', 'en'].map(loc => [loc, JSON.parse(readFileSync(join(ROOT, `src/messages/${loc}.json`), 'utf8'))]),
);
for (const k of ALL) {
  const lk = labelKeys[k];
  if (!lk) { fails.push(`ATTR_LABEL_KEYS 缺少词条 ${k} 的映射（该列会渲染成 undefined）`); continue; }
  // releaseYear → table.year 是历史命名（见 party-constants 的注释），这里只校验存在性
  for (const loc of Object.keys(dicts)) {
    if (!(lk in dicts[loc])) fails.push(`${loc}.json 缺少 ${k} 的标签键 ${lk}`);
  }
}
// 反向：映射表里不该留下已不在词条清单里的键（会让人以为还有这一列）
for (const k of Object.keys(labelKeys)) {
  if (!ALL.includes(k)) fails.push(`ATTR_LABEL_KEYS 有孤儿键 ${k}（不在 ALL_ATTR_KEYS 里）`);
}

cleanup();

if (fails.length) {
  console.error('✗ 词条契约哨兵失败：');
  for (const f of fails) console.error('   - ' + f);
  process.exit(1);
}
console.log(`✓ 词条契约完好：前后端 ${ALL.length} 项同序，artist 位于 row[${1 + artistIdx}]，colorRows 行长 ${ROW_LEN}`);
