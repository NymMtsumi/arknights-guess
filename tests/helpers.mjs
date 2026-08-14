// 冒烟测试共享骨架
// 供 tests/*.mjs 复用：后端启动（临时 DB + dev JWT 回退）、静态服务器（服务 out/）、
// 断言与汇总、Playwright 无关的纯工具。每个脚本是独立进程，模块级 results 天然隔离。
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, stat, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const ROOT = join(__dirname, '..');
export const OUT_DIR = join(ROOT, 'out');

export const BACKEND_PORT = Number(process.env.SMOKE_BACKEND_PORT || 3101);
export const FRONTEND_PORT = Number(process.env.SMOKE_FRONTEND_PORT || 3100);
export const FRONTEND_ORIGIN = `http://localhost:${FRONTEND_PORT}`;
export const WAIT_TIMEOUT = 20_000;

// 临时数据库路径（每个脚本用独立名字，避免互相污染）
export function makeDbPath(name) {
  return join(os.tmpdir(), `arknights-guess-${name}-${process.pid}.db`);
}

// ── 结果收集 ──
const results = [];
export function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// 打印汇总并按结果退出（exitCode 非 0 或存在失败步骤则 exit 1）
export function finish(exitCode) {
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

export function startStaticServer() {
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
export function startBackend({ port = BACKEND_PORT, dbPath } = {}) {
  if (!dbPath) throw new Error('startBackend 需要 dbPath（临时数据库路径），避免误用生产 data.db');
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath,
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

export function killBackend(child) {
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
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeout = WAIT_TIMEOUT, interval = 150, desc = '' } = {}) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeout) {
    try { const v = await fn(); if (v) return v; } catch (e) { lastErr = e; }
    await sleep(interval);
  }
  throw new Error(`timeout (${desc})${lastErr ? `: ${lastErr.message}` : ''}`);
}

export async function waitForBackend(port = BACKEND_PORT) {
  console.log(`⏳ 等待后端就绪 http://localhost:${port}/api/health ...`);
  await waitFor(async () => {
    const r = await fetch(`http://localhost:${port}/api/health`);
    return r.ok;
  }, { timeout: 25_000, desc: 'backend health' });
  console.log('✅ 后端就绪');
}

export async function cleanupDb(dbPath) {
  await rm(dbPath, { force: true }).catch(() => {});
  await rm(`${dbPath}-wal`, { force: true }).catch(() => {});
  await rm(`${dbPath}-shm`, { force: true }).catch(() => {});
}

// 预检：前端必须已 build（且 NEXT_PUBLIC_WS_URL 指向本后端）
export function requireBuild() {
  if (!existsSync(join(OUT_DIR, 'index.html'))) {
    console.error(`❌ 未找到 ${join(OUT_DIR, 'index.html')}`);
    console.error(`   请先构建：NEXT_PUBLIC_WS_URL=http://localhost:${BACKEND_PORT} npm run build`);
    return false;
  }
  return true;
}

export async function requirePlaywright() {
  try {
    const { chromium } = await import('playwright');
    return chromium;
  } catch {
    console.error('❌ 未安装 playwright。请先运行：npm i -D playwright && npx playwright install chromium');
    return null;
  }
}

// 统一创建 zh-CN locale 的浏览器上下文。
// 关键：CI（ubuntu-latest）上 headless Chromium 的 navigator.language 默认是 en-US，
// 前端 i18n getStoredLocale() 会据此自动切英文；但静态导出（output: export）预渲染的是
// 中文文案（构建时 window 不存在 → 回退 zh-CN）。两者不一致 → React 水合时替换 DOM →
// Playwright 点击报「element was detached from the DOM」。显式固定 zh-CN 消除水合不一致。
export function newZhContext(browser) {
  return browser.newContext({ locale: 'zh-CN' });
}
