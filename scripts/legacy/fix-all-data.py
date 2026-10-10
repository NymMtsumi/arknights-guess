#!/usr/bin/env python3
"""全量修正: 阵营改为 所属势力, 修正搜索排序"""

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

def parse_faction(wikitext):
    """提取 |所属势力= """
    for line in wikitext.split("\n"):
        line = line.strip()
        if line.startswith("|所属势力="):
            return line.replace("|所属势力=", "").strip()
    return ""

def parse_race(wikitext):
    for line in wikitext.split("\n"):
        line = line.strip()
        if line.startswith("|种族="):
            return line.replace("|种族=", "").strip()
    return ""

# 加载
with open("src/data/characters.json", "r", encoding="utf-8") as f:
    chars = json.load(f)

names = [c["name"] for c in chars]
faction_map = {}
race_map = {}
total = len(names)

for i in range(0, total, BATCH):
    batch = names[i:i+BATCH]
    print(f"[{i//BATCH+1}/{(total-1)//BATCH+1}] {len(batch)} chars...", end=" ", flush=True)
    wikis = fetch_batch(batch)
    for title, text in wikis.items():
        f = parse_faction(text)
        r = parse_race(text)
        if f: faction_map[title] = f
        if r: race_map[title] = r
    print(f"got {len(wikis)} pages, factions={len([1 for t in wikis if parse_faction(wikis[t])])}")
    time.sleep(0.7)

# 应用修正
faction_fixed = 0
race_fixed = 0
for c in chars:
    name = c["name"]
    if name in faction_map and faction_map[name] != c["faction"]:
        old = c["faction"]
        c["faction"] = faction_map[name]
        c["factionEn"] = faction_map[name]  # 先用中文
        faction_fixed += 1
        if faction_fixed <= 15:
            print(f"  阵营: {name}: {old} → {faction_map[name]}")
    if name in race_map and race_map[name] != c["race"]:
        c["race"] = race_map[name]
        c["raceEn"] = race_map[name]
        race_fixed += 1

print(f"\n阵营修正: {faction_fixed}, 种族修正: {race_fixed}")

# 统计阵营分布
factions = {}
for c in chars:
    f = c["faction"]
    factions[f] = factions.get(f, 0) + 1
print(f"阵营分布 ({len(factions)} 种):")
for f, cnt in sorted(factions.items(), key=lambda x:-x[1])[:20]:
    print(f"  {f}: {cnt}")

# 后处理：炎-龙门 → 炎,龙门（统一格式）
for c in chars:
    c['faction'] = c['faction'].replace('炎-龙门', '炎,龙门').replace('炎-岁', '岁')

# 保存
with open("src/data/characters.json", "w", encoding="utf-8") as f:
    json.dump(chars, f, ensure_ascii=False, indent=2)
print(f"\n✅ 已保存")
