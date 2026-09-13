'use client';

// 派对模式 - 局内实时状态列表（无剧透：只显示状态不显示猜测内容）
// 数据源：party:round_status（累计分 + 剩余次数 + 猜中/耗尽状态，服务端已按分数排序）
//
// ⚠️ 这里曾经是一排 .bdg 横向小卡（对着 §21 的 .pcard 那套）。稿子
//    index-v12-modes.html:1714-1722 的局内实时状态用的是**竖排** .live-list / .live
//    + .avatar-mini，四态 .lock/.busy/.out/.off。.pcard 在任何一份稿子里都不存在，
//    已删除；现在按稿子走竖排。
//    分数在稿子的 .live 里没有对应元素，但它是旧 UI 已有的信息，删掉是功能倒退 ——
//    所以接在状态文案后面（「剩 6 次 · 12 分」），需要严格贴稿时再议。
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
        playerId: p.id, playerName: p.name,
        score: p.score, guessed: false, exhausted: false, guessCount: 0, remaining: 0,
      }));

  const medalEmoji = (i: number) => (i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '');

  return (
    <div className="live-list mb-3">
      {list.map((p, i) => {
        const found = foundPlayers.find(fp => fp.playerId === p.playerId);
        const disconnected = disconnectedPlayers.includes(p.playerId);

        // 四态与稿子 modes:618-624 一一对应：
        //   .off 断线（优先级最高） / .lock 已猜出 / .out 次数耗尽 / .busy 猜测中
        let state = 'busy';
        let statusText = t('party.remainingGuesses', { n: p.remaining });

        if (disconnected) {
          state = 'off';
          statusText = t('party.statusDisconnected');
        } else if (p.guessed || found) {
          state = 'lock';
          // Fix M5-3: rank<=0 时显示 "已猜出" 而非 "#0"
          const rank = found?.rank ?? 0;
          const gc = found?.guessCount ?? p.guessCount;
          statusText = rank > 0
            ? `#${rank} (${gc}${t('party.guessesShort')})`
            : `✅ (${gc}${t('party.guessesShort')})`;
        } else if (p.exhausted) {
          state = 'out';
          statusText = t('party.statusExhausted');
        }

        return (
          <div key={p.playerId} className={`live ${state}`}>
            {/* 稿子这里是 emoji 头像；线上没有头像数据，用名字首字代替。 */}
            <span className={`avatar-mini${disconnected ? ' off' : ''}`} aria-hidden="true">
              {p.playerName.slice(0, 1)}
            </span>
            <span className="ln">{medalEmoji(i)} {p.playerName}</span>
            <span className="st">{statusText} · {p.score} {t('party.points')}</span>
          </div>
        );
      })}
    </div>
  );
}
