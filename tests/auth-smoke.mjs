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

import {
  BACKEND_PORT, check, finish, makeDbPath,
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
  const backend = startBackend({ dbPath: DB_PATH });
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
