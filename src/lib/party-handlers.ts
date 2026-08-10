// 派对模式 — Socket 事件处理器（从 page.tsx 提取，可独立测试）
import type { Socket } from 'socket.io-client';
import type { Character } from '@/types/character';
import type { PartyRoom, PartyReconnectState } from '@/lib/party-socket';
import { usePartyStore, type PartyStage } from '@/stores/party-store';
import { useGameStore } from '@/stores/game-store';
import { findCharacterByName } from '@/lib/game-engine';

// ── DTO 子类型 ──
interface PartyPlayerDTO { id: string; name: string; ready: boolean }
interface RoundPlayerDTO { playerId: string; playerName: string; guessed: boolean; exhausted: boolean; guessCount: number }

// ── 传给每个 handler 的上下文 ──
export interface PartyHandlerCtx {
  t: (key: string, params?: Record<string, string | number>) => string;
  persistRoomCode: (code: string) => void;
  forgetRoom: () => void;
  savePlayerName: (name: string) => void;
  setStage: (stage: PartyStage) => void;
  startCountdown: (seconds: number) => void;
  stopCountdown: () => void;
  setTimedError: (msg: string, ms?: number) => void;
  makeStubChar: (name: string) => Character;
  allChars: Character[];
}

function storeSet(patch: Partial<ReturnType<typeof usePartyStore.getState>>) {
  usePartyStore.setState(patch);
}

// ═══════════════════════════════════════════════
//  房间事件
// ═══════════════════════════════════════════════

export function onPartyCreated(d: { roomCode: string }, ctx: PartyHandlerCtx) {
  storeSet({ connecting: '', roomCode: d.roomCode });
  ctx.persistRoomCode(d.roomCode);
  ctx.savePlayerName(usePartyStore.getState().playerName);
  usePartyStore.setState({ hostId: usePartyStore.getState().socketId });
  ctx.setStage('waiting');
}

export function onPartyJoined(d: {
  room: PartyRoom;
  players: PartyPlayerDTO[];
}, ctx: PartyHandlerCtx, socket: Socket) {
  storeSet({
    connecting: '', roomCode: d.room.code,
    hostId: d.room.hostId, settings: d.room.settings,
    players: d.players.map(p => ({ id: p.id, name: p.name, ready: p.ready, score: 0 })),
  });
  ctx.persistRoomCode(d.room.code);
  ctx.savePlayerName(usePartyStore.getState().playerName);
  if (d.room.started) {
    socket.emit('party:reconnect', { roomCode: d.room.code });
    return;
  }
  ctx.setStage('waiting');
}

export function onPlayerJoined(d: PartyPlayerDTO) {
  usePartyStore.setState(s => ({
    players: [...s.players, { id: d.id, name: d.name, ready: d.ready, score: 0 }],
  }));
}

export function onPlayerLeft(d: { playerId: string; newHostId?: string }) {
  usePartyStore.setState(s => ({
    players: s.players.filter(p => p.id !== d.playerId),
    ...(d.newHostId ? { hostId: d.newHostId } : {}),
  }));
}

export function onKicked(ctx: PartyHandlerCtx) {
  ctx.forgetRoom();
  usePartyStore.getState().resetAll();
  useGameStore.getState().resetGame();
  usePartyStore.setState({ error: ctx.t('party.kicked') });
}

export function onPlayerReady(d: { playerId: string; ready: boolean }) {
  usePartyStore.getState().updatePlayerReady(d.playerId, d.ready);
}

export function onSettingsUpdated(d: { settings: PartyRoom['settings'] }) {
  usePartyStore.setState({ settings: d.settings });
}

export function onHostChanged(d: { newHostId: string }) {
  usePartyStore.setState({ hostId: d.newHostId });
}

export function onPartyError(
  d: { code?: string; message: string; minPlayers?: number },
  ctx: PartyHandlerCtx,
) {
  const errorMap: Record<string, string> = {
    ALREADY_IN_ROOM: 'party.errAlreadyInRoom',
    ROOM_NOT_FOUND: 'party.errRoomNotFound',
    GAME_STARTED: 'party.errGameStarted',
    GAME_ENDED: 'party.errGameEnded',
    ROOM_FULL: 'party.errRoomFull',
    NEED_MORE_PLAYERS: 'party.errNeedMorePlayers',
    NOT_ALL_READY: 'party.errNotAllReady',
    MULTI_TAB: 'party.errMultiTab',
    NOT_IN_ROOM: 'party.errNotInRoom',
  };
  const key = d.code ? errorMap[d.code] : null;
  const msg = key ? ctx.t(key, { min: d.minPlayers ?? 4 }) : d.message;
  ctx.setTimedError(msg);
}

