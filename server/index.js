import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const ROUND_TIME = 120_000;
const DISCONNECT = 30_000;

// 加载干员
let ALL_CHARS = [], EASY_CHARS = [], MED_CHARS = [];
try {
  const data = JSON.parse(readFileSync(join(__dirname, 'characters.json'), 'utf-8'));
  ALL_CHARS = data.map(c => ({ id: c.id, name: c.name }));
  EASY_CHARS = data.filter(c => c.popularity === 'hot' || c.rarity >= 6).map(c => ({ id: c.id, name: c.name }));
  MED_CHARS = data.filter(c => c.popularity === 'hot' || c.popularity === 'normal').map(c => ({ id: c.id, name: c.name }));
  console.log(`已加载 ${ALL_CHARS.length} 干员`);
} catch { console.log('⚠ 未加载干员数据'); }

function randomTarget(diff = 'hard') {
  const pool = diff === 'easy' ? EASY_CHARS : diff === 'medium' ? MED_CHARS : ALL_CHARS;
  if (!pool.length) return { id: '', name: '?' };
  return pool[Math.floor(Math.random() * pool.length)];
}

const http = createServer((req, res) => {
  if (req.url && req.url.startsWith('/stats')) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ connections: io.engine.clientsCount, rooms: rooms.size, playing: Array.from(rooms.values()).filter(r => r.started && !r.finished).length }));
  }
  res.end('OK');
});

const io = new Server(http, { cors: { origin: '*' }, pingInterval: 5000, pingTimeout: 15000 });
const rooms = new Map();

// ===== 辅助函数 =====
function genCode() { let c; do { c = String(Math.floor(1000 + Math.random() * 9000)); } while (rooms.has(c)); return c; }
function score(room) {
  const arr = Array.from(room.players.values());
  return `${arr[0]?.name||'?'} ${arr[0]?.wins||0} - ${arr[1]?.wins||0} ${arr[1]?.name||'?'}`;
}
function generateKey() { return 'p_' + randomBytes(9).toString('base64url'); }
function parseCookies(str) {
  if (!str) return {};
  const result = {};
  for (const part of str.split(';')) {
    const [k, ...r] = part.split('=');
    if (k) { try { result[k.trim()] = decodeURIComponent(r.join('=').trim()); } catch {} }
  }
  return result;
}

// Cookie 身份中间件
io.use((socket, next) => {
  const cookies = parseCookies(socket.handshake.headers.cookie || '');
  if (cookies.player_key) {
    socket.data.playerKey = cookies.player_key;
  } else {
    socket.data.playerKey = generateKey();
    socket.emit('set_cookie', { name: 'player_key', value: socket.data.playerKey });
  }
  next();
});

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
    io.to(room.code).emit('round_end', { winner: null, winnerName: '', targetName: target.name, score: score(room), matchOver: false });
    room._nextRound = setTimeout(() => startRound(room), 5000);
  }, ROUND_TIME);
  room._roundTimer = timer;

  io.to(room.code).emit('round_start', {
    startTime: Date.now(), timeLimit: ROUND_TIME, score: score(room), target, difficulty: room.difficulty || 'hard',
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
    setTimeout(() => io.to(room.code).emit('match_end', { winner: winnerId, winnerName, score: score(room) }), 3000);
  } else {
    room._nextRound = setTimeout(() => startRound(room), 6000);
  }
}

// 查找玩家已有的活跃房间
function findRoomByPlayerKey(pk) {
  for (const [code, r] of rooms) {
    if (r.finished) continue;
    for (const p of r.players.values()) {
      if (p.playerKey === pk) return r;
    }
  }
  return null;
}

// 周期清理
setInterval(() => {
  for (const [code, room] of rooms) {
    const socks = io.sockets.adapter.rooms.get(code);
    const cnt = socks ? socks.size : 0;
    if (cnt === 0) {
      if (room._roundTimer) clearTimeout(room._roundTimer);
      if (room._nextRound) clearTimeout(room._nextRound);
      rooms.delete(code);
    }
    if (!room.started && !room.finished && room._createdAt && Date.now() - room._createdAt > 300_000) {
      rooms.delete(code);
    }
  }
}, 60000);

