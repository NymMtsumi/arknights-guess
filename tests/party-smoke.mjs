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
  requireBuild, requirePlaywright,
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
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const ctxC = await browser.newContext();
    const A = await ctxA.newPage();
    let B = await ctxB.newPage();
    const C = await ctxC.newPage();

    // ── a. 建房 → 房主算 1 人 ──
    console.log('\n[a] 房主建房');
    await A.goto(`${FRONTEND_ORIGIN}/party`, { waitUntil: 'domcontentloaded' });
    await enterLobby(A);
    await A.locator('[data-testid="party-create"]').click({ timeout: WAIT_TIMEOUT });
    const count1 = await waitForCount(A, 1);
    check('a.建房后房主算 1 人', count1 === 1, `count=${count1}`);
    const code = (await A.locator('[data-testid="party-room-code"]').textContent()).trim();
    check('a.房间码生成（6 位数字）', /^\d{6}$/.test(code), code);

    // ── b. 二号搜号进房 ──
    console.log('\n[b] 二号搜号进房');
    await B.goto(`${FRONTEND_ORIGIN}/party`, { waitUntil: 'domcontentloaded' });
    await enterLobby(B);
    await B.locator('[data-testid="party-join-input"]').fill(code);
    await B.locator('#party-join-btn').click({ timeout: WAIT_TIMEOUT });
    await waitForCount(B, 2);
    await waitForCount(A, 2);
    check('b.二号搜号进房（双方见 2 人）', true);

    // ── c. 分享链接自动进房 ──
    console.log('\n[c] 分享链接自动进房');
    await C.goto(`${FRONTEND_ORIGIN}/party?room=${code}`, { waitUntil: 'domcontentloaded' });
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
    await B.goto(`${FRONTEND_ORIGIN}/party?room=${code}`, { waitUntil: 'domcontentloaded' });
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
    await B.goto(`${FRONTEND_ORIGIN}/party?room=${code}`, { waitUntil: 'domcontentloaded' });
    await B.locator('[data-testid="party-game"]').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    check('g.重开页面重进已开始游戏（不再“游戏已开始”）', true);
    await waitFor(async () => (await A.locator('[data-testid="party-disconnected-count"]').count()) === 0, {
      timeout: WAIT_TIMEOUT, desc: '重连后断线计数清除',
    });
    check('g.重连后断线计数清除', true);

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
