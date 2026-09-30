#!/usr/bin/env node
// 海龟汤专属榜 —— API 级测试（plan 阶段 8）
//
// 为什么单开一个文件而不并进 solo-smoke：solo-smoke 是 UI 级、且用**未登录**的
// browser context，排行榜那条只验到「四个 tab 都在、空态能渲染」。而阶段 8 真正
// 会悄悄出错的地方全是**服务端谓词**，一条 UI 断言都盖不住：
//
//   g. `routes/user.js` 的聚合谓词与 byMode 谓词必须**逐字一致**且都排除 turtle。
//      漏改任一 → 「明细之和 ≠ 总数」（源码 :38 的注释自己警告过这个失败模式），
//      而两种漏法的 UI 表现都只是统计页数字偏大，肉眼看不出来。
//   h. `/api/history` 若不排除 turtle，前端会把认不出的 mode **丢掉**，
//      按经典对局渲染 → 海龟汤顶着一个「困难」徽标冒充经典，并被写回 localStorage。
//   e/f. `mode=turtle` 若没进排行榜白名单，会被**静默回落成 single** ——
//      海龟汤 tab 显示的是经典单人的数据，而且不报任何错。
//   d. turtle 必须和 single 一样校验谜底真实存在，否则可以灌垃圾记录刷榜。
//
// ⚠️ 未接入 scripts/smoke-all.sh（新增文件，不擅自改部署 gate）。
//   NODE_OPTIONS="--require ./tests/_dns-preload.cjs" node tests/turtle-leaderboard-test.mjs
// 不需要 build（纯 API 级，不碰静态产物）。

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ROOT, BACKEND_PORT, check, finish, makeDbPath,
  startBackend, killBackend, waitForBackend, cleanupDb, sleep,
} from './helpers.mjs';

const DB_PATH = makeDbPath('turtle-lb');
const BASE = `http://localhost:${BACKEND_PORT}`;

