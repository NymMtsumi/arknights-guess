'use client';

import { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { Header } from '@/components/Header';
import { GameSearch } from '@/components/GameSearch';
import { GuessTable } from '@/components/GuessTable';
import { ScrollSlider } from '@/components/ScrollSlider';
import { useGameStore } from '@/stores/game-store';
import { saveMultiGameStats, type MultiRoundResult } from '@/lib/stats';
import { getUser, getServerUrl, getToken, getPlayerKey } from '@/lib/auth';
import { findCharacterByName } from '@/lib/game-engine';
import type { Character } from '@/types/character';
import charactersData from '@/data/characters.json';

// WebSocket 服务器地址
const WS_BASE = process.env.NEXT_PUBLIC_WS_URL || 'https://ws.arknights-guess.online';
const allChars = charactersData as Character[];
const NICK_KEY = 'liyiba-nickname';
const ROOM_KEY = 'liyiba-room';
function saveRoomCode(code: string) { try { localStorage.setItem(ROOM_KEY, code); } catch {} }
function loadRoomCode(): string { try { return localStorage.getItem(ROOM_KEY) || ''; } catch { return ''; } }
function clearRoomCode() { try { localStorage.removeItem(ROOM_KEY); } catch {} }

const COL_LABELS = ['姓名', '职业', '子职', '阵营', '星级', '种族', '性别', '年份', '部署', '词缀'];
// 困难模式：隐藏星级列（index 4）
const COL_LABELS_HARD = COL_LABELS.filter((_, i) => i !== 4);
function filterOppGrid(grid: string[][]) {
  return grid.map(row => row.filter((_, i) => i !== 4));
}

function loadNick(): string {
  if (typeof window === 'undefined') return '';
  try { return localStorage.getItem(NICK_KEY) || ''; } catch { return ''; }
}
function saveNick(n: string) {
  try { localStorage.setItem(NICK_KEY, n); } catch {}
}

type Stage = 'menu' | 'lobby' | 'waiting' | 'playing' | 'roundEnd' | 'matchEnd' | 'matchmaking';

export default function MultiplayerPage() {
  const [stage, setStage] = useState<Stage>('menu');
  const [socket, setSocket] = useState<Socket | null>(null);
  const [roomCode, setRoomCode] = useState('');
  const [playerName, setPlayerName] = useState(loadNick);
  const [bestOf, setBestOf] = useState(5);
  const [difficulty, setDifficulty] = useState<string>('hard');
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
  const [connecting, setConnecting] = useState('');
  const [oppDisconnected, setOppDisconnected] = useState(false);
  const [roomExpireTime, setRoomExpireTime] = useState(0);
  const [rematchReady, setRematchReady] = useState(false);
  const [queuePosition, setQueuePosition] = useState(0);
  const [matchDifficulty, setMatchDifficulty] = useState('');
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const connectTimer = useRef<NodeJS.Timeout | null>(null);
  const myColorsRef = useRef<string[][]>([]);
  const roundResultsRef = useRef<MultiRoundResult[]>([]);
  const bestOfRef = useRef(5);
  const oppNameRef = useRef('');
  const roomCodeRef = useRef('');
  const socketRef = useRef<Socket | null>(null);
  const myBoardScrollRef = useRef<HTMLDivElement>(null);
  const oppBoardScrollRef = useRef<HTMLDivElement>(null);

  // 页面加载时自动重连已保存的房间
  useEffect(() => {
    const savedCode = loadRoomCode();
    if (!savedCode) return;
    if (socketRef.current?.connected) return;
    const s = connect();
    s.emit("reconnect_room", { code: savedCode });
    s.emit("_log", { action: "auto_reconnect" });
    connectTimer.current = setTimeout(() => { s.disconnect(); setConnecting(""); }, 15000);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Set default player name from auth or guest identity
  useEffect(() => {
    if (loadNick()) return; // User already has a saved name

    const user = getUser();
    if (user) {
      const name = user.nickname || user.username;
      if (name) setPlayerName(name.slice(0, 4));
      return;
    }

    // Not logged in — fetch guest identity
    fetch(`${getServerUrl()}/api/guest-identity`)
      .then(res => res.json())
      .then(data => {
        if (data.displayName) setPlayerName(data.displayName.slice(0, 4));
      })
      .catch(() => {}); // Silently fail
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep refs in sync for socket event handlers
  useEffect(() => { bestOfRef.current = bestOf; }, [bestOf]);
  useEffect(() => { oppNameRef.current = oppName; }, [oppName]);

  const store = useGameStore();

  const clearConnecting = () => {
    if (connectTimer.current) { clearTimeout(connectTimer.current); connectTimer.current = null; }
    setConnecting('');
  };

  const connect = () => {
    // 如果已有活跃连接，先断开旧的
    if (socketRef.current?.connected) {
      socketRef.current.removeAllListeners();
      socketRef.current.disconnect();
    }
    const s = io(WS_BASE, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: 10,
      autoConnect: false,
      auth: { token: getToken() || '', pk: getPlayerKey() || '' },
    });

    // 在连接前注册事件监听器（避免漏掉服务器自动恢复事件）
    s.on('connect_error', (err) => { clearConnecting(); setError('服务器连接失败：' + (err?.message || '')); s.disconnect(); });
    s.on('connect_timeout', () => { clearConnecting(); setError('连接超时，请检查网络'); });
    s.on('error_msg', (d: any) => { clearConnecting(); setError(d.message); s.disconnect(); });
    s.on('room_expired', (d: any) => {
      clearConnecting();
      clearRoomCode();
      setStage('menu');
      setError(d?.message || '房间已过期');
    });
    s.on('existing_room', (d: any) => {
      clearConnecting();
      setRoomCode(d.code); roomCodeRef.current = d.code; saveRoomCode(d.code);
      setBestOf(d.bestOf); if (d.difficulty) setDifficulty(d.difficulty);
      if (d.started) { setStage('playing'); setMyWins(d.wins||0); }
      else { setRoomExpireTime(Date.now() + 120_000); setStage('waiting'); }
    });

    // 接收服务器 Cookie 设置指令（同步到 localStorage，作为客户端 pk 的唯一来源）
    s.on('set_cookie', (d: any) => {
      if (typeof document !== 'undefined') {
        try { localStorage.setItem('player_key', d.value); } catch {}
      }
    });
    s.io.on('reconnect', () => {
      const code = roomCodeRef.current;
      if (code) s.emit('reconnect_room', { code });
    });

    s.on('room_created', (d) => { clearConnecting(); setRoomCode(d.code); roomCodeRef.current = d.code; saveRoomCode(d.code); setBestOf(d.bestOf); setRoomExpireTime(Date.now() + 120_000); setStage('waiting'); });
    // 重连后恢复完整游戏状态
    s.on("reconnect_state", (d) => {
      clearConnecting();
      setRoomCode(d.code); roomCodeRef.current = d.code; saveRoomCode(d.code);
      setBestOf(d.bestOf); if (d.difficulty) setDifficulty(d.difficulty);
      setStage("playing");
      // 使用服务器提供的剩余时间，仅在有活跃回合时启动倒计时
      const hasActiveRound = d.hasActiveRound !== false;
      const remaining = typeof d.remainingTime === 'number' ? Math.max(0, d.remainingTime) : 120;
      if (hasActiveRound && remaining > 0) {
        setTimeLeft(remaining);
      } else {
        setTimeLeft(0); // 回合间隙，不显示倒计时
      }
      setOppGuessCount(0); setOppGrid([]);
      setISurrendered(false); setOppSurrendered(false);
      setOppDisconnected(false);
      setRoundEndData(null); myColorsRef.current = [];
      const me = s.id;
      const opp = d.players.find((p: any) => p.id !== me);
      if (opp) { setOppName(opp.name); setOppWins(opp.wins); }
      const meP = d.players.find((p: any) => p.id === me);
      if (meP) setMyWins(meP.wins);
      const target = d.target?.name ? findCharacterByName(allChars, d.target.name) : null;
      if (target) {
        // 保留当前猜测（不清空 guesses），防止 Socket.IO 自动重连时猜词记录消失
        const existingGuesses = useGameStore.getState().guesses;
        useGameStore.setState({ status: "playing", target, remainingGuesses: Math.max(0, 8 - existingGuesses.length), difficulty: "hard" });
      }
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      if (hasActiveRound && remaining > 0) {
        timerRef.current = setInterval(() => {
          setTimeLeft(t => { if (t <= 1) { clearInterval(timerRef.current!); timerRef.current = null; return 0; } return t - 1; });
        }, 1000);
      }
    });

    s.on('round_start', (d) => {
      clearConnecting();
      if (d.difficulty) setDifficulty(d.difficulty);
      setStage('playing');
      // 使用服务器提供的时间限制（毫秒→秒）
      const roundSec = typeof d.timeLimit === 'number' ? Math.ceil(d.timeLimit / 1000) : 120;
      setTimeLeft(roundSec);
      setOppGuessCount(0); setOppGrid([]);
      setISurrendered(false); setOppSurrendered(false);
      setOppDisconnected(false);
      setRoundEndData(null); myColorsRef.current = [];
      const me = s.id;
      const opp = d.players.find((p: any) => p.id !== me);
      if (opp) { setOppName(opp.name); setOppWins(opp.wins); }
      const meP = d.players.find((p: any) => p.id === me);
      if (meP) setMyWins(meP.wins);
      const target = d.target?.name ? findCharacterByName(allChars, d.target.name) : null;
      if (target) {
        useGameStore.setState({ status: 'playing', target, guesses: [], remainingGuesses: 8, difficulty: 'hard' });
      } else {
        console.error('[round_start] Target not found in local data:', d.target?.name);
      }
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      timerRef.current = setInterval(() => {
        setTimeLeft(t => { if (t <= 1) { clearInterval(timerRef.current!); timerRef.current = null; return 0; } return t - 1; });
      }, 1000);
    });

    s.on('opponent_update', (d) => { setOppGuessCount(d.guessCount); if (d.allComparisons?.length) setOppGrid(d.allComparisons); });
    s.on('opponent_surrendered', (d) => { setOppSurrendered(true); });
    s.on('opponent_disconnected', (d) => { setOppDisconnected(true); });
    s.on('opponent_reconnected', (d) => { setOppDisconnected(false); });

    s.on('round_end', (d) => {
      setStage('roundEnd'); setRoundEndData(d);
      // 记录本小局结果
      const mySid = s.id as string;
      const state = useGameStore.getState();
      roundResultsRef.current.push({
        targetName: d.targetName || '?',
        won: d.winner === mySid,
        guessCount: state.guesses.length,
      });
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    });

    s.on('match_end', (d) => {
      // 比赛结束时保存详细统计
      const mySid = s.id as string;
      // 使用服务器返回的结构化玩家数据计算得分
      const players = d.players || [];
      const me = players.find((p: { id: string }) => p.id === mySid);
      const opp = players.find((p: { id: string }) => p.id !== mySid);
      const myScore = me?.wins || 0;
      const oppScore = opp?.wins || 0;
      saveMultiGameStats({
        won: d.winner === mySid,
        bestOf: bestOfRef.current || 1,
        myScore,
        opponentScore: oppScore,
        opponentName: oppNameRef.current || '对手',
        rounds: [...roundResultsRef.current],
      });
      roundResultsRef.current = [];
      clearRoomCode();
      setStage('matchEnd');
      setEndMsg(d.reason === 'disconnect' ? `${d.winnerName} 获胜（对方断线超30秒）` : `${d.winnerName} 赢得比赛！\n${d.score}`);
      // 不 disconnect，保留连接给再理一把
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    });

    s.on('rematch_start', (d) => {
      setStage('playing'); setMyWins(0); setOppWins(0);
      setRematchReady(false);
      setBestOf(d.bestOf);
      setTimeLeft(120); setOppGuessCount(0); setOppGrid([]);
      setISurrendered(false); setOppSurrendered(false);
      roundResultsRef.current = [];
      setOppDisconnected(false); setRoundEndData(null);
      myColorsRef.current = [];
      useGameStore.setState({ status: 'idle', target: null, guesses: [], remainingGuesses: 8, difficulty: 'hard' });
    });

    // 对手取消再理一把
    s.on('rematch_cancelled', (d: any) => {
      setError(`${d?.playerName || '对手'} 取消了准备`);
      setTimeout(() => setError(''), 3000);
    });

    // === 匹配队列事件 ===
    s.on('matchmaking:status', (d: any) => {
      if (d.queued) {
        setQueuePosition(d.position);
        setMatchDifficulty(d.difficulty);
        setStage('matchmaking');
        clearConnecting();
      } else {
        // 离开队列
        setStage('menu');
        setQueuePosition(0);
        setMatchDifficulty('');
      }
    });

    s.on('matchmaking:matched', (d: any) => {
      clearConnecting();
      setRoomCode(d.roomCode);
      roomCodeRef.current = d.roomCode;
      saveRoomCode(d.roomCode);
      setBestOf(d.bestOf);
      if (d.difficulty) setDifficulty(d.difficulty);
      setOppName(d.opponent.name);
      setMyWins(0);
      setOppWins(0);
      setOppGuessCount(0);
      setOppGrid([]);
      setTimeLeft(120);
      setISurrendered(false);
      setOppSurrendered(false);
      setOppDisconnected(false);
      setRoundEndData(null);
      myColorsRef.current = [];
      setQueuePosition(0);
      setMatchDifficulty('');
      // round_start 会紧随其后，触发 stage → 'playing'
    });

    // 全部监听器就绪后才连接
    s.connect();
    setSocket(s); socketRef.current = s;
    return s;
  };

  const handleCreate = () => {
    clearConnecting();
    if (!playerName.trim() || playerName.trim().length > 4) { setError('昵称最多4个汉字'); return; }
    setError(''); saveNick(playerName.trim()); setConnecting('create');
    const s = connect();
    s.emit('create_room', { playerName: playerName.trim(), bestOf, difficulty });
    s.emit('_log', { action: 'create_room' });
    connectTimer.current = setTimeout(() => { s.disconnect(); setConnecting(''); setError('创建超时'); }, 30000);
  };

  const handleJoin = () => {
    clearConnecting();
    if (!playerName.trim() || !roomCode.trim()) { setError('请输入昵称和房间码'); return; }
    if (playerName.trim().length > 4) { setError('昵称最多4个汉字'); return; }
    setError(''); saveNick(playerName.trim()); setConnecting('join');
    roomCodeRef.current = roomCode.trim().toUpperCase();
    saveRoomCode(roomCodeRef.current);
    const s = connect();
    s.emit('join_room', { code: roomCodeRef.current, playerName: playerName.trim() });
    s.emit('_log', { action: 'join_room' });
    connectTimer.current = setTimeout(() => { s.disconnect(); setConnecting(''); setError('加入超时'); }, 30000);
  };

  const handleQuickMatch = () => {
    clearConnecting();
    if (!playerName.trim() || playerName.trim().length > 4) { setError('昵称最多4个汉字'); return; }
    setError(''); saveNick(playerName.trim()); setConnecting('quickmatch');
    const s = connect();
    s.emit('matchmaking:join', { playerName: playerName.trim(), difficulty, bestOf });
    s.emit('_log', { action: 'quickmatch' });
    connectTimer.current = setTimeout(() => { s.disconnect(); setConnecting(''); setError('匹配超时，请重试'); }, 60000);
  };

  const handleLeaveQueue = () => {
    const s = socketRef.current;
    if (s?.connected) {
      s.emit('matchmaking:leave');
      s.emit('_log', { action: 'leave_queue' });
    }
    setStage('menu');
    setQueuePosition(0);
    setMatchDifficulty('');
    setConnecting('');
    if (connectTimer.current) { clearTimeout(connectTimer.current); connectTimer.current = null; }
  };

  // 等待页面倒计时每秒刷新
  const [, setTick] = useState(0);
  useEffect(() => {
    if (stage !== 'waiting') return;
    const t = setInterval(() => setTick(x => x + 1), 1000);
    return () => clearInterval(t);
  }, [stage]);

  const handleGuess = (char: Character) => {
    if (useGameStore.getState().status !== 'playing') return;
    store.submitGuess(char.name);
    const s = useGameStore.getState();
    if (s.guesses.length) {
      const latest = s.guesses[s.guesses.length - 1];
      const comp = latest.comparisons;
      myColorsRef.current = [...myColorsRef.current, [
        latest.character.id === s.target?.id ? 'correct' : 'wrong',
        comp.class, comp.subclass, comp.faction, comp.rarity, comp.race,
        comp.gender, comp.releaseYear, comp.position, comp.tags,
      ]];
    }
    const sock = socketRef.current;
    if (sock?.connected) {
      sock.emit('guess_update', { guessCount: s.guesses.length, allComparisons: myColorsRef.current });
      if (s.status === 'won') sock.emit('player_win_round', { targetName: s.target?.name || '' });
    }
  };

  const handleSurrender = () => setShowSurrenderConfirm(true);
  const confirmSurrender = () => {
    setShowSurrenderConfirm(false);
    const sock = socketRef.current;
    if (!sock?.connected || useGameStore.getState().status !== 'playing') return;
    setISurrendered(true);
    sock.emit('surrender_round', { targetName: store.target?.name || '' });
    store.giveUp();
  };

  const handleRematch = () => {
    setRematchReady(true);
    socketRef.current?.emit('rematch_ready');
    // 60秒超时自动取消，通知服务器
    setTimeout(() => {
      setRematchReady(prev => {
        if (prev) {
          socketRef.current?.emit('rematch_cancel');
          return false;
        }
        return prev;
      });
    }, 60000);
  };

  const handleCancelRematch = () => {
    setRematchReady(false);
    socketRef.current?.emit('rematch_cancel');
  };

  useEffect(() => { return () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } if (socket) { socket.removeAllListeners(); socket.disconnect(); } }; }, [socket]);

  const guessedIds = new Set(store.guesses.map(g => g.character.id));
  const inputDisabled = useGameStore.getState().status !== 'playing' || iSurrendered;

  return (
    <div className="page">
      <Header />
      <div className="page-scroll" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: 'clamp(12px,2vw,28px) var(--page-inline)' }}>

        {/* ===== 菜单 ===== */}
        {stage === 'menu' && (
          <div style={{ textAlign: 'center', maxWidth: '450px' }}>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(1.5rem,4vw,2rem)', fontStyle: 'italic', fontWeight: 900, marginBottom: '16px' }}>⚔️ 多人对战</h1>
            <p style={{ color: 'var(--text-light)', fontSize: '0.9rem', marginBottom: '14px' }}>BO3 / BO5 / BO7 · 每局 2 分钟 · 先达胜场者胜</p>
            <input value={playerName} onChange={e => setPlayerName(e.target.value)} placeholder="昵称（最多4个字）" style={{ ...inp, marginBottom: '10px', maxWidth: '240px' }} maxLength={4} />
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', marginBottom: '12px', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', gap: '8px', flexBasis: '100%', justifyContent: 'center', marginBottom: '4px' }}>
                {['easy','medium','hard'].map(d => (
                  <button key={d} onClick={() => setDifficulty(d)} style={{
                    padding: '5px 12px', fontSize: '0.8rem', background: difficulty===d?'var(--primary)':'transparent',
                    color: difficulty===d?'var(--bg)':'var(--text)', border: `1px solid ${difficulty===d?'var(--primary)':'var(--border)'}`,
                    borderRadius: 'var(--radius)', cursor:'pointer', fontWeight: difficulty===d?700:400,
                  }}>{d==='easy'?'简单':d==='medium'?'普通':'困难'}</button>
                ))}
              </div>
            {/* 快速匹配按钮 */}
            <button onClick={handleQuickMatch} disabled={!!connecting} style={{
              width: '100%', padding: '12px 20px', background: connecting ? 'var(--card-soft)' : 'var(--accent)', color: connecting ? 'var(--text-light)' : '#fff',
              border: 'none', borderRadius: 'var(--radius)', fontSize: '1.05rem', fontWeight: 700,
              cursor: connecting ? 'default' : 'pointer', marginTop: '4px', opacity: connecting ? 0.7 : 1,
            }}>{connecting ? '连接中...' : '⚡ 快速匹配'}</button>
              <div style={{ display: 'flex', gap: '8px' }}>
              {[3,5,7].map(n => (
                <button key={n} onClick={() => setBestOf(n)} style={{
                  padding: '6px 16px', background: bestOf === n ? 'var(--primary)' : 'transparent',
                  color: bestOf === n ? 'var(--bg)' : 'var(--text)', border: `1px solid ${bestOf === n ? 'var(--primary)' : 'var(--border)'}`,
                  borderRadius: 'var(--radius)', cursor: 'pointer', fontWeight: bestOf === n ? 700 : 400,
                }}>BO{n}</button>
              ))}
            </div>
            {error && <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginTop: '8px' }}>{error}</p>}
            {/* 我的房间 */}
            {loadRoomCode() && (
              <div style={{ width: '100%', maxWidth: '320px', padding: '12px', background: 'var(--card-soft)', borderRadius: 'var(--radius)', border: '1px solid var(--primary)', marginBottom: '12px', marginTop: '12px' }}>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-light)', marginBottom: '4px' }}>📋 上次房间</p>
                <p style={{ fontSize: '1.3rem', fontFamily: 'monospace', fontWeight: 900, color: 'var(--primary)' }}>{loadRoomCode()}</p>
                <button onClick={() => { setConnecting('join'); const s = connect(); s.emit('reconnect_room', { code: loadRoomCode() }); s.emit('_log', { action: 'quick_rejoin' }); connectTimer.current = setTimeout(() => { s.disconnect(); setConnecting(''); setError('重连超时'); }, 30000); }} style={{ ...btn, marginTop: '8px', padding: '6px 16px', fontSize: '0.9rem' }}>🚪 快速重连</button>
              </div>
            )}
            <button onClick={() => setStage('lobby')} style={{ ...btn, marginTop: '8px' }}>🏠 创建 / 加入房间</button>
          </div>
          </div>
        )}

        {/* ===== 大厅 ===== */}
        {stage === 'lobby' && (
          <div style={{ textAlign: 'center', maxWidth: '400px' }}>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.3rem', fontStyle: 'italic', marginBottom: '12px' }}>
              BO{bestOf} · {bestOf === 3 ? '2胜' : bestOf === 5 ? '3胜' : '4胜'}制
            </h2>
            <input value={playerName} onChange={e => setPlayerName(e.target.value)} placeholder="昵称（最多4个字）" style={inp} maxLength={4} />
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

        {/* ===== 等待 ===== */}
        {stage === 'waiting' && (
          <div style={{ textAlign: 'center' }}>
            {roomExpireTime > 0 && roomExpireTime - Date.now() <= 0 ? (
              <>
                <p style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--danger)', marginBottom: '16px' }}>房间已过期</p>
                <a href="/multiplayer" style={{ padding: '8px 20px', background: 'var(--primary)', color: 'var(--bg)', border: 'none', borderRadius: 'var(--radius)', fontWeight: 700, textDecoration: 'none' }}>返回</a>
              </>
            ) : (
              <>
                <p>⏳ 等待对手加入</p>
                <p style={{ fontSize: '3rem', fontFamily: 'monospace', fontWeight: 900, color: 'var(--primary)', margin: '16px 0' }}>{roomCode}</p>
                <p style={{ color: 'var(--text-light)' }}>BO{bestOf} · 分享房间码给好友</p>
                <p style={{ color: 'var(--text-light)', fontSize: '0.8rem', marginTop: '8px' }}>
                  房间将在 {Math.max(0, Math.ceil((roomExpireTime - Date.now()) / 1000))} 秒后自动解散
                </p>
              </>
            )}
          </div>
        )}

        {/* ===== 匹配中 ===== */}
        {stage === 'matchmaking' && (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '2.5rem', marginBottom: '10px', animation: 'neon-pulse 1.5s infinite' }}>⚡</div>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.3rem', fontStyle: 'italic', fontWeight: 700, marginBottom: '8px' }}>
              正在寻找对手...
            </h2>
            <p style={{ color: 'var(--text-light)', fontSize: '0.9rem', marginBottom: '8px' }}>
              难度：{matchDifficulty === 'easy' ? '简单' : matchDifficulty === 'medium' ? '普通' : '困难'} · BO{bestOf}
            </p>
            {queuePosition > 0 && (
              <p style={{ color: 'var(--text-light)', fontSize: '0.85rem', marginBottom: '16px' }}>
                队列位置：第 {queuePosition} 位
              </p>
            )}
            <button onClick={handleLeaveQueue} style={{
              padding: '10px 24px', background: 'transparent', color: 'var(--text)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius)',
              fontWeight: 700, cursor: 'pointer', fontSize: '0.9rem',
            }}>取消匹配</button>
          </div>
        )}

        {/* ===== 对战中 ===== */}
        {stage === 'playing' && (
          <div style={{ width: '100%' }}>
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginBottom: '12px', padding: '10px 12px', background: 'var(--card)', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
              <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>{playerName} <span style={{ color: 'var(--primary)', fontWeight: 900 }}>{myWins}</span></span>
              <span style={{ fontSize: '1.2rem', fontFamily: 'monospace', fontWeight: 900, color: timeLeft <= 30 ? 'var(--danger)' : 'var(--primary)' }}>
                {String(Math.floor(timeLeft/60)).padStart(2,'0')}:{String(timeLeft%60).padStart(2,'0')}
              </span>
              <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>{oppName} <span style={{ color: 'var(--accent)', fontWeight: 900 }}>{oppWins}</span></span>
            </div>
            {oppDisconnected && (
              <div style={{ textAlign: 'center', marginBottom: '8px', color: 'var(--warning)', fontSize: '0.85rem' }}>
                ⚠ {oppName} 断线中 · 30 秒未重连将判负
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'center', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
              <GameSearch onGuess={handleGuess} disabled={inputDisabled} guessedIds={guessedIds} target={store.target} />
              {!inputDisabled && <button onClick={handleSurrender} style={{ padding: '8px 12px', background: 'transparent', color: 'var(--danger)', border: '1px solid var(--danger)', borderRadius: 'var(--radius)', cursor: 'pointer', fontSize: '0.8rem' }}>放弃本局</button>}
              {iSurrendered && <span style={{ color: 'var(--warning)', fontSize: '0.8rem', alignSelf: 'center' }}>你已放弃</span>}
              {oppSurrendered && <span style={{ color: 'var(--warning)', fontSize: '0.8rem', alignSelf: 'center' }}>对手已放弃</span>}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
              <div style={{ flex: '1 1 48%', minWidth: '280px' }}>
                <div style={{ fontWeight: 700, marginBottom: '4px', fontSize: '0.85rem', color: 'var(--primary)' }}>你的猜测</div>
                <div ref={myBoardScrollRef} style={{ overflowX: 'auto', scrollBehavior: 'smooth' }} className="scroll-slider-container"><GuessTable guesses={store.guesses} target={store.target} hideRarity={difficulty === 'hard'} /></div>
                <ScrollSlider containerRef={myBoardScrollRef} />
              </div>
              <div style={{ flex: '1 1 48%', minWidth: '280px' }}>
                <div style={{ fontWeight: 700, marginBottom: '4px', fontSize: '0.85rem', color: 'var(--accent)' }}>{oppName}（{oppGuessCount}次）</div>
                <div ref={oppBoardScrollRef} style={{ overflowX: 'auto', scrollBehavior: 'smooth' }} className="scroll-slider-container">
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.65rem' }}>
                    <thead><tr>{(difficulty==='hard'?COL_LABELS_HARD:COL_LABELS).map((l,i)=><th key={i} style={{padding:'3px 2px',fontWeight:600,color:'var(--text-light)',borderBottom:'1px solid var(--border)',whiteSpace:'nowrap'}}>{l}</th>)}</tr></thead>
                    <tbody>
                      {oppGrid.length===0
                        ? <tr><td colSpan={difficulty==='hard'?9:10} style={{padding:'16px',textAlign:'center',color:'var(--text-light)',fontSize:'0.75rem'}}>等待对手猜测...</td></tr>
                        : [...(difficulty==='hard'?filterOppGrid(oppGrid):oppGrid)].reverse().map((row,i)=>(
                          <tr key={i} style={{animation:'surface-enter 0.35s both'}}>
                            {row.map((color,j)=>(
                              <td key={j} style={{padding:'3px 2px',textAlign:'center'}}>
                                <span style={{display:'inline-block',width:'12px',height:'12px',borderRadius:'2px',background:color==='correct'?'var(--correct)':color==='close'?'var(--close)':color==='wrong'?'var(--wrong)':'#444'}}/>
                              </td>
                            ))}
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
                <ScrollSlider containerRef={oppBoardScrollRef} />
              </div>
            </div>
          </div>
        )}

        {/* ===== 局结束 ===== */}
        {stage === 'roundEnd' && roundEndData && (
          <div style={{ textAlign: 'center', maxWidth: '400px', marginTop: '16px' }}>
            <div style={{ fontSize: '2rem', marginBottom: '6px' }}>
              {roundEndData.winner ? (roundEndData.winner === socket?.id ? '🎉 你赢了本局' : '😔 对手拿下本局') : '🤝 本局平局'}
            </div>
            <p style={{ color: 'var(--text-light)', fontSize: '0.85rem' }}>答案：{roundEndData.targetName} · {roundEndData.score}</p>
            {roundEndData.matchOver
              ? <div style={{ marginTop: '12px' }}><p style={{ color: 'var(--text-light)', fontSize: '0.9rem' }}>比赛结束！{roundEndData.score}</p></div>
              : <p style={{ color: 'var(--text-light)', fontSize: '0.8rem' }}>等待服务器...</p>
            }
          </div>
        )}

        {/* ===== 比赛结束 ===== */}
        {stage === 'matchEnd' && (
          <div style={{ textAlign: 'center', maxWidth: '400px', marginTop: '16px' }}>
            <div style={{ fontSize: '2.5rem', marginBottom: '10px' }}>🏆</div>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.2rem', fontStyle: 'italic', fontWeight: 900, whiteSpace: 'pre-line' }}>{endMsg}</h2>
            <div style={{ marginTop: '16px', display: 'flex', gap: '12px', justifyContent: 'center', flexWrap: 'wrap' }}>
              <button onClick={handleRematch} disabled={rematchReady} style={{
                padding: '10px 24px', background: rematchReady ? 'var(--card-soft)' : 'var(--primary)',
                color: rematchReady ? 'var(--text-light)' : 'var(--bg)', border: 'none', borderRadius: 'var(--radius)',
                fontWeight: 700, cursor: rematchReady ? 'default' : 'pointer', fontSize: '1rem',
              }}>
                {rematchReady ? '⏳ 等待对手...' : '🔄 再理一把！'}
              </button>
              {rematchReady && (
                <button onClick={handleCancelRematch} style={{
                  padding: '10px 24px', background: 'transparent', color: 'var(--text)',
                  border: '1px solid var(--border)', borderRadius: 'var(--radius)',
                  fontWeight: 700, cursor: 'pointer', fontSize: '0.9rem',
                }}>取消准备</button>
              )}
              <a href="/multiplayer" style={{ padding: '10px 24px', background: 'transparent', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontWeight: 700, textDecoration: 'none' }}>退出</a>
            </div>
          </div>
        )}

        {/* ===== 弹窗 ===== */}
        {showSurrenderConfirm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }}>
            <div style={{ background: 'var(--card)', padding: '24px', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)', textAlign: 'center', maxWidth: '320px' }}>
              <p style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '8px' }}>确定放弃本局？</p>
              <p style={{ color: 'var(--text-light)', fontSize: '0.85rem', marginBottom: '16px' }}>放弃后无法继续猜测</p>
              <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
                <button onClick={()=>setShowSurrenderConfirm(false)} style={{ padding:'8px 20px', background:'transparent', border:'1px solid var(--border)', borderRadius:'var(--radius)', cursor:'pointer', color:'var(--text)' }}>取消</button>
                <button onClick={confirmSurrender} style={{ padding:'8px 20px', background:'var(--danger)', color:'#fff', border:'none', borderRadius:'var(--radius)', cursor:'pointer', fontWeight:700 }}>确认放弃</button>
              </div>
            </div>
          </div>
        )}
        {connecting && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }}>
            <div style={{ background:'var(--card)', padding:'32px', borderRadius:'var(--radius)', textAlign:'center' }}>
              <div style={{ fontSize:'2rem', marginBottom:'10px', animation:'neon-pulse 1.5s infinite' }}>{connecting==='create'?'🏠':connecting==='quickmatch'?'⚡':'🚪'}</div>
              <p style={{ fontSize:'1.1rem', fontWeight:700 }}>{connecting==='create'?'正在创建房间...':connecting==='quickmatch'?'正在寻找对手...':'正在加入房间...'}</p>
              <p style={{ color:'var(--text-light)', fontSize:'0.8rem', marginTop:'6px' }}>{connecting==='quickmatch'?'连接中，最多 60 秒':'连接中，最多 30 秒'}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const btn: React.CSSProperties = { padding:'12px 28px', background:'var(--primary)', color:'var(--bg)', border:'none', borderRadius:'var(--radius)', fontSize:'1rem', fontWeight:700, cursor:'pointer' };
const inp: React.CSSProperties = { width:'100%', padding:'10px', background:'var(--input-bg)', color:'var(--text)', border:'1px solid var(--border)', borderRadius:'var(--radius)', fontSize:'1rem', textAlign:'center' };
