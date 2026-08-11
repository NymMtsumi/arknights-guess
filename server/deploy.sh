#!/bin/bash
# 部署脚本 — 由 admin.js webhook 调用
# 6 步结构化部署 + 失败自动回滚
set -euo pipefail

PROJECT_PATH="/opt/liyiba"
NODE_BIN=$(dirname "$(which node)")
LOG_FILE="$PROJECT_PATH/deploy.log"
HEALTH_URL="http://127.0.0.1:${PORT:-3001}/api/version"
PM2_APP="${PM2_APP_NAME:-liyiba}"

log() { echo "[deploy] $(date -Iseconds) $*" >> "$LOG_FILE"; }

cd "$PROJECT_PATH"

# ===== Step 1: 备份（非致命，失败不阻止部署） =====
log "Step 1/6: backup..."
if node server/backup-db.cjs >> "$LOG_FILE" 2>&1; then
  log " Backup OK"
else
  log " Backup FAILED (non-fatal — continuing)"
fi

# ===== Step 2: 语法检查（扫描全部 server JS 文件，任一失败则中止） =====
log "Step 2/6: syntax check (all server/*.js)..."
shopt -s globstar nullglob 2>/dev/null || true
SYNTAX_OK=1
for f in server/**/*.js; do
  [ -f "$f" ] || continue
  if ! node --check "$f" 2>> "$LOG_FILE"; then
    log " Syntax FAILED: $f"
    SYNTAX_OK=0
  fi
done
if [ "$SYNTAX_OK" -eq 0 ]; then
  log " Syntax FAILED — aborting (one or more files have syntax errors)"
  exit 1
fi
log " Syntax OK (all files)"

# ===== Step 3: Fetch + Stash =====
OLD_HEAD=$(git rev-parse HEAD)
log "Step 3/6: fetch (current: ${OLD_HEAD:0:7})..."
git fetch origin main >> "$LOG_FILE" 2>&1
git stash push -m "auto-stash-before-deploy" >> "$LOG_FILE" 2>&1 || true

# ===== Step 4: Pull（fast-forward only） =====
log "Step 4/6: pull..."
if ! git pull --ff-only origin main >> "$LOG_FILE" 2>&1; then
  log " Pull FAILED — restoring stash"
  git stash pop >> "$LOG_FILE" 2>&1 || true
  exit 1
fi
NEW_HEAD=$(git rev-parse HEAD)
log " Pull OK (${OLD_HEAD:0:7} → ${NEW_HEAD:0:7})"

# ===== Step 5: npm install — 失败则回滚 =====
log "Step 5/6: npm install..."
export PATH="$PATH:$NODE_BIN"
if ! npm install --production >> "$LOG_FILE" 2>&1; then
  log " npm install FAILED — rolling back to ${OLD_HEAD:0:7}"
  git reset --hard "$OLD_HEAD" >> "$LOG_FILE" 2>&1
  exit 1
fi
log " npm install OK"

# ===== Step 6: 重启 + 健康检查（3 次重试）— 失败则回滚 =====
log "Step 6/6: restart + health check..."
pm2 restart "$PM2_APP" --update-env >> "$LOG_FILE" 2>&1
sleep 4

HEALTH_PASSED=0
for i in 1 2 3; do
  if curl -fsS --max-time 5 "$HEALTH_URL" > /dev/null 2>&1; then
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
pm2 restart "$PM2_APP" --update-env >> "$LOG_FILE" 2>&1
log "=== Deploy ROLLED BACK ==="
exit 1
