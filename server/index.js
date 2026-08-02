import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const ROUND_TIME = 120_000;
const DISCONNECT = 30_000;
const JWT_SECRET = process.env.JWT_SECRET || 'arknights-guess-secret-change-in-production';
const DB_PATH = join(__dirname, 'data.db');

// ===== 数据库 =====
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    player_key TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_key TEXT NOT NULL,
    won INTEGER NOT NULL DEFAULT 0,
    guess_count INTEGER NOT NULL DEFAULT 0,
    difficulty TEXT NOT NULL DEFAULT 'hard',
    target_name TEXT NOT NULL DEFAULT '',
    timestamp TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
  CREATE INDEX IF NOT EXISTS idx_users_player_key ON users(player_key);
  CREATE INDEX IF NOT EXISTS idx_games_player_key ON games(player_key);
`);

// ===== JWT =====
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// ===== 辅助函数 =====
function parseCookies(str) {
  if (!str) return {};
  const result = {};
  for (const part of str.split(';')) {
    const [k, ...r] = part.split('=');
    if (k) { try { result[k.trim()] = decodeURIComponent(r.join('=').trim()); } catch {} }
  }
  return result;
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

function jsonResponse(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// ===== 干员数据 =====
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

// ===== HTTP 服务器 =====
const http = createServer(async (req, res) => {
  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }

  const url = req.url || '';

  // 旧统计端点
  if (url.startsWith('/stats')) {
    return jsonResponse(res, {
      connections: io.engine.clientsCount,
      rooms: rooms.size,
      playing: Array.from(rooms.values()).filter(r => r.started && !r.finished).length,
    });
  }

  // ===== POST /api/register =====
  if (req.method === 'POST' && url === '/api/register') {
    const body = await parseBody(req);
    const { username, password } = body;

    if (!username || !password) {
      return jsonResponse(res, { error: '用户名和密码不能为空' }, 400);
    }
    if (typeof username !== 'string' || username.trim().length < 2 || username.trim().length > 20) {
      return jsonResponse(res, { error: '用户名需要 2-20 个字符' }, 400);
    }
    if (typeof password !== 'string' || password.length < 4) {
      return jsonResponse(res, { error: '密码至少需要 4 个字符' }, 400);
    }
    if (!/^[a-zA-Z0-9_一-鿿]+$/.test(username.trim())) {
      return jsonResponse(res, { error: '用户名只能包含字母、数字、下划线和中文' }, 400);
    }

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim());
    if (existing) {
      return jsonResponse(res, { error: '用户名已被注册' }, 409);
    }

    const password_hash = await bcrypt.hash(password, 10);
    const result = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username.trim(), password_hash);
    const token = signToken({ userId: result.lastInsertRowid, username: username.trim() });

    return jsonResponse(res, { token, username: username.trim(), userId: result.lastInsertRowid });
  }

  // ===== POST /api/login =====
  if (req.method === 'POST' && url === '/api/login') {
    const body = await parseBody(req);
    const { username, password } = body;

    if (!username || !password) {
      return jsonResponse(res, { error: '用户名和密码不能为空' }, 400);
    }

    const user = db.prepare('SELECT id, username, password_hash, player_key FROM users WHERE username = ?').get(username.trim());
    if (!user) {
      return jsonResponse(res, { error: '用户名或密码错误' }, 401);
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return jsonResponse(res, { error: '用户名或密码错误' }, 401);
    }

    const token = signToken({ userId: user.id, username: user.username });

    return jsonResponse(res, {
      token,
      username: user.username,
      userId: user.id,
      player_key: user.player_key || null,
    });
  }

  // ===== POST /api/sync =====
  if (req.method === 'POST' && url === '/api/sync') {
    const body = await parseBody(req);
    const { player_key, games } = body;

    if (!player_key || !Array.isArray(games)) {
      return jsonResponse(res, { error: '需要 player_key 和 games 数组' }, 400);
    }

    // 验证 JWT（可选：已登录用户绑定）
    const authHeader = req.headers.authorization || '';
    let userId = null;
    if (authHeader.startsWith('Bearer ')) {
      const decoded = verifyToken(authHeader.slice(7));
      if (decoded) userId = decoded.userId;
    }

    // 如果已登录，更新用户的 player_key
    if (userId) {
      db.prepare('UPDATE users SET player_key = ? WHERE id = ?').run(player_key, userId);
    }

    const insert = db.prepare('INSERT INTO games (player_key, won, guess_count, difficulty, target_name, timestamp) VALUES (?, ?, ?, ?, ?, ?)');
    const insertMany = db.transaction((rows) => {
      for (const g of rows) {
        insert.run(player_key, g.won ? 1 : 0, g.guessCount || 0, g.difficulty || 'hard', g.targetName || '', g.timestamp || new Date().toISOString());
      }
    });

    try {
      insertMany(games);
      return jsonResponse(res, { synced: games.length });
    } catch (err) {
      console.error('[sync] error:', err.message);
      return jsonResponse(res, { error: '同步失败' }, 500);
    }
  }

  // ===== GET /api/me =====
  if (req.method === 'GET' && url === '/api/me') {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return jsonResponse(res, { error: '未登录' }, 401);
    }

    const decoded = verifyToken(authHeader.slice(7));
    if (!decoded) {
      return jsonResponse(res, { error: 'token 无效或已过期' }, 401);
    }

    const user = db.prepare('SELECT id, username, player_key, created_at FROM users WHERE id = ?').get(decoded.userId);
    if (!user) {
      return jsonResponse(res, { error: '用户不存在' }, 404);
    }

    // 统计
    const stats = db.prepare(`
      SELECT
        COUNT(*) as totalGames,
        SUM(won) as wins,
        COUNT(*) - SUM(won) as losses,
        SUM(guess_count) as totalGuesses,
        MIN(CASE WHEN won = 1 THEN guess_count ELSE NULL END) as bestScore
      FROM games WHERE player_key = ?
    `).get(user.player_key || '');

    return jsonResponse(res, {
      username: user.username,
      player_key: user.player_key,
      created_at: user.created_at,
      stats: {
        totalGames: stats?.totalGames || 0,
        wins: stats?.wins || 0,
        losses: stats?.losses || 0,
        totalGuesses: stats?.totalGuesses || 0,
        bestScore: stats?.bestScore || 0,
      },
    });
  }

  // ===== POST /api/link-player-key =====
  if (req.method === 'POST' && url === '/api/link-player-key') {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return jsonResponse(res, { error: '未登录' }, 401);
    }
    const decoded = verifyToken(authHeader.slice(7));
    if (!decoded) {
      return jsonResponse(res, { error: 'token 无效或已过期' }, 401);
    }

    const body = await parseBody(req);
    const { player_key } = body;
    if (!player_key) {
      return jsonResponse(res, { error: '需要 player_key' }, 400);
    }

    db.prepare('UPDATE users SET player_key = ? WHERE id = ?').run(player_key, decoded.userId);
    return jsonResponse(res, { success: true });
  }

  // 默认响应
  res.writeHead(200);
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

// Cookie 身份中间件
io.use((socket, next) => {
  const cookies = parseCookies(socket.handshake.headers.cookie || '');
  const urlPk = socket.handshake.query?.pk;
  if (cookies.player_key) {
    socket.data.playerKey = cookies.player_key;
  } else if (urlPk && typeof urlPk === 'string' && urlPk.startsWith('p_')) {
    socket.data.playerKey = urlPk;
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
  const now = Date.now();
  for (const [code, room] of rooms) {
    const socks = io.sockets.adapter.rooms.get(code);
    const cnt = socks ? socks.size : 0;
    if (cnt === 0) {
      if (!room._emptySince) room._emptySince = now;
      if (now - room._emptySince > 60000) {
        if (room._roundTimer) clearTimeout(room._roundTimer);
        if (room._nextRound) clearTimeout(room._nextRound);
        rooms.delete(code);
      }
    } else {
      room._emptySince = null;
    }
    if (!room.started && !room.finished && room._createdAt && now - room._createdAt > 300_000) {
      rooms.delete(code);
    }
  }
}, 30000);

// ===== Socket 连接 =====
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id} pk=${socket.data.playerKey?.slice(0,10)}`);

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

  socket.on('create_room', (data) => {
    const hasRoom = findRoomByPlayerKey(socket.data.playerKey);
    if (hasRoom) {
      socket.emit('existing_room', { code: hasRoom.code, bestOf: hasRoom.bestOf, difficulty: hasRoom.difficulty || 'hard', started: hasRoom.started });
      return;
    }

    if (data?._fromQuickRejoin) {
      socket.emit('room_expired', { message: '原房间已过期，已为您创建新房间' });
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

  socket.on('join_room', (data) => {
    const code = (data?.code || '').toUpperCase();
    const room = rooms.get(code);
    if (!room) { socket.emit('error_msg', { message: '房间不存在' }); return; }
    if (room.players.size >= 2) {
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

  socket.on('guess_update', (data) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.finished || room.roundSettled) return;
    socket.to(room.code).emit('opponent_update', { guessCount: data?.guessCount ?? 0, allComparisons: data?.allComparisons || [] });
  });

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
