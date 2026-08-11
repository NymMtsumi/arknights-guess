'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import Link from 'next/link';
import { io, Socket } from 'socket.io-client';
import { Header } from '@/components/Header';
import { GameSearch } from '@/components/GameSearch';
import { GuessTable } from '@/components/GuessTable';
import { ScrollSlider } from '@/components/ScrollSlider';
import { useGameStore } from '@/stores/game-store';
import { saveMultiGameStats, type MultiRoundResult } from '@/lib/stats';
import { getUser, getServerUrl, getToken, getPlayerKey } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { findCharacterByName } from '@/lib/game-engine';
import type { Character } from '@/types/character';
import charactersData from '@/data/characters.json';

// NOTE: Socket event payloads use `any` types throughout this file.
// Proper TypeScript interfaces for all socket events would be a future improvement.
// WebSocket server address
const WS_BASE = process.env.NEXT_PUBLIC_WS_URL || 'https://ws.arknights-guess.online';
const allChars = charactersData as Character[];
const ROOM_KEY = 'liyiba-room';
function saveRoomCode(code: string) { try { localStorage.setItem(ROOM_KEY, code); } catch {} }
function loadRoomCode(): string { try { return localStorage.getItem(ROOM_KEY) || ''; } catch { return ''; } }
function clearRoomCode() { try { localStorage.removeItem(ROOM_KEY); } catch {} }

type Stage = 'menu' | 'lobby' | 'waiting' | 'playing' | 'roundEnd' | 'matchEnd' | 'matchmaking';

const DIFF_KEY_MAP: Record<string, string> = {
  easy: 'multi.difficultyEasy',
  medium: 'multi.difficultyMedium',
  hard: 'multi.difficultyHard',
};

