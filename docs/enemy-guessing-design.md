# 敌方单位猜谜模式 — 方案设计

> 基于 PRTS 敌方数据（2026-08-11 抓取），数据源：`https://prts.wiki/index.php?title=敌人一览/数据&action=raw&ctype=application/json`

## 一、数据规模

| 指标 | 数值 |
|------|------|
| 敌人总数 | **1681** |
| 普通 | 738 (43.9%) |
| 精英 | 709 (42.2%) |
| 领袖 | 234 (13.9%) |

对比：干员 425 个 → 敌人是干员的 **4.0 倍**。

## 二、猜测维度（11 个属性可用）

### 2.1 维度总览

| # | 属性 | 字段 | 取值数 | 分布特征 |
|---|------|------|--------|----------|
| 1 | 种类 | `enemyRace` | 12 | 62% "其他"，需分组优化 |
| 2 | 地位 | `enemyLevel` | 3 | 均匀分布 |
| 3 | 攻击方式 | `attackType` | 5 | 48% 近战, 33% 远程 |
| 4 | 伤害类型 | `damageType` | 6 | 65% 物理 |
| 5 | 行动方式 | `motion` | 3 | 85% 地面 |
| 6 | 生命值 | `endure` | 10 | SS~E 评级，集中在 A~D |
| 7 | 攻击力 | `attack` | 10 | SS~E 评级，集中在 B~C |
| 8 | 防御力 | `defence` | 10 | SS~E 评级，集中在 C~E |
| 9 | 移动速度 | `moveSpeed` | 10 | SS~E 评级，集中在 B~C |
| 10 | 攻击速度 | `attackSpeed` | 10 | SS~E 评级，集中在 B+~D |
| 11 | 法术抗性 | `resistance` | 10 | SS~E 评级，均匀分布 |

### 2.2 排除的维度

| 属性 | 原因 |
|------|------|
| `enemyRes`（抗控） | 98.8% 为 E，无区分度 |
| `enemyDamageRes`（元素抗） | 99.5% 为 E，无区分度 |
| `ability`（能力描述） | HTML 自由文本，可作为提示但不作为比较维度 |
| `enemyIndex` | 内部索引，对玩家无意义 |

### 2.3 颜色判定规则

**绿色（精确匹配）**：属性值完全相同

**黄色（部分匹配）**：
- 评级属性（endure/attack/defence/moveSpeed/attackSpeed/resistance）：**±1 级**（如 B → B+ 或 C+ 算黄）
  - 评级序列：SS > S+ > S > A+ > A > B+ > B > C > D > E
- 种类（enemyRace）：同大类下的子类（如下方优化后的分组）
- 地位：相邻（普通↔精英, 精英↔领袖）
- 攻击方式：近战+远程 与 近战/远程 互为黄色
- 伤害类型：物理+法术 与 物理/法术 互为黄色

**灰色（不匹配）**：其他情况

### 2.4 种类分组优化

"种类" 62% 集中在 "其他"，直接使用几乎没有区分度。建议按游戏世界观重新分组：

| 新分组 | 包含 | 数量 |
|--------|------|------|
| 感染生物 | 感染生物, 宿主 | 92 (5.5%) |
| 萨卡兹 | 萨卡兹, 坍缩体 | 143 (8.5%) |
| 机械体 | 机械, 无人机 | 130 (7.7%) |
| 造物 | 化物, 源石造物, 法术造物 | 186 (11.1%) |
| 海怪 | 海怪 | 66 (3.9%) |
| 野生动物 | 野生动物 | 21 (1.3%) |
| 其他 | 其他 | 1043 (62.0%) |

→ "其他" 仍占 62%，建议进一步拆分为子分类（如 "普通造物"/"异变体" 等人为分组），或**将种类降级为次要信息维度**（如同干员模式中的 tags）。

## 三、难度设计

### 3.1 三个难度池

| 难度 | 池内容 | 池大小 | 允许次数 | 类比干员 |
|------|--------|--------|----------|----------|
| 简单 | 领袖 | **234** | **6** | 干员 EASY（热门+6星）~180 |
| 普通 | 领袖+精英 | **943** | **8** | 干员 MEDIUM（全部425） |
| 困难 | 全部 | **1681** | **10** | 干员 HARD（全部425, 隐藏星级）|

