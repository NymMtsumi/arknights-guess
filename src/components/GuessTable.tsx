'use client';

import { useRef, useMemo } from 'react';
import type { Character, GuessResult, GuessStatus } from '@/types/character';
import { isAlterRelation } from '@/lib/game-engine';
import { useI18n } from '@/lib/i18n';
import { PARTY_ATTR_KEYS as ATTR_KEYS } from '@/lib/party-constants';
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

function StatusCell({ status, children, width, extraStyle }: { status: GuessStatus; children: React.ReactNode; width?: string; extraStyle?: React.CSSProperties }) {
  return (
    <td
      style={{
        width: width || undefined,
        background: `var(--${status})`,
        color: status === 'wrong' ? 'var(--text-light)' : '#fff',
        fontWeight: status !== 'wrong' ? 700 : 400,
        padding: '10px 12px',
        textAlign: 'center',
        fontSize: '0.9rem',
        whiteSpace: 'nowrap',
        transition: 'background 0.25s',
        ...extraStyle,
      }}
    >
      {children}
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
    class: { key: 'class', label: t('table.class'), getText: (c) => c.class },
    subclass: { key: 'subclass', label: t('table.subclass'), getText: (c) => c.subclass },
    faction: { key: 'faction', label: t('table.faction'), getText: (c) => c.faction },
    rarity: { key: 'rarity', label: t('table.rarity'), getText: (c) => '★'.repeat(c.rarity) },
    race: { key: 'race', label: t('table.race'), getText: (c) => c.race },
    gender: { key: 'gender', label: t('table.gender'), getText: (c) => c.gender },
    releaseYear: { key: 'releaseYear', label: t('table.year'), getText: (c) => c.releaseYear ? String(c.releaseYear) : '?' },
    position: { key: 'position', label: t('table.position'), getText: (c) => c.position || '?' },
    tags: { key: 'tags', label: t('table.tags'), getText: (c) => (c.tags || []).join(' ') || '-' },
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
        style={{
          overflowX: 'auto',
          marginBottom: '0',
          scrollBehavior: 'smooth',
        }}
        className="scroll-slider-container"
      >
      <table className="game-table" style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: '0.9rem', minWidth: `${totalWidth}px` }}>
        <thead>
          <tr>
            {columns.map((col, i) => (
              <th key={col.key} style={{
                width: colPcts[i],
                padding: '10px 12px', textAlign: 'center', fontWeight: 700,
                fontSize: '0.82rem', textTransform: 'uppercase', letterSpacing: '0.05em',
                color: 'var(--text-light)', borderBottom: '2px solid var(--border)', whiteSpace: 'nowrap',
              }}>
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
                    if (isCorrect) {
                      return (
                        <td key={col.key} style={{
                          width: colPcts[colIdx],
                          padding: '10px 12px', textAlign: 'center', fontWeight: 700,
                          fontSize: '0.9rem', whiteSpace: 'nowrap',
                          color: '#fff', background: 'var(--correct)',
                          ...cellStyle,
                        }}>
                          {col.getText(guess.character)}
                        </td>
                      );
                    }
                    if (alterMatch) {
                      return (
                        <td key={col.key} style={{
                          width: colPcts[colIdx],
                          padding: '10px 12px', textAlign: 'center', fontWeight: 700,
                          fontSize: '0.9rem', whiteSpace: 'nowrap',
                          color: '#fff', background: 'var(--close)',
                          ...cellStyle,
                        }}>
                          {col.getText(guess.character)}
                        </td>
                      );
                    }
                    return (
                      <td key={col.key} style={{
                        width: colPcts[colIdx],
                        padding: '10px 12px', textAlign: 'center', fontWeight: 700,
                        color: 'var(--text)', fontSize: '0.9rem', whiteSpace: 'nowrap',
                        ...cellStyle,
                      }}>
                        {col.getText(guess.character)}
                      </td>
                    );
                  }
                  // 其余列通过比较结果显示颜色
                  const statusKey = col.key as keyof GuessResult['comparisons'];
                  if (guess.comparisons && statusKey in guess.comparisons) {
                    return (
                      <StatusCell key={col.key} status={guess.comparisons[statusKey] as GuessStatus} width={colPcts[colIdx]} extraStyle={cellStyle}>
                        {col.getText(guess.character)}
                      </StatusCell>
                    );
                  }
                  return null;
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      <style>{`
        html[data-theme="blast"] .game-table tr { border-color: rgba(255,255,255,0.1); background: #190c15; }
        html[data-theme="blast"] .game-table td:first-child { background: #2a1723; }
        html:not([data-theme="blast"]) .game-table tr { background: var(--card); border-bottom: 1px solid var(--border); }
        .game-table td { border: 1px solid var(--border); border-radius: 3px; }
        @media (max-width: 640px) { .game-table td, .game-table th { padding: 8px 4px; font-size: 0.75rem; } }
      `}</style>
      </div>
      <ScrollSlider containerRef={scrollRef} />
    </div>
  );
}
