import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const ROUND_TIME = 120_000;
const DISCONNECT = 30_000;

// 加载干员
let ALL_CHARS = [];
try {
  ALL_CHARS = JSON.parse(readFileSync(join(__dirname, 'characters.json'), 'utf-8'))
    .map(c => ({ id: c.id, name: c.name }));
  console.log(`已加载 ${ALL_CHARS.length} 个干员`);
} catch { console.log('⚠ 未加载干员数据'); }

function randomTarget() {
  if (!ALL_CHARS.length) return { id: '', name: '?' };
  return ALL_CHARS[Math.floor(Math.random() * ALL_CHARS.length)];
}

const http = createServer((req, res) => {
  if (req.url === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({
      connections: io.engine.clientsCount,
      rooms: rooms.size,
      playing: Array.from(rooms.values()).filter(r => r.started && !r.finished).length,
    }));
  }
  res.end('OK');
});

const io = new Server(http, { cors: { origin: '*' }, pingInterval: 5000, pingTimeout: 15000 });
const rooms = new Map();

// ===== HELPERS =====
function genCode() { let c; do { c = String(Math.floor(1000 + Math.random() * 9000)); } while (rooms.has(c)); return c; }
function score(room) {
  const arr = Array.from(room.players.values());
  return `${arr[0]?.name||'?'} ${arr[0]?.wins||0} - ${arr[1]?.wins||0} ${arr[1]?.name||'?'}`;
}

function startRound(room) {
  if (room.finished) return;
  if (room._roundTimer) clearTimeout(room._roundTimer);

  const target = randomTarget();
  room.target = target;
  room.roundSettled = false;
  room.surrendered = new Set();

  const timer = setTimeout(() => {
    if (room.roundSettled) return;
    room.roundSettled = true;
    io.to(room.code).emit('round_end', {
      winner: null, winnerName: '', targetName: target.name, score: score(room), matchOver: false,
    });
    room._nextRound = setTimeout(() => startRound(room), 5000);
  }, ROUND_TIME);
  room._roundTimer = timer;

  io.to(room.code).emit('round_start', {
    startTime: Date.now(), timeLimit: ROUND_TIME, score: score(room), target,
    players: Array.from(room.players.entries()).map(([id, p]) => ({ id, name: p.name, wins: p.wins })),
  });
}

function endRound(room, winnerId, winnerName, targetName, matchOver) {
  if (room.roundSettled) return;
  room.roundSettled = true;
  if (room._roundTimer) { clearTimeout(room._roundTimer); room._roundTimer = null; }
  if (room._nextRound) { clearTimeout(room._nextRound); room._nextRound = null; }

  io.to(room.code).emit('round_end', { winner: winnerId, winnerName, targetName, score: score(room), matchOver });
  if (matchOver) {
    room.finished = true;
    io.to(room.code).emit('match_end', { winner: winnerId, winnerName, score: score(room) });
  } else {
    room._nextRound = setTimeout(() => startRound(room), 6000);
  }
}

function cleanup(code) {
  setTimeout(() => {
    const room = rooms.get(code);
    if (!room) return;
    const socks = io.sockets.adapter.rooms.get(code);
    if (!socks || socks.size === 0) rooms.delete(code);
  }, 60000);
}

// 定期清理
setInterval(() => {
  for (const [code, room] of rooms) {
    const socks = io.sockets.adapter.rooms.get(code);
    const cnt = socks ? socks.size : 0;
    if (cnt === 0) { rooms.delete(code); continue; }
    if (!room.started && !room.finished && room._createdAt && Date.now() - room._createdAt > 300_000) {
      rooms.delete(code);
    }
  }
}, 60000);

