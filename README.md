# 明日方舟 — 干员猜测游戏 (Arknights Operator Guessing Game)

受 blast.tv/counter-strikle 启发的明日方舟角色猜测游戏。系统随机选择一位干员，通过输入干员名字进行猜测，每次猜测后查看职业、阵营、星级等属性的对比结果。

## 技术栈

- **框架:** Next.js 16 (App Router)
- **语言:** TypeScript
- **样式:** Tailwind CSS v4 + CSS 自定义属性（双主题系统）
- **状态管理:** Zustand
- **国际化:** 自定义 i18n（zh-CN / en）

## 功能

- 🎯 单人猜测模式，3 种难度
- 🌗 双主题：浅色 + Blast 暗黑主题（复刻 shnlfriberg.online）
- 🌐 中/英双语切换
- 👆 搜索自动补全
- 📊 游戏统计记录
- 📱 完整响应式设计

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式
npm run dev

# 构建生产版本
npm run build

# 启动生产服务
npm start
```

访问 [http://localhost:3000](http://localhost:3000) 开始游戏。

## 项目结构

```
src/
  app/                  # Next.js App Router 页面
    page.tsx            # 首页 (路由: /)
    layout.tsx          # 根布局
    globals.css         # 全局样式 + 主题 CSS 变量
    game/page.tsx       # 游戏页面 (路由: /game)
    stats/page.tsx      # 统计页面 (路由: /stats)
    providers.tsx       # 客户端 Providers
  components/           # React 组件
    Header.tsx          # 顶部导航栏
    HeroSection.tsx     # 首页英雄区
    MenuCard.tsx        # 菜单卡片
    GameSearch.tsx      # 搜索输入 + 自动补全
    GuessTable.tsx      # 猜测历史表格
    GameEndDialog.tsx   # 游戏结束弹窗
    RulesDialog.tsx     # 规则弹窗
    ThemeToggle.tsx     # 主题切换
    LanguageSwitcher.tsx # 语言切换
  data/
    characters.json     # 干员数据 (110 个角色)
  hooks/
    use-theme.ts        # 主题 Hook
  lib/
    game-engine.ts      # 游戏核心逻辑
    i18n.tsx            # 国际化 Context
    utils.ts            # 工具函数
  stores/
    game-store.ts       # Zustand 游戏状态
  messages/
    zh-CN.json          # 中文翻译
    en.json             # 英文翻译
  types/
    character.ts        # 类型定义
```

## 部署

推荐部署到 Vercel（一键部署）或 Cloudflare Pages：

```bash
# Vercel CLI
vercel

# 或推送到 GitHub 后连接 Vercel 自动部署
git push origin main
```

## 致谢

- 设计灵感：[shnlfriberg.online](https://shnlfriberg.online) / [blast.tv/counter-strikle](https://blast.tv/counter-strikle/multiplayer)
- 角色数据来源：[明日方舟 PRTS Wiki](https://prts.wiki)
- 游戏数据参考：[Kengxxiao/ArknightsGameData](https://github.com/Kengxxiao/ArknightsGameData)
