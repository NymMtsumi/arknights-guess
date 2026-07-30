'use client';

import { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { Header } from '@/components/Header';
import { GameSearch } from '@/components/GameSearch';
import { GuessTable } from '@/components/GuessTable';
import { useGameStore } from '@/stores/game-store';
import { saveGameStats } from '@/lib/stats';
import type { Character } from '@/types/character';

const SERVER_URL = process.env.NEXT_PUBLIC_WS_URL || 'https://writing-color-built-rhythm.trycloudflare.com';
const COL_LABELS = ['姓名', '职业', '子职', '阵营', '星级', '种族', '性别', '年份', '部署', '词缀'];

type Stage = 'menu' | 'lobby' | 'waiting' | 'playing' | 'roundEnd' | 'matchEnd';
type ConnectingType = '' | 'create' | 'join';

export default function MultiplayerPage() {
  const [stage, setStage] = useState<Stage>('menu');
  const [socket, setSocket] = useState<Socket | null>(null);
  const [roomCode, setRoomCode] = useState('');
  const [playerName, setPlayerName] = useState('');
  const [bestOf, setBestOf] = useState(5);
  const [connecting, setConnecting] = useState<ConnectingType>('');
  const connectTimer = useRef<NodeJS.Timeout | null>(null);
  const [oppName, setOppName] = useState('');
  const [oppWins, setOppWins] = useState(0);
  const [myWins, setMyWins] = useState(0);
  const [oppGuessCount, setOppGuessCount] = useState(0);
  const [oppGrid, setOppGrid] = useState<string[][]>([]);
  const [timeLeft, setTimeLeft] = useState(120);
  const [error, setError] = useState('');
  const [endMsg, setEndMsg] = useState('');
  const [roundEndData, setRoundEndData] = useState<any>(null);
  const [iSurrendered, setISurrendered] = useState(false);
  const [oppSurrendered, setOppSurrendered] = useState(false);
  const [showSurrenderConfirm, setShowSurrenderConfirm] = useState(false);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const myColorsRef = useRef<string[][]>([]);

  const store = useGameStore();

  const trimName = (n: string) => n.slice(0, 4);

  const connect = () => {
    const s = io(SERVER_URL, { transports: ['websocket', 'polling'] });
    setSocket(s);

    s.on('error_msg', (d: { message: string }) => { clearConnecting(); setError(d.message); s.disconnect(); });
    s.on('room_created', (d: { code: string; bestOf: number }) => { clearConnecting(); setRoomCode(d.code); setBestOf(d.bestOf); setStage('waiting'); });

    s.on('round_start', (d: { score: string; players: { id: string; name: string; wins: number }[] }) => {
      clearConnecting();
      setStage('playing');
      setTimeLeft(120);
      setOppGuessCount(0);
      setOppGrid([]);
      setISurrendered(false);
      setOppSurrendered(false);
      setRoundEndData(null);
      myColorsRef.current = [];

      const me = s.id;
      const opp = d.players.find(p => p.id !== me);
      if (opp) { setOppName(opp.name); setOppWins(opp.wins); }
      const meP = d.players.find(p => p.id === me);
      if (meP) setMyWins(meP.wins);

      store.startGame('hard');

      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = setInterval(() => {
        setTimeLeft(t => { if (t <= 1) { clearInterval(timerRef.current!); return 0; } return t - 1; });
      }, 1000);
    });

    s.on('opponent_update', (d: { guessCount: number; allComparisons: string[][] }) => {
      setOppGuessCount(d.guessCount);
      if (d.allComparisons?.length) setOppGrid(d.allComparisons);
    });

    s.on('opponent_surrendered', (d: { playerName: string }) => {
      setOppSurrendered(true);
    });

    s.on('round_end', (d: any) => {
      setStage('roundEnd');
      setRoundEndData(d);
      if (timerRef.current) clearInterval(timerRef.current);
      // 统计战绩
      const won = d.winner === s.id;
      saveGameStats(won, store.guesses.length, 'multi', d.targetName || '');
    });

    s.on('match_end', (d: { winner: string | null; winnerName: string; score: string; reason?: string }) => {
      // 比赛结束时也保存最后一局
      saveGameStats(d.winner === socket?.id, store.guesses.length, 'multi', '');
      setStage('matchEnd');

    s.on('match_end', (d: { winner: string | null; winnerName: string; score: string; reason?: string }) => {
      setStage('matchEnd');
      setEndMsg(d.reason === 'disconnect' ? `${d.winnerName} 获胜（对方断线超30秒）` : `${d.winnerName} 赢得比赛！\n${d.score}`);
      s.disconnect();
      if (timerRef.current) clearInterval(timerRef.current);
    });

    return s;
  };

  const clearConnecting = () => {
    if (connectTimer.current) { clearTimeout(connectTimer.current); connectTimer.current = null; }
    setConnecting('');
  };

  const handleCreate = () => {
    if (!playerName.trim() || playerName.trim().length > 4) { setError('昵称最多4个汉字'); return; }
    setError('');
    setConnecting('create');
    const s = connect();
    s.emit('create_room', { playerName: trimName(playerName), bestOf });
    s.emit('_log', { action: 'create_room', playerName: trimName(playerName), bestOf });
    connectTimer.current = setTimeout(() => {
      s.disconnect();
      setConnecting('');
      setError('创建超时，请检查服务器状态');
    }, 30000);
  };

  const handleJoin = () => {
    if (!playerName.trim() || !roomCode.trim()) { setError('请输入昵称和房间码'); return; }
    if (playerName.trim().length > 4) { setError('昵称最多4个汉字'); return; }
    setError('');
    setConnecting('join');
    const s = connect();
    s.emit('join_room', { code: roomCode.trim().toUpperCase(), playerName: trimName(playerName) });
    s.emit('_log', { action: 'join_room', code: roomCode.trim().toUpperCase(), playerName: trimName(playerName) });
    connectTimer.current = setTimeout(() => {
      s.disconnect();
      setConnecting('');
      setError('加入超时，请检查房间码和服务器');
    }, 30000);
  };

  const handleGuess = (char: Character) => {
    if (useGameStore.getState().status !== 'playing') return;
    store.submitGuess(char.name);

    const s = useGameStore.getState();
    if (s.guesses.length) {
      const latest = s.guesses[s.guesses.length - 1];
      const comp = latest.comparisons;
      const row = [
        latest.character.id === s.target?.id ? 'correct' : 'wrong',
        comp.class, comp.subclass, comp.faction,
        comp.rarity, comp.race, comp.gender,
        comp.releaseYear, comp.position, comp.tags,
      ];
      myColorsRef.current = [...myColorsRef.current, row];
    }

    if (socket) {
      socket.emit('guess_update', { guessCount: s.guesses.length, allComparisons: myColorsRef.current });
      if (s.status === 'won') socket.emit('player_win_round', { targetName: s.target?.name || '' });
    }
  };

  const handleSurrender = () => {
    setShowSurrenderConfirm(true);
  };

  const confirmSurrender = () => {
    setShowSurrenderConfirm(false);
    setISurrendered(true);
    if (!socket || useGameStore.getState().status !== 'playing') return;
    socket.emit('surrender_round', { targetName: store.target?.name || '' });
    store.giveUp();
  };

  useEffect(() => { return () => { if (timerRef.current) clearInterval(timerRef.current); if (socket) socket.disconnect(); }; }, [socket]);

  const guessedIds = new Set(store.guesses.map(g => g.character.id));
  const gameOver = useGameStore.getState().status !== 'playing';
  const inputDisabled = gameOver || iSurrendered;
  // 对手放弃不影响我的输入框

  return (
    <div className="page">
      <Header />
      <div className="page-scroll" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: 'clamp(12px,2vw,28px) var(--page-inline)' }}>

        {/* ---- 菜单 ---- */}
        {stage === 'menu' && (
          <div style={{ textAlign: 'center', maxWidth: '450px' }}>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(1.5rem,4vw,2rem)', fontStyle: 'italic', fontWeight: 900, marginBottom: '16px' }}>⚔️ 多人对战</h1>
            <p style={{ color: 'var(--text-light)', fontSize: '0.9rem', marginBottom: '14px' }}>BO3 / BO5 / BO7 · 每局 2 分钟 · 先达胜场者胜</p>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', marginBottom: '16px' }}>
              {[3,5,7].map(n => (
                <button key={n} onClick={() => setBestOf(n)} style={{
                  padding: '6px 16px', background: bestOf === n ? 'var(--primary)' : 'transparent',
                  color: bestOf === n ? 'var(--bg)' : 'var(--text)', border: `1px solid ${bestOf === n ? 'var(--primary)' : 'var(--border)'}`,
                  borderRadius: 'var(--radius)', cursor: 'pointer', fontWeight: bestOf === n ? 700 : 400,
                }}>BO{n}</button>
              ))}
            </div>
            <button onClick={() => setStage('lobby')} style={btn}>🏠 创建 / 加入房间</button>
          </div>
        )}

        {/* ---- 大厅 ---- */}
        {stage === 'lobby' && (
          <div style={{ textAlign: 'center', maxWidth: '400px' }}>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.3rem', fontStyle: 'italic', marginBottom: '12px' }}>
              BO{bestOf} · {bestOf === 3 ? '2胜' : bestOf === 5 ? '3胜' : '4胜'}制
            </h2>
            <input value={playerName} onChange={e => setPlayerName(e.target.value)} placeholder="昵称（最多4个汉字）" style={inp} maxLength={4} />
            <div style={{ marginTop: '12px' }}>
              <button onClick={handleCreate} style={btn}>创建房间</button>
            </div>
            <div style={{ marginTop: '16px', padding: '12px', borderTop: '1px solid var(--border)' }}>
              <input value={roomCode} onChange={e => setRoomCode(e.target.value.replace(/\D/g,''))} placeholder="4位数字房间码" style={{ ...inp, marginBottom: '8px' }} maxLength={4} inputMode="numeric" />
              <button onClick={handleJoin} style={{ ...btn, background: 'var(--accent)' }}>加入房间</button>
            </div>
            {error && <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginTop: '12px' }}>{error}</p>}
          </div>
        )}

        {/* ---- 等待 ---- */}
        {stage === 'waiting' && (
          <div style={{ textAlign: 'center' }}>
            <p style={{ fontSize: '1.2rem' }}>⏳ 等待对手加入</p>
            <p style={{ fontSize: 'clamp(2rem,5vw,3rem)', fontFamily: 'monospace', fontWeight: 900, color: 'var(--primary)', margin: '16px 0' }}>{roomCode}</p>
            <p style={{ color: 'var(--text-light)' }}>BO{bestOf} · 分享房间码给好友</p>
          </div>
        )}

        {/* ---- 对战中 ---- */}
        {stage === 'playing' && (
          <div style={{ width: '100%' }}>
            {/* 顶部：比分 + 倒计时 */}
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginBottom: '12px', padding: '10px 12px', background: 'var(--card)', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
              <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>{trimName(playerName) || '你'} <span style={{ color: 'var(--primary)', fontWeight: 900 }}>{myWins}</span></span>
              <span style={{ fontSize: '1.2rem', fontFamily: 'monospace', fontWeight: 900, color: timeLeft <= 30 ? 'var(--danger)' : 'var(--primary)' }}>
                {String(Math.floor(timeLeft / 60)).padStart(2,'0')}:{String(timeLeft % 60).padStart(2,'0')}
              </span>
              <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>{oppName} <span style={{ color: 'var(--accent)', fontWeight: 900 }}>{oppWins}</span></span>
            </div>

            {/* 搜索栏 */}
            <div style={{ display: 'flex', justifyContent: 'center', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
              <GameSearch onGuess={handleGuess} disabled={inputDisabled} guessedIds={guessedIds} />
              {!inputDisabled && (
                <button onClick={handleSurrender} style={{ padding: '8px 12px', background: 'transparent', color: 'var(--danger)', border: '1px solid var(--danger)', borderRadius: 'var(--radius)', cursor: 'pointer', fontSize: '0.8rem', whiteSpace: 'nowrap' }}>放弃本局</button>
              )}
              {iSurrendered && <span style={{ color: 'var(--warning)', fontSize: '0.8rem', alignSelf: 'center' }}>你已放弃本局</span>}
              {oppSurrendered && <span style={{ color: 'var(--warning)', fontSize: '0.8rem', alignSelf: 'center' }}>对手已放弃本局</span>}
            </div>

            {/* 左右分栏 - 移动端堆叠 */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
              {/* 左：己方表格 */}
              <div style={{ flex: '1 1 48%', minWidth: '280px' }}>
                <div style={{ fontWeight: 700, marginBottom: '4px', fontSize: '0.85rem', color: 'var(--primary)' }}>你的猜测</div>
                <div style={{ overflowX: 'auto' }}>
                  <GuessTable guesses={store.guesses} target={store.target} />
                </div>
              </div>

              {/* 右：对手颜色网格 */}
              <div style={{ flex: '1 1 48%', minWidth: '280px' }}>
                <div style={{ fontWeight: 700, marginBottom: '4px', fontSize: '0.85rem', color: 'var(--accent)' }}>
                  {oppName}（{oppGuessCount} 次）
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.65rem' }}>
                    <thead>
                      <tr>
                        {COL_LABELS.map((l, i) => (
                          <th key={i} style={{ padding: '3px 2px', fontWeight: 600, color: 'var(--text-light)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>{l}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {oppGrid.length === 0 ? (
                        <tr><td colSpan={10} style={{ padding: '16px', textAlign: 'center', color: 'var(--text-light)', fontSize: '0.75rem' }}>等待对手猜测...</td></tr>
                      ) : (
                        [...oppGrid].reverse().map((row, i) => (
                          <tr key={i} style={{ animation: 'surface-enter 0.35s both' }}>
                            {row.map((color, j) => (
                              <td key={j} style={{ padding: '3px 2px', textAlign: 'center' }}>
                                <span style={{
                                  display: 'inline-block', width: '12px', height: '12px', borderRadius: '2px',
                                  background: color === 'correct' ? 'var(--correct)' : color === 'close' ? 'var(--close)' : color === 'wrong' ? 'var(--wrong)' : '#444',
                                }} title={color} />
                              </td>
                            ))}
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ---- 局结束 ---- */}
        {stage === 'roundEnd' && roundEndData && (
          <div style={{ textAlign: 'center', maxWidth: '400px', marginTop: '16px' }}>
            <div style={{ fontSize: '2rem', marginBottom: '6px' }}>
              {roundEndData.winner ? (roundEndData.winner === socket?.id ? '🎉 你赢了本局' : '😔 对手拿下本局') : '🤝 本局平局'}
            </div>
            <p style={{ color: 'var(--text-light)', fontSize: '0.85rem' }}>答案：{roundEndData.targetName} · {roundEndData.score}</p>
            {!roundEndData.matchOver && <p style={{ color: 'var(--text-light)', fontSize: '0.8rem', marginTop: '6px' }}>5 秒后下一局...</p>}
          </div>
        )}

        {/* ---- 比赛结束 ---- */}
        {stage === 'matchEnd' && (
          <div style={{ textAlign: 'center', maxWidth: '400px', marginTop: '16px' }}>
            <div style={{ fontSize: '2.5rem', marginBottom: '10px' }}>🏆</div>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.2rem', fontStyle: 'italic', fontWeight: 900, whiteSpace: 'pre-line' }}>{endMsg}</h2>
            <a href="/multiplayer" style={{ display: 'inline-block', marginTop: '14px', padding: '10px 24px', background: 'var(--primary)', color: 'var(--bg)', borderRadius: 'var(--radius)', fontWeight: 700, textDecoration: 'none' }}>再来一局</a>
          </div>
        )}

        {/* 放弃确认弹窗 */}
        {showSurrenderConfirm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}>
            <div style={{ background: 'var(--card)', padding: '24px', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)', textAlign: 'center', maxWidth: '320px', border: '1px solid var(--border)' }}>
              <p style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '8px' }}>确定放弃本局？</p>
              <p style={{ color: 'var(--text-light)', fontSize: '0.85rem', marginBottom: '16px' }}>放弃后本局无法继续猜测</p>
              <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
                <button onClick={() => setShowSurrenderConfirm(false)} style={{ padding: '8px 20px', background: 'transparent', border: '1px solid var(--border)', borderRadius: 'var(--radius)', cursor: 'pointer', color: 'var(--text)' }}>取消</button>
                <button onClick={confirmSurrender} style={{ padding: '8px 20px', background: 'var(--danger)', color: '#fff', border: 'none', borderRadius: 'var(--radius)', cursor: 'pointer', fontWeight: 700 }}>确认放弃</button>
              </div>
            </div>
          </div>
        )}

        {/* 连接中弹窗 */}
        {connecting && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}>
            <div style={{ background: 'var(--card)', padding: '32px', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)', textAlign: 'center', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: '2rem', marginBottom: '10px', animation: 'neon-pulse 1.5s infinite' }}>
                {connecting === 'create' ? '🏠' : '🚪'}
              </div>
              <p style={{ fontSize: '1.1rem', fontWeight: 700 }}>
                {connecting === 'create' ? '正在创建房间...' : '正在加入房间...'}
              </p>
              <p style={{ color: 'var(--text-light)', fontSize: '0.8rem', marginTop: '6px' }}>连接服务器中，最多等待 30 秒</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const btn: React.CSSProperties = { padding: '12px 28px', background: 'var(--primary)', color: 'var(--bg)', border: 'none', borderRadius: 'var(--radius)', fontSize: '1rem', fontWeight: 700, cursor: 'pointer' };
const inp: React.CSSProperties = { width: '100%', padding: '10px', background: 'var(--input-bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: '1rem', textAlign: 'center' };
