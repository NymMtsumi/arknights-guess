#!/usr/bin/env python3
"""把本地 git PAT 存为 repo Actions secret `ACTIONS_PAT`（供 data-sync bot 推送 main 用）。

安全：token 只在本进程内使用，绝不打印；加密用 repo public key + libsodium sealed box。

用法:
  python scripts/setup-sync-secret.py [--owner NymMtsumi] [--repo arknights-guess]
        [--token-file ~/.git-credentials-nym] [--proxy http://127.0.0.1:10090]

依赖: PyNaCl (pip install pynacl)
"""

import argparse
import base64
import json
import os
import re
import sys
import urllib.request

try:
    from nacl.public import PublicKey, SealedBox
except ImportError:
    print("✗ 需要 PyNaCl: pip install pynacl", file=sys.stderr)
    sys.exit(1)

API = "https://api.github.com"
SECRET_NAME = "ACTIONS_PAT"


def read_token(token_file):
    if not os.path.exists(token_file):
        print(f"✗ 找不到凭据文件: {token_file}", file=sys.stderr)
        sys.exit(1)
    raw = open(token_file, encoding="utf-8").read().strip()
    # 形如  https://USER:TOKEN@github.com
    m = re.search(r"https?://[^:/@]+:([^/@]+)@github\.com", raw)
    if not m:
        print("✗ 无法从凭据文件解析 token（期望 https://USER:TOKEN@github.com）", file=sys.stderr)
        sys.exit(1)
    return m.group(1)


def opener(proxy):
    if proxy:
        return urllib.request.build_opener(
            urllib.request.ProxyHandler({"http": proxy, "https": proxy})
        )
    return urllib.request.build_opener()


def api_get(op, url, token):
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "arknights-guess-data-sync",
    })
    with op.open(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def api_put(op, url, token, body):
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="PUT", headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "arknights-guess-data-sync",
        "Content-Type": "application/json",
    })
    with op.open(req, timeout=30) as resp:
        return resp.status, json.loads(resp.read().decode("utf-8"))


def main():
    ap = argparse.ArgumentParser(description="把本地 PAT 存为 repo secret ACTIONS_PAT")
    ap.add_argument("--owner", default="NymMtsumi")
    ap.add_argument("--repo", default="arknights-guess")
    ap.add_argument("--token-file", default=os.path.expanduser("~/.git-credentials-nym"))
    ap.add_argument("--proxy", default=None)
    args = ap.parse_args()

    token = read_token(args.token_file)
    op = opener(args.proxy)
    base = f"{API}/repos/{args.owner}/{args.repo}/actions"

    pub = api_get(op, f"{base}/secrets/public-key", token)
    pub_key = pub["key"]
    key_id = pub["key_id"]

    seal = SealedBox(PublicKey(base64.b64decode(pub_key)))
    sealed = base64.b64encode(seal.encrypt(token.encode("utf-8"))).decode("ascii")

    status, resp = api_put(op, f"{base}/secrets/{SECRET_NAME}", token, {
        "encrypted_value": sealed,
        "key_id": key_id,
    })
    if status not in (201, 204):
        print(f"✗ 创建失败 HTTP {status}: {resp}", file=sys.stderr)
        sys.exit(1)

    names = api_get(op, f"{base}/secrets", token)["secrets"]
    present = SECRET_NAME in [s["name"] for s in names]
    print(f"✅ repo secret {SECRET_NAME} 已就绪 (key_id={key_id[:8]}…)")
    print(f"   当前 Actions secrets: {[s['name'] for s in names]}")
    if not present:
        print("⚠ 刚创建的 secret 未出现在列表？请复查", file=sys.stderr)


if __name__ == "__main__":
    main()
