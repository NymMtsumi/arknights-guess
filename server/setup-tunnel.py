#!/usr/bin/env python3
"""创建 Cloudflare Named Tunnel 并部署"""
import urllib.request, json, os, subprocess, sys

TOKEN = 'cfat_UdcyWtWOmTrIG8jpU1VT2s8lafXnEAbzOFv9zHXscdd77d2e'
ACC = 'df587328bd5caa1a6e7e97c6a302f94d'
ECS = '106.14.144.232'
ECS_PASS = '6Nn77777'

def cf_api(method, path, data=None):
    url = f'https://api.cloudflare.com/client/v4/accounts/{ACC}/{path}'
    req = urllib.request.Request(url, method=method,
        headers={'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/json'})
    if data:
        req.data = json.dumps(data).encode()
    return json.loads(urllib.request.urlopen(req).read())

# 1. 创建 tunnel
print('创建 tunnel...')
r = cf_api('POST', 'cfd_tunnel', {'name': 'liyiba-ws', 'config_src': 'cloudflare'})
if not r.get('success'):
    print(f'FAIL: {r.get("errors")}')
    sys.exit(1)
tunnel = r['result']
tid = tunnel['id']
token = tunnel.get('token', '')
print(f'Tunnel ID: {tid}')

# 2. 配置 tunnel 指向 localhost:3001
print('配置 ingress...')
cf_api('PUT', f'cfd_tunnel/{tid}/configurations', {
    'config': {
        'ingress': [
            {'hostname': 'ws.arknights-guess.online', 'service': 'http://localhost:3001'},
            {'service': 'http_status:404'},
        ]
    }
})

# 3. 添加 DNS
print('添加 DNS...')
# 查找zone
zr = urllib.request.Request(f'https://api.cloudflare.com/client/v4/zones?name=arknights-guess.online',
    headers={'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/json'})
zones = json.loads(urllib.request.urlopen(zr).read())
zone_id = zones['result'][0]['id'] if zones.get('result') else '700f9b2923f668b22c45f280e350107a'

dns_r = urllib.request.Request(f'https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records',
    data=json.dumps({'type':'CNAME','name':'ws','content':f'{tid}.cfargotunnel.com','proxied':True,'ttl':1}).encode(),
    headers={'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/json'}, method='POST')
r_dns = json.loads(urllib.request.urlopen(dns_r).read())
print(f'DNS ws: {"OK" if r_dns.get("success") else r_dns.get("errors")}')

# 4. 上传 token 到 ECS 并安装
print('部署到 ECS...')
import paramiko
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(ECS, username='root', password=ECS_PASS, timeout=10)

# 安装 cloudflared 为服务
config = f'''tunnel: {tid}
credentials-file: /root/.cloudflared/{tid}.json

ingress:
  - hostname: ws.arknights-guess.online
    service: http://localhost:3001
  - service: http_status:404
'''

ssh.exec_command(f'mkdir -p /root/.cloudflared')
stdin,stdout,stderr = ssh.exec_command(f'cat > /root/.cloudflared/config.yml << END\n{config}\nEND')
print(stdout.read().decode().strip())

# 写 token 文件
import tempfile, os
tmp = tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False)
json.dump({
    'AccountTag': acc_tag,
    'TunnelSecret': token,
    'TunnelID': tid,
}, tmp)
tmp.close()

sftp = ssh.open_sftp()
sftp.put(tmp.name, f'/root/.cloudflared/{tid}.json')
sftp.close()
os.unlink(tmp.name)

# 获取 AccountTag
def get_acc_tag():
    zr2 = urllib.request.Request(f'https://api.cloudflare.com/client/v4/accounts/{ACC}',
        headers={'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/json'})
    return json.loads(urllib.request.urlopen(zr2).read()).get('result',{}).get('id', ACC)

acc_tag = get_acc_tag()

# 重写正确的 token 文件
tmp2 = tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False)
json.dump({'AccountTag': acc_tag, 'TunnelSecret': token, 'TunnelID': tid}, tmp2)
tmp2.close()
sftp = ssh.open_sftp()
sftp.put(tmp2.name, f'/root/.cloudflared/{tid}.json')
sftp.close()
os.unlink(tmp2.name)

# 安装为系统服务
stdin,stdout,stderr = ssh.exec_command('pkill -f cloudflared 2>/dev/null; sleep 1; /usr/local/bin/cloudflared service install 2>&1')
result = stdout.read().decode() + stderr.read().decode()
print('Service install:', result[:200])

# 启动
stdin,stdout,stderr = ssh.exec_command('systemctl start cloudflared 2>&1; sleep 3; systemctl status cloudflared 2>&1 | head -5')
print('Status:', stdout.read().decode()[:200])

ssh.close()

print(f'\n✅ 完成！WebSocket: wss://ws.arknights-guess.online')
