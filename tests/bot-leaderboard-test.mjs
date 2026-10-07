#!/usr/bin/env node
// 人机对战专属榜 —— API 级测试
//
// 为什么单开一个文件而不并进 bot-smoke：bot-smoke 是 UI 级、用的是**未登录**的
// browser context（人机对局只在登录时才上报），所以它一条都盖不到「落库之后」的事。
// 而这一块真正会悄悄出错的地方全在服务端谓词与白名单里：
//
//   d. `mode='bot'` 若没进排行榜白名单，会被**静默回落成 single** —— 人机 tab 显示的是
//      经典单人的数据，不报任何错。只有拿 totalGuesses 这种「两榜数值必然不同」的字段
//      才能把它认出来。
//   e. `routes/user.js` 的两条 `mode NOT IN ('custom','turtle','bot')` 谓词必须**逐字一致**
//      （聚合 :28 与 byMode :46），漏改任一 → 「明细之和 ≠ 总数」，界面上只是一个查不出
//      来的数字对不上。
//   e/f. 这是用户**拍板**的一条规则：「人机对局不计入个人总战绩」，成绩只进专属榜。
//      它没有任何前端表现 —— 统计页数字偏大是唯一症状，而那个数字平时没人对账。
//   g. bot 的 difficulty 列存的是**人机档位**（easy/medium/hard），若它流进个人历史，
//      会被套上「简单/困难」徽标冒充经典对局，而且它的 guess_count 是整场 BO5 的**累计**
//      次数，与经典单人的「一局几次」不同量纲，混进同一列会让那列失去可比性。
//   h. bot 与 single/turtle 有**两处故意的不对称**（不校验 targetName、允许 guessCount=0）。
//      它们看着像漏改，其实每一条都有理由（见 server/routes/game.js:171 的注释）。
//      这里把它们钉住：将来「顺手统一」会红，而红的时候能顺着本文件的注释读回原因。
//
// 已接入 scripts/smoke-all.sh（构建前那一组，第 6 步）。单独跑：
//   NODE_OPTIONS="--require ./tests/_dns-preload.cjs" node tests/bot-leaderboard-test.mjs
// 不需要 build（纯 API 级，不碰静态产物）。
//
// 全部断言都做过**反事实对照**（改坏一处 → 恰好它自己变红），记录在案：
//   cf1 两条 `NOT IN` 谓词漏掉 bot → e1/e2/e3 红（e4 仍绿 —— 它只钉 byMode 的键集合）
//   cf2 byMode 初始化里塞一个 `bot: 0` → 仅 e4 红
//   cf3 排行榜白名单去掉 bot → c1 红（明细指出 totalGuesses=2 = 经典那局）+ d1/d2/d3 红
//   cf4 targetName 守卫并进 bot → 仅 b2 红（400 目标干员不存在）
//   cf5 「赢不可能 0 猜」守卫并进 bot → 仅 b3 红（400 获胜时 guessCount 至少为 1）
//   cf6 /api/history 的排除列表去掉 bot → 仅 f1 红（count=4 modes=[single,bot,bot,bot]）

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ROOT, BACKEND_PORT, check, finish, makeDbPath,
  startBackend, killBackend, waitForBackend, cleanupDb, sleep,
} from './helpers.mjs';

const DB_PATH = makeDbPath('bot-lb');
const BASE = `http://localhost:${BACKEND_PORT}`;

let ipSeq = 0;
const nextIp = () => `10.11.0.${++ipSeq}`;
const rnd = () => Math.random().toString(36).slice(2, 10);

