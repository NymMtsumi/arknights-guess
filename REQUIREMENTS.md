# 明日方舟猜角色 — 账号系统需求文档

> 整理自 2026年7月-8月完整对话记录
> 目标：让接手开发者清楚了解所有需求、当前进度、以及待完成工作

---

## 一、核心设计原则

### 1.1 对标弗一把（Friberg）
- 仓库：https://github.com/shnlfriberg/csgofriberg
- 网站：https://shnlfriberg.online/
- **账号系统应尽可能贴近弗一把的实现方式**：email-bound accounts, verification-first flow, httpOnly cookies, rate limiting

### 1.2 强绑定邮箱
- 注册必须提供有效的邮箱地址
- **先发送验证邮件 → 用户点击验证链接 → 验证通过后才创建账号**（不是先创建账号再验证！）
- 弗一把的做法：前端输入邮箱 → 后端生成验证 token → 发送邮件 → 用户点击链接确认 → 然后才在数据库创建用户记录

### 1.3 匿名访客系统（已部分实现）
- 使用 `player_key` Cookie 标识匿名用户
- 格式参考：`访客#yg35h`（5-6位大写字母+数字的随机组合）
- 同 IP 下不同设备应该有不同的 player_key
- 账号登录后可关联（link）已有的 player_key，同步历史游戏数据

### 1.4 IP 隔离与防滥用
- 同 IP 下不能多开网页挤占服务器（参考弗一把的实现）
- 同 WiFi 下的两台设备应该独立，不能共用一个房间/player_key

---

## 二、完整功能需求清单

### 2.1 用户认证功能
| 功能 | 优先级 | 状态 | 说明 |
|------|--------|------|------|
| 邮箱验证码发送 | P0 | ⚠️ 部分完成 | 发送验证邮件到指定邮箱 |
| 邮箱验证确认 | P0 | ⚠️ 部分完成 | 点击邮件链接验证，验证通过后才创建账号 |
| 用户注册 | P0 | ⚠️ 需重做 | 当前是先创建账号再验证，需要改为先验证再创建 |
| 用户登录 | P0 | ✅ 基本完成 | 用户名+密码登录 |
| JWT Token 管理 | P0 | ✅ 基本完成 | 30天有效期 |
| httpOnly Cookie | P0 | ✅ 已实现 | `SameSite=None; Secure; HttpOnly; Path=/; Max-Age=2592000` |
| 退出登录 | P1 | ✅ 基本完成 | 清除 token |
| 密码最小长度 | P0 | ✅ 已实现 | ≥ 8 个字符 |
| 密码修改 | P2 | ❌ 未开始 | — |
| "忘记密码"流程 | P2 | ❌ 未开始 | — |

### 2.2 数据同步功能
| 功能 | 优先级 | 状态 | 说明 |
|------|--------|------|------|
| Player Key 关联 | P0 | ✅ 基本完成 | `POST /api/link-player-key` 将匿名身份关联到账号 |
| 游戏历史同步 | P0 | ✅ 基本完成 | `POST /api/sync` 上传本地记录到服务器 |
| 用户信息查询 | P0 | ✅ 基本完成 | `GET /api/me` 返回用户信息和统计数据 |
| 跨设备状态同步 | P1 | ❌ 未开始 | 登录后自动拉取服务器数据 |

### 2.3 排行榜系统（规划中，未开始）
- **每个 IP 对应一个账号**，展示多局胜率
- 排行榜显示内容：用户名、胜率、总局数、最佳成绩
- 可能的分榜：总榜、每日榜、难度分榜

### 2.4 管理员后台（规划中，未开始）
- 查看**正在进行的单人游戏**
- 查看**正在活跃的多人房间**
- 用户管理（查看、封禁）
- 游戏记录查询

