'use client';

// 派对模式 - 主游戏界面
import { useRef, useCallback } from 'react';
import { useI18n } from '@/lib/i18n';
import { usePartyStore } from '@/stores/party-store';
import { useGameStore } from '@/stores/game-store';
import { GameSearch } from '@/components/GameSearch';
import { GuessTable } from '@/components/GuessTable';
import { ScrollSlider } from '@/components/ScrollSlider';
import { PartyPlayerCards } from './PlayerCards';
import type { Socket } from 'socket.io-client';
import type { Character } from '@/types/character';

interface PartyGameProps {
  socket: Socket;
}

export function PartyGame({ socket }: PartyGameProps) {
  const { t } = useI18n();
  const timeLeft = usePartyStore(s => s.timeLeft);
  const currentRound = usePartyStore(s => s.currentRound);
  const totalRounds = usePartyStore(s => s.totalRounds);
  const roundFinished = usePartyStore(s => s.roundFinished);
  const exhaustedPlayers = usePartyStore(s => s.exhaustedPlayers);
  const socketId = usePartyStore(s => s.socketId);
  const playerName = usePartyStore(s => s.playerName);
  const disconnectedCount = usePartyStore(s => s.disconnectedPlayers.length); // Fix M3-2
  const attributes = usePartyStore(s => s.settings.attributes);
  const myBoardScrollRef = useRef<HTMLDivElement>(null);

  // 是否已耗尽次数
  const iExhausted = exhaustedPlayers.includes(socketId);

  // Per-slice selectors（Fix: 避免 whole-store 订阅在每次 guess 时全量重渲染）
  const gameGuesses = useGameStore(s => s.guesses);
  const gameStatus = useGameStore(s => s.status);
  const gameTarget = useGameStore(s => s.target);
  const gameRemaining = useGameStore(s => s.remainingGuesses);

  const handleGuess = useCallback((char: Character) => {
    const gs = useGameStore.getState();
    if (gs.status !== 'playing' || roundFinished) return;
    // 本地去重防御（服务端亦去重，防止快速双击重复计数）
    if (gs.guesses.some(g => g.character.id === char.id)) return;

    // 只发名字：对比在服务端完成，客户端不持有答案
    socket.emit('party:guess', { name: char.name });
  }, [socket, roundFinished]);

  const guessedIds = new Set(gameGuesses.map(g => g.character.id));
  const inputDisabled = gameStatus !== 'playing' || roundFinished || iExhausted;

  return (
    <div data-testid="party-game" style={{ width: '100%' }}>
      {/* 回合信息和计时器 */}
      <div style={{
        display: 'flex', justifyContent: 'center', alignItems: 'center',
        gap: '16px', flexWrap: 'wrap', marginBottom: '12px',
        padding: '10px 16px', background: 'var(--card)',
        borderRadius: 'var(--radius)', border: '1px solid var(--border)',
      }}>
        <span style={{ fontSize: '0.85rem', color: 'var(--text-light)', fontWeight: 600 }}>
          {t('party.round')} {currentRound}/{totalRounds}
        </span>
        <span style={{
          fontSize: '1.3rem', fontFamily: 'monospace', fontWeight: 900,
          color: timeLeft <= 30 ? 'var(--danger)' : 'var(--primary)',
        }}>
          {String(Math.floor(timeLeft / 60)).padStart(2, '0')}:{String(timeLeft % 60).padStart(2, '0')}
        </span>
        <span style={{ fontSize: '0.85rem', color: 'var(--text-light)', fontWeight: 600 }}>
          {playerName}
        </span>
      </div>

      {/* 玩家状态栏 */}
      <PartyPlayerCards />

      {/* 断线提示 */}
      {disconnectedCount > 0 && (
        <div style={{
          textAlign: 'center', marginBottom: '8px',
          color: 'var(--warning)', fontSize: '0.85rem',
        }}>
          ⚠ {t('party.playersDisconnected', { count: disconnectedCount })}
        </div>
      )}

      {/* 搜索和猜测 */}
      {!roundFinished && (
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '12px' }}>
          <GameSearch
            onGuess={handleGuess}
            disabled={inputDisabled}
            guessedIds={guessedIds}
            remainingGuesses={gameRemaining}
          />
        </div>
      )}

      {/* 已猜出提示 */}
      {gameStatus === 'won' && (
        <div style={{
          textAlign: 'center', marginBottom: '12px',
          padding: '10px', background: 'var(--correct-soft, rgba(34,197,94,0.1))',
          borderRadius: 'var(--radius)', border: '1px solid var(--correct)',
          color: 'var(--correct)', fontWeight: 700,
        }}>
          🎉 {t('party.youFoundIt', { count: gameGuesses.length })}
        </div>
      )}

      {/* 已耗尽提示 */}
      {iExhausted && (
        <div style={{
          textAlign: 'center', marginBottom: '12px',
          padding: '10px', background: 'var(--wrong-soft, rgba(239,68,68,0.1))',
          borderRadius: 'var(--radius)', border: '1px solid var(--wrong)',
          color: 'var(--wrong)', fontWeight: 700,
        }}>
          {t('party.outOfGuesses')}
        </div>
      )}

      {/* 猜测表格 */}
      <div ref={myBoardScrollRef} style={{ overflowX: 'auto', scrollBehavior: 'smooth' }} className="scroll-slider-container">
        <GuessTable
          guesses={gameGuesses}
          target={gameTarget}
          hideRarity={false}
          displayAttributes={attributes ?? null}
          staggerKey={gameGuesses.length}
        />
      </div>
      <ScrollSlider containerRef={myBoardScrollRef} />
    </div>
  );
}
