#!/usr/bin/env python3
"""干员数据映射表（单一事实源）。

职业/子职业/阵营/星级/种族 的「游戏 id → 中文/英文」转换。
同时被两处引用，改映射只需改这里：
  - scripts/convert-characters.py   （一次性 base 构建，读 character_table_raw.json）
  - scripts/auto-update.py          （增量自动同步，PRTS enrich 兜底依赖这些映射）

映射缺失时统一回退为「raw id 原样返回」，并在调用方打印 WARNING，
提示维护者到本文件补充新条目。
"""

# 八大职业
PROFESSION_MAP = {
    "CASTER":   {"zh": "术师", "en": "Caster"},
    "MEDIC":    {"zh": "医疗", "en": "Medic"},
    "PIONEER":  {"zh": "先锋", "en": "Vanguard"},
    "SNIPER":   {"zh": "狙击", "en": "Sniper"},
    "SPECIAL":  {"zh": "特种", "en": "Specialist"},
    "SUPPORT":  {"zh": "辅助", "en": "Supporter"},
    "TANK":     {"zh": "重装", "en": "Defender"},
    "WARRIOR":  {"zh": "近卫", "en": "Guard"},
}

# 子职业（含 2025-2026 新增：巡空者/佣兵/裂空炮手 等）
SUBPROFESSION_MAP = {
    "corecaster":       {"zh": "中坚术师", "en": "Core Caster"},
    "splashcaster":     {"zh": "扩散术师", "en": "Splash Caster"},
    "blastcaster":      {"zh": "轰击术师", "en": "Blast Caster"},
    "mystic":           {"zh": "秘术师", "en": "Mystic Caster"},
    "chain":            {"zh": "链术师", "en": "Chain Caster"},
    "funnel":           {"zh": "驭械术师", "en": "Mech-Accord Caster"},
    "primcaster":       {"zh": "本源术师", "en": "Primal Caster"},
    "soulcaster":       {"zh": "塑灵术师", "en": "Necrosis Caster"},
    "physician":        {"zh": "医师", "en": "Medic"},
    "ringhealer":       {"zh": "群愈师", "en": "Multi-target Medic"},
    "healer":           {"zh": "疗养师", "en": "Wandering Medic"},
    "wandermedic":      {"zh": "行医", "en": "Wandering Medic"},
    "chainhealer":      {"zh": "链愈师", "en": "Chain Medic"},
    "incantationmedic": {"zh": "咒愈师", "en": "Incantation Medic"},
    "pioneer":          {"zh": "尖兵", "en": "Pioneer"},
    "charger":          {"zh": "冲锋手", "en": "Charger"},
    "tactician":        {"zh": "战术家", "en": "Tactician"},
    "bearer":           {"zh": "执旗手", "en": "Standard Bearer"},
    "agent":            {"zh": "情报官", "en": "Agent"},
    "fastshot":         {"zh": "速射手", "en": "Marksman"},
    "closerange":       {"zh": "散射手", "en": "Spreadshooter"},
    "aoesniper":        {"zh": "炮手", "en": "Artilleryman"},
    "longrange":        {"zh": "神射手", "en": "Deadeye"},
    "siegesniper":      {"zh": "攻城手", "en": "Siege"},
    "reaperrange":      {"zh": "投掷手", "en": "Flinger"},
    "bombarder":        {"zh": "轰击手", "en": "Bombardier"},
    "loopshooter":      {"zh": "回环射手", "en": "Loopshooter"},
    "hunter":           {"zh": "猎手", "en": "Hunter"},
    "executor":         {"zh": "处决者", "en": "Executor"},
    "hookmaster":       {"zh": "拉人特种", "en": "Hookmaster"},
    "pusher":           {"zh": "推击手", "en": "Push Stroker"},
    "stalker":          {"zh": "伏击客", "en": "Ambusher"},
    "merchant":         {"zh": "行商", "en": "Merchant"},
    "traper":           {"zh": "陷阱师", "en": "Trapmaster"},
    "dollkeeper":       {"zh": "傀儡师", "en": "Dollkeeper"},
    "geek":             {"zh": "怪杰", "en": "Geek"},
    "alchemist":        {"zh": "炼金师", "en": "Alchemist"},
    "skywalker":        {"zh": "巡空者", "en": "Skywalker"},
    "slower":           {"zh": "减速者", "en": "Decel Binder"},
    "summoner":         {"zh": "召唤师", "en": "Summoner"},
    "bard":             {"zh": "吟游者", "en": "Bard"},
    "blessing":         {"zh": "护佑者", "en": "Abjurer"},
    "craftsman":        {"zh": "工匠师", "en": "Artificer"},
    "underminer":       {"zh": "削弱者", "en": "Hexer"},
    "phalanx":          {"zh": "阵法术师", "en": "Phalanx Caster"},
    "ritualist":        {"zh": "巫役", "en": "Ritualist"},
    "counsellor":       {"zh": "回环射手", "en": "Counsellor"},
    "protector":        {"zh": "铁卫", "en": "Protector"},
    "guardian":         {"zh": "守护者", "en": "Guardian"},
    "artsprotector":    {"zh": "驭法铁卫", "en": "Arts Protector"},
    "unyield":          {"zh": "不屈者", "en": "Juggernaut"},
    "duelist":          {"zh": "决战者", "en": "Duelist"},
    "fortress":         {"zh": "要塞", "en": "Fortress"},
    "shotprotector":    {"zh": "哨戒铁卫", "en": "Sentry Protector"},
    "primprotector":    {"zh": "本源铁卫", "en": "Primal Protector"},
    "sword":            {"zh": "剑豪", "en": "Swordmaster"},
    "centurion":        {"zh": "强攻手", "en": "Centurion"},
    "artsfghter":       {"zh": "术战者", "en": "Arts Fighter"},
    "fearless":         {"zh": "无畏者", "en": "Dreadnought"},
    "lord":             {"zh": "领主", "en": "Lord"},
    "fighter":          {"zh": "斗士", "en": "Brawler"},
    "musha":            {"zh": "武者", "en": "Soloblade"},
    "instructor":       {"zh": "教官", "en": "Instructor"},
    "reaper":           {"zh": "收割者", "en": "Reaper"},
    "librator":         {"zh": "解放者", "en": "Liberator"},
    "crusher":          {"zh": "重剑手", "en": "Crusher"},
    "primguard":        {"zh": "本源近卫", "en": "Primal Guard"},
    "hammer":           {"zh": "撼地者", "en": "Earthshaker"},
    "supportiveranger": {"zh": "游击手", "en": "Supportive Ranger"},
    "watchman":         {"zh": "巡哨者", "en": "Watchman"},
    "mercenary":        {"zh": "佣兵", "en": "Mercenary"},
    "skybreaker":       {"zh": "裂空炮手", "en": "Skybreaker"},
}

