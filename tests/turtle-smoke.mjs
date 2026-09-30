#!/usr/bin/env node
// 海龟汤 /turtle —— UI 级冒烟（plan 阶段 7）
//
// routes-smoke 只证明「页面能打开、无 JS 报错」。本脚本补上它**测不到**的那一半：
// 页面与 store 的接线是否真的通（把 ask(field, value) 写错、选项接错池子，
// routes-smoke 全绿而游戏已经坏了）。
//
// 三条关键断言各钉一个**已定**的设计决定：
//   a3/a4/a5 取值域与谜底**同源**（都用难度池）——
//            easy 池只有 3 种星级、2 种性别、68 个子职业；全量池是 6/5/72。
//            谁把取值域改成全量，这三条立刻红。
//   b1       提问的三级反馈 + 数值维方向提示：对 easy 的 3 个星级各问一次，
//            **恰好 1 个「准确」、另外 2 个都带 ↑/↓**（不必知道谜底，确定性成立）。
//   c3       端到端交叉验证：b1 里答「准确」的那个星级，必须等于结算卡上揭晓的谜底星级。
//            （揭晓的谜底是从 DOM 读的，不是从 store —— store 没有对外暴露，本项目也没有
//             `window.__xxx` 测试钩子的先例，不为此在产物里加后门。）
//
// ⚠️ 提问交互在「提问面板改版」时换过：原来的「维度下拉 + 取值下拉 + 提问按钮」
//    （`turtle-dim` / `turtle-value` / `turtle-ask`）已全部移除，改成 9 个常驻行 + 取值 chip
//    **点一下即提问**。本脚本跟着改的是「怎么触发一次提问」；被断言的**事实**没变，
//    仍读提问记录里的 `data-raw`（未格式化的取值），不靠拆展示字符串。
//    新形态下多出两条值得钉住的东西，见 a5b（拼音筛选）与 a2（不再有提交按钮）。
//
// ⚠️ 未接入 scripts/smoke-all.sh（新增文件，不擅自改部署 gate）。
// 需要先 build：NEXT_PUBLIC_WS_URL=http://localhost:3101 npm run build
//   NODE_OPTIONS="--require ./tests/_dns-preload.cjs" node tests/turtle-smoke.mjs

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pinyin } from 'pinyin-pro';
import {
  ROOT, BACKEND_PORT, FRONTEND_ORIGIN, WAIT_TIMEOUT,
  check, finish, sleep, waitFor, makeDbPath,
  startStaticServer, startBackend, killBackend, waitForBackend, cleanupDb,
  requireBuild, requirePlaywright, newZhContext,
} from './helpers.mjs';

/** easy 难度池 = 热门 ∪ 六星（src/lib/game-engine.ts:11）—— 取值域的唯一来源 */
const EASY_RARITIES = [4, 5, 6];
const EASY_GENDERS = 2;
const EASY_SUBCLASSES = 68;
const FULL_RARITIES = 6; // 用来在失败信息里点明「你接的是全量池」

