#!/usr/bin/env bash
# VPS 健康检查 — 部署前后各跑一次
# 用法: ssh root@160.236.110.37 "bash /opt/liyiba/health-check.sh"
set -euo pipefail

PASS=0; FAIL=0; WARN=0
ok()   { echo -e "\033[32m [OK]\033[0m $*"; PASS=$((PASS+1)); }
bad()  { echo -e "\033[31m[FAIL]\033[0m $*"; FAIL=$((FAIL+1)); }
warn() { echo -e "\033[33m[WARN]\033[0m $*"; WARN=$((WARN+1)); }

echo "=== Health Check @ $(date '+%Y-%m-%d %H:%M:%S') ==="
echo ""

# 1. PM2 进程在线
if pm2 jlist 2>/dev/null | grep -q '"name":"liyiba"'; then
  if pm2 jlist 2>/dev/null | grep -q '"status":"online"'; then
    ok "PM2 liyiba online"
  else
    bad "PM2 liyiba status NOT online"
  fi
else
  bad "PM2 liyiba NOT found"
fi

# 2. 端口监听
if ss -tlnp 2>/dev/null | grep -q ':3001'; then
  ok "Port 3001 listening"
else
  bad "Port 3001 NOT listening"
fi

# 3. 无不稳定重启
UNSTABLE=$(pm2 jlist 2>/dev/null | grep -o '"unstable_restarts":[0-9]*' | grep -o '[0-9]*' || echo '?')
if [ "${UNSTABLE:-0}" -eq 0 ]; then
  ok "Unstable restarts: 0"
else
  bad "Unstable restarts: ${UNSTABLE}"
fi

# 4. localhost API
if curl -sf --max-time 5 http://localhost:3001/stats > /dev/null 2>&1; then
  ok "localhost:3001 API reachable"
else
  bad "localhost:3001 API UNREACHABLE"
fi

# 5. nginx 代理
if curl -sf --max-time 5 http://localhost:80/stats > /dev/null 2>&1; then
  ok "nginx proxy :80 -> :3001 OK"
else
  bad "nginx proxy :80 UNREACHABLE"
fi

# 6. HTTPS (Cloudflare → nginx)
if curl -sf --max-time 5 https://ws.arknights-guess.online/stats > /dev/null 2>&1; then
  ok "HTTPS ws.arknights-guess.online OK"
else
  warn "HTTPS ws.arknights-guess.online unreachable (check Cloudflare)"
fi

# 7. 嵌套 node_modules 陷阱（本次故障元凶）
if [ -d /opt/liyiba/server/node_modules ]; then
  bad "NESTED node_modules at /opt/liyiba/server/node_modules/ — rm -rf it!"
else
  ok "No nested node_modules"
fi

# 8. SSL 证书
if [ -f /etc/nginx/ssl/liyiba.crt ] && [ -f /etc/nginx/ssl/liyiba.key ]; then
  ok "SSL certs present"
else
  bad "SSL certs MISSING at /etc/nginx/ssl/"
fi

# 9. nginx 服务
if systemctl is-active --quiet nginx 2>/dev/null; then
  ok "nginx service active"
else
  bad "nginx service NOT active"
fi

# 10. 磁盘 & 内存
DISK_USED=$(df -h / | awk 'NR==2{print $5}' | tr -d '%')
MEM_USED=$(free | awk '/Mem/{printf "%.0f", $3/$2*100}')
if [ "${DISK_USED:-0}" -lt 90 ]; then
  ok "Disk usage: ${DISK_USED}%"
else
  bad "Disk usage HIGH: ${DISK_USED}%"
fi
if [ "${MEM_USED:-0}" -lt 90 ]; then
  ok "Memory usage: ${MEM_USED}%"
else
  bad "Memory usage HIGH: ${MEM_USED}%"
fi

echo ""
echo "=== Result: ${PASS} passed, ${FAIL} failed, ${WARN} warnings ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
