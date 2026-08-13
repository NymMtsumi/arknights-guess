// 派对模式 — 房间管理（创建/加入/离开/踢人/解散/清理）
import { ATTR_KEYS } from '../constants.js';

const DISCONNECT = 30_000;
const MAX_PLAYERS = 8;
const MIN_PLAYERS = 3;
const MAX_GUESSES = 8;
// 每局时长预设（秒，与前端 Lobby 一致；多人对战用毫秒常量，单位不同故不复用 constants.js）
const PARTY_ROUND_TIMES = [60, 120, 180, 240, 300];

// 由 playerKey 生成确定性 4 位数字昵称（弗一把式匿名房，取消自定义昵称）
// playerKey 同一玩家跨重连稳定（登录用户派生自账号、游客存 localStorage），故昵称稳定。
function guestNameFromKey(pk) {
  let h = 0;
  const s = String(pk || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `玩家#${(h % 10000).toString().padStart(4, '0')}`;
}

// ===== ack 辅助（请求-响应协议，消灭静默失败）=====
function ackOk(ack, data) { if (typeof ack === 'function') ack({ ok: true, ...(data || {}) }); }
function ackErr(ack, code, message, extra) { if (typeof ack === 'function') ack({ ok: false, code, message, ...(extra || {}) }); }

// ===== 词条列校验：过滤到合法 ATTR_KEYS、去重；<3 则退化为标准（null）。对齐多人自定义房规则 =====
function sanitizeAttributes(data) {
  const raw = Array.isArray(data?.attributes)
    ? [...new Set(data.attributes.filter(a => ATTR_KEYS.includes(a)))] : [];
  return raw.length >= 3 ? raw : null;
}
// 每局猜测次数：1-15 整数，非法回退 8
function sanitizeMaxGuesses(data) {
  return Number.isInteger(data?.maxGuesses) && data.maxGuesses >= 1 && data.maxGuesses <= 15 ? data.maxGuesses : MAX_GUESSES;
}

export function createPartyRoomModule(deps) {
  const {
    io, partyRooms, partyRoomPlayerIndex,
    onlinePlayers, onlineSockets, ONLINE_TIMEOUT,
    rooms, roomPlayerIndex,
  } = deps;

  // game 回调（由 party.js 在创建 game 模块后延迟绑定）
  let _checkAllDone = null;
  let _partyRoundStart = null;

  function setGameCallbacks(cbs) {
    _checkAllDone = cbs.checkAllDone;
    _partyRoundStart = cbs.partyRoundStart;
  }

  // ===== 查找辅助 =====
  function findPartyRoomByPlayerKey(pk) {
    const code = partyRoomPlayerIndex.get(pk);
    if (!code) return null;
    const room = partyRooms.get(code);
    if (!room || room.finished) {
      partyRoomPlayerIndex.delete(pk);
      return null;
    }
    return room;
  }

  function findPartyRoomByIdentityKey(ik) {
    for (const [, r] of partyRooms) {
      if (r.finished) continue;
      for (const p of r.players.values()) {
        if (p.identityKey === ik || p.playerKey === ik) return r;
      }
    }
    return null;
  }

  // 按 identity 查找房间内玩家，若 socket.id 变更则自动 re-key
  function findPlayerInRoom(room, socket) {
    const direct = room.players.get(socket.id);
    if (direct) return direct;

    for (const [oldSid, p] of room.players) {
      if (p.identityKey === socket.data.identityKey) {
        room.players.delete(oldSid);
        room.players.set(socket.id, p);
        if (p.dcTimer) { clearTimeout(p.dcTimer); p.dcTimer = null; }
        if (room.hostId === oldSid) room.hostId = socket.id;
        try { socket.join(room.code); } catch {}
        console.log(`[party] re-key ${oldSid.slice(0,6)} -> ${socket.id.slice(0,6)} (房间${room.code})`);
        return p;
      }
    }
    return null;
  }

  // ===== 广播 =====
  function broadcast(room, event, data) {
    io.to(room.code).emit(event, data);
  }

  // ===== 生成房间码 =====
  function genPartyCode() {
    let code;
    let attempts = 0;
    do {
      code = String(Math.floor(100000 + Math.random() * 900000));
      if (++attempts > 1000) break;
    } while (partyRooms.has(code));
    return code;
  }

  // ===== 注册在线玩家 =====
  function registerOnline(socket, code) {
    socket.data.roomCode = code;
    partyRoomPlayerIndex.set(socket.data.playerKey, code);
    const entry = onlinePlayers.get(socket.data.playerKey);
    if (entry) { entry.type = 'party'; entry.roomCode = code; }
  }

  // ===== 创建玩家对象 =====
  // 昵称由服务端生成（玩家#XXXX），不再信任客户端传名（取消自定义昵称）
  function makePlayer(socket) {
    return {
      name: guestNameFromKey(socket.data.playerKey),
      wins: 0,
      dcTimer: null,
      lastSocketId: null,
      playerKey: socket.data.playerKey,
      identityKey: socket.data.identityKey,
      ready: false,
    };
  }

  // ===== 创建房间 =====
  function createPartyRoom(socket, data, ack) {
    const existing = findPartyRoomByPlayerKey(socket.data.playerKey);
    if (existing) {
      socket.emit('party:error', { code: 'ALREADY_IN_ROOM', message: '你已在派对房间中' });
      ackErr(ack, 'ALREADY_IN_ROOM', '你已在派对房间中');
      return;
    }
    const multiCode = roomPlayerIndex?.get(socket.data.playerKey);
    if (multiCode && rooms?.has(multiCode)) {
      socket.emit('party:error', { code: 'ALREADY_IN_ROOM', message: '你已在多人对战房间中' });
      ackErr(ack, 'ALREADY_IN_ROOM', '你已在多人对战房间中');
      return;
    }

    const difficulty = ['easy', 'medium', 'hard'].includes(data?.difficulty) ? data?.difficulty : 'hard';
    const rounds = [5, 7, 10].includes(data?.rounds) ? data?.rounds : 7;
    const roundTime = PARTY_ROUND_TIMES.includes(data?.roundTime) ? data?.roundTime : 120;
    const attributes = sanitizeAttributes(data);
    const maxGuesses = sanitizeMaxGuesses(data);

    const code = genPartyCode();
    const room = {
      code,
      hostId: socket.id,
      players: new Map([[socket.id, makePlayer(socket)]]),
      settings: { difficulty, rounds, roundTime, attributes, maxGuesses },
      started: false,
      finished: false,
      currentRound: 0,
      target: null,
      roundStartAt: null,
      roundFinished: false,
      roundPlayers: new Map(),
      scores: new Map(),
      roundResults: [],
      _createdAt: Date.now(),
      _roundTimer: null,
      _revealTimer: null,
      _tickInterval: null,
      _countdownInterval: null,
      _foundRank: 0,
    };

    partyRooms.set(code, room);
    socket.join(code);
    registerOnline(socket, code);

    // 与 joinPartyRoom 一致，下发完整房间 + 玩家快照（否则房主前端 onPartyCreated 无 players → 显示 0 人）
    socket.emit('party:created', {
      room: { code, hostId: room.hostId, settings: room.settings, started: room.started },
      players: Array.from(room.players.entries()).map(([id, pl]) => ({ id, name: pl.name, ready: pl.ready, playerKey: pl.playerKey })),
    });
    ackOk(ack, { roomCode: code });
    console.log(`[派对] 创建房间 ${code} 房主=${room.players.get(socket.id)?.name}`);
  }

  // ===== 加入房间 =====
  function joinPartyRoom(socket, data, ack) {
    const code = String(data?.roomCode || '').trim();
    const room = partyRooms.get(code);
    if (!room) { socket.emit('party:error', { code: 'ROOM_NOT_FOUND', message: '房间不存在' }); ackErr(ack, 'ROOM_NOT_FOUND', '房间不存在'); return; }

    // 重连优先：已在房内的玩家（playerKey 稳定跨重连）必须在 started/finished 拒绝之前走重连分支，
    // 否则开局后重开页面（?room=CODE → party:join）会被误拒为「游戏已开始」。
    for (const [, p] of room.players) {
      if (p.playerKey === socket.data.playerKey || p.identityKey === socket.data.identityKey) {
        if (room.started || room.finished) {
          // 开局/终局后重连：需要完整状态快照，交给 reconnectPartyRoom（含竞态处理与 MULTI_TAB 兜底）
          reconnectPartyRoom(socket, data, ack);
        } else {
          // 等待室重连：沿用下方 in-place 重连逻辑（含 MULTI_TAB 拒绝）
          joinAsExistingPlayer(socket, data, ack, room);
        }
        return;
      }
    }

    if (room.started) { socket.emit('party:error', { code: 'GAME_STARTED', message: '游戏已开始，无法加入' }); ackErr(ack, 'GAME_STARTED', '游戏已开始，无法加入'); return; }
    if (room.finished) { socket.emit('party:error', { code: 'GAME_ENDED', message: '游戏已结束' }); ackErr(ack, 'GAME_ENDED', '游戏已结束'); return; }
    if (room.players.size >= MAX_PLAYERS) { socket.emit('party:error', { code: 'ROOM_FULL', message: '房间已满（最多8人）' }); ackErr(ack, 'ROOM_FULL', '房间已满（最多8人）'); return; }

    // 跨房间检查
    const existingRoom = findPartyRoomByPlayerKey(socket.data.playerKey);
    if (existingRoom && existingRoom.code !== code) {
      socket.emit('party:error', { code: 'ALREADY_IN_ROOM', message: '你已在其他派对房间中' });
      ackErr(ack, 'ALREADY_IN_ROOM', '你已在其他派对房间中');
      return;
    }
    const multiCode = roomPlayerIndex?.get(socket.data.playerKey);
    if (multiCode && rooms?.has(multiCode)) {
      let isReconnect = false;
      for (const [, p] of room.players) {
        if (p.playerKey === socket.data.playerKey || p.identityKey === socket.data.identityKey) {
          isReconnect = true; break;
        }
      }
      if (!isReconnect) {
        socket.emit('party:error', { code: 'ALREADY_IN_ROOM', message: '你已在多人对战房间中' });
        ackErr(ack, 'ALREADY_IN_ROOM', '你已在多人对战房间中');
        return;
      }
    }

    // 新玩家（昵称服务端生成，忽略客户端传名）
    const player = makePlayer(socket);
    room.players.set(socket.id, player);
    socket.join(code);
    registerOnline(socket, code);

    broadcast(room, 'party:player_joined', { id: socket.id, name: player.name, ready: false, playerKey: socket.data.playerKey });
    socket.emit('party:joined', {
      room: { code: room.code, hostId: room.hostId, settings: room.settings, started: room.started },
      players: Array.from(room.players.entries()).map(([id, pl]) => ({ id, name: pl.name, ready: pl.ready, playerKey: pl.playerKey })),
    });
    ackOk(ack, { roomCode: room.code });
    console.log(`[派对] ${player.name} 加入房间 ${code} (${room.players.size}/${MAX_PLAYERS})`);
  }

  // ===== 等待室重连（party:join 命中房内玩家且房间未开始时走这里，含 MULTI_TAB 拒绝）=====
  function joinAsExistingPlayer(socket, data, ack, room) {
    const code = room.code;
    for (const [pid, p] of room.players) {
      if (p.playerKey === socket.data.playerKey || p.identityKey === socket.data.identityKey) {
        if (pid !== socket.id) {
          const oldSocket = io.sockets.sockets.get(pid);
          if (oldSocket && oldSocket.connected) {
            socket.emit('party:error', { code: 'MULTI_TAB', message: '你已在其他标签页中连接' });
            ackErr(ack, 'MULTI_TAB', '你已在其他标签页中连接');
            return;
          }
        }
        if (p.dcTimer) { clearTimeout(p.dcTimer); p.dcTimer = null; }
        p.lastSocketId = pid;
        room.players.delete(pid);
        room.players.set(socket.id, p);
        const jrp = room.roundPlayers.get(pid);
        if (jrp) { room.roundPlayers.delete(pid); room.roundPlayers.set(socket.id, jrp); }
        if (room.hostId === pid) room.hostId = socket.id;
        socket.join(code);
        registerOnline(socket, code);
        broadcast(room, 'party:player_reconnected', { playerId: socket.id, oldPlayerId: pid, playerName: p.name });
        socket.emit('party:joined', {
          room: { code: room.code, hostId: room.hostId, settings: room.settings, started: room.started },
          players: Array.from(room.players.entries()).map(([id, pl]) => ({ id, name: pl.name, ready: pl.ready, playerKey: pl.playerKey })),
        });
        ackOk(ack, { roomCode: room.code });
        return;
      }
    }
    ackErr(ack, 'NOT_IN_ROOM', '你不在该房间中');
  }

  // ===== 重连 =====
  function reconnectPartyRoom(socket, data, ack) {
    const code = String(data?.roomCode || '').trim();
    const room = partyRooms.get(code);
    if (!room) { socket.emit('party:error', { code: 'ROOM_NOT_FOUND', message: '房间不存在' }); ackErr(ack, 'ROOM_NOT_FOUND', '房间不存在'); return; }

    let foundPlayer = null;
    let foundOldId = null;
    for (const [pid, p] of room.players) {
      if (p.playerKey === socket.data.playerKey || p.identityKey === socket.data.identityKey) {
        foundPlayer = p;
        foundOldId = pid;
        break;
      }
    }
    if (!foundPlayer) { socket.emit('party:error', { code: 'NOT_IN_ROOM', message: '你不在该房间中' }); ackErr(ack, 'NOT_IN_ROOM', '你不在该房间中'); return; }

    if (foundOldId !== socket.id) {
      const oldSocket = io.sockets.sockets.get(foundOldId);
      if (oldSocket && oldSocket.connected) {
        // 快速重连竞态：新 socket 的 party:reconnect 先于旧 socket 的 disconnect 事件到达。
        // 与其拒绝（导致玩家永久卡在「别人视角已断线」），不如主动踢掉旧连接，然后正常 re-key。
        try { oldSocket.disconnect(true); } catch {}
      }
    }

    if (foundPlayer.dcTimer) { clearTimeout(foundPlayer.dcTimer); foundPlayer.dcTimer = null; }
    foundPlayer.lastSocketId = foundOldId;
    room.players.delete(foundOldId);
    room.players.set(socket.id, foundPlayer);

    const rp = room.roundPlayers.get(foundOldId);
    if (rp) { room.roundPlayers.delete(foundOldId); room.roundPlayers.set(socket.id, rp); }
    if (room.hostId === foundOldId) room.hostId = socket.id;

    socket.join(code);
    registerOnline(socket, code);
    broadcast(room, 'party:player_reconnected', { playerId: socket.id, oldPlayerId: foundOldId, playerName: foundPlayer.name });

    // 构建完整状态快照
    const state = {
      room: { code: room.code, hostId: room.hostId, settings: room.settings, started: room.started },
      players: Array.from(room.players.entries()).map(([id, pl]) => ({ id, name: pl.name, ready: pl.ready, playerKey: pl.playerKey })),
    };

    if (room.started && !room.finished) {
      state.currentRound = room.currentRound;
      state.totalRounds = room.settings.rounds;
      state.roundFinished = room.roundFinished;
      // 答案仅在回合结束后（揭晓阶段）才下发给重连客户端，回合进行中绝不泄露
      if (room.roundFinished) state.targetName = room.target?.name || '';
      if (!room.roundFinished && room.roundStartAt) {
        const elapsed = Date.now() - room.roundStartAt;
        const roundTime = (room.settings.roundTime || 120) * 1000;
        state.remainingTime = Math.max(0, Math.ceil((roundTime - elapsed) / 1000));
      }
      state.roundPlayers = Array.from(room.roundPlayers.entries()).map(([id, rp]) => {
        const pl = room.players.get(id);
        return { playerId: id, playerName: pl?.name || '?', guessed: rp.guessed, exhausted: rp.exhausted, guessCount: rp.guessCount, findOrder: rp.findOrder };
      });
      state.scores = Array.from(room.scores.entries()).map(([pk, score]) => {
        const pl = Array.from(room.players.values()).find(p => p.playerKey === pk);
        return { playerKey: pk, playerName: pl?.name || '?', score };
      });
      if (room.roundFinished && room.roundResults.length > 0) {
        const lastResult = room.roundResults[room.roundResults.length - 1];
        state.roundRankings = lastResult.rankings;
        state.totalScores = Array.from(room.players.entries()).map(([sid, pl]) => ({
          playerId: sid, playerName: pl.name, playerKey: pl.playerKey,
          score: room.scores.get(pl.playerKey) || 0,
        })).sort((a, b) => b.score - a.score);
      }
    }
    if (room.finished) {
      state.currentRound = room.currentRound;
      state.totalRounds = room.settings.rounds;
      state.finalRankings = [];
      for (const [sid, player] of room.players) {
        state.finalRankings.push({
          playerId: sid,
          playerName: player.name,
          playerKey: player.playerKey,
          totalScore: room.scores.get(player.playerKey) || 0,
          roundsWon: room.roundResults.filter(rr =>
            rr.rankings.length > 0 && !rr.rankings[0].didNotGuess && rr.rankings[0].playerKey === player.playerKey
          ).length,
        });
      }
      state.finalRankings.sort((a, b) => b.totalScore - a.totalScore);
      state.champion = state.finalRankings.length > 0 ? state.finalRankings[0] : null;
    }

    socket.emit('party:reconnect_state', state);
    ackOk(ack, { roomCode: room.code });
    console.log(`[派对] ${foundPlayer.name} 重连到房间 ${code}`);
  }

  // ===== 切换准备 =====
  function toggleReady(socket, ack) {
    const room = findPartyRoomByIdentityKey(socket.data.identityKey);
    if (!room) { ackErr(ack, 'NOT_IN_ROOM', '你不在房间中'); return; }
    if (room.started) { ackErr(ack, 'GAME_STARTED', '游戏已开始'); return; }
    const player = findPlayerInRoom(room, socket);
    if (!player) { ackErr(ack, 'NOT_IN_ROOM', '你不在房间中'); return; }
    if (socket.id === room.hostId) { ackErr(ack, 'HOST_CANNOT_READY', '房主无需准备'); return; }
    player.ready = !player.ready;
    broadcast(room, 'party:player_ready', { playerId: socket.id, ready: player.ready });
    ackOk(ack, { ready: player.ready });
  }

  // ===== 更新设置 =====
  function updateSettings(socket, data, ack) {
    const room = findPartyRoomByIdentityKey(socket.data.identityKey);
    if (!room) { ackErr(ack, 'NOT_IN_ROOM', '你不在房间中'); return; }
    if (room.started || room.finished) { ackErr(ack, 'GAME_STARTED', '游戏已开始，无法修改设置'); return; }
    if (room.hostId !== socket.id) { ackErr(ack, 'NOT_HOST', '仅房主可修改设置'); return; }
    if (data?.difficulty && ['easy', 'medium', 'hard'].includes(data.difficulty)) room.settings.difficulty = data.difficulty;
    if (data?.rounds && [5, 7, 10].includes(data.rounds)) room.settings.rounds = data.rounds;
    if (data?.roundTime && PARTY_ROUND_TIMES.includes(data.roundTime)) room.settings.roundTime = data.roundTime;
    if (data && Object.prototype.hasOwnProperty.call(data, 'attributes')) room.settings.attributes = sanitizeAttributes(data);
    if (data && Object.prototype.hasOwnProperty.call(data, 'maxGuesses')) room.settings.maxGuesses = sanitizeMaxGuesses(data);
    broadcast(room, 'party:settings_updated', { settings: room.settings });
    ackOk(ack, { settings: room.settings });
  }

  // ===== 开始游戏 =====
  function startGame(socket, ack) {
    const room = findPartyRoomByIdentityKey(socket.data.identityKey);
    if (!room) { ackErr(ack, 'NOT_IN_ROOM', '你不在房间中'); return; }
    if (room.started || room.finished) { ackErr(ack, 'GAME_STARTED', '游戏已开始'); return; }
    if (room.hostId !== socket.id) { ackErr(ack, 'NOT_HOST', '仅房主可开始游戏'); return; }

    const onlineCount = [...room.players.values()].filter(p => !p.dcTimer).length;
    if (onlineCount < MIN_PLAYERS) {
      socket.emit('party:error', { code: 'NEED_MORE_PLAYERS', message: `至少需要${MIN_PLAYERS}名玩家`, minPlayers: MIN_PLAYERS });
      ackErr(ack, 'NEED_MORE_PLAYERS', `至少需要${MIN_PLAYERS}名玩家`, { minPlayers: MIN_PLAYERS });
      return;
    }
    let allReady = true;
    for (const [sid, p] of room.players) {
      if (sid !== room.hostId && !p.ready) { allReady = false; break; }
    }
    if (!allReady) {
      socket.emit('party:error', { code: 'NOT_ALL_READY', message: '还有玩家未准备' });
      ackErr(ack, 'NOT_ALL_READY', '还有玩家未准备');
      return;
    }

    room.started = true;
    room.currentRound = 0;
    room.scores = new Map();
    room.roundResults = [];

    const players = Array.from(room.players.entries()).map(([id, pl]) => ({
      id, name: pl.name, ready: pl.ready, playerKey: pl.playerKey,
    }));
    broadcast(room, 'party:game_starting', { countdown: 5, players });
    ackOk(ack, {});

    let countdown = 5;
    room._countdownInterval = setInterval(() => {
      try {
        countdown--;
        if (countdown <= 0) {
          clearInterval(room._countdownInterval);
          room._countdownInterval = null;
          if (partyRooms.has(room.code) && _partyRoundStart) _partyRoundStart(room);
        } else {
          broadcast(room, 'party:game_starting', { countdown, players });
        }
      } catch (e) {
        console.error('[party-room] countdown error:', e.message);
      }
    }, 1000);
  }

  // ===== 离开 =====
  function handlePartyLeave(room, socket, isTimeout) {
    const player = findPlayerInRoom(room, socket) || room.players.get(socket.id);
    if (!player) return;
    if (player.dcTimer) { clearTimeout(player.dcTimer); player.dcTimer = null; }

    // 先告知离开的玩家本人（必须在 socket.leave 之前发送，否则离开后收不到任何事件 → 前端卡在等待室）
    socket.emit('party:left', { reason: isTimeout ? 'timeout' : 'left' });

    // 等待室阶段离开
    if (!room.started) {
      room.players.delete(socket.id);
      if (partyRoomPlayerIndex.get(player.playerKey) === room.code) partyRoomPlayerIndex.delete(player.playerKey);
      const entry = onlinePlayers.get(player.playerKey);
      if (entry && entry.type === 'party') { entry.type = 'idle'; entry.roomCode = null; }

      broadcast(room, 'party:player_left', {
        playerId: socket.id, playerName: player.name, reason: isTimeout ? 'timeout' : 'left',
      });
      socket.leave(room.code);

      if (socket.id === room.hostId && room.players.size > 0) {
        const firstPlayer = room.players.entries().next().value;
        room.hostId = firstPlayer[0];
        broadcast(room, 'party:host_changed', { newHostId: room.hostId, newHostName: firstPlayer[1].name });
      }
      if (room.players.size === 0) dissolveRoom(room, 'all_left');
      return;
    }

    // 游戏进行中离开
    broadcast(room, 'party:player_left', {
      playerId: socket.id, playerName: player.name, reason: isTimeout ? 'timeout' : 'left',
    });
    socket.leave(room.code);

    if (socket.id === room.hostId && room.players.size > 1) {
      let newHost = null;
      for (const [sid, p] of room.players) {
        if (sid === socket.id) continue;
        newHost = { sid, p };
        break;
      }
      if (newHost) {
        room.hostId = newHost.sid;
        broadcast(room, 'party:host_changed', { newHostId: newHost.sid, newHostName: newHost.p.name });
      }
    }

    if (room.started && !room.finished) {
      const rp = room.roundPlayers.get(socket.id);
      if (rp && !rp.guessed) rp.exhausted = true;
      if (_checkAllDone) _checkAllDone(room);
    }

    room.players.delete(socket.id);
    room.roundPlayers.delete(socket.id);
    if (partyRoomPlayerIndex.get(player.playerKey) === room.code) partyRoomPlayerIndex.delete(player.playerKey);
    const entry = onlinePlayers.get(player.playerKey);
    if (entry && entry.type === 'party') { entry.type = 'idle'; entry.roomCode = null; }

    const onlineCount = room.players.size;
    if (onlineCount < MIN_PLAYERS && room.started && !room.finished) {
      broadcast(room, 'party:insufficient_players', { current: onlineCount, minimum: MIN_PLAYERS });
      if (room._lowPlayersTimer) clearTimeout(room._lowPlayersTimer);
      room._lowPlayersTimer = setTimeout(() => {
        if (room.players.size < MIN_PLAYERS && room.started && !room.finished) {
          dissolveRoom(room, 'insufficient_players');
        }
      }, DISCONNECT);
    }

    if (room.players.size === 0) dissolveRoom(room, 'all_left');
  }

  // ===== 踢人 =====
  function handlePartyKick(socket, data, ack) {
    const room = findPartyRoomByIdentityKey(socket.data.identityKey);
    if (!room) { ackErr(ack, 'NOT_IN_ROOM', '你不在房间中'); return; }
    if (room.hostId !== socket.id) { ackErr(ack, 'NOT_HOST', '仅房主可踢人'); return; }
    const targetSid = data?.playerId;
    const target = room.players.get(targetSid);
    if (!target) { ackErr(ack, 'NOT_IN_ROOM', '目标玩家不在房间中'); return; }
    if (targetSid === socket.id) { ackErr(ack, 'INVALID', '不能踢自己'); return; }

    if (target.dcTimer) { clearTimeout(target.dcTimer); target.dcTimer = null; }

    const targetSocket = io.sockets.sockets.get(targetSid);
    if (targetSocket) targetSocket.leave(room.code);

    if (room.started && !room.finished) {
      const rp = room.roundPlayers.get(targetSid);
      if (rp && !rp.guessed) rp.exhausted = true;
      room.roundPlayers.delete(targetSid);
      if (_checkAllDone) _checkAllDone(room);
    }

    room.players.delete(targetSid);
    if (partyRoomPlayerIndex.get(target.playerKey) === room.code) partyRoomPlayerIndex.delete(target.playerKey);
    const entry = onlinePlayers.get(target.playerKey);
    if (entry && entry.type === 'party') { entry.type = 'idle'; entry.roomCode = null; }

    if (room.started && !room.finished && room.players.size < MIN_PLAYERS) {
      broadcast(room, 'party:insufficient_players', { current: room.players.size, minimum: MIN_PLAYERS });
      if (room._lowPlayersTimer) clearTimeout(room._lowPlayersTimer);
      room._lowPlayersTimer = setTimeout(() => {
        if (room.players.size < MIN_PLAYERS && room.started && !room.finished) {
          dissolveRoom(room, 'insufficient_players');
        }
      }, DISCONNECT);
    }

    io.to(targetSid).emit('party:kicked');
    broadcast(room, 'party:player_left', { playerId: targetSid, playerName: target.name });
    ackOk(ack, {});
  }

  // ===== 断线处理 =====
  function handleDisconnect(socket) {
    // 优先 O(1) 索引查找（断线是热路径），回退到全量扫描兜底
    const room = findPartyRoomByPlayerKey(socket.data.playerKey) || findPartyRoomByIdentityKey(socket.data.identityKey);
    if (!room) return;

    // 只按精确 socket.id 查找，绝不 re-key：
    // 玩家重连后已被 re-key 到新 socket，旧 socket 的 disconnect 是「陈旧连接」，
    // 若用 findPlayerInRoom 会把它 re-key 回死 socket 并广播虚假断线 → 断线计数累加。
    const player = room.players.get(socket.id);
    if (!player) return;

    player.lastSocketId = socket.id;
    player.identityKey = socket.data.identityKey;

    broadcast(room, 'party:player_disconnected', { playerId: socket.id, playerName: player.name });
    console.log(`[party] 断线 ${player.name} sid=${socket.id.slice(0,6)} 房间${room.code} 现人数=${room.players.size}`);

    player.dcTimer = setTimeout(() => {
      handlePartyLeave(room, socket, true);
    }, DISCONNECT);
  }

  // ===== 解散房间 =====
  function dissolveRoom(room, reason) {
    if (room._roundTimer) clearTimeout(room._roundTimer);
    if (room._revealTimer) clearTimeout(room._revealTimer);
    if (room._tickInterval) clearInterval(room._tickInterval);
    if (room._countdownInterval) clearInterval(room._countdownInterval);
    if (room._lowPlayersTimer) clearTimeout(room._lowPlayersTimer);
    // 先广播再 leave：玩家 leave 后 io.to(room.code) 为空集，否则解散消息无人收到
    broadcast(room, 'party:room_dissolved', { reason });
    for (const [sid] of room.players) {
      const sock = io.sockets.sockets.get(sid);
      if (sock) sock.leave(room.code);
    }
    for (const p of room.players.values()) {
      // 仅当索引仍指向本房间才删除，防止误删已迁移到其他房间的索引
      if (partyRoomPlayerIndex.get(p.playerKey) === room.code) partyRoomPlayerIndex.delete(p.playerKey);
      const entry = onlinePlayers.get(p.playerKey);
      if (entry && entry.type === 'party') { entry.type = 'idle'; entry.roomCode = null; }
      if (p.dcTimer) clearTimeout(p.dcTimer);
    }
    partyRooms.delete(room.code);
    console.log(`[派对] 房间${room.code} 解散 原因=${reason}`);
  }

  // ===== 周期清理 =====
  function runPeriodicCleanup() {
    for (const [code, room] of partyRooms) {
      const socks = io.sockets.adapter.rooms.get(code);
      const cnt = socks ? socks.size : 0;
      if (cnt === 0) {
        let hasPendingDC = false;
        for (const p of room.players.values()) {
          if (p.dcTimer) { hasPendingDC = true; break; }
        }
        if (!hasPendingDC) {
          if (room._roundTimer) clearTimeout(room._roundTimer);
          if (room._revealTimer) clearTimeout(room._revealTimer);
          if (room._tickInterval) clearInterval(room._tickInterval);
          if (room._countdownInterval) clearInterval(room._countdownInterval);
          if (room._lowPlayersTimer) clearTimeout(room._lowPlayersTimer);
          for (const p of room.players.values()) {
            if (partyRoomPlayerIndex.get(p.playerKey) === code) partyRoomPlayerIndex.delete(p.playerKey);
            const entry = onlinePlayers.get(p.playerKey);
            if (entry && entry.type === 'party') { entry.type = 'idle'; entry.roomCode = null; }
          }
          partyRooms.delete(code);
          continue;
        }
      }
      if (!room.started && !room.finished && room._createdAt && Date.now() - room._createdAt > 300_000) {
        dissolveRoom(room, 'expired');
      }
      if (room.finished && room._finishedAt && Date.now() - room._finishedAt > 300_000) {
        dissolveRoom(room, 'expired');
      }
    }
  }

  return {
    setGameCallbacks,
    // 查找
    findPartyRoomByPlayerKey,
    findPartyRoomByIdentityKey,
    findPlayerInRoom,
    // 广播
    broadcast,
    // 房间操作
    createPartyRoom,
    joinPartyRoom,
    reconnectPartyRoom,
    toggleReady,
    updateSettings,
    startGame,
    handlePartyLeave,
    handlePartyKick,
    handleDisconnect,
    dissolveRoom,
    runPeriodicCleanup,
    // 常量
    DISCONNECT,
    MAX_PLAYERS,
    MIN_PLAYERS,
  };
}
