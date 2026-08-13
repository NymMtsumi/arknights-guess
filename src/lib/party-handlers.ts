// 派对模式 — Socket 事件处理器（从 page.tsx 提取，可独立测试）
import type { Socket } from 'socket.io-client';
import type { Character, GuessComparisons, GuessResult } from '@/types/character';
import type { PartyRoom, PartyReconnectState, PartyRoundEnd, PartyGameEnd, PartyGuessResult } from '@/lib/party-socket';
import { usePartyStore, type PartyStage } from '@/stores/party-store';
import { useGameStore } from '@/stores/game-store';
import { findCharacterByName } from '@/lib/game-engine';
import { PARTY_MIN_PLAYERS, PARTY_MAX_GUESSES } from '@/lib/party-constants';

// ── DTO 子类型 ──
interface PartyPlayerDTO { id: string; name: string; ready: boolean; playerKey?: string }
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

// 兜底：服务端未回传对比结果时的全错占位（正常流程不会用到）
const ALL_WRONG: GuessComparisons = {
  class: 'wrong', subclass: 'wrong', faction: 'wrong', rarity: 'wrong',
  race: 'wrong', gender: 'wrong', releaseYear: 'wrong', tags: 'wrong', position: 'wrong',
};

// ═══════════════════════════════════════════════
//  房间事件
// ═══════════════════════════════════════════════

export function onPartyCreated(d: { room: PartyRoom; players: PartyPlayerDTO[] }, ctx: PartyHandlerCtx) {
  // 房主创建后也收到完整房间 + 玩家快照（与 onPartyJoined 对齐），否则 players 为空 → 显示 0 人
  storeSet({
    connecting: '', roomCode: d.room.code,
    hostId: d.room.hostId, settings: d.room.settings,
    players: d.players.map(p => ({ id: p.id, name: p.name, ready: p.ready, score: 0, playerKey: p.playerKey })),
  });
  ctx.persistRoomCode(d.room.code);
  ctx.savePlayerName(usePartyStore.getState().playerName);
  ctx.setStage('waiting');
}

export function onPartyJoined(d: {
  room: PartyRoom;
  players: PartyPlayerDTO[];
}, ctx: PartyHandlerCtx) {
  storeSet({
    connecting: '', roomCode: d.room.code,
    hostId: d.room.hostId, settings: d.room.settings,
    players: d.players.map(p => ({ id: p.id, name: p.name, ready: p.ready, score: 0, playerKey: p.playerKey })),
  });
  ctx.persistRoomCode(d.room.code);
  ctx.savePlayerName(usePartyStore.getState().playerName);
  ctx.setStage('waiting');
}

export function onPlayerJoined(d: PartyPlayerDTO) {
  usePartyStore.setState(s => ({
    players: [...s.players, { id: d.id, name: d.name, ready: d.ready, score: 0, playerKey: d.playerKey }],
  }));
}

export function onPlayerLeft(d: { playerId: string; newHostId?: string }) {
  usePartyStore.setState(s => ({
    players: s.players.filter(p => p.id !== d.playerId),
    // 离开的玩家若此前处于断线状态，一并从断线名单清除，避免计数残留
    disconnectedPlayers: s.disconnectedPlayers.filter(id => id !== d.playerId),
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
    BAD_NAME: 'party.errBadName',
    INTERNAL_ERROR: 'party.errInternal',
  };
  const key = d.code ? errorMap[d.code] : null;
  const msg = key ? ctx.t(key, { min: d.minPlayers ?? PARTY_MIN_PLAYERS }) : d.message;
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
      players: d.players.map(p => ({ id: p.id, name: p.name, ready: p.ready, score: 0, playerKey: p.playerKey })),
    });
  }
  usePartyStore.setState({ timeLeft: d.countdown });
  ctx.startCountdown(d.countdown);
}

