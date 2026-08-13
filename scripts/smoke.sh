#!/usr/bin/env bash
# 派对模式冒烟测试 — 一键构建前端（指向本地测试后端）+ 跑双客户端冒烟
# 用法：npm run smoke
set -euo pipefail
cd "$(dirname "$0")/.."

BACKEND_PORT="${SMOKE_BACKEND_PORT:-3101}"
export NEXT_PUBLIC_WS_URL="http://localhost:${BACKEND_PORT}"

echo "==> 构建前端（NEXT_PUBLIC_WS_URL=${NEXT_PUBLIC_WS_URL}）"
npm run build

echo "==> 运行双客户端冒烟测试"
node tests/party-smoke.mjs
