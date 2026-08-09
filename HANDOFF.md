# 会话迁移提示词

> 复制以下内容，在新 Claude Code 会话中粘贴即可无缝衔接。

---

继续开发 arknights-guess 项目（明日方舟干员猜测游戏）。

## 第一步：加载上下文

请先阅读以下文件，了解项目全貌：
1. `C:\Users\27125\arknights-guess\CLAUDE.md` — 项目操作手册
2. `C:\Users\27125\.claude\projects\C--Users-27125\memory\MEMORY.md` — 持久记忆索引（16 个文件）
3. 根据任务需要，按 MEMORY.md 索引加载相关 memory 文件

## 当前项目状态

- **前端**: Cloudflare Pages 自动部署，最新 commit `ac541a0`，域名 `www.arknights-guess.online`
- **后端**: VPS `160.236.110.37`，PM2 `liyiba`，Node v22.23.2
- **数据库**: `/opt/liyiba/data.db`，421 干员，42 条每日挑战记录
- **已上线功能**: 单人模式（3 难度）、多人对战（BO3, Socket.IO）、每日挑战（UTC 重置）、用户系统（注册/登录/邮箱验证/密码重置）、排行榜（经典+每日）、在线监测、公告系统
- **上一会话主要工作**: 每日挑战上线、Bug 修复（双写/去重/排行榜为空/游客状态）、VPS Node 升级 v20→v22、Cloudflare 配置梳理

## 重要提醒

- 所有 Token/密码/账号在 memory 文件中，不要硬编码
- PM2 重启必须加 `--update-env`
- 前端是 `output: "export"` 静态导出，不是 SSR
- Cloudflare 非浏览器请求会篡改 UTF-8 中文
- better-sqlite3 是 native 模块，Node 升级后要 `npm rebuild`
- 绝不提交 data.db 到 Git

---

以下是我的任务：
（在此描述你要做的事）
