#!/usr/bin/env node
// 多人对战（标准房 / 自定义房 / 快速匹配）— UI 级冒烟测试（Playwright 多 BrowserContext）
//
// 覆盖 checklist：
//   m1. 标准房：建房 → 拿 4 位房间码 → 二号加入 → 双方 playing
//   m2. 猜测回环：A 猜 → A 侧 game-table 回显（guess_result）；B 侧对手计数 +1（opponent_update）
//   m3. 弃权结算：B 弃权 → 双方 round_end（答案揭晓「答案：…」）
//   m4. 自定义房：A 建自定义房（3 属性）→ B 加入 → A 猜 → 棋盘仅「名字+3 属性」4 列（displayAttributes 过滤）
//   m5. 断线：对手断线 → A 侧显示「断线中」徽标
//   m6. 快速匹配：A/B 同时进队列 → 配对成功 → 双方 playing
//
// 说明：目标干员由服务端随机下发、绝不下发客户端（服务端权威、防作弊），
//   故「猜对判胜」无法确定性触发（概率 1/425）；胜负结算改用「弃权→平局」确定性路径覆盖。
//   match_end（胜场判负/断线超时）走 30s 宽限窗口，smoke 不等待，由 party-smoke 覆盖断线/重连链路。

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ROOT, FRONTEND_ORIGIN, WAIT_TIMEOUT,
  check, finish, waitFor, makeDbPath,
  startStaticServer, startBackend, killBackend, waitForBackend, cleanupDb,
  requireBuild, requirePlaywright, newZhContext,
} from './helpers.mjs';

const DB_PATH = makeDbPath('multiplayer');

// 等待并读取等待室的 4 位房间码（等待室唯一一个纯数字 <p>）
async function readCode(page) {
  await waitFor(async () => {
    const texts = await page.locator('p').allTextContents();
    return texts.map((t) => t.trim()).some((t) => /^\d{4}$/.test(t));
  }, { desc: '4 位房间码出现' });
  const texts = await page.locator('p').allTextContents();
  const code = texts.map((t) => t.trim()).find((t) => /^\d{4}$/.test(t));
  return code || '';
}