// ═══════════════════════════════════════════════
//  游戏事件
// ═══════════════════════════════════════════════

export function onGameStarting(
  d: { countdown: number; players: PartyPlayerDTO[] },
  ctx: PartyHandlerCtx,
) {
  ctx.setStage('countdown');
  if (d.players) {
    usePartyStore.setState({
      players: d.players.map(p => ({ id: p.id, name: p.name, ready: p.ready, score: 0 })),
    });
  }
  usePartyStore.setState({ timeLeft: d.countdown });
  ctx.startCountdown(d.countdown);
}

export function onRoundStart(
  d: { round: number; totalRounds: number; targetName: string; timeLimit: number },
  ctx: PartyHandlerCtx,
) {
  storeSet({ connecting: '' });
  ctx.setStage('playing');
  usePartyStore.setState({
    currentRound: d.round, totalRounds: d.totalRounds,
    targetName: d.targetName,
    timeLeft: Math.ceil(d.timeLimit / 1000),
  });
  usePartyStore.getState().resetRoundState();

  const targetChar = findCharacterByName(ctx.allChars, d.targetName) || ctx.makeStubChar(d.targetName);
  useGameStore.setState({
    status: 'playing', target: targetChar,
    guesses: [], remainingGuesses: 8, difficulty: 'hard',
  });
}

export function onTimerTick(d: { secondsLeft: number }) {
  usePartyStore.setState({ timeLeft: d.secondsLeft });
}

export function onPlayerFound(d: { playerId: string; playerName: string; rank: number; guessCount: number }) {
  usePartyStore.getState().addFoundPlayer(d);
}

export function onPlayerExhausted(d: { playerId: string }) {
  usePartyStore.getState().addExhaustedPlayer(d.playerId);
}

export function onGuessResult(d: { correct: boolean; exhausted?: boolean }) {
  if (d.exhausted && usePartyStore.getState().socketId) {
    usePartyStore.getState().addExhaustedPlayer(usePartyStore.getState().socketId);
  }
}

export function onRoundEnd(d: any, ctx: PartyHandlerCtx) {
  ctx.setStage('reveal');
  ctx.stopCountdown();
  usePartyStore.setState({
    roundFinished: true,
    targetName: d.target?.name || '',
    roundRankings: d.rankings || [],
    totalScores: d.totalScores || [],
  });
}

export function onGameEnd(d: { finalRankings: any[]; champion: any }, ctx: PartyHandlerCtx) {
  ctx.setStage('end');
  ctx.stopCountdown();
  usePartyStore.setState({
    finalRankings: d.finalRankings || [],
    champion: d.champion || null,
  });
  ctx.forgetRoom();
}

export function onRoomDissolved(d: any, ctx: PartyHandlerCtx) {
  ctx.forgetRoom();
  ctx.stopCountdown();
  usePartyStore.getState().resetAll();
  useGameStore.getState().resetGame();
  usePartyStore.setState({ error: ctx.t('party.roomDissolved') });
}

// ═══════════════════════════════════════════════
//  连接状态
// ═══════════════════════════════════════════════

export function onPlayerDisconnected(d: { playerId: string }) {
  usePartyStore.getState().addDisconnectedPlayer(d.playerId);
}

export function onPlayerReconnected(d: { playerId: string; oldPlayerId?: string; playerName?: string }) {
  const st = usePartyStore.getState();
  st.removeDisconnectedPlayer(d.playerId);
  if (d.oldPlayerId && d.oldPlayerId !== d.playerId) {
    usePartyStore.setState(s => ({
      players: s.players.map(p => p.id === d.oldPlayerId ? { ...p, id: d.playerId } : p),
      disconnectedPlayers: s.disconnectedPlayers.filter(id => id !== d.oldPlayerId),
    }));
  }
}

export function onInsufficientPlayers(d: { current: number; minimum: number }, ctx: PartyHandlerCtx) {
  storeSet({ error: ctx.t('party.insufficientPlayers', { current: d.current, min: d.minimum }) });
}

// ═══════════════════════════════════════════════
//  重连状态
// ═══════════════════════════════════════════════

