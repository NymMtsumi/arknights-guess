# 明日方舟 · 干员猜谜

一个非官方的《明日方舟》猜谜游戏 —— 输入干员名，逐格比对职业、阵营、星级等属性，用最少的次数锁定答案。

🔗 **在线试玩：<https://www.arknights-guess.online>**

> An unofficial *Arknights* guessing game in the spirit of Counter-Strikle: pick a name, compare attributes cell by cell, and find the answer in as few guesses as possible.

---

## 玩法

### 干员猜谜

系统从 **429 位干员**中随机选出一位，玩家每次输入一个名字，表格逐列给出比对结果（一致 / 接近 / 不符）。比对覆盖 9 个维度：

职业 · 子职业 · 阵营 · 星级 · 种族 · 性别 · 上线年份 · 标签 · 部署位

三档难度对应不同的候选池，每局最多 8 次机会。同名干员的**异格**形态会被单独提示。

### 敌方单位猜谜

把同一套玩法搬到 **1674 个敌方单位**上，维度换为 11 项：

种族 · 等级 · 攻击方式 · 伤害类型 · 行动方式 · 耐久 · 攻击 · 防御 · 移动速度 · 攻击速度 · 法术抗性

### 每日挑战

全站每天同一个目标，按 **UTC 零点**重置，每人每日一局、独立排行榜。

### 多人对战

基于 WebSocket 的实时对战：用房间码邀请好友，或用快速匹配随机配对。采用 best-of 赛制（1–7 局可选，默认 5 局），双方同时猜同一个目标，先赢够局数者胜。支持游戏中**断线重连**并恢复棋盘。

### 派对模式

3–8 人同房，房间码进出，带准备 / 开局流程与断线重连。

### 账号与数据

注册需邮箱验证，支持密码重置。未登录时的战绩会先存在本地，登录后自动迁移到账号名下（迁移是幂等的，重复上传不会重复计数）。

### 排行榜与统计

经典 / 多人 / 每日三条榜单；个人页汇总总场次、胜率与历史对局。

### 外观与语言

浅色 / 青黑双主题，中英双语，全站响应式。

---

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | Next.js 16（App Router，静态导出）、TypeScript、Tailwind CSS v4、Zustand |
| 后端 | Node.js（原生 HTTP）+ Socket.IO |
| 数据库 | SQLite（better-sqlite3） |
| 认证 | JWT + bcrypt |
| 邮件 | nodemailer（SMTP） |
| 国际化 | 自建轻量 Context（扁平点号键 + `{{param}}` 插值） |

游戏判定逻辑（属性比对、目标抽取）全部在前端运行；服务端负责账号、排行榜、每日挑战的权威校验，以及多人对战的实时状态同步。

## 快速开始

```bash
# 前端
npm install
npm run dev            # http://localhost:3000

# 后端（另开一个终端）
cd server && npm install
node index.js          # http://localhost:3001
```

前端通过 `NEXT_PUBLIC_WS_URL` 指定后端地址（参考 `.env.example`），后端环境变量参考 `server/.env.example`。

```bash
npm run build          # 静态导出到 out/
npm start              # 本地预览导出结果
```

## 测试

```bash
npm run smoke:all      # 构建 + 依次跑完全部 6 套冒烟测试
```

| 命令 | 覆盖范围 |
|---|---|
| `npm run smoke:auth` | 认证链路：注册 / 邮箱验证 / 登录 / 找回密码 / 会话失效，含负面用例 |
| `npm run smoke:admin` | 管理接口与权限边界 |
| `npm run smoke:solo` | 单人、每日挑战、排行榜、统计（Playwright 驱动真实浏览器） |
| `npm run smoke:multiplayer` | 标准房 / 自定义房 / 快速匹配：建房加房、猜测回环、断线徽标 |
| `npm run smoke` | 派对模式回归：建房、加房、分享链接自动进房、局中断线重连 |
| `npm run smoke:routes` | 全路由横切：逐页检查 JS 报错、资源 404、破图 |

另有几个静态检查：`npm run data:check`（两份干员数据字节一致）、`npm run check:i18n`（翻译键对齐）、`npm run check:sort`、`npm run check:contrast`。

## 项目结构

```
src/
  app/                 # 页面路由与全局样式
  components/          # React 组件
  data/                # 干员 / 敌方单位数据
  lib/                 # 游戏引擎、i18n、API 客户端
  stores/              # Zustand 状态
  messages/            # 中英文案
server/
  index.js             # HTTP 入口
  routes/              # REST 接口
  socket/              # Socket.IO 房间、匹配与对战
  db.js                # SQLite schema
scripts/               # 数据同步与一致性检查
tests/                 # 冒烟测试
```

## 数据来源与致谢

- 干员与敌方单位数据取自 [PRTS Wiki](https://prts.wiki) 与 [Kengxxiao/ArknightsGameData](https://github.com/Kengxxiao/ArknightsGameData)，仓库内保存一份本地副本，并定期检查上游更新。
- 玩法灵感来自 [blast.tv/counter-strikle](https://blast.tv/counter-strikle)。
- 与 [shnlfriberg.online](https://shnlfriberg.online)（[源码](https://github.com/shnlfriberg/csgofriberg)）同类，配色体系参考了它的浅色与暗色主题。

## 说明

本项目为非官方作品，与鹰角网络（Hypergryph）无关。《明日方舟》及其角色、美术与游戏数据版权归鹰角网络所有，本项目仅用于学习与交流。

## 许可证

代码以 [MIT 许可证](LICENSE) 开源。上述游戏数据与美术资源的版权仍归原权利人所有，不在本项目授权范围内。