# 阵营（按 nationId）
NATION_MAP = {
    "rhodes":    {"zh": "罗德岛", "en": "Rhodes Island"},
    "lungmen":   {"zh": "龙门", "en": "Lungmen"},
    "kazimierz": {"zh": "卡西米尔", "en": "Kazimierz"},
    "victoria":  {"zh": "维多利亚", "en": "Victoria"},
    "ursus":     {"zh": "乌萨斯", "en": "Ursus"},
    "yan":       {"zh": "炎", "en": "Yan"},
    "siracusa":  {"zh": "叙拉古", "en": "Siracusa"},
    "laterano":  {"zh": "拉特兰", "en": "Laterano"},
    "kjerag":    {"zh": "喀兰贸易", "en": "Kjerag"},
    "columbia":  {"zh": "哥伦比亚", "en": "Columbia"},
    "sargon":    {"zh": "萨尔贡", "en": "Sargon"},
    "leithanien":{"zh": "莱塔尼亚", "en": "Leithanien"},
    "higashi":   {"zh": "东国", "en": "Higashi"},
    "bolivar":   {"zh": "玻利瓦尔", "en": "Bolívar"},
    "iberia":    {"zh": "伊比利亚", "en": "Iberia"},
    "egir":      {"zh": "阿戈尔", "en": "Ægir"},
    "minos":     {"zh": "米诺斯", "en": "Minos"},
    "rim":       {"zh": "雷姆必拓", "en": "Rim Billiton"},
    "sami":      {"zh": "萨米", "en": "Sami"},
}

TIER_MAP = {
    "TIER_1": 1, "TIER_2": 2, "TIER_3": 3,
    "TIER_4": 4, "TIER_5": 5, "TIER_6": 6,
}

