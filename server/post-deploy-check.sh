#!/bin/bash
# 部署后置检查：重启 + 健康检查（3 次重试）+ 失败自动回滚
# 由 server/deploy.sh 通过 nohup + & 分离启动（独立于 Node 进程树），
# 免疫 pm2 restart 对父 Node 进程树的清理，确保健康检查/回滚真正执行。
set -uo pipefail

OLD_HEAD="$1"
PROJECT_PATH="/opt/liyiba"
LOG_FILE="$PROJECT_PATH/deploy.log"
HEALTH_URL="http://127.0.0.1:${PORT:-3001}/api/health"
PM2_APP="${PM2_APP_NAME:-liyiba}"

log() { echo "[deploy] $(date -Iseconds) $*" >> "$LOG_FILE"; }

cd "$PROJECT_PATH" || { log " cd $PROJECT_PATH failed — aborting post-deploy check"; exit 1; }

# 等待父链（deploy.sh / flock / bash -c）退出、本进程被 reparent 到 init，
# 之后 pm2 restart 即使清理 Node 进程树也碰不到本进程。
sleep 2

pm2 restart "$PM2_APP" --update-env >> "$LOG_FILE" 2>&1
sleep 4

HEALTH_PASSED=0
for i in 1 2 3; do
  if curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null | grep -q '"ok":true'; then
    log " Health check PASSED (attempt $i)"
    HEALTH_PASSED=1
    break
  fi
  log " Health check attempt $i failed, retrying..."
  sleep 2
done

if [ "$HEALTH_PASSED" -eq 1 ]; then
  log "=== Deploy OK ==="
  exit 0
fi

# 健康检查全部失败 → 自动回滚
log "Health check FAILED after 3 attempts — ROLLING BACK to ${OLD_HEAD:0:7}"
git reset --hard "$OLD_HEAD" >> "$LOG_FILE" 2>&1
# 回滚后重装旧依赖树，避免旧源码运行在新依赖上（better-sqlite3 是 ABI 敏感的 native 模块，混用会 SIGSEGV）
if npm ci --production >> "$LOG_FILE" 2>&1; then
  log " npm ci OK (rollback)"
else
  log " npm ci FAILED during rollback — continuing"
fi
pm2 restart "$PM2_APP" --update-env >> "$LOG_FILE" 2>&1
log "=== Deploy ROLLED BACK ==="
exit 1