let ipSeq = 0;
const nextIp = () => `10.9.0.${++ipSeq}`;
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
  const turtleAnswer = chars[0]?.name;
  const singleAnswer = chars[1]?.name;
  if (!turtleAnswer || !singleAnswer) {
    console.error('❌ characters.json 数据不足，无法取测试干员名');
    return 1;
  }

  const backend = startBackend({ dbPath: DB_PATH });
  try {
    await waitForBackend(BACKEND_PORT);

    // ══════════════ a. 准备一个已登录用户 ══════════════
    console.log('\n[a] 注册并登录测试用户');
    const email = `turtle-${rnd()}@gmail.com`;
    const password = 'test-pass-123';
    const reg = await api('/api/register', {
      method: 'POST', body: { username: `t${rnd()}`, password, email }, ip: nextIp(),
    });
    const verifyToken = tokenFromLink(reg.data?.devVerifyLink);
    if (!verifyToken) { check('a1.注册返回验证链接', false, JSON.stringify(reg.data)); return 1; }
    const verify = await api(`/api/verify-email?token=${verifyToken}`, { ip: nextIp() });
    const jwt = verify.data?.token;
    check('a1.注册→验证→拿到 JWT', !!jwt, `status=${verify.status}`);
    if (!jwt) return 1;

    // ══════════════ b. 提交对局 ══════════════
    console.log('\n[b] 提交海龟汤 / 经典单人各一局');
    const saveTurtle = await api('/api/save-game', {
      method: 'POST', token: jwt, ip: nextIp(),
      body: {
        won: true, guessCount: 3, difficulty: 'easy',
        targetName: turtleAnswer, mode: 'turtle',
        timestamp: new Date().toISOString(),
      },
    });
    check('b1.mode=turtle 被 save-game 接受（不 400）',
      saveTurtle.status === 200, `status=${saveTurtle.status} body=${JSON.stringify(saveTurtle.data)}`);

    const saveSingle = await api('/api/save-game', {
      method: 'POST', token: jwt, ip: nextIp(),
      body: {
        won: true, guessCount: 2, difficulty: 'hard',
        targetName: singleAnswer, mode: 'single',
        timestamp: new Date().toISOString(),
      },
    });
    check('b2.对照组：mode=single 一局也入库',
      saveSingle.status === 200, `status=${saveSingle.status}`);

    // ══════════════ c. 谜底真实性校验 ══════════════
    console.log('\n[c] 谜底校验（防灌垃圾记录刷榜）');
    const bogus = await api('/api/save-game', {
      method: 'POST', token: jwt, ip: nextIp(),
      body: {
        won: true, guessCount: 1, difficulty: 'easy',
        targetName: '这个干员不存在zzz', mode: 'turtle',
        timestamp: new Date().toISOString(),
      },
    });
    check('c1.mode=turtle 且谜底不存在 → 400（与 single 同一条守卫）',
      bogus.status === 400, `status=${bogus.status} body=${JSON.stringify(bogus.data)}`);

    // c2. 「赢了不可能 0 次猜测」这条守卫必须**同时**管住 single 与 turtle。
    //     海龟汤的获胜只能靠点名猜中产生（turtle-store 的 guesses 恒 >= 1），
    //     「多人/自定义允许 0 次（对手断线判负）」那个口子对它不成立。
    //     ⚠️ 漏了 turtle 时接口会**静默接受**，把 /api/leaderboard?mode=turtle 的
    //        avgGuesses（= SUM(guess_count)/COUNT(*)）直接压到 0.00 —— 不报错，只是榜变假。
    //     谜底用**第三个**真实干员（不复用 turtleAnswer/singleAnswer）：确保拦下它的是
    //     这一条守卫而不是 c1 那条存在性校验，也不与 b1/b2 那两局的记录混在一起。
    //     ⚠️ 若守卫真的漏了 turtle，这里会**插入**一条 guess_count=0 的记录，后面的
    //        d/f/g 会跟着一起红 —— 那是预期级联（c2 的失败信息会先指出真因），不是新 bug。
    const zeroAnswer = chars[2]?.name;
    const zeroGuess = await api('/api/save-game', {
      method: 'POST', token: jwt, ip: nextIp(),
      body: {
        won: true, guessCount: 0, difficulty: 'easy',
        targetName: zeroAnswer, mode: 'turtle',
        timestamp: new Date().toISOString(),
      },
    });
    const zeroSingle = await api('/api/save-game', {
      method: 'POST', token: jwt, ip: nextIp(),
      body: {
        won: true, guessCount: 0, difficulty: 'easy',
        targetName: zeroAnswer, mode: 'single',
        timestamp: new Date().toISOString(),
      },
    });
    // ⚠️ 光断言 status===400 不够：c1 那条存在性校验也返回 400，换个名字也能 400 的守卫
    //    以后还会有别条。必须断言**错误信息**，否则这条用例可能在「被别的守卫拦下」时
    //    依然全绿 —— 那正是它要防的那种静默失效。
    const GUARD_MSG = '至少为 1';
    check('c2.获胜且 guessCount=0 → turtle 与 single 都被同一守卫拒（口径一致）',
      zeroGuess.status === 400 && zeroSingle.status === 400
      && String(zeroGuess.data?.error || '').includes(GUARD_MSG)
      && String(zeroSingle.data?.error || '').includes(GUARD_MSG),
      `turtle=${zeroGuess.status} "${zeroGuess.data?.error}" / single=${zeroSingle.status} "${zeroSingle.data?.error}"`);

    // ══════════════ d. 两张榜互不串 ══════════════
    console.log('\n[d] 排行榜：海龟汤与经典单人各一张');
    // ⚠️ 必须连 totalGuesses 一起断言（海龟汤 3 次 / 经典 2 次，两局是刻意给的不同值）。
    //    只断言 totalGames===1 && wins===1 是**不够的**：mode=turtle 若被白名单漏掉而
    //    静默回落成 single，这个 tab 会显示经典那一局，而那两个数字照样是 1 —— 断言全绿、
    //    榜却是错的。totalGuesses 才是能把两局区分开的那个字段。
    const lbTurtle = await api('/api/leaderboard?mode=turtle&limit=50', { ip: nextIp() });
    const tRow = (lbTurtle.data?.leaderboard || [])[0];
    check('d1.?mode=turtle 命中的是海龟汤那一局（totalGuesses=3，不是经典那局的 2）',
      lbTurtle.status === 200 && !!tRow && tRow.totalGames === 1 && tRow.wins === 1 && tRow.totalGuesses === 3,
      `status=${lbTurtle.status} row=${JSON.stringify(tRow)}`);

    const lbSingle = await api('/api/leaderboard?mode=single&limit=50', { ip: nextIp() });
    const sRow = (lbSingle.data?.leaderboard || [])[0];
    check('d2.?mode=single 命中的是经典那一局（totalGuesses=2），两张榜没串',
      lbSingle.status === 200 && !!sRow && sRow.totalGames === 1 && sRow.wins === 1 && sRow.totalGuesses === 2,
      `status=${lbSingle.status} row=${JSON.stringify(sRow)}`);

    // ══════════════ e. 难度筛选对海龟汤同样生效 ══════════════
    console.log('\n[e] 海龟汤榜的难度筛选');
    const lbEasy = await api('/api/leaderboard?mode=turtle&difficulty=easy&limit=50', { ip: nextIp() });
    const lbHard = await api('/api/leaderboard?mode=turtle&difficulty=hard&limit=50', { ip: nextIp() });
    check('e1.easy 档命中、hard 档为空（难度是真的在过滤，不是在忽略参数）',
      (lbEasy.data?.leaderboard || []).length === 1 && (lbHard.data?.leaderboard || []).length === 0,
      `easy=${(lbEasy.data?.leaderboard || []).length} 条, hard=${(lbHard.data?.leaderboard || []).length} 条`);

    // ══════════════ f. 不进个人战绩聚合 ══════════════
    console.log('\n[f] /api/me：海龟汤不进战绩聚合');
    const me = await api('/api/me', { token: jwt, ip: nextIp() });
    const st = me.data?.stats || {};
    const byMode = me.data?.stats?.byMode || {};
    const detailSum = Object.values(byMode).reduce((a, b) => a + b, 0);
    check('f1.totalGames=1（只有经典那局；海龟汤没被算进去）',
      st.totalGames === 1,
      `totalGames=${st.totalGames} wins=${st.wins} bestScore=${st.bestScore}`);
    check('f2.bestScore=2（经典那局的成绩；若海龟汤的 3 次混进来会变成 2 仍成立，故配合 f1/f3 一起看）',
      st.bestScore === 2, `bestScore=${st.bestScore}`);
    check('f3.byMode 明细之和 === totalGames（漏改谓词会在这里炸）',
      detailSum === st.totalGames,
      `明细 ${JSON.stringify(byMode)} 之和=${detailSum} vs totalGames=${st.totalGames}`);
    check('f4.byMode 里没有 turtle 键，且 single=1',
      !('turtle' in byMode) && byMode.single === 1,
      `byMode=${JSON.stringify(byMode)}`);

    // ══════════════ g. 不进个人历史 ══════════════
    console.log('\n[g] /api/history：海龟汤不出现在个人历史');
    const hist = await api('/api/history?limit=80', { token: jwt, ip: nextIp() });
    const rows = hist.data?.history || [];
    const modes = rows.map(r => r.mode);
    check('g1.历史里恰好 1 条（经典那局），没有 turtle 行',
      rows.length === 1 && !modes.includes('turtle'),
      `count=${rows.length} modes=${JSON.stringify(modes)}`);

    // ══════════════ h. 游客提交不上榜 ══════════════
    console.log('\n[h] 游客（未登录）提交海龟汤');
    const guest = await api('/api/save-game', {
      method: 'POST', ip: nextIp(),
      body: {
        won: true, guessCount: 1, difficulty: 'easy',
        targetName: turtleAnswer, mode: 'turtle',
        timestamp: new Date().toISOString(),
      },
    });
    check('h1.游客提交被接受（与经典单人一致：游客能玩）',
      guest.status === 200, `status=${guest.status}`);
    // 排行榜是 INNER JOIN users，游客行 user_id 为 NULL → 不出现。
    // 这一条同时反向证明了 d1 的「1 条」不是巧合。
    await sleep(200);
    const lbAfter = await api('/api/leaderboard?mode=turtle&limit=50', { ip: nextIp() });
    const afterRows = lbAfter.data?.leaderboard || [];
    check('h2.游客那局不上榜（INNER JOIN users 挡住了 user_id=NULL）',
      afterRows.length === 1 && afterRows[0].totalGames === 1,
      `榜上 ${afterRows.length} 人，totalGames=${afterRows[0]?.totalGames}`);
  } finally {
    killBackend(backend);
    await sleep(300);
    cleanupDb(DB_PATH);
  }
  return 0;
}

const exitCode = await main().catch((e) => { console.error('❌ 未捕获异常:', e); return 1; });
finish(exitCode);
