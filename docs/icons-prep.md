# 图标重绘 · 前期准备（自己手绘 · PNG/JPG 完整角色图 · 静态图片文件）

> 方案确定：**自己手绘完整角色图**，以 **PNG/JPG 静态图片文件**形式替换现有 emoji 图标。
> 本文档是画图前必须看完的规格 + 图片到位后的接入方案。

> **📌 2026-09-02 定稿决策**（评估桌面 NEW/v9 重构稿后拍板）：
> - 图片范围 = **两波共 9 张**（Wave 1 六张 → Wave 2 三张）。不做 4 张（首页大卡会半空），不做 12 张（多人回合/页面头是小号内联 emoji，画大图不值）。
> - Wave 1 与 v9 设计稿的图片槽位（`.menu-icon` / `.dialog-img`）直接对接。

---

## 1. 一个必须先定的关键点：PNG 透明背景（推荐） vs JPG

菜单卡图标（`.menu-icon`）的容器是有**半透明彩色底 + 光效**的盒子。JPG 没有透明通道，放上去是矩形色块；透明 PNG 才能让角色图融入彩色底，且**天然适配双主题**。

| 格式 | 透明背景 | 放彩色底上的效果 | 结论 |
|------|---------|-----------------|------|
| **PNG（带 alpha）** | ✅ | 角色自然融入彩色底，主题通用 | ✅ **推荐** |
| JPG | ❌（只能是矩形） | 出现明显方块/白底 | ⚠️ 只用于全幅大图 |

**结论：菜单卡/难度卡图标一律出透明 PNG。** 若手绘是带底色的完整插画，可交给 Claude 抠图出透明版。

---

## 2. 范围与优先级（两波制）

| 波次 | 插槽 | 数量 | 当前 emoji | 位置 | 处理 |
|------|------|------|-----------|------|------|
| **Wave 1** 首页大卡 | 玩法入口 | 4 | 📅每日 🎯经典 ⚔️多人 🎉派对 | `src/app/page.tsx:56-77` | ✅ 角色图（4 张成套，保证首页网格一致） |
| **Wave 1** 结算弹窗 | 单局结束 | 2 | 🎉猜对 😢猜错 | `src/components/GameEndDialog.tsx:73` | ✅ 角色图（对接 v9 `dialog-img` 槽位） |
| **Wave 2** 难度卡 | 干员/敌方难度选择 | 3 | 🌱简单 ⚔️普通 💀困难 | `src/app/game/page.tsx:321,337-339` | ✅ 角色图（两处选择器同款 emoji，一张两用） |
| 不画 | 多人回合横幅 | 3 | 🎉胜利 😔对手赢 🤝平局 | `multiplayer/page.tsx:877` | ❌ 保留 emoji（内联小符号） |
| 不画 | 页面头/模式徽标 | — | 📅 🎉 ⚔️ 🎯 | `daily/page.tsx`、`game/page.tsx` | ❌ 保留 emoji |
| 不画 | 功能图标 | ~15 | 🎮🏆💔📈📊⭐🏠🚪▲▼✕✓✗★☆ | stats/page、各处 | ❌ 保留 emoji（角色图不适合 16px 功能符号） |

> 规模：**Wave 1 = 6 张 → Wave 2 = 9 张**。
> 为什么不是 4：首页 4 大卡只画 2 张会让另两张空着/虚线，首页呈现"没做完"观感。
> 为什么不是 12：多人回合、每日页标题、模式徽标都是内联小符号，手绘大图放不进去。

---

## 3. 绘制规格（给画图时看）

### 3.1 尺寸（Retina 2x 标准）

| 用途 | 显示尺寸 | 出图尺寸（2x） | 说明 |
|------|---------|---------------|------|
| 首页大卡/难度卡图标 | 43–72px | **128px × 128px** | 手机到桌面都不糊 |
| 结算弹窗形象位 | 64–100px | **160px × 160px** | 弹窗放大场景 |

