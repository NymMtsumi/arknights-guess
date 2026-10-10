#!/usr/bin/env python3
"""从 PRTS Wiki 爬取子职业的正确中文名"""

import json
import time
import urllib.request
import urllib.parse

API_BASE = "https://prts.wiki/api.php"

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


def parse_branch(wikitext):
    """从 wikitext 解析 分支（子职业）"""
    for line in wikitext.split("\n"):
        line = line.strip()
        if line.startswith("|分支="):
            return line.replace("|分支=", "").strip()
    return ""


# 加载当前数据
with open("src/data/characters.json", "r", encoding="utf-8") as f:
    chars = json.load(f)

# 找出每个独立 subProfessionId 对应的一个示例角色
# 按 subclassEn 分组
subclass_map = {}
for c in chars:
    en = c["subclassEn"]
    if en not in subclass_map and c["rarity"] >= 3:
        subclass_map[en] = c["name"]

print(f"需要查询 {len(subclass_map)} 个不同子职业")
print()

# 批量查询
batch = list(subclass_map.values())
correct_names = {}
batch_size = 30

for i in range(0, len(batch), batch_size):
    chunk = batch[i:i+batch_size]
    print(f"[{i//batch_size + 1}/{(len(batch)-1)//batch_size + 1}] 查询 {len(chunk)} 个角色...", end=" ", flush=True)
    wikitexts = fetch_wikitext_batch(chunk)
    found = 0
    for title, text in wikitexts.items():
        branch = parse_branch(text)
        if branch:
            # 找到这个角色对应的 subclassEn
            for c in chars:
                if c["name"] == title:
                    correct_names[c["subclassEn"]] = branch
                    found += 1
                    break
    print(f"获取 {found} 个分支名")
    time.sleep(0.8)

# 应用修正
updated = 0
for c in chars:
    en = c["subclassEn"]
    if en in correct_names and correct_names[en] != c["subclass"]:
        old = c["subclass"]
        c["subclass"] = correct_names[en]
        updated += 1
        if updated <= 20:
            print(f"  {c['name']}: {old} → {correct_names[en]}")

print(f"\n修正了 {updated} 个子职业名称")

# 显示所有修正后的映射
print("\n=== 修正后的子职业映射 ===")
for en, zh in sorted(correct_names.items()):
    print(f"  {en} → {zh}")

# 保存
with open("src/data/characters.json", "w", encoding="utf-8") as f:
    json.dump(chars, f, ensure_ascii=False, indent=2)
print("\n✅ 已保存")
