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
    <div className="w-full max-w-[520px] text-center">
      {/* 回合标题 */}
      <h2 className="scr-ttl">
        {t('party.roundResult', { round: currentRound, total: totalRounds })}
      </h2>

      {/* 答案 */}
      <div className="ansbox hi mb-4">
        <span className="al">
          {t('party.answer')}:
        </span>
        <span className="av2">
          {targetName || '?'}
        </span>
      </div>

      {/* 排名列表 */}
      {found.length > 0 && (
        <div className="card mb-3">
          <div className="board-ttl">
            {t('party.roundRankings')}
          </div>
          {found.map((r, i) => (
            <div
              key={r.playerId}
              className={'rk' + (i < 3 ? ` top${i + 1}` : '')}
            >
              <span className={'place' + (i === 0 ? ' gold' : i === 1 ? ' silver' : i === 2 ? ' bronze' : '')}>{i + 1}</span>
              <span className="rk-medal">{medalEmoji(i)}</span>
              <div>
                <div className="rk-name">{r.playerName}</div>
                <div className="rk-sub">
                  {r.guessCount}{t('party.guessesShort')}
                </div>
              </div>
              <div className="rk-pt">
                +{r.pointsEarned} <small>{t('party.points')}</small>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 未猜出的玩家 */}
      {notFound.length > 0 && (
        <div className="sec-note mb-3">
          {notFound.map(r => r.playerName).join(', ')} — {t('party.didNotGuess')}
        </div>
      )}

      {/* 累计排名 */}
      {totalScores.length > 0 && (
        <div className="card mb-3">
          <div className="board-ttl">
            {t('party.totalStandings')}
          </div>
          {totalScores.map((s, i) => (
            <div
              key={s.playerId}
              className={'rk' + (i < 3 ? ` top${i + 1}` : '')}
            >
              <span className={'place' + (i === 0 ? ' gold' : i === 1 ? ' silver' : i === 2 ? ' bronze' : '')}>{i + 1}</span>
              <span className="rk-name">{s.playerName}</span>
              <span className="rk-pt">
                {s.score} <small>{t('party.points')}</small>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 提示文字 */}
      <p className="sec-note">
        {t('party.nextRoundSoon')}
      </p>
    </div>
  );
}
