// ⚠️ 沙箱环境专用垫片，不是产品代码，也不要进 npm scripts。
//
// 背景：本机默认 DNS 解析器对 resolveMx 返回 EREFUSED（实测 gmail.com / qq.com 均如此），
// 于是 server/routes/auth.js:11-29 的 checkEmailMX() 走 catch 返回 false，
// 第 107-110 行把注册请求判成 400「邮箱域名无效」——
// 而 tests/auth-smoke.mjs:51 注册的正是 smoke-*@gmail.com，
// 所以 auth / admin 两套冒烟在**第一个注册请求**就全红。
//
// 这是环境问题不是代码问题：CI runner（ubuntu-latest）的解析器正常，线上也正常。
// 显式指定公共 DNS 后 resolveMx 立刻恢复（实测 223.5.5.5 / 8.8.8.8 / 1.1.1.1 三家均 OK）。
//
// 用法（仅在默认解析器被拒的机器上）：
//   NODE_OPTIONS="--require <abs>/tests/_dns-preload.cjs" npm run smoke:auth
// tests/helpers.mjs:120 的 startBackend 会把 process.env 透传给后端子进程，
// 所以垫片能作用到真正发起 DNS 查询的那个进程。
//
// 故意不写进 package.json：否则在真实环境里它会把「DNS 坏了」伪装成「通过」。
require('node:dns').setServers(['223.5.5.5', '8.8.8.8']);
