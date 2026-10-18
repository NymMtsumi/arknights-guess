#!/usr/bin/env node
// 猜测序列落库（`games.guess_log`）— API 级验证。
//
// 为什么要有它：这是「用用户数据训练人机」的唯一数据来源，而它**由客户端上报** ——
// 服务端必须做白名单与长度钳制。写坏一次（非法 id 进库、空数组写成 '[]'、超长不截断）
// 不会报任何错，只会静默污染样本库，正是「几个月后才发现训练集有毒」那类坑。
//
// 2026-10-18 起条目带时间：`{ id, t, r }`（t=相对本小局开始的毫秒，r=小局序号）。
// 服务端仍接受旧的纯字符串条目（向后兼容），且对 t/r 做钳制而不是丢弃。
//
// 覆盖：
//   a. 合法条目（id+t+r）原样落库且顺序保持
//   b. 非法元素丢弃；字符串向后兼容；t/r 越界钳制
//   c. 超过 24 条被截断（服务端 MAX_GUESS_LOG）
//   d. 空数组 / 不传 → NULL（不是 '[]'）
//   e. 落库不影响原有列（列序写错的最快症状）
//
// 运行：node tests/guess-log-test.mjs（纯 API 级，不需要 build）
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  ROOT, BACKEND_PORT, check, finish, makeDbPath, sleep,
  startBackend, killBackend, waitForBackend, cleanupDb,
} from './helpers.mjs';

const DB_PATH = makeDbPath('guess-log');
const BASE = `http://localhost:${BACKEND_PORT}`;

let ipSeq = 0;
const nextIp = () => `10.12.0.${++ipSeq}`;
const rnd = () => Math.random().toString(36).slice(2, 10);

async function api(path, { method = 'GET', body, ip } = {}) {
  const headers = { 'X-Real-IP': ip || nextIp() };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, data };
}

/** 直接读临时库，拿到最后一条 games 记录 */
function lastRow(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db.prepare('SELECT id, guess_count, difficulty, mode, guess_log FROM games ORDER BY id DESC LIMIT 1').get();
  } finally {
    db.close();
  }
}

async function main() {
  const roster = JSON.parse(await readFile(join(ROOT, 'src', 'data', 'characters.json'), 'utf8'));
  const ids = roster.map((c) => c.id);
  const pick = (n) => ids.slice(0, n);
  // 单人模式会校验「目标干员必须存在」，所以要用真名（bot 模式才不校验）
  const TARGET = roster[0].name;

  const backend = startBackend({ dbPath: DB_PATH });
  try {
    await waitForBackend(BACKEND_PORT);
    const pk = `g_${rnd()}`;

    // ── a. 合法条目（id + t + r）──
    const seq = pick(4).map((id, i) => ({ id, t: 1200 + i * 5000, r: 0 }));
    let r = await api('/api/save-game', {
      method: 'POST',
      body: { player_key: pk, won: true, guessCount: 4, difficulty: 'hard', targetName: TARGET, mode: 'single', guesses: seq },
    });
    check('a1.带 guesses 的存档返回 200', r.status === 200, JSON.stringify(r.data));
    let row = lastRow(DB_PATH);
    check('a2.合法条目（id+t+r）原样落库且顺序保持', row && row.guess_log === JSON.stringify(seq),
      `库中=${row && row.guess_log}`);

    // ── b. 非法元素丢弃 + 字符串兼容 + 数值钳制 ──
    const s0 = seq[0].id;
    const s1 = seq[1].id;
    r = await api('/api/save-game', {
      method: 'POST',
      body: {
        player_key: pk, won: false, guessCount: 8, difficulty: 'hard', targetName: TARGET, mode: 'single',
        guesses: [
          { id: s0, t: 1000, r: 0 },
          'not-a-real-character-id',              // 不存在的 id → 丢
          42,                                     // 非对象非字符串 → 丢
          { id: '', t: 1, r: 0 },                 // 空 id → 丢
          { id: 'x'.repeat(200), t: 1, r: 0 },    // 超长 id → 丢
          s1,                                     // 旧版纯字符串条目 → 保留原样
          { id: seq[2].id, t: -5, r: -1 },        // t/r 负 → 钳到 0
          { id: seq[3].id, t: 9_999_999, r: 99 }, // t/r 超上限 → 600000 / 20
        ],
      },
    });
    row = lastRow(DB_PATH);
    const expectB = JSON.stringify([
      { id: s0, t: 1000, r: 0 },
      s1,
      { id: seq[2].id, t: 0, r: 0 },
      { id: seq[3].id, t: 600_000, r: 20 },
    ]);
    check('b1.非法条目丢弃 / 字符串兼容 / t·r 越界钳制', row && row.guess_log === expectB,
      `库中=${row && row.guess_log}`);

    // ── c. 超过 24 条被截断 ──
    const many = Array.from({ length: 30 }, (_, i) => ({ id: ids[i % ids.length], t: i * 1000, r: 0 }));
    await api('/api/save-game', {
      method: 'POST',
      body: { player_key: pk, won: false, guessCount: 30, difficulty: 'hard', targetName: TARGET, mode: 'single', guesses: many },
    });
    row = lastRow(DB_PATH);
    const stored = row && row.guess_log ? JSON.parse(row.guess_log) : null;
    check('c1.超过 24 条被截断到 24', Array.isArray(stored) && stored.length === 24,
      `落库长度=${stored && stored.length}`);

    // ── d. 空数组 / 不传 → NULL ──
    await api('/api/save-game', {
      method: 'POST',
      body: { player_key: pk, won: false, guessCount: 2, difficulty: 'hard', targetName: TARGET, mode: 'single', guesses: [] },
    });
    row = lastRow(DB_PATH);
    check('d1.空数组落 NULL（不是 "[]"）', row && row.guess_log === null, `库中=${row && row.guess_log}`);

    await api('/api/save-game', {
      method: 'POST',
      body: { player_key: pk, won: false, guessCount: 2, difficulty: 'hard', targetName: TARGET, mode: 'single' },
    });
    row = lastRow(DB_PATH);
    check('d2.不传 guesses 落 NULL', row && row.guess_log === null, `库中=${row && row.guess_log}`);

    // ── e. 落库不影响原有列（列序写错的最快症状） ──
    await api('/api/save-game', {
      method: 'POST',
      body: {
        player_key: pk, won: true, guessCount: 3, difficulty: 'medium', targetName: TARGET, mode: 'single',
        guesses: pick(3).map((id, i) => ({ id, t: i * 4000, r: 0 })),
      },
    });
    row = lastRow(DB_PATH);
    check('e1.guess_count / difficulty / mode 未被列序写歪',
      row && row.guess_count === 3 && row.difficulty === 'medium' && row.mode === 'single',
      `库中 guess_count=${row && row.guess_count} difficulty=${row && row.difficulty} mode=${row && row.mode}`);

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
