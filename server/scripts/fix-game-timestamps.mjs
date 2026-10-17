#!/usr/bin/env node
// 生产库数据修复：把 `games.timestamp` 里那些「浮点毫秒串 / 秒级 epoch」统一成 ISO 8601。
//
// 背景（2026-10-17 只读核查发现）：全库 57,229 行里有 **260 行**的 timestamp 是
// `"1785872900528.0"` 这种形状 —— 不是 ISO 字符串。后果：
//   · 任何 `WHERE timestamp >= '2026-10-01'` 的字符串比较都会把它们算进/漏出错误的区间；
//   · 时间跨度统计出现 `1970-01-01`（字符串比较把 '1' 排在最前）这类假象；
//   · 将来拿这份数据做训练/分析，时间是错的。
//
// 处理规则（保守，宁可不改也不猜）：
//   · 纯数字且 ≥ 1e12 → 当作**毫秒**时间戳
//   · 纯数字且 < 1e12  → 当作**秒**时间戳（×1000）
//   · 换算后必须落在 [2015-01-01, 现在+1天]，否则**跳过并报告**（不猜它原本是什么时间）
//   · ISO 行一律不动（包括那行 1970-01-01 —— 无法反推真实时间，只报告）
//
// 用法（在服务器上跑，必须显式给库路径）：
//   node fix-game-timestamps.mjs --db /opt/liyiba/data.db            # 试算（默认，不写）
//   node fix-game-timestamps.mjs --db /opt/liyiba/data.db --apply    # 真写（自动备份）
// 备份落在同目录 `data.db.bak-YYYYmmdd-HHMMSS`。
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};
const DB_PATH = argOf('--db');
const APPLY = argv.includes('--apply');
if (!DB_PATH) { console.error('缺少 --db <path>'); process.exit(2); }
if (!existsSync(DB_PATH)) { console.error('库不存在:', DB_PATH); process.exit(2); }

const MIN = Date.UTC(2015, 0, 1);
const MAX = Date.now() + 86_400_000;

function convert(raw) {
  if (typeof raw !== 'string') return { kind: 'skip', why: 'not-string' };
  const t = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return { kind: 'skip', why: 'not-numeric' };
  const n = Number(t);
  if (!Number.isFinite(n)) return { kind: 'skip', why: 'not-finite' };
  const ms = n >= 1e12 ? n : n * 1000;
  if (ms < MIN || ms > MAX) return { kind: 'skip', why: `out-of-range(${new Date(ms).toISOString().slice(0, 10)})` };
  return { kind: 'convert', to: new Date(Math.round(ms)).toISOString() };
}

const db = new Database(DB_PATH, { readonly: !APPLY, fileMustExist: true });
db.pragma('busy_timeout = 5000');

const rows = db.prepare(
  "SELECT id, mode, timestamp FROM games WHERE timestamp IS NOT NULL AND timestamp NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' ORDER BY id",
).all();

const plan = [];
const skipped = [];
for (const r of rows) {
  const res = convert(r.timestamp);
  if (res.kind === 'convert') plan.push({ id: r.id, mode: r.mode, from: r.timestamp, to: res.to });
  else skipped.push({ id: r.id, mode: r.mode, timestamp: r.timestamp, why: res.why });
}

console.log(`库: ${DB_PATH}  模式: ${APPLY ? 'APPLY（会写）' : 'DRY-RUN（不写）'}`);
console.log(`非 ISO 形状的行: ${rows.length}`);
console.log(`  可换算: ${plan.length}`);
console.log(`  跳过:   ${skipped.length}`);
for (const p of plan.slice(0, 5)) console.log(`   ${p.id} ${p.mode}  ${p.from}  →  ${p.to}`);
if (plan.length > 5) console.log(`   … 其余 ${plan.length - 5} 行同理`);
if (skipped.length) {
  console.log('  跳过明细（不猜）：');
  for (const s of skipped.slice(0, 10)) console.log(`   ${s.id} ${s.mode}  ${s.timestamp}  (${s.why})`);
  if (skipped.length > 10) console.log(`   … 其余 ${skipped.length - 10} 行同理`);
}

const bad1970 = db.prepare("SELECT COUNT(*) AS n FROM games WHERE timestamp LIKE '1970-%'").get().n;
console.log(`\nISO 行里落在 1970 的: ${bad1970} 行（无法反推真实时间，只报告、不修改）`);

if (!APPLY) {
  console.log('\n（DRY-RUN 结束，未写入。确认无误后加 --apply）');
  db.close();
  process.exit(0);
}

const backupPath = `${DB_PATH}.bak-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)}`;
db.close();
const src = new Database(DB_PATH, { readonly: true });
await src.backup(backupPath);
src.close();
console.log('\n已备份到:', backupPath);

const wdb = new Database(DB_PATH);
wdb.pragma('busy_timeout = 5000');
const upd = wdb.prepare('UPDATE games SET timestamp = ? WHERE id = ?');
const tx = wdb.transaction((items) => { for (const it of items) upd.run(it.to, it.id); });
const changed = tx(plan);
wdb.close();
console.log(`已写入 ${plan.length} 行（transaction 返回 ${changed}）`);

const check = new Database(DB_PATH, { readonly: true });
const left = check.prepare(
  "SELECT COUNT(*) AS n FROM games WHERE timestamp IS NOT NULL AND timestamp NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*'",
).get().n;
console.log(`复查：剩余非 ISO 形状行 = ${left}（应等于被跳过的 ${skipped.length}）`);
check.close();
