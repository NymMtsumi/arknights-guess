'use client';

import { useI18n } from '@/lib/i18n';
import type { Character, GameStatus } from '@/types/character';

interface GameEndDialogProps {
  status: GameStatus;
  target: Character | null;
  guessCount: number;
  onNewGame: () => void;
}

export function GameEndDialog({ status, target, guessCount, onNewGame }: GameEndDialogProps) {
  const { t } = useI18n();

  if (status !== 'won' && status !== 'lost') return null;
  if (!target) return null;

  const won = status === 'won';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
    >
      <div
        style={{
          background: 'var(--card)',
          color: 'var(--text)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          boxShadow: 'var(--shadow-lg)',
          padding: 'clamp(24px, 5vw, 40px)',
          maxWidth: '420px',
          width: '100%',
          textAlign: 'center',
        }}
      >
        {/* 状态表情 */}
        <div style={{ fontSize: '4rem', marginBottom: '16px' }}>
          {won ? '🎉' : '😢'}
        </div>

        {/* 标题 */}
        <h2
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'clamp(1.5rem, 3vw, 2rem)',
            fontWeight: 900,
            fontStyle: 'italic',
            marginBottom: '12px',
            color: won ? 'var(--correct)' : 'var(--danger)',
          }}
        >
          {won ? t('game.won') : t('game.lost')}
        </h2>

        {/* 描述 */}
        <p style={{ color: 'var(--text-sec)', marginBottom: '20px', fontSize: '0.95rem' }}>
          {won
            ? t('game.wonDesc', { name: target.name, count: guessCount })
            : t('game.lostDesc', { name: target.name })
          }
        </p>

        {/* 目标角色信息 */}
        <div style={{
          display: 'flex',
          justifyContent: 'center',
          gap: '12px',
          marginBottom: '24px',
          flexWrap: 'wrap',
        }}>
          <span style={{
            padding: '4px 10px',
            background: 'var(--primary-soft)',
            color: 'var(--primary-strong)',
            borderRadius: 'var(--radius-sm)',
            fontSize: '0.85rem',
            fontWeight: 600,
          }}>
            {target.class}
          </span>
          <span style={{
            padding: '4px 10px',
            background: 'var(--primary-soft)',
            color: 'var(--primary-strong)',
            borderRadius: 'var(--radius-sm)',
            fontSize: '0.85rem',
            fontWeight: 600,
          }}>
            {'★'.repeat(target.rarity)}
          </span>
          <span style={{
            padding: '4px 10px',
            background: 'var(--primary-soft)',
            color: 'var(--primary-strong)',
            borderRadius: 'var(--radius-sm)',
            fontSize: '0.85rem',
            fontWeight: 600,
          }}>
            {target.faction}
          </span>
        </div>

        {/* 再来一局 */}
        <button
          onClick={onNewGame}
          style={{
            padding: '12px 32px',
            background: 'var(--primary)',
            color: 'var(--bg)',
            border: 'none',
            borderRadius: 'var(--radius)',
            fontSize: '1rem',
            fontWeight: 700,
            cursor: 'pointer',
            transition: 'background 0.2s, transform 0.2s',
          }}
          onMouseEnter={e => (e.currentTarget.style.transform = 'translateY(-2px)')}
          onMouseLeave={e => (e.currentTarget.style.transform = 'translateY(0)')}
        >
          {t('game.newGame')}
        </button>
      </div>
    </div>
  );
}
