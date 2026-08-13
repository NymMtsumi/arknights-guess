'use client';

// 派对模式 - 玩家状态顶栏（无剧透：只显示状态不显示猜测内容）
import { usePartyStore } from '@/stores/party-store';
import { useI18n } from '@/lib/i18n';

export function PartyPlayerCards() {
  const { t } = useI18n();
  const players = usePartyStore(s => s.players);
  const foundPlayers = usePartyStore(s => s.foundPlayers);
  const exhaustedPlayers = usePartyStore(s => s.exhaustedPlayers);
  const disconnectedPlayers = usePartyStore(s => s.disconnectedPlayers);

  if (players.length === 0) return null;

  return (
    <div style={{
      display: 'flex', gap: '8px', justifyContent: 'center',
      flexWrap: 'wrap', marginBottom: '12px',
    }}>
      {players.map(p => {
        const found = foundPlayers.find(fp => fp.playerId === p.id);
        const exhausted = exhaustedPlayers.includes(p.id);
        const disconnected = disconnectedPlayers.includes(p.id);

        let statusColor = 'var(--text-light)';
        let statusText = t('party.statusGuessing');
        let bgColor = 'var(--card-soft)';

        if (found) {
          statusColor = 'var(--correct)';
          // Fix M5-3: rank<=0 时显示 "已猜出" 而非 "#0"
          statusText = found.rank > 0
            ? `#${found.rank} (${found.guessCount}${t('party.guessesShort')})`
            : `✅ (${found.guessCount}${t('party.guessesShort')})`;
          bgColor = 'var(--correct-soft, rgba(34, 197, 94, 0.1))';
        } else if (disconnected) {
          // Fix: 断线优先于次数用尽
          statusColor = 'var(--warning)';
          statusText = t('party.statusDisconnected');
          bgColor = 'var(--warning-soft, rgba(245, 158, 11, 0.1))';
        } else if (exhausted) {
          statusColor = 'var(--wrong)';
          statusText = t('party.statusExhausted');
          bgColor = 'var(--wrong-soft, rgba(239, 68, 68, 0.1))';
        }

        return (
          <div
            key={p.id}
            style={{
              padding: '6px 12px', borderRadius: 'var(--radius)',
              background: bgColor,
              border: `1px solid ${statusColor}`,
              textAlign: 'center',
              minWidth: '90px',
              transition: 'all 0.3s',
            }}
          >
            <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text)' }}>
              {p.name}
            </div>
            <div style={{ fontSize: '0.7rem', color: statusColor, fontWeight: 600 }}>
              {statusText}
            </div>
          </div>
        );
      })}
    </div>
  );
}