// ===== SOCKET =====
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id}`);

  socket.on('create_room', (data) => {
    const code = genCode();
    const bestOf = [3,5,7].includes(data?.bestOf) ? data?.bestOf : 5;
    rooms.set(code, {
      code, bestOf, winsNeeded: Math.ceil(bestOf / 2), _createdAt: Date.now(),
      players: new Map([[socket.id, { name: data?.playerName || '玩家', wins: 0, dcTimer: null, lastSocketId: null }]]),
      started: false, finished: false,
    });
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit('room_created', { code, bestOf });
    console.log(`[房] ${code} BO${bestOf}`);
  });

  socket.on('join_room', (data) => {
    const code = (data?.code || '').toUpperCase();
    const room = rooms.get(code);
    if (!room) { socket.emit('error_msg', { message: '房间不存在' }); return; }
    if (room.players.size >= 2) { socket.emit('error_msg', { message: '房间已满' }); return; }

    room.players.set(socket.id, { name: data?.playerName || '玩家', wins: 0, dcTimer: null, lastSocketId: null });
    socket.join(code);
    socket.data.roomCode = code;
    room.started = true;
    startRound(room);
    console.log(`[房] ${code} 满员`);
  });

  socket.on('_log', (d) => console.log(`[日志] ${d.action}`));

  socket.on('guess_update', (data) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !data || room.finished || room.roundSettled) return;
    socket.to(room.code).emit('opponent_update', {
      guessCount: data?.guessCount ?? 0,
      allComparisons: data?.allComparisons || [],
    });
  });

  socket.on('player_win_round', (data) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !data || room.finished || room.roundSettled) return;
    const player = room.players.get(socket.id);
    if (!player) return;

    player.wins++;
    const won = player.wins >= room.winsNeeded;
    console.log(`[胜] ${player.name} ${player.wins}/${room.winsNeeded}`);
    endRound(room, socket.id, player.name, data?.targetName || room.target?.name || '', won);
    if (won) cleanup(room.code);
  });

  socket.on('surrender_round', (data) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !data || room.finished || room.roundSettled) return;
    room.surrendered.add(socket.id);

    if (room.surrendered.size >= 2) {
      endRound(room, null, '', data?.targetName || room.target?.name || '', false);
      return;
    }

    socket.to(room.code).emit('opponent_surrendered', {
      playerName: room.players.get(socket.id)?.name,
    });

    // 剩余时间给对手
    if (room._roundTimer) clearTimeout(room._roundTimer);
    const elapsed = Date.now() - room._roundStartAt;
    const remaining = Math.max(5000, ROUND_TIME - elapsed);
    room._roundTimer = setTimeout(() => {
      if (room.roundSettled) return;
      endRound(room, null, '', data?.targetName || room.target?.name || '', false);
    }, remaining);
  });

  socket.on('rematch_ready', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.finished) return;
    const player = room.players.get(socket.id);
    if (player) player.ready = true;

    const allReady = Array.from(room.players.values()).every(p => p.ready);
    if (allReady && room.players.size >= 2) {
      room.players.forEach(p => { p.wins = 0; p.ready = false; });
      room.finished = false;
      room.target = null;
      io.to(room.code).emit('rematch_start', { bestOf: room.bestOf, winsNeeded: room.winsNeeded });
      setTimeout(() => startRound(room), 1500);
    }
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.finished) return;
    const player = room.players.get(socket.id);
    if (!player) return;

    // Store old socket ID so reconnecting clients can be matched
    player.lastSocketId = socket.id;

    io.to(room.code).emit('opponent_disconnected', { playerName: player.name });

    player.dcTimer = setTimeout(() => {
      const other = Array.from(room.players.keys()).find(id => id !== socket.id);
      io.to(room.code).emit('match_end', {
        winner: other, winnerName: room.players.get(other)?.name || '对手',
        score: score(room), reason: 'disconnect',
      });
      room.finished = true;
      cleanup(room.code);
    }, DISCONNECT);
  });

  socket.on('reconnect_room', (data) => {
    if (!data) { socket.emit('error_msg', { message: '无效的重连数据' }); return; }
    const code = (data?.code || '').toUpperCase();
    const room = rooms.get(code);
    if (!room) { socket.emit('error_msg', { message: '房间不存在' }); return; }

    // Find the player by matching stored lastSocketId
    let foundPlayerId = null;
    for (const [id, p] of room.players) {
      if (p.lastSocketId === data?.oldSocketId) { foundPlayerId = id; break; }
    }
    if (!foundPlayerId) { socket.emit('error_msg', { message: '未找到玩家信息' }); return; }

    const player = room.players.get(foundPlayerId);

    // Cancel the disconnect timer
    if (player.dcTimer) { clearTimeout(player.dcTimer); player.dcTimer = null; }

    // Remove old entry and re-add with new socket ID
    room.players.delete(foundPlayerId);
    room.players.set(socket.id, player);

    socket.join(code);
    socket.data.roomCode = code;

    // Notify the room that opponent reconnected
    socket.to(code).emit('opponent_reconnected', { playerName: player.name });

    // Send current round state to the reconnecting socket
    socket.emit('reconnect_state', {
      code,
      bestOf: room.bestOf,
      winsNeeded: room.winsNeeded,
      started: room.started,
      finished: room.finished,
      score: score(room),
      target: room.target || null,
      roundSettled: room.roundSettled || false,
      timeLimit: ROUND_TIME,
      myWins: player.wins,
      players: Array.from(room.players.entries()).map(([id, p]) => ({ id, name: p.name, wins: p.wins })),
    });

    console.log(`[重连] ${player.name} -> ${code}`);
  });
});

// 记录回合开始时间
const origStart = startRound;
startRound = function(room) {
  room._roundStartAt = Date.now();
  origStart(room);
};

http.listen(PORT, () => console.log(`:${PORT}`));
