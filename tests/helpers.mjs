// 冒烟测试共享骨架
// 供 tests/*.mjs 复用：后端启动（临时 DB + dev JWT 回退）、静态服务器（服务 out/）、
// 断言与汇总、Playwright 无关的纯工具。每个脚本是独立进程，模块级 results 天然隔离。
import { spawn, spawnSync } from 'node:child_process';
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
  // 🔴 这两个命名空间**不许**回退：`/_next/**` 与 `/icons/**` 装的是**真实文件**，
  //    里面没有「客户端深层路由」这回事 —— 文件不存在就该 404。
  //    不加这条的后果是**静默**的（实测过）：`/icons/menu-nope.png` 会返回 200 +
  //    首页 HTML（16670 字节，与 `/` 逐字节相同），于是 routes-smoke 里那条
  //    「/icons/ 下 4xx 算失败」的监听**永不触发**，变成一行装饰。
  if (rel.startsWith('/_next/') || rel.startsWith('/icons/')) return null;
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
  return new Promise((resolve, reject) => {
    // 端口被占时要 **reject**，不能没有 error 监听 —— 没有监听者时 'error' 事件会变成
    // uncaught exception 直接崩掉进程，而那时调用方的 try/finally 还没进去（或刚进去），
    // 后端就被留在 3101 上（就是 memory 里记的「端口 3101 残留导致只红一条」）。
    server.once('error', reject);
    server.listen(FRONTEND_PORT, () => {
      server.on('error', () => {});   // 启动后的错误不再炸进程
      resolve(server);
    });
  });
}

// ═══════════════════════════════════════════════
//  后端（hermetic：临时 DB + dev JWT 回退 + 放行本静态源）
// ═══════════════════════════════════════════════
// extraEnv：给个别用例补环境变量（如 auth-smoke 要验部署 webhook 的令牌分支，
// 需要 DEPLOY_TOKEN 有值）。默认不传，行为与从前完全一致。
/**
 * 端口上是否已经有进程在**监听**（同步探测）。
 *
 * 用「连一下」而不是「bind 一下」：Windows 与 Linux 的 SO_REUSEADDR 语义相反，
 * bind 试探会在 Windows 上把占着端口的进程骗过去；connect 只认事实。
 * 另起一个 node 进程是为了拿到同步返回值（Node 没有同步的 net API），
 * 每次 startBackend 只跑一次，约 40ms。
 */
function portInUse(port) {
  const probe = spawnSync(process.execPath, ['-e', [
    `const n = require('net');`,
    `const s = n.connect({ port: ${port}, host: '127.0.0.1' });`,
    `s.once('connect', () => { s.destroy(); process.exit(0); });`,
    `s.once('error', () => process.exit(1));`,
    `setTimeout(() => { s.destroy(); process.exit(1); }, 1500).unref();`,
  ].join('\n')], { stdio: 'ignore', timeout: 8000 });
  return probe.status === 0;
}

export function startBackend({ port = BACKEND_PORT, dbPath, extraEnv } = {}) {
  if (!dbPath) throw new Error('startBackend 需要 dbPath（临时数据库路径），避免误用生产 data.db');

  // 🔴 端口归属校验。没有这一步时，残留的孤儿后端会让整个脚本**静默跑在错的 DB 上**：
  //    我们 spawn 的后端因 EADDRINUSE 立刻退出，而随后 waitForBackend 连上的是那个
  //    孤儿（它挂着上一个脚本的临时 DB）—— 于是业务断言按旧数据判定，红得极难归因。
  //    本地最典型的表现就是「只红一条」，CI 因为是干净容器反而看不到。
  if (portInUse(port)) {
    throw new Error(
      `端口 ${port} 已被占用，拒绝启动后端。\n` +
      `        多半是上一个 smoke 脚本留下的孤儿后端（挂着那个脚本的临时 DB）。\n` +
      `        直接继续跑的话，waitForBackend 会连上它，断言会按错误的数据库判定。\n` +
      `        先找出并结束占用 ${port} 的进程再重跑。`,
    );
  }

  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...extraEnv,
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

/**
 * 关掉后端。**返回的 Promise 在子进程真正退出后 resolve**（调用方应当 `await`）。
 *
 * 🔴 为什么必须能 await：老版本是「SIGTERM + 一个 `.unref()` 的 2s SIGKILL 兜底」，
 *    而调用方清一色是 `killBackend(x); await sleep(300); await cleanupDb(); process.exit()`。
 *    `.unref()` 的定时器既不保活、`process.exit` 又立刻终止父进程 —— **2s 那个分支
 *    在所有 smoke 脚本里都到不了**（Windows 上 SIGTERM 等效强杀所以本地看不出来，
 *    但 CI 是 Linux：`server/index.js` 的优雅关闭要走 `http.close()` + `io.close()`，
 *    连接没立刻收干净就成了孤儿进程占着 3101）。下一个脚本的 `waitForBackend` 会连上
 *    这个**挂着上一个脚本临时 DB 的孤儿后端**，报成极难归因的红。
 *
 * 兼容性：不 `await` 的调用方行为与从前一致 —— `async` 函数体在第一个 `await` 之前
 * 是**同步**执行的，而 SIGTERM 就发在那之前。
 */
export async function killBackend(child, { graceMs = 2000 } = {}) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try { child.kill('SIGTERM'); } catch {}
  // 兜底：graceMs 后仍未退出则强杀（Windows 上 SIGTERM 不触发优雅关闭）
  const hard = setTimeout(() => {
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch {} }
  }, graceMs);
  try {
    // 硬上限：SIGKILL 都杀不掉也别把 CI 挂死（正常路径几百毫秒内就 resolve）
    await Promise.race([exited, sleep(graceMs + 3000)]);
  } finally {
    clearTimeout(hard);
  }
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
