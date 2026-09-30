#!/usr/bin/env node
// 多人重连 — 「回合状态被自删除」回归验证
//
// ══════════════════════════════════════════════════════════════════════
// 被测 bug（2026-09-22 引入，7e79b3f）
//
//   server/socket/game.js 的 reconnect_room 里有这么一段「迁移」惯用法：
//
//       room.players.delete(foundPid);
//       room.players.set(socket.id, player);
//       if (room._roundPlayers?.has(foundPid)) {
//         room._roundPlayers.set(socket.id, room._roundPlayers.get(foundPid));
//         room._roundPlayers.delete(foundPid);   // ← 当 foundPid === socket.id 时，
//       }                                        //   删掉的正是上一行刚写进去的那条
//
//   foundPid 来自 roomPlayerIndex（playerKey → code）。而**连接时的自动恢复**
//   （:204-207）已经把该玩家挂到自己 socket.id 名下了。浏览器重连后 mount 会再发一次
//   reconnect_room，此刻 foundPid 恰好 === socket.id —— 自删除成立。
//
// 后果（都不是崩溃，是静默失效，所以线上没人报错）：
//   1. reconnectPayload 的 `mine` 变 null → `mine?.alterFlags?.length === ...`
//      读 null 抛异常 → 被 catch → **reconnect_state 永远发不出去** → 棋盘全空
//   2. multi:guess 走到 `const rp = room._roundPlayers?.get(socket.id); if (!rp) return;`
//      → 静默 return，玩家**本回合剩下的时间一次都猜不了**
//
//  这两条都是用户可见的功能丧失，却是「无异常、无日志噪音」的形态，
//  所以本脚本断言的是**行为**（回执到没到），不是日志里有没有 error。
// ══════════════════════════════════════════════════════════════════════
//
// 覆盖：
//   r1 基线：满员开局的回合里，一方猜一次能拿到 guess_result
//   r2 同 pk 第二次连接 → 自动恢复路径给出 existing_room(started=true)
//   r3 **第一次 reconnect_room 必须返回 reconnect_state**（修复前：超时）
//   r4 该 reconnect_state 的 myGuessChain / myColorRows === 已猜次数
//      —— 重连者的本回合进度还在，且 colorRows 行长 = 11（阶段 5 的 artist 槽没丢）
//   r5 重连后**仍能继续猜**（修复前：multi:guess 静默 return）
//   r6 **第二次 reconnect_room 依旧返回 reconnect_state**（幂等；修复前同样超时）
//
// ⚠️ 未接入 scripts/smoke-all.sh（新增文件，不擅自改部署 gate）。
// 纯 socket、无浏览器、无 build 依赖，可直接跑：
//   node tests/multi-reconnect-smoke.mjs

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ROOT, BACKEND_PORT, WAIT_TIMEOUT,
  check, finish, waitFor, makeDbPath, sleep,
  startBackend, killBackend, waitForBackend, cleanupDb,
} from './helpers.mjs';

const DB_PATH = makeDbPath('multi-reconnect');
const ALL_KEYS = ['class', 'subclass', 'faction', 'rarity', 'race', 'gender', 'releaseYear', 'position', 'tags', 'artist'];
/** colorRows 是**定长位置数组**：1 个名字列 + 10 个词条 = 11 槽，artist 固定在下标 10 */
const ROW_LEN = 1 + ALL_KEYS.length;

/** 等一条**新**事件（用长度推进，避免读到上一轮的残留） */
async function waitNew(buf, ev, timeout = WAIT_TIMEOUT) {
  const n = buf[ev].length;
  await waitFor(() => buf[ev].length > n, { timeout, desc: `${ev} 第 ${n + 1} 条` });
  return buf[ev][n];
}

