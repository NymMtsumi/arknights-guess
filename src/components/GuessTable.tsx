'use client';

import { useRef } from 'react';
import type { Character, GuessResult, GuessStatus } from '@/types/character';
import { isAlterRelation } from '@/lib/game-engine';
import { useI18n } from '@/lib/i18n';
import { ScrollSlider } from './ScrollSlider';

interface GuessTableProps {
  guesses: GuessResult[];
  target: Character | null;
  hideRarity?: boolean;
  /** 每次递增强制猜对行重新挂载，重新播放闪烁动画 */
  flashTrigger?: number;
  /** 每次猜中递增，强制最新非胜行重新挂载以重播逐格揭示 */
  staggerKey?: number;
}

function StatusCell({ status, children, colWidth, extraStyle }: { status: GuessStatus; children: React.ReactNode; colWidth?: number; extraStyle?: React.CSSProperties }) {
  return (
    <td
      style={{
        width: colWidth ? `${colWidth}px` : undefined,
        background: `var(--${status})`,
        color: status === 'wrong' ? 'var(--text-light)' : '#fff',
        fontWeight: status !== 'wrong' ? 700 : 400,
        padding: '10px 12px',
        textAlign: 'center',
        fontSize: '0.9rem',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        transition: 'background 0.25s',
        ...extraStyle,
      }}
    >
      {children}
    </td>
  );
}

export function GuessTable({ guesses, target, hideRarity, flashTrigger, staggerKey }: GuessTableProps) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);

  if (guesses.length === 0) return null;

  const columns = [
    { key: 'name', label: t('table.name'), render: (g: GuessResult) => g.character.name },
    { key: 'class', label: t('table.class'), render: (g: GuessResult) => g.character.class, statusKey: 'class' as const },
    { key: 'subclass', label: t('table.subclass'), render: (g: GuessResult) => g.character.subclass, statusKey: 'subclass' as const },
    { key: 'faction', label: t('table.faction'), render: (g: GuessResult) => g.character.faction, statusKey: 'faction' as const },
    ...(hideRarity ? [] : [{ key: 'rarity', label: t('table.rarity'), render: (g: GuessResult) => '★'.repeat(g.character.rarity), statusKey: 'rarity' as const }]),
    { key: 'race', label: t('table.race'), render: (g: GuessResult) => g.character.race, statusKey: 'race' as const },
    { key: 'gender', label: t('table.gender'), render: (g: GuessResult) => g.character.gender, statusKey: 'gender' as const },
    { key: 'releaseYear', label: t('table.year'), render: (g: GuessResult) => g.character.releaseYear ? String(g.character.releaseYear) : '?', statusKey: 'releaseYear' as const },
    { key: 'position', label: t('table.position'), render: (g: GuessResult) => g.character.position || '?', statusKey: 'position' as const },
    { key: 'tags', label: t('table.tags'), render: (g: GuessResult) => (g.character.tags || []).join(' ') || '-', statusKey: 'tags' as const },
  ];

  // 列宽：名字和 tags 留足空间，其余窄列均分
  // 使用固定像素 min-width 防止 table-layout:fixed 下百分比因容器宽度不确定而漂移
  const colWidths = hideRarity
    ? [120, 72, 72, 80, 72, 56, 72, 72, 110]   // 9 列 (px)
    : [110, 70, 64, 78, 60, 70, 56, 70, 70, 110]; // 10 列 (px)

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
      <table className="game-table" style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: '0.9rem', minWidth: `${colWidths.reduce((a, b) => a + b, 0)}px` }}>
        <thead>
          <tr>
            {columns.map((col, i) => (
              <th key={col.key} style={{
                width: `${colWidths[i] || 70}px`,
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
            const alterMatch = target && isAlterRelation(target, guess.character);
            const isWinner = target ? guess.character.id === target.id : false;
            const isNewest = i === 0;
            // 胜行 + 最新行需要交错动画延迟
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
                  // 名字列：猜对=绿，异格=黄；固定宽度 + 溢出省略
                  const nameCellBase: React.CSSProperties = {
                    width: `${colWidths[0] || 110}px`,
                    padding: '10px 12px', textAlign: 'center', fontWeight: 700,
                    fontSize: '0.9rem', whiteSpace: 'nowrap',
                    overflow: 'hidden', textOverflow: 'ellipsis',
                    ...cellStyle,
                  };
                  if (col.key === 'name') {
                    const isCorrect = target && guess.character.id === target.id;
                    if (isCorrect) {
                      return (
                        <td key={col.key} style={{ ...nameCellBase, color: '#fff', background: 'var(--correct)' }}>
                          {col.render(guess)}
                        </td>
                      );
                    }
                    if (alterMatch) {
                      return (
                        <td key={col.key} style={{ ...nameCellBase, color: '#fff', background: 'var(--close)' }}>
                          {col.render(guess)}
                        </td>
                      );
                    }
                    return (
                      <td key={col.key} style={{ ...nameCellBase, color: 'var(--text)' }}>
                        {col.render(guess)}
                      </td>
                    );
                  }
                  if (col.statusKey) {
                    return (
                      <StatusCell key={col.key} status={guess.comparisons[col.statusKey]} colWidth={colWidths[colIdx]} extraStyle={cellStyle}>
                        {col.render(guess)}
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
        .game-table td { border: 1px solid var(--border); }
        @media (max-width: 640px) { .game-table td, .game-table th { padding: 8px 4px; font-size: 0.75rem; } }
      `}</style>
      </div>
      <ScrollSlider containerRef={scrollRef} />
    </div>
  );
}