export function onRoundStart(
  d: { round: number; totalRounds: number; timeLimit: number; maxGuesses?: number; attributes?: string[] | null; difficulty?: string },
  ctx: PartyHandlerCtx,
) {
  storeSet({ connecting: '' });
  ctx.setStage('playing');
  const settings = usePartyStore.getState().settings;
  usePartyStore.setState({
    currentRound: d.round, totalRounds: d.totalRounds,
    targetName: '', // 回合进行中不持有答案（服务端不下发，回合结束才揭晓）
    timeLeft: Math.ceil(d.timeLimit / 1000),
    settings: {
      ...settings,
      ...(d.attributes !== undefined ? { attributes: d.attributes ?? null } : {}),
      ...(d.difficulty ? { difficulty: d.difficulty } : {}),
    },
  });
  usePartyStore.getState().resetRoundState();

  // 无目标：客户端只渲染服务端返回的对比结果，答案仅存服务端
  useGameStore.setState({
    status: 'playing', target: null,
    guesses: [], remainingGuesses: d.maxGuesses ?? PARTY_MAX_GUESSES, difficulty: 'hard',
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

export function onGuessResult(d: PartyGuessResult, ctx: PartyHandlerCtx) {
  const gs = useGameStore.getState();
  // 已胜/已败后忽略迟到回执（胜利瞬间可能仍有在途猜测的回执到达）
  if (gs.status !== 'playing') return;

  const char = findCharacterByName(ctx.allChars, d.name) || ctx.makeStubChar(d.name);
  // 去重防御：极端情况下重复回执不重复入表
  if (gs.guesses.some(g => g.character.id === char.id)) return;

  const maxGuesses = usePartyStore.getState().settings.maxGuesses ?? PARTY_MAX_GUESSES;
  const result: GuessResult = {
    character: char,
    comparisons: d.comparisons ?? ALL_WRONG,
    timestamp: Date.now(),
    ...(d.correct ? { correct: true } : {}),
    ...(d.isAlter ? { isAlter: true } : {}),
  };

  useGameStore.setState({
    guesses: [...gs.guesses, result],
    remainingGuesses: Math.max(0, maxGuesses - d.guessCount),
    status: d.correct ? 'won' : (d.exhausted ? 'lost' : 'playing'),
  });

  if (d.exhausted && usePartyStore.getState().socketId) {
    usePartyStore.getState().addExhaustedPlayer(usePartyStore.getState().socketId);
  }
}

export function onRoundEnd(d: PartyRoundEnd, ctx: PartyHandlerCtx) {
  ctx.setStage('reveal');
  ctx.stopCountdown();
  usePartyStore.setState({
    roundFinished: true,
    targetName: d.target?.name || '',
    roundRankings: d.rankings || [],
    totalScores: d.totalScores || [],
  });
}

export function onGameEnd(d: PartyGameEnd, ctx: PartyHandlerCtx) {
  ctx.setStage('end');
  ctx.stopCountdown();
  usePartyStore.setState({
    finalRankings: d.finalRankings || [],
    champion: d.champion || null,
  });
  ctx.forgetRoom();
}

export function onRoomDissolved(d: { reason?: string }, ctx: PartyHandlerCtx) {
  ctx.forgetRoom();
  ctx.stopCountdown();
  usePartyStore.getState().resetAll();
  useGameStore.getState().resetGame();
  usePartyStore.setState({ error: ctx.t('party.roomDissolved') });
}

export function onPartyLeft(ctx: PartyHandlerCtx) {
  // 本人主动离开：服务端在 socket.leave 前下发 party:left，这里退回菜单（否则离开后收不到 room_dissolved 而卡在等待室）
  ctx.forgetRoom();
  ctx.stopCountdown();
  usePartyStore.getState().resetAll();
  useGameStore.getState().resetGame();
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
      // 重连换 socket.id 后，猜中/耗尽名单里的旧 id 同步迁移，避免断线状态残留
      foundPlayers: s.foundPlayers.map(f => f.playerId === d.oldPlayerId ? { ...f, playerId: d.playerId } : f),
      exhaustedPlayers: s.exhaustedPlayers.map(id => id === d.oldPlayerId ? d.playerId : id),
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
    players: d.players.map(p => ({ id: p.id, name: p.name, ready: p.ready ?? false, score: 0, playerKey: p.playerKey })),
  });
  ctx.persistRoomCode(d.room.code);

  // 恢复累积分数（按 playerKey 精确匹配，回退到名称，避免重名串号）
  if (d.scores) {
    const players = usePartyStore.getState().players;
    const updated = players.map(pl => {
      const byKey = d.scores?.find((s: { playerKey: string; playerName: string; score: number }) => s.playerKey === pl.playerKey);
      const byName = byKey || d.scores?.find((s: { playerName: string; score: number }) => s.playerName === pl.name);
      return { ...pl, score: byName?.score ?? pl.score };
    });
    usePartyStore.setState({ players: updated });
  }

  if (d.room.started && !d.finalRankings) {
    usePartyStore.setState({
      currentRound: d.currentRound || 0,
      totalRounds: d.totalRounds || d.room.settings.rounds,
      // 回合进行中清空答案；仅揭晓阶段（roundFinished）才持有并展示
      targetName: d.roundFinished ? (d.targetName || '') : '',
    });

    // 回合进行中：恢复棋盘但不持有答案（服务端不下发目标，本地无 target）
    if (!d.roundFinished) {
      const myRp = d.roundPlayers?.find(rp => rp.playerId === usePartyStore.getState().socketId);
      const maxG = d.room.settings.maxGuesses ?? PARTY_MAX_GUESSES;
      useGameStore.setState({
        status: 'playing', target: null,
        guesses: [],
        remainingGuesses: Math.max(0, maxG - (myRp?.guessCount ?? 0)),
        difficulty: 'hard',
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
      champion: d.champion ?? null,
      currentRound: d.currentRound || 0,
      totalRounds: d.totalRounds || d.room.settings.rounds,
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
  socket.on('party:joined', (d) => onPartyJoined(d, ctx));
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
  socket.on('party:guess_result', (d) => onGuessResult(d, ctx));
  socket.on('party:round_end', (d) => onRoundEnd(d, ctx));
  socket.on('party:game_end', (d) => onGameEnd(d, ctx));
  socket.on('party:room_dissolved', (d) => onRoomDissolved(d, ctx));
  socket.on('party:left', () => onPartyLeft(ctx));

  // 连接状态
  socket.on('party:player_disconnected', onPlayerDisconnected);
  socket.on('party:player_reconnected', onPlayerReconnected);
  socket.on('party:insufficient_players', (d) => onInsufficientPlayers(d, ctx));

  // 重连状态
  socket.on('party:reconnect_state', (d) => onReconnectState(d, ctx));
}
