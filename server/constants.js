// 共享常量：干员属性规范顺序 + 自定义房间单局时间档位
// （与前端 myColorsRef / colLabels 顺序一致，见 src/app/multiplayer/page.tsx）
export const ATTR_KEYS = ['class', 'subclass', 'faction', 'rarity', 'race', 'gender', 'releaseYear', 'position', 'tags'];
export const ROUND_TIME = 120_000;
export const ROUND_TIME_PRESETS = [30000, 60000, 90000, 120000, 180000, 300000];
