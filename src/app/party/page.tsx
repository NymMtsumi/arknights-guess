'use client';

// 派对模式主页面 — 使用共享 hooks + 提取后的 handler 模块
import { useEffect, useRef, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Header } from '@/components/Header';
import { PartyLobby } from '@/components/party/Lobby';
import { PartyWaitingRoom } from '@/components/party/WaitingRoom';
import { PartyGame } from '@/components/party/PartyGame';
import { PartyRoundReveal } from '@/components/party/RoundReveal';
import { PartyEnd } from '@/components/party/PartyEnd';
import { usePartyStore } from '@/stores/party-store';
import { useGameStore } from '@/stores/game-store';
import { useI18n } from '@/lib/i18n';
import { useSocket } from '@/hooks/useSocket';
import { useCountdown } from '@/hooks/useCountdown';
import { usePlayerName } from '@/hooks/usePlayerName';
import { useRoom } from '@/hooks/useRoom';
import { registerAllPartyHandlers, type PartyHandlerCtx } from '@/lib/party-handlers';
import type { Character } from '@/types/character';
import charactersData from '@/data/characters.json';

const allChars = charactersData as Character[];

/** Suspense 边界包裹：useSearchParams 需要 Suspense 祖先 */
export default function PartyPage() {
  return (
    <Suspense fallback={<div className="page"><Header /><div style={{ textAlign: 'center', padding: '40px' }}>Loading...</div></div>}>
      <PartyPageContent />
    </Suspense>
  );
}

function PartyPageContent() {
  const { t } = useI18n();
  const searchParams = useSearchParams();

  // 共享 hooks
  const { playerName, savePlayerName } = usePlayerName();
  const { persistRoomCode, forgetRoom } = useRoom();
  const { timeLeft, start: startCountdown, stop: stopCountdown } = useCountdown();

  // Store
  const stage = usePartyStore(s => s.stage);
  const setStage = usePartyStore(s => s.setStage);
  const connecting = usePartyStore(s => s.connecting);
  const error = usePartyStore(s => s.error);

  const storeSet = (patch: Partial<ReturnType<typeof usePartyStore.getState>>) => usePartyStore.setState(patch);

  // 带追踪的错误定时器
  const errorTimerRef = useRef<NodeJS.Timeout | null>(null);
  const setTimedError = (msg: string, ms = 3000) => {
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    storeSet({ connecting: '', error: msg });
    if (ms > 0) errorTimerRef.current = setTimeout(() => usePartyStore.setState({ error: '' }), ms);
  };

  // stub 角色（查不到时降级）
  const makeStubChar = (name: string): Character => ({
    id: name, name, nameEn: name, class: '', classEn: '', subclass: '', subclassEn: '',
    faction: '', factionEn: '', rarity: 0, race: '', raceEn: '', gender: '', genderEn: '',
    position: '', positionEn: '', releaseYear: 0, tags: [], alterBase: '',
  } as Character);

  // 构建 handler 上下文
  const handlerCtx: PartyHandlerCtx = {
    t, persistRoomCode, forgetRoom, savePlayerName,
    setStage, startCountdown, stopCountdown, setTimedError,
    makeStubChar, allChars,
  };

  // Socket
  const { socketRef, isConnected, connect, disconnect } = useSocket({
    onError: (msg) => {
      usePartyStore.setState({ connecting: '', error: t('party.serverError', { msg }) });
    },
    onBeforeConnect: (s) => {
      registerAllPartyHandlers(s, handlerCtx);
    },
    onReconnect: (s) => {
      const code = usePartyStore.getState().roomCode;
      if (code) s.emit('party:reconnect', { roomCode: code });
    },
  });

  // ── 生命周期 ──
  useEffect(() => {
    return () => { disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (playerName) usePartyStore.setState({ playerName });
  }, [playerName]);

  useEffect(() => {
    connect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const room = searchParams.get('room');
    if (room && room.trim()) setStage('lobby');
  }, [searchParams, setStage]);

  // ── 渲染 ──
  return (
    <div className="page">
      <Header />
      <div className="page-scroll" style={{
        display: 'flex', flexDirection: 'column',
        alignItems: 'center',
        padding: 'clamp(12px, 2vw, 28px) var(--page-inline)',
      }}>
        {/* Menu */}
        {stage === 'menu' && (
          <div style={{ textAlign: 'center', maxWidth: '450px' }}>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(1.5rem, 4vw, 2rem)', fontStyle: 'italic', fontWeight: 900, marginBottom: '12px' }}>
              🎉 {t('party.title')}
            </h1>
            <p style={{ color: 'var(--text-light)', fontSize: '0.9rem', marginBottom: '20px' }}>
              {t('party.description')}
            </p>
            <button onClick={() => setStage('lobby')} style={{ padding: '14px 32px', background: 'var(--primary)', color: 'var(--bg)', border: 'none', borderRadius: 'var(--radius)', fontSize: '1.1rem', fontWeight: 700, cursor: 'pointer' }}>
              {t('party.createJoinRoom')}
            </button>
          </div>
        )}

        {/* Lobby */}
        {stage === 'lobby' && <PartyLobby onBack={() => setStage('menu')} socketRef={socketRef} isConnected={isConnected} />}

        {/* Waiting Room */}
        {stage === 'waiting' && socketRef.current && <PartyWaitingRoom socket={socketRef.current} isConnected={isConnected} />}

        {/* Countdown */}
        {stage === 'countdown' && (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '4rem', marginBottom: '16px', animation: 'neon-pulse 1s infinite' }}>{timeLeft}</div>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.2rem', fontStyle: 'italic', fontWeight: 700 }}>{t('party.gettingReady')}</h2>
          </div>
        )}

        {/* Playing */}
        {stage === 'playing' && socketRef.current && <PartyGame socket={socketRef.current} />}

        {/* Round Reveal */}
        {stage === 'reveal' && <PartyRoundReveal />}

        {/* Game End */}
        {stage === 'end' && <PartyEnd />}

        {/* Error Toast */}
        {error && stage !== 'lobby' && (
          <div style={{ position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)', padding: '10px 20px', background: 'var(--danger)', color: '#fff', borderRadius: 'var(--radius)', fontWeight: 700, zIndex: 100, fontSize: '0.9rem' }}>
            {error}
            <button onClick={() => usePartyStore.setState({ error: '' })} style={{ marginLeft: '12px', background: 'transparent', color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 700 }}>X</button>
          </div>
        )}

        {/* Connecting Dialog */}
        {connecting && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }}>
            <div style={{ background: 'var(--card)', padding: '32px', borderRadius: 'var(--radius)', textAlign: 'center' }}>
              <div style={{ fontSize: '2rem', marginBottom: '10px', animation: 'neon-pulse 1.5s infinite' }}>
                {connecting === 'create' ? '🏠' : connecting === 'join' ? '🚪' : '🎉'}
              </div>
              <p style={{ fontSize: '1.1rem', fontWeight: 700 }}>
                {connecting === 'create' ? t('party.creating') : connecting === 'join' ? t('party.joining') : t('party.connecting')}
              </p>
              <p style={{ color: 'var(--text-light)', fontSize: '0.8rem', marginTop: '6px' }}>
                {t('party.connectingTimeout')}
              </p>
            </div>
          </div>
        )}

        <style>{`
          @keyframes neon-pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
          }
        `}</style>
      </div>
    </div>
  );
}
