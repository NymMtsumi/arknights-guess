#!/usr/bin/env bash
# 心跳监控 — crontab 每分钟调用一次
# 连续失败 ≥3 次时写告警标记文件，方便登录时快速发现异常
set -euo pipefail

LOG_DIR="/opt/liyiba/logs"
FAIL_COUNT_FILE="$LOG_DIR/heartbeat-fail-count"
ALERT_FILE="$LOG_DIR/ALERT"

mkdir -p "$LOG_DIR"

if curl -sf --max-time 5 http://localhost:3001/stats > /dev/null 2>&1; then
  # 成功：清零失败计数，并撤下告警
  # 🔴 必须连 ALERT 一起删。原先成功路径只清计数，于是「告警一旦触发就永不消失」：
  #    2026-08-11 触发的那条一直挂到 2026-10-16，其间服务完全正常，
  #    而 /etc/profile.d/liyiba-alert.sh 会让 **每次 SSH 登录** 都谎报「SERVER ALERT」。
  #    监控的价值在于反映**当前**状态，不会自愈的告警比没有告警更糟。
  echo 0 > "$FAIL_COUNT_FILE"
  rm -f "$ALERT_FILE"
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
