# arknights-guess 项目操作手册

> 明日方舟干员猜测游戏。前端 Cloudflare Pages + 后端 VPS Node.js + SQLite。

## 项目路径
- **本地**: `C:\Users\27125\arknights-guess`
- **VPS**: `/opt/liyiba`
- **持久记忆**: `C:\Users\27125\.claude\projects\C--Users-27125\memory\`（16 个 .md 文件，包含所有凭据、架构、陷阱）
- **Memory 索引**: 先读 `memory/MEMORY.md`，按需加载具体文件

## 技术栈
| 层 | 技术 |
|----|------|
| 前端 | Next.js 16 (App Router, `output: "export"` 静态导出), TypeScript, Tailwind v4, Zustand |
| 后端 | 单文件 Node.js HTTP (`server/index.js` :3001) + Socket.IO 4.8 |
| 数据库 | SQLite (`better-sqlite3`)，路径 `/opt/liyiba/data.db` |
| 认证 | JWT (`jsonwebtoken` + `bcryptjs`) + `player_key` Cookie |
| 邮件 | nodemailer → QQ SMTP (`smtp.qq.com:465`) |
| i18n | next-intl (zh-CN, en) |

## 域名 & 部署架构
```
用户浏览器
  ├─ www.arknights-guess.online  → Cloudflare Pages（前端，GitHub push main → 自动部署）
  └─ ws.arknights-guess.online   → Cloudflare → VPS nginx :443 → Node :3001（API + WebSocket）
```
- **Cloudflare Pages**: 项目 `arknights-guess`，GitHub 集成，每次 push main 自动构建
- **VPS**: `160.236.110.37`（Debian 12, Node v22.23.2），PM2 进程 `liyiba`
- **VPS .env**: `/opt/liyiba/.env`（SMTP_PASS, JWT_SECRET, DEPLOY_TOKEN, CLOUDFLARE_API_TOKEN 等）
- **后端部署**: GitHub Actions `deploy.yml` → curl webhook `/api/deploy` → VPS git pull + pm2 restart
- **nginx 配置**: `/etc/nginx/sites-available/liyiba`（反向代理 :443→:3001, WebSocket upgrade）

## 本地开发
```bash
npm install           # 安装依赖
npm run dev           # 启动 Next.js dev server（Turbopack, :3000）
node server/index.js  # 单独启动后端（:3001，需要 server/.env）
```
- 本地 `.env.local`: `NEXT_PUBLIC_WS_URL=https://ws.arknights-guess.online`（指向生产 API）
- 如需本地后端: 创建 `server/.env`（参考 `server/.env.example`），改 `NEXT_PUBLIC_WS_URL=http://localhost:3001`
- **avoid**: 在 `server/node_modules/` 放任何包 — Node.js 会优先解析嵌套 node_modules 导致 better-sqlite3 加载错误二进制 → SIGSEGV

## 关键文件
| 文件 | 用途 |
|------|------|
| `server/index.js` | HTTP routing + Socket.IO + middleware（routes split into server/routes/） |
| `server/db.js` | SQLite schema + 索引初始化 |
| `server/characters.js` | 干员数据加载 + 每日挑战算法（dailySeed/seedRandom/pickDailyTarget） |
| `server/characters.json` | 全部干员数据（与 `src/data/characters.json` 同步） |
| `server/routes/game.js` | save-game, leaderboard, daily/status, daily/leaderboard |
| `server/routes/auth.js` | 注册/登录/邮箱验证/密码重置 |
| `server/routes/admin.js` | 管理员仪表盘/用户管理/deploy webhook |
| `server/routes/user.js` | me/profile/sync/link-player-key/history |
| `server/socket/index.js` | Socket.IO 多人对战 + 在线追踪 |
| `src/lib/auth.ts` | JWT 管理、apiCall、getServerUrl |
| `src/lib/stats.ts` | 游戏统计 + saveGameToServer |
| `src/stores/game-store.ts` | 单人模式 zustand store |
| `src/stores/daily-store.ts` | 每日挑战 zustand store |
| `src/app/daily/page.tsx` | 每日挑战页面 |
| `src/app/multiplayer/page.tsx` | 多人对战页面 |
| `src/app/admin/page.tsx` | 管理员面板 |
| `next.config.ts` | `output: "export"` + `images: { unoptimized: true }` |
| `wrangler.jsonc.archived` | Cloudflare Workers 配置（OpenNext adapter，已废弃归档） |
| `.github/workflows/deploy.yml` | CI/CD — 检测 server 变更 → webhook VPS |

## VPS 运维
```bash
ssh -i ~/.ssh/id_ed25519 root@160.236.110.37
pm2 status                    # 查看进程
pm2 restart liyiba --update-env  # 重启（必须加 --update-env！否则 env vars 丢失）
pm2 logs liyiba --lines 50    # 查看日志
cat /opt/liyiba/.env          # 查看环境变量
sqlite3 /opt/liyiba/data.db   # 直接操作数据库
```
- **重启 PM2 必须加 `--update-env`**，否则 SMTP_PASS/JWT_SECRET 等丢失 → 邮件退化为调试模式
- **Nginx 配置变更后**: `nginx -t && systemctl reload nginx`
- **数据库备份**: 每次部署自动备份 `data.db.bak-YYYYMMDD-HHMM`

## 关键陷阱（详见 memory/critical-gotchas.md）
1. 🔴 **绝不提交 data.db 到 Git** — 会覆盖生产数据库。`.gitignore` 同时排除 `server/data.db*` 和根目录 `data.db*`
2. 🔴 **PM2 重启必须 `--update-env`** — 否则 SMTP_PASS/SITE_URL 丢失
3. 🟡 **better-sqlite3 是 native 模块** — Node.js 版本升级后必须 `npm rebuild better-sqlite3`
4. 🟡 **Cloudflare 对非浏览器请求做 WAF 篡改** — curl 测试时 UTF-8 中文可能被替换为 U+FFFD，浏览器请求正常
5. 🟡 **前端是静态导出** — `output: "export"`，不是 SSR。HTML 是空壳（只有 `<script>` 标签），不能通过 curl HTML 判断版本
6. 🟡 **单人模式完全客户端** — 服务器只在游戏结束时收到 `POST /api/save-game`。中间状态靠 30s 心跳 `POST /api/heartbeat`

## 凭据管理
- **所有凭据集中存储**在 memory 文件中（`memory/MEMORY.md` 索引），不要在代码中硬编码
- **VPS .env** (`/opt/liyiba/.env`) 包含生产密钥：SMTP_PASS, JWT_SECRET, DEPLOY_TOKEN, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
- **本地 .env.local** 包含：CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, NEXT_PUBLIC_WS_URL
- **GitHub PAT** 存储在 `~/.git-credentials-nym`
- **SSH 密钥** 在 `~/.ssh/id_ed25519`（Ed25519, comment: `liyiba-server`）
- 旧凭据清单见 `memory/deprecated-resources.md`

## 管理员
- 管理员账号信息见 memory 文件（不在此处存储密码）
- 管理面板: `/admin` → 公告管理 / 用户管理 / 游客管理 / 在线玩家

## 当前版本
- 已上线功能：单人模式（3 难度）、多人对战（BO3）、每日挑战、用户注册/登录/邮箱验证/密码重置、排行榜（经典+每日）、在线玩家监测、公告系统
- 生产状态：前端 Cloudflare Pages / 后端 PM2 liyiba
