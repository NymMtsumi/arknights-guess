#!/usr/bin/env node
// 单人/每日/排行榜/统计 — UI 级冒烟测试（Playwright 单 BrowserContext）
//
// 覆盖 checklist：
//   s1. 单人 /game：选难度 → 输入真实干员名 → 提交 → 出现 game-table（猜测已登记）
//   s2. 每日 /daily：进入即 playing（临时 DB 无记录）→ 猜一个干员 → 出现 game-table
//   s3. 排行榜 /leaderboard：标题 + 三 tab（单人/多人/每日）+ 切「每日」后难度筛选隐藏
//   s4. 统计 /stats：标题 + 空数据态（临时 DB 无战绩 →「暂无游戏记录」）
//
// 目标干员客户端随机、不可预知，故「不追求猜对」，只验证「能玩、有正确反馈」。
// 干员名从 src/data/characters.json 取第一个（与前端 findCharacterByName 同源，必然可命中）。

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ROOT, FRONTEND_ORIGIN, WAIT_TIMEOUT,
  check, finish, waitFor, makeDbPath,
  startStaticServer, startBackend, killBackend, waitForBackend, cleanupDb,
  requireBuild, requirePlaywright,
} from './helpers.mjs';

const DB_PATH = makeDbPath('solo');

async function main() {
  if (!requireBuild()) return 1;
  const chromium = await requirePlaywright();
  if (!chromium) return 1;

  // 前端 game-engine 用的干员数据源
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
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    // ── s1. 单人 /game ──
    console.log('\n[s1] 单人模式');
    await page.goto(`${FRONTEND_ORIGIN}/game`, { waitUntil: 'domcontentloaded' });
    await page.locator('.menu-card', { hasText: '简单' }).first().click({ timeout: WAIT_TIMEOUT });
    const search1 = page.locator('input.game-search-input');
    await search1.waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    check('s1.选难度后进入游戏（搜索框出现）', true);

    await search1.fill(knownName);
    await search1.press('Enter');
    await page.locator('table.game-table').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    check('s1.提交猜测后出现 game-table', true);
    const singleRows = await page.locator('table.game-table tbody tr').count();
    check('s1.猜测登记为 1 行', singleRows >= 1, `rows=${singleRows}`);

    // ── s2. 每日 /daily ──
    console.log('\n[s2] 每日挑战');
    await page.goto(`${FRONTEND_ORIGIN}/daily`, { waitUntil: 'domcontentloaded' });
    const search2 = page.locator('input.game-search-input');
    await search2.waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    check('s2.进入即 playing（搜索框出现，临时 DB 无记录）', true);

    await search2.fill(knownName);
    await search2.press('Enter');
    await page.locator('table.game-table').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    check('s2.提交猜测后出现 game-table', true);

    // ── s3. 排行榜 /leaderboard ──
    console.log('\n[s3] 排行榜');
    await page.goto(`${FRONTEND_ORIGIN}/leaderboard`, { waitUntil: 'domcontentloaded' });
    await page.locator('h1', { hasText: '排行榜' }).waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    check('s3.标题「排行榜」渲染', true);

    const tabs = page.locator('[role="tab"]');
    await waitFor(async () => (await tabs.count()) === 3, { desc: '3 个 tab' });
    check('s3.三 tab（单人/多人/每日）存在', true);

    // 切「每日」→ 难度筛选栏隐藏
    await page.locator('[role="tab"]', { hasText: '每日' }).click();
    await waitFor(async () => (await page.locator('.leaderboard-difficulty-bar').count()) === 0, {
      desc: '每日模式隐藏难度筛选',
    });
    check('s3.切「每日」后难度筛选隐藏', true);
    // 无错误态：错误态用「加载失败」文案（.leaderboard-empty 同时被空数据态复用，不能据此判错）
    const lbErr = await page.locator('text=加载失败').count();
    check('s3.排行榜无错误态（非「加载失败」）', lbErr === 0, lbErr > 0 ? '出现加载失败' : '');
    // 临时 DB 无数据 → 空数据态应正常渲染（fetch 成功返回 0 条）
    await page.locator('.leaderboard-empty').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    check('s3.空数据态渲染（fetch 成功返回 0 条）', true);

    // ── s4. 统计 /stats ──
    console.log('\n[s4] 统计');
    await page.goto(`${FRONTEND_ORIGIN}/stats`, { waitUntil: 'domcontentloaded' });
    await page.locator('h1', { hasText: '游戏统计' }).waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    check('s4.标题「游戏统计」渲染', true);
    await page.locator('text=暂无游戏记录').first().waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    check('s4.空数据态「暂无游戏记录」渲染（临时 DB 无战绩）', true);

    return 0;
  } catch (e) {
    console.error('\n❌ 单人/每日/排行榜/统计冒烟异常：', e.message);
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