# 已知角色种族（手动补充常见角色；auto-update 优先走 PRTS，此项仅兜底）
RACE_MAP = {
    "阿米娅":       {"zh": "卡特斯/奇美拉", "en": "Cautus/Chimera"},
    "凯尔希":       {"zh": "菲林", "en": "Feline"},
    "陈":           {"zh": "龙", "en": "Lung"},
    "煌":           {"zh": "菲林", "en": "Feline"},
    "能天使":       {"zh": "萨科塔", "en": "Sankta"},
    "德克萨斯":     {"zh": "鲁珀", "en": "Lupo"},
    "银灰":         {"zh": "菲林", "en": "Feline"},
    "推进之王":     {"zh": "阿斯兰", "en": "Aslan"},
    "塞雷娅":       {"zh": "瓦伊凡", "en": "Vouivre"},
    "伊芙利特":     {"zh": "萨卡兹", "en": "Sarkaz"},
    "斯卡蒂":       {"zh": "阿戈尔", "en": "Aegir"},
    "艾雅法拉":     {"zh": "卡普里尼", "en": "Caprinae"},
    "安洁莉娜":     {"zh": "沃尔珀", "en": "Vulpo"},
    "星熊":         {"zh": "鬼", "en": "Oni"},
    "夜莺":         {"zh": "萨卡兹", "en": "Sarkaz"},
    "闪灵":         {"zh": "萨卡兹", "en": "Sarkaz"},
    "黑":           {"zh": "菲林", "en": "Feline"},
    "赫拉格":       {"zh": "黎博利", "en": "Liberi"},
    "W":            {"zh": "萨卡兹", "en": "Sarkaz"},
    "迷迭香":       {"zh": "菲林", "en": "Feline"},
    "泥岩":         {"zh": "萨卡兹", "en": "Sarkaz"},
    "山":           {"zh": "菲林", "en": "Feline"},
    "棘刺":         {"zh": "阿戈尔", "en": "Aegir"},
    "铃兰":         {"zh": "沃尔珀", "en": "Vulpo"},
    "幽灵鲨":       {"zh": "阿戈尔", "en": "Aegir"},
    "拉普兰德":     {"zh": "鲁珀", "en": "Lupo"},
    "蓝毒":         {"zh": "安努拉", "en": "Anura"},
    "普罗旺斯":     {"zh": "鲁珀", "en": "Lupo"},
    "临光":         {"zh": "库兰塔", "en": "Kuranta"},
    "红":           {"zh": "鲁珀", "en": "Lupo"},
    "白面鸮":       {"zh": "黎博利", "en": "Liberi"},
    "雷蛇":         {"zh": "瓦伊凡", "en": "Vouivre"},
    "芙兰卡":       {"zh": "沃尔珀", "en": "Vulpo"},
    "空":           {"zh": "鲁珀", "en": "Lupo"},
    "华法琳":       {"zh": "萨卡兹", "en": "Sarkaz"},
    "赫默":         {"zh": "黎博利", "en": "Liberi"},
    "凛冬":         {"zh": "乌萨斯", "en": "Ursus"},
    "陨星":         {"zh": "库兰塔", "en": "Kuranta"},
    "守林人":       {"zh": "埃拉菲亚", "en": "Elafia"},
    "清道夫":       {"zh": "札拉克", "en": "Zalak"},
    "蛇屠箱":       {"zh": "匹特拉姆", "en": "Petram"},
    "桃金娘":       {"zh": "阿纳缇", "en": "Anaty"},
    "暴行":         {"zh": "卡特斯", "en": "Cautus"},
    "翎羽":         {"zh": "黎博利", "en": "Liberi"},
    "克洛丝":       {"zh": "卡特斯", "en": "Cautus"},
    "芬":           {"zh": "库兰塔", "en": "Kuranta"},
    "米格鲁":       {"zh": "佩洛", "en": "Perro"},
    "芙蓉":         {"zh": "萨卡兹", "en": "Sarkaz"},
    "炎熔":         {"zh": "萨卡兹", "en": "Sarkaz"},
    "白雪":         {"zh": "阿纳缇", "en": "Anaty"},
    "末药":         {"zh": "沃尔珀", "en": "Vulpo"},
    "远山":         {"zh": "萨弗拉", "en": "Savra"},
    "深海色":       {"zh": "阿戈尔", "en": "Aegir"},
    "星极":         {"zh": "黎博利", "en": "Liberi"},
    "梅":           {"zh": "黎博利", "en": "Liberi"},
    "送葬人":       {"zh": "萨科塔", "en": "Sankta"},
    "安德切尔":     {"zh": "萨科塔", "en": "Sankta"},
    "史都华德":     {"zh": "沃尔珀", "en": "Vulpo"},
}


def convert_rarity(tier_str: str) -> int:
    """TIER_5 -> 5，未知名回退 1。"""
    return TIER_MAP.get(tier_str, 1)


def convert_profession(prof: str) -> dict:
    return PROFESSION_MAP.get(prof, {"zh": prof, "en": prof})


def convert_subprofession(sub: str) -> dict:
    return SUBPROFESSION_MAP.get(sub, {"zh": sub, "en": sub})


def convert_nation(nation_id) -> dict:
    """nationId 可能为 None/空串。"""
    if not nation_id:
        return {"zh": "未知", "en": "Unknown"}
    return NATION_MAP.get(nation_id, {"zh": nation_id, "en": nation_id})
