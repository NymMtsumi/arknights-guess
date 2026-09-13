/**
 * 排序白名单校验证
 * ================
 * 目的：证明 admin.js 里每个 parseSort 白名单的**每个列表达式**都是合法 SQL，
 *      并且整条 ORDER BY 在真实 schema 上跑得通。
 *
 * 为什么需要它：白名单里的列名写错（`created_at` 写成 `creatd_at`、
 * 聚合别名 `totalGames` 写成 `totalgames`）不会在编辑时暴露，也不会在页面
 * 加载时暴露 —— 只有管理员**点了那一列的表头**才会 500。这是典型的
 * 「静默到被点击才炸」，值得一个专门的探针。
 *
 * 做法：白名单从 admin.js **源码里抽**，不在这里重抄一份。
 *      重抄一份的话，源码改了测试不会跟着改，测试就变成了自说自话。
 *
 * 用法：node tests/sort-whitelist-check.mjs
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initSchema } from '../server/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, '..', 'server', 'routes', 'admin.js'), 'utf8');

/* 每个端点：白名单变量名 → 该端点真实的 FROM/WHERE 上下文。
   上下文必须与 admin.js 里的查询一致，否则测的不是同一条 SQL。 */
const CONTEXTS = {
  users: {
    // SELECT ... FROM users WHERE 1=1   [ORDER BY {{}} , id DESC] LIMIT ? OFFSET ?
    query: (order) =>
      `SELECT id, username, display_id, nickname, email, email_verified_at, role, banned_at, created_at
       FROM users WHERE 1=1 ORDER BY ${order}, id DESC LIMIT ? OFFSET ?`,
  },
  guests: {
    // GROUP BY 之后才能引用聚合别名，所以这里必须带上 GROUP BY
    query: (order) =>
      `SELECT g.player_key, COUNT(*) as totalGames, SUM(g.won) as wins, MAX(g.timestamp) as lastSeen
       FROM games g WHERE g.user_id IS NULL
       GROUP BY g.player_key ORDER BY ${order} LIMIT ? OFFSET ?`,
  },
  audit: {
    query: (order) =>
      `SELECT a.id, a.action, a.target_type, a.target_id, a.detail, a.ip, a.created_at,
              COALESCE(u.nickname, u.username) as admin_name
       FROM admin_actions a LEFT JOIN users u ON u.id = a.admin_id
       WHERE 1=1 ORDER BY ${order}, a.id DESC LIMIT ? OFFSET ?`,
  },
};

/**
 * 从 admin.js 抽出一个端点附近的 parseSort 白名单字面量。
 * 用「端点函数名 → 下一个 parseSort 调用」定位，顺序敏感但源码里就是这个顺序。
 */
function extractWhitelist(anchor, nextAnchor) {
  const start = SRC.indexOf(anchor);
  if (start < 0) throw new Error(`找不到锚点：${anchor}`);
  const end = nextAnchor ? SRC.indexOf(nextAnchor, start) : SRC.length;
  const seg = SRC.slice(start, end);
  const m = seg.match(/parseSort\(\s*urlObj\s*,\s*\{([\s\S]*?)\}\s*,\s*'([^']+)'\s*\)/);
  if (!m) throw new Error(`在 ${anchor} 之后找不到 parseSort(...)`);
  /* 白名单字面量是**一行多对**（`username: 'a', email: 'b',`），
     所以不能按行匹配 —— 直接全局扫 key: 'value' 对。 */
  const entries = {};
  for (const mm of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*:\s*'([^']*)'/g)) entries[mm[1]] = mm[2];
  return { entries, defaultExpr: m[2] };
}

const EXTRACT = {
  users: extractWhitelist('async function handleAdminUsers', 'async function handleBanUser'),
  guests: extractWhitelist('async function handleAdminGuests', 'async function handleAdminOnline'),
  audit: extractWhitelist('async function handleAuditLog', 'return {\n    handleDashboard'),
};

/* 干员列表是内存排序，不走 SQL —— 单独校验它的白名单键在数据里真的存在 */
const charSeg = SRC.slice(
  SRC.indexOf('async function handleAdminCharacters'),
  SRC.indexOf('async function handleImportCharacters') > 0
    ? SRC.indexOf('async function handleImportCharacters')
    : SRC.length,
);
const charM = charSeg.match(/parseSort\(\s*urlObj\s*,\s*\{([\s\S]*?)\}\s*,\s*'([^']+)'\s*\)/);
const charKeys = charM
  ? [...charM[1].matchAll(/([A-Za-z_$][\w$]*)\s*:\s*'([^']*)'/g)].map((m) => m[2])
  : [];

/* ── 造库 ───────────────────────────────────────────────── */
const db = new Database(':memory:');
initSchema(db);

// 灌一点数据，确保 ORDER BY 真的排序而不是在空表上「成功」
db.prepare("INSERT INTO users (username, password_hash, email, email_verified_at, role, banned_at, created_at) VALUES (?,?,?,?,?,?,?)")
  .run('b_user', 'x', 'b@example.com', null, 'user', null, '2024-01-02 00:00:00');
db.prepare("INSERT INTO users (username, password_hash, email, email_verified_at, role, banned_at, created_at) VALUES (?,?,?,?,?,?,?)")
  .run('a_user', 'x', 'a@example.com', '2024-01-01 00:00:00', 'admin', '2024-02-01 00:00:00', '2024-01-01 00:00:00');
