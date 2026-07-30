'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { GameSearch } from '@/components/GameSearch';
import { GuessTable } from '@/components/GuessTable';
import { useGameStore } from '@/stores/game-store';
import type { Character } from '@/types/character';

const SERVER_URL = process.env.NEXT_PUBLIC_WS_URL || 'http://localhost:3001';

type Stage = 'menu' | 'create' | 'join' | 'waiting' | 'playing' | 'ended';

interface OpponentInfo {
  id: string;
  name: string;
  guessCount: number;
  comparisons: string[][];
}

interface EndInfo {
  winner: string | null;
  winnerName: string;
  reason: string;
  targetName: string;
}

export default function MultiplayerPage() {
  const [stage, setStage] = useState<Stage>('menu');
  const [socket, setSocket] = useState<Socket | null>(null);
  const [roomCode, setRoomCode] = useState('');
  const [playerName, setPlayerName] = useState('');
  const [opponent, setOpponent] = useState<OpponentInfo | null>(null);
  const [endInfo, setEndInfo] = useState<EndInfo | null>(null);
  const [timeLeft, setTimeLeft] = useState(120);
  const [error, setError] = useState('');
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // 游戏 store
  const gameStore = useGameStore();

  // 连接服务器
  const connect = useCallback(() => {
    const s = io(SERVER_URL, { transports: ['websocket', 'polling'] });
    setSocket(s);
    return s;
  }, []);

  // 创建房间
  const handleCreate = () => {
    if (!playerName.trim()) { setError('请输入昵称'); return; }
    const s = connect();
    const target = gameStore.target;
    s.emit('create_room', {
      playerName: playerName.trim(),
      targetCharId: target?.id || '',
      targetName: target?.name || '',
    });
    s.on('room_created', (data: { code: string }) => {
      setRoomCode(data.code);
      setStage('waiting');
    });
    setupSocketListeners(s);
  };

  // 加入房间
  const handleJoin = () => {
    if (!playerName.trim()) { setError('请输入昵称'); return; }
    if (!roomCode.trim()) { setError('请输入房间码'); return; }
    const s = connect();
    s.emit('join_room', { code: roomCode.trim(), playerName: playerName.trim() });
    setupSocketListeners(s);
  };

  const setupSocketListeners = (s: Socket) => {
    s.on('error_msg', (data: { message: string }) => {
      setError(data.message);
      s.disconnect();
    });

    s.on('game_start', (data: { targetCharId: string; targetName: string; players: { id: string; name: string }[]; startTime: number }) => {
      setStage('playing');
      setTimeLeft(120);
      setEndInfo(null);

      // 找对手信息
      const me = s.id;
      const opp = data.players.find(p => p.id !== me);
      if (opp) setOpponent({ id: opp.id, name: opp.name, guessCount: 0, comparisons: [] });

      // 开始倒计时
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = setInterval(() => {
        const elapsed = Date.now() - data.startTime;
        const remaining = Math.max(0, 120 - Math.floor(elapsed / 1000));
        setTimeLeft(remaining);
        if (remaining <= 0) clearInterval(timerRef.current!);
      }, 1000);
    });

    s.on('opponent_update', (data: { playerId: string; guessCount: number; comparisons: string[][] }) => {
      setOpponent(prev => prev ? { ...prev, guessCount: data.guessCount, comparisons: data.comparisons } : prev);
    });

    s.on('game_end', (data: EndInfo) => {
      setEndInfo(data);
      setStage('ended');
      if (timerRef.current) clearInterval(timerRef.current);
      s.disconnect();
    });

    s.on('disconnect', () => {
      if (stage === 'playing') {
        setEndInfo({ winner: null, winnerName: '', reason: 'disconnect', targetName: '' });
        setStage('ended');
      }
    });
  };

  // 发送猜测更新
  const handleGuess = (char: Character) => {
    gameStore.submitGuess(char.name);
    if (socket) {
      const comps = gameStore.guesses.length > 0
        ? [] // 用最近一次猜测的颜色
        : [];
      socket.emit('guess_update', {
        guessCount: gameStore.guesses.length + 1,
        comparisons: comps,
      });
    }

    // 检查是否赢了
    if (gameStore.status === 'won' && socket) {
      socket.emit('player_win', { targetName: gameStore.target?.name || '' });
    }
  };

  const handleGiveUp = () => {
    if (socket) socket.emit('player_giveup');
  };

  // 开始单机游戏(选目标)
  const startSoloGame = () => {
    gameStore.startGame('hard');
  };

  // 清理
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (socket) socket.disconnect();
    };
  }, [socket]);

  const guessedIds = new Set(gameStore.guesses.map(g => g.character.id));

  return (
    <div className="page">
      <Header />
      <div className="page-scroll" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 'clamp(24px, 4vw, 40px)' }}>

        {/* 开始菜单 */}
        {stage === 'menu' && (
          <div style={{ textAlign: 'center', maxWidth: '420px' }}>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '2rem', fontStyle: 'italic', fontWeight: 900, marginBottom: '24px' }}>
              ⚔️ 多人对战
            </h1>
            <p style={{ color: 'var(--text-light)', marginBottom: '24px', fontSize: '0.9rem' }}>
              与好友同猜一位干员，120 秒内先猜中者获胜，实时查看对方进度
            </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', flexWrap: 'wrap' }}>
              <button onClick={() => { setStage('create'); startSoloGame(); }} style={btnStyle}>
                🏠 创建房间
              </button>
              <button onClick={() => { setStage('join'); startSoloGame(); }} style={{ ...btnStyle, background: 'var(--accent)' }}>
                🚪 加入房间
              </button>
            </div>
          </div>
        )}

        {/* 创建房间 */}
        {stage === 'create' && (
          <div style={{ textAlign: 'center', maxWidth: '400px' }}>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem', fontStyle: 'italic', marginBottom: '16px' }}>
              创建房间
            </h2>
            <input value={playerName} onChange={e => setPlayerName(e.target.value)} placeholder="输入你的昵称"
              style={inputStyle} maxLength={12} />
            {error && <p style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>{error}</p>}
            <button onClick={handleCreate} style={{ ...btnStyle, marginTop: '12px' }}>创建</button>
          </div>
        )}

        {/* 加入房间 */}
        {stage === 'join' && (
          <div style={{ textAlign: 'center', maxWidth: '400px' }}>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem', fontStyle: 'italic', marginBottom: '16px' }}>
              加入房间
            </h2>
            <input value={roomCode} onChange={e => setRoomCode(e.target.value.toUpperCase())} placeholder="输入 4 位房间码"
              style={inputStyle} maxLength={4} />
            <input value={playerName} onChange={e => setPlayerName(e.target.value)} placeholder="输入你的昵称"
              style={{ ...inputStyle, marginTop: '8px' }} maxLength={12} />
            {error && <p style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>{error}</p>}
            <button onClick={handleJoin} style={{ ...btnStyle, marginTop: '12px' }}>加入</button>
          </div>
        )}

        {/* 等待对手 */}
        {stage === 'waiting' && (
          <div style={{ textAlign: 'center' }}>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.8rem', fontStyle: 'italic', marginBottom: '12px' }}>
              ⏳ 等待对手加入
            </h2>
            <p style={{ fontSize: '3rem', fontFamily: 'monospace', fontWeight: 900, color: 'var(--primary)', margin: '16px 0' }}>
              {roomCode}
            </p>
            <p style={{ color: 'var(--text-light)', fontSize: '0.9rem' }}>
              分享这个房间码给好友
            </p>
          </div>
        )}

        {/* 对战进行中 */}
        {(stage === 'playing' || stage === 'ended') && (
          <div style={{ maxWidth: 'var(--content-max)', width: '100%' }}>
            {/* 顶部状态栏 */}
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              marginBottom: '16px', padding: '12px 16px',
              background: 'var(--card)', borderRadius: 'var(--radius)', border: '1px solid var(--border)',
            }}>
              <div>
                <span style={{ fontWeight: 700 }}>你：</span>
                <span style={{ color: 'var(--primary)' }}>{gameStore.guesses.length} 次猜测</span>
              </div>
              <div style={{ fontSize: '1.3rem', fontFamily: 'monospace', fontWeight: 900, color: timeLeft <= 30 ? 'var(--danger)' : 'var(--primary)' }}>
                {Math.floor(timeLeft / 60)}:{(timeLeft % 60).toString().padStart(2, '0')}
              </div>
              <div>
                <span style={{ fontWeight: 700 }}>{opponent?.name || '对手'}：</span>
                <span style={{ color: 'var(--accent)' }}>{opponent?.guessCount || 0} 次猜测</span>
              </div>
            </div>

            {/* 搜索 + 放弃 */}
            {stage === 'playing' && (
              <div style={{ display: 'flex', justifyContent: 'center', gap: '12px', marginBottom: '16px' }}>
                <GameSearch onGuess={handleGuess} disabled={gameStore.status !== 'playing'} guessedIds={guessedIds} />
                <button onClick={handleGiveUp} style={{
                  padding: '8px 16px', background: 'transparent', color: 'var(--danger)',
                  border: '1px solid var(--danger)', borderRadius: 'var(--radius)', cursor: 'pointer', fontSize: '0.85rem',
                }}>放弃</button>
              </div>
            )}

            {/* 猜测表格 */}
            <GuessTable guesses={gameStore.guesses} target={gameStore.target} />

            {/* 对手进度 */}
            {opponent && opponent.comparisons.length > 0 && (
              <div style={{ marginTop: '16px', padding: '12px', background: 'var(--card-soft)', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
                <p style={{ fontWeight: 700, marginBottom: '8px' }}>{opponent.name} 的进度：</p>
                <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                  {opponent.comparisons.map((row, i) => (
                    <div key={i} style={{ display: 'flex', gap: '2px' }}>
                      {row.map((color, j) => (
                        <span key={j} style={{
                          width: '12px', height: '12px', borderRadius: '2px',
                          background: color === 'correct' ? 'var(--correct)' : color === 'close' ? 'var(--close)' : 'var(--wrong)',
                        }} />
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* 结束弹窗 */}
        {stage === 'ended' && endInfo && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
            style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}>
            <div style={{
              background: 'var(--card)', padding: 'clamp(24px,5vw,40px)', borderRadius: 'var(--radius)',
              boxShadow: 'var(--shadow-lg)', border: '1px solid var(--border)', maxWidth: '400px', textAlign: 'center',
            }}>
              <div style={{ fontSize: '3rem', marginBottom: '12px' }}>
                {endInfo.reason === 'win' ? '🎉' : endInfo.reason === 'timeout' ? '⏰' : '🏳️'}
              </div>
              <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem', fontStyle: 'italic', fontWeight: 900 }}>
                {endInfo.reason === 'win' ? `${endInfo.winnerName} 获胜！` :
                 endInfo.reason === 'timeout' ? '时间到，平局' :
                 `${endInfo.winnerName} 获胜（对方退出）`}
              </h2>
              {endInfo.targetName && (
                <p style={{ color: 'var(--text-light)', marginTop: '8px' }}>答案：{endInfo.targetName}</p>
              )}
              <a href="/multiplayer" style={{ display: 'inline-block', marginTop: '16px', padding: '10px 24px',
                background: 'var(--primary)', color: 'var(--bg)', borderRadius: 'var(--radius)',
                fontWeight: 700, textDecoration: 'none' }}>再来一局</a>
            </div>
          </div>
        )}
      </div>
      <Footer />
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 14px', background: 'var(--input-bg)', color: 'var(--text)',
  border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: '1rem', textAlign: 'center',
};

const btnStyle: React.CSSProperties = {
  padding: '12px 28px', background: 'var(--primary)', color: 'var(--bg)',
  border: 'none', borderRadius: 'var(--radius)', fontSize: '1rem', fontWeight: 700, cursor: 'pointer',
};
