#!/usr/bin/env python3
"""从 ArknightsGameData character_table.json 提取角色数据"""

# 映射表统一来自 scripts/maps.py（convert-characters 与 auto-update 共用，单一事实源）
import json
from maps import (
    RACE_MAP,
    convert_rarity,
    convert_profession,
    convert_subprofession,
    convert_nation,
)

def main():
    with open('scripts/character_table_raw.json', 'r', encoding='utf-8') as f:
        raw_data = json.load(f)

    characters = []
    seen_names = set()

    for key, val in raw_data.items():
        # 排除 token、trap 等非角色条目
        if any(x in key for x in ['token', 'trap', 'test', 'default']):
            continue

        name_zh = val.get('name', '')
        name_en = val.get('appellation', '')

        # 跳过无名称或重复的角色
        if not name_zh or not name_en:
            continue
        if name_zh in seen_names:
            continue
        seen_names.add(name_zh)

        # 排除明显非干员的条目（isNotObtainable + 低星）
        rarity_str = val.get('rarity', 'TIER_1')
        if val.get('isNotObtainable') and rarity_str == 'TIER_1':
            # 但仍保留 1 星可获取角色（如机器人）
            pass

        profession = val.get('profession', '')
        subprofession = val.get('subProfessionId', '')
        nation_id = val.get('nationId', '')

        prof_data = convert_profession(profession)
        sub_data = convert_subprofession(subprofession)
        nation_data = convert_nation(nation_id)

        rarity = convert_rarity(rarity_str)

        # 种族
        race_data = RACE_MAP.get(name_zh, {"zh": "未知", "en": "Unknown"})

        # 性别（简单推测：大部分为女，少数已知男角色）
        # 从已有的 110 角色数据可以扩展
        gender_data = {"zh": "未知", "en": "Unknown"}

        characters.append({
            "id": key,
            "name": name_zh,
            "nameEn": name_en,
            "class": prof_data["zh"],
            "classEn": prof_data["en"],
            "subclass": sub_data["zh"],
            "subclassEn": sub_data["en"],
            "faction": nation_data["zh"],
            "factionEn": nation_data["en"],
            "rarity": rarity,
            "race": race_data["zh"],
            "raceEn": race_data["en"],
            "gender": gender_data["zh"],
            "genderEn": gender_data["en"],
            "position": "高台" if val.get("position") == "RANGED" else "地面" if val.get("position") == "MELEE" else "未知",
            "positionEn": "Ranged" if val.get("position") == "RANGED" else "Melee" if val.get("position") == "MELEE" else "Unknown",
        })

    # 写入输出文件
    output_path = 'src/data/characters.json'
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(characters, f, ensure_ascii=False, indent=2)

    print(f"✅ 已转换 {len(characters)} 个角色")
    print(f"   输出: {output_path}")

    # 统计
    rarity_counts = {}
    class_counts = {}
    for c in characters:
        r = c['rarity']
        rarity_counts[r] = rarity_counts.get(r, 0) + 1
        cl = c['class']
        class_counts[cl] = class_counts.get(cl, 0) + 1

    print(f"\n   星级分布: {dict(sorted(rarity_counts.items()))}")
    print(f"   职业分布: {dict(sorted(class_counts.items()))}")


if __name__ == '__main__':
    main()
