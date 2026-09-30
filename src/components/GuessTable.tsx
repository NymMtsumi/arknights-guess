'use client';

import { useRef, useMemo } from 'react';
import type { Character, GuessResult, GuessStatus } from '@/types/character';
import { isAlterRelation } from '@/lib/game-engine';
import { useI18n } from '@/lib/i18n';
import { PARTY_ATTR_KEYS as ATTR_KEYS, ATTR_LABEL_KEYS } from '@/lib/party-constants';
import { ScrollSlider } from './ScrollSlider';

interface GuessTableProps {
  guesses: GuessResult[];
  target: Character | null;
  hideRarity?: boolean;
  /** 自定义房：指定要展示的属性列（ATTR_KEYS 子集，规范顺序）。为数组时覆盖 hideRarity 逻辑 */
  displayAttributes?: string[] | null;
  /** 每次递增强制猜对行重新挂载，重新播放闪烁动画 */
  flashTrigger?: number;
  /** 每次猜中递增，强制最新非胜行重新挂载以重播逐格揭示 */
  staggerKey?: number;
}

/** 比较结果 → V12 语义格类（正确 / 接近 / 失准），配色由 .gcell.ok/.warn/.no 提供 */
const STATUS_CLASS: Record<GuessStatus, string> = {
  correct: 'ok',
  close: 'warn',
  wrong: 'no',
};

/** 走 .gcell.num 的等宽数字列（设计稿 index-v12-game.html:812/815） */
const NUMERIC_COLS = new Set(['rarity', 'releaseYear']);

function StatusCell({ status, children, width, numeric, extraStyle }: { status: GuessStatus; children: React.ReactNode; width?: string; numeric?: boolean; extraStyle?: React.CSSProperties }) {
  return (
    <td style={{ width: width || undefined, ...extraStyle }}>
      <div className={`gcell ${STATUS_CLASS[status] || 'no'}${numeric ? ' num' : ''}`}>{children}</div>
    </td>
  );
}

/**
 * 估算文本渲染宽度（像素）
 * 中文字符 ≈ 14px，英文/数字 ≈ 8px，空格 ≈ 4px
 * 在 0.9rem (≈14.4px) 字体下实测接近
 */
function estimateTextWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    if (ch === ' ') { w += 4; }
    else if (/[一-鿿　-〿＀-￯★]/.test(ch)) { w += 14; }
    else { w += 8; }
  }
  return w;
}

/** 列定义 + 文本提取 */
interface ColDef {
  key: string;
  label: string;
  getText: (c: Character) => string;
}

// 属性列规范顺序（单一事实来源 party-constants，与 server/constants.js ATTR_KEYS 一致）

function buildColumns(t: (k: string) => string, hideRarity: boolean, displayAttributes?: string[] | null): ColDef[] {
  const nameCol: ColDef = { key: 'name', label: t('table.name'), getText: (c) => c.name };
  const attrCols: Record<string, ColDef> = {
    class: { key: 'class', label: t(ATTR_LABEL_KEYS.class), getText: (c) => c.class },
    subclass: { key: 'subclass', label: t(ATTR_LABEL_KEYS.subclass), getText: (c) => c.subclass },
    faction: { key: 'faction', label: t(ATTR_LABEL_KEYS.faction), getText: (c) => c.faction },
    rarity: { key: 'rarity', label: t(ATTR_LABEL_KEYS.rarity), getText: (c) => '★'.repeat(c.rarity) },
    race: { key: 'race', label: t(ATTR_LABEL_KEYS.race), getText: (c) => c.race },
    gender: { key: 'gender', label: t(ATTR_LABEL_KEYS.gender), getText: (c) => c.gender },
    releaseYear: { key: 'releaseYear', label: t(ATTR_LABEL_KEYS.releaseYear), getText: (c) => c.releaseYear ? String(c.releaseYear) : '?' },
    position: { key: 'position', label: t(ATTR_LABEL_KEYS.position), getText: (c) => c.position || '?' },
    tags: { key: 'tags', label: t(ATTR_LABEL_KEYS.tags), getText: (c) => (c.tags || []).join(' ') || '-' },
    // 画师：可选词条，只有 displayAttributes 显式含 'artist' 时才会被渲染（自建房）。
    // 经典房走下面的 ATTR_KEYS 分支，结构性拿不到这一列。
    artist: { key: 'artist', label: t(ATTR_LABEL_KEYS.artist), getText: (c) => c.artist || '?' },
  };

  // 自定义房：只展示名字 + 所选属性
  if (displayAttributes && displayAttributes.length > 0) {
    return [nameCol, ...displayAttributes.filter(a => attrCols[a]).map(a => attrCols[a])];
  }
  // 标准房：全部 9 项（hard 隐藏 rarity）
  return [nameCol, ...ATTR_KEYS.filter(a => !(hideRarity && a === 'rarity')).map(a => attrCols[a])];
}