async function main() {
  if (!requireBuild()) return 1;
  const chromium = await requirePlaywright();
  if (!chromium) return 1;

  const chars = JSON.parse(readFileSync(join(ROOT, 'src', 'data', 'characters.json'), 'utf8'));
  // 大字集（子职业）的筛选用例要一个**一定在 easy 池里**的取值
  const easySubclasses = [...new Set(
    chars.filter(c => c.popularity === 'hot' || c.rarity >= 6).map(c => c.subclass),
  )];
  const DB_PATH = makeDbPath('turtle');
  const backend = startBackend({ dbPath: DB_PATH });
  let staticServer = null;
  let browser = null;
  let ctx = null;
  let ctx2 = null;

  try {
    await waitForBackend(BACKEND_PORT);
    staticServer = await startStaticServer();
    browser = await chromium.launch({ headless: true });
    ctx = await newZhContext(browser);
    const P = await ctx.newPage();
    const pageErrors = [];
    P.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));

    const rows = () => P.locator('[data-testid="turtle-log-row"]');
    const toolRows = () => P.locator('[data-testid^="turtle-row-"]');
    const attemptsText = () => P.locator('[data-testid="turtle-attempts"]').textContent();
    /**
     * chip 的 testid 尾部就是取值本身 —— 读它比拆展示文本（星级是星条）可靠。
     *
     * ⚠️ 两个坑，都是实测踩出来的：
     *   1. `prefix` 必须**当参数传进** evaluateAll，不能靠闭包 —— 回调体在浏览器里
     *      序列化执行，闭包里的 Node 变量一律不存在（第一版：`field is not defined`）。
     *   2. 传**整条前缀**而不是 `field` 再在浏览器里拼：自己拼长度时差一就会把
     *      testid 的尾部分隔符一起切进来，取值变成 `-执旗手`。这种错法在
     *      `a4`（只数个数）与 `Array.includes`（严格相等，不是子串）下**都看不出来**，
     *      只有 `a3` 的字符串比对会红 —— 所以别在这里手工算长度。
     */
    const chipValues = (scope, field) => {
      const prefix = `turtle-chip-${field}-`;
      return scope
        .locator(`[data-testid^="${prefix}"]`)
        .evaluateAll((els, p) => els.map(e => e.getAttribute('data-testid').slice(p.length)), prefix);
    };

    /**
     * 点一个取值 chip = 提问一次，等日志多一行。
     * 大字集（种族/阵营/子职业）默认只铺前 12 个候选，取值不在其中时先筛选再点。
     */
    const askOne = async (pg, field, value) => {
      const before = await rows().count();
      const chip = pg.locator(`[data-testid="turtle-chip-${field}-${value}"]`);
      if ((await chip.count()) === 0) {
        await pg.locator(`[data-testid="turtle-search-${field}"]`).fill(String(value));
      }
      await chip.first().click({ timeout: WAIT_TIMEOUT });
      await waitFor(async () => (await rows().count()) === before + 1, { desc: `提问后日志 +1（${field}=${value}）` });
      const row = rows().nth(before);
      return {
        value: await row.locator('[data-testid="turtle-log-value"]').getAttribute('data-raw'),
        text: (await row.locator('[data-testid="turtle-log-value"]').textContent()).trim(),
        level: (await row.locator('[data-testid="turtle-log-level"]').textContent()).trim(),
        hint: (await row.locator('[data-testid="turtle-log-hint"]').count()) > 0,
      };
    };

    await P.goto(`${FRONTEND_ORIGIN}/turtle`, { waitUntil: 'load' });

    // ══════════════ a. 开局与取值域 ══════════════
    console.log('\n[a] 开局与提问取值域');
    check('a1.未开局时三档难度卡都在',
      (await P.locator('[data-testid^="turtle-start-"]').count()) === 3,
      `难度卡 ${await P.locator('[data-testid^="turtle-start-"]').count()} 张`);

    await P.locator('[data-testid="turtle-start-easy"]').click({ timeout: WAIT_TIMEOUT });
    await waitFor(async () => await P.locator('[data-testid="turtle-attempts"]').count() === 1, { desc: '进入局中' });
    const startAttempts = (await attemptsText() || '').trim();
    // 9 个维度必须**同时可见**（改版的核心：不再有「选维度」这个模式），
    // 且不能再有提交按钮（点取值即提问）。
    const rowCount = await toolRows().count();
    const submitCount = await P.locator('[data-testid="turtle-ask"]').count();
    check('a2.开局后剩余 24 次、9 个维度行同时可见、无独立提交按钮',
      startAttempts.includes('24') && rowCount === 9 && submitCount === 0,
      `剩余="${startAttempts}" 维度行=${rowCount}（期望 9） 提交按钮=${submitCount}（期望 0）`);

    // 星级是 chip 行（6 级以下全铺）→ 直接数 chip
    const rarityChips = P.locator('[data-testid^="turtle-chip-rarity-"]');
    await waitFor(async () => (await rarityChips.count()) > 0, { desc: '星级 chip 铺开' });
    const rarities = await chipValues(P, 'rarity');
    check(`a3.星级取值域 = easy 池的 ${EASY_RARITIES.length} 种（全量池是 ${FULL_RARITIES}，改错池子这里红）`,
      rarities.length === EASY_RARITIES.length
        && rarities.map(Number).sort((x, y) => x - y).join(',') === EASY_RARITIES.join(','),
      `实际 [${rarities.join(',')}]，期望 [${EASY_RARITIES.join(',')}]`);

    // 星级 chip 的**标签**是星条而不是裸数字 —— formatOption 是面板与记录共用的那一份
    const fourStarLabel = (await P.locator('[data-testid="turtle-chip-rarity-4"]').textContent() || '').trim();
    check('a3b.星级 chip 画的是 6 格星条（与 GameSearch / 猜测表同一种星级记号）',
      fourStarLabel === '★'.repeat(4) + '☆'.repeat(2),
      `4★ 的 chip 文本="${fourStarLabel}"，期望 "${'★'.repeat(4)}${'☆'.repeat(2)}"`);

    const genders = await chipValues(P, 'gender');
    check(`a4.性别取值域 = ${EASY_GENDERS} 种（easy 池只有男女；全量池是 5）`,
      genders.length === EASY_GENDERS,
      `实际 ${genders.length} 种 [${genders.join(',')}]`);

    // 子职业是**大字集** → 走筛选框，候选被截断到 12，所以取值域大小看那行末尾的计数
    const subclassCount = P.locator('[data-testid="turtle-count-subclass"]');
    await waitFor(async () => (await subclassCount.count()) === 1, { desc: '子职业计数' });
    const subclassTotal = Number(((await subclassCount.textContent()) || '').match(/\d+/)?.[0]);
    check(`a5.子职业取值域 = ${EASY_SUBCLASSES} 种（easy 池；全量池是 72）`,
      subclassTotal === EASY_SUBCLASSES,
      `实际 ${subclassTotal}（读的是行尾计数，不是候选 chip —— 候选有 12 个上限）`);

    // 筛选框真的能筛：中文子串命中；再验拼音命中（valueSearchIndex 拼了 全拼 + 首字母）
    const probe = easySubclasses[0];
    const probeInput = P.locator('[data-testid="turtle-search-subclass"]');
    await probeInput.fill(probe);
    await waitFor(async () => (await chipValues(P, 'subclass')).includes(probe),
      { desc: `按中文筛出「${probe}」` });
    const pyProbe = pinyin(probe, { toneType: 'none', type: 'array' }).join('');
    await probeInput.fill(pyProbe);
    await waitFor(async () => (await chipValues(P, 'subclass')).includes(probe),
      { desc: `按拼音「${pyProbe}」筛出「${probe}」` });
    check(`a5b.子职业筛选：中文子串与拼音都能命中（「${probe}」/「${pyProbe}」）`, true);
    await probeInput.fill(''); // 清掉，免得影响后面按 testid 直接点 chip 的用例

    // 大字集的候选**只在敲了字之后出现**，空查询一个都不铺。
    // ⚠️ 这一条必须显式写：askOne 在找不到 chip 时会先往筛选框里填值再点，所以它对
    //    「到底有没有铺候选」是**免疫**的 —— 不写这条，将来谁把候选铺回空查询，
    //    所有用例照样全绿，而面板会悄悄长回一屏半高。
    // 也**不能**用 waitFor 等它变成 0：那就成了「等到为 0 再断言为 0」，恒真。
    const BIG_FIELDS = ['race', 'faction', 'subclass'];
    const emptyPeek = {};
    for (const f of BIG_FIELDS) {
      await P.locator(`[data-testid="turtle-search-${f}"]`).fill('');
      emptyPeek[f] = (await chipValues(P, f)).length;
    }
    await P.locator('[data-testid="turtle-search-subclass"]').fill('zzzzzz');
    await waitFor(async () => (await P.locator('[data-testid="turtle-nomatch-subclass"]').count()) === 1,
      { desc: '无匹配提示出现' });
    const noMatchChips = (await chipValues(P, 'subclass')).length;
    await P.locator('[data-testid="turtle-search-subclass"]').fill('');
    check('a6.大字集空查询不铺候选；敲字无匹配时给「没有匹配项」而不是空行',
      BIG_FIELDS.every(f => emptyPeek[f] === 0) && noMatchChips === 0,
      `空查询候选 ${BIG_FIELDS.map(f => `${f}=${emptyPeek[f]}`).join(' ')}（期望全 0）；`
        + `无匹配时候选 ${noMatchChips} 个（期望 0，且「没有匹配项」已出现）`);

    // ══════════════ b. 提问 ══════════════
    console.log('\n[b] 提问的三级反馈与方向提示');
    // 对 easy 的 3 个星级各问一次：谜底只有一个星级，所以必然恰好 1 个「准确」
    const asked = [];
    for (const r of EASY_RARITIES) asked.push(await askOne(P, 'rarity', r));
    const correctOnes = asked.filter(a => a.level === '准确');
    const withHint = asked.filter(a => a.hint);
    check('b1.三个星级各问一次：恰好 1 个「准确」，另 2 个都带 ↑/↓ 方向提示',
      correctOnes.length === 1 && withHint.length === 2,
      asked.map(a => `${a.value}→${a.level}${a.hint ? '+提示' : '（无提示）'}`).join(' | '));

    // 问过的取值要变暗（面板对 24 次共享池的提示）—— 这是改版新增的一条
    const askedChipOff = await P.locator(`[data-testid="turtle-chip-rarity-${correctOnes[0].value}"]`)
      .evaluate(el => el.classList.contains('off') && !el.disabled);
    check('b1b.问过的取值 chip 变暗但仍可点（提示而非拦截）', askedChipOff,
      `class 含 off 且未 disabled = ${askedChipOff}`);

    const afterAsks = (await attemptsText() || '').trim();
    check('b2.问 3 次 → 剩余次数 24→21（提问与猜测共用同一个池）',
      afterAsks.includes('21'),
      `剩余="${afterAsks}"（开局时 "${startAttempts}"）`);

    // ══════════════ c. 猜测与结算 ══════════════
    console.log('\n[c] 点名猜测与结算');
    const targetRarity = Number(correctOnes[0].value);
    // 挑一个**星级不等于谜底**的干员 → 这次猜测必然不中，局面不会提前结束
    const wrongPick = chars.find(c => c.rarity !== targetRarity && c.name && c.name.length <= 6);
    check('c0.能找到用于「必不中」的猜测目标',
      !!wrongPick, wrongPick ? `${wrongPick.name}（${wrongPick.rarity}★ vs 谜底 ${targetRarity}★）` : '找不到');

    const input = P.locator('input.game-search-input');
    await input.click({ timeout: WAIT_TIMEOUT });
    await input.fill(wrongPick.name);
    await sleep(300); // 等 150ms 防抖出下拉
    await P.keyboard.press('Enter');
    await waitFor(async () => (await P.locator('[data-testid="turtle-guess-item"]').count()) === 1, { desc: '猜测记录出现' });
    const guessText = (await P.locator('[data-testid="turtle-guess-item"]').first().textContent() || '').trim();
    // 「仍在局中」看剩余次数徽标——它只在 playing 时渲染
    const stillPlaying = (await P.locator('[data-testid="turtle-attempts"]').count()) === 1;
    check('c1.猜一个星级不同的干员 → 未结算、次数再 -1、名字进猜测记录',
      guessText === wrongPick.name && stillPlaying && (await attemptsText() || '').includes('20'),
      `记录="${guessText}" 仍在局中=${stillPlaying} 剩余="${(await attemptsText() || '').trim()}"`);

    await P.locator('[data-testid="turtle-give-up"]').click({ timeout: WAIT_TIMEOUT });
    await P.locator('[data-testid="turtle-answer"]').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    const answerName = (await P.locator('[data-testid="turtle-answer"]').textContent() || '').trim();
    const answerMeta = (await P.locator('[data-testid="turtle-answer-meta"]').textContent() || '').trim();
    check('c2.放弃 → 揭晓谜底卡出现，且谜底不是刚猜过的那个',
      answerName.length > 0 && answerName !== wrongPick.name,
      `谜底="${answerName}" 元信息="${answerMeta}" 猜过="${wrongPick.name}"`);

    // 端到端交叉验证：揭晓的谜底星级必须等于 b1 里唯一答「准确」的那个星级
    const metaRarity = (answerMeta.match(/(\d+)\s*星/) || [])[1];
    check('c3.揭晓的谜底星级 === 唯一答「准确」的那个星级（引擎↔页面端到端一致）',
      metaRarity !== undefined && Number(metaRarity) === targetRarity,
      `揭晓 ${metaRarity}★ vs 答「准确」的 ${targetRarity}★（元信息 "${answerMeta}"）`);

    check('c4.结算后提问面板收起、「再来一把」出现',
      (await toolRows().count()) === 0 && (await P.locator('[data-testid="turtle-restart"]').count()) === 1,
      `维度行 ${await toolRows().count()} 个、重开按钮 ${await P.locator('[data-testid="turtle-restart"]').count()} 个`);

    // ══════════════ d. 重开不残留 ══════════════
    console.log('\n[d] 重开');
    await P.locator('[data-testid="turtle-restart"]').click({ timeout: WAIT_TIMEOUT });
    await waitFor(async () => (await P.locator('[data-testid^="turtle-start-"]').count()) === 3, { desc: '回到未开局' });
    check('d1.重开后回到未开局（三张难度卡）',
      (await P.locator('[data-testid^="turtle-start-"]').count()) === 3,
      '三张难度卡可见');
    // ⚠️ 不能拿整页 innerText 做子串匹配：干员「年」与 howTo2 的「上线**年份**」撞车，
    //    实测全池 429 人里正好 1 个单字名会误伤（多字名 0 个），每局约 1/153 概率假红。
    //    改成「有没有哪个元素的**整段文本**就是谜底名」—— 真泄漏时名字必然是某个
    //    叶子元素的完整内容（答案卡、下拉项、猜测记录），而「上线年份」整段不等于「年」。
    const leaked = await P.evaluate((name) => {
      return Array.from(document.querySelectorAll('body *'))
        .filter(el => el.children.length === 0 && (el.textContent || '').trim() === name)
        .map(el => `${el.tagName.toLowerCase()}${el.dataset.testid ? `[${el.dataset.testid}]` : ''}`)
        .slice(0, 3);
    }, answerName);
    check('d2.上一局的谜底名没有留在页面上（状态确实被清空）',
      leaked.length === 0 && (await P.locator('[data-testid="turtle-answer"]').count()) === 0,
      leaked.length
        ? `仍渲染在 ${leaked.join(' / ')}，且答案卡 ${await P.locator('[data-testid="turtle-answer"]').count()} 个`
        : `无任何元素整段等于"${answerName}"，答案卡 0 个`);

    // ══════════════ e. 英文不露原始键名 ══════════════
    // plan 的手工验收第 6 条（「切到 en 不能出现原始键名」）在这里机器化。
    // i18n 哨兵只保证两份 JSON 键集合一致、且 t('字面量') 的键两边都在；
    // 「渲染出来是不是键名本身」只有真跑一次才知道。
    console.log('\n[e] 英文');
    const before = await P.locator('body').innerText();
    await P.getByRole('button', { name: 'Switch language' }).click({ timeout: WAIT_TIMEOUT });
    await waitFor(async () => (await P.locator('body').innerText()) !== before, { desc: '切到英文' });
    const enText = await P.locator('body').innerText();
    const rawKeys = enText.match(/\b(?:turtle|game|menu|table|party|multi)\.[a-zA-Z][a-zA-Z0-9.]*/g) || [];
    check('e1.切到英文后，页面上没有裸露的 i18n 键名',
      rawKeys.length === 0,
      rawKeys.length ? `露出 ${rawKeys.length} 个：${[...new Set(rawKeys)].slice(0, 6).join(', ')}` : '0 个');
    check('e2.英文下海龟汤标题与规则文案确实换成了英文',
      /Turtle Soup/i.test(enText) && /attempts/i.test(enText),
      `标题命中 Turtle Soup=${/Turtle Soup/i.test(enText)}，正文含 attempts=${/attempts/i.test(enText)}`);

    // ══════════════ f. 结算落档 → 海龟汤榜（登录态端到端） ══════════════
    // a–e 全跑在**未登录**上下文里，而 saveTurtleStats 对游客直接 return ——
    // 也就是说「结算时页面到底有没有把成绩提交上去」这段接线，到这里一行都没被执行过。
    // 这一节换成真 JWT（API 注册→验证拿到的），打完一局后直接查服务端榜单。
    console.log('\n[f] 结算落档到海龟汤榜（登录态）');
    let ipSeq = 0;
    const apiCall = async (path, { method = 'GET', body, token } = {}) => {
      const headers = { 'X-Real-IP': `10.7.0.${++ipSeq}` };
      if (body) headers['Content-Type'] = 'application/json';
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch(`http://localhost:${BACKEND_PORT}${path}`, {
        method, headers, body: body ? JSON.stringify(body) : undefined,
      });
      let data = null; try { data = await res.json(); } catch {}
      return { status: res.status, data };
    };
    const tokenFrom = (link) => { try { return new URL(link).searchParams.get('token'); } catch { return null; } };
    const rnd = () => Math.random().toString(36).slice(2, 10);

    const email = `turtlesmoke-${rnd()}@gmail.com`;
    const reg = await apiCall('/api/register', {
      method: 'POST', body: { username: `ts${rnd()}`, password: 'test-pass-123', email },
    });
    const vTok = tokenFrom(reg.data?.devVerifyLink);
    const ver = vTok ? await apiCall(`/api/verify-email?token=${vTok}`) : { status: 0, data: null };
    const jwt = ver.data?.token;
    check('f1.测试用户注册并登录（拿到 JWT）', !!jwt, `verify status=${ver.status}`);

    if (jwt) {
      ctx2 = await newZhContext(browser);
      await ctx2.addInitScript((t) => {
        localStorage.setItem('arknights-auth-token', t);
        localStorage.setItem('arknights-auth-user', JSON.stringify({
          id: 1, username: 'turtleprobe', email: 'p@example.com', role: 'user', email_verified: true,
        }));
      }, jwt);
      const P2 = await ctx2.newPage();
      const p2Errors = [];
      P2.on('pageerror', (e) => p2Errors.push(String(e && e.message ? e.message : e)));

      await P2.goto(`${FRONTEND_ORIGIN}/turtle`, { waitUntil: 'load' });
      await P2.locator('[data-testid="turtle-start-easy"]').click({ timeout: WAIT_TIMEOUT });
      await waitFor(async () => (await P2.locator('[data-testid="turtle-attempts"]').count()) === 1, { desc: '登录态开局' });

      // 只**提问**两次、一次都不点名 —— 这样 f3 才能把「上报的是点名猜测次数」
      // 和「上报的是共享消耗次数」区分开：前者应为 0，后者会是 2。
      // 两个维度都取各自最小的一项，不必知道谜底（这里只关心「问了几次」）。
      const rows2 = () => P2.locator('[data-testid="turtle-log-row"]');
      for (const f of ['rarity', 'gender']) {
        const beforeCount = await rows2().count();
        await P2.locator(`[data-testid^="turtle-chip-${f}-"]`).first().click({ timeout: WAIT_TIMEOUT });
        await waitFor(async () => (await rows2().count()) === beforeCount + 1, { desc: `提问 ${f}` });
      }
      await P2.locator('[data-testid="turtle-give-up"]').click({ timeout: WAIT_TIMEOUT });
      await P2.locator('[data-testid="turtle-answer"]').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });

      let row = null;
      try {
        await waitFor(async () => {
          const lb = await apiCall('/api/leaderboard?mode=turtle&limit=50');
          row = (lb.data?.leaderboard || [])[0] || null;
          return !!row;
        }, { desc: '海龟汤榜出现该玩家' });
      } catch { /* row 留在 null，下面的断言会红并打印实际值 */ }

      check('f2.结算后成绩上了海龟汤榜（totalGames=1）',
        !!row && row.totalGames === 1, `row=${JSON.stringify(row)}`);
      check('f3.上报的是点名猜测次数、不是共享消耗（问了 2 次、0 次点名 → totalGuesses=0）',
        !!row && row.totalGuesses === 0, `totalGuesses=${row?.totalGuesses}（若为 2 说明上报了共享消耗）`);
      check('f4.「放弃」记为一负（wins=0）',
        !!row && row.wins === 0, `wins=${row?.wins}`);
      check('f5.登录态整局 0 个 pageerror', p2Errors.length === 0,
        p2Errors.length ? JSON.stringify(p2Errors.slice(0, 3)) : '0 个');
    }

    // ══════════════ g. 全程无 JS 报错 ══════════════
    check('g1.整局下来 0 个 pageerror',
      pageErrors.length === 0,
      pageErrors.length ? JSON.stringify(pageErrors.slice(0, 3)) : '0 个');

    await sleep(200);
  } finally {
    if (ctx) { try { await ctx.close(); } catch {} }
    if (ctx2) { try { await ctx2.close(); } catch {} }
    if (browser) { try { await browser.close(); } catch {} }
    if (staticServer) { try { staticServer.close(); } catch {} }
    killBackend(backend);
    await sleep(300);
    cleanupDb(DB_PATH);
  }
  return 0;
}

const exitCode = await main().catch((e) => { console.error('❌ 未捕获异常:', e); return 1; });
finish(exitCode);
