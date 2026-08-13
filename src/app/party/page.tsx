'use client';

// 派对模式主页面 — 使用共享 hooks + 提取后的 handler 模块
import { useEffect, useRef, useState } from 'react';
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

export default function PartyPage() {
  return <PartyPageContent />;
}

function PartyPageContent() {
  const { t } = useI18n();
  // 静态导出（output: "export"）下 useSearchParams 首次渲染为空、不可靠，
  // 改为与 verify/reset-password/leaderboard 页一致：直接读 window.location.search。
  const [roomParam, setRoomParam] = useState('');
  const [showRules, setShowRules] = useState(false);
  // 邀请链接自动进房：仅触发一次，防止重复 emit（房间不存在则停留在 lobby 显示错误）
  const autoJoinRef = useRef(false);
  // 语言切换后 t 会重建，但 handler 仅在连接时注册一次（闭包捕获首个 t）。
  // 用 ref 保持引用稳定、始终读取最新语言，避免切换语言后 toast 仍是旧语言。
  const tRef = useRef(t);
  tRef.current = t;

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
    t: (key, params) => tRef.current(key, params),
    persistRoomCode, forgetRoom, savePlayerName,
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
      if (!code) return;
      s.emit('party:reconnect', { roomCode: code }, (res: { ok?: boolean; code?: string }) => {
        // 重连失败（房间已解散/已结束/被拒）：清残留状态退回大厅，通过「上次房间」重新加入
        if (res && res.ok === false) {
          usePartyStore.getState().resetAll();
          useGameStore.getState().resetGame();
          usePartyStore.setState({ stage: 'lobby', error: t('party.errReconnect') });
        }
      });
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
    const params = new URLSearchParams(window.location.search);
    setRoomParam(params.get('room') || '');
  }, []);

  useEffect(() => {
    if (roomParam && roomParam.trim()) setStage('lobby');
  }, [roomParam, setStage]);

  // 邀请链接 ?room=XXXXXX 自动进房（而非只跳 lobby 预填）。
  // 依赖 isConnected 触发：socket 连上后立即 emit party:join，成功后 onPartyJoined 会把 stage 推到 waiting。
  useEffect(() => {
    const code = roomParam && roomParam.trim();
    if (!code || autoJoinRef.current) return;
    const socket = socketRef.current;
    if (!socket || !isConnected) return;
    // 已手动进入过房间（等待室/游戏中）则不再自动加入
    const stage = usePartyStore.getState().stage;
    if (stage === 'waiting' || stage === 'countdown' || stage === 'playing') return;

    autoJoinRef.current = true;
    usePartyStore.setState({ connecting: 'join' });
    socket.emit('party:join', { roomCode: code }, (res: { ok?: boolean; code?: string; message?: string }) => {
      // 失败时只清除 connecting；具体错误文案由 party:error 事件负责（onPartyError → toast）
      if (res && res.ok === false) usePartyStore.setState({ connecting: '' });
    });
  }, [roomParam, isConnected, socketRef]);

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
            <button data-testid="party-menu-join" onClick={() => setStage('lobby')} style={{ padding: '14px 32px', background: 'var(--primary)', color: 'var(--bg)', border: 'none', borderRadius: 'var(--radius)', fontSize: '1.1rem', fontWeight: 700, cursor: 'pointer' }}>
              {t('party.createJoinRoom')}
            </button>

            {/* 规则面板（可折叠） */}
            <div style={{ marginTop: '24px', textAlign: 'left' }}>
              <button
                onClick={() => setShowRules(!showRules)}
                style={{
                  width: '100%', padding: '10px', background: 'var(--card)',
                  color: 'var(--text)', border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)', cursor: 'pointer', fontWeight: 700,
                  fontSize: '0.9rem',
                }}
              >
                📖 {t('party.rulesTitle')} {showRules ? '▲' : '▼'}
              </button>
              {showRules && (
                <div style={{
                  marginTop: '8px', padding: '14px', background: 'var(--card)',
                  border: '1px solid var(--border)', borderRadius: 'var(--radius)',
                  fontSize: '0.85rem', lineHeight: '1.7', color: 'var(--text)',
                }}>
                  <p style={{ marginBottom: '8px' }}>{t('party.rulesIntro')}</p>
                  <ol style={{ paddingLeft: '20px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <li>{t('party.rule1')}</li>
                    <li>{t('party.rule2')}</li>
                    <li>{t('party.rule3')}</li>
                    <li>{t('party.rule4')}</li>
                  </ol>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Lobby */}
        {stage === 'lobby' && <PartyLobby onBack={() => setStage('menu')} socketRef={socketRef} isConnected={isConnected} initialCode={roomParam} />}

        {/* Waiting Room */}
        {stage === 'waiting' && socketRef.current && <PartyWaitingRoom socket={socketRef.current} isConnected={isConnected} />}

        {/* Countdown */}
        {stage === 'countdown' && (
          <div data-testid="party-countdown" style={{ textAlign: 'center' }}>
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
