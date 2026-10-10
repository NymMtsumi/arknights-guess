#!/usr/bin/env python3
"""添加标签(tags)、异格(alter)关系, 删除盟约干员"""

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

def parse_tags(wikitext):
    for line in wikitext.split("\n"):
        line = line.strip()
        if line.startswith("|标签="):
            t = line.replace("|标签=", "").strip()
            return [tag.strip() for tag in t.split() if tag.strip()]
    return []

def parse_alter(wikitext):
    """提取异格原型名称, 返回原型名字符串或空"""
    for line in wikitext.split("\n"):
        line = line.strip()
        # {{异格干员|原型=斯卡蒂}}
        if "{{异格干员|原型=" in line and "非异格" not in line:
            start = line.find("原型=") + 3
            end = line.find("}}", start)
            if end == -1: end = len(line)
            return line[start:end].strip()
        # {{干员异格任务|对象干员=浊心斯卡蒂
        if "干员异格任务|对象干员=" in line:
            start = line.find("对象干员=") + 5
            end = line.find("}}", start)
            if end == -1: end = len(line)
            return line[start:end].strip()
    return ""

# 加载
with open("src/data/characters.json", "r", encoding="utf-8") as f:
    chars = json.load(f)

# 删除盟约干员
before = len(chars)
chars = [c for c in chars if "盟约" not in c["name"] and not c["name"].startswith("盟约")]
print(f"删除 {before-len(chars)} 个盟约干员, 剩余 {len(chars)}")

# 抓取
names = [c["name"] for c in chars]
tag_map = {}
alter_map = {}  # alter_name -> base_name
total = len(names)

for i in range(0, total, BATCH):
    batch = names[i:i+BATCH]
    bn = i//BATCH+1
    tb = (total-1)//BATCH+1
    print(f"[{bn}/{tb}] {len(batch)} chars...", end=" ", flush=True)
    wikis = fetch_batch(batch)
    got_tags = 0
    got_alters = 0
    for title, text in wikis.items():
        tags = parse_tags(text)
        if tags:
            tag_map[title] = tags
            got_tags += 1
        alter_base = parse_alter(text)
        if alter_base:
            alter_map[title] = alter_base
            got_alters += 1
    print(f"tags={got_tags} alters={got_alters}")
    time.sleep(0.7)

# 应用标签
added = 0
for c in chars:
    name = c["name"]
    if name in tag_map:
        c["tags"] = tag_map[name]
        added += 1
    else:
        c["tags"] = []
print(f"标签: {added}/{len(chars)}")

# 应用异格
alter_added = 0
for c in chars:
    name = c["name"]
    # 如果这是异格形态
    if name in alter_map:
        c["alterBase"] = alter_map[name]
        alter_added += 1
    else:
        c["alterBase"] = ""
print(f"异格关系: {alter_added} 个异格")

# 统计标签
all_tags = set()
for c in chars:
    for t in c.get("tags", []):
        all_tags.add(t)
print(f"所有标签种类 ({len(all_tags)}): {sorted(all_tags)}")

# 统计异格
for c in chars:
    if c.get("alterBase"):
        print(f"  异格: {c['name']} → 原型={c['alterBase']}")

# 保存
with open("src/data/characters.json", "w", encoding="utf-8") as f:
    json.dump(chars, f, ensure_ascii=False, indent=2)
print(f"\n✅ 已保存 {len(chars)} 个角色")
