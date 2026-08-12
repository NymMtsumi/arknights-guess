// 回合管理 + 所有 Socket.IO 事件处理器
import { sanitizeString } from '../utils.js';
import { randomTarget } from '../characters.js';

const ROUND_TIME = 120_000;
const DISCONNECT = 30_000;
const DISBAND_COOLDOWN = 120_000; // 解散房间后 120 秒内不能创建新房间

export function registerGameHandlers({
  io, rooms, roomPlayerIndex,
  findRoomByPlayerKey, findRoomByIdentityKey,
  genCode,
  onlinePlayers, onlineSockets, ONLINE_TIMEOUT,
  handleJoinQueue, handleLeaveQueue, removeFromQueue, cleanupStaleQueue,
}) {

  const roomCooldowns = new Map(); // playerKey → expiry timestamp (ms)

  // ===== 回合管理 =====
  function startRound(room) {
    if (room.finished) return;
    if (room._roundTimer) clearTimeout(room._roundTimer);
    const target = randomTarget(room.difficulty || 'hard');
    room.target = target;
    room.roundSettled = false;
    room.surrendered = new Set();
    room._roundStartAt = Date.now();
    // 跟踪本回合每位玩家的状态
    room._roundPlayers = new Map();
    for (const [sid, p] of room.players) {
      room._roundPlayers.set(sid, { guessed: false, exhausted: false, surrendered: false });
    }

    const timer = setTimeout(() => {
      // 回合超时 = 平局（双方均未猜出且未放弃）
      if (room.roundSettled) return; // 防御：player_win_round 已先行结算
      room.roundSettled = true;
      room._roundStartAt = null;
      io.to(room.code).emit('round_end', {
        winner: null, winnerName: '', targetName: target.name,
        score: score(room), matchOver: false, reason: 'timeout',
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
    // 按 playerKey 稳定排序，防止重连（delete+set 改变 Map 插入顺序）导致比分方向对调
    const arr = Array.from(room.players.values()).sort((a, b) => a.playerKey.localeCompare(b.playerKey));
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
      lastIp: socket.data.ip || existingEntry?.lastIp || null,
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
            started: existing.started, wins: player.wins, _createdAt: existing._createdAt,
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
        // 通过 playerKey/identityKey 查找玩家信息，而非 socket.id（重连后 id 会变）
        let wins = 0;
        for (const [, p] of existingR.players) {
          if (p.playerKey === socket.data.playerKey || p.identityKey === socket.data.identityKey) {
            wins = p.wins; break;
          }
        }
        socket.emit('existing_room', {
          code: existingR.code, bestOf: existingR.bestOf,
          difficulty: existingR.difficulty || 'hard', started: existingR.started,
          wins, _createdAt: existingR._createdAt,
        });
        return;
      }
      // 检查解散冷却
      const cooldownUntil = roomCooldowns.get(socket.data.playerKey);
      if (cooldownUntil && Date.now() < cooldownUntil) {
        const remaining = Math.ceil((cooldownUntil - Date.now()) / 1000);
        socket.emit('error_msg', { message: `解散房间后需等待 ${remaining} 秒才能进行快速匹配`, cooldown: remaining });
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
          _createdAt: hasRoom._createdAt,
        });
        return;
      }

      // 检查解散冷却
      const cooldownUntil = roomCooldowns.get(socket.data.playerKey);
      if (cooldownUntil && Date.now() < cooldownUntil) {
        const remaining = Math.ceil((cooldownUntil - Date.now()) / 1000);
        socket.emit('error_msg', { message: `解散房间后需等待 ${remaining} 秒才能创建新房间`, cooldown: remaining });
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
          name: sanitizeString(data?.playerName || '玩家', 20), wins: 0, dcTimer: null,
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
            socket.emit('existing_room', { code, bestOf: room.bestOf, difficulty: room.difficulty || 'hard', started: room.started, wins: p.wins, _createdAt: room._createdAt });
            if (room.started) {
              const hasActiveRound = !!room._roundStartAt;
              const remainingTime = hasActiveRound
                ? Math.max(0, Math.ceil((ROUND_TIME - (Date.now() - room._roundStartAt)) / 1000))
                : 0;
              socket.emit('reconnect_state', {
                code, bestOf: room.bestOf, winsNeeded: room.winsNeeded,
                score: room.players.size >= 2 ? score(room) : '',
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
        name: sanitizeString(data?.playerName || '玩家', 20), wins: 0, dcTimer: null,
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
    let _logCount = 0, _logResetAt = Date.now();
    socket.on('_log', (d) => {
      const now = Date.now();
      if (now - _logResetAt > 10_000) { _logCount = 0; _logResetAt = now; }
      if (++_logCount > 5) return; // 限速：每 10 秒最多 5 条
      const action = typeof d?.action === 'string' ? d.action.replace(/\n/g, '\\n').slice(0, 200) : '[invalid]';
      console.log(`[日志] ${action}`);
    });

    // === guess_update ===
    socket.on('guess_update', (data) => {
      const room = rooms.get(socket.data.roomCode);
      if (!room || room.finished || room.roundSettled) return;
      if (!room.players.has(socket.id)) return; // 防止 stale roomCode 跨房间数据泄露
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

      // 标记猜出状态（防重复上报：同一回合只能赢一次）
      const rp = room._roundPlayers?.get(socket.id);
      if (rp?.guessed) return;
      if (rp) rp.guessed = true;

      player.wins++;
      const won = player.wins >= room.winsNeeded;
      console.log(`[胜] ${player.name} ${player.wins}/${room.winsNeeded}`);
      endRound(room, socket.id, player.name, data?.targetName || room.target?.name || '', won);
      } catch (e) { console.error('[game] player_win_round error:', e.message); }
    });

    // === player_exhausted ===
    socket.on('player_exhausted', (data) => {
      try {
      const room = rooms.get(socket.data.roomCode);
      if (!room || room.finished || room.roundSettled) return;
      const player = room.players.get(socket.id);
      if (!player) return;

      const rp = room._roundPlayers?.get(socket.id);
      if (rp) rp.exhausted = true;

      // 检查双方是否均耗尽 → 平局
      const otherId = Array.from(room.players.keys()).find(id => id !== socket.id);
      const otherRp = otherId ? room._roundPlayers?.get(otherId) : null;
      if (otherRp?.exhausted) {
        console.log(`[耗尽] 双方次数耗尽 → 平局`);
        endRound(room, null, '', data?.targetName || room.target?.name || '', false);
        // 平局不加分
      }
      } catch (e) { console.error('[game] player_exhausted error:', e.message); }
    });

    // === surrender_round ===
    socket.on('surrender_round', (data) => {
      try {
      const room = rooms.get(socket.data.roomCode);
      if (!room || room.finished || room.roundSettled) return;
      const player = room.players.get(socket.id);
      if (!player) return;

      const rp = room._roundPlayers?.get(socket.id);
      if (rp) rp.surrendered = true;

      const otherId = Array.from(room.players.keys()).find(id => id !== socket.id);
      const otherPlayer = otherId ? room.players.get(otherId) : null;
      const otherRp = otherId ? room._roundPlayers?.get(otherId) : null;

      // 通知对方你已放弃
      socket.to(room.code).emit('opponent_surrendered', { playerName: player.name });

      // 判断胜负：
      // 对方已猜出 → 对方胜
      if (otherRp?.guessed) {
        console.log(`[弃权] ${player.name} 弃权 → ${otherPlayer?.name} 已猜出，胜出`);
        endRound(room, otherId, otherPlayer?.name || '对手', data?.targetName || room.target?.name || '', otherPlayer ? otherPlayer.wins >= room.winsNeeded : false);
        return;
      }

      // 对方已放弃或已耗尽 → 双方弃权/放弃vs耗尽 → 平局
      if (otherRp?.surrendered || otherRp?.exhausted) {
        console.log(`[弃权] 双方弃权/耗尽 → 平局`);
        endRound(room, null, '', data?.targetName || room.target?.name || '', false);
        return;
      }

      // 对方未猜出、未放弃 → 平局（弃权方主动放弃，不判对方胜）
      // KNOWN EDGE CASE: If both players surrender_round within the same event-loop tick,
      // the second emit may see the first's surrender flag set via otherRp?.surrendered and
      // take the "both surrendered → draw" branch above. This is rare (< ~1ms race window)
      // and the outcome is the same (draw), so it is accepted without a setTimeout defense.
      console.log(`[弃权] ${player.name} 弃权 → 对方未猜出 → 平局`);
      endRound(room, null, '', data?.targetName || room.target?.name || '', false);
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
      // 重置双方 ready 标志，防止一方取消后另一方 stale ready 导致误启动
      for (const p of room.players.values()) p.ready = false;
      if (room._rematchTimer) { clearTimeout(room._rematchTimer); room._rematchTimer = null; }
      socket.to(room.code).emit('rematch_cancelled', { playerName: room.players.get(socket.id)?.name });
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
            // B9 fix: 断线立即取消 rematch，不等待超时
            const other = Array.from(room.players.values()).find(x => x.playerKey !== p.playerKey);
            if (other) other.ready = false;
            clearTimeout(room._rematchTimer);
            room._rematchTimer = null;
            io.to(room.code).emit('rematch_cancelled', { playerName: '系统', reason: 'opponent_left' });
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
        // 检查对方是否也离线了
        const otherId = Array.from(room.players.keys()).find(id => id !== socket.id);
        const otherPlayer = otherId ? room.players.get(otherId) : null;
        let bothOffline = false;
        if (otherPlayer) {
          const otherPk = otherPlayer.playerKey;
          const otherSocks = onlineSockets.get(otherPk);
          if (!otherSocks || otherSocks.size === 0) {
            bothOffline = true;
          }
        }

        if (bothOffline) {
          // 双方离线 → 解散房间，双方判负
          console.log(`[断线] 双方离线 → 解散房间 ${room.code}`);
          if (room._roundTimer) { clearTimeout(room._roundTimer); room._roundTimer = null; }
          if (room._nextRound) { clearTimeout(room._nextRound); room._nextRound = null; }
          io.to(room.code).emit('match_end', {
            winner: null, winnerName: '', score: score(room), reason: 'both_disconnected',
            players: Array.from(room.players.entries()).map(([id, p]) => ({ id, name: p.name, wins: p.wins })),
          });
          room.finished = true;
          room._finishedAt = Date.now();
          for (const p of room.players.values()) roomPlayerIndex.delete(p.playerKey);
          for (const p of room.players.values()) {
            const entry = onlinePlayers.get(p.playerKey);
            if (entry && entry.type === 'multi') { entry.type = 'idle'; entry.roomCode = null; }
          }
          return;
        }

        // 单方离线 → 离线方判负
        if (room.finished) return; // 比赛已正常结束，match_end 流程已处理
        if (room.roundSettled) {
          // 回合刚结束（等待下一回合），延长宽限期让玩家有机会重连
          if (player.dcTimer) clearTimeout(player.dcTimer);
          player.dcTimer = setTimeout(() => {
            if (room.finished) return;
            if (room._roundTimer) { clearTimeout(room._roundTimer); room._roundTimer = null; }
            if (room._nextRound) { clearTimeout(room._nextRound); room._nextRound = null; }
            io.to(room.code).emit('match_end', {
              winner: otherId, winnerName: otherPlayer?.name || '对手',
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
        io.to(room.code).emit('match_end', {
          winner: otherId, winnerName: otherPlayer?.name || '对手',
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
          started: false, wins: player.wins, _createdAt: room._createdAt,
        });
      }

      const reEntry = onlinePlayers.get(socket.data.playerKey);
      if (reEntry) { reEntry.type = 'multi'; reEntry.roomCode = code; }
      console.log(`[重连] ${socket.id} → ${code}`);
      } catch (e) { console.error('[game] reconnect_room error:', e.message); }
    });

    // === disband_room ===
    socket.on('disband_room', () => {
      try {
        const room = findRoomByPlayerKey(socket.data.playerKey);
        if (!room) { socket.emit('error_msg', { message: '你没有正在进行的房间' }); return; }
        if (room.started) { socket.emit('error_msg', { message: '游戏已开始，无法解散' }); return; }
        if (room.finished) return;

        const code = room.code;

        // 清理房间定时器
        if (room._roundTimer) clearTimeout(room._roundTimer);
        if (room._nextRound) clearTimeout(room._nextRound);
        if (room._matchEndTimer) clearTimeout(room._matchEndTimer);
        if (room._rematchTimer) clearTimeout(room._rematchTimer);

        // 清理玩家索引
        for (const p of room.players.values()) {
          roomPlayerIndex.delete(p.playerKey);
          const entry = onlinePlayers.get(p.playerKey);
          if (entry && entry.type === 'multi') { entry.type = 'idle'; entry.roomCode = null; }
        }

        // 通知房间内其他人（如果有）
        socket.to(code).emit('room_disbanded', { code, reason: 'host_disbanded' });

        // 删除房间
        rooms.delete(code);

        // 设置冷却时间（仅对房主）
        roomCooldowns.set(socket.data.playerKey, Date.now() + DISBAND_COOLDOWN);

        socket.emit('room_disbanded', { code, reason: 'disbanded', cooldown: DISBAND_COOLDOWN });
        console.log(`[房] ${code} 被房主解散, 冷却 ${DISBAND_COOLDOWN / 1000}s`);
      } catch (e) { console.error('[game] disband_room error:', e.message); }
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

    // 清理超时排队（委托给 matchmaking 模块，避免代码重复）
    cleanupStaleQueue();

    // 清理过期冷却
    for (const [pk, expiry] of roomCooldowns) {
      if (Date.now() >= expiry) roomCooldowns.delete(pk);
    }
  }

  return { startRound, endRound, score, runPeriodicCleanup, roomCooldowns };
}
