#!/usr/bin/env node
// 派对模式 — 双/多客户端冒烟测试（Playwright 多 BrowserContext）
//
// 覆盖 checklist（作为上线前置 gate，全部通过才允许部署）：
//   a. 建房 → 房主算 1 人
//   b. 二号搜号进房
//   c. 点分享链接 ?room=CODE 自动进房（而非跳回 lobby）
//   d. 非房主准备 → 房主开始 → 进入倒计时/游戏中
//   e. 有人点离开 → 人数正确回落、本人 UI 复位
//   f. 断线重连（等待室）→ 他人视角先显示断线、重连（同 player_key）后清除
//   g. 局中断线重连 → 断线计数不虚高 + 重开页面能重进已开始游戏（不再“游戏已开始”）
//
// 脚本自行完成：
//   1) 起后端（临时 DB，零依赖生产配置）
//   2) 静态服务 out/（需要先用 NEXT_PUBLIC_WS_URL 指向本后端 build 前端）
//   3) 开三个隔离的 BrowserContext 跑 a-f
//   4) 清理临时进程与文件
//
// 运行：NEXT_PUBLIC_WS_URL=http://localhost:3101 npm run build && node tests/party-smoke.mjs
//   或直接：npm run smoke（内部先 build 再测）

import {
  OUT_DIR, BACKEND_PORT, FRONTEND_ORIGIN, WAIT_TIMEOUT,
  check, finish, sleep, waitFor, makeDbPath,
  startStaticServer, startBackend, killBackend, waitForBackend, cleanupDb,
  requireBuild, requirePlaywright, newZhContext,
} from './helpers.mjs';

const DB_PATH = makeDbPath('party');

// ── party 专属 helper ──
async function readCount(page) {
  const txt = await page.locator('[data-testid="party-player-count"]').textContent();
  const m = (txt || '').match(/(\d+)\s*\/\s*\d+/);
  return m ? parseInt(m[1], 10) : -1;
}

async function waitForCount(page, n, timeout = WAIT_TIMEOUT) {
  await waitFor(async () => (await readCount(page)) === n, { timeout, desc: `count == ${n}` });
  return readCount(page);
}

async function enterLobby(page) {
  await page.locator('[data-testid="party-menu-join"]').click({ timeout: WAIT_TIMEOUT });
  await page.locator('[data-testid="party-create"]').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
}