### 2.5 安全要求
| 要求 | 状态 | 说明 |
|------|------|------|
| 密码哈希 | ✅ bcryptjs | — |
| Token 加密 | ✅ JWT (jsonwebtoken) | 密钥需改为生产环境强随机值 |
| 速率限制 | ✅ 内存级 | 注册 5次/小时/IP，登录 10次/15分钟/IP |
| 输入清理 | ✅ 已实现 | username/password 类型检查 |
| 防多开 | ⚠️ 待完善 | 同 IP 限制逻辑 |
| SMTP 凭据保护 | ⚠️ 待修复 | 硬编码值已改为环境变量，但 VPS 上未设置 |
| JWT Secret | ⚠️ 待修复 | 使用弱默认值，需在 VPS 环境变量中设置 |

### 2.6 运维要求
- **本地测试优先**：任何新功能必须先在本地验证，再部署到生产
- **环境变量管理**：所有敏感凭据（SMTP_PASS, JWT_SECRET, SITE_URL）必须通过环境变量注入
- **数据库备份**：SQLite 文件定期备份

---

## 三、当前技术架构

### 3.1 服务器端（`server/index.js`）
- 原生 Node.js HTTP 服务器（**不用 Express**），手动路由匹配
- Socket.IO 用于多人实时对战
- SQLite（better-sqlite3）数据库，文件 `data.db`
- bcryptjs 密码哈希
- jsonwebtoken JWT 管理
- nodemailer + QQ SMTP 邮件发送
- 进程管理：PM2（`pm2 start index.js`）

### 3.2 客户端（`src/lib/auth.ts`, `src/components/AuthDialog.tsx`）
- JWT Token 存储在 localStorage (`arknights-auth-token`)
- 用户信息存储在 localStorage (`arknights-auth-user`)
- 所有 API 请求自动携带 Bearer Token
- 自动检测 localhost vs 生产环境 API URL

### 3.3 API 端点总览
| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| POST | `/api/register` | 无 | 注册（当前：先创建用户再验证 ⚠️） |
| POST | `/api/login` | 无 | 登录 |
| POST | `/api/auth-cookie` | 无 | 将 Bearer token 转为 httpOnly cookie |
| GET | `/api/me` | Bearer | 获取当前用户信息和统计 |
| POST | `/api/sync` | Bearer | 同步游戏历史 |
| POST | `/api/link-player-key` | Bearer | 关联匿名 player_key |
| POST | `/api/send-verification` | Bearer | 发送验证邮件 |
| GET | `/api/verify-email` | 无（URL token）| 验证邮箱 |

### 3.4 数据库表结构
```sql
-- 用户表
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  email TEXT,
  email_verified_at TEXT,  -- NULL 表示未验证
  player_key TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 邮箱验证表
CREATE TABLE email_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- 游戏记录表
CREATE TABLE games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_key TEXT NOT NULL,
  won INTEGER NOT NULL,
  guess_count INTEGER NOT NULL,
  difficulty TEXT NOT NULL,
  target_name TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);
```

---

## 四、需要重做的核心模块

### 4.1 ⚠️ 注册流程 — 最高优先级

**当前错误流程：**
```
用户提交注册表单 → 创建用户记录 → 发送验证邮件 → 用户点击链接 → 标记已验证
```

**要求的正确流程（弗一把的做法）：**
```
用户提交注册表单 → 生成验证 token → 发送验证邮件 → 用户点击链接验证 → 创建用户记录
```

**需要改动的地方：**
1. `POST /api/register` — 不应立即创建 user 记录，只插入 email_verifications 记录
2. `GET /api/verify-email` — 验证通过后，才执行 INSERT INTO users
3. 数据库设计：email_verifications 表需存储临时注册信息（username, password_hash, email）等待验证
4. 前端 `src/lib/auth.ts` 的 `register()` 函数 — 调整以适配新流程
5. 前端 `src/components/AuthDialog.tsx` — 注册成功后提示"请查收验证邮件"，不立即登录

### 4.2 Header 登录按钮
`src/components/Header.tsx` 当前是干净的（没有登录按钮），需要重新添加：
```tsx
// 需要导入
import { AuthDialog } from './AuthDialog';
import { getUser } from '@/lib/auth';
// 在 LanguageSwitcher 旁边添加登录/用户按钮
```

