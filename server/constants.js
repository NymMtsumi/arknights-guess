// 共享常量：干员属性规范顺序 + 自定义房间单局时间档位
// （与前端 myColorsRef / colLabels 顺序一致，见 src/app/multiplayer/page.tsx）
// ⚠️ ATTR_KEYS 是「标准房」的词条集，也是与前端 PARTY_ATTR_KEYS 的契约 —— 一行都别动。
//    画师是**可选**词条：只允许出现在自定义房里，标准房永远拿不到（靠下面的派生常量保证）。
export const ATTR_KEYS = ['class', 'subclass', 'faction', 'rarity', 'race', 'gender', 'releaseYear', 'position', 'tags'];
export const OPTIONAL_ATTR_KEYS = ['artist'];
// 接受玩家提交词条时的白名单（自定义房可含画师）
export const ALL_ATTR_KEYS = [...ATTR_KEYS, ...OPTIONAL_ATTR_KEYS];
// ⚠️ 顺序必须与前端 ALL_ATTR_KEYS 一致：colorRows 是**定长位置数组**，
//    artist 固定占下标 10；顺序错了整块对手棋盘会错位。
export const ROUND_TIME = 120_000;
export const ROUND_TIME_PRESETS = [30000, 60000, 90000, 120000, 180000, 300000];
