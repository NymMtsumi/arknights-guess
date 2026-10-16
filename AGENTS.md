<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:dsh-handoff -->
# 给 DeepSeek Harness (dsh) 的接手说明

本项目（`arknights-guess`）原由 Claude Code 开发，现交接给 dsh 继续。

**开工前先读（dsh 侧材料，不在本仓库内，含机密）：**

1. 主交接文档 `HANDOFF-FOR-DSH.md` —— 项目全貌、Memory 索引、**进行中/未收尾任务**、
   全部密钥/API/代理、上下文里反复强调的坑。**含明文凭据，切勿复制进本仓库。**
2. 记忆材料包 `handover/memory-arknights/MEMORY.md` —— 持久记忆索引（**索引 24 条 /
   目录 25 个文件**，含凭据、架构、陷阱）。
   > 存放位置由接手方的 `$DSH_HOME` 决定（本机为 `%USERPROFILE%\.dsh\handover\`）。

**本仓库内其它必读：**
- `CLAUDE.md` —— 项目操作手册
- `HANDOFF-CONFIDENTIAL.md` —— 机密凭据与架构（已 gitignore，**勿提交、勿复制**）

**纪律：** 任何「已完成」必须附可复现的验证命令与输出；探针全绿 ≠ 修复成立，
必须做反事实对照。涉及生产服务器的**修改**，动手前先问用户。
<!-- END:dsh-handoff -->