### 3.2 构图（统一性最关键）

- **裁切统一**：所有角色同一裁切 —— 推荐**半身像**（头 + 肩/胸口），主体占画布 **70–80%**，头顶留 ~10% 安全边距
- **背景统一**：透明（PNG）。若画装饰背景，全组用同一底色，保证视觉重量一致
- **朝向统一**：主体居中略偏上
- 不要超边框、不要贴边裁手裁脚

### 3.3 命名（图片放 `public/icons/`）

```
public/icons/
  # Wave 1 — 首页大卡 ×4
  menu-daily.png      # 📅 每日挑战
  menu-classic.png    # 🎯 经典模式
  menu-multi.png      # ⚔️ 多人对战
  menu-party.png      # 🎉 派对模式
  # Wave 1 — 结算弹窗 ×2
  result-win.png      # 🎉 猜对
  result-lose.png     # 😢 猜错
  # Wave 2 — 难度 ×3（干员/敌方两处共用）
  diff-easy.png       # 🌱 简单
  diff-normal.png     # ⚔️ 普通
  diff-hard.png       # 💀 困难
```

### 3.4 单张体积预算

- 单张 ≤ **100KB**（128px 透明 PNG 通常 20–60KB）
- Wave 1 六张 ≤ 0.6MB；全 9 张 ≤ 0.9MB，全站增量可接受
- 若手绘稿很精细（导出 >300KB），交出来，可压缩/转 WebP

---

## 4. 主题适配

- 站点有多主题（青暗夜/米纸白昼，酒红扩展位）。**透明 PNG 天然适配所有主题**——底色由容器提供
- 唯一注意：**别在角色图内画深色背景/白底**，否则在某个主题下会变成不透明色块

---

## 5. 图片到位后的接入方案

### 5.1 目录
```bash
mkdir -p public/icons
```

### 5.2 组件改动（最小 diff，保持 emoji 兜底）

**MenuCard.tsx** —— `icon` 支持「emoji 或图片路径」二选一：
```tsx
<span className="menu-icon">
  {icon.startsWith('/')
    ? <img src={icon} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'contain', borderRadius: 'inherit' }} />
    : icon}
</span>
```

**globals.css `.menu-icon`** —— 支持图片子元素（盒子尺寸/背景不动）：
```css
.menu-icon img { width: 100%; height: 100%; object-fit: contain; display: block; }
```

**结算弹窗（GameEndDialog）** —— 同样 `<img>` 替换 emoji。

> 备注：若 v9 重构上线，`.menu-icon`/`.dialog-img` 显示尺寸会变（大卡 72px / 弹窗 100px），本方案按 CSS 变量驱动，只调显示尺寸，图片文件不用重画。

### 5.3 懒加载
- 首页大卡在首屏 → 直接加载（不 `loading="lazy"`）
- 结算弹窗 → 按需挂载，天然只在出现时请求

---

## 6. 回归安全（接入不破坏现有测试）

- **保留 `.menu-card` / `.menu-icon` / `.menu-label` class 名** —— 冒烟测试选择器依赖它们
- `npm run smoke:all` 必须全绿后再 push
- 多主题 + 640px 移动端各截图对比一次

---

## 7. 试点（最小先行验证）

**先画 2 张**：`menu-daily.png` + `menu-classic.png`，走通「出图 → 接入 → 双主题验证 → smoke 全绿」全流程。
裁切/尺寸有问题只重画 2 张；确认后补齐 Wave 1 剩余 4 张，再进 Wave 2。

---

## 8. 推进节奏

1. 试点 2 张：`menu-daily` + `menu-classic`（PNG 透明，128px，半身像 80% 构图）
2. 补齐 Wave 1：`menu-multi`、`menu-party`、`result-win`、`result-lose`
3. Wave 2（可选）：`diff-easy/normal/hard` 三张
4. 每批进 `public/icons/` 后，由 Claude Code 完成 `<img>` 接入 + 主题验证 + smoke 回归
