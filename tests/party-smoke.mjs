#!/usr/bin/env node
// 派对模式 — 双/多客户端冒烟测试（Playwright 多 BrowserContext）
//
// 覆盖 checklist（作为上线前置 gate，全部通过才允许部署）：
//   a. 建房 → 房主算 1 人
//   b. 二号搜号进房
//   c. 点分享链接 ?room=CODE 自动进房（而非跳回 lobby）
//   d. 非房主准备 → 房主开始 → 进入倒计时/游戏中
//   e. 有人点离开 → 人数正确回落、本人 UI 复位
//   f. 断线重连 → 他人视角先显示断线、重连（同 player_key）后清除
//
// 脚本自行完成：
//   1) 起后端（临时 DB，零依赖生产配置）
//   2) 静态服务 out/（需要先用 NEXT_PUBLIC_WS_URL 指向本后端 build 前端）
//   3) 开三个隔离的 BrowserContext 跑 a-f
//   4) 清理临时进程与文件
//
// 运行：NEXT_PUBLIC_WS_URL=http://localhost:3101 npm run build && node tests/party-smoke.mjs
//   或直接：npm run smoke（内部先 build 再测）

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, stat, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT_DIR = join(ROOT, 'out');

const BACKEND_PORT = Number(process.env.SMOKE_BACKEND_PORT || 3101);
const FRONTEND_PORT = Number(process.env.SMOKE_FRONTEND_PORT || 3100);
const FRONTEND_ORIGIN = `http://localhost:${FRONTEND_PORT}`;
const DB_PATH = join(os.tmpdir(), `arknights-guess-smoke-${process.pid}.db`);
const WAIT_TIMEOUT = 20_000;

// ── 结果收集 ──
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// ═══════════════════════════════════════════════
//  静态服务器（服务 out/，含 SPA 回退 + 路由相对 _next 资源）
// ═══════════════════════════════════════════════
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};

async function resolveFile(urlPath) {
  const rel = decodeURIComponent((urlPath || '/').split('?')[0]);
  const outRoot = normalize(OUT_DIR);
  const candidate = normalize(join(outRoot, rel));
  if (!candidate.startsWith(outRoot + '\\') && !candidate.startsWith(outRoot + '/') && candidate !== outRoot) {
    return null; // 路径穿越防护
  }

  // 1. 精确文件
  if (existsSync(candidate) && (await stat(candidate)).isFile()) return candidate;
  // 2. 目录 → index.html（/party → out/party/index.html）
  if (existsSync(candidate) && (await stat(candidate)).isDirectory()) {
    const idx = join(candidate, 'index.html');
    if (existsSync(idx) && (await stat(idx)).isFile()) return idx;
  }
  // 3. 文件 + .html 形式
  const htmlForm = candidate + '.html';
  if (existsSync(htmlForm) && (await stat(htmlForm)).isFile()) return htmlForm;
  // 4. 路由相对的 _next 静态资源（/party/_next/... → /_next/...）
  const nextIdx = rel.indexOf('/_next/');
  if (nextIdx >= 0) {
    const stripped = normalize(join(outRoot, rel.slice(nextIdx + 1)));
    if (existsSync(stripped) && (await stat(stripped)).isFile()) return stripped;
  }
  // 5. SPA 回退（客户端深层路由）
  const rootIdx = join(outRoot, 'index.html');
  return existsSync(rootIdx) ? rootIdx : null;
}

function startStaticServer() {
  const server = createServer(async (req, res) => {
    try {
      const file = await resolveFile(req.url || '/');
      if (!file) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
      const data = await readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(String(e));
    }
  });
  return new Promise((resolve) => server.listen(FRONTEND_PORT, () => resolve(server)));
}

// ═══════════════════════════════════════════════
//  后端（hermetic：临时 DB + dev JWT 回退 + 放行本静态源）
// ═══════════════════════════════════════════════
function startBackend() {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(BACKEND_PORT),
      DB_PATH,
      NODE_ENV: 'development',
      ALLOW_DEV_FALLBACK: '1',
      // 放行本冒烟测试的静态前端源（覆盖默认 allowlist）
      ALLOWED_ORIGINS: `${FRONTEND_ORIGIN},http://localhost:3000`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`[backend] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[backend] ${d}`));
  return child;
}

