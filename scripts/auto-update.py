#!/usr/bin/env python3
"""增量自动同步明日方舟干员数据。

数据源（唯一事实源）: Kengxxiao/ArknightsGameData 镜像
  zh_CN/gamedata/excel/character_table.json   (master 分支)

流程:
  1) 拉取上游该文件的 blob sha（GitHub contents API）
  2) 与状态文件 .github/data-sync-state.json 的 seen 比较；未变且无挂起 → 退出 0
  3) 变了 → 下载完整表 → 候选 = 可获取干员
     （有中英文名、isNotObtainable=False、key 不含 token/trap/test/default、
       zh 名不在当前 roster）
  4) 新候选 与 挂起未加入的干员 一起走 PRTS wiki 增量 enrich
     （只查少数几个新名字，绝不重跑全量 425）
  5) 完整性 gate：race/gender 仍「未知」的候选挂起
     （.github/data-sync-held.json，含 base entry，重试只需查 PRTS）
     同一候选挂起超过阈值 → force-add（允许未知字段，避免永远卡住）
  6) 变更「只追加」到 server/characters.json 与 src/data/characters.json
     —— 绝不重排已有行：每日挑战 seed 按池内索引取目标，重排会让同日目标漂移；
       两文件写同一字节串保证一致
  7) seen 每次检查后推进；merged 仅当无挂起时推进

模式:
  --dry-run   只计算与打印变更，不写任何文件（含状态）
  --apply     完整执行并写文件（GitHub Actions 用）
  --check     只比较 seen 与上游 sha，不下载不写
  --wiki-test NAME  对指定干员跑一次 PRTS enrich（演练用，不写 roster）

代理（仅本地需要；GitHub Actions 无需）:
  --proxy http://127.0.0.1:PORT       仅用于 GitHub（下载上游表）
  --wiki-proxy http://127.0.0.1:PORT  仅用于 PRTS wiki

示例:
  python scripts/auto-update.py --check
  python scripts/auto-update.py --dry-run --proxy http://127.0.0.1:10090
  python scripts/auto-update.py --apply
"""

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import date

# 让 `import maps` 生效（本文件与 maps.py 同目录）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from maps import (  # noqa: E402
    RACE_MAP,
    convert_nation,
    convert_profession,
    convert_rarity,
    convert_subprofession,
)

sys.stdout.reconfigure(encoding="utf-8")

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 上游镜像
GITHUB_API = "https://api.github.com"
MIRROR = "Kengxxiao/ArknightsGameData"
UPSTREAM_REF = "master"
UPSTREAM_PATH = "zh_CN/gamedata/excel/character_table.json"

# 本仓库内文件（相对 REPO_ROOT）
ROSTER_PATHS = ["server/characters.json", "src/data/characters.json"]
STATE_PATH = ".github/data-sync-state.json"
HELD_PATH = ".github/data-sync-held.json"

# PRTS wiki
WIKI_API = "https://prts.wiki/api.php"
WIKI_BATCH = 30          # 每批 wiki 查询页数（MediaWiki 上限 50）
WIKI_DELAY = 0.8         # 批次间延迟（秒）

MAX_HELD_ATTEMPTS = 5    # 同一候选挂起重试次数上限，超限 force-add

UA = "ArknightsGuess-data-sync/1.0 (github actions; contact: repo owner)"
REQUIRED_FIELDS = [
    "id", "name", "nameEn", "class", "classEn", "subclass", "subclassEn",
    "faction", "factionEn", "rarity", "race", "raceEn", "gender", "genderEn",
    "popularity", "releaseYear", "tags", "alterBase", "position", "positionEn",
]


# ============================================================ HTTP
def build_opener(proxy):
    if proxy:
        handler = urllib.request.ProxyHandler({"http": proxy, "https": proxy})
        return urllib.request.build_opener(handler)
    return urllib.request.build_opener()