### 3.2 期望值计算

目标：数学期望 E[获胜所需猜测次数] ≈ 总次数 × 40%

信息论简化模型：
- 每次猜测的有效信息增益因子 f，取决于可区分属性数量和玩家策略
- 干员模式：425 人, 8 次猜测, f ≈ 425^(1/8) ≈ **2.13**
- 单次猜测后，候选数缩小约 1/2.13
- 敌方模式使用相同 f（维度数量和区分度相当），反推各难度 E[获胜猜测次数]：

| 难度 | 池大小 | 允许次数 N | E[获胜] ≈ log(P)/log(2.13) | E/N 比例 |
|------|--------|-----------|---------------------------|----------|
| 简单 | 234 | 6 | 7.2 | 120% ❌ |
| 简单 | 234 | 7 | 7.2 | 103% ❌ |
| 简单 | 234 | **8** | 7.2 | 90% — 但次数太多 |
| 普通 | 943 | 8 | 9.1 | 114% ❌ |
| 普通 | 943 | **10** | 9.1 | 91% |
| 困难 | 1681 | 10 | 9.8 | 98% ❌ |
| 困难 | 1681 | **12** | 9.8 | 82% |
| 困难 | 1681 | **14** | 9.8 | 70% |

### 3.3 调整后的难度方案

理论期望太高，需要缩小池来达到 40% 目标：

| 难度 | 池选择 | 池大小 | 允许次数 N | E[理论] | E/N |
|------|--------|--------|-----------|---------|-----|
| 简单 | 领袖 + 非"其他"种类精英 | ~250 | **6** | 6.8 | ~113% |
| 普通 | 领袖 + 精英 | 943 | **8** | 9.1 | ~114% |
| 困难 | 全部 | 1681 | **10** | 9.8 | ~98% |

**结论**：以纯理论计算，E/N 很难精确做到 40%。实际玩家的策略效率低于最优理论值（f < 2.13），所以**实际 E 会高于理论值**，N 需要更大容错空间。

### 3.4 最终推荐方案

| 难度 | 池大小 | 猜测次数 | 说明 |
|------|--------|----------|------|
| 简单 | ~250（领袖） | **7** | 少量精英池 |
| 普通 | ~500（精英） | **8** | 中等规模 |
| 困难 | 全部 1681 | **12** | 隐藏地位（如同干员隐藏星级）|

**E/N ≈ 40% 的实现方法**：不是精确数学公式，而是通过池大小 × 允许次数 × 隐藏属性三个杠杆来调节。推荐**上线后收集真实数据**来校准。
- 前 100 局统计实际平均获胜猜测次数
- 如果 E/N > 50%：缩小池或减少 N
- 如果 E/N < 30%：扩大池或增加 N

## 四、数据库设计（独立于干员数据库）

### 4.1 建议：使用独立 SQLite 文件

```
/opt/liyiba/
  data.db         ← 现有干员数据库
  enemy_data.db   ← 敌方单位猜谜数据库（新增）
```

**理由**：
- 敌人数据 1681 条，独立维护（PRTS 更新时只替换此文件）
- 敌方游戏模式和干员模式战绩完全隔离
- 迁移、备份、清理互不影响
- `server/enemy-db.js` 管理敌方数据库连接

### 4.2 表结构

