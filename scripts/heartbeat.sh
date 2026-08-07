#!/usr/bin/env bash
# 心跳监控 — crontab 每分钟调用一次
# 连续失败 ≥3 次时写告警标记文件，方便登录时快速发现异常
set -euo pipefail

LOG_DIR="/opt/liyiba/logs"
FAIL_COUNT_FILE="$LOG_DIR/heartbeat-fail-count"
ALERT_FILE="$LOG_DIR/ALERT"

mkdir -p "$LOG_DIR"

if curl -sf --max-time 5 http://localhost:3001/stats > /dev/null 2>&1; then
  # 成功：清零失败计数
  echo 0 > "$FAIL_COUNT_FILE"
  exit 0
fi

# 失败：累加计数
PREV=$(cat "$FAIL_COUNT_FILE" 2>/dev/null || echo 0)
CURRENT=$((PREV + 1))
echo "$CURRENT" > "$FAIL_COUNT_FILE"

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
echo "[$TIMESTAMP] Heartbeat FAIL #$CURRENT" >> "$LOG_DIR/heartbeat.log"

# 连续 3 次失败 → 标记告警（登录时 MOTD 会提示）
if [ "$CURRENT" -ge 3 ]; then
  echo "[$TIMESTAMP] ALERT: Server down for ${CURRENT} consecutive checks" > "$ALERT_FILE"
fi