### 4.3 SMTP 环境变量
VPS 上必须设置（通过 PM2 环境变量或 /etc/environment）：
```bash
SMTP_PASS="QQ邮箱授权码"
JWT_SECRET="随机生成的安全密钥"
SITE_URL="https://arknights-guess.online"
```

### 4.4 前端 email 传递
`AuthDialog.tsx` 中 `register()` 函数当前只接受 `(username, password)`，需要改为 `(username, password, email)` 并更新 `src/lib/auth.ts`。

---

## 五、与弗一把的对比

| 维度 | 弗一把 | 我们当前 | 差距 |
|------|--------|----------|------|
| 注册流程 | 先验证邮箱 → 再创建账号 | 先创建账号 → 再验证 | ⚠️ 需重做 |
| 密码要求 | — | ≥ 8 字符 | ✅ |
| Token 存储 | httpOnly cookie | localStorage + httpOnly cookie 双通道 | ✅ |
| 邮件发送 | nodemailer + SMTP | nodemailer + QQ SMTP | ✅ 技术方案一致 |
| 速率限制 | — | 注册 5/hr, 登录 10/15min | ✅ |
| 验证中间件 | Express middleware | 内联手动验证 | 架构不同但功能对等 |
| 输入校验 | zod schema | 手动类型检查 | 弗一把更规范 |
| 匿名访客 | guest cookie | player_key cookie | ✅ 逻辑对等 |
| 服务器框架 | Express | 原生 http | 不同但不影响功能 |
| 数据库 | PostgreSQL | SQLite | 弗一把更可扩展 |

---

## 六、移交清单（给接手开发者）

### 需要提供的权限
1. **GitHub 仓库**：需要邀请为协作者（仓库地址待补充）
2. **VPS SSH**：`root@160.236.110.37`，密钥需要分享（或创建新用户）
3. **Cloudflare**：Pages 部署权限（或通过 GitHub Actions 自动部署）
4. **QQ 邮箱 SMTP 授权码**：用于发送验证邮件

### 需要告知的关键信息
1. VPS 使用 PM2 管理进程，不是 systemd
2. 数据库是 SQLite 文件，备份 `data.db` 即可
3. 云端 HTTPS 由 Cloudflare 代理，VPS 只需监听 80 端口
4. 前端部署到 Cloudflare Pages（项目名：arknights-guess）
5. WebSocket 使用 `ws.arknights-guess.online` 子域名

### 打包文件列表
```
arknights-auth-handoff/
├── REQUIREMENTS.md          ← 本文件（需求文档）
├── README.md                ← 交接说明
├── server/
│   ├── index.js             ← 服务器完整代码（含认证端点）
│   └── package.json         ← 依赖清单
└── src/
    ├── lib/
    │   └── auth.ts          ← 客户端认证工具
    ├── components/
    │   ├── AuthDialog.tsx   ← 登录/注册对话框
    │   └── Header.tsx       ← 当前干净版（需加登录按钮）
    └── app/
        └── verify/
            └── page.tsx     ← 邮箱验证落地页
```

---

## 七、用户原始需求语录（摘录）

> "一个IP绑定一个游客账号，随机发放编号如：访客#yg35h"

> "后续增加账号，绑定邮箱登录功能，登录自动同步账号上面的战绩等信息"

> "后端界面应该至少能看到正在进行的单人游戏和多人游戏房间，以及正在活跃的多人房间"

> "弗一把在同ip下创建两个网页，另一个网页想要在创建房间的时候会显示房间已创建"

> "弗一把在多人模式页面会有'已创建的房间显示'即：如果玩家创建了一个房间，或者是断连了，他会在这里提示重连"

> "向弗一把看齐，我们强绑定可用的邮箱账号，并向邮箱发送验证邮件"

> "由于这是一个比较庞大的系统开发任务，我希望你不要直接上线，而是在开发好之后，先在本地部署"

> "尽可能贴近弗一把 https://github.com/shnlfriberg/csgofriberg。强绑定邮箱。注册时先发送验证邮件，确认注册再创建账号。"

---

*文档整理日期：2026-08-03*