async function main() {
  const chars = JSON.parse(await readFile(join(ROOT, 'src', 'data', 'characters.json'), 'utf8'));
  if (!chars.length) { console.error('❌ characters.json 为空'); return 1; }

  const backend = startBackend({ dbPath: DB_PATH });
  const raw = [];

  try {
    await waitForBackend();
    const { io } = await import('socket.io-client');

    const PK = 'p_reconn' + 'x'.repeat(12);
    const connect = (label, pk) => new Promise((resolve, reject) => {
      const s = io(`http://localhost:${BACKEND_PORT}`, {
        transports: ['websocket'], forceNew: true, auth: { pk },
      });
      s.on('connect', () => resolve(s));
      s.on('connect_error', reject);
      setTimeout(() => reject(new Error(`${label} 连接超时`)), WAIT_TIMEOUT);
    });
    const tap = (s, events) => {
      const buf = {};
      for (const e of events) { buf[e] = []; s.on(e, (d) => buf[e].push(d)); }
      return buf;
    };

    // ══════════════ 建局 ══════════════
    console.log('\n[r1] 基线：正常猜测回环');
    const A = await connect('A', 'p_reconnA' + 'x'.repeat(11));
    const B = await connect('B', PK);
    raw.push(A, B);
    const aBuf = tap(A, ['room_created', 'round_start', 'guess_result', 'round_end', 'error_msg']);
    const bBuf = tap(B, ['round_start', 'guess_result', 'round_end', 'error_msg']);

    // 自定义房 + 15 次上限：一轮里猜不错就不会提前结束回合
    A.emit('create_room', {
      playerName: '重连甲', difficulty: 'easy', bestOf: 5, maxGuesses: 15, attributes: ALL_KEYS,
    });
    await waitFor(() => aBuf.room_created.length >= 1, { desc: 'room_created' });
    const code = aBuf.room_created[0].code;

    B.emit('join_room', { code, playerName: '重连乙' });
    await waitFor(() => bBuf.round_start.length >= 1, { desc: 'B round_start' });

    // 挑一个大概率不是谜底的干员（谜底来自 easy 池，这里从池尾取，命中概率极低）
    const pool = chars.filter((c) => c.popularity === 'hot' || c.rarity >= 6);
    const probe = (n) => chars[chars.length - 1 - n].name;
    const g1 = probe(0);
    B.emit('multi:guess', { name: g1 });
    await waitFor(() => bBuf.guess_result.length >= 1, { desc: 'B guess_result #1' });
    const first = bBuf.guess_result[0];
    check('r1.基线：满员开局后猜测有回执',
      !first.correct && typeof first.guessCount === 'number',
      `guess=${g1} correct=${first.correct} guessCount=${first.guessCount}`);

    // ══════════════ 重连 ══════════════
    console.log('\n[r2-r4] 同 pk 第二次连接 → 重连');
    const B2 = await connect('B2', PK);
    raw.push(B2);
    const b2Buf = tap(B2, ['existing_room', 'reconnect_state', 'round_start', 'guess_result', 'round_end', 'error_msg']);

    const existing = await waitNew(b2Buf, 'existing_room');
    check('r2.自动恢复路径给出 existing_room 且标记已开局',
      existing.code === code && existing.started === true,
      `code=${existing.code} started=${existing.started}`);

    // 浏览器重连后 mount 会做的事：主动再发一次 reconnect_room。
    // ⚠️ 这一步是**触发 bug 的全部条件** —— 自动恢复已把玩家挂到新 socket.id 名下，
    //    所以这里的 foundPid 恰好 === socket.id，自删除成立。
    B2.emit('reconnect_room', { code });
    // 超时不抛出去 —— 让它变成一条失败断言，后面几条才有机会各自报告
    let reState = null;
    try { reState = await waitNew(b2Buf, 'reconnect_state', 8000); } catch { /* 修复前就会走到这里 */ }
    check('r3.第一次 reconnect_room 返回 reconnect_state（修复前此处超时）',
      !!reState, reState ? `收到 ${Object.keys(reState).length} 个字段` : '8000ms 内无 reconnect_state');

    const myRows = Array.isArray(reState?.myColorRows) ? reState.myColorRows : [];
    const myChain = Array.isArray(reState?.myGuessChain) ? reState.myGuessChain : [];
    check('r4.重连者本回合进度完整（chain/colorRows === 1，行长 11 槽含 artist）',
      myChain.length === 1 && myRows.length === 1 && myRows[0]?.length === ROW_LEN,
      `chain=${myChain.length} rows=${myRows.length} 行长=${myRows[0]?.length ?? 'n/a'}（期望 1/1/${ROW_LEN}）`
      + ` row[10]=${JSON.stringify(myRows[0]?.[10])}`);

    // ══════════════ 重连后还能不能玩 ══════════════
    console.log('\n[r5] 重连后仍能继续猜');
    const g2 = probe(1);
    B2.emit('multi:guess', { name: g2 });
    let afterGuess = null;
    try {
      afterGuess = await waitNew(b2Buf, 'guess_result', 5000);
    } catch { /* 超时 → afterGuess 保持 null，下面判失败 */ }
    check('r5.重连后猜测仍有回执（修复前 multi:guess 静默 return）',
      !!afterGuess && afterGuess.guessCount === 2,
      afterGuess ? `guess=${g2} guessCount=${afterGuess.guessCount}（期望 2）` : `guess=${g2} → ${5000}ms 内无 guess_result`);

    // ══════════════ 幂等 ══════════════
    console.log('\n[r6] 第二次 reconnect_room 幂等');
    const B3 = await connect('B3', PK);
    raw.push(B3);
    const b3Buf = tap(B3, ['existing_room', 'reconnect_state', 'error_msg']);
    await waitNew(b3Buf, 'existing_room');
    B3.emit('reconnect_room', { code });
    let re2 = null;
    try { re2 = await waitNew(b3Buf, 'reconnect_state', 8000); } catch { /* 同上 */ }
    check('r6.再次重连仍返回 reconnect_state（可反复重连）',
      !!re2 && (re2.myGuessChain || []).length === 2,
      re2 ? `myGuessChain=${(re2.myGuessChain || []).length}（期望 2）` : '8000ms 内无 reconnect_state');

    await sleep(200);
  } finally {
    for (const s of raw) { try { s.disconnect(); } catch {} }
    killBackend(backend);
    await sleep(300);
    cleanupDb(DB_PATH);
  }
  return 0;
}

const exitCode = await main();
finish(exitCode);
