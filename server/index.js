import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { randomBytes } from 'node:crypto';

const PORT = process.env.PORT || 3001;
const ROUND_TIME = 120_000;
const DISCONNECT_LIMIT = 30_000;
const CLEANUP_DONE = 60_000;    // 比赛结束后 1 分钟清理
const CLEANUP_ORPHAN = 120_000;  // 未开始的房间 2 分钟清理
const CLEANUP_EMPTY = 30_000;    // 房间无人后 30 秒清理

const httpServer = createServer((req, res) => {
  if (req.url === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      connections: io.engine.clientsCount,
      rooms: rooms.size,
      playing: Array.from(rooms.values()).filter(r => r.started && !r.finished).length,
    }));
    return;
  }
  res.writeHead(200); res.end('OK');
});
const io = new Server(httpServer, { cors: { origin: '*' }, pingTimeout: 15000, pingInterval: 5000 });

const rooms = new Map();

function genRoomCode() {
  let c; do { c = String(Math.floor(1000 + Math.random() * 9000)); } while (rooms.has(c));
  return c;
}

function formatScore(room) {
  const arr = Array.from(room.players.values());
  return `${arr[0]?.name||'?'} ${arr[0]?.wins||0} - ${arr[1]?.wins||0} ${arr[1]?.name||'?'}`;
}

function clearRoundTimer(room) {
  if (room?.currentRound?.timer) { clearTimeout(room.currentRound.timer); room.currentRound.timer = null; }
}

function notifyDisconnect(room, playerName) {
  io.to(room.code).emit('opponent_disconnected', { playerName, seconds: 30 });
}

io.on('connection', (socket) => {
  console.log(`[+] ${socket.id}`);

  // === 创建房间 ===
  socket.on('create_room', (data) => {
    const code = genRoomCode();
    const bestOf = [3,5,7].includes(data.bestOf) ? data.bestOf : 5;
    const winsNeeded = Math.ceil(bestOf / 2);

    rooms.set(code, {
      code, bestOf, winsNeeded, _createdAt: Date.now(),
      players: new Map([[socket.id, { name: data.playerName||'玩家', wins: 0, ready: false, disconnectTimer: null }]]),
      currentRound: null, started: false, finished: false,
      roundTarget: null,
    });

    socket.join(code);
    socket.data.roomCode = code;
    socket.emit('room_created', { code, bestOf });
    // 2分钟内无人加入则清理
    cleanupLater(code, CLEANUP_ORPHAN);
    console.log(`[房] ${code} BO${bestOf}`);
  });

  // === 加入房间 ===
  socket.on('join_room', (data) => {
    const code = (data.code || '').toUpperCase();
    const room = rooms.get(code);
    if (!room) { socket.emit('error_msg', { message: '房间不存在' }); return; }
    if (room.players.size >= 2) { socket.emit('error_msg', { message: '房间已满' }); return; }

    room.players.set(socket.id, { name: data.playerName||'玩家', wins: 0, ready: false, disconnectTimer: null });
    socket.join(code);
    socket.data.roomCode = code;
    room.started = true;
    startRound(room);
    console.log(`[房] ${code} 满员开战`);
  });

  // === 客户端操作日志 ===
  socket.on('_log', (data) => {
    console.log(`[日志] ${data.action} by ${socket.id}`);
  });

  // === 猜测更新 ===
  socket.on('guess_update', (data) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room?.currentRound) return;
    socket.to(room.code).emit('opponent_update', {
      guessCount: data.guessCount,
      allComparisons: data.allComparisons || [],
    });
  });

  // === 猜中本局 ===
  socket.on('player_win_round', (data) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room?.currentRound || room.finished) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    player.wins++;

    const won = player.wins >= room.winsNeeded;
    clearRoundTimer(room);
    console.log(`[胜] ${player.name} 猜中, ${player.wins}/${room.winsNeeded}胜, matchOver=${won}`);

    io.to(room.code).emit('round_end', {
      winner: socket.id, winnerName: player.name,
      targetName: room.roundTarget?.name || data.targetName || '',
      score: formatScore(room), matchOver: won,
    });

    if (won) {
      room.finished = true;
      room.players.forEach(p => p.ready = false);
      io.to(room.code).emit('match_end', {
        winner: socket.id, winnerName: player.name, score: formatScore(room),
      });
      cleanupLater(code, CLEANUP_DONE);
    } else {
      setTimeout(() => startRound(room), 6000);
    }
  });

  // === 放弃本局 ===
  socket.on('surrender_round', (data) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room?.currentRound || room.finished) return;
    room.currentRound.surrendered = room.currentRound.surrendered || new Set();
    room.currentRound.surrendered.add(socket.id);

    if (room.currentRound.surrendered.size >= 2) {
      clearRoundTimer(room);
      io.to(room.code).emit('round_end', {
        winner: null, winnerName: '', targetName: room.roundTarget?.name || '',
        score: formatScore(room), matchOver: false,
      });
      setTimeout(() => startRound(room), 5000);
      return;
    }

    io.to(room.code).emit('opponent_surrendered', {
      playerName: room.players.get(socket.id)?.name,
    });

    const timeout = setTimeout(() => {
      io.to(room.code).emit('round_end', {
        winner: null, winnerName: '', targetName: room.roundTarget?.name || '',
        score: formatScore(room), matchOver: false,
      });
      setTimeout(() => startRound(room), 5000);
    }, room.currentRound.remaining);
    room.currentRound.timer = timeout;
  });

  // === 再理一把 ===
  socket.on('rematch_ready', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (player) player.ready = true;

    const allReady = Array.from(room.players.values()).every(p => p.ready);
    if (allReady && room.players.size === 2) {
      room.players.forEach(p => { p.wins = 0; p.ready = false; });
      room.finished = false;
      room.roundTarget = null;
      if (room._cleanupTimer) { clearTimeout(room._cleanupTimer); room._cleanupTimer = null; }
      io.to(room.code).emit('rematch_start', { bestOf: room.bestOf, winsNeeded: room.winsNeeded });
      setTimeout(() => startRound(room), 1500);
    }
  });

  // === 断开 ===
  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || room.finished) return;

    const player = room.players.get(socket.id);
    if (!player) return;

    notifyDisconnect(room, player.name);

    player.disconnectTimer = setTimeout(() => {
      const other = Array.from(room.players.keys()).find(id => id !== socket.id);
      io.to(code).emit('match_end', {
        winner: other, winnerName: room.players.get(other)?.name || '对手',
        score: formatScore(room), reason: 'disconnect',
      });
      room.finished = true;
      clearRoundTimer(room);
      cleanupLater(code, CLEANUP_DONE);
    }, DISCONNECT_LIMIT);
  });

  // === 重连 ===
  socket.on('reconnect_room', (data) => {
    const code = (data.code || '').toUpperCase();
    const room = rooms.get(code);
    if (!room || room.finished) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    if (player.disconnectTimer) { clearTimeout(player.disconnectTimer); player.disconnectTimer = null; }
    socket.join(code);
    socket.data.roomCode = code;
    io.to(code).emit('opponent_reconnected', { playerName: player.name });
    // 发送当前回合状态
    if (room.currentRound) {
      socket.emit('round_start', {
        startTime: room.currentRound.startTime,
        timeLimit: ROUND_TIME,
        score: formatScore(room),
        target: room.roundTarget,
        players: Array.from(room.players.entries()).map(([id, p]) => ({ id, name: p.name, wins: p.wins })),
      });
    }
    console.log(`[重连] ${socket.id} → ${code}`);
  });
});

