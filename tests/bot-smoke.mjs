#!/usr/bin/env node
// 人机对战 /bot —— UI 级冒烟
//
// routes-smoke 只证明「这个页面能打开、无 JS 报错」。本脚本补上它**测不到**的那一半：
// 页面与人机大脑的接线（把档位接错、棋盘槽位错一格、hideRarity 跟着档位走，
// routes-smoke 全绿而游戏已经坏了）。
//
// 被钉住的几件事，每条都对应一个**具体会静默出错**的改动（全部做过反事实对照：
// 改坏对应那行 → 对应断言变红，且其余断言不受影响）：
//   c1  人机棋盘的 9 列表头由 `party-constants` 的单一事实源推出来，且**不含画师列** ——
//       「顺手把 ALL_ATTR_KEYS 接上去」会让右盘多一列（左盘没有），玩家看到两张不同宽的表。
//   c2  人机每一行恰好 9 格、每格都落在三色词表里，且第 1 格是名字列 —— `toColorRow` 的槽位与
//       `displayCols.dataIdx` 错位时，格子会读到非三色的值而退化成**无色点**。
//       ⚠️ **本条的边界**：人机猜的是哪个人**不渲染在 DOM 里**（和多人房一样，只给对手看颜色），
//          所以「8 个词条之间的顺序对不对」在 UI 层不可验 —— 换对了槽位也是三色点。
//          那层保证靠 `scripts/check-attr-contract.mjs` 的槽位契约 + 页面里那两处对齐的注释，
//          不在这里假装验过。
//   d1  玩家棋盘的 9 列表头**不含「星级」** —— 这是需求②「人机页棋盘删星级」的探针。
//       ⚠️ 本条**双向**钉住：既拦「有人把星级列加回来」，也拦「有人顺手连左盘都没删干净」。
//          它**不是**「hideRarity 恒 false」的探针（那是这条断言在本功能之前的旧含义，
//          现在含义已经反过来了 —— 看到旧描述别以为是回归）。
//          反事实：把本页的 `hideRarity` 改回 `hideRarity={false}` → d1 立刻红。
//   c6  人机的**第一猜**在 4s 内落子 —— 需求③「首猜不思考、像真人一样随手点一个」的探针。
//       反事实：把 newRound 里那行 `BOT_FIRST_DELAY_MS[m.tier]` 改回 `botDelayMs(m.tier)`
//       （困难档 6.8s）→ c6 立刻红。⚠️ 只测第一局：之后的每一步本来就该走慢节奏。
//   e1/e2  每局揭晓的谜底**不是人机的名字**，且各局谜底互不相同 —— 对应 `newRound` 里
//       「把人机名与本场已用过的谜底一起排除出池子」那段。抽签口径正确时这两条**恒真**
//       （不是概率断言），只在有人删掉排除时才有机会响。
//   f3  终局卡揭晓的谜底是干员表里的真名。⚠️ e1/e2/f3 都要从结算卡文本里解析谜底，
//       共用 `parseAnswer` —— 分隔符写错会让名字被截断，f3 随即退化：
//         · 约 1/215 概率的**假红**（`凯尔希·思衡托`、`维娜·维多利亚` 有裸 `·`）；
//         · 更糟的是**假绿** —— `凯尔希` 本身就是另一位真干员，截断到它时 f3 照样绿，
//           而断言已经不再检查被截断的那个名字了。所以这条注释别只写「假红」。
//
// ⚠️ 本页**没有服务端**（方案 A 纯客户端），所以这里不做落档断言 ——
//    人机榜的服务端口径由 tests/bot-engine-test.mjs 之外的 routes 层保证，
//    而「登录后才发 save-game」这条路径在未登录上下文里根本不执行。
//
// 需要先 build：NEXT_PUBLIC_WS_URL=http://localhost:3101 npm run build
//   node tests/bot-smoke.mjs

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT, BACKEND_PORT, FRONTEND_ORIGIN, WAIT_TIMEOUT,
  check, finish, sleep, waitFor, makeDbPath,
  startStaticServer, startBackend, killBackend, waitForBackend, cleanupDb,
  requireBuild, requirePlaywright, newZhContext,
} from './helpers.mjs';
import { loadTsModule } from './_ts-load.mjs';

