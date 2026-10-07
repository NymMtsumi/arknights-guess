/**
 * 平局 / 超时插图的取图序号（`public/icons/draw-1..5.png`）。
 *
 * ⚠️ 用哈希而不是 `Math.random()`：调用点全都在 **render 里**，随机数会在任何一次
 *    重渲染时换图 —— 而局内计时器每 100ms `setState` 一次，表现就是疯狂闪烁。
 *    以「目标名 + 比分 + 服务端给的 reason」为种 → 同一局恒定，不同局大概率不同。
 *
 * ⚠️ `reason` 只有超时那一支才有（`server/socket/game.js:55` 发 `'timeout'`），
 *    其余平局分支不发该字段，所以必须容忍 `undefined`。
 *
 * 两个调用方（多人页 `roundEnd` 横幅、人机页 `roundEnd` 横幅）必须**取到同一张**，
 * 否则同一个「超时」在两种模式里长得不一样。这也是它被提到 lib 来的原因 ——
 * 需求⑤要的是两页视觉一致，两份手抄副本迟早会漂。
 */
export function drawArtIndex(d: { targetName?: string; score?: string | number; reason?: string }): number {
  const seed = `${d.targetName ?? ''}|${d.score ?? 0}|${d.reason ?? ''}`;
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 5 + 1;
}
