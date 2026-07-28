#!/usr/bin/env python3
"""从 PRTS Wiki 抓取上线时间，剔除预备干员"""

import json
import time
import urllib.request
import urllib.parse
import sys

sys.stdout.reconfigure(encoding='utf-8')

API_BASE = "https://prts.wiki/api.php"
BATCH_SIZE = 30
DELAY = 0.8

def fetch_wikitext_batch(names):
    titles = "|".join(names)
    params = {
        "action": "query",
        "prop": "revisions",
        "rvprop": "content",
        "format": "json",
        "titles": titles,
    }
    url = API_BASE + "?" + urllib.parse.urlencode(params, safe="|")
    req = urllib.request.Request(url, headers={"User-Agent": "AknGuess/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"  API error: {e}")
        return {}
    result = {}
    for page_data in data.get("query", {}).get("pages", {}).values():
        title = page_data.get("title", "")
        revs = page_data.get("revisions", [])
        if revs:
            result[title] = revs[0].get("*", "")
    return result


def parse_release_date(wikitext):
    """提取上线时间，返回年份（如 2019），失败返回空"""
    for line in wikitext.split("\n"):
        line = line.strip()
        if line.startswith("|上线时间="):
            val = line.replace("|上线时间=", "").strip()
            # 格式: 2019-04-30 10:00 或 2020-01-01
            if val and len(val) >= 4:
                return val[:4]  # 取年份
    return ""


# 加载
with open("src/data/characters.json", "r", encoding="utf-8") as f:
    chars = json.load(f)

# 剔除预备干员
before = len(chars)
chars = [c for c in chars if "预备干员" not in c["name"] and not c["name"].startswith("预备")]
removed = before - len(chars)
print(f"剔除 {removed} 个预备干员，剩余 {len(chars)} 个")

# 需要查询的角色
names = [c["name"] for c in chars]
release_map = {}
failed = 0

for i in range(0, len(names), BATCH_SIZE):
    batch = names[i:i + BATCH_SIZE]
    bn = i // BATCH_SIZE + 1
    total = len(names) // BATCH_SIZE + 1
    print(f"[{bn}/{total}] 查询 {len(batch)} 个...", end=" ", flush=True)

    wikitexts = fetch_wikitext_batch(batch)
    found = 0
    for title, text in wikitexts.items():
        year = parse_release_date(text)
        if year:
            release_map[title] = year
            found += 1

    missing = len(batch) - found
    failed += missing
    print(f"获取 {found} 个年份" + (f", 缺 {missing}" if missing else ""))
    time.sleep(DELAY)

# 应用年份
added = 0
for c in chars:
    name = c["name"]
    if name in release_map:
        c["releaseYear"] = int(release_map[name])
        added += 1
    else:
        c["releaseYear"] = 0  # 未知年份

print(f"\n写入年份: {added}/{len(chars)}, 失败: {failed}")

# 统计年份分布
years = {}
for c in chars:
    y = c.get("releaseYear", 0)
    years[y] = years.get(y, 0) + 1
print(f"年份分布: {dict(sorted(years.items()))}")

# 保存
with open("src/data/characters.json", "w", encoding="utf-8") as f:
    json.dump(chars, f, ensure_ascii=False, indent=2)
print("✅ 已保存 characters.json")
