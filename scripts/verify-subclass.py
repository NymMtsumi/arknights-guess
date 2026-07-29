#!/usr/bin/env python3
"""对比 PRTS wiki 上的子职业名称，找出差异"""

import json, time, urllib.request, urllib.parse, sys
sys.stdout.reconfigure(encoding='utf-8')

API = "https://prts.wiki/api.php"
BATCH = 30

def fetch_batch(names):
    titles = "|".join(names)
    params = {"action":"query","prop":"revisions","rvprop":"content","format":"json","titles":titles}
    url = API + "?" + urllib.parse.urlencode(params, safe="|")
    req = urllib.request.Request(url, headers={"User-Agent":"Akn/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read().decode())
    except: return {}
    result = {}
    for p in data.get("query",{}).get("pages",{}).values():
        revs = p.get("revisions",[])
        if revs: result[p["title"]] = revs[0].get("*","")
    return result

def parse_subclass(wikitext):
    """从 wikitext 提取 |分支= """
    for line in wikitext.split("\n"):
        line = line.strip()
        if line.startswith("|分支="):
            return line.replace("|分支=", "").strip()
    return ""

def parse_class(wikitext):
    """从 wikitext 提取 |职业= """
    for line in wikitext.split("\n"):
        line = line.strip()
        if line.startswith("|职业="):
            return line.replace("|职业=", "").strip()
    return ""

# 加载
with open("src/data/characters.json", "r", encoding="utf-8") as f:
    chars = json.load(f)

names = [c["name"] for c in chars]
total = len(names)
differences = []

for i in range(0, total, BATCH):
    batch = names[i:i+BATCH]
    print(f"[{i//BATCH+1}/{(total-1)//BATCH+1}] 检查 {len(batch)} 个...", end=" ", flush=True)
    wikis = fetch_batch(batch)
    found = 0
    for title, text in wikis.items():
        prts_sub = parse_subclass(text)
        prts_class = parse_class(text)
        # 找到对应角色
        for c in chars:
            if c["name"] == title:
                if prts_sub and prts_sub != c["subclass"]:
                    differences.append((title, c["subclass"], prts_sub, c["class"], prts_class))
                if prts_class and prts_class != c["class"]:
                    differences.append((title, c["class"], prts_class, "CLASS", ""))
                found += 1
                break
    print(f"检查 {found} | 差异 {len(differences)}")
    time.sleep(0.7)

print(f"\n=== 发现 {len(differences)} 处差异 ===")
for name, old, new, context, ctx2 in differences:
    tag = "职业" if context == "CLASS" else "子职业"
    print(f"  {name}: [{tag}] {old} → {new}")

# 如果有差异，自动修正子职业
if differences:
    subclass_fixes = {d[0]: d[2] for d in differences if d[3] != "CLASS"}
    class_fixes = {d[0]: d[2] for d in differences if d[3] == "CLASS"}

    fixed = 0
    for c in chars:
        if c["name"] in subclass_fixes:
            c["subclass"] = subclass_fixes[c["name"]]
            fixed += 1
        if c["name"] in class_fixes:
            c["class"] = class_fixes[c["name"]]
            fixed += 1

    with open("src/data/characters.json", "w", encoding="utf-8") as f:
        json.dump(chars, f, ensure_ascii=False, indent=2)
    print(f"\n✅ 已自动修正 {fixed} 条")
else:
    print("\n✅ 子职业全部正确，无需修正")