// ═══════════════════════════════════════════════
//  主流程
// ═══════════════════════════════════════════════
async function main() {
  if (!requireBuild()) return 1;
  const chromium = await requirePlaywright();
  if (!chromium) return 1;

  const backend = startBackend({ dbPath: DB_PATH });
  let staticServer = null;
  let browser = null;

  try {
    await waitForBackend(BACKEND_PORT);
    staticServer = await startStaticServer();
    browser = await chromium.launch({ headless: true });

    // 三个隔离 context：A 房主 / B 搜号加入 / C 分享链接加入
    const ctxA = await newZhContext(browser);
    const ctxB = await newZhContext(browser);
    const ctxC = await newZhContext(browser);
    const A = await ctxA.newPage();
    let B = await ctxB.newPage();
    const C = await ctxC.newPage();

    // ── a. 建房 → 房主算 1 人 ──
    console.log('\n[a] 房主建房');
    await A.goto(`${FRONTEND_ORIGIN}/party`, { waitUntil: 'load' });
    await enterLobby(A);
    await A.locator('[data-testid="party-create"]').click({ timeout: WAIT_TIMEOUT });
    const count1 = await waitForCount(A, 1);
    check('a.建房后房主算 1 人', count1 === 1, `count=${count1}`);
    const code = (await A.locator('[data-testid="party-room-code"]').textContent()).trim();
    check('a.房间码生成（6 位数字）', /^\d{6}$/.test(code), code);

    // ── b. 二号搜号进房 ──
    console.log('\n[b] 二号搜号进房');
    await B.goto(`${FRONTEND_ORIGIN}/party`, { waitUntil: 'load' });
    await enterLobby(B);
    await B.locator('[data-testid="party-join-input"]').fill(code);
    await B.locator('#party-join-btn').click({ timeout: WAIT_TIMEOUT });
    await waitForCount(B, 2);
    await waitForCount(A, 2);
    check('b.二号搜号进房（双方见 2 人）', true);

    // ── c. 分享链接自动进房 ──
    console.log('\n[c] 分享链接自动进房');
    await C.goto(`${FRONTEND_ORIGIN}/party?room=${code}`, { waitUntil: 'load' });
    await C.locator('[data-testid="party-room-code"]').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    await waitForCount(C, 3);
    await waitForCount(A, 3);
    check('c.分享链接自动进房（非跳回 lobby）', true, '3 人');

    // ── f. 断线重连 → 他人视角先显示断线、重连后清除 ──
    console.log('\n[f] 断线重连');
    await B.close(); // 关闭页面 → socket 断开，服务端广播 party:player_disconnected
    await waitFor(async () => (await A.locator('[data-testid="party-disconnected-badge"]').count()) === 1, {
      timeout: WAIT_TIMEOUT, desc: 'B 掉线后 A 侧出现断线徽标',
    });
    check('f.掉线后他人视角显示断线', true);
    B = await ctxB.newPage(); // 同 context → 复用同一 player_key，触发重连分支
    await B.goto(`${FRONTEND_ORIGIN}/party?room=${code}`, { waitUntil: 'load' });
    await B.locator('[data-testid="party-room-code"]').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    await waitFor(async () => (await A.locator('[data-testid="party-disconnected-badge"]').count()) === 0, {
      timeout: WAIT_TIMEOUT, desc: 'B 重连后 A 侧断线徽标清除',
    });
    check('f.重连后他人视角不再显示断线', true);
    await waitForCount(A, 3);
    await waitForCount(B, 3);
    check('f.重连后双方仍见 3 人', true);

    // ── e. 有人离开 → 人数回落、本人 UI 复位 ──
    console.log('\n[e] 离开按钮');
    await C.locator('[data-testid="party-leave"]').click({ timeout: WAIT_TIMEOUT });
    await C.locator('[data-testid="party-menu-join"]').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    await waitForCount(A, 2);
    check('e.离开后人数回落 + 本人 UI 复位', true, 'C 回菜单，A 见 2 人');

    // C 重新加入（凑满 3 人，为 d 做准备）
    console.log('\n[c2] C 重新加入');
    await C.locator('[data-testid="party-menu-join"]').click({ timeout: WAIT_TIMEOUT });
    await C.locator('[data-testid="party-join-input"]').fill(code);
    await C.locator('#party-join-btn').click({ timeout: WAIT_TIMEOUT });
    await waitForCount(C, 3);
    await waitForCount(A, 3);

    // ── d. 非房主准备 → 房主开始 ──
    console.log('\n[d] 准备 + 开始');
    await B.locator('[data-testid="party-ready"]').click({ timeout: WAIT_TIMEOUT });
    await C.locator('[data-testid="party-ready"]').click({ timeout: WAIT_TIMEOUT });
    await waitFor(async () => A.locator('[data-testid="party-start"]').isEnabled(), { desc: 'start enabled' });
    check('d.准备后房主开始按钮可用', true);
    await A.locator('[data-testid="party-start"]').click({ timeout: WAIT_TIMEOUT });
    await A.locator('[data-testid="party-countdown"]').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    await B.locator('[data-testid="party-countdown"]').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    check('d.开始后进入倒计时', true);

    // 附加：回合真正开始（5s 倒计时后进入 playing）
    try {
      await A.locator('[data-testid="party-game"]').waitFor({ state: 'visible', timeout: 12_000 });
      check('d+.回合开始进入游戏中', true);
    } catch {
      check('d+.回合开始进入游戏中', false, '未在 12s 内进入 playing');
    }

    // ── g. 局中断线重连（回归：断线计数不虚高 + 重开页面重进已开始游戏）──
    console.log('\n[g] 局中断线重连');
    await B.locator('[data-testid="party-game"]').waitFor({ state: 'visible', timeout: 12_000 });
    await C.locator('[data-testid="party-game"]').waitFor({ state: 'visible', timeout: 12_000 });

    await B.close();
    await waitFor(async () => {
      const el = A.locator('[data-testid="party-disconnected-count"]');
      return (await el.count()) === 1 && (await el.getAttribute('data-count')) === '1';
    }, { timeout: WAIT_TIMEOUT, desc: '局内断线计数=1（不虚高为 3）' });
    check('g.局内断线计数=1（不虚高）', true);

    B = await ctxB.newPage();
    await B.goto(`${FRONTEND_ORIGIN}/party?room=${code}`, { waitUntil: 'load' });
    await B.locator('[data-testid="party-game"]').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    check('g.重开页面重进已开始游戏（不再“游戏已开始”）', true);
    await waitFor(async () => (await A.locator('[data-testid="party-disconnected-count"]').count()) === 0, {
      timeout: WAIT_TIMEOUT, desc: '重连后断线计数清除',
    });
    check('g.重连后断线计数清除', true);

    // ── h. 凭证不外泄：派对载荷里绝不能出现别人的 player_key ──
    // player_key 是玩家凭证：server/socket/index.js 的握手接受 auth.pk / query.pk，
    // 谁拿到谁的 pk 就能顶替那个游客的身份。旧代码把全房 pk 放在
    // party:created / player_joined / round_status / round_end 等载荷里广播给同房所有人。
    // 这条断言用裸 socket 客户端收全量事件、递归扫值，比 grep 更能挡住「换个字段名又漏回来」。
    console.log('\n[h] 派对载荷不含 player_key');
    const { io } = await import('socket.io-client');
    const conn = (label) => new Promise((resolve, reject) => {
      const s = io(BACKEND_PORT === 0 ? '' : `http://localhost:${BACKEND_PORT}`, {
        transports: ['websocket'], forceNew: true,
        auth: { pk: `p_smokeLEAK${label}${'x'.repeat(6)}` },
      });
      s.on('connect', () => resolve(s));
      s.on('connect_error', reject);
      setTimeout(() => reject(new Error(`${label} 连接超时`)), WAIT_TIMEOUT);
    });

    const seen = [];   // 收集所有收到的载荷
    const sink = (label) => (s) => {
      s.onAny((ev, payload) => {
        if (ev === 'set_cookie') return; // 服务端只给自己下发自己的 pk，是正常路径
        seen.push({ label, ev, payload });
      });
    };

    // ⚠️ 必须凑够 MIN_PLAYERS=3 并真的开局：只建房不加人的话收不到
    //    party:round_status / round_end，而「没收到载荷」会让下面的断言**假通过**。
    //    所以末尾有一条「样本覆盖」断言，缺了它会直接判失败。
    const s1 = await conn('A');
    const s2 = await conn('B');
    const s3 = await conn('C');
    sink('A')(s1); sink('B')(s2); sink('C')(s3);

    const emitAck = (s, ev, data) => new Promise((resolve) => {
      s.timeout(WAIT_TIMEOUT).emit(ev, data, (err, resp) => resolve(err ? null : resp));
    });

    const created = await emitAck(s1, 'party:create', { difficulty: 'hard', rounds: 3, roundTime: 60 });
    const leakCode = created?.roomCode;
    check('h.裸客户端建房成功', !!leakCode, `resp=${JSON.stringify(created)}`);
    await emitAck(s2, 'party:join', { roomCode: leakCode });
    await emitAck(s3, 'party:join', { roomCode: leakCode });
    await sleep(400);
    await emitAck(s2, 'party:toggle_ready', {});
    await emitAck(s3, 'party:toggle_ready', {});
    await emitAck(s1, 'party:start', {});
    await sleep(1200);

    // 递归找任何看起来像 player_key 的值（p_ / g_ 前缀 + 够长）
    const isCred = (v) => typeof v === 'string' && /^[pg]_[A-Za-z0-9_-]{8,}$/.test(v);
    const hits = [];
    const walk = (v, path) => {
      if (isCred(v)) { hits.push(path); return; }
      if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
      if (v && typeof v === 'object') {
        for (const [k, val] of Object.entries(v)) walk(val, `${path}.${k}`);
      }
    };
    for (const { label, ev, payload } of seen) walk(payload, `${label}:${ev}`);

    check('h.收到过派对载荷（样本非空，断言才有意义）', seen.length >= 3, `events=${seen.length} [${[...new Set(seen.map(s => s.ev))].join(',')}]`);
    // 覆盖闸：必须真的跑到「局内实时状态」这一步，否则上面那条「不含凭证」是假通过
    const evs = new Set(seen.map(s => s.ev));
    check('h.确实跑到了局内载荷（round_status / round_end）', evs.has('party:round_status') || evs.has('party:round_end'), `events=[${[...evs].join(',')}]`);
    check('h.载荷中不含任何 player_key 形式的凭证', hits.length === 0, hits.slice(0, 6).join(' | '));

    // ── i. 房间码枚举被限流 ──
    // 6 位房间码只有 10^6 种，而 party:join 失败会明确回「房间不存在」——
    // 不设限的话一条连接几分钟就能扫完，扫到就挤进陌生人的房间。
    // 用**新建的连接**发一串必失败的 join，必须在若干次之后被 RATE_LIMITED 挡住。
    console.log('\n[i] 房间码枚举限流');
    const s4 = await conn('D');
    let limited = null;
    for (let i = 0; i < 40; i++) {
      const r = await emitAck(s4, 'party:join', { roomCode: '000000' });
      if (r && r.code === 'RATE_LIMITED') { limited = i; break; }
    }
    check('i.连续枚举房间码会被限流', limited !== null, limited === null ? '40 次全放行' : `第 ${limited + 1} 次被拒`);
    // 断言「是限流拒的」而不是「因为房间不存在拒的」：两者错误码不同
    const after = await emitAck(s4, 'party:join', { roomCode: '000000' });
    check('i.限流状态下后续请求仍被拒（不是偶发）', after?.code === 'RATE_LIMITED', `resp=${JSON.stringify(after)}`);
    s4.close();

    return 0;
  } catch (e) {
    console.error('\n❌ 冒烟测试异常：', e.message);
    console.error('   若为后端启动失败，请确认 better-sqlite3 已编译：npm rebuild better-sqlite3');
    return 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (staticServer) staticServer.close();
    killBackend(backend);
    await sleep(800);
    await cleanupDb(DB_PATH);
  }
}

// ═══════════════════════════════════════════════
//  入口
// ═══════════════════════════════════════════════
const exitCode = await main();
finish(exitCode);
