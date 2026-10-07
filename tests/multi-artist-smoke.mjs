#!/usr/bin/env node
// 多人自建房「画师」词条 — 槽位 / UI / 重连验证（plan 阶段 5）
//
// 这一段改动碰的是 colorRows —— 一个**定长位置数组**，同时喂三处：
// 前端的 rowToComparisons（重连）、发给对手的 opponent_update、以及自己的 myColorRows。
// 不变量 #2 要求只能**末尾追加**，本脚本就是把这条不变量钉死。
//
// 覆盖：
//   a. 服务端槽位（两个裸 socket 客户端，**确定性、不依赖巧合**）
//      a1 自定义房白名单放行 artist
//      a2 colorRows 行长 = 11（扩槽成功）
//      a3 row[10] === guess_result.comparisons.artist  ← 逐条比对
//      a4 row[1..9] 与 9 个标准键逐一相等            ← 证明前 10 槽语义未被扰动
//      a5 row[0] === (correct ? 'correct' : 'wrong')
//      a6 标准房（不传 attributes）不暴露 artist，但行结构同样是 11 槽
//   b. UI 自己棋盘 + 重连（浏览器建房、裸客户端进房）
//      b1 自建房表头 11 列、末列为「画师」；每行 11 个 gcell（1 名字 + 10 词条）
//      b2 刷新后表头与**全部单元格颜色**与刷新前逐字节相同
//         —— b2 是 rowToComparisons 的确定性探针：漏掉 artist 那行，
//            重连后画师格会渲染成空 <td>（GuessTable.tsx:186 的 return null），
//            每行 gcell 从 11 掉到 10。
//   c. UI 对手棋盘对位 + 命中行搜寻（裸客户端猜、浏览器看）
//      c1 对手棋盘表头 11 列、末列为「画师」，每行 11 个点
//      c2 每个点的颜色 === 服务端下发的 row 对应槽位
//      c3 **命中行**：artist 为 correct 的那一行，画师点必须是 d-ok
//
// ⚠️ 为什么 c3 需要"搜寻"而不是直接构造：
//    这段代码历史上出过的 bug 是 displayCols 用 ATTR_KEYS 查下标 →
//    indexOf('artist') === -1 → dataIdx = 0 → 画师列去读**名字列**的颜色。
//    而名字列只在猜中时才是 'correct'，所以那个 bug 的输出是
//    「画师点 = 名字点」——**它是正确输出的子集**（绝大多数猜测两边都是 wrong）。
//    只有当 artist 恰好命中时，正确实现给 d-ok、bug 给 d-no，才分得开。
//    单次猜测命中率约 2%，所以这里按「大画师组」挑猜测对象来抬命中率，
//    跑不到命中就**显式判 INCONCLUSIVE**（计入失败），绝不静默通过。
//
// ⚠️ 有效探针 = 「artist 命中 **且名字未中**」。**猜中答案的那一行不算**：
//    那种行的名字列本来就是 correct（两列同时 d-ok），正确实现与 bug 的输出完全重合，
//    它既证伪不了什么，也不该断言「名字点 = d-no」——
//    2026-10-07 实测因此**假红过一次**（日志：`第 1 回合：猜 1 次，累计核对 1 行`，
//    而内层只有 `if (r.correct)` 会 break → 那一猜就是答案本身）。
//    所以答案恰好落在 hunt 名单里时，本轮按「无效」处理、继续下一回合，不当失败。
//
// ⚠️ 未接入 scripts/smoke-all.sh（新增文件，不擅自改部署 gate）。
// 手动运行：需要先 npm run build
//   NODE_OPTIONS="--require ./tests/_dns-preload.cjs" node tests/multi-artist-smoke.mjs

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ROOT, BACKEND_PORT, FRONTEND_ORIGIN, WAIT_TIMEOUT,
  check, finish, waitFor, makeDbPath, sleep,
  startStaticServer, startBackend, killBackend, waitForBackend, cleanupDb,
  requireBuild, requirePlaywright, newZhContext,
} from './helpers.mjs';

const DB_PATH = makeDbPath('multi-artist');

