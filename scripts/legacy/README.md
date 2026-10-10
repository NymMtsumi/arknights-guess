# scripts/legacy —— 一次性脚本归档

这里放的是**跑过一次就完事**的历史脚本：早期把 roster 从手搓数据补成 PRTS 口径的那几轮数据手术、
一次性运维修复、以及一次性的配置引导。

**它们的结果已经固化在 `src/data/characters.json` / `server/characters.json` 里**，正常开发流程
（`scripts/auto-update.py` 每日增量 + `scripts/maps.py` 映射表）不会再调用它们。放在这里而不是
直接删掉，是为了留下「这列字段当初是怎么来的」的线索 —— 出问题时会话记录可能已经没了，但脚本还在。

⚠️ **别当成工具链的一部分去调用。** 多数脚本硬编码了当时的绝对路径（`/opt/liyiba/data.db`、
本机会话 JSONL），或在没有网络/PRTS 结构变动后会直接失败。要重跑请先读它的文件头注释。

| 文件 | 干了什么 |
|---|---|
| `add-release-year.py` | 从 PRTS Wiki 抓上线年份，剔除预备干员 |
| `add-tags-alters.py` | 补 `tags` 与异格（alter）关系，并删除盟约干员 |
| `fix-all-data.py` | 全量修正：阵营改名为「所属势力」、修正搜索排序 |
| `fix-subclass-names.py` | 从 PRTS 爬子职业正确中文名（**此职责已移交 `scripts/maps.py`**） |
| `fetch-race-gender.py` | 批量抓种族 / 性别 |
| `verify-gender.py` | 对照 PRTS 校验性别字段 |
| `verify-subclass.py` | 对照 PRTS 找出子职业名差异 |
| `clean-daily-dups.cjs` | 删每日挑战的重复记录（硬编码 `/opt/liyiba/data.db`） |
| `merge-db.js` | 把当前库合并回某个备份库（硬编码 `data.db.bak-20260805-1515`） |
| `setup-sync-secret.py` | 把本地 PAT 存成 repo secret `ACTIONS_PAT`（data-sync bot 推送用，已完成） |
| `extract-user-messages.mjs` | 从会话 JSONL 提取用户真实消息（硬编码本机 transcript 绝对路径） |
| `characters_export.csv` | 上述数据手术期间导出的 roster 快照（72 KB，非脚本） |

## 仍然 live、**没有**放进这里的同名近亲

- `scripts/auto-update.py`、`scripts/maps.py` —— 每日数据同步管道（`data:sync`）
- `scripts/backfill-artist.py` —— 幂等可重跑，且被 `auto-update.py` / `.gitattributes` 的注释按名引用
- `scripts/convert-characters.py` —— roster 基线构建器
- `scripts/build-enemy-data.js` —— 生成前后端两份 `enemy-characters.json`
- `scripts/make-favicon.py` —— 二进制 `favicon.ico` 的生成说明
- `scripts/serve-local.mjs` —— 按生产路由形态预览 `out/` 构建产物
