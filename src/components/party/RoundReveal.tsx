'use client';

// 派对模式 - 回合结果展示（回合间隔15s）
import { useMemo } from 'react';
import { useI18n } from '@/lib/i18n';
import { usePartyStore } from '@/stores/party-store';

export function PartyRoundReveal() {
  const { t } = useI18n();
  const rankings = usePartyStore(s => s.roundRankings);
  const rawScores = usePartyStore(s => s.totalScores);
  // Fix: client-side 排序防御，防止服务端排序不一致
  const totalScores = useMemo(() => [...rawScores].sort((a, b) => b.score - a.score), [rawScores]);
  const targetName = usePartyStore(s => s.targetName);
  const currentRound = usePartyStore(s => s.currentRound);
  const totalRounds = usePartyStore(s => s.totalRounds);

  // 分离猜出的和未猜出的
  const found = rankings.filter(r => !r.didNotGuess);
  const notFound = rankings.filter(r => r.didNotGuess);

  const medalEmoji = (i: number) => {
    if (i === 0) return '🥇';
    if (i === 1) return '🥈';
    if (i === 2) return '🥉';
    return '';
  };

  return (
    <div style={{ width: '100%', maxWidth: '520px', textAlign: 'center' }}>
      {/* 回合标题 */}
      <h2 style={{
        fontFamily: 'var(--font-display)', fontSize: '1.1rem',
        fontStyle: 'italic', fontWeight: 700, marginBottom: '8px',
      }}>
        {t('party.roundResult', { round: currentRound, total: totalRounds })}
      </h2>

      {/* 答案 */}
      <div style={{
        padding: '12px', background: 'var(--card)',
        border: '1px solid var(--primary)', borderRadius: 'var(--radius)',
        marginBottom: '16px',
      }}>
        <span style={{ color: 'var(--text-light)', fontSize: '0.85rem' }}>
          {t('party.answer')}:
        </span>
        <span style={{
          fontSize: '1.3rem', fontWeight: 900, color: 'var(--primary)',
          marginLeft: '8px',
        }}>
          {targetName || '?'}
        </span>
      </div>

      {/* 排名列表 */}
      {found.length > 0 && (
        <div style={{
          padding: '12px', background: 'var(--card)',
          border: '1px solid var(--border)', borderRadius: 'var(--radius)',
          marginBottom: '12px',
        }}>
          <div style={{ fontWeight: 700, fontSize: '0.9rem', marginBottom: '8px' }}>
            {t('party.roundRankings')}
          </div>
          {found.map((r, i) => (
            <div
              key={r.playerId}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '8px 12px', marginBottom: '4px',
                background: i === 0 ? 'var(--accent-soft, rgba(251, 191, 36, 0.1))' : 'var(--card-soft)',
                borderRadius: 'var(--radius)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '1.2rem' }}>{medalEmoji(i)}</span>
                <span style={{ fontWeight: 700 }}>{r.playerName}</span>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-light)' }}>
                  {r.guessCount}{t('party.guessesShort')}
                </div>
                <div style={{
                  fontSize: '0.9rem', fontWeight: 700,
                  color: r.pointsEarned > 0 ? 'var(--correct)' : 'var(--text-light)',
                }}>
                  +{r.pointsEarned} {t('party.points')}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 未猜出的玩家 */}
      {notFound.length > 0 && (
        <div style={{
          padding: '8px 12px', marginBottom: '12px',
          fontSize: '0.8rem', color: 'var(--text-light)',
        }}>
          {notFound.map(r => r.playerName).join(', ')} — {t('party.didNotGuess')}
        </div>
      )}

      {/* 累计排名 */}
      {totalScores.length > 0 && (
        <div style={{
          padding: '12px', background: 'var(--card)',
          border: '1px solid var(--border)', borderRadius: 'var(--radius)',
          marginBottom: '12px',
        }}>
          <div style={{ fontWeight: 700, fontSize: '0.9rem', marginBottom: '8px' }}>
            {t('party.totalStandings')}
          </div>
          {totalScores.map((s, i) => (
            <div
              key={s.playerId}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '6px 12px', marginBottom: '2px',
                background: i === 0 ? 'var(--accent-soft, rgba(251,191,36,0.1))' : 'transparent',
                borderRadius: 'var(--radius)',
                fontWeight: i === 0 ? 700 : 400,
              }}
            >
              <span>{i + 1}. {s.playerName}</span>
              <span style={{ color: 'var(--primary)', fontWeight: 700 }}>
                {s.score} {t('party.points')}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 提示文字 */}
      <p style={{ color: 'var(--text-light)', fontSize: '0.8rem' }}>
        {t('party.nextRoundSoon')}
      </p>
    </div>
  );
}
