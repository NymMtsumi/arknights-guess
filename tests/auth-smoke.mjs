#!/usr/bin/env node
// 认证链路冒烟测试（API 级，Node fetch 直连后端，无需 Playwright）
//
// 覆盖：register → verify-email → me → login → forgot-password → reset-password →
//      旧 token 失效 → 新密码登录，以及关键负面用例（401/409/400）。
//
// dev 模式（NODE_ENV=development）下 register 返回 devVerifyLink、forgot 返回 devResetLink，
// 均无需真实 SMTP；token 从链接解析。
//
// 坑（已处理）：
//   - DNS MX 校验：用真实域 gmail.com + 随机本地部分，避免 400
//   - 内存限流：每次请求注入递增 X-Real-IP（本地 127.0.0.1 时后端信任该头），
//     邮箱/用户名随机化，避免撞 IP/邮箱限流桶

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ROOT, BACKEND_PORT, check, finish, makeDbPath,
  startBackend, killBackend, waitForBackend, cleanupDb,
} from './helpers.mjs';

const DB_PATH = makeDbPath('auth');
const BASE = `http://localhost:${BACKEND_PORT}`;

let ipSeq = 0;
const nextIp = () => `10.0.0.${++ipSeq}`;
const rnd = () => Math.random().toString(36).slice(2, 10);

