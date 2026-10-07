// 路由冒烟：13 条路由 × 3 档（light / blast / 已登录），逐页打开并统计 pageerror / 资源 4xx / 破图。
// 对应验收标准①「每个模式每个页面能打开、无 JS 报错」—— 这是它的机器化守卫。
//
// 为什么不并进 solo/multiplayer/party-smoke：那三个各起一套后端+静态服务、
// 只覆盖自己那几条路由；本脚本是**全路由横切**，专门接住「改 A 页把 B 页弄挂」
// 这类跨页回归（V12 换肤期真的发生过）。失败退出码 1，可直接当 gate。
//
// ─────────────────────────────────────────────────────────────────────
// 本文件修过的四个缺陷（别把它们改回去）
//
// ① `await requireBuild()` 把返回值丢了 —— 它其实是**同步**的、失败时打印原因并返回
//    false。不接结果的话，「没构建」时脚本照跑，13×3 条路由在 load 上挨个超时，
//    最后报成一屏 NAV 错误，真正的原因（「请先构建：…」）被淹在下面。
// ② 没有 try/finally —— 中途任何一处抛错都会跳过收尾，把后端留在 3101 上。
//    且 `startBackend` / `startStaticServer` 原本在 try **之外** —— 起静态服务失败时
//    finally 根本不会执行，后端照样变孤儿。现在两者都进了 try（`let` 声明在 try 前）。
// ③ 收尾用裸 `backend.kill()` —— 那是 SIGTERM，而 Windows 上 SIGTERM 不触发优雅
//    关闭。现在 `await killBackend(...)`（它内部有 SIGKILL 兜底，且**等子进程真的退出**；
//    老的 `.unref()` 定时器在 `process.exit` 面前永远轮不到，见 helpers.mjs 的注释）。
// ④ 🔴 **「页面能打开」这半条曾经是恒真的**（最隐蔽的一个，2026-10 才发现）：
//    断言是 `status === 200`，而静态服务器对**任何**未命中路径都 SPA 回退到
//    `out/index.html` 并照样 `writeHead(200)`。实测 `/definitely-not-a-route-xyz`、
//    `/_next/static/chunks/nope.js`、`/icons/menu-nope.png` 全部返回 200 且响应体
//    与首页**逐字节相同**（16670 字节）=> 把某页删掉/改名而 ROUTES 里还留着，
//    13×3 条**全部照绿**；连唯一的反向断言（登录态用户名必须出现）也会被满足 ——
//    回退的首页同样渲染 <Header />。对不挂 Header 的四条路由（/profile /verify
//    /reset-password /admin）则是整片无保护。
//    现在改成**与本路由自己的产物逐字节对照**（`servedBody === out/<route>.html`）：
//    回退成首页 => 与产物不同 => 红。同时 helpers 的静态服务器不再对
//    `/_next/**` `/icons/**` 做回退（它们是真实文件，缺失就该 404），
//    于是第 68 行那条 4xx 监听**才真的会触发**。
// ⑤ ROUTES / HEADER_ROUTES 是手工清单：加一页不改它 => 那一页**从不被打开**（routes-smoke
//    是全仓唯一的全路由横切）；加一页挂 Header 不改 HEADER_ROUTES => 最强的那条反向断言
//    **静默跳过**。两者都**不报错**。现在从 `src/app/**/page.tsx` 与源码里的 `<Header`
//    推导，再断言与手工清单**严格相等**（漂移 = 红，且告诉你差在哪一条）。
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startStaticServer, startBackend, makeDbPath, cleanupDb, requireBuild, requirePlaywright, newZhContext, killBackend, FRONTEND_ORIGIN, OUT_DIR, ROOT, WAIT_TIMEOUT, sleep } from './helpers.mjs';

const ROUTES = ['/', '/game', '/multiplayer', '/party', '/daily', '/turtle', '/bot', '/leaderboard', '/stats', '/profile', '/verify', '/reset-password', '/admin'];
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
// 注意这份集合的含义是「**渲染 <Header />** 的路由」，不是「Header 导航里列出的路由」。
// /turtle 挂 Header（见 src/app/turtle/page.tsx），所以必须在这里 —— 漏掉它等于
// 海龟汤页不受「已登录用户名必须出现」这条反向断言保护，而那正是接住
// 「渲染期读 localStorage 造成水合不匹配」的探针（V12 期间 Header 踩过一次）。
// ⚠️ 这份清单会被 deriveExpected() 反向校验（见下方的漂移守卫），别手改到不一致。
const HEADER_ROUTES = new Set(['/', '/game', '/multiplayer', '/party', '/daily', '/turtle', '/bot', '/leaderboard', '/stats']);
const PROBE_USER = 'routeprobe';

/** 该路由**自己的产物**文件路径；没有产物返回 null。
 *  查找顺序与 helpers.mjs 的 `resolveFile` 保持一致（目录下的 index.html 优先于 <route>.html）。 */
function artifactFor(route) {
  const seg = route === '/' ? '' : route.slice(1);
  for (const rel of [join(seg, 'index.html'), `${seg}.html`]) {
    const p = join(OUT_DIR, rel);
    if (existsSync(p)) return p;
  }
  return null;
}

/** 从源码推导「应有的路由清单」与「应挂 Header 的清单」，与手工清单对照。
 *  返回错误信息数组（空 = 一致）。这是防**静默漂移**的守卫：
 *  漂移的后果不是报错，而是「这条路由/这条断言根本没被跑」。 */