function killBackend(child) {
  if (!child || child.exitCode !== null) return;
  try { child.kill('SIGTERM'); } catch {}
  // 兜底：2s 后仍未退出则强杀（Windows 上 SIGTERM 不触发优雅关闭）
  setTimeout(() => {
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch {} }
  }, 2000).unref();
}

// ═══════════════════════════════════════════════
//  工具
// ═══════════════════════════════════════════════
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = WAIT_TIMEOUT, interval = 150, desc = '' } = {}) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeout) {
    try { const v = await fn(); if (v) return v; } catch (e) { lastErr = e; }
    await sleep(interval);
  }
  throw new Error(`timeout (${desc})${lastErr ? `: ${lastErr.message}` : ''}`);
}

async function readCount(page) {
  const txt = await page.locator('[data-testid="party-player-count"]').textContent();
  const m = (txt || '').match(/(\d+)\s*\/\s*\d+/);
  return m ? parseInt(m[1], 10) : -1;
}

async function waitForCount(page, n, timeout = WAIT_TIMEOUT) {
  await waitFor(async () => (await readCount(page)) === n, { timeout, desc: `count == ${n}` });
  return readCount(page);
}

async function enterLobby(page) {
  await page.locator('[data-testid="party-menu-join"]').click({ timeout: WAIT_TIMEOUT });
  await page.locator('[data-testid="party-create"]').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
}