// ===== 回合管理 =====

// 加载干员数据
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
let ALL_CHARS = [];
try {
  const data = JSON.parse(readFileSync(join(__dirname, 'characters.json'), 'utf-8'));
  ALL_CHARS = data.map(c => ({ id: c.id, name: c.name }));
} catch { ALL_CHARS = []; }
console.log(`已加载 ${ALL_CHARS.length} 个干员`);

function randomTarget() {
  if (!ALL_CHARS.length) return { id: '', name: '随机干员' };
  return ALL_CHARS[Math.floor(Math.random() * ALL_CHARS.length)];
}

function startRound(room) {
  if (room.finished) return;
  clearRoundTimer(room);

  // 随机选目标（服务器统一）
  const target = randomTarget();
  room.roundTarget = target;

  const remaining = ROUND_TIME;
  room.currentRound = {
    startTime: Date.now(), remaining,
    surrended: new Set(),
    timer: setTimeout(() => {
      io.to(room.code).emit('round_end', {
        winner: null, winnerName: '',
        targetName: target.name,
        score: formatScore(room), matchOver: false,
      });
      setTimeout(() => startRound(room), 5000);
    }, remaining),
  };

  io.to(room.code).emit('round_start', {
    startTime: Date.now(), timeLimit: remaining,
    score: formatScore(room),
    target,
    players: Array.from(room.players.entries()).map(([id, p]) => ({ id, name: p.name, wins: p.wins })),
  });
}

function cleanupLater(code, delay) {
  const room = rooms.get(code);
  if (!room) return;
  // 清除之前的定时器
  if (room._cleanupTimer) clearTimeout(room._cleanupTimer);
  room._cleanupTimer = setTimeout(() => {
    if (room.finished || !room.started) {
      const roomSockets = io.sockets.adapter.rooms.get(code);
      if (!roomSockets || roomSockets.size === 0) {
        rooms.delete(code);
        console.log(`[清理] ${code}`);
      }
    }
  }, delay);
}

// 定时清理冗余房间
setInterval(() => {
  for (const [code, room] of rooms) {
    const roomSockets = io.sockets.adapter.rooms.get(code);
    const socketCount = roomSockets ? roomSockets.size : 0;
    // 无人连接 → 删除
    if (socketCount === 0) { rooms.delete(code); continue; }
    // 未开始 + 已超 5 分钟 → 删除
    if (!room.started && !room.finished && room._createdAt && Date.now() - room._createdAt > 300_000) {
      rooms.delete(code); console.log(`[清理] ${code} (超时)`);
    }
    // 比赛结束 + 只剩1人 → 删除
    if (room.finished && socketCount <= 1) { rooms.delete(code); }
  }
}, 60000);

httpServer.listen(PORT, () => console.log(`:${PORT}`));