async function api(path, { method = 'GET', body, token, ip } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (ip) headers['X-Real-IP'] = ip;
  const res = await fetch(`${BASE}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

function tokenFromLink(link) {
  try { return new URL(link).searchParams.get('token'); } catch { return null; }
}

async function main() {
  const chars = JSON.parse(await readFile(join(ROOT, 'src', 'data', 'characters.json'), 'utf8'));
  const hardAnswer = chars[0]?.name;
  const singleAnswer = chars[1]?.name;
  if (!hardAnswer || !singleAnswer) {
    console.error('❌ characters.json 数据不足，无法取测试干员名');
    return 1;
  }

  const backend = startBackend({ dbPath: DB_PATH });
  try {
    await waitForBackend(BACKEND_PORT);

    // ══════════════ a. 准备一个已登录用户 ══════════════
    console.log('\n[a] 注册并登录测试用户');
    const email = `bot-${rnd()}@gmail.com`;
    const password = 'test-pass-123';
    const reg = await api('/api/register', {
      method: 'POST', body: { username: `b${rnd()}`, password, email }, ip: nextIp(),
    });
    const verifyToken = tokenFromLink(reg.data?.devVerifyLink);
    if (!verifyToken) { check('a1.注册返回验证链接', false, JSON.stringify(reg.data)); return 1; }
    const verify = await api(`/api/verify-email?token=${verifyToken}`, { ip: nextIp() });
    const jwt = verify.data?.token;
    check('a1.注册→验证→拿到 JWT', !!jwt, `status=${verify.status}`);
    if (!jwt) return 1;

    // ══════════════ b. 提交人机对局 ══════════════
    console.log('\n[b] 提交人机对局（三档各一局）+ 经典单人一局作对照');
    // 三局的 guessCount 刻意给成 12 / 9 / 0 三个互不相同的值，且分属三档，
    // 这样 d 段能用难度筛选把「档位分组」与「计数器口径」分别断言出来。
    // guessCount 对 bot 的含义是**整场 BO5 的累计次数**（前端 saveBotStats 传的就是
    // myTotalGuesses），不是某一小局的次数 —— 所以 12 这个量级是正常的。
    const saveHard = await api('/api/save-game', {
      method: 'POST', token: jwt, ip: nextIp(),
      body: {
        won: true, guessCount: 12, difficulty: 'hard',
        targetName: hardAnswer, mode: 'bot',
        timestamp: new Date().toISOString(),
      },
    });
    check('b1.mode=bot 被 save-game 接受（不 400）',
      saveHard.status === 200, `status=${saveHard.status} body=${JSON.stringify(saveHard.data)}`);

    // b2. **中途投降的形态**：targetName 为空。这是 bot 与 single/turtle 的**第一处
    //     故意的不对称** —— single/turtle 会因此 400，bot 不会（BO5 打了一半就退出时
    //     没有「最后完成的那一局」，但比分与次数都是真的，不该丢档）。
    //     ⚠️ 这条同时是「targetName 校验没被顺手统一」的哨兵：若有人把 bot 并进
    //        game.js 那条 `mode === 'single' || mode === 'turtle'` 的存在性守卫，
    //        b2 会从 200 变 400 —— 那时请读 game.js:171 的注释再决定，不要直接改本文件。
    const saveAbort = await api('/api/save-game', {
      method: 'POST', token: jwt, ip: nextIp(),
      body: {
        won: false, guessCount: 9, difficulty: 'easy',
        targetName: '', mode: 'bot',
        timestamp: new Date().toISOString(),
      },
    });
    check('b2.中途投降（targetName 为空）仍被接受 —— bot 故意不做谜底存在性校验',
      saveAbort.status === 200, `status=${saveAbort.status} body=${JSON.stringify(saveAbort.data)}`);

    // b3. **第二处故意的不对称**：won=true 且 guessCount=0。
    //     对 single/turtle 这条是 400（「获胜时 guessCount 至少为 1」），对 bot **不是** ——
    //     一局人机可以是 0 次猜测就赢的：时间耗尽时机器人还没猜出来、而玩家是**先**猜中的
    //     那一方（或机器人投降 / 超时判负），那一局玩家一次都没点过名。它是真实的战绩。
    const saveZero = await api('/api/save-game', {
      method: 'POST', token: jwt, ip: nextIp(),
      body: {
        won: true, guessCount: 0, difficulty: 'medium',
        targetName: hardAnswer, mode: 'bot',
        timestamp: new Date().toISOString(),
      },
    });
    check('b3.获胜且 guessCount=0 被接受 —— bot 故意不并进「赢不可能 0 猜」那条守卫',
      saveZero.status === 200, `status=${saveZero.status} body=${JSON.stringify(saveZero.data)}`);

    // b4. 反证对照。上面三条若把 bot 误当成 single 也全是 200，所以必须有一局真的
    //     single 进同一个库，才能证明 d 段「bot 没被回落成 single」不是空断言。
    const saveSingle = await api('/api/save-game', {
      method: 'POST', token: jwt, ip: nextIp(),
      body: {
        won: true, guessCount: 2, difficulty: 'hard',
        targetName: singleAnswer, mode: 'single',
        timestamp: new Date().toISOString(),
      },
    });
    check('b4.对照组：mode=single 一局也入库（totalGuesses=2，与 bot 的 12/9/0 必然不同）',
      saveSingle.status === 200, `status=${saveSingle.status}`);

    // ══════════════ c. 白名单与回落 ══════════════
    console.log('\n[c] 排行榜白名单：bot 自成一张榜，且不回落成 single');
    // ⚠️ 必须连 totalGuesses 一起断言。只断言 totalGames/wins 是**不够的**：
    //    mode=bot 若被白名单漏掉而静默回落成 single，这个 tab 会显示经典那一局，
    //    而 totalGames=1 / wins=1 照样能对上 —— 断言全绿、榜却是错的。
    //    totalGuesses（bot 合计 21 vs 经典 2）才是能把两张榜区分开的字段。
    const lbBot = await api('/api/leaderboard?mode=bot&limit=50', { ip: nextIp() });
    const bRow = (lbBot.data?.leaderboard || [])[0];
    check('c1.?mode=bot 命中的是那三局人机（totalGames=3, wins=2, totalGuesses=12+9+0=21）',
      lbBot.status === 200 && !!bRow && bRow.totalGames === 3 && bRow.wins === 2 && bRow.totalGuesses === 21,
      `status=${lbBot.status} totalGames=${bRow?.totalGames} wins=${bRow?.wins} totalGuesses=${bRow?.totalGuesses}`);
    // ⚠️ detail 是**恒打印**的（check 成功也打），所以只放中性测量值，别写「（若…说明…）」
    //    这种诊断口吻 —— 绿的时候它看着像一条报错，会让人以为刚出了事。
    //    回落成 single 的判别式（totalGames=1）留在上面 158-160 的注释里。

    const lbSingle = await api('/api/leaderboard?mode=single&limit=50', { ip: nextIp() });
    const sRow = (lbSingle.data?.leaderboard || [])[0];
    check('c2.?mode=single 只有经典那一局（totalGuesses=2），两张榜没串',
      lbSingle.status === 200 && !!sRow && sRow.totalGames === 1 && sRow.wins === 1 && sRow.totalGuesses === 2,
      `status=${lbSingle.status} row=${JSON.stringify(sRow)}`);

    // ══════════════ d. 难度筛选 = 人机档位筛选 ══════════════
    // bot 的 `difficulty` 列存的就是**档位**（BotTier = Difficulty，见 bot-engine.ts 的选型
    // 注释），而服务端的难度过滤是 `['easy','medium','hard']` —— 于是「三档各一张小榜」
    // 是白拿的。这一段把「白拿」这件事验证成事实：三档各自的局数与次数**各不相同**，
    // 若过滤没生效（忽略参数），三档会返回同一批数据（都是 3 局 21 次）。
    console.log('\n[d] 三档各自成榜（难度筛选真的在过滤）');
    const lbEasy = await api('/api/leaderboard?mode=bot&difficulty=easy&limit=50', { ip: nextIp() });
    const lbMedium = await api('/api/leaderboard?mode=bot&difficulty=medium&limit=50', { ip: nextIp() });
    const lbHard = await api('/api/leaderboard?mode=bot&difficulty=hard&limit=50', { ip: nextIp() });
    const eRow = (lbEasy.data?.leaderboard || [])[0];
    const mRow = (lbMedium.data?.leaderboard || [])[0];
    const hRow = (lbHard.data?.leaderboard || [])[0];
    check('d1.easy 档 = 那一局 1:0 负（totalGuesses=9）',
      !!eRow && eRow.totalGames === 1 && eRow.totalGuesses === 9 && eRow.wins === 0,
      `row=${JSON.stringify(eRow)}`);
    // totalGuesses=0 是**真实**的一局：人机先超时/投降，玩家一猜没下就赢了。
    check('d2.medium 档 = 那一局 0 次猜测取胜（totalGuesses=0，胜 1 局）',
      !!mRow && mRow.totalGames === 1 && mRow.totalGuesses === 0 && mRow.wins === 1,
      `totalGames=${mRow?.totalGames} wins=${mRow?.wins} totalGuesses=${mRow?.totalGuesses}`);
    check('d3.hard 档 = 那一局 12 次猜测取胜',
      !!hRow && hRow.totalGames === 1 && hRow.totalGuesses === 12 && hRow.wins === 1,
      `row=${JSON.stringify(hRow)}`);

    // ══════════════ e. 不进个人战绩聚合（用户拍板）══════════════
    console.log('\n[e] /api/me：人机不进战绩聚合');
    const me = await api('/api/me', { token: jwt, ip: nextIp() });
    const st = me.data?.stats || {};
    const byMode = st.byMode || {};
    const detailSum = Object.values(byMode).reduce((a, b) => a + b, 0);
    check('e1.totalGames=1（只有经典那局；三局人机没被算进去）',
      st.totalGames === 1,
      `totalGames=${st.totalGames} wins=${st.wins} bestScore=${st.bestScore}`);
    check('e2.bestScore=2（经典那局的 2 次；若 bot 的 0 次混进来 MIN 会变 0）',
      st.bestScore === 2, `bestScore=${st.bestScore}`);
    check('e3.byMode 明细之和 === totalGames（两条谓词漂移会在这里炸）',
      detailSum === st.totalGames,
      `明细 ${JSON.stringify(byMode)} 之和=${detailSum} vs totalGames=${st.totalGames}`);
    // ⚠️ 本条的职责**只是 byMode 的键集合**（服务端那个白名单初始化里没有 bot，
    //    且 classic 那局确实记进去了）。「bot 被排除出聚合」这件事由 e1–e3 负责 ——
    //    反事实记录可见 cf1：两条谓词漏掉 bot 时 e1/e2/e3 红、**e4 仍绿**；
    //    反过来 cf2（初始化里塞 bot:0）才是仅 e4 红。别把这条读成「排除已验证」。
    check('e4.byMode 的键集合里没有 bot，且 classic 记了 1 局（排除本身靠 e1–e3）',
      !('bot' in byMode) && byMode.single === 1,
      `byMode=${JSON.stringify(byMode)}`);

    // ══════════════ f. 不进个人历史 ══════════════
    console.log('\n[f] /api/history：人机不出现在个人历史');
    const hist = await api('/api/history?limit=80', { token: jwt, ip: nextIp() });
    const rows = hist.data?.history || [];
    const modes = rows.map(r => r.mode);
    check('f1.历史里恰好 1 条（经典那局），没有 bot 行',
      rows.length === 1 && !modes.includes('bot'),
      `count=${rows.length} modes=${JSON.stringify(modes)}`);

    // ══════════════ g. 游客提交不上榜 ══════════════
    console.log('\n[g] 游客（未登录）提交人机对局');
    const guest = await api('/api/save-game', {
      method: 'POST', ip: nextIp(),
      body: {
        won: true, guessCount: 5, difficulty: 'hard',
        targetName: hardAnswer, mode: 'bot',
        timestamp: new Date().toISOString(),
      },
    });
    check('g1.游客提交被接受（与经典单人一致：游客能玩）',
      guest.status === 200, `status=${guest.status}`);
    // 排行榜是 INNER JOIN users，游客行 user_id 为 NULL → 不出现。
    // 这一条同时反向证明了 c1 的「3 局」不是巧合。
    await sleep(200);
    const lbAfter = await api('/api/leaderboard?mode=bot&limit=50', { ip: nextIp() });
    const afterRows = lbAfter.data?.leaderboard || [];
    check('g2.游客那局不上榜（INNER JOIN users 挡住了 user_id=NULL）',
      afterRows.length === 1 && afterRows[0].totalGames === 3,
      `榜上 ${afterRows.length} 人，totalGames=${afterRows[0]?.totalGames}`);
  } finally {
    await killBackend(backend);
    await sleep(300);
    cleanupDb(DB_PATH);
  }
  return 0;
}

const exitCode = await main().catch((e) => { console.error('❌ 未捕获异常:', e); return 1; });
finish(exitCode);
