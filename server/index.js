import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { readFileSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createTransport } from 'nodemailer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const ROUND_TIME = 120_000;
const DISCONNECT = 30_000;
const JWT_SECRET = process.env.JWT_SECRET || 'arknights-guess-secret-change-in-production';
const DB_PATH = join(__dirname, 'data.db');

// ===== SMTP 邮件配置 =====
const SMTP_CONFIG = {
  host: 'smtp.qq.com',
  port: 465,
  secure: true,
  auth: {
    user: '3479083602@qq.com',
    pass: process.env.SMTP_PASS || '',
  },
};
const transporter = createTransport(SMTP_CONFIG);
const SITE_URL = process.env.SITE_URL || 'http://localhost:3000';

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

  CREATE TABLE IF NOT EXISTS email_verifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    email TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
  CREATE INDEX IF NOT EXISTS idx_users_player_key ON users(player_key);
  CREATE INDEX IF NOT EXISTS idx_games_player_key ON games(player_key);
`);

// 补充列（兼容旧数据库，列已存在则跳过）
for (const [table, col, type] of [
  ['users', 'email', 'TEXT'],
  ['users', 'email_verified_at', 'TEXT'],
]) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); } catch {}
}

// ===== 频率限制（内存） =====
const rateLimitStore = new Map(); // key -> { count, resetAt }

function checkRateLimit(key, maxRequests, windowMs) {
  const now = Date.now();
  let entry = rateLimitStore.get(key);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + windowMs };
    rateLimitStore.set(key, entry);
  }
  entry.count++;
  return entry.count <= maxRequests;
}

// 定期清理过期记录
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore) {
    if (now > entry.resetAt) rateLimitStore.delete(key);
  }
}, 120_000);

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
function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

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

function jsonResponse(res, data, status = 200, extraHeaders = {}) {
  const body = JSON.stringify(data);
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(body);
}

// 输入清理：trim 所有字符串，强制最大长度
function sanitizeString(val, maxLen) {
  if (typeof val !== 'string') return '';
  return val.trim().slice(0, maxLen);
}

// ===== 加载干员 =====
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
      'Access-Control-Allow-Credentials': 'true',
    });
    return res.end();
  }

  const url = req.url || '';
  const ip = getClientIP(req);

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
    // 频率限制: 5次/小时/IP
    if (!checkRateLimit(`reg:${ip}`, 5, 3600_000)) {
      return jsonResponse(res, { error: '注册请求过于频繁，请1小时后再试' }, 429);
    }

    const body = await parseBody(req);
    const username = sanitizeString(body.username, 20);
    const password = typeof body.password === 'string' ? body.password : '';
    const email = sanitizeString(body.email, 320);

    if (!username || !password) {
      return jsonResponse(res, { error: '用户名和密码不能为空' }, 400);
    }
    if (username.length < 2 || username.length > 20) {
      return jsonResponse(res, { error: '用户名需要 2-20 个字符' }, 400);
    }
    if (password.length < 8) {
      return jsonResponse(res, { error: '密码至少需要 8 个字符' }, 400);
    }
    if (!/^[a-zA-Z0-9_一-鿿]+$/.test(username)) {
      return jsonResponse(res, { error: '用户名只能包含字母、数字、下划线和中文' }, 400);
    }
    if (email && email.length > 320) {
      return jsonResponse(res, { error: '邮箱地址过长' }, 400);
    }

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
      return jsonResponse(res, { error: '用户名已被注册' }, 409);
    }

    const password_hash = await bcrypt.hash(password, 10);
    const result = db.prepare('INSERT INTO users (username, password_hash, email) VALUES (?, ?, ?)').run(username, password_hash, email || null);
    const token = signToken({ userId: result.lastInsertRowid, username });

    // 设置 httpOnly cookie 作为更强的认证方式
    const cookieHeader = `token=${token}; SameSite=None; Secure; HttpOnly; Path=/; Max-Age=2592000`;
    return jsonResponse(res, { token, username, userId: result.lastInsertRowid }, 200, {
      'Set-Cookie': cookieHeader,
    });
  }

  // ===== POST /api/login =====
  if (req.method === 'POST' && url === '/api/login') {
    // 频率限制: 10次/15分钟/IP
    if (!checkRateLimit(`login:${ip}`, 10, 900_000)) {
      return jsonResponse(res, { error: '登录请求过于频繁，请15分钟后再试' }, 429);
    }

    const body = await parseBody(req);
    const username = sanitizeString(body.username, 20);
    const password = typeof body.password === 'string' ? body.password : '';

    if (!username || !password) {
      return jsonResponse(res, { error: '用户名和密码不能为空' }, 400);
    }

    const user = db.prepare('SELECT id, username, password_hash, player_key, email, email_verified_at FROM users WHERE username = ?').get(username);
    if (!user) {
      return jsonResponse(res, { error: '用户名或密码错误' }, 401);
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return jsonResponse(res, { error: '用户名或密码错误' }, 401);
    }

    const token = signToken({ userId: user.id, username: user.username });

    // 设置 httpOnly cookie
    const cookieHeader = `token=${token}; SameSite=None; Secure; HttpOnly; Path=/; Max-Age=2592000`;
    return jsonResponse(res, {
      token,
      username: user.username,
      userId: user.id,
      player_key: user.player_key || null,
      email: user.email || null,
      email_verified: !!user.email_verified_at,
    }, 200, {
      'Set-Cookie': cookieHeader,
    });
  }

  // ===== POST /api/auth-cookie =====
  if (req.method === 'POST' && url === '/api/auth-cookie') {
    const body = await parseBody(req);
    let token = body.token;

    // 也接受 Authorization header
    if (!token) {
      const authHeader = req.headers.authorization || '';
      if (authHeader.startsWith('Bearer ')) {
        token = authHeader.slice(7);
      }
    }

    if (!token) {
      return jsonResponse(res, { error: '需要 token' }, 400);
    }

    // 验证 token 有效性
    const decoded = verifyToken(token);
    if (!decoded) {
      return jsonResponse(res, { error: 'token 无效或已过期' }, 401);
    }

    const cookieHeader = `token=${token}; SameSite=None; Secure; HttpOnly; Path=/; Max-Age=2592000`;
    return jsonResponse(res, { ok: true }, 200, {
      'Set-Cookie': cookieHeader,
    });
  }

  // ===== POST /api/sync =====
  if (req.method === 'POST' && url === '/api/sync') {
    const body = await parseBody(req);
    const player_key = typeof body.player_key === 'string' ? body.player_key.trim() : '';
    const games = body.games;

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
        insert.run(player_key, g.won ? 1 : 0, g.guessCount || 0, g.difficulty || 'hard', sanitizeString(g.targetName || '', 100), g.timestamp || new Date().toISOString());
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

    const user = db.prepare('SELECT id, username, player_key, email, email_verified_at, created_at FROM users WHERE id = ?').get(decoded.userId);
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
      email: user.email || null,
      email_verified: !!user.email_verified_at,
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
    const player_key = typeof body.player_key === 'string' ? body.player_key.trim() : '';
    if (!player_key) {
      return jsonResponse(res, { error: '需要 player_key' }, 400);
    }

    db.prepare('UPDATE users SET player_key = ? WHERE id = ?').run(player_key, decoded.userId);
    return jsonResponse(res, { success: true });
  }

  // ===== POST /api/send-verification =====
  if (req.method === 'POST' && url === '/api/send-verification') {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return jsonResponse(res, { error: '未登录' }, 401);
    }
    const decoded = verifyToken(authHeader.slice(7));
    if (!decoded) {
      return jsonResponse(res, { error: 'token 无效或已过期' }, 401);
    }

    const body = await parseBody(req);
    const email = sanitizeString(body.email, 320);

    if (!email || !email.includes('@')) {
      return jsonResponse(res, { error: '请输入有效的邮箱地址' }, 400);
    }

    const user = db.prepare('SELECT id, email, email_verified_at FROM users WHERE id = ?').get(decoded.userId);
    if (!user) {
      return jsonResponse(res, { error: '用户不存在' }, 404);
    }
    if (user.email_verified_at) {
      return jsonResponse(res, { error: '邮箱已验证' }, 400);
    }

    // 更新用户邮箱
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, decoded.userId);

    // 生成验证 token
    const verifyToken_ = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(verifyToken_).digest('hex');
    const expiresAt = new Date(Date.now() + 3600_000).toISOString(); // 1小时过期

    // 删除旧的验证记录
    db.prepare('DELETE FROM email_verifications WHERE user_id = ?').run(decoded.userId);
    // 插入新的验证记录
    db.prepare('INSERT INTO email_verifications (user_id, email, token_hash, expires_at) VALUES (?, ?, ?, ?)').run(decoded.userId, email, tokenHash, expiresAt);

    const verifyLink = `${SITE_URL}/verify?token=${verifyToken_}`;

    // 发送邮件
    try {
      await transporter.sendMail({
        from: '"明日方舟猜干员" <3479083602@qq.com>',
        to: email,
        subject: '验证你的邮箱 - 明日方舟猜干员',
        html: `
          <div style="max-width:480px;margin:0 auto;font-family:sans-serif">
            <h2>验证你的邮箱</h2>
            <p>感谢注册！点击下方按钮验证你的邮箱地址：</p>
            <a href="${verifyLink}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none;font-weight:bold">验证邮箱</a>
            <p style="color:#666;margin-top:20px;font-size:0.85rem">或者复制此链接到浏览器：<br>${verifyLink}</p>
            <p style="color:#999;font-size:0.8rem">此链接1小时内有效。如果你没有注册此账号，请忽略此邮件。</p>
          </div>
        `,
      });
      return jsonResponse(res, { ok: true, message: '验证邮件已发送' });
    } catch (err) {
      console.error('[send-verification] email error:', err.message);
      return jsonResponse(res, { error: '邮件发送失败，请稍后再试' }, 500);
    }
  }

  // ===== GET /api/verify-email =====
  if (req.method === 'GET' && url.startsWith('/api/verify-email')) {
    const urlObj = new URL(url, 'http://localhost');
    const token = urlObj.searchParams.get('token');

    if (!token) {
      return jsonResponse(res, { error: '缺少验证 token' }, 400);
    }

    const tokenHash = createHash('sha256').update(token).digest('hex');

    // 查找有效的验证记录
    const record = db.prepare('SELECT id, user_id, email, expires_at FROM email_verifications WHERE token_hash = ?').get(tokenHash);
    if (!record) {
      return jsonResponse(res, { error: '无效的验证链接' }, 400);
    }
    if (new Date(record.expires_at) < new Date()) {
      db.prepare('DELETE FROM email_verifications WHERE id = ?').run(record.id);
      return jsonResponse(res, { error: '验证链接已过期，请重新发送' }, 400);
    }

    // 标记邮箱为已验证
    db.prepare('UPDATE users SET email = ?, email_verified_at = datetime(\'now\') WHERE id = ?').run(record.email, record.user_id);
    // 删除已使用的验证记录
    db.prepare('DELETE FROM email_verifications WHERE id = ?').run(record.id);

    return jsonResponse(res, { ok: true, email: record.email });
  }

  // 未匹配的路由
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
});

const io = new Server(http, { cors: { origin: '*' }, pingInterval: 5000, pingTimeout: 15000 });
const rooms = new Map();

// ===== 游戏辅助函数 =====
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

    // 旧房间已过期，提示并创建新房间
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
