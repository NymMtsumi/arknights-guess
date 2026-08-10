// 派对模式 — 房间管理（创建/加入/离开/踢人/解散/清理）
import { sanitizeString } from '../utils.js';

const DISCONNECT = 30_000;
const MAX_PLAYERS = 6;
const MIN_PLAYERS = 4;

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
  function makePlayer(socket, name) {
    return {
      name: sanitizeString(name || '玩家', 20),
      wins: 0,
      dcTimer: null,
      lastSocketId: null,
      playerKey: socket.data.playerKey,
      identityKey: socket.data.identityKey,
      ready: false,
    };
  }

  // ===== 创建房间 =====
  function createPartyRoom(socket, data) {
    const existing = findPartyRoomByPlayerKey(socket.data.playerKey);
    if (existing) {
      socket.emit('party:error', { code: 'ALREADY_IN_ROOM', message: '你已在派对房间中' });
      return;
    }
    const multiCode = roomPlayerIndex?.get(socket.data.playerKey);
    if (multiCode && rooms?.has(multiCode)) {
      socket.emit('party:error', { code: 'ALREADY_IN_ROOM', message: '你已在多人对战房间中' });
      return;
    }

    const playerName = sanitizeString(data?.playerName || '玩家', 20);
    const difficulty = ['easy', 'medium', 'hard'].includes(data?.difficulty) ? data?.difficulty : 'hard';
    const rounds = [5, 7, 10].includes(data?.rounds) ? data?.rounds : 7;
    const roundTime = [60, 120, 180, 240, 300].includes(data?.roundTime) ? data?.roundTime : 120;

    const code = genPartyCode();
    const room = {
      code,
      hostId: socket.id,
      players: new Map([[socket.id, makePlayer(socket, playerName)]]),
      settings: { difficulty, rounds, roundTime },
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

    socket.emit('party:created', { roomCode: code });
    console.log(`[派对] 创建房间 ${code} 房主=${playerName}`);
  }

  // ===== 加入房间 =====
  function joinPartyRoom(socket, data) {
    const code = String(data?.roomCode || '').trim();
    const room = partyRooms.get(code);
    if (!room) { socket.emit('party:error', { code: 'ROOM_NOT_FOUND', message: '房间不存在' }); return; }
    if (room.started) { socket.emit('party:error', { code: 'GAME_STARTED', message: '游戏已开始，无法加入' }); return; }
    if (room.finished) { socket.emit('party:error', { code: 'GAME_ENDED', message: '游戏已结束' }); return; }
    if (room.players.size >= MAX_PLAYERS) { socket.emit('party:error', { code: 'ROOM_FULL', message: '房间已满（最多6人）' }); return; }

    // 跨房间检查
    const existingRoom = findPartyRoomByPlayerKey(socket.data.playerKey);
    if (existingRoom && existingRoom.code !== code) {
      socket.emit('party:error', { code: 'ALREADY_IN_ROOM', message: '你已在其他派对房间中' });
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
        return;
      }
    }

    // 重连检查
    for (const [pid, p] of room.players) {
      if (p.playerKey === socket.data.playerKey || p.identityKey === socket.data.identityKey) {
        if (pid !== socket.id) {
          const oldSocket = io.sockets.sockets.get(pid);
          if (oldSocket && oldSocket.connected) {
            socket.emit('party:error', { code: 'MULTI_TAB', message: '你已在其他标签页中连接' });
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
          players: Array.from(room.players.entries()).map(([id, pl]) => ({ id, name: pl.name, ready: pl.ready })),
        });
        return;
      }
    }

    // 新玩家
    const playerName = sanitizeString(data?.playerName || '玩家', 20);
    room.players.set(socket.id, makePlayer(socket, playerName));
    socket.join(code);
    registerOnline(socket, code);

    broadcast(room, 'party:player_joined', { id: socket.id, name: playerName, ready: false });
    socket.emit('party:joined', {
      room: { code: room.code, hostId: room.hostId, settings: room.settings, started: room.started },
      players: Array.from(room.players.entries()).map(([id, pl]) => ({ id, name: pl.name, ready: pl.ready })),
    });
    console.log(`[派对] ${playerName} 加入房间 ${code} (${room.players.size}/${MAX_PLAYERS})`);
  }

  // ===== 重连 =====
  function reconnectPartyRoom(socket, data) {
    const code = String(data?.roomCode || '').trim();
    const room = partyRooms.get(code);
    if (!room) { socket.emit('party:error', { code: 'ROOM_NOT_FOUND', message: '房间不存在' }); return; }

    let foundPlayer = null;
    let foundOldId = null;
    for (const [pid, p] of room.players) {
      if (p.playerKey === socket.data.playerKey || p.identityKey === socket.data.identityKey) {
        foundPlayer = p;
        foundOldId = pid;
        break;
      }
    }
    if (!foundPlayer) { socket.emit('party:error', { code: 'NOT_IN_ROOM', message: '你不在该房间中' }); return; }

    if (foundOldId !== socket.id) {
      const oldSocket = io.sockets.sockets.get(foundOldId);
      if (oldSocket && oldSocket.connected) {
        socket.emit('party:error', { code: 'MULTI_TAB', message: '你已在其他标签页中连接' });
        return;
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
      players: Array.from(room.players.entries()).map(([id, pl]) => ({ id, name: pl.name, ready: pl.ready })),
    };

    if (room.started && !room.finished) {
      state.currentRound = room.currentRound;
      state.targetName = room.target?.name || '';
      state.roundFinished = room.roundFinished;
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
      state.finalRankings = [];
      for (const [sid, player] of room.players) {
        state.finalRankings.push({
          playerId: sid,
          playerName: player.name,
          totalScore: room.scores.get(player.playerKey) || 0,
        });
      }
      state.finalRankings.sort((a, b) => b.totalScore - a.totalScore);
    }

    socket.emit('party:reconnect_state', state);
    console.log(`[派对] ${foundPlayer.name} 重连到房间 ${code}`);
  }

  // ===== 切换准备 =====
  function toggleReady(socket) {
    const room = findPartyRoomByIdentityKey(socket.data.identityKey);
    if (!room || room.started) return;
    const player = findPlayerInRoom(room, socket);
    if (!player || socket.id === room.hostId) return;
    player.ready = !player.ready;
    broadcast(room, 'party:player_ready', { playerId: socket.id, ready: player.ready });
  }

  // ===== 更新设置 =====
  function updateSettings(socket, data) {
    const room = findPartyRoomByIdentityKey(socket.data.identityKey);
    if (!room || room.started || room.finished) return;
    if (room.hostId !== socket.id) return;
    if (data?.difficulty && ['easy', 'medium', 'hard'].includes(data.difficulty)) room.settings.difficulty = data.difficulty;
    if (data?.rounds && [5, 7, 10].includes(data.rounds)) room.settings.rounds = data.rounds;
    if (data?.roundTime && [60, 120, 180, 240, 300].includes(data.roundTime)) room.settings.roundTime = data.roundTime;
    broadcast(room, 'party:settings_updated', { settings: room.settings });
  }

  // ===== 开始游戏 =====
  function startGame(socket) {
    const room = findPartyRoomByIdentityKey(socket.data.identityKey);
    if (!room || room.started || room.finished) return;
    if (room.hostId !== socket.id) return;

    const onlineCount = [...room.players.values()].filter(p => !p.dcTimer).length;
    if (onlineCount < MIN_PLAYERS) {
      socket.emit('party:error', { code: 'NEED_MORE_PLAYERS', message: `至少需要${MIN_PLAYERS}名玩家`, minPlayers: MIN_PLAYERS });
      return;
    }
    let allReady = true;
    for (const [sid, p] of room.players) {
      if (sid !== room.hostId && !p.ready) { allReady = false; break; }
    }
    if (!allReady) {
      socket.emit('party:error', { code: 'NOT_ALL_READY', message: '还有玩家未准备' });
      return;
    }

    room.started = true;
    room.currentRound = 0;
    room.scores = new Map();
    room.roundResults = [];

    const players = Array.from(room.players.entries()).map(([id, pl]) => ({
      id, name: pl.name, ready: pl.ready,
    }));
    broadcast(room, 'party:game_starting', { countdown: 5, players });

    let countdown = 5;
    room._countdownInterval = setInterval(() => {
      countdown--;
      if (countdown <= 0) {
        clearInterval(room._countdownInterval);
        room._countdownInterval = null;
        if (partyRooms.has(room.code) && _partyRoundStart) _partyRoundStart(room);
      } else {
        broadcast(room, 'party:game_starting', { countdown, players });
      }
    }, 1000);
  }

  // ===== 离开 =====
  function handlePartyLeave(room, socket, isTimeout) {
    const player = findPlayerInRoom(room, socket) || room.players.get(socket.id);
    if (!player) return;
    if (player.dcTimer) { clearTimeout(player.dcTimer); player.dcTimer = null; }

    // 等待室阶段离开
    if (!room.started) {
      room.players.delete(socket.id);
      partyRoomPlayerIndex.delete(player.playerKey);
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
    partyRoomPlayerIndex.delete(player.playerKey);
    const entry = onlinePlayers.get(player.playerKey);
    if (entry && entry.type === 'party') { entry.type = 'idle'; entry.roomCode = null; }

    const onlineCount = room.players.size;
    if (onlineCount < MIN_PLAYERS && room.started && !room.finished) {
      broadcast(room, 'party:insufficient_players', { current: onlineCount, minimum: MIN_PLAYERS });
      room._lowPlayersTimer = setTimeout(() => {
        if (room.players.size < MIN_PLAYERS && room.started && !room.finished) {
          dissolveRoom(room, 'insufficient_players');
        }
      }, DISCONNECT);
    }

    if (room.players.size === 0) dissolveRoom(room, 'all_left');
  }

  // ===== 踢人 =====
  function handlePartyKick(socket, data) {
    const room = findPartyRoomByIdentityKey(socket.data.identityKey);
    if (!room || room.hostId !== socket.id) return;
    const targetSid = data?.playerId;
    const target = room.players.get(targetSid);
    if (!target || targetSid === socket.id) return;

    const targetSocket = io.sockets.sockets.get(targetSid);
    if (targetSocket) targetSocket.leave(room.code);

    if (room.started && !room.finished) {
      const rp = room.roundPlayers.get(targetSid);
      if (rp && !rp.guessed) rp.exhausted = true;
      room.roundPlayers.delete(targetSid);
      if (_checkAllDone) _checkAllDone(room);
    }

    room.players.delete(targetSid);
    partyRoomPlayerIndex.delete(target.playerKey);
    const entry = onlinePlayers.get(target.playerKey);
    if (entry && entry.type === 'party') { entry.type = 'idle'; entry.roomCode = null; }

    if (room.started && !room.finished && room.players.size < MIN_PLAYERS) {
      broadcast(room, 'party:insufficient_players', { current: room.players.size, minimum: MIN_PLAYERS });
      room._lowPlayersTimer = setTimeout(() => {
        if (room.players.size < MIN_PLAYERS && room.started && !room.finished) {
          dissolveRoom(room, 'insufficient_players');
        }
      }, DISCONNECT);
    }

    io.to(targetSid).emit('party:kicked');
    broadcast(room, 'party:player_left', { playerId: targetSid, playerName: target.name });
  }

  // ===== 断线处理 =====
  function handleDisconnect(socket) {
    const room = findPartyRoomByIdentityKey(socket.data.identityKey);
    if (!room) return;

    const player = findPlayerInRoom(room, socket) || room.players.get(socket.id);
    if (!player) return;

    player.lastSocketId = socket.id;
    player.identityKey = socket.data.identityKey;

    if (room.finished) {
      cleanupEmptyRoom(room);
      return;
    }

    broadcast(room, 'party:player_disconnected', { playerId: socket.id, playerName: player.name });

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
    for (const [sid] of room.players) {
      const sock = io.sockets.sockets.get(sid);
      if (sock) sock.leave(room.code);
    }
    for (const p of room.players.values()) {
      partyRoomPlayerIndex.delete(p.playerKey);
      const entry = onlinePlayers.get(p.playerKey);
      if (entry && entry.type === 'party') { entry.type = 'idle'; entry.roomCode = null; }
      if (p.dcTimer) clearTimeout(p.dcTimer);
    }
    broadcast(room, 'party:room_dissolved', { reason });
    partyRooms.delete(room.code);
    console.log(`[派对] 房间${room.code} 解散 原因=${reason}`);
  }

  function cleanupEmptyRoom(room) {
    let hasOnline = false;
    for (const [sid] of room.players) {
      if (io.sockets.sockets.has(sid)) { hasOnline = true; break; }
    }
    if (!hasOnline) dissolveRoom(room, 'all_disconnected');
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
            partyRoomPlayerIndex.delete(p.playerKey);
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
    cleanupEmptyRoom,
    runPeriodicCleanup,
    // 常量
    DISCONNECT,
    MAX_PLAYERS,
    MIN_PLAYERS,
  };
}
