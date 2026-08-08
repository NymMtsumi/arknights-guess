'use client';

import { useI18n } from '@/lib/i18n';
import { loadHistory } from '@/lib/stats';
import type { Character, GameStatus } from '@/types/character';

interface GameEndDialogProps {
  status: GameStatus;
  target: Character | null;
  guessCount: number;
  onClose: () => void;
  onNewGame: () => void;
}

/** 从历史记录计算当前连胜/连败数（最近连续同结果数） */
function computeStreak(): { type: 'win' | 'loss' | null; count: number } {
  try {
    const history = loadHistory();
    if (!history.length) return { type: null, count: 0 };
    // 按时间戳降序排列（最新在前）
    const sorted = [...history].sort((a, b) => b.timestamp - a.timestamp);
    const first = sorted[0];
    // 多人模式也计入 streak
    const firstWon = 'won' in first ? first.won : false;
    let count = 0;
    for (const r of sorted) {
      const rWon = 'won' in r ? r.won : false;
      if (rWon === firstWon) count++;
      else break;
    }
    return { type: firstWon ? 'win' : 'loss', count };
  } catch {
    return { type: null, count: 0 };
  }
}

export function GameEndDialog({ status, target, guessCount, onClose, onNewGame }: GameEndDialogProps) {
  const { t } = useI18n();

  if (status !== 'won' && status !== 'lost') return null;
  if (!target) return null;

  const won = status === 'won';
  const streak = computeStreak();

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

        {/* 连胜/连败提示 */}
        {streak.count >= 2 && (
          <div className="streak-badge" style={{
            marginBottom: '16px',
            padding: '8px 18px',
            borderRadius: 'var(--radius)',
            fontSize: '0.95rem',
            fontWeight: 700,
            background: streak.type === 'win'
              ? 'rgba(255, 215, 0, 0.15)'
              : 'rgba(255, 101, 120, 0.12)',
            color: streak.type === 'win' ? '#b8860b' : 'var(--danger)',
            border: `1px solid ${streak.type === 'win' ? 'rgba(255, 215, 0, 0.35)' : 'rgba(255, 101, 120, 0.3)'}`,
          }}>
            {streak.type === 'win'
              ? `🔥 连胜 ${streak.count} 局！`
              : `💪 连败 ${streak.count} 局，下次一定！`
            }
          </div>
        )}

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

        {/* 两个按钮 */}
        <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', flexWrap: 'wrap' }}>
          <button
            onClick={onClose}
            style={{
              padding: '12px 24px',
              background: 'transparent',
              color: 'var(--text)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              fontSize: '0.95rem',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {t('game.viewResult')}
          </button>
          <button
            onClick={onNewGame}
            style={{
              padding: '12px 28px',
              background: 'var(--primary)',
              color: 'var(--bg)',
              border: 'none',
              borderRadius: 'var(--radius)',
              fontSize: '1rem',
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            {t('game.newGame')}
          </button>
        </div>
      </div>
    </div>
  );
}
