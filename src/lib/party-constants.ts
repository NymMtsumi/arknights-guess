// 派对模式 — 前端共享常量
// 词条列顺序必须与 server/constants.js 的 ATTR_KEYS 完全一致（单一事实来源，避免前后端契约漂移）

export const PARTY_ATTR_KEYS = ['class', 'subclass', 'faction', 'rarity', 'race', 'gender', 'releaseYear', 'position', 'tags'] as const;
export type PartyAttrKey = typeof PARTY_ATTR_KEYS[number];

export const PARTY_MIN_PLAYERS = 3;
export const PARTY_MAX_PLAYERS = 8;
export const PARTY_MAX_GUESSES = 8;