```sql
-- 敌方单位主表
CREATE TABLE enemy_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  enemy_index TEXT NOT NULL UNIQUE,       -- PRTS 索引 B1, B2, ...
  sort_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  name_en TEXT,                            -- 英文名（后续补充）
  enemy_race TEXT NOT NULL,                -- 种类（已分组的）
  enemy_race_raw TEXT NOT NULL,            -- 原始种类
  enemy_level TEXT NOT NULL,               -- 地位：普通/精英/领袖
  attack_type TEXT NOT NULL,               -- 攻击方式
  damage_type TEXT NOT NULL,               -- 伤害类型
  motion TEXT NOT NULL,                    -- 行动方式
  endure TEXT NOT NULL,                    -- 生命值评级
  attack TEXT NOT NULL,                    -- 攻击力评级
  defence TEXT NOT NULL,                   -- 防御力评级
  move_speed TEXT NOT NULL,                -- 移动速度评级
  attack_speed TEXT NOT NULL,              -- 攻击速度评级
  resistance TEXT NOT NULL,                -- 法术抗性评级
  ability TEXT,                            -- 能力描述（纯文本）
  asset_name TEXT,                         -- 头像文件名
  wiki_url TEXT,                           -- PRTS 页面链接
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 敌方猜谜战绩表
CREATE TABLE enemy_games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_key TEXT NOT NULL,
  user_id INTEGER,                         -- 注册用户 ID（可为 NULL）
  won INTEGER NOT NULL DEFAULT 0,          -- 0/1
  guess_count INTEGER NOT NULL,
  difficulty TEXT NOT NULL,                -- easy/normal/hard
  target_name TEXT NOT NULL,
  guesses_json TEXT,                       -- 每轮猜测的 JSON（可选，复盘用）
  timestamp TEXT NOT NULL,
  mode TEXT DEFAULT 'enemy_single',        -- 模式：enemy_single, enemy_daily
  daily_date TEXT,                         -- 每日模式日期
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 去重索引
CREATE UNIQUE INDEX idx_enemy_daily_user ON enemy_games(user_id, daily_date)
  WHERE user_id IS NOT NULL AND daily_date IS NOT NULL;
CREATE UNIQUE INDEX idx_enemy_daily_guest ON enemy_games(player_key, daily_date)
  WHERE user_id IS NULL AND daily_date IS NOT NULL;

-- 排行榜索引
CREATE INDEX idx_enemy_games_rank ON enemy_games(mode, difficulty, won, guess_count);
```

## 五、数据抓取与更新流程

### 5.1 数据源

```
https://prts.wiki/index.php?title=敌人一览/数据&action=raw&ctype=application/json
```

返回 1681 个敌人的完整 JSON 数组。

### 5.2 清洗脚本

`scripts/build-enemy-data.js`（待实现）：
1. 从 PRTS API 拉取 JSON
2. 过滤无用字段（enemyRes, enemyDamageRes, enemyIndex 等）
3. 种类重新分组
4. ability 去 HTML 标签，提取纯文本
5. 输出 `server/enemy-characters.json`（供后端加载）+ `src/data/enemy-characters.json`（供前端加载）

### 5.3 命名编码

敌方单位名称含特殊字符（如 `源石虫·α`、`"Mechanist"`），需要确保：
- JSON 编码为 UTF-8
- 搜索时使用 NFKC Unicode 归一化
- URL/文件名使用百分号编码

## 六、前端页面结构

### 6.1 新增路由

```
/enemy          → 敌方模式选择页（类似首页菜单）
/enemy/game     → 单人敌方猜谜
/enemy/daily    → 敌方每日挑战
/enemy/stats    → 敌方战绩统计
/enemy/rules    → 敌方规则说明
```

### 6.2 组件复用

现有组件可复用：
- `GameSearch` — 搜索下拉（需适配敌人数据源）
- `GuessTable` — 猜测结果表（需适配新的属性列）
- `GameEndDialog` — 结算弹窗
- `RulesDialog` — 规则弹窗
- `Footer` / `Header` — 页头页脚

### 6.3 新增组件

- `EnemyCard` — 敌人信息卡（含头像）
- `RatingBar` — 评级条的视觉呈现（SS→E 色阶）

## 七、工作量估算

| 阶段 | 内容 | 预估时间 |
|------|------|----------|
| 数据层 | 抓取脚本 + 清洗 + 建表 | 2h |
| 后端 | API：enemy/status, enemy/save-game, enemy/leaderboard, enemy/daily | 3h |
| 前端 Store | enemy-store.ts（Zustand） | 2h |
| 前端页面 | enemy/page, enemy/game/page, enemy/daily/page | 4h |
| i18n | 中英文词条 | 1h |
| 测试 | 本地联调 + 边界测试 | 2h |
| **合计** | | **~14h** |