/** 页面上三个档位按钮的 testid 后缀 */
const TIERS = ['easy', 'medium', 'hard'];
/**
 * 用困难档跑全程。
 * ⚠️ 这里**不再**因为「哪档落子快」而选它 —— 需求③之后三档的第一猜都是 ~1.5s
 *    （`BOT_FIRST_DELAY_MS`，与档位无关），选困难纯粹是沿用历史、没有速度理由。
 *    后续步骤（在第 2 步之后）仍按各档自己的 `botDelayMs` 走，冒烟只等**第一**子。
 */
const TIER = 'hard';
/**
 * 「元素可能已经走了，别在这儿耗着」类读取/点击用的超时（ms）。
 *
 * 🔴 必须显式给。Playwright 的默认超时是 **30s**，而 locator 方法在元素缺席时是
 *    **一直等到超时**才抛 —— 不带超时的「容忍缺席」不是「立刻返回空」，是「每局白等 30s」。
 *    实测（同版本 Playwright，对未渲染的元素取 textContent）：无超时 30006ms / 带 1000ms 超时 1010ms。
 *    结算卡总共只停 3s，只要还在窗口里就是毫秒级命中，1s 绰绰有余。
 */
const SHORT_TIMEOUT = 1_000;
/**
 * 把结算卡上的「答案：{{name}} · {{score}}」切成谜底名与比分。
 *
 * 🔴 分隔符必须是**带空格的** ` · `（`multi.answerWithScore` 的中英两份模板都是这样）。
 *    干员名里本身就有**裸 `·`**（全表 429 人里有 2 个：`凯尔希·思衡托`、`维娜·维多利亚`），
 *    所以早先那句 `replace(/\s*·.*$/, "")`（空白可有可无）会把名字拦腰截断成「凯尔希」/「维娜」，
 *    于是 f3「谜底是干员表里的真名」变成一条**约每 215 局假红一次**的断言。
 *    收敛成一处，就不会有人再写回错的那版。
 *
 * ⚠️ 这条助手是**第 2 轮审查补的**，而第一次补丁的脚本在后续步骤提前 exit，整份没写盘 ——
 *    当时只跑了 `node --check`（只查语法、不解析标识符）所以看着是绿的，真跑冒烟才炸出
 *    「parseAnswer is not defined」。经验：改完测试文件必须真跑一次，`node --check` 不算验证。
 */
function parseAnswer(text) {
  const parts = text.replace(/^[^：]*：/, '').split(' · ');
  return { name: (parts[0] || '').trim(), score: (parts[1] || '').trim() };
}
/** 最多走几局。放弃 3 次必然够（每局给对手 +1 分，先到 3 胜即终）；
 *  留到 6 是兜住「玩家那唯一一次猜测正好命中」的小概率 —— 那种情况要多打一局。 */
const MAX_ROUNDS = 6;

