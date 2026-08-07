// 回合管理 + 所有 Socket.IO 事件处理器
import { sanitizeString } from '../utils.js';
import { randomTarget } from '../characters.js';

const ROUND_TIME = 120_000;
const DISCONNECT = 30_000;

export function registerGameHandlers({
  io, rooms, roomPlayerIndex,
  findRoomByPlayerKey, findRoomByIdentityKey,
  genCode,
  onlinePlayers, onlineSockets, ONLINE_TIMEOUT,
  matchmakingQueue,
  handleJoinQueue, handleLeaveQueue, removeFromQueue,
}) {

  // ===== 回合管理 =====
  function startRound(room) {
    if (room.finished) return;
    if (room._roundTimer) clearTimeout(room._roundTimer);
    const target = randomTarget(room.difficulty || 'hard');
    room.target = target;
    room.roundSettled = false;
    room.surrendered = new Set();
    room._roundStartAt = Date.now();

    const timer = setTimeout(() => {
      room.roundSettled = true;
      io.to(room.code).emit('round_end', {
        winner: null, winnerName: '', targetName: target.name,
        score: score(room), matchOver: false,
      });
      room._nextRound = setTimeout(() => startRound(room), 5000);
    }, ROUND_TIME);
    room._roundTimer = timer;

    io.to(room.code).emit('round_start', {
      startTime: Date.now(), timeLimit: ROUND_TIME,
      score: score(room), target, difficulty: room.difficulty || 'hard',
      players: Array.from(room.players.entries()).map(([id, p]) => ({ id, name: p.name, wins: p.wins })),
    });
  }

  function endRound(room, winnerId, winnerName, targetName, matchOver) {
    if (room.roundSettled) return;
    room.roundSettled = true;
    room._roundStartAt = null; // 清除回合计时，防止重连时计算错误的 remainingTime
    if (room._roundTimer) { clearTimeout(room._roundTimer); room._roundTimer = null; }
    if (room._nextRound) { clearTimeout(room._nextRound); room._nextRound = null; }
    io.to(room.code).emit('round_end', { winner: winnerId, winnerName, targetName, score: score(room), matchOver });

    if (matchOver) {
      room.finished = true;
      room._finishedAt = Date.now();
      if (room._matchEndTimer) clearTimeout(room._matchEndTimer);
      room._matchEndTimer = setTimeout(() => {
        // Re-check: rematch_start may have reset finished flag
        if (!room.finished) return;
        io.to(room.code).emit('match_end', {
          winner: winnerId, winnerName, score: score(room),
          players: Array.from(room.players.entries()).map(([id, p]) => ({ id, name: p.name, wins: p.wins })),
        });
        for (const p of room.players.values()) {
          roomPlayerIndex.delete(p.playerKey);
          const e = onlinePlayers.get(p.playerKey);
          if (e && e.type === 'multi') { e.type = 'idle'; e.roomCode = null; }
        }
      }, 3000);
    } else {
      room._nextRound = setTimeout(() => startRound(room), 6000);
    }
  }

  function score(room) {
    const arr = Array.from(room.players.values());
    return `${arr[0]?.name || '?'} ${arr[0]?.wins || 0} - ${arr[1]?.wins || 0} ${arr[1]?.name || '?'}`;
  }

  // ===== 注册所有 Socket 事件 =====
  io.on('connection', (socket) => {
    console.log(`[+] ${socket.id} pk=${socket.data.playerKey?.slice(0, 10)}`);

    // 在线追踪（保留已有的 type/roomCode，避免多标签页覆盖游戏状态）
    const pk = socket.data.playerKey;
    if (!onlineSockets.has(pk)) onlineSockets.set(pk, new Set());
    onlineSockets.get(pk).add(socket.id);
    const existingEntry = onlinePlayers.get(pk);
    onlinePlayers.set(pk, {
      playerKey: pk,
      displayName: socket.data.displayName || existingEntry?.displayName || '',
      username: socket.data.username || existingEntry?.username || null,
      userId: socket.data.userId || existingEntry?.userId || null,
      type: existingEntry?.type || 'idle',
      roomCode: existingEntry?.roomCode || null,
      lastSeen: Date.now(),
    });

    // === 自动恢复：连接时查旧房 ===
    try {
    const existing = findRoomByPlayerKey(socket.data.playerKey);
    if (existing) {
      for (const [pid, player] of existing.players) {
        if (player.playerKey === socket.data.playerKey || player.identityKey === socket.data.identityKey) {
          // 防止多标签页抢槽：如果旧 socket 仍活跃，拒绝转移
          const oldSocket = io.sockets.sockets.get(pid);
          if (oldSocket && !player.dcTimer) {
            // 旧 socket 活跃且未断线 → 这是多标签页，拒绝（静默，旧标签页仍正常工作）
            socket.emit('error_msg', { message: '你已在另一标签页的游戏中' });
            return;
          }
          if (player.dcTimer) { clearTimeout(player.dcTimer); player.dcTimer = null; }
          player.identityKey = socket.data.identityKey;
          player.lastSocketId = pid;
          existing.players.delete(pid);
          existing.players.set(socket.id, player);
          socket.join(existing.code);
          socket.data.roomCode = existing.code;
          socket.to(existing.code).emit('opponent_reconnected', { playerName: player.name });
          socket.emit('existing_room', {
            code: existing.code, bestOf: existing.bestOf, difficulty: existing.difficulty || 'hard',
            started: existing.started, wins: player.wins,
          });
          if (existing.started) {
            const hasActiveRound = !!existing._roundStartAt;
            const remainingTime = hasActiveRound
              ? Math.max(0, Math.ceil((ROUND_TIME - (Date.now() - existing._roundStartAt)) / 1000))
              : 0;
            socket.emit('reconnect_state', {
              code: existing.code, bestOf: existing.bestOf, winsNeeded: existing.winsNeeded,
              score: score(existing), target: existing.target, remainingTime, hasActiveRound,
              players: Array.from(existing.players.entries()).map(([id, p]) => ({ id, name: p.name, wins: p.wins })),
            });
          }
          const reEntry = onlinePlayers.get(socket.data.playerKey);
          if (reEntry) { reEntry.type = 'multi'; reEntry.roomCode = existing.code; }
          console.log(`[恢复] ${socket.id} → ${existing.code}`);
          break;
        }
      }
    }
    } catch (e) { console.error('[game] connection auto-restore error:', e.message); }

    // === room:sync ===
    socket.on('room:sync', () => {
      const room = findRoomByIdentityKey(socket.data.identityKey);
      if (room && !room.finished) {
        socket.emit('room:sync', {
          room: { code: room.code, bestOf: room.bestOf, difficulty: room.difficulty || 'hard', started: room.started, status: room.started ? 'playing' : 'waiting' },
        });
      } else {
        socket.emit('room:sync', { room: null });
      }
    });

    // === matchmaking:join ===
    socket.on('matchmaking:join', (data) => {
      const existingR = findRoomByPlayerKey(socket.data.playerKey);
      if (existingR) {
        socket.emit('existing_room', {
          code: existingR.code, bestOf: existingR.bestOf,
          difficulty: existingR.difficulty || 'hard', started: existingR.started,
          wins: existingR.players.get(socket.id)?.wins || 0,
        });
        return;
      }
      handleJoinQueue(socket, data);
    });

    // === matchmaking:leave ===
    socket.on('matchmaking:leave', () => handleLeaveQueue(socket));

    // === create_room ===
    socket.on('create_room', (data) => {
      try {
      const hasRoom = findRoomByPlayerKey(socket.data.playerKey);
      if (hasRoom) {
        socket.emit('existing_room', {
          code: hasRoom.code, bestOf: hasRoom.bestOf,
          difficulty: hasRoom.difficulty || 'hard', started: hasRoom.started,
        });
        return;
      }

      if (data?._fromQuickRejoin) {
        socket.emit('room_expired', { message: '原房间已过期，已为您创建新房间' });
      }

      const code = genCode();
      const bestOf = [3, 5, 7].includes(data?.bestOf) ? data?.bestOf : 5;
      const difficulty = ['easy', 'medium', 'hard'].includes(data?.difficulty) ? data?.difficulty : 'hard';

      rooms.set(code, {
        code, bestOf, winsNeeded: Math.ceil(bestOf / 2), difficulty, _createdAt: Date.now(),
        players: new Map([[socket.id, {
          name: data?.playerName || '玩家', wins: 0, dcTimer: null,
          lastSocketId: null, playerKey: socket.data.playerKey,
          identityKey: socket.data.identityKey, ready: false,
        }]]),
        started: false, finished: false,
      });
      socket.join(code);
      socket.data.roomCode = code;
      roomPlayerIndex.set(socket.data.playerKey, code);

      const entry = onlinePlayers.get(socket.data.playerKey);
      if (entry) { entry.type = 'multi'; entry.roomCode = code; }

      socket.emit('room_created', { code, bestOf, difficulty });
      console.log(`[房] ${code} BO${bestOf}`);
      } catch (e) { console.error('[game] create_room error:', e.message); }
    });

    // === join_room ===
    socket.on('join_room', (data) => {
      try {
      const code = (data?.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) { socket.emit('error_msg', { message: '房间不存在' }); return; }
      if (room.players.size >= 2) {
        for (const [pid, p] of room.players) {
          if (p.dcTimer && (p.playerKey === socket.data.playerKey || p.identityKey === socket.data.identityKey)) {
            if (p.dcTimer) clearTimeout(p.dcTimer);
            p.lastSocketId = pid;
            room.players.delete(pid);
            room.players.set(socket.id, p);
            socket.join(code);
            socket.data.roomCode = code;
            roomPlayerIndex.set(socket.data.playerKey, code);
            const entry2 = onlinePlayers.get(socket.data.playerKey);
            if (entry2) { entry2.type = 'multi'; entry2.roomCode = code; }
            socket.to(code).emit('opponent_reconnected', { playerName: p.name });
            socket.emit('existing_room', { code, bestOf: room.bestOf, difficulty: room.difficulty || 'hard', started: room.started, wins: p.wins });
            if (room.started) {
              const hasActiveRound = !!room._roundStartAt;
              const remainingTime = hasActiveRound
                ? Math.max(0, Math.ceil((ROUND_TIME - (Date.now() - room._roundStartAt)) / 1000))
                : 0;
              socket.emit('reconnect_state', {
                code, bestOf: room.bestOf, winsNeeded: room.winsNeeded,
                score: room.players.size >= 2 ? `${Array.from(room.players.values())[0]?.name || '?'} ${Array.from(room.players.values())[0]?.wins || 0} - ${Array.from(room.players.values())[1]?.wins || 0} ${Array.from(room.players.values())[1]?.name || '?'}` : '',
                target: room.target, remainingTime, hasActiveRound,
                players: Array.from(room.players.entries()).map(([id, pl]) => ({ id, name: pl.name, wins: pl.wins })),
              });
            }
            console.log(`[重连] ${socket.id} → ${code}`);
            return;
          }
        }
        socket.emit('error_msg', { message: '房间已满' }); return;
      }

      room.players.set(socket.id, {
        name: data?.playerName || '玩家', wins: 0, dcTimer: null,
        lastSocketId: null, playerKey: socket.data.playerKey,
        identityKey: socket.data.identityKey, ready: false,
      });
      socket.join(code);
      socket.data.roomCode = code;
      roomPlayerIndex.set(socket.data.playerKey, code);

      const entry3 = onlinePlayers.get(socket.data.playerKey);
      if (entry3) { entry3.type = 'multi'; entry3.roomCode = code; }

      room.started = true;
      startRound(room);
      console.log(`[房] ${code} 满员`);
      } catch (e) { console.error('[game] join_room error:', e.message); }
    });

    // === _log ===
    socket.on('_log', (d) => {
      const action = typeof d?.action === 'string' ? d.action.replace(/\n/g, '\\n').slice(0, 200) : '[invalid]';
      console.log(`[日志] ${action}`);
    });

    // === guess_update ===
    socket.on('guess_update', (data) => {
      const room = rooms.get(socket.data.roomCode);
      if (!room || room.finished || room.roundSettled) return;
      socket.to(room.code).emit('opponent_update', {
        guessCount: data?.guessCount ?? 0,
        allComparisons: data?.allComparisons || [],
      });
    });

    // === player_win_round ===
    socket.on('player_win_round', (data) => {
      try {
      const room = rooms.get(socket.data.roomCode);
      if (!room || room.finished || room.roundSettled) return;
      const player = room.players.get(socket.id);
      if (!player) return;
      player.wins++;
      const won = player.wins >= room.winsNeeded;
      console.log(`[胜] ${player.name} ${player.wins}/${room.winsNeeded}`);
      endRound(room, socket.id, player.name, data?.targetName || room.target?.name || '', won);
      } catch (e) { console.error('[game] player_win_round error:', e.message); }
    });

    // === surrender_round ===
    socket.on('surrender_round', (data) => {
      try {
      const room = rooms.get(socket.data.roomCode);
      if (!room || room.finished || room.roundSettled) return;
      const player = room.players.get(socket.id);
      if (!player) return; // 只允许房间内的真实玩家弃权，防止幽灵 socket 利用
      // 单人弃权 = 对方胜
      const otherId = Array.from(room.players.keys()).find(id => id !== socket.id);
      const otherPlayer = room.players.get(otherId);
      if (otherPlayer) {
        otherPlayer.wins++;
        const won = otherPlayer.wins >= room.winsNeeded;
        console.log(`[弃权] ${room.players.get(socket.id)?.name} → ${otherPlayer.name} ${otherPlayer.wins}/${room.winsNeeded}`);
        endRound(room, otherId, otherPlayer.name, data?.targetName || room.target?.name || '', won);
      }
      } catch (e) { console.error('[game] surrender_round error:', e.message); }
    });

    // === rematch_ready ===
    socket.on('rematch_ready', () => {
      try {
      const room = rooms.get(socket.data.roomCode);
      if (!room || !room.finished) return;
      const player = room.players.get(socket.id);
      if (!player) return;
      player.ready = true;

      if (room._rematchTimer) clearTimeout(room._rematchTimer);
      room._rematchTimer = setTimeout(() => {
        if (!room.finished) return;
        for (const p of room.players.values()) p.ready = false;
        io.to(room.code).emit('rematch_cancelled', { playerName: '系统', reason: 'timeout' });
      }, 60_000);

      if (Array.from(room.players.values()).every(p => p.ready) && room.players.size >= 2) {
        if (room._rematchTimer) { clearTimeout(room._rematchTimer); room._rematchTimer = null; }
        if (room._matchEndTimer) { clearTimeout(room._matchEndTimer); room._matchEndTimer = null; }
        room.players.forEach(p => { p.wins = 0; p.ready = false; });
        room.finished = false; room.target = null;
        for (const p of room.players.values()) roomPlayerIndex.set(p.playerKey, room.code);
        for (const p of room.players.values()) {
          const entry = onlinePlayers.get(p.playerKey);
          if (entry) { entry.type = 'multi'; entry.roomCode = room.code; }
        }
        io.to(room.code).emit('rematch_start', { bestOf: room.bestOf, winsNeeded: room.winsNeeded });
        setTimeout(() => startRound(room), 1500);
      }
      } catch (e) { console.error('[game] rematch_ready error:', e.message); }
    });

    // === rematch_cancel ===
    socket.on('rematch_cancel', () => {
      const room = rooms.get(socket.data.roomCode);
      if (!room || !room.finished) return;
      const player = room.players.get(socket.id);
      if (player) player.ready = false;
      if (room._rematchTimer) { clearTimeout(room._rematchTimer); room._rematchTimer = null; }
      socket.to(room.code).emit('rematch_cancelled', { playerName: player?.name });
    });

    // === disconnect ===
    socket.on('disconnect', () => {
      const pk = socket.data.playerKey;
      const sockSet = onlineSockets.get(pk);
      if (sockSet) {
        sockSet.delete(socket.id);
        if (sockSet.size === 0) {
          const entry = onlinePlayers.get(pk);
          if (entry) entry.lastSeen = Date.now();
        }
      }

      removeFromQueue(socket.id);

      const room = rooms.get(socket.data.roomCode);
      if (!room) return;
      // P1 fix: finished but rematch pending — still handle disconnect
      if (room.finished) {
        if (room._rematchTimer) {
          const p = room.players.get(socket.id);
          if (p) {
            p.dcTimer = null;
            p.ready = false; // R3: 防止断线后 rematch 带幽灵玩家启动
            io.to(room.code).emit('opponent_disconnected', { playerName: p.name });
            const other = Array.from(room.players.values()).find(x => x.playerKey !== p.playerKey);
            if (other && other.ready) {
              other.ready = false;
              clearTimeout(room._rematchTimer);
              room._rematchTimer = null;
              io.to(room.code).emit('rematch_cancelled', { playerName: '系统', reason: 'opponent_left' });
            }
          }
        }
        return;
      }
      const player = room.players.get(socket.id);
      if (!player) return;
      player.lastSocketId = socket.id;
      player.identityKey = socket.data.identityKey;
      io.to(room.code).emit('opponent_disconnected', { playerName: player.name });

      player.dcTimer = setTimeout(() => {
        // 如果在 roundSettled 窗口（回合刚结束/比赛中），延后检查
        if (room.roundSettled || room.finished) {
          // 重新设置一个短定时器，在回合结束后再次检查
          if (player.dcTimer) clearTimeout(player.dcTimer);
          player.dcTimer = setTimeout(() => {
            if (room.roundSettled || room.finished) return;
            if (room._roundTimer) { clearTimeout(room._roundTimer); room._roundTimer = null; }
            if (room._nextRound) { clearTimeout(room._nextRound); room._nextRound = null; }
            const other = Array.from(room.players.keys()).find(id => id !== socket.id);
            io.to(room.code).emit('match_end', {
              winner: other, winnerName: room.players.get(other)?.name || '对手',
              score: score(room), reason: 'disconnect',
              players: Array.from(room.players.entries()).map(([id, p]) => ({ id, name: p.name, wins: p.wins })),
            });
            room.finished = true;
            room._finishedAt = Date.now();
            for (const p of room.players.values()) roomPlayerIndex.delete(p.playerKey);
            for (const p of room.players.values()) {
              const entry = onlinePlayers.get(p.playerKey);
              if (entry && entry.type === 'multi') { entry.type = 'idle'; entry.roomCode = null; }
            }
          }, DISCONNECT);
          return;
        }
        if (room._roundTimer) { clearTimeout(room._roundTimer); room._roundTimer = null; }
        if (room._nextRound) { clearTimeout(room._nextRound); room._nextRound = null; }
        const other = Array.from(room.players.keys()).find(id => id !== socket.id);
        io.to(room.code).emit('match_end', {
          winner: other, winnerName: room.players.get(other)?.name || '对手',
          score: score(room), reason: 'disconnect',
          players: Array.from(room.players.entries()).map(([id, p]) => ({ id, name: p.name, wins: p.wins })),
        });
        room.finished = true;
        room._finishedAt = Date.now();
        for (const p of room.players.values()) roomPlayerIndex.delete(p.playerKey);
        for (const p of room.players.values()) {
          const entry = onlinePlayers.get(p.playerKey);
          if (entry && entry.type === 'multi') { entry.type = 'idle'; entry.roomCode = null; }
        }
      }, DISCONNECT);
    });

    // === reconnect_room ===
    socket.on('reconnect_room', (data) => {
      try {
      const code = (data?.code || '').toUpperCase();
      const room = rooms.get(code);

      if (!room) {
        socket.emit('room_expired', { message: '房间不存在或已过期' });
        return;
      }
      if (room.finished) {
        socket.emit('room_expired', { message: '比赛已结束' });
        return;
      }

      let foundPid = null;
      for (const [pid, p] of room.players) {
        if (p.playerKey === socket.data.playerKey || p.identityKey === socket.data.identityKey) {
          foundPid = pid; break;
        }
      }
      if (!foundPid) {
        socket.emit('room_expired', { message: '你不在该房间中' });
        return;
      }
      const player = room.players.get(foundPid);
      if (player.dcTimer) { clearTimeout(player.dcTimer); player.dcTimer = null; }
      room.players.delete(foundPid);
      room.players.set(socket.id, player);
      socket.join(code);
      socket.data.roomCode = code;
      socket.to(code).emit('opponent_reconnected', { playerName: player.name });

      if (room.started) {
        const hasActiveRound = !!room._roundStartAt;
        const remainingTime = hasActiveRound
          ? Math.max(0, Math.ceil((ROUND_TIME - (Date.now() - room._roundStartAt)) / 1000))
          : 0;
        socket.emit('reconnect_state', {
          code, bestOf: room.bestOf, winsNeeded: room.winsNeeded,
          score: score(room), target: room.target, remainingTime, hasActiveRound,
          players: Array.from(room.players.entries()).map(([id, p]) => ({ id, name: p.name, wins: p.wins })),
        });
      } else {
        socket.emit('existing_room', {
          code, bestOf: room.bestOf, difficulty: room.difficulty || 'hard',
          started: false, wins: player.wins,
        });
      }

      const reEntry = onlinePlayers.get(socket.data.playerKey);
      if (reEntry) { reEntry.type = 'multi'; reEntry.roomCode = code; }
      console.log(`[重连] ${socket.id} → ${code}`);
      } catch (e) { console.error('[game] reconnect_room error:', e.message); }
    });
  });

  // ===== 周期清理（由 index.js 中统一的 setInterval 调用） =====
  function runPeriodicCleanup() {
    // 清理空/过期房间
    for (const [code, room] of rooms) {
      const socks = io.sockets.adapter.rooms.get(code);
      const cnt = socks ? socks.size : 0;
      if (cnt === 0) {
        // 跳过有 dcTimer 的房间（玩家在重连窗口内）
        let hasPendingDC = false;
        for (const p of room.players.values()) {
          if (p.dcTimer) { hasPendingDC = true; break; }
        }
        if (!hasPendingDC) {
          if (room._roundTimer) clearTimeout(room._roundTimer);
          if (room._nextRound) clearTimeout(room._nextRound);
          if (room._matchEndTimer) clearTimeout(room._matchEndTimer);
          if (room._rematchTimer) clearTimeout(room._rematchTimer);
          for (const p of room.players.values()) roomPlayerIndex.delete(p.playerKey);
          rooms.delete(code);
        }
      }
      if (!room.started && !room.finished && room._createdAt && Date.now() - room._createdAt > 300_000) {
        if (room._roundTimer) clearTimeout(room._roundTimer);
        if (room._matchEndTimer) clearTimeout(room._matchEndTimer);
        if (room._rematchTimer) clearTimeout(room._rematchTimer);
        for (const p of room.players.values()) roomPlayerIndex.delete(p.playerKey);
        rooms.delete(code);
      }
      if (room.finished && room._finishedAt && Date.now() - room._finishedAt > 300_000) {
        if (room._roundTimer) clearTimeout(room._roundTimer);
        if (room._matchEndTimer) clearTimeout(room._matchEndTimer);
        if (room._rematchTimer) clearTimeout(room._rematchTimer);
        for (const p of room.players.values()) roomPlayerIndex.delete(p.playerKey);
        rooms.delete(code);
      }
    }

    // 清理超时离线玩家
    const _now = Date.now();
    for (const [pk, entry] of onlinePlayers) {
      const sockSet = onlineSockets.get(pk);
      if ((!sockSet || sockSet.size === 0) && _now - entry.lastSeen > ONLINE_TIMEOUT) {
        onlinePlayers.delete(pk);
        onlineSockets.delete(pk);
      }
    }

    // 清理超时排队
    const _queueNow = Date.now();
    for (const [sid, entry] of matchmakingQueue) {
      if (_queueNow - entry.joinedAt > 300_000) {
        matchmakingQueue.delete(sid);
        const sock = io.sockets.sockets.get(sid);
        if (sock) {
          sock.emit('matchmaking:status', { queued: false, position: 0, difficulty: '' });
        }
      }
    }
  }

  return { startRound, endRound, score, runPeriodicCleanup };
}