db.prepare("INSERT INTO games (player_key, won, target_name, user_id, timestamp) VALUES (?,?,?,?,?)")
  .run('pk_bbb', 1, '凯尔希', null, '2024-03-01 00:00:00');
db.prepare("INSERT INTO games (player_key, won, target_name, user_id, timestamp) VALUES (?,?,?,?,?)")
  .run('pk_aaa', 0, '银灰', null, '2024-03-02 00:00:00');
db.prepare("INSERT INTO admin_actions (admin_id, action, target_type, target_id, detail, ip, created_at) VALUES (?,?,?,?,?,?,?)")
  .run(1, 'ban_user', 'user', '3', 'd', '10.0.0.2', '2024-04-01 00:00:00');
db.prepare("INSERT INTO admin_actions (admin_id, action, target_type, target_id, detail, ip, created_at) VALUES (?,?,?,?,?,?,?)")
  .run(2, 'create_token', 'api_token', '1', 'd', '10.0.0.1', '2024-04-02 00:00:00');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  → ' + detail : ''}`); }
};

console.log('\n════ 排序白名单校验 ════\n');
for (const [name, ctx] of Object.entries(CONTEXTS)) {
  const { entries, defaultExpr } = EXTRACT[name];
  const keys = Object.keys(entries);
  console.log(`${name}：${keys.length} 个可排序列（默认 ${defaultExpr}）`);
  for (const [key, expr] of Object.entries(entries)) {
    for (const dir of ['ASC', 'DESC']) {
      const order = `${expr} ${dir}`;
      let err = null, rows = null;
      try { rows = db.prepare(ctx.query(order)).all(10, 0); } catch (e) { err = e.message; }
      ok(`${name}.${key} (${dir}) → ${expr}`, !err,
        err || (rows ? '' : '返回空'));
    }
  }
  // 默认排序也必须可执行，否则不带 sort 参数的**首次加载**就 500
  let defErr = null;
  try { db.prepare(ctx.query(`${defaultExpr} DESC`)).all(10, 0); } catch (e) { defErr = e.message; }
  ok(`${name} 默认排序 ${defaultExpr} 可执行`, !defErr, defErr || '');
}

console.log(`\n干员（内存排序）：${charKeys.length} 个可排序列`);
const chars = JSON.parse(readFileSync(join(__dirname, '..', 'server', 'characters.json'), 'utf8'));
const sample = Array.isArray(chars) ? chars : (chars.characters || []);
for (const k of charKeys) {
  // 白名单键必须真的是数据里的字段，否则排序比较器全程拿到 undefined
  const present = sample.filter((c) => c[k] !== undefined).length;
  ok(`干员字段 ${k} 存在于数据中`, present > 0, `${present}/${sample.length} 条有该字段`);
}
// 名字升序默认值也要能排
if (charKeys.length) {
  const sorted = [...sample].sort((a, b) =>
    String(a.name ?? '').localeCompare(String(b.name ?? ''), 'zh-Hans-CN'));
  ok('干员按 name 升序排序不抛错', sorted.length === sample.length, `${sorted.length} 条`);
}

/* ── 注入防护：这是本文件存在的主要理由 ───────────────────
   parseSort 是**唯一**把请求参数拼进 SQL 的地方。逐条试着用恶意 sort/dir
   把它顶穿，确认输出**永远**是白名单里的字面量，绝不回显输入。 */
console.log('\n注入防护（parseSort 实测）');
const { parseSort } = await import('../server/routes/admin.js');

const WL = { name: 'name', created: 'created_at' };
const asUrl = (qs) => new URL('http://x/?' + qs);

const MALICIOUS = [
  "name; DROP TABLE users--",
  "name' OR '1'='1",
  "created_at) UNION SELECT password_hash FROM users--",
  "__proto__",
  "constructor",
  "toString",
  "hasOwnProperty",
  "valueOf",
  "",                 // 空
  "NAME",             // 大小写不匹配
  "name ",            // 尾随空格
];
for (const evil of MALICIOUS) {
  for (const dir of ["asc", "desc", "ASC; DROP TABLE users--", "1"]) {
    const { expr, dir: d } = parseSort(asUrl(`sort=${encodeURIComponent(evil)}&dir=${encodeURIComponent(dir)}`), WL, 'created_at');
    const clean = (expr === 'name' || expr === 'created_at') && (d === 'ASC' || d === 'DESC');
    ok(`sort=${JSON.stringify(evil)} dir=${JSON.stringify(dir)} → ${expr} ${d}`, clean,
      clean ? '' : `回显了输入！expr=${expr} dir=${d}`);
  }
}

// 正例：白名单命中必须真的生效，否则「安全」只是因为什么都不认
{
  const r1 = parseSort(asUrl('sort=name&dir=asc'), WL, 'created_at');
  ok('白名单命中生效（sort=name&dir=asc）', r1.expr === 'name' && r1.dir === 'ASC', `${r1.expr} ${r1.dir}`);
  const r2 = parseSort(asUrl('sort=nope&dir=asc'), WL, 'created_at');
  ok('未命中回退默认（sort=nope）', r2.expr === 'created_at', `${r2.expr} ${r2.dir}`);
  // dir 只认 asc，其余一律 DESC —— 'ASC' 大写不该通过
  const r3 = parseSort(asUrl('sort=name&dir=ASC'), WL, 'created_at');
  ok('dir 只认小写 asc，其余归 DESC', r3.dir === 'DESC', r3.dir);
}

db.close();
console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass}/${pass + fail} 通过\n`);
process.exit(fail === 0 ? 0 : 1);
