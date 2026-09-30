import { pinyin } from 'pinyin-pro';
import type { GuessStatus } from '../types/character';
import type { QuestionField } from './turtle-engine';

/**
 * 海龟汤的**展示词汇**（键名与类名，不含译文）—— 提问面板与提问记录共用一份。
 *
 * 单独成文件而不是塞进 `turtle-engine.ts`：那个模块是**纯判定**，被
 * `tests/_ts-load.mjs` 直接加载做确定性测试（不碰 DOM、不碰 CSS、不碰 i18n）。
 * 这里全是表现层映射，混进去会让「纯逻辑」这条边界糊掉。
 */

/** 维度的中文名直接复用干员表的列名，不另建一套 —— table.* 已有全部 9 个键 */
export const FIELD_LABEL_KEY: Record<QuestionField, string> = {
  class: 'table.class',
  subclass: 'table.subclass',
  faction: 'table.faction',
  rarity: 'table.rarity',
  race: 'table.race',
  gender: 'table.gender',
  releaseYear: 'table.year',
  position: 'table.position',
  tags: 'table.tags',
};

/** 三级反馈 → 徽标类。.bdg-* 是**独立**样式（不依赖 .guess-table），可直接用 */
export const LEVEL_CLASS: Record<GuessStatus, string> = {
  correct: 'bdg bdg-ok',
  close: 'bdg bdg-warn',
  wrong: 'bdg bdg-no',
};
export const LEVEL_KEY: Record<GuessStatus, string> = {
  correct: 'turtle.levelCorrect',
  close: 'turtle.levelClose',
  wrong: 'turtle.levelWrong',
};

/**
 * 取值 → 展示文本。**提问面板的 chip 与提问记录必须共用它**，
 * 否则同一个取值在两处长得不一样（记录里写 6、面板上画六颗星）。
 *
 * 只有星级需要特殊化：全站（`GameSearch` 的 `formatRarity`、猜测表的星级列）
 * 都用「实心★ + 空心☆ 凑满 6 颗」这一种记号表示星级，这里跟着用同一种。
 * 其余维度原样输出。
 *
 * ⚠️ `6 - n` 必须夹住下界：数据若出现 7★（上游加了新星级），`'☆'.repeat(-1)`
 *    会抛 RangeError 把整页打挂 —— 一个纯展示函数不该有这种杀伤力。
 */
export function formatOption(field: QuestionField, value: string | number): string {
  if (field === 'rarity') {
    const n = Number(value);
    if (!Number.isFinite(n)) return String(value);
    return '★'.repeat(Math.max(0, n)) + '☆'.repeat(Math.max(0, 6 - n));
  }
  return String(value);
}

/**
 * 取值的中文拼音检索串 —— 只给大字集（种族 / 阵营 / 子职业）的筛选框用。
 *
 * 拼成「原名 + 全拼 + 首字母」一整串，匹配就退化成一次 `includes`：
 *   近卫 → "近卫jinweijw"，于是 `近卫` / `jinwei` / `jw` 三种输入都能命中。
 *
 * ⚠️ 和 `GameSearch` 里的拼音索引**不是**同一份，不能共用：那边的键是 `Character`
 *    并且按分数排序（精确 > 前缀 > 包含），这里的键是一个取值字符串、只做布尔过滤。
 *    相同的只有 `pinyin-pro` 这一个依赖。
 *
 * 模块级 Map 缓存：取值域最多 72 项、进程内不变，不值得每敲一个字重算一遍。
 */
const searchIndexCache = new Map<string, string>();

export function valueSearchIndex(value: string): string {
  let idx = searchIndexCache.get(value);
  if (idx === undefined) {
    const parts = pinyin(value, { toneType: 'none', type: 'array' });
    idx = (value + parts.join('') + parts.map(s => s[0]).join('')).toLowerCase();
    searchIndexCache.set(value, idx);
  }
  return idx;
}