async function main() {
  if (!requireBuild()) return 1;
  const chromium = await requirePlaywright();
  if (!chromium) return 1;

  const characters = JSON.parse(await readFile(join(ROOT, 'src', 'data', 'characters.json'), 'utf8'));
  const knownName = characters[0]?.name;
  if (!knownName) {
    console.error('❌ characters.json 为空，无法取测试干员名');
    return 1;
  }
  console.log(`   测试干员名 = ${knownName}`);

  const backend = startBackend({ dbPath: DB_PATH });
  let staticServer = null;
  let browser = null;

  try {
    await waitForBackend();
    staticServer = await startStaticServer();
    browser = await chromium.launch({ headless: true });

    // ── m1 + m2 + m3. 标准房 ──
    console.log('\n[m1] 标准房建房 + 加入');
    const ctxA = await newZhContext(browser);
    const ctxB = await newZhContext(browser);
    const A = await ctxA.newPage();
    const B = await ctxB.newPage();

    await A.goto(`${FRONTEND_ORIGIN}/multiplayer`, { waitUntil: 'load' });
    await A.getByText('创建 / 加入房间').click({ timeout: WAIT_TIMEOUT });
    await A.getByText('创建房间', { exact: true }).click({ timeout: WAIT_TIMEOUT });
    await A.getByText('等待对手加入').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    const code = await readCode(A);
    check('m1.标准房创建成功（4 位房间码）', /^\d{4}$/.test(code), `code=${code}`);

    await B.goto(`${FRONTEND_ORIGIN}/multiplayer`, { waitUntil: 'load' });
    await B.getByText('创建 / 加入房间').click({ timeout: WAIT_TIMEOUT });
    await B.locator('input[placeholder="4位数字房间码"]').fill(code);
    await B.getByText('加入房间', { exact: true }).click({ timeout: WAIT_TIMEOUT });
    await A.locator('input.game-search-input').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    await B.locator('input.game-search-input').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    check('m1.满员后双方进入 playing', true);

    console.log('\n[m2] 猜测回环（guess_result / opponent_update）');
    await A.locator('input.game-search-input').fill(knownName);
    await A.locator('input.game-search-input').press('Enter');
    await A.locator('table.game-table').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    check('m2.A 猜测结果回显（guess_result → game-table）', true);
    await waitFor(async () => (await B.getByText('（1次）').count()) > 0, { desc: 'B 侧对手计数=1' });
    check('m2.B 收到对手更新（opponent_update 计数=1）', true);

    console.log('\n[m3] 弃权结算（round_end）');
    await B.getByText('放弃本局', { exact: true }).click({ timeout: WAIT_TIMEOUT });
    await B.getByText('确认放弃', { exact: true }).click({ timeout: WAIT_TIMEOUT });
    await A.getByText('答案：').first().waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    await B.getByText('答案：').first().waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    check('m3.弃权 → 双方 round_end（答案揭晓）', true);

    await ctxA.close();
    await ctxB.close();

    // ── m4 + m5. 自定义房 ──
    console.log('\n[m4] 自定义房（属性列过滤）');
    const ctxC = await newZhContext(browser);
    const ctxD = await newZhContext(browser);
    const C = await ctxC.newPage();
    const D = await ctxD.newPage();

    await C.goto(`${FRONTEND_ORIGIN}/multiplayer`, { waitUntil: 'load' });
    await C.getByText('自定义房间').click({ timeout: WAIT_TIMEOUT }); // menu → custom（默认已选 3 属性）
    await C.getByText('创建房间', { exact: true }).click({ timeout: WAIT_TIMEOUT });
    await C.getByText('等待对手加入').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    const code2 = await readCode(C);
    check('m4.自定义房创建成功', /^\d{4}$/.test(code2), `code=${code2}`);

    await D.goto(`${FRONTEND_ORIGIN}/multiplayer`, { waitUntil: 'load' });
    await D.getByText('创建 / 加入房间').click({ timeout: WAIT_TIMEOUT });
    await D.locator('input[placeholder="4位数字房间码"]').fill(code2);
    await D.getByText('加入房间', { exact: true }).click({ timeout: WAIT_TIMEOUT });
    await C.locator('input.game-search-input').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    await D.locator('input.game-search-input').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    check('m4.自定义房满员进入 playing', true);

    await C.locator('input.game-search-input').fill(knownName);
    await C.locator('input.game-search-input').press('Enter');
    await C.locator('table.game-table').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    const thCount = await C.locator('table.game-table thead th').count();
    check('m4.棋盘仅「名字+3 属性」4 列（displayAttributes 过滤）', thCount === 4, `cols=${thCount}`);

    console.log('\n[m5] 对手断线');
    await D.close();
    await C.getByText('断线中').first().waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    check('m5.对手断线 → 显示「断线中」徽标', true);

    await ctxC.close();

    // ── m6. 快速匹配 ──
    console.log('\n[m6] 快速匹配');
    const ctxE = await newZhContext(browser);
    const ctxF = await newZhContext(browser);
    const E = await ctxE.newPage();
    const F = await ctxF.newPage();

    await E.goto(`${FRONTEND_ORIGIN}/multiplayer`, { waitUntil: 'load' });
    await F.goto(`${FRONTEND_ORIGIN}/multiplayer`, { waitUntil: 'load' });
    await E.getByText('快速匹配').click({ timeout: WAIT_TIMEOUT });
    await F.getByText('快速匹配').click({ timeout: WAIT_TIMEOUT });
    await E.locator('input.game-search-input').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    await F.locator('input.game-search-input').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    check('m6.快速匹配配对成功进入 playing', true);

    await ctxE.close();
    await ctxF.close();

    return 0;
  } catch (e) {
    console.error('\n❌ 多人对战冒烟异常：', e.message);
    return 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (staticServer) staticServer.close();
    killBackend(backend);
    await cleanupDb(DB_PATH);
  }
}

const exitCode = await main();
finish(exitCode);