function deriveExpected() {
  const errs = [];
  const derived = ['/'];
  for (const e of readdirSync(join(ROOT, 'src/app'), { withFileTypes: true })) {
    if (e.isDirectory() && existsSync(join(ROOT, 'src/app', e.name, 'page.tsx'))) derived.push(`/${e.name}`);
  }
  const missing = derived.filter((r) => !ROUTES.includes(r));
  const extra = ROUTES.filter((r) => !derived.includes(r));
  if (missing.length || extra.length) {
    errs.push(`ROUTES 与 src/app/**/page.tsx 对不上：源码里有但清单里没有=[${missing.join(', ')}]，`
      + `清单里有但源码里没有=[${extra.join(', ')}]`
      + `（漏了 → 这条路由从不被打开；多了 → 产物缺失会在下面报出）`);
  }

  const derivedHeader = new Set(derived.filter((r) => {
    const p = r === '/' ? join(ROOT, 'src/app/page.tsx') : join(ROOT, 'src/app', r.slice(1), 'page.tsx');
    return readFileSync(p, 'utf8').includes('<Header');
  }));
  const hMissing = [...derivedHeader].filter((r) => !HEADER_ROUTES.has(r));
  const hExtra = [...HEADER_ROUTES].filter((r) => !derivedHeader.has(r));
  if (hMissing.length || hExtra.length) {
    errs.push(`HEADER_ROUTES 与源码里的 <Header 对不上：源码挂了但清单没列=[${hMissing.join(', ')}]`
      + `（这些页失去「登录态用户名必须出现」这条反向断言），清单列了但源码没挂=[${hExtra.join(', ')}]`
      + `（这些页会因用户名不出现而假红）`);
  }
  return errs;
}

async function main() {
  // requireBuild 是同步的、失败时自己打印「请先构建：…」并返回 false —— 必须接住它。
  if (!requireBuild()) return 1;

  // 漂移守卫 + 产物预检：都在起服务器**之前**做，失败就立刻返回（不留孤儿进程）。
  let anchorErrs = deriveExpected();
  const ARTIFACTS = new Map();
  for (const route of ROUTES) {
    const p = artifactFor(route);
    if (!p) { anchorErrs.push(`${route} 没有产物文件（out/ 下既无 <route>.html 也无 <route>/index.html）`); continue; }
    ARTIFACTS.set(route, readFileSync(p, 'utf8'));
  }
  if (anchorErrs.length) {
    console.error('❌ 路由清单/产物预检失败（本脚本需要同步更新）：');
    for (const e of anchorErrs) console.error('   - ' + e);
    return 1;
  }

  const chromium = await requirePlaywright();
  if (!chromium) return 1;

  const dbPath = makeDbPath('verify-routes');
  // ⚠️ 资源获取放在 try **内部**（用 let 先声明）—— 见文件头 ②：
  //    起静态服务失败时若在 try 外，finally 不会执行，后端就变成 3101 上的孤儿。
  let backend = null;
  let staticServer = null;
  let pass = 0;
  const fails = [];
  let browser = null;
  try {
    backend = await startBackend({ dbPath });
    await sleep(800);
    staticServer = await startStaticServer();
    browser = await chromium.launch();

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
        // /icons/ 下的配图 404 与 /_next/ 下的 chunk 4xx 都要算失败。
        // ⚠️ 这条监听**依赖 helpers 的静态服务器不对这两个前缀做 SPA 回退** ——
        //    回退的话它们永远返回 200，这里一行都不会触发（见文件头 ④）。
        page.on('response', (r) => {
          const u = r.url();
          if ((u.includes('/icons/') || u.includes('/_next/')) && r.status() >= 400) {
            errors.push(`RES ${r.status()} ${u}`);
          }
        });
        let status = 0;
        try {
          const resp = await page.goto(FRONTEND_ORIGIN + route, { waitUntil: 'load', timeout: WAIT_TIMEOUT });
          status = resp ? resp.status() : 0;
          await sleep(600);

          // 🔴 核心断言：服务端返回的必须是**这条路由自己的产物**，不是 SPA 回退的首页。
          //    只断言 `status === 200` 是恒真的（静态服务器对任何路径都回退并返回 200），
          //    所以这里比对响应体与 `out/<route>.html` 的字节。独立再 fetch 一次
          //    （不用 page.goto 的 response，避免它已被消费）。
          const served = await (await fetch(FRONTEND_ORIGIN + route)).text();
          if (served !== ARTIFACTS.get(route)) {
            errors.push(`产物不符：响应体与该路由的 out 产物不同（长度 ${served.length} vs ${ARTIFACTS.get(route).length}）`
              + `—— 多半是 SPA 回退成了首页，即这条路由其实没有产物`);
          }

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

    console.log('本地产物目录:', OUT_DIR);
    console.log(`路由数 ${ROUTES.length} × 档位 ${PASSES.length} = ${ROUTES.length * PASSES.length}`);
    console.log(`通过 ${pass}/${ROUTES.length * PASSES.length}`);
    if (fails.length) {
      console.log('失败明细:');
      for (const f of fails) console.log(`  [${f.theme}] ${f.route} status=${f.status} errors=${JSON.stringify(f.errors)}`);
    }
  } finally {
    // 收尾必须无条件执行（见文件头 ②③）：任何一处抛错都要走到这里来，且要等子进程真的退出。
    if (browser) { try { await browser.close(); } catch {} }
    if (staticServer) { try { staticServer.close(); } catch {} }
    await killBackend(backend);
    await cleanupDb(dbPath);
  }
  return fails.length ? 1 : 0;
}

process.exit(await main());