export default function MultiplayerPage() {
  const { t } = useI18n();

  // Compute column labels from i18n (used for opponent grid headers)
  const colLabelKeys = ['table.name', 'table.class', 'table.subclass', 'table.faction', 'table.rarity', 'table.race', 'table.gender', 'table.year', 'table.position', 'table.tags'];
  const colLabels = colLabelKeys.map(k => t(k));
  const colLabelsHard = colLabels.filter((_, i) => i !== 4);
  function filterOppGrid(grid: string[][]) {
    return grid.map(row => row.filter((_, i) => i !== 4));
  }

  const [stage, setStage] = useState<Stage>('menu');
  const [socket, setSocket] = useState<Socket | null>(null);
  const [roomCode, setRoomCode] = useState('');
  const [playerName, setPlayerName] = useState('');
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
  const rematchTimer = useRef<NodeJS.Timeout | null>(null);
  const myColorsRef = useRef<string[][]>([]);
  const roundResultsRef = useRef<MultiRoundResult[]>([]);
  const bestOfRef = useRef(5);
  const oppNameRef = useRef('');
  const roomCodeRef = useRef('');
  const socketRef = useRef<Socket | null>(null);
  const myBoardScrollRef = useRef<HTMLDivElement>(null);
  const oppBoardScrollRef = useRef<HTMLDivElement>(null);

  // Auto-reconnect to saved room on page load
  useEffect(() => {
    const savedCode = loadRoomCode();
    if (!savedCode) return;
    if (socketRef.current?.connected) return;
    const s = connect();
    s.emit("reconnect_room", { code: savedCode });
    s.emit("_log", { action: "auto_reconnect" });
    connectTimer.current = setTimeout(() => { s.disconnect(); setConnecting(""); }, 15000);
    return () => {
      if (connectTimer.current) { clearTimeout(connectTimer.current); connectTimer.current = null; }
      // 清理未被 socketRef 持有的 socket（避免孤立连接泄漏）
      if (socketRef.current !== s) { s.disconnect(); }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Derive player name from auth or guest identity (full name, no truncation)
  useEffect(() => {
    const user = getUser();
    if (user) {
      const name = user.nickname || user.username;
      if (name) setPlayerName(name);
      return;
    }

    fetch(`${getServerUrl()}/api/guest-identity`)
      .then(res => res.json())
      .then(data => {
        if (data.displayName) setPlayerName(data.displayName);
      })
      .catch(() => {});
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
    // Disconnect old socket if active
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

    // Register event listeners before connecting
    s.on('connect_error', (err) => { clearConnecting(); setError(t('multi.serverConnectFail', { msg: err?.message || '' })); s.disconnect(); });
    s.on('connect_timeout', () => { clearConnecting(); setError(t('multi.connectTimeout')); });
    s.on('error_msg', (d: any) => { clearConnecting(); setError(d.message); s.disconnect(); });
    s.on('room_expired', (d: any) => {
      clearConnecting();
      clearRoomCode();
      setStage('menu');
      setError(d?.message || t('multi.roomExpired'));
    });
    s.on('existing_room', (d: any) => {
      clearConnecting();
      setRoomCode(d.code); roomCodeRef.current = d.code; saveRoomCode(d.code);
      setBestOf(d.bestOf); if (d.difficulty) setDifficulty(d.difficulty);
      if (d.started) { setStage('playing'); setMyWins(d.wins||0); }
      else { setRoomExpireTime(Date.now() + 120_000); setStage('waiting'); }
    });

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

    s.on("reconnect_state", (d) => {
      clearConnecting();
      setRoomCode(d.code); roomCodeRef.current = d.code; saveRoomCode(d.code);
      setBestOf(d.bestOf); if (d.difficulty) setDifficulty(d.difficulty);
      setStage("playing");
      const hasActiveRound = d.hasActiveRound !== false;
      const remaining = typeof d.remainingTime === 'number' ? Math.max(0, d.remainingTime) : 120;
      if (hasActiveRound && remaining > 0) { setTimeLeft(remaining); }
      else { setTimeLeft(0); }
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
      const mySid = s.id as string;
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
        opponentName: oppNameRef.current || 'Opponent',
        rounds: [...roundResultsRef.current],
      });
      roundResultsRef.current = [];
      clearRoomCode();
      setStage('matchEnd');
      setEndMsg(
        d.reason === 'both_disconnected' ? t('multi.matchEndBothDisconnected')
        : d.reason === 'disconnect' ? t('multi.matchEndDisconnect', { name: d.winnerName })
        : d.winner === null ? t('multi.matchEndDraw')
        : t('multi.matchEndWin', { name: d.winnerName, score: d.score })
      );
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

    s.on('rematch_cancelled', (d: any) => {
      setError(t('multi.rematchCancelled', { name: d?.playerName || '' }));
      setTimeout(() => setError(''), 3000);
    });

    // Matchmaking queue events
    s.on('matchmaking:status', (d: any) => {
      if (d.queued) {
        setQueuePosition(d.position);
        setMatchDifficulty(d.difficulty);
        setStage('matchmaking');
        clearConnecting();
      } else {
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
      setMyWins(0); setOppWins(0);
      setOppGuessCount(0); setOppGrid([]);
      setTimeLeft(120);
      setISurrendered(false); setOppSurrendered(false);
      setOppDisconnected(false);
      setRoundEndData(null); myColorsRef.current = [];
      setQueuePosition(0); setMatchDifficulty('');
    });

    s.connect();
    setSocket(s); socketRef.current = s;
    return s;
  };

  const handleCreate = () => {
    clearConnecting();
    if (!playerName.trim()) { setError(t('multi.enterRoomCode')); return; }
    setError(''); setConnecting('create');
    const s = connect();
    s.emit('create_room', { playerName: playerName.trim(), bestOf, difficulty });
    s.emit('_log', { action: 'create_room' });
    connectTimer.current = setTimeout(() => { s.disconnect(); setConnecting(''); setError(t('multi.createTimeout')); }, 30000);
  };

  const handleJoin = () => {
    clearConnecting();
    if (!roomCode.trim()) { setError(t('multi.enterRoomCode')); return; }
    setError(''); setConnecting('join');
    roomCodeRef.current = roomCode.trim().toUpperCase();
    saveRoomCode(roomCodeRef.current);
    const s = connect();
    s.emit('join_room', { code: roomCodeRef.current, playerName: playerName.trim() });
    s.emit('_log', { action: 'join_room' });
    connectTimer.current = setTimeout(() => { s.disconnect(); setConnecting(''); setError(t('multi.joinTimeout')); }, 30000);
  };

  const handleQuickMatch = () => {
    clearConnecting();
    if (!playerName.trim()) { setError(t('multi.enterRoomCode')); return; }
    setError(''); setConnecting('quickmatch');
    const s = connect();
    s.emit('matchmaking:join', { playerName: playerName.trim(), difficulty, bestOf });
    s.emit('_log', { action: 'quickmatch' });
    connectTimer.current = setTimeout(() => { s.disconnect(); setConnecting(''); setError(t('multi.matchTimeout')); }, 60000);
  };

  const handleLeaveQueue = () => {
    const s = socketRef.current;
    if (s?.connected) { s.emit('matchmaking:leave'); s.emit('_log', { action: 'leave_queue' }); }
    setStage('menu'); setQueuePosition(0); setMatchDifficulty(''); setConnecting('');
    if (connectTimer.current) { clearTimeout(connectTimer.current); connectTimer.current = null; }
  };

  // Waiting page countdown tick
  // OPTIMIZATION: This forces a full page re-render every second. Could be extracted
  // into a sub-component (e.g. <WaitingRoom />) to isolate re-renders, but the
  // current approach is acceptable given the low complexity of the waiting view.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (stage !== 'waiting') return;
    const timer = setInterval(() => setTick(x => x + 1), 1000);
    return () => clearInterval(timer);
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
      if (s.status === 'lost') sock.emit('player_exhausted', { targetName: s.target?.name || '' });
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
    if (rematchTimer.current) clearTimeout(rematchTimer.current);
    rematchTimer.current = setTimeout(() => {
      setRematchReady(prev => {
        if (prev) { socketRef.current?.emit('rematch_cancel'); return false; }
        return prev;
      });
    }, 60000);
  };

  const handleCancelRematch = () => {
    setRematchReady(false);
    if (rematchTimer.current) { clearTimeout(rematchTimer.current); rematchTimer.current = null; }
    socketRef.current?.emit('rematch_cancel');
  };

  useEffect(() => { return () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } if (rematchTimer.current) { clearTimeout(rematchTimer.current); rematchTimer.current = null; } if (socket) { socket.removeAllListeners(); socket.disconnect(); } }; }, [socket]);

  const guessedIds = useMemo(() => new Set(store.guesses.map(g => g.character.id)), [store.guesses]);
  const inputDisabled = store.status !== 'playing' || iSurrendered;
  const winTarget = bestOf === 3 ? 2 : bestOf === 5 ? 3 : 4;

  return (
    <div className="page">
      <Header />
      <div className="page-scroll" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: 'clamp(12px,2vw,28px) var(--page-inline)' }}>

        {/* ===== Menu ===== */}
        {stage === 'menu' && (
          <div style={{ textAlign: 'center', maxWidth: '450px' }}>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(1.5rem,4vw,2rem)', fontStyle: 'italic', fontWeight: 900, marginBottom: '16px' }}>⚔️ {t('multi.title')}</h1>
            <p style={{ color: 'var(--text-light)', fontSize: '0.9rem', marginBottom: '14px' }}>{t('multi.description')}</p>
            <div className="multi-select-row">
              <label className="multi-select-wrapper">
                <span className="multi-select-label">{t('multi.difficultyLabel')}</span>
                <select value={difficulty} onChange={e => setDifficulty(e.target.value)} className="multi-select">
                  <option value="easy">{t('multi.difficultyEasy')}</option>
                  <option value="medium">{t('multi.difficultyMedium')}</option>
                  <option value="hard">{t('multi.difficultyHard')}</option>
                </select>
              </label>
              <label className="multi-select-wrapper">
                <span className="multi-select-label">{t('multi.formatLabel')}</span>
                <select value={bestOf} onChange={e => setBestOf(Number(e.target.value))} className="multi-select">
                  <option value={3}>BO3</option>
                  <option value={5}>BO5</option>
                  <option value={7}>BO7</option>
                </select>
              </label>
            </div>
            <button onClick={handleQuickMatch} disabled={!!connecting} style={{
              width: '100%', padding: '12px 20px', background: connecting ? 'var(--card-soft)' : 'var(--accent)', color: connecting ? 'var(--text-light)' : '#fff',
              border: 'none', borderRadius: 'var(--radius)', fontSize: '1.05rem', fontWeight: 700,
              cursor: connecting ? 'default' : 'pointer', marginTop: '4px', opacity: connecting ? 0.7 : 1,
            }}>{connecting ? t('multi.connecting') : '⚡ ' + t('multi.quickMatch')}</button>
            {error && <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginTop: '8px' }}>{error}</p>}
            {loadRoomCode() && (
              <div style={{ width: '100%', maxWidth: '320px', padding: '12px', background: 'var(--card-soft)', borderRadius: 'var(--radius)', border: '1px solid var(--primary)', marginBottom: '12px', marginTop: '12px' }}>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-light)', marginBottom: '4px' }}>📋 {t('multi.lastRoom')}</p>
                <p style={{ fontSize: '1.3rem', fontFamily: 'monospace', fontWeight: 900, color: 'var(--primary)' }}>{loadRoomCode()}</p>
                <button onClick={() => { const code = loadRoomCode(); setConnecting('join'); const s = connect(); s.emit('reconnect_room', { code }); s.emit('_log', { action: 'quick_rejoin' }); connectTimer.current = setTimeout(() => { s.disconnect(); setConnecting(''); setError(t('multi.reconnectTimeout')); }, 30000); }} style={{ ...btn, marginTop: '8px', padding: '6px 16px', fontSize: '0.9rem' }}>🚪 {t('multi.quickRejoin')}</button>
              </div>
            )}
            <button onClick={() => setStage('lobby')} style={{ ...btn, marginTop: '8px' }}>🏠 {t('multi.createJoinRoom')}</button>
          </div>
        )}

        {/* ===== Lobby ===== */}
        {stage === 'lobby' && (
          <div style={{ textAlign: 'center', maxWidth: '400px' }}>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.3rem', fontStyle: 'italic', marginBottom: '12px' }}>
              BO{bestOf} · {t('multi.winFormat', { n: winTarget })}制
            </h2>
            <div style={{ marginTop: '12px' }}>
              <button onClick={handleCreate} style={btn}>{t('multi.createRoom')}</button>
            </div>
            <div style={{ marginTop: '16px', padding: '12px', borderTop: '1px solid var(--border)' }}>
              <input value={roomCode} onChange={e => setRoomCode(e.target.value.replace(/\D/g,''))} placeholder={t('multi.roomCodePlaceholder')} style={{ ...inp, marginBottom: '8px' }} maxLength={4} inputMode="numeric" />
              <button onClick={handleJoin} style={{ ...btn, background: 'var(--accent)' }}>{t('multi.joinRoom')}</button>
            </div>
            {error && <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginTop: '12px' }}>{error}</p>}
          </div>
        )}

        {/* ===== Waiting ===== */}
        {stage === 'waiting' && (
          <div style={{ textAlign: 'center' }}>
            {roomExpireTime > 0 && roomExpireTime - Date.now() <= 0 ? (
              <>
                <p style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--danger)', marginBottom: '16px' }}>{t('multi.roomExpired')}</p>
                <Link href="/multiplayer" style={{ padding: '8px 20px', background: 'var(--primary)', color: 'var(--bg)', border: 'none', borderRadius: 'var(--radius)', fontWeight: 700, textDecoration: 'none' }}>{t('multi.back')}</Link>
              </>
            ) : (
              <>
                <p>⏳ {t('multi.waitingOpponent')}</p>
                <p style={{ fontSize: '3rem', fontFamily: 'monospace', fontWeight: 900, color: 'var(--primary)', margin: '16px 0' }}>{roomCode}</p>
                <p style={{ color: 'var(--text-light)' }}>{t('multi.shareRoom', { bo: bestOf })}</p>
                <p style={{ color: 'var(--text-light)', fontSize: '0.8rem', marginTop: '8px' }}>
                  {t('multi.roomExpireIn', { seconds: Math.max(0, Math.ceil((roomExpireTime - Date.now()) / 1000)) })}
                </p>
              </>
            )}
          </div>
        )}

        {/* ===== Matchmaking ===== */}
        {stage === 'matchmaking' && (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '2.5rem', marginBottom: '10px', animation: 'neon-pulse 1.5s infinite' }}>⚡</div>
            <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.3rem', fontStyle: 'italic', fontWeight: 700, marginBottom: '8px' }}>
              {t('multi.searching')}
            </h2>
            <p style={{ color: 'var(--text-light)', fontSize: '0.9rem', marginBottom: '8px' }}>
              {t('multi.matchDifficultyAndBo', { difficulty: t(DIFF_KEY_MAP[matchDifficulty] || 'multi.difficultyHard'), bo: bestOf })}
            </p>
            {queuePosition > 0 && (
              <p style={{ color: 'var(--text-light)', fontSize: '0.85rem', marginBottom: '16px' }}>
                {t('multi.queuePosition', { position: queuePosition })}
              </p>
            )}
            <button onClick={handleLeaveQueue} style={{
              padding: '10px 24px', background: 'transparent', color: 'var(--text)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius)',
              fontWeight: 700, cursor: 'pointer', fontSize: '0.9rem',
            }}>{t('multi.cancelMatch')}</button>
          </div>
        )}

        {/* ===== Playing ===== */}
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
                ⚠ {t('multi.oppDisconnected', { name: oppName })}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'center', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
              <GameSearch onGuess={handleGuess} disabled={inputDisabled} guessedIds={guessedIds} target={store.target} remainingGuesses={store.remainingGuesses} />
              {!inputDisabled && <button onClick={handleSurrender} style={{ padding: '8px 12px', background: 'transparent', color: 'var(--danger)', border: '1px solid var(--danger)', borderRadius: 'var(--radius)', cursor: 'pointer', fontSize: '0.8rem' }}>{t('multi.surrender')}</button>}
              {iSurrendered && <span style={{ color: 'var(--warning)', fontSize: '0.8rem', alignSelf: 'center' }}>{t('multi.youSurrendered')}</span>}
              {oppSurrendered && <span style={{ color: 'var(--warning)', fontSize: '0.8rem', alignSelf: 'center' }}>{t('multi.oppSurrendered')}</span>}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
              <div style={{ flex: '1 1 48%', minWidth: '280px' }}>
                <div style={{ fontWeight: 700, marginBottom: '4px', fontSize: '0.85rem', color: 'var(--primary)' }}>{t('multi.yourGuesses')}</div>
                <div ref={myBoardScrollRef} style={{ overflowX: 'auto', scrollBehavior: 'smooth' }} className="scroll-slider-container"><GuessTable guesses={store.guesses} target={store.target} hideRarity={difficulty === 'hard'} staggerKey={store.guesses.length} /></div>
                <ScrollSlider containerRef={myBoardScrollRef} />
              </div>
              <div style={{ flex: '1 1 48%', minWidth: '280px' }}>
                <div style={{ fontWeight: 700, marginBottom: '4px', fontSize: '0.85rem', color: 'var(--accent)' }}>{t('multi.oppGuesses', { name: oppName, count: oppGuessCount })}</div>
                <div ref={oppBoardScrollRef} style={{ overflowX: 'auto', scrollBehavior: 'smooth' }} className="scroll-slider-container">
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.65rem' }}>
                    <thead><tr>{(difficulty==='hard'?colLabelsHard:colLabels).map((l,i)=><th key={i} style={{padding:'3px 2px',fontWeight:600,color:'var(--text-light)',borderBottom:'1px solid var(--border)',whiteSpace:'nowrap'}}>{l}</th>)}</tr></thead>
                    <tbody>
                      {oppGrid.length===0
                        ? <tr><td colSpan={difficulty==='hard'?9:10} style={{padding:'16px',textAlign:'center',color:'var(--text-light)',fontSize:'0.75rem'}}>{t('multi.waitingOppGuess')}</td></tr>
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

        {/* ===== Round End ===== */}
        {stage === 'roundEnd' && roundEndData && (
          <div style={{ textAlign: 'center', maxWidth: '400px', marginTop: '16px' }}>
            <div style={{ fontSize: '2rem', marginBottom: '6px' }}>
              {roundEndData.winner ? (roundEndData.winner === socket?.id ? '🎉 ' + t('multi.youWinRound') : '😔 ' + t('multi.oppWinRound')) : '🤝 ' + t('multi.roundDraw')}
            </div>
            <p style={{ color: 'var(--text-light)', fontSize: '0.85rem' }}>{t('multi.answerWithScore', { name: roundEndData.targetName, score: roundEndData.score })}</p>
            {roundEndData.matchOver
              ? <div style={{ marginTop: '12px' }}><p style={{ color: 'var(--text-light)', fontSize: '0.9rem' }}>{t('multi.matchOver', { score: roundEndData.score })}</p></div>
              : <p style={{ color: 'var(--text-light)', fontSize: '0.8rem' }}>{t('multi.waitingServer')}</p>
            }
          </div>
        )}

        {/* ===== Match End ===== */}
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
                {rematchReady ? '⏳ ' + t('multi.waitingOpp') : '🔄 ' + t('multi.playAgain')}
              </button>
              {rematchReady && (
                <button onClick={handleCancelRematch} style={{
                  padding: '10px 24px', background: 'transparent', color: 'var(--text)',
                  border: '1px solid var(--border)', borderRadius: 'var(--radius)',
                  fontWeight: 700, cursor: 'pointer', fontSize: '0.9rem',
                }}>{t('multi.cancelReady')}</button>
              )}
              <Link href="/multiplayer" style={{ padding: '10px 24px', background: 'transparent', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontWeight: 700, textDecoration: 'none' }}>{t('multi.exit')}</Link>
            </div>
          </div>
        )}

        {/* ===== Surrender Confirm Dialog ===== */}
        {showSurrenderConfirm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }}>
            <div style={{ background: 'var(--card)', padding: '24px', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)', textAlign: 'center', maxWidth: '320px' }}>
              <p style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '8px' }}>{t('multi.confirmSurrenderTitle')}</p>
              <p style={{ color: 'var(--text-light)', fontSize: '0.85rem', marginBottom: '16px' }}>{t('multi.confirmSurrenderDesc')}</p>
              <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
                <button onClick={()=>setShowSurrenderConfirm(false)} style={{ padding:'8px 20px', background:'transparent', border:'1px solid var(--border)', borderRadius:'var(--radius)', cursor:'pointer', color:'var(--text)' }}>{t('multi.cancel')}</button>
                <button onClick={confirmSurrender} style={{ padding:'8px 20px', background:'var(--danger)', color:'#fff', border:'none', borderRadius:'var(--radius)', cursor:'pointer', fontWeight:700 }}>{t('multi.confirmSurrender')}</button>
              </div>
            </div>
          </div>
        )}

        {/* ===== Connecting Dialog ===== */}
        {connecting && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }}>
            <div style={{ background:'var(--card)', padding:'32px', borderRadius:'var(--radius)', textAlign:'center' }}>
              <div style={{ fontSize:'2rem', marginBottom:'10px', animation:'neon-pulse 1.5s infinite' }}>{connecting==='create'?'🏠':connecting==='quickmatch'?'⚡':'🚪'}</div>
              <p style={{ fontSize:'1.1rem', fontWeight:700 }}>{connecting==='create' ? t('multi.creating') : connecting==='quickmatch' ? t('multi.searchingOpp') : t('multi.joining')}</p>
              <p style={{ color:'var(--text-light)', fontSize:'0.8rem', marginTop:'6px' }}>{connecting==='quickmatch' ? t('multi.connectingTimeout60') : t('multi.connectingTimeout30')}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const btn: React.CSSProperties = { padding:'12px 28px', background:'var(--primary)', color:'var(--bg)', border:'none', borderRadius:'var(--radius)', fontSize:'1rem', fontWeight:700, cursor:'pointer' };
const inp: React.CSSProperties = { width:'100%', padding:'10px', background:'var(--input-bg)', color:'var(--text)', border:'1px solid var(--border)', borderRadius:'var(--radius)', fontSize:'1rem', textAlign:'center' };
