'use client';

import { ALL_ATTR_KEYS, PARTY_ATTR_KEYS, ATTR_LABEL_KEYS } from '@/lib/party-constants';

/** PARTY_ATTR_KEYS 是 readonly 元组，`.includes(string)` 过不了类型；用 Set 免掉 cast */
const STANDARD_KEYS = new Set<string>(PARTY_ATTR_KEYS);

/**
 * 词条多选 chips —— **单人自建房（`/game`）与派对房（`Lobby`）共用**这一份实现。
 *
 * ⚠️ 多人自建房（`multiplayer/page.tsx`）**没有**接进来，那里仍是内联的一份副本。
 *    原因不是懒：它的 `customAttrs` 恒为数组（默认 `['class','faction','rarity']`），
 *    压根没有本组件「`null` = 标准九列」这一档，语义对不上，硬套要先改它的默认值。
 *    代价是画师 chip 在两处各写了一遍 —— 改词条清单时要**同时**看这两处。
 *
 * 视觉类名沿用派对房原有的 cfg-row / cfg-lb / cfg-hint / cfg-ct / tchip，
 * 不新造形态（含 disabled 态与「重置为标准」按钮的位置）。
 *
 * ⚠️ `attributes === null` 表示**标准词条** = `PARTY_ATTR_KEYS`（九项，**不含画师**）。
 * 画师属于 `OPTIONAL_ATTR_KEYS`，只有自建房能选，且默认关闭。
 * 因此标准态下画师 chip 必须是「灭」的 —— 不能图省事写成
 * `isStandard || attributes.includes(a)`，那会让画师亮着却没生效（假亮）。
 */
export function AttrChips({
  attributes, onChange, disabled, t,
}: {
  /** null = 标准九列；数组 = 自定义所选（可为空数组，调用方需自行拦住 0 项开局） */
  attributes: string[] | null;
  onChange: (attrs: string[] | null) => void;
  disabled?: boolean;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const isStandard = attributes === null;

  const toggle = (a: string) => {
    if (disabled) return;
    if (isStandard) {
      // 标准 → 自定义：
      //  · 标准词条（在 PARTY_ATTR_KEYS 里）→ 从标准九项里移掉它
      //  · 可选词条（画师）→ 加进标准九项（标准态下它本来是关的）
      onChange(STANDARD_KEYS.has(a)
        ? PARTY_ATTR_KEYS.filter(k => k !== a)
        : [...PARTY_ATTR_KEYS, a]);
    } else if (attributes.includes(a)) {
      onChange(attributes.filter(k => k !== a));
    } else {
      onChange([...attributes, a]);
    }
  };

  return (
    <div className="cfg-row">
      <span className="cfg-lb">
        {t('party.attributes')}:
      </span>
      <span className="cfg-hint">
        {isStandard
          ? t('attr.standardCount', { n: PARTY_ATTR_KEYS.length })
          : `${attributes.length}/${ALL_ATTR_KEYS.length}`}
      </span>
      <div className="cfg-ct">
        {ALL_ATTR_KEYS.map(a => {
          const on = isStandard ? STANDARD_KEYS.has(a) : attributes.includes(a);
          return (
            <button
              key={a}
              type="button"
              disabled={disabled}
              onClick={() => toggle(a)}
              className={on ? 'tchip on' : 'tchip off'}
            >
              {t(ATTR_LABEL_KEYS[a])}
            </button>
          );
        })}
      </div>
      {!isStandard && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange(null)}
          className="btn-o btn-sm mt-1.5"
        >
          {t('party.resetStandard')}
        </button>
      )}
    </div>
  );
}