/** 扫描所有猜测数据，计算每列所需的最小像素宽度 */
function computeColumnWidths(guesses: GuessResult[], target: Character | null, hideRarity: boolean, displayAttributes: string[] | null | undefined, t: (k: string) => string): number[] {
  const columns = buildColumns(t, hideRarity, displayAttributes);
  // 确保表头宽度也被考虑
  const widths = columns.map(col => estimateTextWidth(col.label) + 28); // padding 12+12 + 4 buffer

  for (const g of guesses) {
    for (let i = 0; i < columns.length; i++) {
      const textW = estimateTextWidth(columns[i].getText(g.character));
      const cellW = textW + 28; // left+right padding 12px each + 4px buffer
      if (cellW > widths[i]) widths[i] = cellW;
    }
  }
  // 也考虑 target（如果已揭晓）
  if (target) {
    for (let i = 0; i < columns.length; i++) {
      const textW = estimateTextWidth(columns[i].getText(target));
      const cellW = textW + 28;
      if (cellW > widths[i]) widths[i] = cellW;
    }
  }
  return widths;
}

export function GuessTable({ guesses, target, hideRarity, displayAttributes, flashTrigger, staggerKey }: GuessTableProps) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);

  // 动态测量列宽：扫描所有数据后计算精确像素宽度
  const colWidths = useMemo(
    () => computeColumnWidths(guesses, target, !!hideRarity, displayAttributes, t),
    [guesses, target, hideRarity, displayAttributes, t]
  );

  if (guesses.length === 0) return null;

  const columns = buildColumns(t, !!hideRarity, displayAttributes);
  const totalWidth = colWidths.reduce((a: number, b: number) => a + b, 0);
  // 像素宽度 → 百分比（总和 100%），配合 width:100% 表格居中且列宽精确不偏移
  const colPcts = colWidths.map((w: number) => `${(w / totalWidth) * 100}%`);

  return (
    <div>
      <div
        ref={scrollRef}
        style={{ scrollBehavior: 'smooth' }}
        className="table-wrap scroll-slider-container"
      >
      {/* ⚠️ `game-table` 不是样式类，是**测试契约**：tests/solo-smoke.mjs:59,61 与
          tests/multiplayer-smoke.mjs:85,125 用它定位这张表。V12 的语义类是
          `.guess-table`，但契约类必须一起留着 —— 改名会让部署 gate 直接失败。 */}
      <table className="guess-table game-table op" style={{ width: '100%', tableLayout: 'fixed', minWidth: `${totalWidth}px` }}>
        <thead>
          <tr>
            {columns.map((col, i) => (
              <th key={col.key} className="zh" style={{ width: colPcts[i] }}>
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...guesses].reverse().map((guess, i) => {
            const alterMatch = guess.isAlter === true || (target && isAlterRelation(target, guess.character));
            const isWinner = guess.correct === true || (target ? guess.character.id === target.id : false);
            const isNewest = i === 0;
            const needsStagger = isWinner || isNewest;
            const rowClass = isWinner ? 'guess-row-winner' : isNewest ? 'guess-row-newest' : '';
            const rowKey = isWinner
              ? `winner-${guess.timestamp}-${flashTrigger ?? 0}`
              : isNewest
                ? `newest-${guess.timestamp}-${staggerKey ?? 0}`
                : String(guess.timestamp);
            return (
              <tr key={rowKey} className={rowClass}>
                {columns.map((col, colIdx) => {
                  const cellStyle: React.CSSProperties = needsStagger
                    ? { animationDelay: `${colIdx * 0.06}s` }
                    : {};
                  if (col.key === 'name') {
                    const isCorrect = guess.correct === true || (target && guess.character.id === target.id);
                    const nameClass = isCorrect ? 'gcell ok' : alterMatch ? 'gcell warn' : 'gcell name';
                    return (
                      <td key={col.key} style={{ width: colPcts[colIdx], ...cellStyle }}>
                        <div className={nameClass}>{col.getText(guess.character)}</div>
                      </td>
                    );
                  }
                  // 其余列通过比较结果显示颜色。
                  // ⚠️ 键不在 comparisons 里时**必须渲染一个占位格**，不能 return null：
                  //    表头来自同一个 `columns` 数组，少一个 <td> 会让这一行比表头短一格、
                  //    后面的列整排左移错位 —— 不是渲染成空白。属潜在风险（服务端两条路径
                  //    socket/game.js 与 socket/party-game.js 恒带全部列），但 artist 现在
                  //    是**可选**键，多一处兜底就少一次错位。兜底取 'wrong'，与 multiplayer
                  //    的 rowToComparisons 对 undefined 的兜底一致。
                  //    原先这里还有个 `guess.comparisons &&` —— 类型上 comparisons 必填，
                  //    是恒真的死分支，去掉以免被误读成「可能为空」。
                  const statusKey = col.key as keyof GuessResult['comparisons'];
                  const status = statusKey in guess.comparisons
                    ? (guess.comparisons[statusKey] as GuessStatus)
                    : 'wrong';
                  return (
                    <StatusCell key={col.key} status={status} width={colPcts[colIdx]} numeric={NUMERIC_COLS.has(col.key)} extraStyle={cellStyle}>
                      {col.getText(guess.character)}
                    </StatusCell>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
      <ScrollSlider containerRef={scrollRef} />
    </div>
  );
}
