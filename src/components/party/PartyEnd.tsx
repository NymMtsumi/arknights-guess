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
    <div className="w-full max-w-[520px] text-center">
      {/* 标题 */}
      <div className="emoji-lg">🏆</div>
      <h2 className="scr-ttl">
        {t('party.gameOver')}
      </h2>

      {/* 冠军 */}
      {champion && (
        <div className="champ-card mb-4">
          <div className="champ-tro">👑</div>
          <div className="champ-name">
            {champion.playerName}
          </div>
          <div className="champ-tags">
            {t('party.champion', { score: champion.totalScore })}
          </div>
        </div>
      )}

      {/* 最终排名 */}
      {finalRankings.length > 0 && (
        <div className="card mb-4">
        <div className="board-ttl">
          {t('party.finalStandings')}
        </div>
        {finalRankings.map((r, i) => (
          <div
            key={r.playerId}
            className={'rk' + (i < 3 ? ` top${i + 1}` : '')}
          >
            <span className={'place' + (i === 0 ? ' gold' : i === 1 ? ' silver' : i === 2 ? ' bronze' : '')}>{i + 1}</span>
            <span className="rk-medal">{medalEmoji(i)}</span>
            <div>
              <div className="rk-name">{r.playerName}</div>
              {(r.roundsWon ?? 0) > 0 && (
                <div className="rk-sub">
                  {t('party.roundsWon', { n: r.roundsWon! })}
                </div>
              )}
            </div>
            <div className="rk-pt">
              {r.totalScore} <small>{t('party.points')}</small>
            </div>
          </div>
        ))}
      </div>
      )}

      <button
        onClick={handleExit}
        className="btn-p"
      >
        {t('party.backToMenu')}
      </button>
    </div>
  );
}
