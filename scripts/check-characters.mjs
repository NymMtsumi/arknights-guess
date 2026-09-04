#!/usr/bin/env node
// 干员 roster 一致性 gate（本地 + CI 共用）
//  1) server/characters.json 与 src/data/characters.json 必须字节一致
//  2) 两份都能被 JSON 解析，长度一致
//  3) 每条目 20 字段齐全；popularity 枚举合法；rarity 为 1..6 整数
//  4) 无重复中文名（游戏按 name 匹配，重复会破坏匹配/每日挑战）
//
// 用法: node scripts/check-characters.mjs     （退出码 0=通过 / 1=失败）
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PATHS = ['server/characters.json', 'src/data/characters.json'];
const POPULARITY = new Set(['hot', 'normal', 'cold']);
const REQUIRED = [
  'id', 'name', 'nameEn', 'class', 'classEn', 'subclass', 'subclassEn',
  'faction', 'factionEn', 'rarity', 'race', 'raceEn', 'gender', 'genderEn',
  'popularity', 'releaseYear', 'tags', 'alterBase', 'position', 'positionEn',
];

const errors = [];
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const texts = PATHS.map(read);
if (texts[0] !== texts[1]) {
  errors.push('server/characters.json 与 src/data/characters.json 字节不一致');
}

const lists = [];
for (let i = 0; i < PATHS.length; i++) {
  try {
    lists.push(JSON.parse(texts[i]));
  } catch (e) {
    errors.push(`${PATHS[i]} 非法 JSON: ${e.message}`);
  }
}

if (lists.length === 2) {
  const [a, b] = lists;
  if (a.length !== b.length) errors.push(`两份 roster 长度不同: ${a.length} vs ${b.length}`);

  const seen = new Set();
  for (let i = 0; i < a.length; i++) {
    const c = a[i];
    const label = c?.name ?? `#${i}`;
    if (!c || typeof c !== 'object') { errors.push(`#${i} 不是对象`); break; }
    const missing = REQUIRED.filter((f) => !(f in c));
    if (missing.length) { errors.push(`${label} 缺字段: ${missing.join(',')}`); break; }
    if (!c.name || !c.nameEn) { errors.push(`${label} name/nameEn 为空`); break; }
    if (seen.has(c.name)) { errors.push(`重复中文名: ${c.name}`); break; }
    seen.add(c.name);
    if (!POPULARITY.has(c.popularity)) { errors.push(`${label} popularity 非法: ${c.popularity}`); break; }
    if (!Number.isInteger(c.rarity) || c.rarity < 1 || c.rarity > 6) {
      errors.push(`${label} rarity 非法: ${c.rarity}`); break;
    }
    if (!Number.isInteger(c.releaseYear) || c.releaseYear < 0) {
      errors.push(`${label} releaseYear 非法: ${c.releaseYear}`); break;
    }
    if (!Array.isArray(c.tags) || c.tags.some((t) => typeof t !== 'string')) {
      errors.push(`${label} tags 非法`); break;
    }
  }
}

if (errors.length) {
  for (const e of errors) console.error(`✗ ${e}`);
  process.exit(1);
}
console.log(`✓ 干员数据一致（${lists[0]?.length ?? '?'} 个干员，两文件字节相同）`);