const STANDARD_KEYS = ['class', 'subclass', 'faction', 'rarity', 'race', 'gender', 'releaseYear', 'position', 'tags'];
const ALL_KEYS = [...STANDARD_KEYS, 'artist'];

/** 状态 → GuessTable 的类名（GuessTable.tsx:23-27） */
const GC = { correct: 'ok', close: 'warn', wrong: 'no' };
/** 状态 → 对手棋盘圆点的类名（multiplayer/page.tsx:962） */
const DOT = { correct: 'd-ok', close: 'd-cl', wrong: 'd-no' };

async function main() {
  if (!requireBuild()) return 1;
  const chromium = await requirePlaywright();
  if (!chromium) return 1;

  const chars = JSON.parse(await readFile(join(ROOT, 'src', 'data', 'characters.json'), 'utf8'));
  const knownName = chars[0]?.name;
  if (!knownName) { console.error('❌ characters.json 为空'); return 1; }

  const backend = startBackend({ dbPath: DB_PATH });
  let staticServer = null;
  let browser = null;
  const raw = [];

  try {
    await waitForBackend();
    staticServer = await startStaticServer();
    browser = await chromium.launch({ headless: true });

    const { io } = await import('socket.io-client');
    const conn = (label) => new Promise((resolve, reject) => {
      const s = io(`http://localhost:${BACKEND_PORT}`, {
        transports: ['websocket'], forceNew: true,
        auth: { pk: `p_artist${label}${'x'.repeat(10)}` },
      });
      s.on('connect', () => resolve(s));
      s.on('connect_error', reject);
      setTimeout(() => reject(new Error(`${label} 连接超时`)), WAIT_TIMEOUT);
    });
    const connect = async (label) => { const s = await conn(label); raw.push(s); return s; };
    const tap = (s, events) => { const buf = {}; for (const e of events) { buf[e] = []; s.on(e, (d) => buf[e].push(d)); } return buf; };
    const waitLen = (buf, ev, n) => waitFor(() => (buf[ev]?.length || 0) >= n, { desc: `${ev} 第 ${n} 条` });

    const createRoom = async (s, buf, payload) => {
      s.emit('create_room', payload);
      await waitLen(buf, 'room_created', 1);
      return buf.room_created[0];
    };
    const joinRoom = async (s, buf, code, playerName) => {
      s.emit('join_room', { code, playerName: playerName || undefined });
      await waitLen(buf, 'round_start', 1);
    };
    /**
     * 猜一个干员并等回执。返回 guess_result 载荷；**返回 null = 本回合已结算、服务端不再受理**。
     *
     * 🔴 必须能返回 null，不能无条件等 guess_result —— 服务端在**多条路径上静默丢弃**猜测：
     *      · `server/socket/game.js:411`  `if (!room || room.finished || room.roundSettled) return;`
     *        （回合计时到点 / 有人猜中 / 有人放弃 → roundSettled，见 `:53-61` 的 roundTime 分支）
     *      · `:425`  `if (rp.guessed || rp.exhausted) return;`
     *    两处都是直接 return，**既不发 guess_result 也不发 error_msg**。原先这里无条件等
     *    guess_result：一旦回合在循环中途结算，之后每一次猜测都要空等满 WAIT_TIMEOUT 再抛错，
     *    整个套件红掉 —— 而它现在挂在**部署 gate** 上。CI runner 比本机慢，实测撞到过。
     *
     *    ⚠️ 这是**测试侧的缺陷，不是产品缺陷**：丢弃晚到的猜测是服务端**正确**行为，
     *       `:424` 的注释写明了理由（防绕过 maxGuesses 的恶意续猜）。
     *       修的是「测试没料到回合会提前结算」，不是「服务端不该丢」。
     *
     *    判定用「round_end 计数是否增长」而不是「猜中了没」：回合可能因**对手放弃**或
     *    **本回合耗尽**而结算，那两种情况跟猜没猜中无关。没 tap round_end 的房间恒为 0 次，
     *    退化成原来的行为。
     *
     *    真超时（两条都不来）仍然抛错 —— 不把「后端挂了」伪装成「回合结算了」。
     */
    const guess = async (s, buf, name) => {
      const n = buf.guess_result.length;
      const ended = buf.round_end?.length || 0;
      s.emit('multi:guess', { name });
      const ok = await waitFor(
        () => buf.guess_result.length > n || (buf.round_end?.length || 0) > ended,
        { desc: `guess_result 第 ${n + 1} 条` },
      ).then(() => true).catch(() => false);
      if (!ok) throw new Error(`timeout (guess_result 第 ${n + 1} 条)`);
      return buf.guess_result.length > n ? buf.guess_result[n] : null;
    };

    /** 按「大画师组」挑猜测对象 —— 抬高 artist 命中的概率，见文件头 c3 的说明 */
    const huntGuesses = (difficulty, count) => {
      const pool = difficulty === 'easy'
        ? chars.filter((c) => c.popularity === 'hot' || c.rarity >= 6)
        : chars;
      const by = new Map();
      for (const c of pool) {
        if (!by.has(c.artist)) by.set(c.artist, []);
        by.get(c.artist).push(c);
      }
      const groups = [...by.values()].sort((a, b) => b.length - a.length);
      const picked = groups.slice(0, count).map((g) => g[0]);
      const cover = groups.slice(0, count).reduce((s, g) => s + g.length, 0);
      return { names: picked.map((c) => c.name), cover, pool: pool.length };
    };

    // ══════════════ a. 服务端槽位（裸客户端对，确定性） ══════════════
    console.log('\n[a] 服务端 colorRows 槽位');
    const A = await connect('A');
    const B = await connect('B');
    const aBuf = tap(A, ['room_created', 'guess_result', 'round_start', 'round_end', 'error_msg']);
    const bBuf = tap(B, ['opponent_update', 'round_start', 'round_end', 'error_msg']);

    const created = await createRoom(A, aBuf, {
      playerName: '画家甲', difficulty: 'easy', bestOf: 5, maxGuesses: 15, attributes: ALL_KEYS,
    });
    const attrs = Array.isArray(created.attributes) ? created.attributes : [];
    check('a1.自定义房白名单放行 artist',
      created.custom === true && attrs.includes('artist') && attrs.length === ALL_KEYS.length,
      `custom=${created.custom} attributes=[${attrs.join(',')}]`);

    await joinRoom(B, bBuf, created.code, '画家乙');

    // 15 次猜测（= maxGuesses），逐条比对两个客户端收到的载荷
    const nGuesses = Math.min(15, guessCountOf(created));
    for (const nm of huntGuesses('easy', nGuesses).names) {
      const r = await guess(A, aBuf, nm);
      if (!r || r.correct) break; // null = 回合已结算；猜中也结算，两者都不再受理
    }
    await sleep(300); // 让 opponent_update 落定

    const comps = aBuf.guess_result;
    const rows = bBuf.opponent_update.at(-1)?.allComparisons || [];
    check('a.样本覆盖（猜测数 > 0）', comps.length > 0, `猜测 ${comps.length} 次`);

    check('a2.colorRows 行长 = 11（扩槽成功）',
      rows.length > 0 && rows.every((r) => r.length === 11),
      `行长=[${rows.map((r) => r.length).join(',')}]`);

    const slot10 = rows.map((r, i) => r[10] === comps[i]?.comparisons?.artist);
    check('a3.row[10] === comparisons.artist（逐条）',
      slot10.length > 0 && slot10.every(Boolean),
      `${slot10.filter(Boolean).length}/${slot10.length} 相符；row[10]=[${rows.map((r) => r[10]).join(',')}] artist=[${comps.map((c) => c.comparisons.artist).join(',')}]`);

    const misStd = [];
    rows.forEach((r, i) => {
      STANDARD_KEYS.forEach((k, j) => {
        if (r[j + 1] !== comps[i].comparisons[k]) misStd.push(`#${i}.${k}: row=${r[j + 1]} cmp=${comps[i].comparisons[k]}`);
      });
    });
    check('a4.row[1..9] 与 9 个标准键逐一相等（前 10 槽语义未扰动）',
      misStd.length === 0, misStd.length ? misStd.slice(0, 3).join(' | ') : '全部相符');

    const misName = rows.map((r, i) => r[0] === (comps[i].correct ? 'correct' : 'wrong')).filter(Boolean).length;
    check('a5.row[0] = 名字列（correct/wrong）', misName === rows.length, `${misName}/${rows.length}`);

    // ── a6. 标准房：不传 attributes ──
    const C1 = await connect('C1');
    const D1 = await connect('D1');
    const c1Buf = tap(C1, ['room_created', 'guess_result', 'round_start', 'error_msg']);
    const d1Buf = tap(D1, ['opponent_update', 'round_start', 'error_msg']);
    const std = await createRoom(C1, c1Buf, { playerName: '标准甲', difficulty: 'hard', bestOf: 5 });
    await joinRoom(D1, d1Buf, std.code, '标准乙');
    await guess(C1, c1Buf, knownName);
    await sleep(300);
    const stdRows = d1Buf.opponent_update.at(-1)?.allComparisons || [];
    check('a6.标准房不暴露 artist（结构性保证）',
      !std.attributes && !std.custom && (stdRows[0]?.length === 11),
      `attributes=${JSON.stringify(std.attributes)} custom=${std.custom} 行长=${stdRows[0]?.length}`);

    // ══════════════ b. UI 自己棋盘 + 重连 ══════════════
    console.log('\n[b] UI 自己棋盘 + 重连');
    const ctxB = await newZhContext(browser);
    const pageB = await ctxB.newPage();
    await pageB.goto(`${FRONTEND_ORIGIN}/multiplayer`, { waitUntil: 'load' });
    await pageB.getByText('自定义房间').click({ timeout: WAIT_TIMEOUT });

    // 默认已选 职业/阵营/星级，补齐其余 7 个（含画师）
    for (const label of ['子职业', '种族', '性别', '上线年份', '部署位', '词缀', '画师']) {
      await pageB.locator('button.tchip', { hasText: new RegExp(`^${label}$`) }).click({ timeout: WAIT_TIMEOUT });
    }
    const hintTxt = await pageB.locator('.cfg-hint').first().innerText();
    check('b0.词条计数 = 10/10', hintTxt.includes('10/10'), hintTxt);

    await pageB.getByText('创建房间', { exact: true }).click({ timeout: WAIT_TIMEOUT });
    const codeB = await readCode(pageB);
    check('b.自建房创建成功', /^\d{4}$/.test(codeB), `code=${codeB}`);

    const R = await connect('R'); // 裸客户端当对手，既凑人数又持有 ground truth
    const rBuf = tap(R, ['round_start', 'guess_result', 'error_msg']);
    await joinRoom(R, rBuf, codeB, '裸对手');

    await pageB.locator('input.game-search-input').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    await pageB.locator('input.game-search-input').fill(knownName);
    await pageB.locator('input.game-search-input').press('Enter');
    await pageB.locator('table.game-table').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });

    const ownHeaders = () => pageB.locator('table.game-table thead th').allInnerTexts();
    const ownCells = () => pageB.locator('table.game-table tbody tr').first().locator('div.gcell').evaluateAll(
      (els) => els.map((e) => e.className.replace(/\s+/g, ' ').trim()));

    const h1 = await ownHeaders();
    check('b1.自建房表头 11 列、末列为画师',
      h1.length === 11 && h1[10] === '画师', `cols=${h1.length} [${h1.join('|')}]`);
    const cells1 = await ownCells();
    check('b1.每行 11 个 gcell（1 名字 + 10 词条）',
      cells1.length === 11, `gcell=${cells1.length} [${cells1.join(' | ')}]`);

    // 重连：刷新 → rowToComparisons(myColorRows) 重建棋盘
    await pageB.reload({ waitUntil: 'load' });
    await pageB.locator('table.game-table').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    const h2 = await ownHeaders();
    const cells2 = await ownCells();
    check('b2.刷新后表头仍 11 列含画师',
      h2.length === 11 && h2[10] === '画师', `cols=${h2.length} [${h2.join('|')}]`);
    check('b2.刷新后单元格颜色逐字节相同（rowToComparisons 覆盖 artist）',
      JSON.stringify(cells1) === JSON.stringify(cells2),
      `前=[${cells1.join(',')}] 后=[${cells2.join(',')}]`);

    // ══════════════ c. UI 对手棋盘对位 + 命中行搜寻 ══════════════
    // 裸客户端 S 负责建房与猜测（这样测试能直接拿到 ground truth），
    // 浏览器 C 只负责「看」——它是对手，对手棋盘才会渲染 S 的色块。
    // ⚠️ 多人房只有 2 个位置：S + C 正好，**不能**再加第三方凑人数（会「房间已满」）。
    console.log('\n[c] UI 对手棋盘（裸客户端猜、浏览器看）');
    const S = await connect('S');
    const sBuf = tap(S, ['room_created', 'guess_result', 'round_start', 'round_end', 'error_msg']);

    const { names: hunt, cover, pool } = huntGuesses('easy', 15);
    console.log(`   搜寻策略：easy 池 ${pool} 人，猜 15 个大画师组代表 → 覆盖 ${cover}/${pool} = ${(cover / pool * 100).toFixed(0)}%`);

    // bestOf 7（服务端上限，winsNeeded 4）而不是 5：S 只能靠猜中名字赢局，
    // 而赢下的那些局**不算探针** —— 见上面 MAX_ROUNDS 那段最后一条 ⚠️。
    const roomC = await createRoom(S, sBuf, {
      playerName: '搜寻者', difficulty: 'easy', bestOf: 7, maxGuesses: 15, attributes: ALL_KEYS,
    });

    const ctxC = await newZhContext(browser);
    const pageC = await ctxC.newPage();
    await pageC.goto(`${FRONTEND_ORIGIN}/multiplayer`, { waitUntil: 'load' });
    await pageC.getByText('创建 / 加入房间').click({ timeout: WAIT_TIMEOUT });
    await pageC.locator('input[placeholder="4位数字房间码"]').fill(roomC.code);
    await pageC.getByText('加入房间', { exact: true }).click({ timeout: WAIT_TIMEOUT });
    await pageC.locator('input.game-search-input').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });

    // 🔴 回合上限 = 12，**不是 3**。这条断言（c3）是概率性的，而它跑在**部署 gate**里，
    //    「偶尔红一次」等于偶尔无故阻断一次部署，比漏检更难接受。
    //    实测单回合有效探针出现率 = **40%**（2026-10-07 实跑 12 次统计：30 回合里 12 回合出现）。
    //    ⚠️ 早期这里写的是 60% = cover/pool = 92/153，那个数只算了「答案的画师组在 hunt 里」，
    //    没扣掉两种情况：① 答案**本身就是**那个代表 → 名字会被猜中，那行不是有效探针（见 c3）；
    //    ② 猜中名字的那一行常常来不及渲染就被跳过（下面那个静默 catch），
    //    偏偏它往往就是本轮唯一「有 artist 命中」的一行。所以照 60% 推出来的概率全是乐观值。
    //    每回合服务端都重新 randomTarget（见 server/socket/game.js:38）→ 回合之间独立：
    //      3 回合 → 漏 21.6%
    //      8 回合 → 漏 1.68%
    //     12 回合 → 漏 0.22%
    //    ⚠️ 加回合数**不会**把测试拖长多少：只有「没探针」的回合才继续，而那是 60% 的分支；
    //    期望回合数 ≈ 1/0.4 = 2.5，每多一个空回合约 +10s（实测跑满 7 回合的整轮也不到 1 分钟）。
    //    ⚠️ 上限能不能随意加：可以。空回合一定是**平局**（S 15 次用完 = exhausted，C 弃权）
    //    → 平局不计分、不结束比赛，所以空回合可以无限多。
    //    ⚠️ **唯一**会提前掐掉比赛的是 S 攒满胜场（room 的 bestOf）—— 而 S 赢一局必然是
    //    「猜中了名字」，也就是答案恰好落在 hunt 名单里（≈9.8%/回合，且这种回合**不算探针**、
    //    循环不会退出）。bestOf 5 只要 3 局就能结束比赛，那条
    //    「比赛先结束 → hits 仍为 0 → INCONCLUSIVE 假红」的路（(0.098/0.601)³ ≈ 0.43%）
    //    比 12 回合跑空（0.22%）还大；所以这里抬到服务端上限 **bestOf 7**（要 4 局，≈0.07%）。
    const MAX_ROUNDS = 12;
    //
    // ⚠️ **每猜一次就读一次对手棋盘**，不能攒完 15 次再读。原因有两条：
    //   (1) 一旦某次猜中名字，服务端立刻 endRound，浏览器切到结算屏、
    //       整个 opp-grid 卸载 —— 攒到最后读会读到空表；
    //   (2) round_start 会 setOppGrid([])（multiplayer/page.tsx:404），
    //       攒着读会跨回合串行。
    // 逐次读还有个好处：行号即下标，不必再对齐两次切片。
    await waitLen(sBuf, 'round_start', 1);
    let oppHeaders = [];
    let hits = 0, totalRows = 0, mismatches = [];
    for (let round = 1; round <= MAX_ROUNDS && hits === 0; round++) {
      const before = sBuf.round_start.length;
      let i = 0;
      // 本回合是不是**自己**结算的（猜中名字）。false 而回合又结束了 = 别人结算的
      // （对手放弃 / 超时 / 双方耗尽），那种情况下放弃按钮已随结算屏卸载，不能再点。
      let settledByUs = false;
      for (const nm of hunt) {
        const r = await guess(S, sBuf, nm);
        // null = 本回合已被结算，服务端此后静默丢弃猜测 → 收工，别空转到超时
        if (!r) break;
        // 等这一行渲染出来（读空表 = 这一轮白读，宁可超时失败也不要静默空转）
        await waitFor(async () => (await pageC.locator('table.opp-grid tbody tr span.opp-dot').count()) >= (i + 1) * 11,
          { desc: `对手棋盘第 ${i + 1} 行` }).catch(() => {});
        // opp-grid 显示时 reverse 过：dots[0] 最新，反向后下标 = 猜测顺序
        const dotRows = [...(await readOppGrid(pageC))].reverse();
        oppHeaders = await pageC.locator('table.opp-grid thead th').allInnerTexts();
        if (dotRows.length > i) {
          totalRows++;
          const expect = [r.correct ? 'correct' : 'wrong',
            ...STANDARD_KEYS.map((k) => r.comparisons[k]), r.comparisons.artist];
          for (let j = 0; j < 11 && j < dotRows[i].length; j++) {
            if (dotRows[i][j] !== DOT[expect[j]]) mismatches.push(`r${i}c${j}: 点=${dotRows[i][j]} 期望=${DOT[expect[j]]}(${expect[j]})`);
          }
          // ⚠️ `&& !r.correct` 是**承重的**，别删：猜中答案的那一行，名字列本来就是 correct
          //    （两列同时 d-ok），正确实现与「画师列错读名字列」的 bug 完全重合 ——
          //    它证伪不了任何东西。旧版无条件断言「名字点 = d-no」，于是**答案恰好落在 hunt
          //    名单里时当场假红**（2026-10-07 实测撞到过）。这种行不计 hits、不断言，
          //    本轮按「无效」处理，外层靠 `hits === 0` continue 到下一回合。
          if (r.comparisons.artist === 'correct' && !r.correct) {
            hits++;
            check(`c3.第 ${i} 行 artist 命中：画师点 = d-ok、名字点 = d-no`,
              dotRows[i][10] === DOT.correct && dotRows[i][0] === DOT.wrong,
              `画师点=${dotRows[i][10]} 名字点=${dotRows[i][0]}`);
          }
        }
        i++;
        if (r.correct) { settledByUs = true; break; } // 猜中名字 → 回合立刻结束
      }
      console.log(`   第 ${round} 回合：猜 ${i} 次，累计核对 ${totalRows} 行，有效探针 ${hits}`);
      // 比赛已结束（bestOf 5 数满胜场）就没有下一回合了，再等 round_start 只会等满超时
      if (sBuf.round_end.at(-1)?.matchOver) break;
      if (hits === 0 && round < MAX_ROUNDS) {
        // 只有 S 次数耗尽是**不会**结算的（服务端要**其余玩家全部出局**才判平局）——
        // 所以让只观战的 C 放弃：此时 S 已 exhausted、C 已 surrendered → 全体出局 → 平局，
        // 6s 后自动开下一局。
        // ⚠️ 需求⑥之后这条**依然成立**，但机制换了：C 的放弃**本身**不再结算回合
        //    （旧版会），结算靠的是它让 C 也变成「出局」、从而凑满「全体出局」。
        //    本用例能继续用，正是因为有 S 先耗尽这一半 —— 别以为它测的是「单方放弃即结算」。
        // ⚠️ 放弃是二次确认：handleSurrender 只开弹窗（page.tsx:647），
        //    必须再点弹窗里的「确认放弃」才真的 emit surrender_round。
        // ⚠️ 只在本回合**仍开着**时才点：回合若已被别人结算（对手放弃/超时/耗尽），
        //    浏览器已经切到结算屏、这两个按钮都不在 DOM 里，click 会空等到 WAIT_TIMEOUT
        //    再抛错 —— 表现与「后端挂了」一模一样，但其实是测试自己把回合走完了。
        if (!settledByUs) {
          await pageC.locator('button', { hasText: '放弃本局' }).click({ timeout: WAIT_TIMEOUT });
          await pageC.locator('button', { hasText: '确认放弃' }).click({ timeout: WAIT_TIMEOUT });
        }
        await waitLen(sBuf, 'round_start', before + 1);
      }
    }

    check('c1.对手棋盘表头 11 列、末列为画师',
      oppHeaders.length === 11 && oppHeaders[10] === '画师', `cols=${oppHeaders.length} [${oppHeaders.join('|')}]`);
    check('c2.对手棋盘每行 11 个点，颜色逐格匹配服务端载荷',
      mismatches.length === 0 && totalRows > 0,
      mismatches.length ? mismatches.slice(0, 3).join(' | ') : `共 ${totalRows} 行全部相符`);
    check('c3.至少出现一行 artist 命中（否则本项无法证伪 dataIdx 错位）',
      hits > 0,
      hits > 0
        ? `有效探针 ${hits} 行`
        : `INCONCLUSIVE — ${MAX_ROUNDS} 回合 ${totalRows} 行内未出现**有效探针**（artist 命中且名字未中），`
          + `画师列与名字列的错位在颜色上不可区分（本项按 0.6^${MAX_ROUNDS} ≈ 0.2% 的概率会这样空转，真出现请重跑一次确认）`);

    return 0;
  } catch (e) {
    console.error('\n❌ 多人画师冒烟异常：', e.message);
    return 1;
  } finally {
    for (const s of raw) { try { s.disconnect(); } catch {} }
    if (browser) await browser.close().catch(() => {});
    if (staticServer) staticServer.close();
    await killBackend(backend);
    await cleanupDb(DB_PATH);
  }
}

/** opponent_update 的 allComparisons 行数与 maxGuesses 取小 —— 猜满就结束，不再受理 */
function guessCountOf(created) {
  const mg = Number(created.maxGuesses);
  return Number.isInteger(mg) && mg > 0 ? mg : 8;
}

/** 读对手棋盘每个点的颜色类名（d-ok / d-cl / d-no / ''） */
async function readOppGrid(page) {
  return page.locator('table.opp-grid tbody tr').evaluateAll((rows) =>
    rows.map((tr) => [...tr.querySelectorAll('span.opp-dot')].map((sp) => {
      const m = [...sp.classList].find((c) => /^d-(ok|cl|no)$/.test(c));
      return m || '';
    })));
}

async function readCode(page) {
  await waitFor(async () => {
    const texts = await page.locator('p').allTextContents();
    return texts.map((x) => x.trim()).some((x) => /^\d{4}$/.test(x));
  }, { desc: '4 位房间码出现' });
  const texts = await page.locator('p').allTextContents();
  return texts.map((x) => x.trim()).find((x) => /^\d{4}$/.test(x)) || '';
}

const exitCode = await main();
finish(exitCode);
