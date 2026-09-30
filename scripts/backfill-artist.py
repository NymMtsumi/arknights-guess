#!/usr/bin/env python3
"""回填干员的「画师」字段（一次性脚本，可重跑幂等）。

数据源（唯一事实源）: Kengxxiao/ArknightsGameData 镜像
  zh_CN/gamedata/excel/skin_table.json   (master 分支)

⚠️ 为什么不是 character_table.json:
   那个表的条目**没有** drawlerList 字段（实测 1375 条 0 命中）。
   画师在 skin_table 的 charSkins 里。

⚠️ 为什么必须取 `<charId>#1`（基础皮）:
   同一干员的不同皮肤画师可能不同。实测「能天使」:
     char_103_angel#1        -> 幻象黑兔   ← 要的是这个
     char_103_angel@sale#8   -> 尾鱼
   取叠加皮肤会让画师数据与干员本人对不上。

⚠️ designerList 全为 null，**不要用**；只用 displaySkin.drawerList。

流程:
  1) 下载 skin_table.json（或用 --from 复用已下载的本地副本）
  2) 校验两份 roster 当前字节一致（不一致就退出 —— 避免在漂移的基线上叠加改动）
  3) 每个干员取 charSkins[f"{id}#1"].displaySkin.drawerList[0]，缺失填「未知」
  4) artist **追加到条目字段末尾**，不重排既有字段
  5) 两份 roster 写同一字节串

为什么可以整文件重 dump: 实测 json.dumps(obj, indent=2, ensure_ascii=False) + "\n"
与现有文件**字节精确相等**（237072 bytes），所以 diff 只会是新增的 artist 行。

用法:
  python scripts/backfill-artist.py --from /tmp/skin_table.json          # 用本地副本
  python scripts/backfill-artist.py --proxy http://127.0.0.1:10090      # 自行下载
  python scripts/backfill-artist.py --from ... --dry-run                # 只看统计不写
"""

import argparse
import collections
import json
import os
import sys
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SKIN_TABLE_URL = (
    "https://raw.githubusercontent.com/Kengxxiao/ArknightsGameData"
    "/master/zh_CN/gamedata/excel/skin_table.json"
)

ROSTER_PATHS = ["server/characters.json", "src/data/characters.json"]

UNKNOWN = "未知"


def dump_roster(chars):
    """与现有文件字节精确一致的序列化（别改参数 —— 会污染整个 diff）"""
    return (json.dumps(chars, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def load_skin_table(args):
    if args.from_file:
        with open(args.from_file, "rb") as f:
            raw = f.read()
        print(f"  读本地副本 {args.from_file} ({len(raw)} bytes)")
    else:
        handlers = []
        if args.proxy:
            handlers.append(urllib.request.ProxyHandler({"http": args.proxy, "https": args.proxy}))
        opener = urllib.request.build_opener(*handlers)
        req = urllib.request.Request(
            SKIN_TABLE_URL, headers={"User-Agent": "ArknightsGuess-data-sync/1.0"}
        )
        print(f"  下载 {SKIN_TABLE_URL}")
        with opener.open(req, timeout=300) as resp:
            raw = resp.read()
        print(f"  下载完成 ({len(raw)} bytes)")

    # 防御：确认下到的是真 JSON 而不是 404 文本（曾经踩过 14 字节的 "404: Not Found"）
    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception as e:
        sys.exit(f"✗ skin_table.json 不是合法 JSON（{len(raw)} bytes）: {e}")
    if "charSkins" not in data:
        sys.exit(f"✗ skin_table.json 缺 charSkins 键，实际顶层键: {list(data.keys())}")
    print(f"  charSkins 条目数: {len(data['charSkins'])}")
    return data["charSkins"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="from_file", help="复用本地已下载的 skin_table.json")
    ap.add_argument("--proxy", help="下载上游时的代理，如 http://127.0.0.1:10090")
    ap.add_argument("--dry-run", action="store_true", help="只统计，不写文件")
    args = ap.parse_args()

    print("[1/4] 读取上游画师数据")
    char_skins = load_skin_table(args)

    print("[2/4] 校验两份 roster 基线一致")
    texts = []
    for p in ROSTER_PATHS:
        with open(os.path.join(REPO_ROOT, p), "rb") as f:
            texts.append(f.read())
    if texts[0] != texts[1]:
        sys.exit("✗ 两份 roster 字节不一致，先跑 `npm run data:check` 查清再回填")
    chars = json.loads(texts[0].decode("utf-8"))
    print(f"  ✓ 基线一致，{len(chars)} 个干员")

    print("[3/4] 取 <id>#1 基础皮的 drawerList[0]")
    hit = miss = 0
    multi = []
    artists = collections.Counter()
    missing = []
    for c in chars:
        entry = char_skins.get(f"{c['id']}#1") or {}
        drawer = (entry.get("displaySkin") or {}).get("drawerList") or []
        if len(drawer) > 1:
            multi.append((c["name"], drawer))
        if drawer:
            artist = drawer[0]
            hit += 1
            artists[artist] += 1
        else:
            artist = UNKNOWN
            miss += 1
            missing.append(f"{c['name']}({c['id']})")
        # 追加到字段末尾（不重排既有字段）
        c["artist"] = artist

    print(f"  命中 {hit} / 缺失 {miss}  (总 {len(chars)})")
    print(f"  画师去重数: {len(artists)}")
    if multi:
        print(f"  ⚠️ drawerList 长度 >1 的条目 {len(multi)} 个（已取 [0]，请人工确认）:")
        for name, dl in multi:
            print(f"     {name}: {dl}")
    if missing:
        print(f"  ⚠️ 缺失清单: {', '.join(missing)}")

    if args.dry_run:
        print("\n--dry-run：未写文件")
        return

    print("[4/4] 写入两份 roster")
    blob = dump_roster(chars)
    for p in ROSTER_PATHS:
        with open(os.path.join(REPO_ROOT, p), "wb") as f:
            f.write(blob)
        print(f"  ✓ {p}  ({len(blob)} bytes)")

    print("\n画师作品数 top 15:")
    for k, v in artists.most_common(15):
        print(f"  {v:3d}  {k}")


if __name__ == "__main__":
    main()
