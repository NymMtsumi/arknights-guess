#!/usr/bin/env python3
"""从 PRTS Wiki 批量抓取干员的种族和性别数据"""

import json
import sys
import time
import urllib.request
import urllib.parse
import urllib.error

API_BASE = "https://prts.wiki/api.php"
BATCH_SIZE = 20  # 每批查询的页面数（MediaWiki API 限制 50）
DELAY = 1.0      # 批次间延迟（秒）

def fetch_wikitext_batch(names: list[str]) -> dict[str, str]:
    """批量获取页面的 wikitext，返回 {name: wikitext}"""
    titles = "|".join(names)
    params = {
        "action": "query",
        "prop": "revisions",
        "rvprop": "content",
        "format": "json",
        "titles": titles,
    }
    url = API_BASE + "?" + urllib.parse.urlencode(params, safe="|")
    req = urllib.request.Request(url, headers={"User-Agent": "ArknightsGuess/1.0"})

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"  ⚠ API 请求失败: {e}")
        return {}

    result = {}
    pages = data.get("query", {}).get("pages", {})
    for page_id, page_data in pages.items():
        title = page_data.get("title", "")
        revisions = page_data.get("revisions", [])
        if revisions:
            result[title] = revisions[0].get("*", "")
    return result


def parse_infobox(wikitext: str) -> dict[str, str]:
    """从 wikitext 中解析 种族 和 性别"""
    result = {"race": "", "raceEn": "", "gender": "", "genderEn": ""}

    for line in wikitext.split("\n"):
        line = line.strip()
        if line.startswith("|种族="):
            result["race"] = line.replace("|种族=", "").strip()
        elif line.startswith("|性别="):
            result["gender"] = line.replace("|性别=", "").strip()
        elif line.startswith("|英文名="):
            # 也顺便获取标准英文名
            pass

    # 如果没在模板中找到，尝试从档案区域查找
    if not result["gender"]:
        for line in wikitext.split("\n"):
            if "【性别】" in line:
                result["gender"] = line.split("【性别】")[1].strip()[:10]
                break

    if not result["race"]:
        for line in wikitext.split("\n"):
            if "【种族】" in line:
                result["race"] = line.split("【种族】")[1].strip()[:30]
                break

    return result


def main():
    # 加载当前角色数据
    with open("src/data/characters.json", "r", encoding="utf-8") as f:
        characters = json.load(f)

    # 找出需要更新的角色（种族或性别为"未知"）
    need_update = [
        c for c in characters
        if c.get("race") == "未知" or c.get("gender") == "未知"
    ]

    print(f"总角色: {len(characters)}")
    print(f"需要更新: {len(need_update)}")
    print(f"批次大小: {BATCH_SIZE}, 预计 {len(need_update)//BATCH_SIZE + 1} 批")
    print()

    # 建立 name → character 的索引（用于按页面标题查找）
    name_to_chars = {}
    for c in characters:
        name_to_chars[c["name"]] = c

    updated = 0
    failed = 0
    names_list = [c["name"] for c in need_update]

    for i in range(0, len(names_list), BATCH_SIZE):
        batch = names_list[i:i + BATCH_SIZE]
        batch_num = i // BATCH_SIZE + 1
        total_batches = len(names_list) // BATCH_SIZE + 1
        print(f"[{batch_num}/{total_batches}] 查询 {len(batch)} 个角色...", end=" ", flush=True)

        wikitexts = fetch_wikitext_batch(batch)

        found = 0
        for title, wikitext in wikitexts.items():
            info = parse_infobox(wikitext)
            char = name_to_chars.get(title)
            if char:
                if info["race"] and char.get("race") == "未知":
                    char["race"] = info["race"]
                    char["raceEn"] = info["race"]  # 先用中文，后续可改进
                    found += 1
                if info["gender"] and char.get("gender") == "未知":
                    char["gender"] = info["gender"]
                    char["genderEn"] = "Male" if info["gender"] == "男" else "Female" if info["gender"] == "女" else info["gender"]
                    found += 1
            else:
                # 可能标题不匹配，跳过
                pass

        updated += found
        missing = len(batch) - len(wikitexts)
        failed += missing
        print(f"找到 {len(wikitexts)} 页, 更新 {found} 个字段", end="")
        if missing:
            print(f", 缺 {missing} 页", end="")
        print()

        time.sleep(DELAY)

    # 保存
    with open("src/data/characters.json", "w", encoding="utf-8") as f:
        json.dump(characters, f, ensure_ascii=False, indent=2)

    # 统计
    still_unknown_race = sum(1 for c in characters if c["race"] == "未知")
    still_unknown_gender = sum(1 for c in characters if c["gender"] == "未知")

    print()
    print(f"✅ 完成！更新了 {updated} 个字段, {failed} 个页面获取失败")
    print(f"   种族未知: {still_unknown_race} → {still_unknown_race}/{len(characters)}")
    print(f"   性别未知: {still_unknown_gender} → {still_unknown_gender}/{len(characters)}")


if __name__ == "__main__":
    main()
