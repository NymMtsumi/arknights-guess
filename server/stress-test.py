#!/usr/bin/env python3
"""ngrok 承载压力测试 - 逐步增加连接数"""
import socket, time, sys, threading

URL = 'scalded-refreeze-unedited.ngrok-free.dev'
PORT = 443
results = []

def test_connection(idx):
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(10)
        s.connect((URL, PORT))
        # 发送简单的 Socket.IO 握手
        s.send(f'GET /socket.io/?EIO=4&transport=polling HTTP/1.1\r\nHost: {URL}\r\nConnection: close\r\n\r\n'.encode())
        resp = s.recv(100)
        s.close()
        return 'OK' if b'sid' in resp else 'ERR'
    except Exception as e:
        return str(e)[:30]

def stress(conn_count):
    threads = []
    ok = 0; fail = 0
    for i in range(conn_count):
        t = threading.Thread(target=lambda i=i: results.append((i, test_connection(i))))
        t.start()
        threads.append(t)
        if i % 50 == 0:
            time.sleep(0.02)  # 小延迟避免本地端口耗尽
    for t in threads:
        t.join()
    for r in results[-conn_count:]:
        if r[1] == 'OK': ok += 1
        else: fail += 1
    return ok, fail

# 逐步加压
for count in [10, 50, 100, 200, 300, 500]:
    print(f'测试 {count} 连接...', end=' ', flush=True)
    ok, fail = stress(count)
    success_rate = ok / (ok+fail) * 100 if ok+fail else 0
    print(f'✅{ok} ❌{fail} ({success_rate:.0f}%)')
    if fail > ok * 0.5:
        print(f'⚠ 失败率超过50%，达到极限 -> ~{count} 连接')
        break
    time.sleep(2)  # 释放连接

print(f'\n当前在线: ', end='')
# 查stats
import urllib.request, json
r = json.loads(urllib.request.urlopen(f'https://{URL}/stats').read())
print(f'connections={r.get(\"connections\",\"?\")}')