async function main() {
  if (!requireBuild()) return 1;
  const chromium = await requirePlaywright();
  if (!chromium) return 1;

  const zh = JSON.parse(readFileSync(join(ROOT, 'src', 'messages', 'zh-CN.json'), 'utf8'));
  const en = JSON.parse(readFileSync(join(ROOT, 'src', 'messages', 'en.json'), 'utf8'));
  const chars = JSON.parse(readFileSync(join(ROOT, 'src', 'data', 'characters.json'), 'utf8'));

  const pc = (await loadTsModule('src/lib/party-constants.ts')).mod;
  // 期望的 9 列表头 = 姓名 + 8 个标准词条（**已去掉星级**，需求②）。
  // 🔴 **写死中文串**，不要从 `ATTR_LABEL_KEYS` + zh JSON 现推 —— 第 3 轮审查指出：
  //    页面渲染的就是 `t(ATTR_LABEL_KEYS[a])`，两边的原料同一份，现推等于同义反复：
  //    谁把某个 `ATTR_LABEL_KEYS` 改错（例如把 gender 指到 table.tags），
  //    期望值会跟着一起错，这条断言照样绿。写死才有独立性。
  const wantHeaders = ['姓名', '职业', '子职业', '阵营', '种族', '性别', '上线年份', '部署位', '词缀'];
  // 再反向钉一次：写死的那份必须与单一事实源**逐字一致**（漂移时这里先红，
  // 比在浏览器里等到 c1 才红更容易定位）。
  // ⚠️ 过滤条件必须与页面 `displayCols` 里那句 `.filter(c => c.key !== 'rarity')` **同一形状** ——
  //    这里现推出来的是「单一事实源 − 星级」，不是「单一事实源」。少了这层过滤，
  //    a0 会因为「页面少一列、期望多一列」而红，而真正的原因（谁改了 ATTR_*）反而被盖住。
  const derivedHeaders = ['table.name',
    ...pc.PARTY_ATTR_KEYS.filter(a => a !== 'rarity').map(a => pc.ATTR_LABEL_KEYS[a])].map(k => zh[k]);
  check('a0.写死的表头与 party-constants + zh 文案逐字一致（改了单一事实源必须同步本清单）',
    derivedHeaders.join('|') === wantHeaders.join('|'),
    `单一事实源 [${derivedHeaders.join(',')}]；本脚本写死 [${wantHeaders.join(',')}]`);
  const artistLabel = zh[pc.ATTR_LABEL_KEYS.artist];

  /** 玩家那唯一一次猜测要点的干员：取一个名字唯一的常见干员 */
  const guessPick = chars.find(c => c.name === '阿米娅') || chars[0];

  const DB_PATH = makeDbPath('bot');
  const backend = startBackend({ dbPath: DB_PATH });
  let staticServer = null;
  let browser = null;
  let ctx = null;

  try {
    await waitForBackend(BACKEND_PORT);
    staticServer = await startStaticServer();
    browser = await chromium.launch({ headless: true });
    ctx = await newZhContext(browser);
    const P = await ctx.newPage();
    const pageErrors = [];
    P.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));

    // ── 读数小工具 ────────────────────────────────────────────

    /** 当前处于哪一屏。四个 testid 互斥，按「最特殊优先」判 */
    const stageOf = async () => {
      if (await P.locator('[data-testid="bot-match-end"]').count()) return 'matchEnd';
      if (await P.locator('[data-testid="bot-round-end"]').count()) return 'roundEnd';
      if (await P.locator('[data-testid="bot-time"]').count()) return 'playing';
      return 'menu';
    };

    /**
     * 人机的名字。`bot-name` 的内容形如 `刻俄柏 0`（后面那个 `<span class="n">` 是胜场数），
     * 所以只取**第一个文本节点** —— 拼 display 字符串再切数字会被带数字的干员名坑到。
     */
    const readBotName = () => P.locator('[data-testid="bot-name"]').evaluate((el) => {
      const node = Array.from(el.childNodes).find((n) => n.nodeType === Node.TEXT_NODE);
      return (node ? node.textContent : '').trim();
    });

    const headersOf = (sel) => P.locator(sel).evaluateAll((ths) => ths.map((th) => (th.textContent || '').trim()));

    /** 人机棋盘：返回每一格圆点的 class 列表 */
    const botDotRows = async () => {
      const rows = P.locator('[data-testid="bot-opp-row"]');
      const n = await rows.count();
      const out = [];
      for (let i = 0; i < n; i++) {
        out.push(await rows.nth(i).locator('td').evaluateAll((tds) => tds.map((td) => {
          const dot = td.querySelector('.opp-dot');
          return dot ? dot.className : '(无圆点)';
        })));
      }
      return out;
    };

    /** 确认放弃本局（按钮 → 弹窗 → 确认） */
    const surrender = async () => {
      await P.locator('[data-testid="bot-surrender"]').click({ timeout: WAIT_TIMEOUT });
      await P.locator('[data-testid="bot-surrender-confirm"]').click({ timeout: WAIT_TIMEOUT });
    };

    // ══════════════ a. 入口与开局面板 ══════════════
    console.log('\n[a] 入口与开局面板');
    // 入口在多人页菜单里（就挂在「快速匹配」下方），未登录也能进 —— 这条钉住「人在哪能找到它」
    await P.goto(`${FRONTEND_ORIGIN}/multiplayer`, { waitUntil: 'load' });
    const entry = P.getByRole('button', { name: new RegExp(zh['bot.title']) });
    const entryCount = await entry.count();
    check('a1.多人页菜单里有且仅有一个「人机对战」入口', entryCount === 1, `匹配到 ${entryCount} 个按钮`);
    if (entryCount === 1) {
      await entry.click({ timeout: WAIT_TIMEOUT });
      await waitFor(async () => P.url().endsWith('/bot'), { desc: '跳到 /bot' });
    } else {
      await P.goto(`${FRONTEND_ORIGIN}/bot`, { waitUntil: 'load' });
    }
    check('a2.点入口进入 /bot', P.url().endsWith('/bot'), P.url());

    await waitFor(async () => (await P.locator('[data-testid^="bot-tier-"]').count()) === TIERS.length,
      { desc: '三档难度按钮' });
    const defaultTier = await P.locator('[data-testid="bot-tier-easy"]').getAttribute('class');
    check('a3.开局默认低档：easy 按钮高亮',
      /(^|\s)on(\s|$)/.test(defaultTier || ''),
      `class="${defaultTier}"`);

    // 换挡必须真的换掉「谁被选中」—— 只换 state 不换高亮 = 玩家看着 A 打的是 B。
    // ⚠️ 这里原本还比对了「档位说明文案」那半句，需求④把那段文案整段删了，
    //    所以**只留高亮这半句**（别把整条 a4 删掉 —— 那就没人拦「点了没反应」）。
    await P.locator(`[data-testid="bot-tier-${TIER}"]`).click({ timeout: WAIT_TIMEOUT });
    const hardClass = await P.locator(`[data-testid="bot-tier-${TIER}"]`).getAttribute('class');
    const easyClassNow = await P.locator('[data-testid="bot-tier-easy"]').getAttribute('class');
    check(`a4.点「${zh[`bot.tier${TIER[0].toUpperCase()}${TIER.slice(1)}`]}」后：它高亮、easy 熄灭`,
      /(^|\s)on(\s|$)/.test(hardClass || '') && /(^|\s)off(\s|$)/.test(easyClassNow || ''),
      `hard="${hardClass}" easy="${easyClassNow}"`);

    // ══════════════ b. 开局 ══════════════
    console.log('\n[b] 开局');
    await P.locator('[data-testid="bot-start"]').click({ timeout: WAIT_TIMEOUT });
    await waitFor(async () => (await stageOf()) === 'playing', { desc: '进入局中' });

    const timeText = ((await P.locator('[data-testid="bot-time"]').textContent()) || '').trim();
    const secs = /^(\d{2}):(\d{2})$/.test(timeText) ? Number(RegExp.$1) * 60 + Number(RegExp.$2) : -1;
    check('b1.单局计时器是 mm:ss 且从 90 秒起（人机与多人同赛制）',
      secs > 80 && secs <= 90, `显示 "${timeText}"（${secs}s）`);

    const myWins0 = ((await P.locator('[data-testid="bot-my-wins"]').textContent()) || '').trim();
    const oppWins0 = ((await P.locator('[data-testid="bot-opp-wins"]').textContent()) || '').trim();
    check('b2.开局比分 0 : 0', myWins0 === '0' && oppWins0 === '0', `你=${myWins0} 对方=${oppWins0}`);

    const botName = await readBotName();
    check('b3.人机的显示 ID 是从干员表里抽的真名（整场固定）',
      chars.some(c => c.name === botName), `抽到 "${botName}"`);

    const status0 = ((await P.locator('[data-testid="bot-status"]').textContent()) || '').trim();
    check('b4.状态行是「{名字} 正在思考…」', status0.includes(botName) && status0 === zh['bot.thinking'].replace('{{name}}', botName),
      `"${status0}"`);

    // ══════════════ c. 多局循环 ══════════════
    // 每一局都是「等一次人机落子（只等第一局）→ 玩家猜一次 → 放弃 → 读谜底」，直到有人先到 3 胜。
    console.log('\n[c] 对局流程');
    const answers = [];
    const scores = [];
    let boardChecked = false;
    let playerGuessed = false;
    let sawEmptyPlayerBoard = false;

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const stage = await stageOf();
      if (stage === 'matchEnd') break;
      if (stage === 'menu') { await P.locator('[data-testid="bot-start"]').click({ timeout: WAIT_TIMEOUT }); }
      await waitFor(async () => (await stageOf()) === 'playing', { desc: `第 ${round} 局开始` });

      if (!boardChecked) {
        // 人机落子前，玩家棋盘**应当不存在**（GuessTable 在零猜测时 return null）
        sawEmptyPlayerBoard = (await P.locator('table.game-table').count()) === 0;
        const firstGuessT0 = Date.now();
        // 等第一子，或等来一个「人机第一猜就中」的结算 —— 后者概率约 1/429，但不能让它变成假红
        await waitFor(async () => (await P.locator('[data-testid="bot-opp-row"]').count()) >= 1
          || (await stageOf()) !== 'playing', { desc: `第 ${round} 局人机落第一子` });
        const firstGuessMs = Date.now() - firstGuessT0;
        // 🔴 需求③的行为探针：人机的**第一猜**要快（~1.5s，`BOT_FIRST_DELAY_MS`），
        //    不是它平时的思考节奏（困难档 6.8s、普通 8.2s、简单 10s）。
        //    上限取 4s：正常 ~1.6s（含 stage 轮询与 tick 的 100ms 粒度），
        //    「谁把这行改回 `botDelayMs(m.tier)`」时这档至少 6.8s → 稳稳变红。
        //    ⚠️ 只测**第一局**（`boardChecked` 那道门）—— 之后的每一猜本来就该走慢节奏。
        check(`c6.人机第一猜在 4s 内落子（实测 ${(firstGuessMs / 1000).toFixed(1)}s；需求③：首猜不思考）`,
          firstGuessMs < 4000,
          `${firstGuessMs}ms（首猜延迟常量 BOT_FIRST_DELAY_MS=1500ms + tick 粒度 + 轮询延迟）`);

        if ((await stageOf()) === 'playing') {
          const botHeaders = await headersOf('[data-testid="bot-opp-grid"] thead th');
          check(`c1.人机棋盘 ${botHeaders.length} 列表头 = 姓名 + 8 个标准词条（无星级），且**没有画师列**`,
            botHeaders.length === wantHeaders.length
              && botHeaders.join('|') === wantHeaders.join('|')
              && !botHeaders.includes(artistLabel),
            `实际 [${botHeaders.join(',')}]；期望 [${wantHeaders.join(',')}]；画师列「${artistLabel}」出现=${botHeaders.includes(artistLabel)}`);

          const dots = await botDotRows();
          const flat = dots.flat();
          const COLORED = /(^|\s)d-(ok|cl|no)(\s|$)/;
          check(`c2.人机已落 ${dots.length} 行，每行恰好 ${wantHeaders.length} 格且每格都带三色之一`,
            dots.length >= 1 && dots.every((r) => r.length === wantHeaders.length)
              && flat.every((c) => COLORED.test(c)),
            `行数=${dots.length} 每行格数=[${dots.map((r) => r.length).join(',')}] `
              + `无色格=${flat.filter((c) => !COLORED.test(c)).length}`);
          // 第 1 格必须是**名字列**且是「未命中」色：人机没猜中时 row[0] 恒为 'wrong'，
          // 所以它恒是 d-no（猜中即结算、整行会被拆掉，那一支在 UI 上永远看不到）。
          // 这一条钉住 slot 0 的语义，配合 c2 的「恰 9 格」把名字列与第 1 个词条的分界卡死。
          check('c2b.人机行第 1 格是名字列（恒为未命中色，不是某个词条的颜色）',
            dots.every((r) => r[0] === 'opp-dot d-no'),
            `各行的第 1 格 = [${dots.map((r) => r[0]).join(' | ')}]`);

          const title = ((await P.locator('[data-testid="bot-board-title"]').textContent()) || '').trim();
          check('c3.人机棋盘标题带上人机名与它的猜测次数',
            title === zh['multi.oppGuesses'].replace('{{name}}', botName).replace('{{count}}', String(dots.length)),
            `"${title}"，当前行数 ${dots.length}`);

          // 玩家落一子：钉住 handleGuess 的接线（猜完棋盘出现、最新一行就是刚点的那个名字）
          await P.locator('input.game-search-input').click({ timeout: WAIT_TIMEOUT });
          await P.locator('input.game-search-input').fill(guessPick.name);
          await sleep(300); // 等 150ms 防抖出下拉
          await P.keyboard.press('Enter');
          await waitFor(async () => (await P.locator('table.game-table tbody tr').count()) >= 1,
            { desc: '玩家棋盘出现第一行' });

          const playerHeaders = await headersOf('table.game-table thead th');
          check(`d1.玩家棋盘是 ${wantHeaders.length} 列**且不含「星级」**（需求②：人机页删星级的探针）`,
            playerHeaders.length === wantHeaders.length
              && playerHeaders.join('|') === wantHeaders.join('|')
              && !playerHeaders.includes(zh['table.rarity']),
            `实际 [${playerHeaders.join(',')}]；含「${zh['table.rarity']}」=${playerHeaders.includes(zh['table.rarity'])}`);

          const newest = ((await P.locator('table.game-table tbody tr').first().locator('td').first().textContent()) || '').trim();
          check('d2.猜的那个干员出现在玩家棋盘最新一行（onGuess 接线正确）',
            newest === guessPick.name, `最新一行="${newest}"，点的是 "${guessPick.name}"`);
          playerGuessed = true;
          boardChecked = true;
        }
        // 走到这里说明人机第一猜就中了：本局已结算，直接进结算流程（不做棋盘断言，下一局再补）
      }

      // 结束本局：还在局中就放弃（放弃 = 让出本局，对手 +1 分）
      if ((await stageOf()) === 'playing') {
        await surrender();
      }
      await waitFor(async () => (await stageOf()) !== 'playing', { desc: `第 ${round} 局结算` });

      const endStage = await stageOf();
      if (endStage === 'roundEnd') {
        // 🔴 结算卡只停 3s 就自动开下一局，而这里既要读它的文本、又要点它 —— 每一步都可能
        //    撞上「这张卡已经自己走了」。撞上时 textContent()/click() 会一直等 element
        //    出现、最后等满超时报错，把「只是慢了一拍」变成一条**假红**（CI 冷启动时最容易）。
        //    所以：读的时候容忍缺席，点的时候容忍中途 detach —— 但**每次都要带短超时**
        //    （不带 = 每局白等 30s，见 SHORT_TIMEOUT 的注释）。
        //    ⚠️ 代价是**可能少读一局**：本场恰好 3 局时（玩家弃权 3 次 = 人机先到 3 胜），
        //       漏读 1 局就只剩 2 条 —— 故 e1 的门槛取 >= 2 而**不是** >= 3。
        //       写 >= 3 就是零余量：撞上上面那种「慢了一拍」时 e1 会假红（而真答案一直是对的）。
        //       e2 是「各局互不相同」，少一局只是少一个比较对象，照样成立。
        const endCard = P.locator('[data-testid="bot-round-end"]');
        if (await endCard.count()) {
          const answerText = ((await P.locator('[data-testid="bot-answer"]')
            .textContent({ timeout: SHORT_TIMEOUT }).catch(() => '')) || '').trim();
          const resultText = ((await P.locator('[data-testid="bot-round-result"]')
            .textContent({ timeout: SHORT_TIMEOUT }).catch(() => '')) || '').trim();
          // multi.answerWithScore = "答案：{{name}} · {{score}}"
          if (answerText) {
            const { name, score } = parseAnswer(answerText);
            answers.push({ name, score, resultText });
            scores.push(score);
          }
          // 点一下立刻跳（不点也不会卡住，只是慢 3s/局）
          await endCard.click({ timeout: SHORT_TIMEOUT }).catch(() => {});
        }
        await sleep(150);
      } else {
        // 终局：**最后一局的谜底在终局卡上**（bot-final-answer）。不读它的话，整场里
        // 唯一看不到答案的就是决定胜负的那一局 —— 而它恰恰是最想看的那局。
        const t2 = ((await P.locator('[data-testid="bot-final-answer"]').textContent()) || '').trim();
        answers.push({ ...parseAnswer(t2), resultText: '' });
        break; // matchEnd
      }
    }

    check('c4.人机落子前玩家棋盘是空的（GuessTable 零猜测不渲染）', sawEmptyPlayerBoard);
    check('c5.玩家成功落子一次', playerGuessed);

    check('e1.每一局揭晓的谜底都不是人机的名字（人机名被排除出谜底池）',
      answers.length >= 2 && answers.every((a) => a.name.length > 0 && a.name !== botName),
      answers.map((a) => `${a.name}(${a.score})`).join(' | ') || '一局都没读到谜底');
    check('e2.各局谜底互不相同（本场已用过的谜底被排除）',
      new Set(answers.map((a) => a.name)).size === answers.length,
      `${answers.length} 局 / ${new Set(answers.map((a) => a.name)).size} 个不同谜底`);

    // ══════════════ f. 终局 ══════════════
    console.log('\n[f] 终局');
    await waitFor(async () => (await stageOf()) === 'matchEnd', { desc: '终局画面' });
    const finalScore = ((await P.locator('[data-testid="bot-match-score"]').textContent()) || '').trim();
    const nums = finalScore.match(/(\d+)\s*:\s*(\d+)/);
    check('f1.对手先到 3 胜，终局比分如实反映',
      !!nums && Number(nums[2]) === 3, `"${finalScore}"`);
    const resultText = ((await P.locator('[data-testid="bot-match-result"]').textContent()) || '').trim();
    check('f2.胜负文案与比分一致（我们没到 3 → 显示「人机赢下」）',
      !!nums && resultText === (Number(nums[1]) >= 3 ? zh['bot.matchWin'] : zh['bot.matchLose']),
      `"${resultText}"，比分 ${nums ? `${nums[1]}:${nums[2]}` : '?'}`);
    // 终局卡要揭晓**最后一局**的谜底（多人房同形态：那边是在结算卡上加一行「本场结束」，
    // 一样会亮出答案）。只 show 终局结果、不 show 答案的话，唯一看不到答案的偏偏是决胜局。
    const finalAns = ((await P.locator('[data-testid="bot-final-answer"]').textContent()) || '').trim();
    const finalAnsName = parseAnswer(finalAns).name;
    check('f3.终局卡揭晓最后一局的谜底，且是干员表里的真名',
      chars.some((c) => c.name === finalAnsName), `"${finalAns}" → 解析出 "${finalAnsName}"`);

    check('f4.终局有「再战」与「退出」两个出口',
      (await P.locator('[data-testid="bot-restart"]').count()) === 1
        && (await P.locator('[data-testid="bot-exit"]').count()) === 1);

    await P.locator('[data-testid="bot-exit"]').click({ timeout: WAIT_TIMEOUT });
    await waitFor(async () => (await stageOf()) === 'menu', { desc: '退出回到开局面板' });
    check('f5.退出后回到开局面板（三档按钮重现）',
      (await P.locator('[data-testid^="bot-tier-"]').count()) === TIERS.length);

    // ══════════════ g. 英文不露原始键名 ══════════════
    // i18n 哨兵只保证两份 JSON 键集合一致、`t('字面量')` 的键两边都在；
    // 「渲染出来是不是键名本身」只有真跑一次才知道。**这一条在本功能里尤其要紧**：
    // 需求④删掉了 `bot.description` 与三档 `bot.tier*Desc` 共 4 组键（中英各 4 个），
    // 删键最容易出的事就是「页面还引用着 / 引用了错的一半」—— 那会原样显示键名。
    console.log('\n[g] 英文');
    const before = await P.locator('body').innerText();
    await P.getByRole('button', { name: 'Switch language' }).click({ timeout: WAIT_TIMEOUT });
    await waitFor(async () => (await P.locator('body').innerText()) !== before, { desc: '切到英文' });
    const enText = await P.locator('body').innerText();
    const rawKeys = enText.match(/\b(?:bot|multi|table|menu|game|leaderboard)\.[a-zA-Z][a-zA-Z0-9.]*/g) || [];
    check('g1.切到英文后，页面上没有裸露的 i18n 键名',
      rawKeys.length === 0,
      rawKeys.length ? `露出 ${rawKeys.length} 个：${[...new Set(rawKeys)].slice(0, 6).join(', ')}` : '0 个');
    // g2 原本钉的是「英文下档位说明换成了英文那份」——说明文案已按需求④删除，
    // 改钉**留下来的那部分**：三个档位按钮必须是英文档位名，而不是键名或中文。
    const enTierNames = await P.locator('[data-testid^="bot-tier-"]')
      .evaluateAll((els) => els.map((e) => (e.textContent || '').trim()));
    const wantEnTiers = ['bot.tierEasy', 'bot.tierMedium', 'bot.tierHard'].map((k) => en[k]);
    check('g2.英文下三个档位按钮显示英文档位名（档位名保留，说明文案已删）',
      enTierNames.join('|') === wantEnTiers.join('|'),
      `实际 [${enTierNames.join(',')}]；期望 [${wantEnTiers.join(',')}]`);

    // ══════════════ h. 全程无 JS 报错 ══════════════
    check('h1.整场下来 0 个 pageerror',
      pageErrors.length === 0,
      pageErrors.length ? JSON.stringify(pageErrors.slice(0, 3)) : '0 个');

    // ══════════════ i. 投降确认框不得跨局（源码级不变量）══════════════
    // 🔴 为什么这里读源码而不是点界面：这个 bug 只在「确认框开着的时候这一局自己结束」
    //    时才暴露，而让一局自己结束的两条路都不适合放进 gate —— 超时要等满 90 秒；
    //    人机猜中要 ~39 秒且不确定；期间 modal-mask 盖住整页（无 pointer-events:none），
    //    棋盘点不动，所以也没法用「第 8 次猜测结束本局」来构造。
    //    因此这两条钉的是**形状**：它挡得住「有人删了这行」，挡不住「有人换一种写法绕过」。
    //    人工复现（30 秒内可做）：进 playing → 点「放弃本局」开框 → 放着不管，
    //    等这一局超时自己结束 → 3 秒后新局开始 → 点框里的「确认放弃」。
    //    修好之前：新局零猜测被判负（`bot-opp-wins` +1）；修好后：框已经不在。
    console.log('\n[i] 投降框跨局不变量（源码级）');
    const pageSrc = readFileSync(join(ROOT, 'src/app/bot/page.tsx'), 'utf8');
    // i1. newRound 里必须清掉这个 flag。框不属于任何一局，但 stage 回到 playing 时
    //     渲染条件又会成立 —— 只在渲染处加 stage 门是**不够的**（新局又回到 playing）。
    const newRoundBody = pageSrc.match(/const newRound = useCallback\(\(\) => \{[\s\S]*?\n  \}, \[\]\);/);
    // ⚠️ detail 是**恒打印**的（helpers.mjs:31），所以它必须是中性测量值，
    //    不能写成失败断言 —— 否则绿的时候会打出一句自相矛盾的说明（先前就是这样）。
    check('i1. newRound 里清掉了投降确认框（否则新局一开始框就自己弹回来）',
      !!newRoundBody && newRoundBody[0].includes('setShowSurrenderConfirm(false)'),
      newRoundBody
        ? `newRound 体 ${newRoundBody[0].length} 字符，${newRoundBody[0].includes('setShowSurrenderConfirm(false)') ? '含' : '不含'}该行`
        : '未提取到 newRound 函数体（改写了它？本检查需同步）');
    // i2. 渲染处必须有 stage 门：局末那 3 秒（roundEnd）不该让框盖在结算卡上。
    const i2ok = /stage === 'playing' && showSurrenderConfirm/.test(pageSrc);
    check('i2. 投降框的渲染条件带 stage === \'playing\'（结算卡不被遮罩盖住）',
      i2ok,
      `渲染条件${i2ok ? '形如 stage && flag' : '不含 stage 门'}`);

    await sleep(200);
  } finally {
    if (ctx) { try { await ctx.close(); } catch {} }
    if (browser) { try { await browser.close(); } catch {} }
    if (staticServer) { try { staticServer.close(); } catch {} }
    await killBackend(backend);
    await sleep(300);
    cleanupDb(DB_PATH);
  }
  return 0;
}

const exitCode = await main().catch((e) => { console.error('❌ 未捕获异常:', e); return 1; });
finish(exitCode);
