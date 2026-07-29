#!/usr/bin/env python3
"""校验 PRTS wiki 上的性别数据"""

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

def parse_gender(wikitext):
    for line in wikitext.split("\n"):
        line = line.strip()
        if line.startswith("|性别="):
            return line.replace("|性别=", "").strip()
    return ""

with open("src/data/characters.json", "r", encoding="utf-8") as f:
    chars = json.load(f)

names = [c["name"] for c in chars]
total = len(names)
differences = []

for i in range(0, total, BATCH):
    batch = names[i:i+BATCH]
    print(f"[{i//BATCH+1}/{(total-1)//BATCH+1}] 检查 {len(batch)} 个...", end=" ", flush=True)
    wikis = fetch_batch(batch)
    for title, text in wikis.items():
        prts_gender = parse_gender(text)
        if not prts_gender: continue
        for c in chars:
            if c["name"] == title:
                if c["gender"] != prts_gender:
                    differences.append((title, c["gender"], prts_gender))
                break
    print(f"差异 {len(differences)}")
    time.sleep(0.7)

print(f"\n=== 发现 {len(differences)} 处差异 ===")
for name, old, new in differences:
    print(f"  {name}: {old} → {new}")

# 自动修正
if differences:
    fix_map = {d[0]: d[2] for d in differences}
    fixed = 0
    for c in chars:
        if c["name"] in fix_map:
            old = c["gender"]
            new_g = fix_map[c["name"]]
            c["gender"] = new_g
            c["genderEn"] = "Male" if new_g == "男" else "Female" if new_g == "女" else new_g
            fixed += 1
    with open("src/data/characters.json", "w", encoding="utf-8") as f:
        json.dump(chars, f, ensure_ascii=False, indent=2)
    print(f"\n✅ 已修正 {fixed} 条")
else:
    print("\n✅ 性别全部正确")