export function onReconnectState(d: PartyReconnectState, ctx: PartyHandlerCtx) {
  storeSet({ connecting: '' });
  usePartyStore.setState({
    roomCode: d.room.code, hostId: d.room.hostId,
    settings: d.room.settings,
    players: d.players.map(p => ({ id: p.id, name: p.name, ready: p.ready ?? false, score: 0 })),
  });
  ctx.persistRoomCode(d.room.code);

  // 恢复累积分数
  if (d.scores) {
    const players = usePartyStore.getState().players;
    const updated = players.map(pl => {
      const byName = d.scores?.find((s: { playerName: string; score: number }) => s.playerName === pl.name);
      return { ...pl, score: byName?.score ?? pl.score };
    });
    usePartyStore.setState({ players: updated });
  }

  if (d.room.started && !d.finalRankings) {
    usePartyStore.setState({
      currentRound: d.currentRound || 0, targetName: d.targetName || '',
    });

    if (d.targetName) {
      const targetChar = findCharacterByName(ctx.allChars, d.targetName) || ctx.makeStubChar(d.targetName);
      useGameStore.setState({
        status: 'playing', target: targetChar,
        guesses: [], remainingGuesses: 8, difficulty: 'hard',
      });
    }

    if (d.roundPlayers) {
      usePartyStore.getState().resetRoundState();
      const st = usePartyStore.getState();
      d.roundPlayers.forEach((rp: RoundPlayerDTO & { findOrder?: number }) => {
        if (rp.guessed) st.addFoundPlayer({ playerId: rp.playerId, playerName: rp.playerName, rank: rp.findOrder ?? 0, guessCount: rp.guessCount });
        if (rp.exhausted) st.addExhaustedPlayer(rp.playerId);
      });
    }

    if (d.roundRankings) usePartyStore.setState({ roundRankings: d.roundRankings });
    if (d.totalScores) usePartyStore.setState({ totalScores: d.totalScores });

    if (!d.roundFinished && d.remainingTime) {
      usePartyStore.setState({ timeLeft: d.remainingTime, roundFinished: false });
      ctx.startCountdown(d.remainingTime);
      ctx.setStage('playing');
    } else if (d.roundFinished) {
      ctx.setStage('reveal');
      usePartyStore.setState({ roundFinished: true });
    }
  } else if (d.finalRankings) {
    ctx.setStage('end');
    usePartyStore.setState({
      finalRankings: d.finalRankings,
      currentRound: d.currentRound || 0,
    });
  } else {
    ctx.setStage('waiting');
  }
}

// ═══════════════════════════════════════════════
//  注册所有 handler
// ═══════════════════════════════════════════════

export function registerAllPartyHandlers(socket: Socket, ctx: PartyHandlerCtx) {
  // 同步 socket id
  socket.on('connect', () => {
    usePartyStore.setState({ socketId: socket.id as string });
  });

  // 房间事件
  socket.on('party:created', (d) => onPartyCreated(d, ctx));
  socket.on('party:joined', (d) => onPartyJoined(d, ctx, socket));
  socket.on('party:player_joined', onPlayerJoined);
  socket.on('party:player_left', onPlayerLeft);
  socket.on('party:kicked', () => onKicked(ctx));
  socket.on('party:player_ready', onPlayerReady);
  socket.on('party:settings_updated', onSettingsUpdated);
  socket.on('party:host_changed', onHostChanged);
  socket.on('party:error', (d) => onPartyError(d, ctx));

  // 游戏事件
  socket.on('party:game_starting', (d) => onGameStarting(d, ctx));
  socket.on('party:round_start', (d) => onRoundStart(d, ctx));
  socket.on('party:timer_tick', onTimerTick);
  socket.on('party:player_found', onPlayerFound);
  socket.on('party:player_exhausted', onPlayerExhausted);
  socket.on('party:guess_result', onGuessResult);
  socket.on('party:round_end', (d) => onRoundEnd(d, ctx));
  socket.on('party:game_end', (d) => onGameEnd(d, ctx));
  socket.on('party:room_dissolved', (d) => onRoomDissolved(d, ctx));

  // 连接状态
  socket.on('party:player_disconnected', onPlayerDisconnected);
  socket.on('party:player_reconnected', onPlayerReconnected);
  socket.on('party:insufficient_players', (d) => onInsufficientPlayers(d, ctx));

  // 重连状态
  socket.on('party:reconnect_state', (d) => onReconnectState(d, ctx));
}
