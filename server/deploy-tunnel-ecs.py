#!/usr/bin/env python3
"""部署 cloudflared tunnel 到 ECS（仅ECS操作，不操作API）"""
import paramiko, json, time, os, urllib.request

ECS = '106.14.144.232'
ECS_PASS = '6Nn77777'
TID = 'd827699d-bbd5-4037-8982-d53a48551f76'
ACC = 'df587328bd5caa1a6e7e97c6a302f94d'
TOKEN = 'cfat_UdcyWtWOmTrIG8jpU1VT2s8lafXnEAbzOFv9zHXscdd77d2e'

# 获取tunnel token
url = f'https://api.cloudflare.com/client/v4/accounts/{ACC}/cfd_tunnel/{TID}/token'
req = urllib.request.Request(url, headers={'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/json'})
r = json.loads(urllib.request.urlopen(req).read())
tunnel_token = r.get('result', '')
print(f'Got tunnel token: {tunnel_token[:20]}...')

# 写 config
config = f'''tunnel: {TID}
credentials-file: /root/.cloudflared/{TID}.json
ingress:
  - hostname: ws.arknights-guess.online
    service: http://localhost:3001
  - service: http_status:404
'''
creds = json.dumps({'AccountTag': ACC, 'TunnelSecret': tunnel_token, 'TunnelID': TID})

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(ECS, username='root', password=ECS_PASS, timeout=10)

# 上传文件
sftp = ssh.open_sftp()
# Write to temp local, upload
f1 = 'server/_cf-config.yml'
f2 = 'server/_cf-creds.json'
with open(f1, 'w') as f: f.write(config)
with open(f2, 'w') as f: f.write(creds)
sftp.put(f1, '/root/.cloudflared/config.yml')
sftp.put(f2, f'/root/.cloudflared/{TID}.json')
sftp.close()
os.remove(f1)
os.remove(f2)
print('配置已上传')

# 杀旧进程，装服务
ssh.exec_command('pkill -f cloudflared 2>/dev/null; pkill -f ngrok 2>/dev/null')
time.sleep(2)

stdin,out,err = ssh.exec_command('/usr/local/bin/cloudflared --config /root/.cloudflared/config.yml tunnel run 2>&1 &')
time.sleep(1)

stdin,out,err = ssh.exec_command('/usr/local/bin/cloudflared service install 2>&1')
print(out.read().decode()[:200])

stdin,out,err = ssh.exec_command('systemctl enable cloudflared 2>&1; systemctl start cloudflared 2>&1')
time.sleep(5)

stdin,out,err = ssh.exec_command('systemctl status cloudflared 2>&1 | head -8')
print(out.read().decode())

ssh.close()
print('\n✅ ECS部署完成')
