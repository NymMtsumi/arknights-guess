// 派对模式 / 自定义房 — 前端共享常量
// 词条列顺序必须与 server/constants.js 的 ATTR_KEYS 完全一致（单一事实来源，避免前后端契约漂移）

/**
 * 标准词条：九个默认对比维度。
 *
 * ⚠️ **这个数组是「经典房间不用画师」的结构性保证** ——
 *    标准房（经典单人 / 每日 / 多人）渲染列时走 `PARTY_ATTR_KEYS`，
 *    所以只要 artist 不在这个数组里，它就永远不会出现在经典房间里。
 *    可选词条请加到下面的 OPTIONAL_ATTR_KEYS，**不要**往这里塞。
 */
export const PARTY_ATTR_KEYS = ['class', 'subclass', 'faction', 'rarity', 'race', 'gender', 'releaseYear', 'position', 'tags'] as const;
export type PartyAttrKey = typeof PARTY_ATTR_KEYS[number];

/**
 * 可选词条：**只**出现在自建房（单人自建 / 多人自建）的词条选择里，默认不启用。
 * 与服务端 server/constants.js 的 OPTIONAL_ATTR_KEYS 对应。
 */
export const OPTIONAL_ATTR_KEYS = ['artist'] as const;
export type OptionalAttrKey = typeof OPTIONAL_ATTR_KEYS[number];

/** 自建房允许被选中的全部词条 = 标准 + 可选。服务端的白名单用这个。 */
export const ALL_ATTR_KEYS = [...PARTY_ATTR_KEYS, ...OPTIONAL_ATTR_KEYS];

/**
 * 词条 → i18n 键（单一事实源）。
 *
 * ⚠️ 注意 `releaseYear` 映射到 `table.year`（不是 table.releaseYear）——
 *    这是历史命名，两侧 JSON 里就是这么写的。
 * ⚠️ stats 页不走这张表：它用模板字面量 ``t(`table.${a === 'releaseYear' ? 'year' : a}`)``，
 *    所以新增词条时**不需要**改那里（模板前缀已被 i18n 哨兵登记为动态覆盖）。
 */
export const ATTR_LABEL_KEYS: Record<string, string> = {
  class: 'table.class',
  subclass: 'table.subclass',
  faction: 'table.faction',
  rarity: 'table.rarity',
  race: 'table.race',
  gender: 'table.gender',
  releaseYear: 'table.year',
  position: 'table.position',
  tags: 'table.tags',
  artist: 'table.artist',
};

export const PARTY_MIN_PLAYERS = 3;
export const PARTY_MAX_PLAYERS = 8;
export const PARTY_MAX_GUESSES = 8;