// ===== Socket 连接 =====
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id} pk=${socket.data.playerKey?.slice(0,10)}`);

  // === 自动恢复：连接时查旧房 ===
  const existing = findRoomByPlayerKey(socket.data.playerKey);
  if (existing) {
    for (const [pid, player] of existing.players) {
      if (player.playerKey === socket.data.playerKey) {
        if (player.dcTimer) { clearTimeout(player.dcTimer); player.dcTimer = null; }
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
          socket.emit('reconnect_state', {
            code: existing.code, bestOf: existing.bestOf, winsNeeded: existing.winsNeeded,
            score: score(existing), target: existing.target, players: Array.from(existing.players.entries()).map(([id, p]) => ({ id, name: p.name, wins: p.wins })),
          });
        }
        console.log(`[恢复] ${socket.id} → ${existing.code}`);
        break;
      }
    }
  }

  // === 创建房间 ===
  socket.on('create_room', (data) => {
    // 先查是否已有活跃房间
    const hasRoom = findRoomByPlayerKey(socket.data.playerKey);
    if (hasRoom) {
      socket.emit('existing_room', { code: hasRoom.code, bestOf: hasRoom.bestOf, difficulty: hasRoom.difficulty || 'hard', started: hasRoom.started });
      return;
    }

    const code = genCode();
    const bestOf = [3,5,7].includes(data?.bestOf) ? data?.bestOf : 5;
    const difficulty = ['easy','medium','hard'].includes(data?.difficulty) ? data?.difficulty : 'hard';
    rooms.set(code, { code, bestOf, winsNeeded: Math.ceil(bestOf / 2), difficulty, _createdAt: Date.now(), players: new Map([[socket.id, { name: data?.playerName || '玩家', wins: 0, dcTimer: null, lastSocketId: null, playerKey: socket.data.playerKey, ready: false }]]), started: false, finished: false });
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit('room_created', { code, bestOf, difficulty });
    console.log(`[房] ${code} BO${bestOf}`);
  });

  // === 加入房间 ===
  socket.on('join_room', (data) => {
    const code = (data?.code || '').toUpperCase();
    const room = rooms.get(code);
    if (!room) { socket.emit('error_msg', { message: '房间不存在' }); return; }
    if (room.players.size >= 2) {
      // 检查是否有一方断线且同身份
      for (const [pid, p] of room.players) {
        if (p.dcTimer && p.playerKey === socket.data.playerKey) {
          if (p.dcTimer) clearTimeout(p.dcTimer);
          p.lastSocketId = pid;
          room.players.delete(pid);
          room.players.set(socket.id, p);
          socket.join(code);
          socket.data.roomCode = code;
          socket.to(code).emit('opponent_reconnected', { playerName: p.name });
          socket.emit('existing_room', { code, bestOf: room.bestOf, difficulty: room.difficulty || 'hard', started: room.started, wins: p.wins });
          console.log(`[重连] ${socket.id} → ${code}`);
          return;
        }
      }
      socket.emit('error_msg', { message: '房间已满' }); return;
    }

    room.players.set(socket.id, { name: data?.playerName || '玩家', wins: 0, dcTimer: null, lastSocketId: null, playerKey: socket.data.playerKey, ready: false });
    socket.join(code);
    socket.data.roomCode = code;
    room.started = true;
    startRound(room);
    console.log(`[房] ${code} 满员`);
  });

  socket.on('_log', (d) => console.log(`[日志] ${d.action}`));

  // === 猜测 ===
  socket.on('guess_update', (data) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.finished || room.roundSettled) return;
    socket.to(room.code).emit('opponent_update', { guessCount: data?.guessCount ?? 0, allComparisons: data?.allComparisons || [] });
  });

  // === 猜中 ===
  socket.on('player_win_round', (data) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.finished || room.roundSettled) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    player.wins++;
    const won = player.wins >= room.winsNeeded;
    console.log(`[胜] ${player.name} ${player.wins}/${room.winsNeeded}`);
    endRound(room, socket.id, player.name, data?.targetName || room.target?.name || '', won);
  });

  // === 弃权 ===
  socket.on('surrender_round', (data) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.finished || room.roundSettled) return;
    if (!room.surrendered) room.surrendered = new Set();
    room.surrendered.add(socket.id);
    if (room.surrendered.size >= 2) { endRound(room, null, '', data?.targetName || room.target?.name || '', false); return; }
    socket.to(room.code).emit('opponent_surrendered', { playerName: room.players.get(socket.id)?.name });
    if (room._roundTimer) clearTimeout(room._roundTimer);
    const elapsed = Date.now() - (room._roundStartAt || Date.now());
    const remaining = Math.max(5000, ROUND_TIME - elapsed);
    room._roundTimer = setTimeout(() => endRound(room, null, '', data?.targetName || room.target?.name || '', false), remaining);
  });

  // === 再理一把 ===
  socket.on('rematch_ready', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.finished) return;
    const player = room.players.get(socket.id);
    if (player) player.ready = true;
    if (Array.from(room.players.values()).every(p => p.ready) && room.players.size >= 2) {
      room.players.forEach(p => { p.wins = 0; p.ready = false; });
      room.finished = false; room.target = null;
      io.to(room.code).emit('rematch_start', { bestOf: room.bestOf, winsNeeded: room.winsNeeded });
      setTimeout(() => startRound(room), 1500);
    }
  });

  // === 断开 ===
  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.finished) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    player.lastSocketId = socket.id;
    io.to(room.code).emit('opponent_disconnected', { playerName: player.name });
    player.dcTimer = setTimeout(() => {
      if (room.roundSettled || room.finished) return;
      const other = Array.from(room.players.keys()).find(id => id !== socket.id);
      io.to(room.code).emit('match_end', { winner: other, winnerName: room.players.get(other)?.name || '对手', score: score(room), reason: 'disconnect' });
      room.finished = true;
    }, DISCONNECT);
  });

  // === 主动重连 ===
  socket.on('reconnect_room', (data) => {
    const code = (data?.code || '').toUpperCase();
    const room = rooms.get(code);
    if (!room) return;
    let found = null;
    for (const [pid, p] of room.players) { if (p.lastSocketId === data?.oldSocketId) { found = pid; break; } }
    if (!found) return;
    const player = room.players.get(found);
    if (player.dcTimer) { clearTimeout(player.dcTimer); player.dcTimer = null; }
    room.players.delete(found);
    room.players.set(socket.id, player);
    socket.join(code);
    socket.data.roomCode = code;
    socket.to(code).emit('opponent_reconnected', { playerName: player.name });
    if (room.started) {
      socket.emit('reconnect_state', { code, bestOf: room.bestOf, winsNeeded: room.winsNeeded, score: score(room), target: room.target, players: Array.from(room.players.entries()).map(([id, p]) => ({ id, name: p.name, wins: p.wins })) });
    }
  });
});

http.listen(PORT, () => console.log(`:${PORT}`));
