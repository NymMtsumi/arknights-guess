'use client';

// 派对模式 - 局内实时排行榜（无剧透：只显示状态不显示猜测内容）
// 数据源：party:round_status（累计分 + 剩余次数 + 猜中/耗尽状态，服务端已按分数排序）
import { usePartyStore } from '@/stores/party-store';
import { useI18n } from '@/lib/i18n';

export function PartyPlayerCards() {
  const { t } = useI18n();
  const players = usePartyStore(s => s.players);
  const foundPlayers = usePartyStore(s => s.foundPlayers);
  const roundStatus = usePartyStore(s => s.roundStatus);
  const disconnectedPlayers = usePartyStore(s => s.disconnectedPlayers);

  if (players.length === 0) return null;

  // 有实时状态则按其排序渲染（服务端已按 score 降序），否则回退到玩家列表
  const list = roundStatus.length > 0
    ? roundStatus
    : players.map(p => ({
        playerId: p.id, playerName: p.name, playerKey: p.playerKey,
        score: p.score, guessed: false, exhausted: false, guessCount: 0, remaining: 0,
      }));

  const medalEmoji = (i: number) => (i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '');

  return (
    <div style={{
      display: 'flex', gap: '8px', justifyContent: 'center',
      flexWrap: 'wrap', marginBottom: '12px',
    }}>
      {list.map((p, i) => {
        const found = foundPlayers.find(fp => fp.playerId === p.playerId);
        const disconnected = disconnectedPlayers.includes(p.playerId);

        let statusColor = 'var(--text-light)';
        let statusText = t('party.statusGuessing');
        let bgColor = 'var(--card-soft)';

        if (disconnected) {
          // 断线优先于其他状态
          statusColor = 'var(--warning)';
          statusText = t('party.statusDisconnected');
          bgColor = 'var(--warning-soft, rgba(245, 158, 11, 0.1))';
        } else if (p.guessed || found) {
          statusColor = 'var(--correct)';
          // Fix M5-3: rank<=0 时显示 "已猜出" 而非 "#0"
          const rank = found?.rank ?? 0;
          const gc = found?.guessCount ?? p.guessCount;
          statusText = rank > 0
            ? `#${rank} (${gc}${t('party.guessesShort')})`
            : `✅ (${gc}${t('party.guessesShort')})`;
          bgColor = 'var(--correct-soft, rgba(34, 197, 94, 0.1))';
        } else if (p.exhausted) {
          statusColor = 'var(--wrong)';
          statusText = t('party.statusExhausted');
          bgColor = 'var(--wrong-soft, rgba(239, 68, 68, 0.1))';
        } else {
          // 猜测中：显示剩余次数
          statusText = t('party.remainingGuesses', { n: p.remaining });
        }

        return (
          <div
            key={p.playerId}
            style={{
              padding: '6px 12px', borderRadius: 'var(--radius)',
              background: bgColor,
              border: `1px solid ${statusColor}`,
              textAlign: 'center',
              minWidth: '96px',
              transition: 'all 0.3s',
            }}
          >
            <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text)' }}>
              {medalEmoji(i)} {p.playerName}
            </div>
            <div style={{ fontSize: '0.7rem', color: statusColor, fontWeight: 600 }}>
              {statusText}
            </div>
            <div style={{ fontSize: '0.7rem', color: 'var(--primary)', fontWeight: 700 }}>
              {p.score} {t('party.points')}
            </div>
          </div>
        );
      })}
    </div>
  );
}
