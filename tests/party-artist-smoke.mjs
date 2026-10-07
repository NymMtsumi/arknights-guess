#!/usr/bin/env node
// 派对模式「画师」词条 — 白名单 / 大厅面板 / 局内列（plan 阶段 9）
//
// 派对房是**自建房**，所以画师在这里应当可选。与多人自建房（阶段 5）不同，
// 派对**不涉及承重结构**：服务端下发的是 `comparisons` 对象（不是 colorRows 那种
// 定长位置数组），前端 GuessTable 走 displayAttributes 分支，所以本阶段的改动面很小 ——
//   1. server/constants.js 的白名单 ATTR_KEYS → ALL_ATTR_KEYS
//   2. 大厅词条面板换成共享组件 AttrChips（10 个 chip）
//   3. 已死的 party.standardColumns 键从两份 JSON 删除
// 正因为改动面小、失败形态又是静默的（chip 亮着但服务端过滤掉），更需要确定性断言。
//
// 覆盖：
//   a. 服务端白名单（裸 socket，确定性）
//      a1 传全 10 项（含 artist）→ settings.attributes 含 artist 且长度 10
//      a2 传标准 9 项（不含 artist）→ 长度 9 且**不含** artist（证明不是来者不拒）
//      a3 传 ['artist','artist','class','bogus'] → 过滤+去重后只剩 2 项 → 退化为标准（null）
//         —— 证明加宽白名单没有把「去重」和「<3 退化」这两条规则一起弄坏
//      a4 party:update_settings 走的是另一个入口（:410），单独验一次
//   b. 大厅词条面板（浏览器）
//      b1 chip 共 10 个，且含「画师」
//      b2 标准态：画师 chip 是灭的，提示语「标准（9 列）」
//         —— 若提示语仍是「标准（全部列）」就是错的：画师在标准态下是关的
//      b3 点画师 → 亮起，提示语 10/10
//      b4 再点一次 → 又灭（toggle 双向，不是单向加）
//   c. 端到端：带画师的派对房，局内表格
//      c1 表头含「画师」列
//      c2 猜一次后该行 11 个单元格，画师格有色（证明 comparisons.artist 真的落到了格子上）
//
// ⚠️ 未接入 scripts/smoke-all.sh（新增文件，不擅自改部署 gate）。
// 需要先 build：NEXT_PUBLIC_WS_URL=http://localhost:3101 npm run build
//   NODE_OPTIONS="--require ./tests/_dns-preload.cjs" node tests/party-artist-smoke.mjs

import {
  BACKEND_PORT, FRONTEND_ORIGIN, WAIT_TIMEOUT,
  check, finish, sleep, waitFor, makeDbPath,
  startStaticServer, startBackend, killBackend, waitForBackend, cleanupDb,
  requireBuild, requirePlaywright, newZhContext,
} from './helpers.mjs';

const DB_PATH = makeDbPath('party-artist');
const ALL_KEYS = ['class', 'subclass', 'faction', 'rarity', 'race', 'gender', 'releaseYear', 'position', 'tags', 'artist'];
const STD_KEYS = ALL_KEYS.filter(k => k !== 'artist');

/** 状态 → GuessTable 的类名（GuessTable.tsx:23-27） */
const GCELL_OK = ['ok', 'warn', 'no'];