// ═══════════════════════════════════════════════
//  主流程
// ═══════════════════════════════════════════════
async function main() {
  // 预检：前端必须已 build（且 NEXT_PUBLIC_WS_URL 指向本后端）
  if (!existsSync(join(OUT_DIR, 'index.html'))) {
    console.error(`❌ 未找到 ${join(OUT_DIR, 'index.html')}`);
    console.error(`   请先构建：NEXT_PUBLIC_WS_URL=http://localhost:${BACKEND_PORT} npm run build`);
    return 1;
  }

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.error('❌ 未安装 playwright。请先运行：npm i -D playwright && npx playwright install chromium');
    return 1;
  }

  const backend = startBackend();
  let staticServer = null;
  let browser = null;

  try {
    console.log(`⏳ 等待后端就绪 http://localhost:${BACKEND_PORT}/api/health ...`);
    await waitFor(async () => {
      const r = await fetch(`http://localhost:${BACKEND_PORT}/api/health`);
      return r.ok;
    }, { timeout: 25_000, desc: 'backend health' });
    console.log('✅ 后端就绪');

    staticServer = await startStaticServer();
    browser = await chromium.launch({ headless: true });

    // 三个隔离 context：A 房主 / B 搜号加入 / C 分享链接加入
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const ctxC = await browser.newContext();
    const A = await ctxA.newPage();
    let B = await ctxB.newPage();
    const C = await ctxC.newPage();

    // ── a. 建房 → 房主算 1 人 ──
    console.log('\n[a] 房主建房');
    await A.goto(`${FRONTEND_ORIGIN}/party`, { waitUntil: 'domcontentloaded' });
    await enterLobby(A);
    await A.locator('[data-testid="party-create"]').click({ timeout: WAIT_TIMEOUT });
    const count1 = await waitForCount(A, 1);
    check('a.建房后房主算 1 人', count1 === 1, `count=${count1}`);
    const code = (await A.locator('[data-testid="party-room-code"]').textContent()).trim();
    check('a.房间码生成（6 位数字）', /^\d{6}$/.test(code), code);

    // ── b. 二号搜号进房 ──
    console.log('\n[b] 二号搜号进房');
    await B.goto(`${FRONTEND_ORIGIN}/party`, { waitUntil: 'domcontentloaded' });
    await enterLobby(B);
    await B.locator('[data-testid="party-join-input"]').fill(code);
    await B.locator('#party-join-btn').click({ timeout: WAIT_TIMEOUT });
    await waitForCount(B, 2);
    await waitForCount(A, 2);
    check('b.二号搜号进房（双方见 2 人）', true);

    // ── c. 分享链接自动进房 ──
    console.log('\n[c] 分享链接自动进房');
    await C.goto(`${FRONTEND_ORIGIN}/party?room=${code}`, { waitUntil: 'domcontentloaded' });
    await C.locator('[data-testid="party-room-code"]').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    await waitForCount(C, 3);
    await waitForCount(A, 3);
    check('c.分享链接自动进房（非跳回 lobby）', true, '3 人');

    // ── f. 断线重连 → 他人视角先显示断线、重连后清除 ──
    console.log('\n[f] 断线重连');
    await B.close(); // 关闭页面 → socket 断开，服务端广播 party:player_disconnected
    await waitFor(async () => (await A.locator('[data-testid="party-disconnected-badge"]').count()) === 1, {
      timeout: WAIT_TIMEOUT, desc: 'B 掉线后 A 侧出现断线徽标',
    });
    check('f.掉线后他人视角显示断线', true);
    B = await ctxB.newPage(); // 同 context → 复用同一 player_key，触发重连分支
    await B.goto(`${FRONTEND_ORIGIN}/party?room=${code}`, { waitUntil: 'domcontentloaded' });
    await B.locator('[data-testid="party-room-code"]').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    await waitFor(async () => (await A.locator('[data-testid="party-disconnected-badge"]').count()) === 0, {
      timeout: WAIT_TIMEOUT, desc: 'B 重连后 A 侧断线徽标清除',
    });
    check('f.重连后他人视角不再显示断线', true);
    await waitForCount(A, 3);
    await waitForCount(B, 3);
    check('f.重连后双方仍见 3 人', true);

    // ── e. 有人离开 → 人数回落、本人 UI 复位 ──
    console.log('\n[e] 离开按钮');
    await C.locator('[data-testid="party-leave"]').click({ timeout: WAIT_TIMEOUT });
    await C.locator('[data-testid="party-menu-join"]').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    await waitForCount(A, 2);
    check('e.离开后人数回落 + 本人 UI 复位', true, 'C 回菜单，A 见 2 人');

    // C 重新加入（凑满 3 人，为 d 做准备）
    console.log('\n[c2] C 重新加入');
    await C.locator('[data-testid="party-menu-join"]').click({ timeout: WAIT_TIMEOUT });
    await C.locator('[data-testid="party-join-input"]').fill(code);
    await C.locator('#party-join-btn').click({ timeout: WAIT_TIMEOUT });
    await waitForCount(C, 3);
    await waitForCount(A, 3);

    // ── d. 非房主准备 → 房主开始 ──
    console.log('\n[d] 准备 + 开始');
    await B.locator('[data-testid="party-ready"]').click({ timeout: WAIT_TIMEOUT });
    await C.locator('[data-testid="party-ready"]').click({ timeout: WAIT_TIMEOUT });
    await waitFor(async () => A.locator('[data-testid="party-start"]').isEnabled(), { desc: 'start enabled' });
    check('d.准备后房主开始按钮可用', true);
    await A.locator('[data-testid="party-start"]').click({ timeout: WAIT_TIMEOUT });
    await A.locator('[data-testid="party-countdown"]').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    await B.locator('[data-testid="party-countdown"]').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    check('d.开始后进入倒计时', true);

    // 附加：回合真正开始（5s 倒计时后进入 playing）
    try {
      await A.locator('[data-testid="party-game"]').waitFor({ state: 'visible', timeout: 12_000 });
      check('d+.回合开始进入游戏中', true);
    } catch {
      check('d+.回合开始进入游戏中', false, '未在 12s 内进入 playing');
    }

    return 0;
  } catch (e) {
    console.error('\n❌ 冒烟测试异常：', e.message);
    console.error('   若为后端启动失败，请确认 better-sqlite3 已编译：npm rebuild better-sqlite3');
    return 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (staticServer) staticServer.close();
    killBackend(backend);
    await sleep(800);
    await rm(DB_PATH, { force: true }).catch(() => {});
    await rm(`${DB_PATH}-wal`, { force: true }).catch(() => {});
    await rm(`${DB_PATH}-shm`, { force: true }).catch(() => {});
  }
}

// ═══════════════════════════════════════════════
//  入口：打印汇总，按结果退出
// ═══════════════════════════════════════════════
const exitCode = await main();
const passed = results.filter((r) => r.ok).length;
console.log('\n' + '═'.repeat(56));
console.log(`冒烟结果：${passed}/${results.length} 通过`);
for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}`);
if (exitCode !== 0) {
  console.error('❌ 冒烟测试未通过，阻止部署');
  process.exit(1);
} else if (passed !== results.length) {
  console.error('❌ 有步骤失败，阻止部署');
  process.exit(1);
} else {
  console.log('✅ 全部通过，可部署');
  process.exit(0);
}
