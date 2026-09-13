// 路由冒烟：11 条路由 × 2 主题，逐页打开并统计 pageerror / /icons/ 404 / 破图。
// 对应验收标准①「每个模式每个页面能打开、无 JS 报错」—— 这是它的机器化守卫。
//
// 为什么不并进 solo/multiplayer/party-smoke：那三个各起一套后端+静态服务、
// 只覆盖自己那几条路由；本脚本是**全路由横切**，专门接住「改 A 页把 B 页弄挂」
// 这类跨页回归（V12 换肤期真的发生过）。失败退出码 1，可直接当 gate。
import { startStaticServer, startBackend, makeDbPath, cleanupDb, requireBuild, requirePlaywright, newZhContext, FRONTEND_ORIGIN, WAIT_TIMEOUT, sleep } from './helpers.mjs';

const ROUTES = ['/', '/game', '/multiplayer', '/party', '/daily', '/leaderboard', '/stats', '/profile', '/verify', '/reset-password', '/admin'];
const THEMES = ['light', 'blast'];
// 第三档：已登录 + 预置 localStorage。
// 为什么必须单列一档：未登录时 localStorage 是空的，服务端预渲染与客户端首帧**恰好一致**，
// 于是「渲染期读 localStorage」造成的水合不匹配（React #418）在这个脚本里永远不现形。
// V12 期间 Header 与 multiplayer 各踩过一次 —— 实测 8 条路由里 7 条报错（#418）。
const LOGGED_IN = { label: 'logged-in', theme: 'blast', loggedIn: true };
const PASSES = [...THEMES.map((theme) => ({ label: theme, theme })), LOGGED_IN];
// 渲染 <Header /> 的路由。只有这些页「已登录」才体现为用户名文本；
// /profile /verify /reset-password /admin 自带外壳、不挂 Header
// （/profile 未登录时 ProfilePage 直接 return null），在它们上面断言用户名必然失败。
const HEADER_ROUTES = new Set(['/', '/game', '/multiplayer', '/party', '/daily', '/leaderboard', '/stats']);
const PROBE_USER = 'routeprobe';

await requireBuild();
const chromium = await requirePlaywright();

const dbPath = makeDbPath('verify-routes');
const backend = await startBackend({ dbPath });
await sleep(800);
const staticServer = await startStaticServer();

let pass = 0;
const fails = [];
const browser = await chromium.launch();

for (const p of PASSES) {
  for (const route of ROUTES) {
    const ctx = await newZhContext(browser);
    // 只预设主题。data-ui 是 <html> 上的字面量，没有开关可设
    // （原先这里还写 ui-skin='v12'，该键已随「运行时切回 classic」一起删除）。
    // 已登录档额外塞 arknights-auth-user —— getUser() 只读这个键，不需要 token。
    await ctx.addInitScript(({ th, user }) => {
      localStorage.setItem('ui-theme', th);
      if (user) localStorage.setItem('arknights-auth-user', JSON.stringify(user));
    }, { th: p.theme, user: p.loggedIn ? { id: 1, username: PROBE_USER, email: 'p@example.com', role: 'admin', email_verified: true } : null });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message ? e.message : e)));
    // 新增：/icons/ 下的配图 404 与「加载完成但 0 宽」的破图都要算失败。
    // 只统计 /icons/ 前缀，避免被 favicon、远程 API 之类的既有噪声污染。
    page.on('response', (r) => {
      if (r.url().includes('/icons/') && r.status() >= 400) errors.push(`ICON ${r.status()} ${r.url()}`);
    });
    let status = 0;
    try {
      const resp = await page.goto(FRONTEND_ORIGIN + route, { waitUntil: 'load', timeout: WAIT_TIMEOUT });
      status = resp ? resp.status() : 0;
      await sleep(600);
      const broken = await page.evaluate(() =>
        Array.from(document.images)
          .filter((i) => i.currentSrc.includes('/icons/') && i.complete && i.naturalWidth === 0)
          .map((i) => i.currentSrc)
      );
      for (const b of broken) errors.push('BROKEN IMG ' + b);
      // 反向断言：已登录档下，挂了 Header 的路由必须真的把用户名显示出来。
      // 没有这一条，「把 Header 改成永远渲染『登录』」同样能让上面 0 错误通过 ——
      // 修水合不匹配时最省事的错法恰好就是那样。
      if (p.loggedIn && HEADER_ROUTES.has(route)) {
        const shown = await page.evaluate((n) => document.body.innerText.includes(n), PROBE_USER);
        if (!shown) errors.push('登录态未反映到界面（Header 里没有用户名）');
      }
    } catch (e) {
      errors.push('NAV: ' + e.message);
    }
    const ok = status === 200 && errors.length === 0;
    if (ok) pass++;
    else fails.push({ theme: p.label, route, status, errors });
    await ctx.close();
  }
}

console.log('本地产物目录:', new URL('.', import.meta.url).pathname.replace(/\/tests\/$/, '/out'));
console.log(`路由数 ${ROUTES.length} × 档位 ${PASSES.length} = ${ROUTES.length * PASSES.length}`);
console.log(`通过 ${pass}/${ROUTES.length * PASSES.length}`);
if (fails.length) {
  console.log('失败明细:');
  for (const f of fails) console.log(`  [${f.theme}] ${f.route} status=${f.status} errors=${JSON.stringify(f.errors)}`);
}

await browser.close();
staticServer.close();
if (backend && backend.kill) backend.kill();
cleanupDb(dbPath);
process.exit(fails.length ? 1 : 0);
