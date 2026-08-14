#!/usr/bin/env bash
# 全模块冒烟测试 — 一键构建前端（指向本地测试后端）+ 顺序跑 5 个测试脚本
# 用法：npm run smoke:all
#
# 顺序（快→慢，快速失败）：
#   1. 认证链路（API 级，无 Playwright）
#   2. 管理面板（API 级 + better-sqlite3 直连提权）
#   3. 单人/每日/排行榜/统计（UI 级）
#   4. 多人对战（UI 级）
#   5. 派对模式（UI 级，回归）
#
# 任一步非 0 退出即中止（set -e），部署 gate 复用同一脚本。
set -euo pipefail
cd "$(dirname "$0")/.."

BACKEND_PORT="${SMOKE_BACKEND_PORT:-3101}"
export NEXT_PUBLIC_WS_URL="http://localhost:${BACKEND_PORT}"

echo "==> 认证链路冒烟（API）"
node tests/auth-smoke.mjs

echo "==> 管理面板冒烟（API）"
node tests/admin-smoke.mjs

echo "==> 构建前端（NEXT_PUBLIC_WS_URL=${NEXT_PUBLIC_WS_URL}）"
npm run build

echo "==> 单人/每日/排行榜/统计冒烟（UI）"
node tests/solo-smoke.mjs

echo "==> 多人对战冒烟（UI）"
node tests/multiplayer-smoke.mjs

echo "==> 派对模式冒烟（UI）"
node tests/party-smoke.mjs

echo "✅ 全模块冒烟通过"
