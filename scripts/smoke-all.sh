#!/usr/bin/env bash
# 全模块冒烟测试 — 一键构建前端（指向本地测试后端）+ 顺序跑 13 个测试脚本
# 用法：npm run smoke:all
#
# 顺序（快→慢，快速失败）：
#   1. 海龟汤引擎/store（纯逻辑，无后端无 build —— 最快，放最前）
#   2. 认证链路（API 级，无 Playwright）
#   3. 管理面板（API 级 + better-sqlite3 直连提权）
#   4. 海龟汤专属榜（API 级，验服务端谓词）
#   5. 多人重连（Socket 级，无 build）
#   6. 单人/每日/排行榜/统计（UI 级）
#   7. 单人自建房（UI 级）
#   8. 多人对战（UI 级）
#   9. 多人画师词条（UI 级）
#  10. 派对模式（UI 级，回归）
#  11. 派对画师词条（UI 级）
#  12. 海龟汤页面（UI 级）
#  13. 全路由横切（UI 级，12 路由 × 2 主题）
#
# 第 6 步已建好产物，所以 7~13 复用同一次构建，不额外花构建时间。
# 任一步非 0 退出即中止（set -e），部署 gate 复用同一脚本。
#
# ⚠️ 这里**故意不设** NODE_OPTIONS="--require tests/_dns-preload.cjs"：
#    那个垫片只治「本机默认 DNS 解析器对 resolveMx 返回 EREFUSED」这一种环境病，
#    CI runner 与线上都正常。写进来会把「DNS 坏了」伪装成「通过」（垫片文件头自己写了）。
#    本地遇到注册请求 400「邮箱域名无效」时，手动加 NODE_OPTIONS 跑单测即可。
set -euo pipefail
cd "$(dirname "$0")/.."

BACKEND_PORT="${SMOKE_BACKEND_PORT:-3101}"
export NEXT_PUBLIC_WS_URL="http://localhost:${BACKEND_PORT}"

# ── 构建前：不需要静态产物的测试 ──

echo "==> 海龟汤引擎/store 逻辑（纯 node，无后端）"
node tests/turtle-store-test.mjs

echo "==> 认证链路冒烟（API）"
node tests/auth-smoke.mjs

echo "==> 管理面板冒烟（API）"
node tests/admin-smoke.mjs

echo "==> 海龟汤专属榜冒烟（API）"
node tests/turtle-leaderboard-test.mjs

echo "==> 多人重连冒烟（Socket）"
node tests/multi-reconnect-smoke.mjs

echo "==> 构建前端（NEXT_PUBLIC_WS_URL=${NEXT_PUBLIC_WS_URL}）"
npm run build

# ── 构建后：UI 级测试复用同一份产物 ──

echo "==> 单人/每日/排行榜/统计冒烟（UI）"
node tests/solo-smoke.mjs

echo "==> 单人自建房冒烟（UI）"
node tests/solo-custom-smoke.mjs

echo "==> 多人对战冒烟（UI）"
node tests/multiplayer-smoke.mjs

echo "==> 多人画师词条冒烟（UI）"
node tests/multi-artist-smoke.mjs

echo "==> 派对模式冒烟（UI）"
node tests/party-smoke.mjs

echo "==> 派对画师词条冒烟（UI）"
node tests/party-artist-smoke.mjs

echo "==> 海龟汤页面冒烟（UI）"
node tests/turtle-smoke.mjs

echo "==> 全路由横切冒烟（UI，12 路由 × 2 主题）"
node tests/routes-smoke.mjs

echo "✅ 全模块冒烟通过"