async function main() {
  if (!requireBuild()) return 1;
  const chromium = await requirePlaywright();
  if (!chromium) return 1;

  const backend = startBackend({ dbPath: DB_PATH });
  const raw = [];
  let staticServer = null;
  let browser = null;
  let ctx = null;

  try {
    await waitForBackend(BACKEND_PORT);
    staticServer = await startStaticServer();
    browser = await chromium.launch({ headless: true });
    const { io } = await import('socket.io-client');

    const conn = (label) => new Promise((resolve, reject) => {
      const s = io(`http://localhost:${BACKEND_PORT}`, {
        transports: ['websocket'], forceNew: true,
        auth: { pk: `p_partyart${label}${'x'.repeat(10)}` },
      });
      s.on('connect', () => resolve(s));
      s.on('connect_error', reject);
      setTimeout(() => reject(new Error(`${label} 连接超时`)), WAIT_TIMEOUT);
    });
    const connect = async (label) => { const s = await conn(label); raw.push(s); return s; };
    const emitAck = (s, ev, data) => new Promise((resolve) => {
      s.timeout(WAIT_TIMEOUT).emit(ev, data, (err, resp) => resolve(err ? null : resp));
    });
    /** party:create 的 ack 只回 roomCode，settings 走 party:created 事件 */
    const createRoom = async (s, attrs) => {
      let got = null;
      s.once('party:created', (d) => { got = d; });
      const ack = await emitAck(s, 'party:create', { difficulty: 'hard', rounds: 3, roundTime: 60, attributes: attrs });
      await waitFor(() => got !== null, { desc: 'party:created' });
      return { ack, room: got.room };
    };
    const attrsOf = (room) => (Array.isArray(room?.settings?.attributes) ? room.settings.attributes : null);

    // ══════════════ a. 服务端白名单 ══════════════
    console.log('\n[a] 服务端词条白名单');
    const S1 = await connect('S1');
    const S2 = await connect('S2');
    const S3 = await connect('S3');
    const S4 = await connect('S4');

    const r1 = await createRoom(S1, ALL_KEYS);
    const a1 = attrsOf(r1.room);
    check('a1.白名单放行 artist（10 项全收）',
      !!a1 && a1.length === ALL_KEYS.length && a1.includes('artist'),
      `attributes=${JSON.stringify(a1)}`);

    const r2 = await createRoom(S2, STD_KEYS);
    const a2 = attrsOf(r2.room);
    check('a2.标准 9 项不含 artist（白名单不是来者不拒）',
      !!a2 && a2.length === STD_KEYS.length && !a2.includes('artist'),
      `attributes=${JSON.stringify(a2)}`);

    const r3 = await createRoom(S3, ['artist', 'artist', 'class', 'bogus']);
    const a3 = attrsOf(r3.room);
    check('a3.非法项被过滤、重复被去重、不足 3 项退化为标准',
      a3 === null,
      `attributes=${JSON.stringify(a3)}（期望 null：artist+class 去重后仅 2 项）`);

    // a4. update_settings 是第二个入口（party-room.js:410）
    const a4attrs = ['class', 'faction', 'artist'];
    let upd = null;
    S4.on('party:settings_updated', (d) => { upd = d; });
    await emitAck(S4, 'party:create', { difficulty: 'hard', rounds: 3, roundTime: 60 });
    await emitAck(S4, 'party:update_settings', { attributes: a4attrs });
    await waitFor(() => upd !== null, { desc: 'party:settings_updated' }).catch(() => {});
    check('a4.update_settings 同样放行 artist',
      !!upd && Array.isArray(upd.settings?.attributes) && upd.settings.attributes.includes('artist'),
      `settings.attributes=${JSON.stringify(upd?.settings?.attributes)}`);

    // ══════════════ b. 大厅词条面板 ══════════════
    console.log('\n[b] 大厅词条面板');
    ctx = await newZhContext(browser);
    const P = await ctx.newPage();
    await P.goto(`${FRONTEND_ORIGIN}/party`, { waitUntil: 'load' });
    await P.locator('[data-testid="party-menu-join"]').click({ timeout: WAIT_TIMEOUT });
    await P.locator('[data-testid="party-create"]').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });

    const chips = P.locator('.cfg-row .tchip');
    const chipCount = await chips.count();
    const artistChip = P.locator('.tchip', { hasText: /^画师$/ });
    check('b1.词条 chip 共 10 个且含「画师」',
      chipCount === ALL_KEYS.length && (await artistChip.count()) === 1,
      `chip 数=${chipCount}（期望 ${ALL_KEYS.length}）`);

    const hint = () => P.locator('.cfg-hint').last().textContent();
    // 标准态：画师灭 + 提示语「标准（9 列）」
    const clsStd = (await artistChip.getAttribute('class')) || '';
    const hintStd = (await hint() || '').trim();
    check('b2.标准态画师 chip 灭、提示语为 9 列',
      clsStd.includes('off') && hintStd.includes('9'),
      `class="${clsStd}" hint="${hintStd}"`);

    await artistChip.click({ timeout: WAIT_TIMEOUT });
    await waitFor(async () => ((await artistChip.getAttribute('class')) || '').includes('on'), { desc: '画师 chip 亮起' });
    const hintOn = (await hint() || '').trim();
    check('b3.点画师后亮起、计数变 10/10',
      hintOn.includes(`10/${ALL_KEYS.length}`),
      `hint="${hintOn}"`);

    await artistChip.click({ timeout: WAIT_TIMEOUT });
    await waitFor(async () => ((await artistChip.getAttribute('class')) || '').includes('off'), { desc: '画师 chip 熄灭' });
    check('b4.再点一次又灭（toggle 双向）',
      ((await artistChip.getAttribute('class')) || '').includes('off'), 'class 回到 off');

    // ══════════════ c. 端到端：局内表格 ══════════════
    console.log('\n[c] 端到端：带画师的派对房');
    // 浏览器当房主、开画师，两个裸客户端凑够 MIN_PLAYERS=3 并准备
    await artistChip.click({ timeout: WAIT_TIMEOUT }); // 重新点上画师
    await waitFor(async () => ((await artistChip.getAttribute('class')) || '').includes('on'), { desc: '画师已选中' });
    await P.locator('[data-testid="party-create"]').click({ timeout: WAIT_TIMEOUT });
    const code = (await P.locator('[data-testid="party-room-code"]').textContent()).trim();
    check('c0.带画师建房成功（6 位房号）', /^\d{6}$/.test(code), code);

    const J1 = await connect('J1');
    const J2 = await connect('J2');
    await emitAck(J1, 'party:join', { roomCode: code });
    await emitAck(J2, 'party:join', { roomCode: code });
    await sleep(400);
    await emitAck(J1, 'party:toggle_ready', {});
    await emitAck(J2, 'party:toggle_ready', {});
    // 房主是浏览器，start 只能由它点（服务端校验 hostId）
    await P.locator('[data-testid="party-start"]').click({ timeout: WAIT_TIMEOUT });
    await P.locator('[data-testid="party-game"]').waitFor({ state: 'visible', timeout: 20_000 });

    // ⚠️ GuessTable 在 guesses.length === 0 时直接 return null（GuessTable.tsx:127），
    //    **必须先猜一次表格才存在**。这是既有行为，不是本阶段引入的。
    const pool = P.locator('input.game-search-input');
    await pool.click({ timeout: WAIT_TIMEOUT });
    await pool.fill('虎狼丸');
    await P.keyboard.press('Enter');

    const table = P.locator('table.game-table');
    try {
      await table.waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    } catch (e) {
      const html = await P.locator('[data-testid="party-game"]').innerHTML().catch(() => '(取不到)');
      console.error('── 表格未出现，party-game 内容 ──');
      console.error(html.slice(0, 1200));
      throw e;
    }
    const heads = await table.locator('thead th').allTextContents();
    check('c1.局内表头含「画师」列',
      heads.some(h => h.trim() === '画师') && heads[heads.length - 1].trim() === '画师',
      `表头=[${heads.map(h => h.trim()).join(' | ')}]`);

    await waitFor(async () => (await table.locator('tbody tr').count()) >= 1, { desc: '出现 1 行猜测' });

    // 颜色类在 <td> 里那层 <div class="gcell …">，不在 td 上（GuessTable.tsx:35,174）
    const firstRow = table.locator('tbody tr').first();
    const gcells = await firstRow.locator('.gcell').evaluateAll(ds => ds.map(d => d.className));
    const colored = gcells.filter(c => GCELL_OK.some(k => c.split(/\s+/).includes(k)));
    const lastIsArtist = colored.length === ALL_KEYS.length
      && GCELL_OK.some(k => gcells[gcells.length - 1].split(/\s+/).includes(k))
      && heads[heads.length - 1].trim() === '画师';
    check('c2.猜测行 11 格、10 格有色、末格（画师）有色',
      gcells.length === ALL_KEYS.length + 1 && lastIsArtist,
      `格数=${gcells.length} 有色=${colored.length} 末格 class="${gcells[gcells.length - 1]}" 末列表头="${heads[heads.length - 1].trim()}"`);

    // ══════════════ d. 反向：标准派对房不得出现画师列 ══════════════
    // 这是「画师只在自建房」的结构性保证在派对侧的落点：房主不碰词条面板时
    // attributes === null，前端走 buildColumns 的标准分支（PARTY_ATTR_KEYS，9 项）。
    // 用独立 context + 独立裸客户端，避开上一局的状态。
    console.log('\n[d] 反向：标准派对房无画师列');
    const ctxD = await newZhContext(browser);
    const Q = await ctxD.newPage();
    await Q.goto(`${FRONTEND_ORIGIN}/party`, { waitUntil: 'load' });
    await Q.locator('[data-testid="party-menu-join"]').click({ timeout: WAIT_TIMEOUT });
    await Q.locator('[data-testid="party-create"]').click({ timeout: WAIT_TIMEOUT });
    const codeD = (await Q.locator('[data-testid="party-room-code"]').textContent()).trim();
    const J3 = await connect('J3');
    const J4 = await connect('J4');
    await emitAck(J3, 'party:join', { roomCode: codeD });
    await emitAck(J4, 'party:join', { roomCode: codeD });
    await sleep(400);
    await emitAck(J3, 'party:toggle_ready', {});
    await emitAck(J4, 'party:toggle_ready', {});
    await Q.locator('[data-testid="party-start"]').click({ timeout: WAIT_TIMEOUT });
    await Q.locator('[data-testid="party-game"]').waitFor({ state: 'visible', timeout: 20_000 });

    const poolQ = Q.locator('input.game-search-input');
    await poolQ.click({ timeout: WAIT_TIMEOUT });
    await poolQ.fill('虎狼丸');
    await Q.keyboard.press('Enter');
    const tableQ = Q.locator('table.game-table');
    await tableQ.waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    const headsQ = (await tableQ.locator('thead th').allTextContents()).map(h => h.trim());
    const cellsQ = (await tableQ.locator('tbody tr').first().locator('.gcell').evaluateAll(ds => ds.map(d => d.className)));
    check('d1.标准派对房表头无「画师」，词条列 9 项',
      !headsQ.includes('画师') && headsQ.length === STD_KEYS.length + 1 && cellsQ.length === STD_KEYS.length + 1,
      `表头=${headsQ.length} 列 [${headsQ.join(' | ')}] 格数=${cellsQ.length}`);
    await ctxD.close().catch(() => {});

    await sleep(200);
  } finally {
    for (const s of raw) { try { s.disconnect(); } catch {} }
    if (ctx) { try { await ctx.close(); } catch {} }
    if (browser) { try { await browser.close(); } catch {} }
    if (staticServer) { try { staticServer.close(); } catch {} }
    await killBackend(backend);
    await sleep(300);
    cleanupDb(DB_PATH);
  }
  return 0;
}

const exitCode = await main();
finish(exitCode);