def http_get_bytes(url, opener, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with opener.open(req, timeout=timeout) as resp:
        return resp.read()


def http_get_json(url, opener, timeout=60):
    data = http_get_bytes(url, opener, timeout)
    return json.loads(data.decode("utf-8"))


# ============================================================ 上游状态
def get_upstream_meta(opener):
    """返回 (sha, download_url)。sha 为该文件的 git blob sha，上游任何改动都会变。"""
    url = f"{GITHUB_API}/repos/{MIRROR}/contents/{UPSTREAM_PATH}?ref={UPSTREAM_REF}"
    try:
        meta = http_get_json(url, opener, timeout=30)
    except Exception as e:
        print(f"✗ GitHub API 请求失败: {e}", file=sys.stderr)
        return None, None
    download_url = meta.get("download_url") or (
        f"https://raw.githubusercontent.com/{MIRROR}/{UPSTREAM_REF}/{UPSTREAM_PATH}"
    )
    return meta.get("sha"), download_url


def download_table(opener, download_url):
    print(f"下载上游表 ({UPSTREAM_PATH})…")
    raw = http_get_bytes(download_url, opener, timeout=180)
    print(f"  收到 {len(raw):,} 字节")
    return json.loads(raw.decode("utf-8"))


def load_state():
    p = os.path.join(REPO_ROOT, STATE_PATH)
    if not os.path.exists(p):
        return {"source": f"{MIRROR}@{UPSTREAM_REF}:{UPSTREAM_PATH}", "seen": None, "merged": None}
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def save_state(state):
    state["source"] = f"{MIRROR}@{UPSTREAM_REF}:{UPSTREAM_PATH}"
    state["checked"] = date.today().isoformat()
    p = os.path.join(REPO_ROOT, STATE_PATH)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
        f.write("\n")


# ============================================================ roster 读写
def load_roster(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def serialize_roster(data):
    """与现有文件字节格式完全一致（已验证 round-trip 仅差结尾换行）。"""
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"


def write_roster(path, data):
    with open(path, "w", encoding="utf-8") as f:
        f.write(serialize_roster(data))


# ============================================================ 候选筛选
def select_candidates(ct, roster_names):
    """返回有序 [(key, val)]：上游新出的可获取干员，zh 名不在当前 roster。

    规则与历史验证一致：在 live 数据上精确复现现有 425 人名单
    （0 缺失、0 多余）。同 zh 名多 key 时按 key 排序取最后（如 暮落 双 id）。
    """
    cand = {}
    for key, val in ct.items():
        if any(x in key for x in ("token", "trap", "test", "default")):
            continue
        name_zh, name_en = val.get("name", ""), val.get("appellation", "")
        if not name_zh or not name_en:
            continue
        if val.get("isNotObtainable"):
            continue
        cand[name_zh] = (key, val)
    return sorted(
        ((k, v) for n, (k, v) in cand.items() if n not in roster_names),
        key=lambda kv: kv[0],
    )


# ============================================================ base 条目构建
def build_base_entry(key, val):
    """由 character_table 构建 20 字段条目；race/gender/tags 由 PRTS/mirror 后续填充。

    返回值 (entry, warnings)。warnings 提示映射表缺失，需人工补 maps.py。
    """
    warnings = []
    name_zh = val.get("name", "")
    name_en = val.get("appellation", "")

    prof = convert_profession(val.get("profession", ""))
    if prof["zh"] == val.get("profession", ""):
        warnings.append(f"职业映射缺失 profession={val.get('profession')!r}")
    sub = convert_subprofession(val.get("subProfessionId", ""))
    if sub["zh"] == val.get("subProfessionId", ""):
        warnings.append(f"子职业映射缺失 subProfessionId={val.get('subProfessionId')!r}")
    nation = convert_nation(val.get("nationId"))

    rarity = convert_rarity(val.get("rarity", "TIER_1"))

    pos_raw = val.get("position", "NONE")
    position = {
        "RANGED": ("高台", "Ranged"),
        "MELEE": ("地面", "Melee"),
    }.get(pos_raw, ("未知", "Unknown"))

    race_map = RACE_MAP.get(name_zh)

    entry = {
        "id": key,
        "name": name_zh,
        "nameEn": name_en,
        "class": prof["zh"],
        "classEn": prof["en"],
        "subclass": sub["zh"],
        "subclassEn": sub["en"],
        "faction": nation["zh"],
        "factionEn": nation["en"],
        "rarity": rarity,
        "race": race_map["zh"] if race_map else "未知",
        "raceEn": race_map["en"] if race_map else "Unknown",
        "gender": "未知",
        "genderEn": "Unknown",
        "popularity": "normal",
        "releaseYear": date.today().year,   # 新干员即为今年实装；PRTS 有准确值时覆盖
        "tags": list(val.get("tagList") or []),
        "alterBase": "",
        "position": position[0],
        "positionEn": position[1],
    }
    return entry, warnings


# ============================================================ PRTS enrich
def fetch_wikitext_batch(names, opener):
    """批量取 wikitext，返回 {title: wikitext}。"""
    titles = "|".join(names)
    params = {
        "action": "query", "prop": "revisions", "rvprop": "content",
        "format": "json", "titles": titles,
    }
    url = WIKI_API + "?" + urllib.parse.urlencode(params, safe="|")
    try:
        data = http_get_json(url, opener, timeout=30)
    except Exception as e:
        print(f"  ⚠ PRTS API 失败: {e}")
        return {}
    result = {}
    for page_data in data.get("query", {}).get("pages", {}).values():
        title = page_data.get("title", "")
        revs = page_data.get("revisions", [])
        if revs:
            result[title] = revs[0].get("*", "")
    return result


def _clean(v):
    v = v.strip()
    # 未录入 = PRTS 模板中间态占位（编辑未完成），与 未知/暂无 同等对待，绝不当作真实值
    return "" if v in ("？", "?", "-", "—", "暂无", "未知", "未录入") else v


def _parse_alter(line):
    if "{{异格干员|原型=" in line and "非异格" not in line:
        start = line.find("原型=") + 3
        end = line.find("}}", start)
        return line[start: end if end != -1 else len(line)].strip()
    if "干员异格任务|对象干员=" in line:
        start = line.find("对象干员=") + 5
        end = line.find("}}", start)
        return line[start: end if end != -1 else len(line)].strip()
    return ""


def parse_wikitext(wikitext):
    """从 infobox 解析 种族/性别/所属势力/上线时间/标签/异格原型。"""
    info = {"race": "", "gender": "", "faction": "", "year": None, "tags": [], "alter": ""}
    for line in wikitext.split("\n"):
        s = line.strip()
        if s.startswith("|种族="):
            info["race"] = _clean(s[len("|种族="):])
        elif s.startswith("|性别="):
            info["gender"] = _clean(s[len("|性别="):])
        elif s.startswith("|所属势力="):
            info["faction"] = _clean(s[len("|所属势力="):])
        elif s.startswith("|上线时间="):
            v = s[len("|上线时间="):].strip()
            if v[:4].isdigit():
                info["year"] = int(v[:4])
        elif s.startswith("|标签="):
            tags = [t.strip() for t in s[len("|标签="):].split() if t.strip()]
            if tags:
                info["tags"] = tags
        elif s.startswith("|") and "异格" in s and "原型" in s:
            alter = _parse_alter(s)
            if alter:
                info["alter"] = alter
    # 档案区兜底（部分页面 infobox 不带，档案段有）
    if not info["gender"]:
        for line in wikitext.split("\n"):
            if "【性别】" in line:
                info["gender"] = _clean(line.split("【性别】")[1].strip()[:10])
                break
    if not info["race"]:
        for line in wikitext.split("\n"):
            if "【种族】" in line:
                info["race"] = _clean(line.split("【种族】")[1].strip()[:30])
                break
    return info


def gender_to_en(zh):
    return {"男": "Male", "女": "Female"}.get(zh, zh or "Unknown")


def apply_prts(entry, info):
    """把 PRTS 解析结果并入 entry；只覆盖「新值非空」的字段。返回是否 race/gender 完整。"""
    if info["race"] and entry["race"] in ("未知", "Unknown", "", "未录入"):
        entry["race"] = info["race"]
        entry["raceEn"] = info["race"]          # en 不维护完整词表，沿用中文（同历史）
    if info["gender"] and entry["gender"] in ("未知", "Unknown", "", "未录入"):
        entry["gender"] = info["gender"]
        entry["genderEn"] = gender_to_en(info["gender"])
    if info["faction"]:
        # PRTS 所属势力比 nationId 映射更精确（如 龙门/近卫局），以 wiki 为准
        if info["faction"] != entry["faction"]:
            entry["faction"] = info["faction"]
            entry["factionEn"] = info["faction"]
    if info["year"]:
        entry["releaseYear"] = info["year"]
    if not entry.get("tags") and info["tags"]:
        entry["tags"] = info["tags"]
    if info["alter"]:
        entry["alterBase"] = info["alter"]
    return is_complete(entry)


def is_complete(entry):
    """race/gender 非未知才算完整（这两项只能靠 PRTS，无法从镜像推导）。"""
    return entry["race"] not in ("", "未知", "Unknown", "未录入") and \
        entry["gender"] not in ("", "未知", "Unknown", "未录入")


# ============================================================ 挂起/写入
def load_held():
    p = os.path.join(REPO_ROOT, HELD_PATH)
    if not os.path.exists(p):
        return {}
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def save_held(held):
    p = os.path.join(REPO_ROOT, HELD_PATH)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(held, f, ensure_ascii=False, indent=2)
        f.write("\n")


def validate_entries(entries):
    """写入前的轻量自检：字段齐全、名字非空、无重复。"""
    missing = [e.get("name") for e in entries
               if any(f not in e for f in REQUIRED_FIELDS)]
    if missing:
        raise SystemExit(f"✗ 条目字段不完整: {missing}")
    names = [e.get("name") for e in entries]
    if len(names) != len(set(names)):
        raise SystemExit(f"✗ 新增条目含重复名字: {names}")


def print_entry(e):
    print(f"    [{e['rarity']}★ {e['class']}/{e['subclass']}] {e['name']} ({e['nameEn']})"
          f"  {e['faction']} {e['race']} {e['gender']} {e['releaseYear']}"
          f" tags={e['tags']} alterBase={e.get('alterBase', '') or '-'}")


# ============================================================ 主流程
def run_sync(opener, wiki_opener, apply_mode):
    state = load_state()
    held = load_held()

    sha, download_url = get_upstream_meta(opener)
    if not sha:
        return 2

    changed = sha != state.get("seen")
    if not changed and not held:
        print("✓ 上游无更新，roster 已最新")
        return 0

    new_entries = {}   # name -> entry
    if changed:
        ct = download_table(opener, download_url)
        roster = load_roster(os.path.join(REPO_ROOT, ROSTER_PATHS[0]))
        roster_names = {c["name"] for c in roster}
        candidates = select_candidates(ct, roster_names)
        # 已在挂起名单里的名字不重复入选（走 held 重试路径，保留 attempts 计数）
        candidates = [(k, v) for k, v in candidates if v.get("name", "") not in held]
        if candidates:
            for key, val in candidates:
                entry, warns = build_base_entry(key, val)
                for w in warns:
                    print(f"  ⚠ WARNING: {entry['name']}: {w} —— 请补 scripts/maps.py")
                new_entries[entry["name"]] = entry
            print(f"发现 {len(new_entries)} 个新干员: {sorted(new_entries)}")
        else:
            print(f"上游有更新但无新可获取干员（{UPSTREAM_PATH} 变化可能与 roster 无关）")

    # 重试目标 = 挂起未加入 ∪ 新候选；挂起的 entry 已在 held 里（重试只需查 PRTS，不再下载）
    all_names = sorted(set(held.keys()) | set(new_entries))

    additions = []
    still_held = {}
    if all_names:
        print(f"PRTS enrich {len(all_names)} 个: {all_names}")
        for i in range(0, len(all_names), WIKI_BATCH):
            batch = all_names[i:i + WIKI_BATCH]
            wikis = fetch_wikitext_batch(batch, wiki_opener)
            for title, text in wikis.items():
                if title not in all_names:
                    continue
                if title in new_entries:
                    entry = new_entries[title]
                else:
                    entry = held[title].get("entry")
                if entry is None:
                    continue
                apply_prts(entry, parse_wikitext(text))
            if i + WIKI_BATCH < len(all_names):
                time.sleep(WIKI_DELAY)

        # 逐个裁决
        for name in all_names:
            if name in new_entries:
                entry, attempts = new_entries[name], 0
            else:
                entry, attempts = held[name].get("entry"), held[name].get("attempts", 0)
            if entry is None:
                continue
            if is_complete(entry):
                additions.append(entry)
                print(f"  ✓ 完整可加入: {entry['name']}")
            else:
                attempts += 1
                if attempts >= MAX_HELD_ATTEMPTS:
                    additions.append(entry)
                    print(f"  ⚠ 挂起 {attempts} 次仍缺 race/gender，force-add: {entry['name']}"
                          f" (race={entry['race']}, gender={entry['gender']})")
                else:
                    still_held[name] = {"id": entry["id"], "name": entry["name"],
                                        "entry": entry, "attempts": attempts}
                    print(f"  … 挂起(第 {attempts} 次): {name} "
                          f"(缺 race={entry['race']=='未知'}, gender={entry['gender']=='未知'}); 下轮重试")

    # ---- 写文件 ----
    if additions:
        validate_entries(additions)
        additions.sort(key=lambda e: e["id"])
        if not apply_mode:
            print(f"\n[dry-run] 将新增 {len(additions)} 个干员到两个 roster 文件（仅追加，不重排）：")
            for e in additions:
                print_entry(e)
        else:
            data = []
            for path in ROSTER_PATHS:
                lst = load_roster(os.path.join(REPO_ROOT, path))
                data.append((path, lst))
            names_in = {c["name"] for _, lst in data for c in lst}
            real_adds = [e for e in additions if e["name"] not in names_in]
            for e in real_adds:
                for _, lst in data:
                    lst.append(e)
            for path, lst in data:
                write_roster(os.path.join(REPO_ROOT, path), lst)
            new_len = len(real_adds)
            print(f"✅ 已写入 {new_len} 个新干员（两文件字节一致）:")
            for e in real_adds:
                print_entry(e)
    else:
        print("无新干员可加入")

    # ---- 更新状态 ----
    if changed:
        state["seen"] = sha
    if not still_held:
        state["merged"] = sha
    if not apply_mode:
        print("\n[dry-run] 状态文件将更新: seen=", state.get("seen")[:7] if state.get("seen") else None,
              "merged=", state.get("merged")[:7] if state.get("merged") else None,
              "held=", {k: v["attempts"] for k, v in still_held.items()} or "{}")
        # dry-run 不落盘
        return 0

    # 真实落盘（apply）
    save_state(state)
    if still_held:
        save_held(still_held)
    elif held:
        if os.path.exists(os.path.join(REPO_ROOT, HELD_PATH)):
            os.remove(os.path.join(REPO_ROOT, HELD_PATH))
    return 0


def cmd_validate():
    """校验两份 roster 文件：字节一致 + 可解析 + 每条目 schema 合法。"""
    errors = []
    try:
        texts = [open(os.path.join(REPO_ROOT, p), encoding="utf-8").read() for p in ROSTER_PATHS]
    except OSError as e:
        print(f"✗ 读取失败: {e}")
        return 1
    if texts[0] != texts[1]:
        errors.append("server/characters.json 与 src/data/characters.json 字节不一致")
    parsed = []
    for p, t in zip(ROSTER_PATHS, texts):
        try:
            parsed.append(json.loads(t))
        except json.JSONDecodeError as e:
            errors.append(f"{p} 非法 JSON: {e}")
    if len(parsed) == 2:
        a, b = parsed
        if len(a) != len(b):
            errors.append("两份 roster 长度不同")
        names = [c.get("name") for c in a]
        if len(names) != len(set(names)):
            dup = sorted({n for n in names if names.count(n) > 1})
            errors.append(f"存在重复中文名: {dup}")
        for i, c in enumerate(a):
            miss = [f for f in REQUIRED_FIELDS if f not in c]
            if miss:
                errors.append(f"#{i} ({c.get('name')}) 缺字段: {miss}")
                break
            if c["popularity"] not in ("hot", "normal", "cold"):
                errors.append(f"{c['name']} popularity 非法: {c['popularity']}")
                break
            if not isinstance(c["rarity"], int) or not (1 <= c["rarity"] <= 6):
                errors.append(f"{c['name']} rarity 非法: {c['rarity']}")
                break
    if errors:
        for e in errors:
            print(f"✗ {e}")
        return 1
    print(f"✓ roster 校验通过（{len(parsed[0])} 个干员，两文件一致）")
    return 0


def cmd_wiki_test(name, wiki_opener):
    """演练：对单个干员跑 PRTS enrich 打印结果（不写任何文件）。"""
    entry = {"name": name}
    wikis = fetch_wikitext_batch([name], wiki_opener)
    if not wikis:
        print(f"✗ PRTS 未找到页面: {name}")
        return 1
    info = parse_wikitext(next(iter(wikis.values())))
    print(f"{name} → {info}")
    return 0


def main():
    ap = argparse.ArgumentParser(description="明日方舟干员数据自动同步")
    ap.add_argument("--check", action="store_true", help="只比较 seen 与上游 sha")
    ap.add_argument("--apply", action="store_true", help="完整执行并写文件")
    ap.add_argument("--dry-run", action="store_true", help="只计算不写")
    ap.add_argument("--validate", action="store_true", help="校验两份 roster 文件一致性")
    ap.add_argument("--wiki-test", metavar="NAME", help="PRTS enrich 演练（单干员）")
    ap.add_argument("--proxy", help="GitHub 代理 http://host:port")
    ap.add_argument("--wiki-proxy", help="PRTS wiki 代理 http://host:port")
    args = ap.parse_args()

    if args.validate:
        sys.exit(cmd_validate())
    if args.wiki_test:
        sys.exit(cmd_wiki_test(args.wiki_test, build_opener(args.wiki_proxy)))

    opener = build_opener(args.proxy)
    wiki_opener = build_opener(args.wiki_proxy)

    if args.check:
        state = load_state()
        sha, _ = get_upstream_meta(opener)
        if not sha:
            sys.exit(2)
        if sha == state.get("seen"):
            print(f"✓ 上游无更新 (seen={sha[:7]})")
            sys.exit(0)
        print(f"上游有更新: seen={str(state.get('seen'))[:7] or 'None'} → {sha[:7]}")
        sys.exit(1)

    if not args.apply and not args.dry_run:
        ap.print_help()
        sys.exit(2)

    code = run_sync(opener, wiki_opener, apply_mode=args.apply)
    sys.exit(code)


if __name__ == "__main__":
    main()
