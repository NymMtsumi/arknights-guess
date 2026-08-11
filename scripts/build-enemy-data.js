/**
 * 敌方单位数据抓取与清洗脚本
 *
 * 数据源：PRTS wiki — https://prts.wiki/index.php?title=敌人一览/数据&action=raw&ctype=application/json
 *
 * 输出：
 *   server/enemy-characters.json   — 后端加载
 *   src/data/enemy-characters.json — 前端打包
 *
 * 用法：
 *   node scripts/build-enemy-data.js              # 从 PRTS 在线拉取
 *   node scripts/build-enemy-data.js --local      # 使用本地 scripts/enemy_data.json
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// 种类重新分组 → 提升区分度（原始 62% 集中在"其他"）
const RACE_GROUP_MAP = {
  '感染生物': '感染生物',
  '宿主': '感染生物',
  '萨卡兹': '萨卡兹',
  '坍缩体': '萨卡兹',
  '无人机': '机械体',
  '机械': '机械体',
  '化物': '造物',
  '源石造物': '造物',
  '法术造物': '造物',
  '海怪': '海怪',
  '野生动物': '野生动物',
  '其他': '其他',
};

// 评级序列（用于游戏引擎的"相邻=黄色"判断）
const RATING_ORDER = ['SS', 'S+', 'S', 'A+', 'A', 'B+', 'B', 'C', 'D', 'E'];

// 地位全称 → 简称（前端显示用）
const LEVEL_SHORT = {
  '普通': '普通',
  '精英': '精英',
  '领袖': '领袖',
};

/**
 * 去除 HTML 标签，提取纯文本
 */
function stripHtml(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .replace(/<br\s*\/?>/gi, ' · ')
    .replace(/<li>/gi, ' · ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * 文件名安全化（头像 URL 用）
 */
function safeFileName(name) {
  return encodeURIComponent(name);
}

function transformEnemy(raw) {
  const raceRaw = raw.enemyRace || '其他';
  const ability = stripHtml(raw.ability);

  return {
    // 基础标识
    id: raw.sortId || 0,
    name: raw.name || '',
    // 英文名暂缺，后续从游戏数据补充
    nameEn: '',

    // 种类（原始 + 分组）
    race: RACE_GROUP_MAP[raceRaw] || '其他',
    raceRaw,

    // 地位
    level: raw.enemyLevel || '普通',

    // 攻击 & 伤害
    attackType: raw.attackType || '近战',
    damageType: raw.damageType || '物理',

    // 行动方式（简化：地面/飞行/未知）
    motion: raw.motion || '地面',

    // 六维评级
    endure: raw.endure || 'E',
    attack: raw.attack || 'E',
    defence: raw.defence || 'E',
    moveSpeed: raw.moveSpeed || 'E',
    attackSpeed: raw.attackSpeed || 'E',
    resistance: raw.resistance || 'E',

    // 能力描述
    ability,

    // 头像 & 链接
    assetName: safeFileName(raw.name),
    wikiUrl: raw.enemyLink || '',

    // 难度过滤用
    isBoss: raw.enemyLevel === '领袖',
    isElite: raw.enemyLevel === '精英',
  };
}

async function main() {
  const useLocal = process.argv.includes('--local');
  let rawData;

  if (useLocal) {
    console.log('[enemy-data] Loading local data...');
    const localPath = resolve(ROOT, 'scripts', 'enemy_data.json');
    rawData = JSON.parse(readFileSync(localPath, 'utf-8'));
  } else {
    console.log('[enemy-data] Fetching from PRTS API...');
    const url = 'https://prts.wiki/index.php?title=%E6%95%8C%E4%BA%BA%E4%B8%80%E8%A7%88/%E6%95%B0%E6%8D%AE&action=raw&ctype=application/json';
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    rawData = await resp.json();
  }

  if (!Array.isArray(rawData)) {
    throw new Error(`Expected array, got ${typeof rawData}`);
  }

  console.log(`[enemy-data] Loaded ${rawData.length} raw entries`);

  // 清洗 & 转换
  const enemies = rawData
    .map(transformEnemy)
    .sort((a, b) => a.id - b.id);

  // 去重（按 name + level 组合键）
  const seen = new Set();
  const deduped = enemies.filter(e => {
    const key = `${e.name}||${e.level}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`[enemy-data] After dedup: ${deduped.length} entries`);

  // 统计
  const raceDist = {};
  const levelDist = {};
  for (const e of deduped) {
    raceDist[e.race] = (raceDist[e.race] || 0) + 1;
    levelDist[e.level] = (levelDist[e.level] || 0) + 1;
  }
  console.log('[enemy-data] Race distribution:', raceDist);
  console.log('[enemy-data] Level distribution:', levelDist);

  // 输出 JSON
  const payload = JSON.stringify(deduped, null, 2);

  const serverPath = resolve(ROOT, 'server', 'enemy-characters.json');
  writeFileSync(serverPath, payload, 'utf-8');
  console.log(`[enemy-data] Written ${deduped.length} enemies → server/enemy-characters.json`);

  const clientPath = resolve(ROOT, 'src', 'data', 'enemy-characters.json');
  writeFileSync(clientPath, payload, 'utf-8');
  console.log(`[enemy-data] Written ${deduped.length} enemies → src/data/enemy-characters.json`);

  // 同时打印评级顺序（供游戏引擎参考）
  console.log('[enemy-data] Rating order:', RATING_ORDER.join(' > '));
}

main().catch(err => {
  console.error('[enemy-data] Fatal:', err);
  process.exit(1);
});