async function api(path, { method = 'GET', body, token, ip } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (ip) headers['X-Real-IP'] = ip;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

function tokenFromLink(link) {
  try { return new URL(link).searchParams.get('token'); } catch { return null; }
}

async function main() {
  // DEPLOY_TOKEN 必须有值：否则 /api/deploy 走「未配置」分支返回 500，
  // 就分辨不出「请求被 CSRF 门拦下」和「请求到了 handler 但配置缺失」。
  const backend = startBackend({ dbPath: DB_PATH, extraEnv: { DEPLOY_TOKEN: 'smoke-deploy-token' } });
  try {
    await waitForBackend(BACKEND_PORT);

    const email = `smoke-${rnd()}@gmail.com`;
    const username = `u${rnd()}`;
    const password = 'test-pass-123';
    const newPassword = 'new-pass-456';

    // ── 正向链 ──
    console.log('\n[1] 注册');
    const reg = await api('/api/register', { method: 'POST', body: { username, password, email }, ip: nextIp() });
    check('注册成功（dev 返回 devVerifyLink）', reg.status === 200 && !!reg.data?.devVerifyLink, `status=${reg.status}`);
    const verifyToken = tokenFromLink(reg.data?.devVerifyLink);
    check('注册链接含 token', !!verifyToken);

    console.log('\n[2] 邮箱验证');
    const verify = await api(`/api/verify-email?token=${verifyToken}`);
    check('验证成功并自动登录（返回 JWT + email_verified）',
      verify.status === 200 && !!verify.data?.token && verify.data?.email_verified === true, `status=${verify.status}`);
    const jwt = verify.data?.token;

    console.log('\n[3] 获取当前用户');
    const me = await api('/api/me', { token: jwt });
    check('GET /api/me 返回正确用户', me.status === 200 && me.data?.username === username && me.data?.email_verified === true);
    check('me 含 stats 聚合字段', !!(me.data?.stats && typeof me.data.stats.totalGames === 'number'));

    console.log('\n[4] 登录');
    const login = await api('/api/login', { method: 'POST', body: { email, password }, ip: nextIp() });
    check('登录成功', login.status === 200 && !!login.data?.token, `status=${login.status}`);

    // ── [4b] 统计口径 byMode 必须能与 totalGames 对账 ──
    // 这是「统计页总场次 ≠ 排行榜场次」那个 BUG 的不变量：/api/me 的聚合口径是
    // `mode != 'custom'`（经典+多人+每日），而 /api/leaderboard 每个 tab 只取
    // `WHERE mode = ?` —— 两边本来就不是一个量。拆出 byMode 明细才能逐项对上，
    // 而「明细之和 == 总数」要求两条 SQL 的谓词逐字一致，正是最容易改歪的地方。
    // 用真实落库记录来测（save-game 认 Bearer token，归属到 user_id）。
    console.log('\n[4b] 统计口径 byMode 对账');
    const chars = JSON.parse(await readFile(join(ROOT, 'server', 'characters.json'), 'utf8'));
    const knownName = chars[0]?.name;
    const jwt4b = login.data.token;
    const saveSingle = await api('/api/save-game', {
      method: 'POST', token: jwt4b, ip: nextIp(),
      body: { won: false, guessCount: 3, mode: 'single', difficulty: 'easy', targetName: knownName },
    });
    const saveMulti = await api('/api/save-game', {
      method: 'POST', token: jwt4b, ip: nextIp(),
      body: { won: false, guessCount: 0, mode: 'multi', difficulty: 'hard', targetName: '' },
    });
    // ⚠️ 这条 custom 是**必须有**的，不是为了凑数：`totalGames` 与 `byMode` 两条 SQL 的
    //    谓词都是 `mode != 'custom'`，而 custom 正是这条谓词的唯一分界。fixture 里不放
    //    一行 custom，下面「明细之和 == totalGames」在把谓词改歪（例如漏掉 mode != 'custom'）
    //    时**照样通过** —— 实测过：无 custom 行时 total 2 / sum 2 相等；有 custom 行时
    //    total 3 / sum 2 才暴露。custom 不进 byMode（user.js 的 `if (row.mode in byMode)` 会跳过），
    //    所以它只应抬高 totalGames 的"应然值"，不改变 sum。
    const saveCustom = await api('/api/save-game', {
      method: 'POST', token: jwt4b, ip: nextIp(),
      body: { won: false, guessCount: 2, mode: 'custom', difficulty: 'hard', targetName: knownName },
    });
    check('save-game 单人入库', saveSingle.status === 200, `status=${saveSingle.status} ${saveSingle.data?.error || ''}`);
    check('save-game 多人入库', saveMulti.status === 200, `status=${saveMulti.status} ${saveMulti.data?.error || ''}`);
    check('save-game 自定义房入库', saveCustom.status === 200, `status=${saveCustom.status} ${saveCustom.data?.error || ''}`);

    const me2 = await api('/api/me', { token: jwt4b });
    const bm = me2.data?.stats?.byMode; // ⚠️ 在 stats 里，不是顶层
    check('GET /api/me 带 byMode 三项', !!bm
      && typeof bm.single === 'number' && typeof bm.multi === 'number' && typeof bm.daily === 'number',
      JSON.stringify(bm));
    check('byMode.single / multi 各记 1 场', bm?.single === 1 && bm?.multi === 1, JSON.stringify(bm));
    // custom 落了 1 条，但两条 SQL 都把它排除在外 —— 所以 totalGames 应当仍是 2，不是 3。
    // 这一条同时钉住「谓词一致」和「custom 确实被排除」两件事。
    const sum = bm ? bm.single + bm.multi + bm.daily : -1;
    check('custom 不计入 totalGames（谓词 mode != \'custom\' 生效）',
      me2.data?.stats?.totalGames === 2, `totalGames=${me2.data?.stats?.totalGames}（3 = custom 漏进了统计口径）`);
    check('byMode 明细之和 == totalGames（口径可对账；含 custom 行时仍成立）',
      !!bm && sum === me2.data?.stats?.totalGames,
      `明细和=${sum} totalGames=${me2.data?.stats?.totalGames}`);

    console.log('\n[5] 忘记密码');
    const forgot = await api('/api/forgot-password', { method: 'POST', body: { email }, ip: nextIp() });
    check('忘记密码返回 devResetLink', forgot.status === 200 && !!forgot.data?.devResetLink, `status=${forgot.status}`);
    const resetToken = tokenFromLink(forgot.data?.devResetLink);
    check('重置链接含 token', !!resetToken);

    console.log('\n[6] 重置密码');
    const reset = await api('/api/reset-password', { method: 'POST', body: { token: resetToken, password: newPassword }, ip: nextIp() });
    check('重置密码成功', reset.status === 200 && reset.data?.ok === true, `status=${reset.status}`);

    console.log('\n[7] 旧 token 失效（token_version 递增）');
    const meOld = await api('/api/me', { token: jwt });
    check('旧 token 访问 /api/me → 401', meOld.status === 401, `status=${meOld.status}`);

    console.log('\n[8] 新密码登录');
    const login2 = await api('/api/login', { method: 'POST', body: { email, password: newPassword }, ip: nextIp() });
    check('新密码登录成功', login2.status === 200 && !!login2.data?.token, `status=${login2.status}`);

    // ── 负面用例 ──
    console.log('\n[9] 负面用例');
    const badLogin = await api('/api/login', { method: 'POST', body: { email, password: 'wrong-pass' }, ip: nextIp() });
    check('错误密码 → 401', badLogin.status === 401, `status=${badLogin.status}`);

    const dupReg = await api('/api/register', { method: 'POST', body: { username, password, email }, ip: nextIp() });
    check('重复注册 → 409', dupReg.status === 409, `status=${dupReg.status}`);

    const shortReg = await api('/api/register', { method: 'POST', body: { username: `x${rnd()}`, password: 'short', email: `smoke-${rnd()}@gmail.com` }, ip: nextIp() });
    check('密码 <8 → 400', shortReg.status === 400, `status=${shortReg.status}`);

    const badReset = await api('/api/reset-password', { method: 'POST', body: { token: 'deadbeef'.repeat(8), password: newPassword }, ip: nextIp() });
    check('无效重置 token → 400', badReset.status === 400, `status=${badReset.status}`);

    const reuseReset = await api('/api/reset-password', { method: 'POST', body: { token: resetToken, password: newPassword }, ip: nextIp() });
    check('已用重置 token → 400', reuseReset.status === 400, `status=${reuseReset.status}`);

    const noAuthMe = await api('/api/me');
    check('无 token 访问 /api/me → 401', noAuthMe.status === 401, `status=${noAuthMe.status}`);

    // ── 用户枚举：未注册邮箱的 forgot-password 不能给出可判别的信号 ──
    // 修前未注册邮箱回 404「该邮箱尚未注册」→ 拿一份邮箱清单刷一遍就知道哪些地址注册过本站。
    // ⚠️ 断言「状态码为 200 且文案 == 通用文案」，而不只是「不再是 404」——
    //    后者可以靠改成另一个 400/别的措辞蒙混过关，那依然可判别。
    //    这里**不**去比对已注册邮箱的响应：dev 环境下已注册会多带 devResetLink
    //    （与 register 的 devVerifyLink 同一套设计，见 CLAUDE.md「dev 链接不落生产」），
    //    拿它做「不可区分」的基准会得到一个只在开发环境成立的假结论。
    console.log('\n[用户枚举] /api/forgot-password');
    const enumUnknown = await api('/api/forgot-password', { method: 'POST', body: { email: `nobody-${rnd()}@gmail.com` }, ip: nextIp() });
    check('未注册邮箱不再回 404', enumUnknown.status === 200, `status=${enumUnknown.status}`);
    check('未注册邮箱回通用文案（无枚举信号）',
      enumUnknown.data?.message === '如果该邮箱已注册，重置邮件已发送',
      `message=${JSON.stringify(enumUnknown.data?.message)}`);

    // ── 游客战绩迁移契约（/api/sync）──
    // 回归的正是这次修掉的丢档事故：线上单人历史记录**没有 mode 字段**
    // （见 src/lib/stats.ts 的 GameRecord），而服务端曾要求 mode 必须是
    // 'single'/'multi' 字面量 → 整批被静默跳过，客户端却把本地记录标记成已迁移并删掉。
    //
    // ⚠️ 下面这条 payload **故意不带 mode**，就是为了钉住这个形状。
    //    把它改成带 mode:'single' 会让测试失去意义 —— 那正是当初漏掉的那一步。
    console.log('\n[迁移契约] /api/sync');
    const syncToken = login2.data?.token;
    const ts0 = Date.now() - 60_000;
    const payload = [
      { timestamp: new Date(ts0).toISOString(), targetName: '能天使', won: true, guessCount: 3, difficulty: 'hard' },
      { timestamp: new Date(ts0 + 1000).toISOString(), targetName: '银灰', won: false, guessCount: 8, difficulty: 'medium' },
      { timestamp: new Date(ts0 + 2000).toISOString(), targetName: '陈', won: true, guessCount: 5, difficulty: 'easy' },
    ];

    const meBefore = await api('/api/me', { token: syncToken });
    const before = meBefore.data?.stats?.totalGames ?? -1;

    const sync1 = await api('/api/sync', { method: 'POST', body: { player_key: 'p_smoke_guest', games: payload }, token: syncToken, ip: nextIp() });
    check('缺 mode 字段的单人战绩被收下（不再静默跳过）', sync1.status === 200 && sync1.data?.synced === 3, `status=${sync1.status} synced=${sync1.data?.synced}`);
    check('返回逐行 results（客户端据此决定哪些本地记录可删）', Array.isArray(sync1.data?.results) && sync1.data.results.length === 3 && sync1.data.results.every((r) => r === 'new'), `results=${JSON.stringify(sync1.data?.results)}`);

    const meAfter = await api('/api/me', { token: syncToken });
    check('/api/me 统计 +3', (meAfter.data?.stats?.totalGames ?? -1) === before + 3, `before=${before} after=${meAfter.data?.stats?.totalGames}`);

    // 同一批再传一次 = 重复登录后重新上传。必须幂等：不新增行，且客户端仍能判定「已迁移」。
    const sync2 = await api('/api/sync', { method: 'POST', body: { player_key: 'p_smoke_guest', games: payload }, token: syncToken, ip: nextIp() });
    check('重复上传幂等（synced=0 / duplicates=3）', sync2.status === 200 && sync2.data?.synced === 0 && sync2.data?.duplicates === 3, `synced=${sync2.data?.synced} dup=${sync2.data?.duplicates}`);
    check('重复行的 results 标为 dup（客户端才不会反复重传）', Array.isArray(sync2.data?.results) && sync2.data.results.every((r) => r === 'dup'), `results=${JSON.stringify(sync2.data?.results)}`);

    const meAfter2 = await api('/api/me', { token: syncToken });
    check('重复上传不刷新统计（防刷榜）', (meAfter2.data?.stats?.totalGames ?? -1) === before + 3, `after=${meAfter2.data?.stats?.totalGames}`);

    const syncBad = await api('/api/sync', { method: 'POST', body: { player_key: 'p_smoke_guest', games: [{ mode: 'daily', timestamp: new Date(ts0 + 5000).toISOString(), targetName: '陈', won: true, guessCount: 1 }] }, token: syncToken, ip: nextIp() });
    check('daily 仍被拒绝（results 标 bad，不进经典榜）', syncBad.data?.results?.[0] === 'bad' && syncBad.data?.synced === 0, `results=${JSON.stringify(syncBad.data?.results)}`);

    // ── CSRF 门 ──
    // token cookie 是 SameSite=None（前端 www.* / API ws.* 跨站，必须如此），
    // 浏览器会自动把它带在任何跨站请求上。下面两条就是攻击者能构造的形态。
    console.log('\n[CSRF 门]');
    const raw = async (path, { method = 'POST', headers = {}, body } = {}) => {
      const res = await fetch(`${BASE}${path}`, { method, headers, body });
      let data = null; try { data = await res.json(); } catch {}
      return { status: res.status, data };
    };

    // 简单请求：text/plain 不触发预检 → 修前会一路打到 handler
    const plain = await raw('/api/register', {
      headers: { 'Content-Type': 'text/plain', 'X-Real-IP': nextIp(), Origin: 'https://evil.example' },
      body: JSON.stringify({ username: `x${rnd()}`, password: 'test-pass-123', email: `x-${rnd()}@gmail.com` }),
    });
    check('text/plain + 跨站 Origin 的注册被拒 → 403', plain.status === 403, `status=${plain.status} ${JSON.stringify(plain.data)?.slice(0, 80)}`);

    // 合法 Content-Type，但 Origin 指向站外
    const badOrigin = await raw('/api/register', {
      headers: { 'Content-Type': 'application/json', 'X-Real-IP': nextIp(), Origin: 'https://evil.example' },
      body: JSON.stringify({ username: `x${rnd()}`, password: 'test-pass-123', email: `x-${rnd()}@gmail.com` }),
    });
    check('跨站 Origin 的 JSON 注册被拒 → 403', badOrigin.status === 403, `status=${badOrigin.status}`);

    // 放行侧：无 body、无 Content-Type 的 logout（前端真实调用形态）不能被误杀
    const logoutNoBody = await raw('/api/logout', { headers: { 'X-Real-IP': nextIp() } });
    check('无 body 的 logout 不被 CSRF 门误杀', logoutNoBody.status !== 403, `status=${logoutNoBody.status}`);

    // 放行侧：GitHub Actions 的部署 webhook 形态（JSON + 无 Origin）
    // 403 必须来自令牌校验本身，而不是 CSRF 门 —— 那才是「门放行了」的证据。
    const deployShape = await raw('/api/deploy', { headers: { 'Content-Type': 'application/json', 'X-Real-IP': nextIp() }, body: JSON.stringify({ token: 'wrong' }) });
    check('部署 webhook 形态未被 CSRF 门误杀（403 来自令牌校验）', deployShape.status === 403 && deployShape.data?.error === '部署令牌无效', `status=${deployShape.status} err=${deployShape.data?.error}`);
    // ⚠️ 别在这里试「正确令牌」：admin.js:494 接到正确令牌会 spawn server/deploy.sh，
    //    本地就会真的跑一遍拉取+重启。上面这条 403 的措辞是「部署令牌无效」而非
    //    CSRF 的「来源不被允许 / Content-Type 必须为 application/json」，
    //    已经足以证明请求穿过了 CSRF 门、到达 handler。

    return 0;
  } catch (e) {
    console.error('\n❌ 认证冒烟异常：', e.message);
    return 1;
  } finally {
    killBackend(backend);
    await cleanupDb(DB_PATH);
  }
}

const exitCode = await main();
finish(exitCode);
