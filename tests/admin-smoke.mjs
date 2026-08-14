#!/usr/bin/env node
// 管理面板冒烟测试（API 级 + better-sqlite3 直连临时库提权）
//
// 临时 DB 初始无 admin，流程：注册 + 验证两个用户 → better-sqlite3 直连临时库把 A 提为 admin
// → 用 A 的 JWT 覆盖管理端点（dashboard/公告/用户/封禁/角色/令牌/审计/在线）→ 权限负面用例。
//
// 坑（已处理）：DNS MX 校验用真实域 gmail.com；限流用递增 X-Real-IP + 随机邮箱/用户名。

import { createRequire } from 'node:module';
import {
  BACKEND_PORT, check, finish, makeDbPath,
  startBackend, killBackend, waitForBackend, cleanupDb,
} from './helpers.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const DB_PATH = makeDbPath('admin');
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

// 注册 + 验证，返回 { jwt, userId }
async function registerAndVerify(username, password, email) {
  const reg = await api('/api/register', { method: 'POST', body: { username, password, email }, ip: nextIp() });
  if (reg.status !== 200 || !reg.data?.devVerifyLink) throw new Error(`register failed: ${reg.status}`);
  const token = new URL(reg.data.devVerifyLink).searchParams.get('token');
  const verify = await api(`/api/verify-email?token=${token}`);
  if (verify.status !== 200 || !verify.data?.token) throw new Error(`verify failed: ${verify.status}`);
  return { jwt: verify.data.token, userId: verify.data.userId };
}

async function main() {
  const backend = startBackend({ dbPath: DB_PATH });
  try {
    await waitForBackend(BACKEND_PORT);

    // 两个普通用户：A 将提权为 admin，B 用于权限负面 + 封禁/角色测试
    const A = await registerAndVerify(`u${rnd()}`, 'test-pass-123', `smoke-${rnd()}@gmail.com`);
    const B = await registerAndVerify(`u${rnd()}`, 'test-pass-123', `smoke-${rnd()}@gmail.com`);

    // 直连临时库把 A 提为 admin
    const db = new Database(DB_PATH);
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run('admin', A.userId);
    db.close();

    // ── 权限负面（B 尚未封禁，是正常用户但非 admin）──
    console.log('\n[权限] 非 admin / 未登录');
    const nonAdmin = await api('/api/admin/dashboard', { token: B.jwt });
    check('非 admin 访问 admin API → 403', nonAdmin.status === 403, `status=${nonAdmin.status}`);
    const noAuth = await api('/api/admin/dashboard');
    check('无 token 访问 admin API → 401', noAuth.status === 401, `status=${noAuth.status}`);

    // ── dashboard ──
    console.log('\n[dashboard]');
    const dash = await api('/api/admin/dashboard', { token: A.jwt });
    check('dashboard 返回统计字段', dash.status === 200 && typeof dash.data?.totalUsers === 'number' && typeof dash.data?.onlineNow === 'number', `status=${dash.status}`);

    // ── 公告 CRUD ──
    console.log('\n[公告 CRUD]');
    const annCreate = await api('/api/admin/announcements', { method: 'POST', body: { title: '冒烟公告', content: '内容', is_popup: false }, token: A.jwt });
    check('创建公告', annCreate.status === 200 && !!annCreate.data?.id, `status=${annCreate.status}`);
    const annId = annCreate.data?.id;
    const annUpdate = await api(`/api/admin/announcements/${annId}`, { method: 'PUT', body: { title: '冒烟公告-改' }, token: A.jwt });
    check('更新公告', annUpdate.status === 200 && annUpdate.data?.ok === true, `status=${annUpdate.status}`);
    const annDelete = await api(`/api/admin/announcements/${annId}`, { method: 'DELETE', token: A.jwt });
    check('删除公告', annDelete.status === 200 && annDelete.data?.ok === true, `status=${annDelete.status}`);

    // ── 用户管理 ──
    console.log('\n[用户管理]');
    const users = await api('/api/admin/users', { token: A.jwt });
    check('用户列表含刚注册用户', users.status === 200 && users.data?.total >= 2, `total=${users.data?.total}`);

    const ban = await api(`/api/admin/users/${B.userId}/ban`, { method: 'PATCH', body: { banned: true }, token: A.jwt });
    check('封禁用户', ban.status === 200 && ban.data?.banned === true, `status=${ban.status}`);
    const unban = await api(`/api/admin/users/${B.userId}/ban`, { method: 'PATCH', body: { banned: false }, token: A.jwt });
    check('解封用户', unban.status === 200 && unban.data?.banned === false, `status=${unban.status}`);

    const promote = await api(`/api/admin/users/${B.userId}/role`, { method: 'PATCH', body: { role: 'admin' }, token: A.jwt });
    check('提升用户为 admin', promote.status === 200 && promote.data?.role === 'admin', `status=${promote.status}`);
    const demote = await api(`/api/admin/users/${B.userId}/role`, { method: 'PATCH', body: { role: 'user' }, token: A.jwt });
    check('不能降级其他管理员 → 403（防夺权）', demote.status === 403, `status=${demote.status}`);

    // ── 令牌 ──
    console.log('\n[API 令牌]');
    const tokCreate = await api('/api/admin/tokens', { method: 'POST', body: { name: '冒烟令牌' }, token: A.jwt });
    check('创建令牌', tokCreate.status === 200 && typeof tokCreate.data?.token === 'string', `status=${tokCreate.status}`);
    const tokList = await api('/api/admin/tokens', { token: A.jwt });
    const tokId = tokList.data?.tokens?.[0]?.id;
    check('令牌列表含刚创建', tokList.status === 200 && !!tokId, `total=${tokList.data?.total}`);
    const tokDelete = await api(`/api/admin/tokens/${tokId}`, { method: 'DELETE', token: A.jwt });
    check('吊销令牌', tokDelete.status === 200 && tokDelete.data?.ok === true, `status=${tokDelete.status}`);

    // ── 审计 + 在线 ──
    console.log('\n[审计 & 在线]');
    const audit = await api('/api/admin/audit-log', { token: A.jwt });
    check('审计日志可读', audit.status === 200 && Array.isArray(audit.data?.logs), `status=${audit.status}`);
    const online = await api('/api/admin/online', { token: A.jwt });
    check('在线玩家可读', online.status === 200 && typeof online.data?.totalOnline === 'number', `status=${online.status}`);

    return 0;
  } catch (e) {
    console.error('\n❌ 管理面板冒烟异常：', e.message);
    return 1;
  } finally {
    killBackend(backend);
    await cleanupDb(DB_PATH);
  }
}

const exitCode = await main();
finish(exitCode);
