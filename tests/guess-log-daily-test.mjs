#!/usr/bin/env node
// 每日挑战的 guess_log 落库验证（服务端权威模式 —— 这部分序列由服务器自己记录）
//
// 为什么要单独验：每日挑战的会话 history 只存在内存里，落库只发生一次（猜完/放弃/次数用尽）。
// 写错的话「每日」这一档的样本会永远是 NULL，而且不会有任何报错。
//
// 运行：node tests/guess-log-daily-test.mjs
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  ROOT, BACKEND_PORT, check, finish, makeDbPath, sleep,
  startBackend, killBackend, waitForBackend, cleanupDb,
} from './helpers.mjs';

const DB_PATH = makeDbPath('guess-log-daily');
const BASE = `http://localhost:${BACKEND_PORT}`;
let ipSeq = 0;
const nextIp = () => `10.13.0.${++ipSeq}`;

async function api(path, { method = 'GET', body, ip } = {}) {
  const headers = { 'X-Real-IP': ip || nextIp() };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, data };
}

function dailyRow(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare("SELECT id, guess_count, guess_log, target_name FROM games WHERE mode='daily' ORDER BY id DESC LIMIT 1").get();
  } finally { db.close(); }
}

async function main() {
  const roster = JSON.parse(await readFile(join(ROOT, 'src', 'data', 'characters.json'), 'utf8'));
  const backend = startBackend({ dbPath: DB_PATH });
  try {
    await waitForBackend(BACKEND_PORT);
    const pk = `g_daily_${Math.random().toString(36).slice(2, 8)}`;

    // 连猜 8 个真名（大概率不会猜中当日目标，从而走「次数用尽」落库分支）
    const names = roster.slice(0, 8).map((c) => c.name);
    let last = null;
    for (const name of names) {
      last = await api('/api/daily/guess', { method: 'POST', body: { player_key: pk, name } });
      if (last.data && (last.data.won || last.data.lost)) break;
      await sleep(60);
    }
    // 保险：若还没结束，放弃（giveUp 分支也会落库）
    if (!(last && last.data && (last.data.won || last.data.lost))) {
      last = await api('/api/daily/guess', { method: 'POST', body: { player_key: pk, giveUp: true } });
    }

    const row = dailyRow(DB_PATH);
    check('a1.每日挑战结束会落库一行', !!row, row ? `id=${row.id} target=${row.target_name}` : '库中无 daily 行');
    const stored = row && row.guess_log ? JSON.parse(row.guess_log) : null;
    check('a2.每日的 guess_log 非空（服务端自己记的序列）', Array.isArray(stored) && stored.length > 0,
      `落库=${row && row.guess_log}`);
    check('a3.序列里存的是干员 id（不是名字）', Array.isArray(stored) && stored.every((x) => typeof x === 'string' && roster.some((c) => c.id === x)),
      `样例=${stored && stored.slice(0, 3).join(',')}`);
    check('a4.序列长度与 guess_count 一致', row && Array.isArray(stored) && stored.length === row.guess_count,
      `guess_count=${row && row.guess_count} 序列长度=${stored && stored.length}`);
    return 0;
  } finally {
    await killBackend(backend);
    await sleep(300);
    cleanupDb(DB_PATH);
  }
}

let code = 1;
try { code = await main(); } catch (e) { console.error('❌ 未捕获异常:', e); code = 1; }
finish(code);
