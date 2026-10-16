<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:dsh-handoff -->
# 给 DeepSeek Harness (dsh) 的接手说明

本项目（`arknights-guess`）原由 Claude Code 开发，现交接给 dsh 继续。

**开工前先读这两份：**

1. `C:\Users\27125\Desktop\AI\HANDOFF-FOR-DSH.md`
   —— 主交接文档：项目全貌、全部 Memory 索引、**进行中/未收尾任务**、
     全部密钥/API/代理、以及上下文里反复强调的坑。**含机密，勿复制进本仓库。**
2. `C:\Users\27125\.dsh\handover\memory-arknights\MEMORY.md`
   —— 网站项目的持久记忆索引（24 个 memory 文件，含凭据、架构、陷阱）。

**本仓库内其它必读：**
- `CLAUDE.md` —— 项目操作手册（dsh 默认会自动加载它）
- `HANDOFF-CONFIDENTIAL.md` —— 机密凭据与架构（已 gitignore，**勿提交**）

**纪律：** 任何「已完成」必须附可复现的验证命令与输出；探针全绿 ≠ 修复成立，
必须做反事实对照。涉及生产 VPS 的修改，动手前先问用户。
<!-- END:dsh-handoff -->
