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
}

function StatusCell({ status, children }: { status: GuessStatus; children: React.ReactNode }) {
  return (
    <td
      style={{
        background: `var(--${status})`,
        color: status === 'wrong' ? 'var(--text-light)' : '#fff',
        fontWeight: status !== 'wrong' ? 700 : 400,
        padding: '10px 12px',
        textAlign: 'center',
        fontSize: '0.9rem',
        whiteSpace: 'nowrap',
        transition: 'background 0.25s',
      }}
    >
      {children}
    </td>
  );
}

export function GuessTable({ guesses, target, hideRarity }: GuessTableProps) {
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
      <table className="game-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
        <thead>
          <tr>
            {columns.map(col => (
              <th key={col.key} style={{
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
            const isWinner = target && guess.character.id === target.id;
            return (
              <tr
                key={guess.timestamp}
                className={isWinner ? 'guess-row-winner' : ''}
                style={i === 0 && !isWinner ? {
                  animation: 'surface-enter 0.4s 0s cubic-bezier(0.2, 0.72, 0.25, 1) both',
                } : {}}
              >
                {columns.map(col => {
                  // 名字列：猜对=绿，异格=黄
                  if (col.key === 'name') {
                    const isCorrect = target && guess.character.id === target.id;
                    if (isCorrect) {
                      return (
                        <td key={col.key} style={{
                          padding: '10px 12px', textAlign: 'center', fontWeight: 700,
                          fontSize: '0.9rem', whiteSpace: 'nowrap',
                          color: '#fff', background: 'var(--correct)',
                        }}>
                          {col.render(guess)}
                        </td>
                      );
                    }
                    if (alterMatch) {
                      return (
                        <td key={col.key} style={{
                          padding: '10px 12px', textAlign: 'center', fontWeight: 700,
                          fontSize: '0.9rem', whiteSpace: 'nowrap',
                          color: '#fff', background: 'var(--close)',
                        }}>
                          {col.render(guess)}
                        </td>
                      );
                    }
                    return (
                      <td key={col.key} style={{
                        padding: '10px 12px', textAlign: 'center', fontWeight: 700,
                        color: 'var(--text)', fontSize: '0.9rem', whiteSpace: 'nowrap',
                      }}>
                        {col.render(guess)}
                      </td>
                    );
                  }
                  if (col.statusKey) {
                    return (
                      <StatusCell key={col.key} status={guess.comparisons[col.statusKey]}>
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
