#!/usr/bin/env bash
# 后端部署脚本 — 带健康检查验证
# 用法: bash scripts/deploy.sh
set -euo pipefail

VPS="root@160.236.110.37"
VPS_PATH="/opt/liyiba/server"
SERVER_DIR="$(cd "$(dirname "$0")/../server" && pwd)"

echo "=== Deploy Backend @ $(date '+%Y-%m-%d %H:%M:%S') ==="
echo ""

# 1. 部署前健康检查
echo "--- Pre-deploy health check ---"
ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 "$VPS" "bash /opt/liyiba/health-check.sh" || {
  echo ""
  echo "❌ Pre-deploy health check FAILED. Fix issues before deploying."
  exit 1
}

# 2. 上传文件
echo ""
echo "--- Uploading files ---"
FILES=(
  "index.js"
  "db.js"
  "auth.js"
  "utils.js"
  "characters.js"
  "characters.json"
  "routes/auth.js"
  "routes/user.js"
  "routes/game.js"
  "routes/admin.js"
  "socket/index.js"
  "socket/rooms.js"
  "socket/matchmaking.js"
  "socket/game.js"
)

for f in "${FILES[@]}"; do
  if [ -f "$SERVER_DIR/$f" ]; then
    scp -q -o StrictHostKeyChecking=no -o ConnectTimeout=10 \
      "$SERVER_DIR/$f" "$VPS:$VPS_PATH/$f" 2>/dev/null && \
      echo "  OK  $f" || echo "  FAIL $f"
  else
    echo "  SKIP $f (not found locally)"
  fi
done

# 3. 重启 PM2
echo ""
echo "--- Restarting PM2 ---"
ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 "$VPS" \
  "pm2 restart liyiba --update-env" 2>&1

# 4. 等待服务就绪
echo ""
echo "--- Waiting for server to be ready ---"
for i in 1 2 3 4 5; do
  sleep 1
  if ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 "$VPS" \
    "curl -sf --max-time 3 http://localhost:3001/stats > /dev/null" 2>/dev/null; then
    echo "  Server ready after ${i}s"
    break
  fi
  if [ "$i" -eq 5 ]; then
    echo "  ⚠️  Server did not respond within 5s"
  fi
done

# 5. 部署后健康检查
echo ""
echo "--- Post-deploy health check ---"
ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 "$VPS" "bash /opt/liyiba/health-check.sh"
RESULT=$?

echo ""
if [ "$RESULT" -eq 0 ]; then
  echo "✅ Deploy SUCCESS"
else
  echo "❌ Deploy FAILED — check VPS logs: ssh $VPS 'pm2 logs liyiba --lines 50'"
fi

exit "$RESULT"
