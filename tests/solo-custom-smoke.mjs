#!/usr/bin/env node
// 单人自建房（自选词条）— UI 级验证
//
// 覆盖 checklist：
//   c1. 经典单人不受影响：表头 10 列（名字 + 9 词条），且**没有**画师列
//   c2. 词条 chips 计数：标准态 9 列；点标准词条 → 8；重置 → 9；点画师 → 10
//   c3. 自建房开局：表头 11 列（名字 + 10），且「画师」列出现
//   c4. 不落档：自建房结束一局，本地 stats/history **均未写入**（用户决策：自建房不计战绩）
//   c5. 「再来一把」保持自建房词条（回归：handleNewGame 若不传 attributes 会静默
//       退化成经典对局，并因此开始落档）
//   c6. 对照组：经典局结束**必须**写 stats/history —— 否则 c4 可能只是「落档机制根本没跑」
//
// ⚠️ 未接入 scripts/smoke-all.sh。是否并入部署 gate 由维护者决定（新增文件，默认不改 gate）。
// 手动运行：需要先 npm run build
//   NODE_OPTIONS="--require ./tests/_dns-preload.cjs" node tests/solo-custom-smoke.mjs

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ROOT, FRONTEND_ORIGIN, WAIT_TIMEOUT,
  check, finish, waitFor, makeDbPath,
  startStaticServer, startBackend, killBackend, waitForBackend, cleanupDb,
  requireBuild, requirePlaywright, newZhContext,
} from './helpers.mjs';

const DB_PATH = makeDbPath('solo-custom');
const STATS_KEY = 'arknights-guess-stats';
const HISTORY_KEY = 'arknights-guess-history';

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
    const ctx = await newZhContext(browser);
    const page = await ctx.newPage();

    const headers = () => page.locator('table.game-table thead th').allInnerTexts();
    const guessOnce = async () => {
      const s = page.locator('input.game-search-input');
      await s.waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
      await s.fill(knownName);
      await s.press('Enter');
      await page.locator('table.game-table').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    };
    const readLs = () => page.evaluate(([s, h]) => ({
      stats: localStorage.getItem(s),
      history: localStorage.getItem(h),
    }), [STATS_KEY, HISTORY_KEY]);
    const giveUpAndWaitDialog = async () => {
      await page.locator('button', { hasText: '放弃' }).click({ timeout: WAIT_TIMEOUT });
      await waitFor(async () => (await page.locator('text=很遗憾').count()) > 0, { desc: '结算弹窗' });
    };

    // ── c1. 经典单人（回归）：10 列、无画师 ──
    console.log('\n[c1] 经典单人（回归）');
    await page.goto(`${FRONTEND_ORIGIN}/game`, { waitUntil: 'load' });
    await page.locator('.menu-card', { hasText: '简单' }).first().click({ timeout: WAIT_TIMEOUT });
    await guessOnce();
    const h1 = await headers();
    check('c1.经典单人表头 10 列（名字+9）', h1.length === 10, `cols=${h1.length} [${h1.join('|')}]`);
    check('c1.经典单人无「画师」列', !h1.includes('画师'), `[${h1.join('|')}]`);

    // ── c2. 词条 chips 计数 ──
    console.log('\n[c2] 自建房词条 chips 计数');
    await page.goto(`${FRONTEND_ORIGIN}/game`, { waitUntil: 'load' });
    // ⚠️ 入口改版后：自定义词条是第二排的一张 .menu-card，**配置区默认收起**，
    //    要点开卡片才出现。此前是常驻的 `.card` + hasText('自定义词条')，改版后
    //    那个选择器一个也命中不了（.menu-card 不是 .card，且配置区还没渲染）。
    await page.locator('[data-testid="solo-custom-card"]').click({ timeout: WAIT_TIMEOUT });
    const card = page.locator('[data-testid="solo-custom-panel"]');
    await card.waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    const hint = card.locator('.cfg-hint');
    const hintText = () => hint.innerText();
    check('c2.标准态提示为「标准（9 列）」', (await hintText()).includes('9'), await hintText());

    // 精确匹配：'职业' 是 '子职业' 的子串，hasText 会同时命中两个 chip
    await card.locator('.tchip', { hasText: /^职业$/ }).click();
    check('c2.点标准词条「职业」→ 8/10', (await hintText()).startsWith('8/10'), await hintText());

    await card.locator('.btn-o', { hasText: '重置为标准' }).click();
    check('c2.重置回标准（9 列）', (await hintText()).includes('9'), await hintText());

    await card.locator('.tchip', { hasText: /^画师$/ }).click();
    check('c2.点「画师」→ 10/10', (await hintText()).startsWith('10/10'), await hintText());

    // ── c3. 自建房开局：11 列且含画师 ──
    console.log('\n[c3] 自建房开局');
    await card.locator('[data-testid="solo-custom-start"]').click({ timeout: WAIT_TIMEOUT });
    await guessOnce();
    const h3 = await headers();
    check('c3.自建房表头 11 列（名字+10）', h3.length === 11, `cols=${h3.length} [${h3.join('|')}]`);
    check('c3.自建房出现「画师」列', h3.includes('画师'), `[${h3.join('|')}]`);

    // ── c4. 不落档 ──
    console.log('\n[c4] 自建房不落档');
    await giveUpAndWaitDialog();
    const ls4 = await readLs();
    check('c4.自建房结束后未写 stats', ls4.stats === null, `stats=${ls4.stats}`);
    check('c4.自建房结束后未写 history', ls4.history === null, `history=${(ls4.history || '').slice(0, 60)}`);

    // ── c5. 再来一把保持自建房词条 ──
    console.log('\n[c5] 再来一把保持自建房词条');
    await page.locator('button', { hasText: '再来一把' }).click({ timeout: WAIT_TIMEOUT });
    await guessOnce();
    const h5 = await headers();
    check('c5.再来一把仍为自建房（11 列含画师）',
      h5.length === 11 && h5.includes('画师'), `cols=${h5.length} [${h5.join('|')}]`);

    // ── c6. 对照组：经典局结束会落档 ──
    console.log('\n[c6] 对照组：经典局结束会落档');
    await page.goto(`${FRONTEND_ORIGIN}/game`, { waitUntil: 'load' });
    await page.locator('.menu-card', { hasText: '简单' }).first().click({ timeout: WAIT_TIMEOUT });
    await guessOnce();
    await giveUpAndWaitDialog();
    const ls6 = await readLs();
    check('c6.经典局结束写入 stats', ls6.stats !== null, `stats=${(ls6.stats || '').slice(0, 60)}`);
    check('c6.经典局结束写入 history', ls6.history !== null, `history=${(ls6.history || '').slice(0, 60)}`);

    return 0;
  } catch (e) {
    console.error('\n❌ 单人自建房冒烟异常：', e.message);
    return 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (staticServer) staticServer.close();
    await killBackend(backend);
    await cleanupDb(DB_PATH);
  }
}

const exitCode = await main();
finish(exitCode);
