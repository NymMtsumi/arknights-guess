'use client';

// 派对模式 - 最终结算界面
import { useI18n } from '@/lib/i18n';
import { usePartyStore } from '@/stores/party-store';
import { useGameStore } from '@/stores/game-store';
import { useRouter } from 'next/navigation';
import { useRoom } from '@/hooks/useRoom';

export function PartyEnd() {
  const { t } = useI18n();
  const router = useRouter();
  const { forgetRoom } = useRoom();
  const finalRankings = usePartyStore(s => s.finalRankings);
  const champion = usePartyStore(s => s.champion);
  const resetAll = usePartyStore(s => s.resetAll);

  const handleExit = () => {
    forgetRoom();
    resetAll();
    useGameStore.getState().resetGame(); // Fix #9: 避免离开派对后单人模式卡死
    router.push('/party');
  };

  const medalEmoji = (i: number) => {
    if (i === 0) return '🥇';
    if (i === 1) return '🥈';
    if (i === 2) return '🥉';
    return '';
  };

  return (
    <div style={{ width: '100%', maxWidth: '520px', textAlign: 'center' }}>
      {/* 标题 */}
      <div style={{ fontSize: '3rem', marginBottom: '10px' }}>🏆</div>
      <h2 style={{
        fontFamily: 'var(--font-display)', fontSize: '1.5rem',
        fontStyle: 'italic', fontWeight: 900, marginBottom: '8px',
      }}>
        {t('party.gameOver')}
      </h2>

      {/* 冠军 */}
      {champion && (
        <div style={{
          padding: '16px', marginBottom: '16px',
          background: 'var(--accent-soft, rgba(251, 191, 36, 0.15))',
          border: '2px solid var(--accent)',
          borderRadius: 'var(--radius)',
        }}>
          <div style={{ fontSize: '2rem', marginBottom: '4px' }}>👑</div>
          <div style={{
            fontSize: '1.3rem', fontWeight: 900,
            color: 'var(--accent)', marginBottom: '4px',
          }}>
            {champion.playerName}
          </div>
          <div style={{ fontSize: '0.9rem', color: 'var(--text)' }}>
            {t('party.champion', { score: champion.totalScore })}
          </div>
        </div>
      )}

      {/* 最终排名 */}
      {finalRankings.length > 0 && (
        <div style={{
        padding: '16px', background: 'var(--card)',
        border: '1px solid var(--border)', borderRadius: 'var(--radius)',
        marginBottom: '16px',
      }}>
        <div style={{ fontWeight: 700, fontSize: '0.95rem', marginBottom: '10px' }}>
          {t('party.finalStandings')}
        </div>
        {finalRankings.map((r, i) => (
          <div
            key={r.playerId}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '10px 14px', marginBottom: '4px',
              background: i === 0 ? 'var(--accent-soft, rgba(251,191,36,0.1))'
                : i === 1 ? 'var(--card-soft)'
                : 'transparent',
              borderRadius: 'var(--radius)',
              border: i === 0 ? '1px solid var(--accent)' : 'none',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '1.3rem' }}>{medalEmoji(i)}</span>
              <span style={{ fontWeight: i <= 2 ? 700 : 400, fontSize: '1rem' }}>
                {i + 1}. {r.playerName}
              </span>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{
                fontSize: '1rem', fontWeight: 700, color: 'var(--primary)',
              }}>
                {r.totalScore} {t('party.points')}
              </div>
              {(r.roundsWon ?? 0) > 0 && (
                <div style={{ fontSize: '0.75rem', color: 'var(--text-light)' }}>
                  {t('party.roundsWon', { n: r.roundsWon! })}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      )}

      <button
        onClick={handleExit}
        style={{
          padding: '12px 32px', background: 'var(--primary)', color: 'var(--bg)',
          border: 'none', borderRadius: 'var(--radius)', fontWeight: 700,
          fontSize: '1rem', cursor: 'pointer',
        }}
      >
        {t('party.backToMenu')}
      </button>
    </div>
  );
}
