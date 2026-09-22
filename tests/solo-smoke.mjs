#!/usr/bin/env node
// 单人/每日/排行榜/统计 — UI 级冒烟测试（Playwright 单 BrowserContext）
//
// 覆盖 checklist：
//   s1. 单人 /game：选难度 → 输入真实干员名 → 提交 → 出现 game-table（猜测已登记）
//   s2. 每日 /daily：进入即 playing（临时 DB 无记录）→ 猜一个干员 → 出现 game-table
//   s3. 排行榜 /leaderboard：标题 + 三 tab（单人/多人/每日）+ 切「每日」后难度筛选隐藏
//   s2b.每日 /daily 刷新页面：猜测记录从服务端 history 重建（不是「记录消失」）
//   s4. 统计 /stats：标题 + 空数据态（临时 DB 无战绩 →「暂无游戏记录」）
//   s5. 每日会话被清扫后不再发放次数（防挂机刷当日排行榜；独立短 TTL 后端）
//
// 目标干员客户端随机、不可预知，故「不追求猜对」，只验证「能玩、有正确反馈」。
// 干员名从 src/data/characters.json 取第一个（与前端 findCharacterByName 同源，必然可命中）。

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ROOT, FRONTEND_ORIGIN, WAIT_TIMEOUT, BACKEND_PORT,
  check, finish, waitFor, sleep, makeDbPath,
  startStaticServer, startBackend, killBackend, waitForBackend, cleanupDb,
  requireBuild, requirePlaywright, newZhContext,
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
    const ctx = await newZhContext(browser);
    const page = await ctx.newPage();

    // ── s1. 单人 /game ──
    console.log('\n[s1] 单人模式');
    await page.goto(`${FRONTEND_ORIGIN}/game`, { waitUntil: 'load' });
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
    await page.goto(`${FRONTEND_ORIGIN}/daily`, { waitUntil: 'load' });
    const search2 = page.locator('input.game-search-input');
    await search2.waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    check('s2.进入即 playing（搜索框出现，临时 DB 无记录）', true);

    await search2.fill(knownName);
    await search2.press('Enter');
    await page.locator('table.game-table').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    check('s2.提交猜测后出现 game-table', true);

    // ── s2b. 刷新页面后猜测记录仍在（/api/daily/status 的 history 往返）──
    // 浏览器会用 SameSite=Lax 的 player_key cookie（apiCall 带 credentials:'include'）
    // 认回同一个会话，服务端把 history 回传给 daily-store 重建整张猜测表。
    // 这条链路（服务端 history → 客户端 rebuild）修过一次「中途退出记录消失」，
    // 在这里钉住，免得再退化回去。
    console.log('\n[s2b] 每日刷新后重建猜测表');
    await page.reload({ waitUntil: 'load' });
    let dailyRows = 0;
    try {
      await waitFor(async () => (await page.locator('table.game-table tbody tr').count()) >= 1, { desc: '重建的猜测行' });
      dailyRows = await page.locator('table.game-table tbody tr').count();
    } catch {
      dailyRows = await page.locator('table.game-table tbody tr').count().catch(() => 0);
    }
    check('s2b.刷新后猜测记录被重建（history 往返）', dailyRows >= 1, `rows=${dailyRows}`);

    // ── s3. 排行榜 /leaderboard ──
    console.log('\n[s3] 排行榜');
    await page.goto(`${FRONTEND_ORIGIN}/leaderboard`, { waitUntil: 'load' });
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
    await page.goto(`${FRONTEND_ORIGIN}/stats`, { waitUntil: 'load' });
    await page.locator('h1', { hasText: '游戏统计' }).waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    check('s4.标题「游戏统计」渲染', true);
    await page.locator('text=暂无游戏记录').first().waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    check('s4.空数据态「暂无游戏记录」渲染（临时 DB 无战绩）', true);

    // ── s5. 每日会话被清扫后不再发放次数（防挂机刷当日排行榜）──
    // 单独起一个后端：TTL / 清扫间隔由环境变量覆盖成毫秒级，否则要等满 1 小时。
    // 不设变量时这两个值就是生产值（1 小时 / 5 分钟），线上行为不受影响。
    // 场景：猜 1 次 → 挂机到会话被清扫 → 再猜。
    // 拦不住的话这里会新建会话、次数回满 8 次（未完成的局在 DB 里没有记录可回填）。
    console.log('\n[s5] 每日会话清扫后不再发放次数');
    // 端口从 BACKEND_PORT 推导，不写死：smoke-all.sh / smoke.sh 都用
    // SMOKE_BACKEND_PORT 覆盖主端口，写死会在并行运行时撞车 —— 更糟的是若 3102
    // 恰好被别人的后端占着，waitForBackend 会连上去，那条后端没有短 TTL，
    // 于是「第二次猜测返回 200」被误报成业务失败。
    const TTL_PORT = BACKEND_PORT + 1;
    const TTL_BASE = `http://localhost:${TTL_PORT}`;
    const TTL_DB = makeDbPath('daily-ttl');
    const ttlBackend = startBackend({
      port: TTL_PORT, dbPath: TTL_DB,
      extraEnv: { DAILY_SESSION_TTL_MS: '1500', DAILY_SWEEP_INTERVAL_MS: '300' },
    });
    let ttlPass = false;
    try {
      await waitForBackend(TTL_PORT);
      const pk = `p_smoke_ttl_${Math.random().toString(36).slice(2, 10)}`;
      const guess = (name) => fetch(`${TTL_BASE}/api/daily/guess`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, player_key: pk }),
      }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));

      // 首猜：必须是一次「没猜中」的普通猜测，否则会话直接结算，测不到清扫。
      // 循环在**第一次未命中就 break**，所以 first=null 只可能是 characters[0] 恰为当日
      // 目标（1/429，按 UTC 日确定性 → 命中当天会稳定失败一整天）。
      // 失败信息带上最后一次响应，免得把这种彩票说成「5 个候选全部命中」。
      let first = null;
      let last = null;
      for (const c of characters.slice(0, 5)) {
        last = await guess(c.name);
        if (last.status === 200 && !last.data?.won && !last.data?.lost) { first = last.data; break; }
      }
      check('s5.建立进行中的会话（首猜未命中，剩余 7 次）',
        first?.remainingGuesses === 7,
        first
          ? `remaining=${first.remainingGuesses}`
          : `未取得进行中的会话：最后一次 status=${last?.status} body=${JSON.stringify(last?.data)?.slice(0, 120)}`);

      // 余量按最坏相位算：判定是 `now - lastActiveAt > TTL`（严格大于），
      // 最坏情况是第 5 次 tick 恰好落在 1500ms → 下一次才清扫，即 TTL + 一个间隔 ≈ 1800ms
      // （本机实测 setInterval(300) 平均 311ms）。取 4000ms 留 ≈2.2s 余量，
      // 避免 CI 上同时跑两个后端 + Chromium 时被事件循环阻塞吃掉。
      await sleep(4000);

      const again = await guess(characters[0].name);
      check('s5.清扫后再猜 → 409 且标记 voided（不新建会话）',
        again.status === 409 && again.data?.voided === true,
        `status=${again.status} voided=${again.data?.voided} remaining=${again.data?.remainingGuesses}`);

      const st = await fetch(`${TTL_BASE}/api/daily/status`, { headers: { 'X-Player-Key': pk } })
        .then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
      check('s5.status 报 voided 且不报 inProgress（前端据此显示「今日已挑战」）',
        st.data?.voided === true && !st.data?.inProgress,
        `voided=${st.data?.voided} inProgress=${st.data?.inProgress}`);
      ttlPass = true;
    } finally {
      killBackend(ttlBackend);
      await cleanupDb(TTL_DB);
    }
    if (!ttlPass) console.error('   （s5 未走完，见上方失败项）');

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
