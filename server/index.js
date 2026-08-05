import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
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
const APP_VERSION = '2026-08-05-001'; // 每次部署前递增此值，客户端将自动强制刷新
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

  CREATE TABLE IF NOT EXISTS pending_registrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    email TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    is_popup INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
  CREATE INDEX IF NOT EXISTS idx_users_player_key ON users(player_key);
  CREATE INDEX IF NOT EXISTS idx_games_player_key ON games(player_key);
  CREATE INDEX IF NOT EXISTS idx_pending_reg_token ON pending_registrations(token_hash);
`);

// 补充列（兼容旧数据库，列已存在则跳过）
for (const [table, col, type] of [
  ['users', 'email', 'TEXT'],
  ['users', 'email_verified_at', 'TEXT'],
  ['users', 'nickname', 'TEXT'],
  ['users', 'avatar', 'TEXT'],
  ['users', 'display_id', 'TEXT'],
  ['users', 'role', "TEXT DEFAULT 'user'"],
  ['users', 'banned_at', 'TEXT'],
  ['games', 'mode', "TEXT DEFAULT 'single'"],
]) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); } catch {}
}
// display_id 唯一索引（ALTER TABLE 不支持 UNIQUE 约束）
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_display_id ON users(display_id)'); } catch {}

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

// 定期清理过期待处理注册（每小时）
setInterval(() => {
  db.prepare("DELETE FROM pending_registrations WHERE expires_at < datetime('now')").run();
}, 3600_000);

// ===== 鉴权中间件 =====
function requireAuth(req, res) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    jsonResponse(res, { error: '未登录，请先登录' }, 401);
    return null;
  }
  const decoded = verifyToken(authHeader.slice(7));
  if (!decoded) {
    jsonResponse(res, { error: '登录已过期，请重新登录' }, 401);
    return null;
  }
  return decoded; // { userId, username, iat, exp }
}

function requireAdmin(req, res) {
  const user = requireAuth(req, res);
  if (!user) return null;
  const row = db.prepare('SELECT role FROM users WHERE id = ?').get(user.userId);
  if (!row || row.role !== 'admin') {
    jsonResponse(res, { error: '无管理员权限' }, 403);
    return null;
  }
  return user;
}

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
    'Access-Control-Allow-Credentials': 'false',
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

function deriveGuestName(key) {
  const code = createHash('sha256').update(key + 'display').digest('hex').slice(0, 5).toUpperCase();
  return `访客#${code}`;
}

// 为用户生成唯一显示编号（基于 user.id + salt，36进制5位，不可重复）
const DISPLAY_ID_SALT = randomBytes(32).toString('hex'); // 进程重启后变化，但已生成的编号不变（存于DB）
function generateDisplayCode(userId) {
  const digest = createHash('sha256')
    .update(`arknights-display-v1\0`, 'ascii')
    .update(String(userId))
    .update(DISPLAY_ID_SALT)
    .digest();
  const value = digest.readUInt32BE(0) % (36 ** 5); // 36^5 ≈ 6000万
  return value.toString(36).padStart(5, '0').toUpperCase();
}

// ===== 昵称违禁词过滤 =====
const NICKNAME_FORBIDDEN = new Set([
  // === 中文脏话/人身攻击 ===
  '傻逼', '傻比', '傻b', 'sb', '傻杯', '煞笔', '沙比', '沙雕', '傻屌', '傻叉',
  '弱智', '脑残', '智障', '白痴', '二百五', '废物', '垃圾',
  '操你', '草你', '艹你', '草泥马', '操你妈', 'cnm', 'cao', '我操', '卧槽', '我艹',
  '妈的', '妈的', '他妈的', '你妈的', '你妈', '他妈', '妈逼', '妈比', '妈了个',
  '贱人', '贱货', '骚货', '骚比', '婊子', '婊', '妓女', '鸡婆', '荡妇',
  '淫', '奸', '强奸', '轮奸', '鸡巴', '鸡吧', '几把', '几巴', 'jb', 'j8',
  '屌', '屄', '逼', ' bitch', 'bitch', 'fuck', 'fck', 'fuk', 'f*ck', 'shit',
  '狗日的', '日你', '日了狗', '狗东西', '狗娘养',
  '龟儿子', '王八蛋', '王八', '杂种', '野种', '孽种',
  '去死', '去死吧', '死妈', '死全家', '全家死', '不得好死',
  '废物', '辣鸡', '垃圾', '恶心',
  // === 政治/敏感 ===
  '习近平', '习大大', '习包子', '习皇帝', '小熊维尼', '维尼',
  '毛泽东', '邓小平', '江泽民', '胡锦涛', '温家宝', '李克强',
  '共产党', '中共', '国民党', '民进党',
  '法轮功', '法轮大法', 'falun', '六四', '天安门', '八九',
  '台独', '藏独', '疆独', '港独', '西藏独立', '新疆独立',
  '民主', '自由', '人权', '迫害', '专制', '独裁', '暴政', // 上下文敏感，整体屏蔽
  // === 歧视/仇恨 ===
  '支那', '赤佬', '黑鬼', 'nigger', 'nigga', 'negro',
  'faggot', 'fag', 'tranny', 'retard', 'retarded',
  // === 广告/引流 ===
  '加微信', '加我微信', '加qq', '加我q', '加我QQ',
  '微信号', '微信：', 'qq：', 'QQ：', 'vx：', 'VX：',
  '出售', '代练', '陪玩', '包赢', '刷分', '外挂', '作弊',
  '看片', '视频', '直播', '加群',
  // === 冒充官方 ===
  '管理员', '官方', '客服', 'GM', 'gm', 'admin', '系统',
  '版主', ' moderator', 'moderator',
  // === 其他规避 ===
  '　', // 全角空格（用于隐藏违禁词）
]);

function checkNicknameProfanity(nickname) {
  const lower = nickname.toLowerCase();
  // 检查每个违禁词
  for (const word of NICKNAME_FORBIDDEN) {
    if (lower.includes(word.toLowerCase())) {
      return word; // 返回匹配到的违禁词
    }
  }
  // 检查纯数字/纯符号昵称（规避检测用）
  if (/^[\d\s._\-+*=#@!~`]+$/.test(nickname)) {
    return '纯数字符号';
  }
  // 检查过多重复字符（如"啊啊啊啊啊啊啊"规避检测）
  if (/(.)\1{6,}/.test(nickname)) {
    return '重复字符';
  }
  // 检查是否只有空白/不可见字符
  if (nickname.trim().length === 0) {
    return '空白昵称';
  }
  return null; // 通过
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
      'Access-Control-Allow-Credentials': 'false',
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
    // 频率限制: 5次/10分钟/IP
    if (!checkRateLimit(`reg:${ip}`, 5, 600_000)) {
      return jsonResponse(res, { error: '注册请求过于频繁，请10分钟后再试' }, 429);
    }

    const body = await parseBody(req);
    const username = sanitizeString(body.username, 20);
    const password = typeof body.password === 'string' ? body.password : '';
    const email = sanitizeString(body.email, 320);

    // --- 验证输入 ---
    if (!username || !password || !email) {
      return jsonResponse(res, { error: '用户名、密码和邮箱不能为空' }, 400);
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
    if (!email.includes('@') || email.length > 320) {
      return jsonResponse(res, { error: '请输入有效的邮箱地址' }, 400);
    }

    // --- 检查用户名是否已被注册 ---
    const existingUser = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existingUser) {
      return jsonResponse(res, { error: '用户名已被注册' }, 409);
    }

    // --- 检查是否有未过期的待处理注册（防重复提交） ---
    const existingPending = db.prepare(
      "SELECT id FROM pending_registrations WHERE (username = ? OR email = ?) AND expires_at > datetime('now')"
    ).get(username, email);
    if (existingPending) {
      return jsonResponse(res, { error: '该用户名或邮箱已有待验证的注册，请查收邮件或等待过期后重试' }, 409);
    }

    // --- 哈希密码 ---
    const password_hash = await bcrypt.hash(password, 10);

    // --- 生成验证 token ---
    const verifyToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(verifyToken).digest('hex');
    const expiresAt = new Date(Date.now() + 3600_000).toISOString(); // 1小时后过期

    // --- 存储到待处理注册表（不创建用户！） ---
    db.prepare(
      'INSERT INTO pending_registrations (username, password_hash, email, token_hash, expires_at) VALUES (?, ?, ?, ?, ?)'
    ).run(username, password_hash, email, tokenHash, expiresAt);

    // --- 发送验证邮件 ---
    const verifyLink = `${SITE_URL}/verify?token=${verifyToken}`;
    if (!process.env.SMTP_PASS || SITE_URL === 'http://localhost:3000') {
      console.log('[DEV] 验证链接:', verifyLink);
    }

    const isDev = !process.env.SMTP_PASS || SITE_URL === 'http://localhost:3000';

    if (isDev) {
      // 本地开发：跳过邮件发送，直接保留待处理注册
      console.log('[DEV] ========================================');
      console.log('[DEV] 验证链接:', verifyLink);
      console.log('[DEV] ========================================');
      return jsonResponse(res, {
        ok: true,
        message: '[DEV] 验证邮件已跳过，请使用控制台打印的链接完成验证',
        devVerifyLink: verifyLink,
      });
    }

    try {
      await transporter.sendMail({
        from: '"明日方舟猜干员" <3479083602@qq.com>',
        to: email,
        subject: '完成注册 - 明日方舟猜干员',
        html: `
          <div style="max-width:480px;margin:0 auto;font-family:sans-serif">
            <h2>完成你的注册</h2>
            <p>感谢注册！点击下方按钮完成注册：</p>
            <a href="${verifyLink}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none;font-weight:bold">完成注册</a>
            <p style="color:#666;margin-top:20px;font-size:0.85rem">或者复制此链接到浏览器：<br>${verifyLink}</p>
            <p style="color:#999;font-size:0.8rem">此链接1小时内有效。如果你没有注册此账号，请忽略此邮件。</p>
          </div>
        `,
      });

      return jsonResponse(res, {
        ok: true,
        message: '验证邮件已发送，请查收邮件并点击链接完成注册',
      });
    } catch (err) {
      // 邮件发送失败 → 清理待处理记录，避免垃圾数据
      db.prepare('DELETE FROM pending_registrations WHERE token_hash = ?').run(tokenHash);
      console.error('[register] email error:', err.message);
      return jsonResponse(res, { error: '邮件发送失败，请稍后再试' }, 500);
    }
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

    const user = db.prepare('SELECT id, username, display_id, nickname, role, password_hash, player_key, email, email_verified_at FROM users WHERE username = ?').get(username);
    if (!user) {
      return jsonResponse(res, { error: '用户名或密码错误' }, 401);
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return jsonResponse(res, { error: '用户名或密码错误' }, 401);
    }

    const token = signToken({ userId: user.id, username: user.username });

    // 确保用户有 player_key（兼容旧账号）
    // 优先使用 cookie 中已存在的 player_key（保留旧游戏数据）
    let playerKey = user.player_key;
    let setPlayerKeyCookie = '';
    if (!playerKey) {
      const cookies = parseCookies(req.headers.cookie || '');
      if (cookies.player_key && typeof cookies.player_key === 'string' && cookies.player_key.startsWith('p_')) {
        // 使用 cookie 中已有的 player_key（旧用户可能之前玩过多人）
        playerKey = cookies.player_key;
        db.prepare('UPDATE users SET player_key = ? WHERE id = ?').run(playerKey, user.id);
      } else {
        // 完全没有 player_key → 生成新的
        playerKey = 'p_' + randomBytes(9).toString('base64url');
        db.prepare('UPDATE users SET player_key = ? WHERE id = ?').run(playerKey, user.id);
        setPlayerKeyCookie = `player_key=${playerKey}; SameSite=Lax; Path=/; Max-Age=94608000; HttpOnly`;
      }
    }

    // 设置 httpOnly token cookie
    const cookieHeaders = [`token=${token}; SameSite=None; Secure; HttpOnly; Path=/; Max-Age=2592000`];
    if (setPlayerKeyCookie) cookieHeaders.push(setPlayerKeyCookie);

    return jsonResponse(res, {
      token,
      username: user.username,
      displayId: user.display_id || null,
      nickname: user.nickname || null,
      userId: user.id,
      role: user.role || 'user',
      player_key: playerKey,
      email: user.email || null,
      email_verified: !!user.email_verified_at,
    }, 200, {
      'Set-Cookie': cookieHeaders,
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

    const insert = db.prepare('INSERT INTO games (player_key, won, guess_count, difficulty, target_name, timestamp, mode) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insertMany = db.transaction((rows) => {
      for (const g of rows) {
        const mode = g.mode === 'multi' ? 'multi' : 'single';
        insert.run(player_key, g.won ? 1 : 0, g.guessCount || 0, g.difficulty || 'hard', sanitizeString(g.targetName || '', 100), g.timestamp || new Date().toISOString(), mode);
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
    const auth = requireAuth(req, res);
    if (!auth) return;

    const user = db.prepare(
      'SELECT id, username, display_id, nickname, player_key, email, email_verified_at, role, created_at FROM users WHERE id = ?'
    ).get(auth.userId);
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
      displayId: user.display_id || null,
      nickname: user.nickname || null,
      player_key: user.player_key,
      email: user.email || null,
      email_verified: !!user.email_verified_at,
      role: user.role || 'user',
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
    const auth = requireAuth(req, res);
    if (!auth) return;

    const body = await parseBody(req);
    const player_key = typeof body.player_key === 'string' ? body.player_key.trim() : '';
    if (!player_key) {
      return jsonResponse(res, { error: '需要 player_key' }, 400);
    }

    db.prepare('UPDATE users SET player_key = ? WHERE id = ?').run(player_key, auth.userId);
    return jsonResponse(res, { success: true });
  }

  // ===== PATCH /api/me — 修改个人信息 =====
  if (req.method === 'PATCH' && url === '/api/me') {
    const auth = requireAuth(req, res);
    if (!auth) return;

    const body = await parseBody(req);
    const nickname = typeof body.nickname === 'string' ? sanitizeString(body.nickname, 30) : null;

    // 校验 nickname
    if (nickname !== null) {
      if (nickname.length < 1 || nickname.length > 30) {
        return jsonResponse(res, { error: '昵称需要 1-30 个字符' }, 400);
      }
      const badWord = checkNicknameProfanity(nickname);
      if (badWord) {
        return jsonResponse(res, { error: `昵称包含违禁内容，请修改` }, 400);
      }
    }

    if (nickname === null) {
      return jsonResponse(res, { error: '没有需要修改的字段' }, 400);
    }

    db.prepare('UPDATE users SET nickname = ? WHERE id = ?').run(nickname, auth.userId);

    // 返回更新后的用户信息
    const user = db.prepare(
      'SELECT id, username, display_id, nickname, email, email_verified_at, created_at FROM users WHERE id = ?'
    ).get(auth.userId);

    return jsonResponse(res, {
      username: user.username,
      displayId: user.display_id || null,
      nickname: user.nickname || null,
      email: user.email || null,
      email_verified: !!user.email_verified_at,
      created_at: user.created_at,
    });
  }

  // ===== POST /api/send-verification =====
  if (req.method === 'POST' && url === '/api/send-verification') {
    const auth = requireAuth(req, res);
    if (!auth) return;

    const body = await parseBody(req);
    const email = sanitizeString(body.email, 320);

    if (!email || !email.includes('@')) {
      return jsonResponse(res, { error: '请输入有效的邮箱地址' }, 400);
    }

    const user = db.prepare('SELECT id, email, email_verified_at FROM users WHERE id = ?').get(auth.userId);
    if (!user) {
      return jsonResponse(res, { error: '用户不存在' }, 404);
    }
    if (user.email_verified_at) {
      return jsonResponse(res, { error: '邮箱已验证' }, 400);
    }

    // 更新用户邮箱
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, auth.userId);

    // 生成验证 token
    const verifyToken_ = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(verifyToken_).digest('hex');
    const expiresAt = new Date(Date.now() + 3600_000).toISOString(); // 1小时过期

    // 删除旧的验证记录
    db.prepare('DELETE FROM email_verifications WHERE user_id = ?').run(auth.userId);
    // 插入新的验证记录
    db.prepare('INSERT INTO email_verifications (user_id, email, token_hash, expires_at) VALUES (?, ?, ?, ?)').run(auth.userId, email, tokenHash, expiresAt);

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

    // 情况1：新注册流程（从 pending_registrations 查）
    const pending = db.prepare(
      "SELECT id, username, password_hash, email, expires_at FROM pending_registrations WHERE token_hash = ?"
    ).get(tokenHash);

    if (pending) {
      if (new Date(pending.expires_at) < new Date()) {
        db.prepare('DELETE FROM pending_registrations WHERE id = ?').run(pending.id);
        return jsonResponse(res, { error: '验证链接已过期，请重新注册' }, 400);
      }

      // 再次确认用户名没有被抢注
      const existingUser = db.prepare('SELECT id FROM users WHERE username = ?').get(pending.username);
      if (existingUser) {
        db.prepare('DELETE FROM pending_registrations WHERE id = ?').run(pending.id);
        return jsonResponse(res, { error: '用户名已被注册' }, 409);
      }

      // 创建用户（邮箱已通过验证）
      const result = db.prepare(
        "INSERT INTO users (username, password_hash, email, email_verified_at, created_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))"
      ).run(pending.username, pending.password_hash, pending.email);

      // 生成唯一显示编号
      const userId = result.lastInsertRowid;
      const displayId = generateDisplayCode(userId);
      db.prepare('UPDATE users SET display_id = ? WHERE id = ?').run(displayId, userId);

      // 清理待处理记录
      db.prepare('DELETE FROM pending_registrations WHERE id = ?').run(pending.id);

      return jsonResponse(res, {
        ok: true,
        email: pending.email,
        username: pending.username,
      });
    }

    // 情况2：旧流程兼容（已注册用户补验证邮箱，从 email_verifications 查）
    const record = db.prepare(
      'SELECT id, user_id, email, expires_at FROM email_verifications WHERE token_hash = ?'
    ).get(tokenHash);

    if (!record) {
      return jsonResponse(res, { error: '无效的验证链接' }, 400);
    }
    if (new Date(record.expires_at) < new Date()) {
      db.prepare('DELETE FROM email_verifications WHERE id = ?').run(record.id);
      return jsonResponse(res, { error: '验证链接已过期，请重新发送' }, 400);
    }

    db.prepare("UPDATE users SET email = ?, email_verified_at = datetime('now') WHERE id = ?").run(record.email, record.user_id);
    db.prepare('DELETE FROM email_verifications WHERE id = ?').run(record.id);

    return jsonResponse(res, { ok: true, email: record.email });
  }

  // ===== POST /api/save-game =====
  if (req.method === 'POST' && url === '/api/save-game') {
    if (!checkRateLimit(`save:${ip}`, 30, 60_000)) {
      return jsonResponse(res, { error: '请求过于频繁，请稍后再试' }, 429);
    }

    const body = await parseBody(req);
    let player_key = typeof body.player_key === 'string' ? body.player_key.trim() : '';
    const won = body.won;
    const guessCount = typeof body.guessCount === 'number' ? body.guessCount : -1;
    const mode = sanitizeString(body.mode || 'single', 10);
    let difficulty = sanitizeString(body.difficulty || 'hard', 20);
    const targetName = sanitizeString(body.targetName || '', 100);
    // 兼容数字时间戳（Date.now()）和 ISO 字符串
    let timestamp = body.timestamp;
    if (typeof timestamp === 'number') {
      timestamp = new Date(timestamp).toISOString();
    } else if (typeof timestamp !== 'string' || !timestamp) {
      timestamp = new Date().toISOString();
    }

    // 多人模式：difficulty 可以是 'multi'
    if (mode === 'multi') {
      if (difficulty !== 'multi') difficulty = 'multi'; // 多人模式统一标记
    } else if (!['easy', 'medium', 'hard'].includes(difficulty)) {
      return jsonResponse(res, { error: 'difficulty 必须是 easy、medium 或 hard' }, 400);
    }

    // 如果没有 player_key，尝试从 cookie 中获取或自动生成（兼容纯单人游客）
    let newPlayerKey = null;
    if (!player_key) {
      const cookies = parseCookies(req.headers.cookie || '');
      if (cookies.player_key) {
        player_key = cookies.player_key;
      } else {
        // 自动为游客生成 player_key
        player_key = 'p_' + randomBytes(9).toString('base64url');
        newPlayerKey = player_key;
      }
    }

    if (typeof won !== 'boolean') {
      return jsonResponse(res, { error: 'won 必须是布尔值' }, 400);
    }
    if (guessCount < 0) {
      return jsonResponse(res, { error: 'guessCount 不能为负数' }, 400);
    }

    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) {
      const decoded = verifyToken(authHeader.slice(7));
      if (decoded) {
        db.prepare('UPDATE users SET player_key = ? WHERE id = ?').run(player_key, decoded.userId);
      }
    }

    const result = db.prepare(
      'INSERT INTO games (player_key, won, guess_count, difficulty, target_name, timestamp, mode) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(player_key, won ? 1 : 0, guessCount, difficulty, targetName, timestamp, mode);

    // 如果 player_key 是新生成的，设置 cookie
    const extraHeaders = {};
    if (newPlayerKey) {
      extraHeaders['Set-Cookie'] = `player_key=${newPlayerKey}; SameSite=Lax; Path=/; Max-Age=94608000; HttpOnly`;
    }

    console.log(`[save-game] pk=${player_key.slice(0,10)} won=${won} guesses=${guessCount} mode=${mode} diff=${difficulty}`);
    return jsonResponse(res, { saved: true, id: result.lastInsertRowid, player_key: newPlayerKey || undefined }, 200, extraHeaders);
  }

  // ===== GET /api/guest-identity =====
  if (req.method === 'GET' && url === '/api/guest-identity') {
    const cookies = parseCookies(req.headers.cookie || '');
    let guestKey = cookies.guest_id || '';

    if (guestKey && typeof guestKey === 'string' && guestKey.startsWith('g_') && guestKey.length > 10) {
      const displayName = deriveGuestName(guestKey);
      console.log(`[guest] existing key=${guestKey.slice(0,10)} name=${displayName}`);
      return jsonResponse(res, { key: guestKey, displayName });
    }

    guestKey = 'g_' + randomBytes(12).toString('base64url');
    const displayName = deriveGuestName(guestKey);
    const cookieHeader = `guest_id=${guestKey}; SameSite=Lax; Path=/; Max-Age=94608000; HttpOnly`;
    console.log(`[guest] new key=${guestKey.slice(0,10)} name=${displayName}`);
    return jsonResponse(res, { key: guestKey, displayName }, 200, {
      'Set-Cookie': cookieHeader,
    });
  }

  // ===== GET /api/leaderboard =====
  if (req.method === 'GET' && url.startsWith('/api/leaderboard')) {
    const urlObj = new URL(url, 'http://localhost');
    let limit = parseInt(urlObj.searchParams.get('limit')) || 50;
    const difficulty = sanitizeString(urlObj.searchParams.get('difficulty') || '', 20);
    const mode = sanitizeString(urlObj.searchParams.get('mode') || 'single', 10);

    if (limit < 1) limit = 1;
    if (limit > 100) limit = 100;
    if (!['single', 'multi'].includes(mode)) mode = 'single';

    // 只统计注册用户（INNER JOIN users 确保排除游客）
    let query, params;
    if (difficulty && ['easy', 'medium', 'hard'].includes(difficulty)) {
      query = `
        SELECT g.player_key, u.username, u.display_id, u.nickname,
               SUM(g.won) as wins,
               COUNT(*) as totalGames,
               ROUND(CAST(SUM(g.won) AS REAL) / CAST(COUNT(*) AS REAL) * 100, 1) as winRate
        FROM games g
        INNER JOIN users u ON u.player_key = g.player_key
        WHERE g.difficulty = ? AND g.mode = ?
        GROUP BY g.player_key
        ORDER BY wins DESC, winRate DESC
        LIMIT ?
      `;
      params = [difficulty, mode, limit];
    } else {
      query = `
        SELECT g.player_key, u.username, u.display_id, u.nickname,
               SUM(g.won) as wins,
               COUNT(*) as totalGames,
               ROUND(CAST(SUM(g.won) AS REAL) / CAST(COUNT(*) AS REAL) * 100, 1) as winRate
        FROM games g
        INNER JOIN users u ON u.player_key = g.player_key
        WHERE g.mode = ?
        GROUP BY g.player_key
        ORDER BY wins DESC, winRate DESC
        LIMIT ?
      `;
      params = [mode, limit];
    }

    const rows = db.prepare(query).all(...params);
    const leaderboard = rows.map((row, idx) => ({
      rank: idx + 1,
      username: row.username,
      displayId: row.display_id || null,
      nickname: row.nickname || null,
      displayName: row.nickname || row.username,
      wins: row.wins,
      totalGames: row.totalGames,
      winRate: row.winRate,
    }));

    console.log(`[leaderboard] returned ${leaderboard.length} entries mode=${mode} diff=${difficulty || 'all'}`);
    return jsonResponse(res, { leaderboard });
  }

  // ==================== 管理员 API ====================

  // ---- 公开：获取公告列表 ----
  if (req.method === 'GET' && url === '/api/announcements') {
    const rows = db.prepare('SELECT id, title, content, is_popup, created_at FROM announcements ORDER BY created_at DESC LIMIT 50').all();
    return jsonResponse(res, rows.map(r => ({
      id: r.id, title: r.title, content: r.content,
      is_popup: !!r.is_popup, created_at: r.created_at,
    })));
  }

  // ---- 管理员：发布公告 ----
  if (req.method === 'POST' && url === '/api/admin/announcements') {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await parseBody(req);
    const title = sanitizeString(body.title, 128);
    const content = sanitizeString(body.content, 10000);
    if (!title || !content) return jsonResponse(res, { error: '标题和内容不能为空' }, 400);
    const result = db.prepare('INSERT INTO announcements (title, content, is_popup) VALUES (?, ?, ?)').run(title, content, body.is_popup ? 1 : 0);
    return jsonResponse(res, { ok: true, id: result.lastInsertRowid });
  }

  // ---- 管理员：删除公告 ----
  if (req.method === 'DELETE' && url.startsWith('/api/admin/announcements/')) {
    const admin = requireAdmin(req, res); if (!admin) return;
    const id = parseInt(url.split('/').pop(), 10);
    if (!id || id < 1) return jsonResponse(res, { error: '无效的公告ID' }, 400);
    const result = db.prepare('DELETE FROM announcements WHERE id = ?').run(id);
    if (result.changes === 0) return jsonResponse(res, { error: '公告不存在' }, 404);
    return jsonResponse(res, { ok: true });
  }

  // ---- 管理员：用户列表 ----
  if (req.method === 'GET' && url.startsWith('/api/admin/users')) {
    const admin = requireAdmin(req, res); if (!admin) return;
    const urlObj = new URL(url, 'http://localhost');
    const search = sanitizeString(urlObj.searchParams.get('search') || '', 64);
    const page = Math.max(1, parseInt(urlObj.searchParams.get('page')) || 1);
    const pageSize = Math.min(100, Math.max(10, parseInt(urlObj.searchParams.get('pageSize')) || 50));

    let query = 'SELECT id, username, display_id, nickname, email, email_verified_at, role, banned_at, created_at FROM users WHERE 1=1';
    const params = [];
    if (search) {
      query += ' AND (username LIKE ? OR display_id LIKE ? OR email LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    const countRow = db.prepare(`SELECT COUNT(*) as total FROM (${query})`).get(...params);
    const total = countRow.total;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const p = Math.min(page, totalPages);
    const users = db.prepare(query + ' ORDER BY created_at DESC LIMIT ? OFFSET ?').all(...params, pageSize, (p - 1) * pageSize);

    return jsonResponse(res, {
      users: users.map(u => ({
        id: u.id, username: u.username,
        displayId: u.display_id || '',
        nickname: u.nickname || null,
        email: u.email || null,
        emailVerified: !!u.email_verified_at,
        role: u.role || 'user',
        banned: !!u.banned_at,
        createdAt: u.created_at,
      })),
      total, page: p, pageSize, totalPages,
    });
  }

  // ---- 管理员：封禁/解封用户 ----
  if (req.method === 'PATCH' && url.match(/^\/api\/admin\/users\/(\d+)\/ban$/)) {
    const admin = requireAdmin(req, res); if (!admin) return;
    const userId = parseInt(url.match(/^\/api\/admin\/users\/(\d+)\/ban$/)[1], 10);
    const body = await parseBody(req);
    if (typeof body.banned !== 'boolean') return jsonResponse(res, { error: 'banned 字段必填 (boolean)' }, 400);

    if (body.banned && userId === admin.userId) {
      return jsonResponse(res, { error: '不能封禁自己' }, 400);
    }

    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!user) return jsonResponse(res, { error: '用户不存在' }, 404);

    db.prepare('UPDATE users SET banned_at = ? WHERE id = ?').run(body.banned ? new Date().toISOString() : null, userId);

    if (body.banned) {
      for (const [sid, s] of io.sockets.sockets) {
        if (s.data?.userId === userId) s.disconnect(true);
      }
    }

    return jsonResponse(res, { ok: true, id: userId, banned: body.banned });
  }

  // ---- 管理员：修改用户昵称 ----
  if (req.method === 'PATCH' && url.match(/^\/api\/admin\/users\/(\d+)\/nickname$/)) {
    const admin = requireAdmin(req, res); if (!admin) return;
    const userId = parseInt(url.match(/^\/api\/admin\/users\/(\d+)\/nickname$/)[1], 10);
    const body = await parseBody(req);
    const newNickname = sanitizeString(body.nickname, 30);

    if (!newNickname || newNickname.length < 1) {
      return jsonResponse(res, { error: '昵称不能为空' }, 400);
    }

    const badWord = checkNicknameProfanity(newNickname);
    if (badWord) return jsonResponse(res, { error: `昵称包含违禁内容: ${badWord}` }, 400);

    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!user) return jsonResponse(res, { error: '用户不存在' }, 404);

    db.prepare('UPDATE users SET nickname = ? WHERE id = ?').run(newNickname, userId);
    return jsonResponse(res, { ok: true, id: userId, nickname: newNickname });
  }

  // ---- 管理员：游客列表 ----
  if (req.method === 'GET' && url.startsWith('/api/admin/guests')) {
    const admin = requireAdmin(req, res); if (!admin) return;
    const urlObj = new URL(url, 'http://localhost');
    const search = sanitizeString(urlObj.searchParams.get('search') || '', 64);
    const page = Math.max(1, parseInt(urlObj.searchParams.get('page')) || 1);
    const pageSize = Math.min(100, Math.max(10, parseInt(urlObj.searchParams.get('pageSize')) || 50));

    const aggQuery = `
      SELECT g.player_key, COUNT(*) as totalGames, SUM(g.won) as wins, MAX(g.timestamp) as lastSeen
      FROM games g
      LEFT JOIN users u ON u.player_key = g.player_key
      WHERE u.player_key IS NULL
      ${search ? "AND (g.player_key LIKE ? OR g.target_name LIKE ?)" : ''}
      GROUP BY g.player_key ORDER BY lastSeen DESC
    `;
    const countParams = search ? [`%${search}%`, `%${search}%`] : [];
    const countRow = db.prepare(`SELECT COUNT(*) as total FROM (${aggQuery})`).all(...countParams);
    const total = countRow[0]?.total || 0;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const p = Math.min(page, totalPages);
    const guests = db.prepare(aggQuery + ' LIMIT ? OFFSET ?').all(...countParams, pageSize, (p - 1) * pageSize);

    return jsonResponse(res, {
      guests: guests.map(g => ({
        playerKey: g.player_key,
        displayName: deriveGuestName(g.player_key),
        totalGames: g.totalGames,
        wins: g.wins,
        lastSeen: g.lastSeen,
      })),
      total, page: p, pageSize, totalPages,
    });
  }

  // ===== GET /api/history =====
  if (req.method === 'GET' && url.startsWith('/api/history')) {
    const auth = requireAuth(req, res);
    if (!auth) return;

    const urlObj = new URL(url, 'http://localhost');
    let limit = parseInt(urlObj.searchParams.get('limit')) || 80;
    if (limit < 1) limit = 1;
    if (limit > 200) limit = 200;

    const user = db.prepare('SELECT player_key FROM users WHERE id = ?').get(auth.userId);
    const pk = user?.player_key || '';

    const rows = db.prepare(
      'SELECT won, guess_count, difficulty, target_name, timestamp, mode FROM games WHERE player_key = ? ORDER BY timestamp DESC LIMIT ?'
    ).all(pk, limit);

    const history = rows.map(r => ({
      timestamp: new Date(r.timestamp).getTime(),
      won: !!r.won,
      guessCount: r.guess_count,
      difficulty: r.difficulty,
      targetName: r.target_name || '',
      mode: r.mode || 'single',
    }));

    return jsonResponse(res, { history, count: history.length });
  }

  // ===== GET /api/version — 客户端版本检测（强制刷新旧缓存） =====
  if (req.method === 'GET' && url === '/api/version') {
    return jsonResponse(res, { version: APP_VERSION });
  }

  // ===== POST /api/deploy — Webhook 自动部署 =====
  if (req.method === 'POST' && url === '/api/deploy') {
    const body = await parseBody(req);
    const DEPLOY_TOKEN = process.env.DEPLOY_TOKEN || '';
    if (!DEPLOY_TOKEN) {
      return jsonResponse(res, { error: 'DEPLOY_TOKEN not configured' }, 500);
    }
    if (body.token !== DEPLOY_TOKEN) {
      return jsonResponse(res, { error: 'invalid token' }, 403);
    }
    jsonResponse(res, { ok: true, message: 'deploy triggered' });
    // detached 子进程避免被 PM2 重启影响
    setTimeout(() => {
      const child = spawn('bash', ['-c',
        'cd /opt/liyiba && git fetch origin main && git reset --hard origin/main && export PATH=$PATH:/root/.nvm/versions/node/v18.20.4/bin && npm install --production && pm2 restart liyiba'
      ], { detached: true, stdio: 'ignore' });
      child.unref();
    }, 500);
    return;
  }

  // 未匹配的路由
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
});

// auto-deploy v3: echo key + verbose SSH
const io = new Server(http, { cors: { origin: '*' }, pingInterval: 5000, pingTimeout: 15000 });
const rooms = new Map();

// ===== 匹配队列 =====
const matchmakingQueue = new Map(); // socketId -> { socketId, playerKey, playerName, difficulty, joinedAt }

function genMatchCode() {
  let code;
  do {
    code = randomBytes(3).toString('hex').toUpperCase(); // 6 hex chars
  } while (rooms.has(code));
  return code;
}

function tryMatch(difficulty) {
  // 筛选同难度的排队玩家，按加入时间 FIFO 排序
  const entries = Array.from(matchmakingQueue.values())
    .filter(e => e.difficulty === difficulty)
    .sort((a, b) => a.joinedAt - b.joinedAt);

  if (entries.length < 2) return;

  const [p1, p2] = entries;
  matchmakingQueue.delete(p1.socketId);
  matchmakingQueue.delete(p2.socketId);

  const sock1 = io.sockets.sockets.get(p1.socketId);
  const sock2 = io.sockets.sockets.get(p2.socketId);
  if (!sock1 || !sock2) {
    // 有一方断线了，把另一方放回队列
    if (sock1) matchmakingQueue.set(p1.socketId, p1);
    if (sock2) matchmakingQueue.set(p2.socketId, p2);
    return;
  }

  const code = genMatchCode();
  const bestOf = 5;
  const winsNeeded = Math.ceil(bestOf / 2);

  const room = {
    code, bestOf, winsNeeded, difficulty, _createdAt: Date.now(),
    players: new Map([
      [p1.socketId, { name: p1.playerName, wins: 0, dcTimer: null, lastSocketId: null, playerKey: p1.playerKey, identityKey: sock1.data.identityKey, ready: false }],
      [p2.socketId, { name: p2.playerName, wins: 0, dcTimer: null, lastSocketId: null, playerKey: p2.playerKey, identityKey: sock2.data.identityKey, ready: false }],
    ]),
    started: true, finished: false,
  };
  rooms.set(code, room);

  sock1.join(code);
  sock1.data.roomCode = code;
  sock2.join(code);
  sock2.data.roomCode = code;

  console.log(`[匹配] ${p1.playerName} vs ${p2.playerName} 房间 ${code} 难度 ${difficulty}`);

  // 通知双方
  sock1.emit('matchmaking:matched', { roomCode: code, opponent: { name: p2.playerName, playerKey: p2.playerKey }, bestOf, difficulty });
  sock2.emit('matchmaking:matched', { roomCode: code, opponent: { name: p1.playerName, playerKey: p1.playerKey }, bestOf, difficulty });

  // 开始游戏
  startRound(room);
}

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
  socket.data.identityKey = socket.data.playerKey;
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

function findRoomByIdentityKey(ik) {
  for (const [code, r] of rooms) {
    if (r.finished) continue;
    for (const p of r.players.values()) {
      if (p.identityKey === ik || p.playerKey === ik) return r;
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
      if (player.playerKey === socket.data.playerKey || player.identityKey === socket.data.identityKey) {
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

  // === 同步房间状态 ===
  socket.on('room:sync', () => {
    const room = findRoomByIdentityKey(socket.data.identityKey);
    if (room && !room.finished) {
      socket.emit('room:sync', {
        room: { code: room.code, bestOf: room.bestOf, difficulty: room.difficulty || 'hard', started: room.started, status: room.started ? 'playing' : 'waiting' }
      });
    } else {
      socket.emit('room:sync', { room: null });
    }
  });

  // === 匹配：加入队列 ===
  socket.on('matchmaking:join', (data) => {
    // 检查是否已在房间中
    const existing = findRoomByPlayerKey(socket.data.playerKey);
    if (existing) {
      socket.emit('existing_room', { code: existing.code, bestOf: existing.bestOf, difficulty: existing.difficulty || 'hard', started: existing.started, wins: existing.players.get(socket.id)?.wins || 0 });
      return;
    }

    const playerName = sanitizeString(data?.playerName || '玩家', 20);
    const difficulty = ['easy', 'medium', 'hard'].includes(data?.difficulty) ? data?.difficulty : 'hard';

    // 移除已有排队记录（如有）
    matchmakingQueue.delete(socket.id);

    matchmakingQueue.set(socket.id, {
      socketId: socket.id,
      playerKey: socket.data.playerKey,
      playerName,
      difficulty,
      joinedAt: Date.now(),
    });

    // 计算排队位置（同难度FIFO）
    const position = Array.from(matchmakingQueue.values())
      .filter(e => e.difficulty === difficulty)
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .findIndex(e => e.socketId === socket.id) + 1;

    socket.emit('matchmaking:status', { queued: true, position, difficulty });
    console.log(`[排队] ${playerName} 加入 ${difficulty} 队列 位置 ${position}`);

    // 尝试匹配
    tryMatch(difficulty);
  });

  // === 匹配：离开队列 ===
  socket.on('matchmaking:leave', () => {
    const wasInQueue = matchmakingQueue.has(socket.id);
    matchmakingQueue.delete(socket.id);
    if (wasInQueue) {
      socket.emit('matchmaking:status', { queued: false, position: 0, difficulty: '' });
      console.log(`[排队] ${socket.id} 离开队列`);
    }
  });

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
    rooms.set(code, { code, bestOf, winsNeeded: Math.ceil(bestOf / 2), difficulty, _createdAt: Date.now(), players: new Map([[socket.id, { name: data?.playerName || '玩家', wins: 0, dcTimer: null, lastSocketId: null, playerKey: socket.data.playerKey, identityKey: socket.data.identityKey, ready: false }]]), started: false, finished: false });
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
        if (p.dcTimer && (p.playerKey === socket.data.playerKey || p.identityKey === socket.data.identityKey)) {
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

    room.players.set(socket.id, { name: data?.playerName || '玩家', wins: 0, dcTimer: null, lastSocketId: null, playerKey: socket.data.playerKey, identityKey: socket.data.identityKey, ready: false });
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
    // 从匹配队列中移除
    matchmakingQueue.delete(socket.id);

    const room = rooms.get(socket.data.roomCode);
    if (!room || room.finished) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    player.lastSocketId = socket.id;
    player.identityKey = socket.data.identityKey;
    io.to(room.code).emit('opponent_disconnected', { playerName: player.name });
    player.dcTimer = setTimeout(() => {
      if (room.roundSettled || room.finished) return;
      const other = Array.from(room.players.keys()).find(id => id !== socket.id);
      io.to(room.code).emit('match_end', { winner: other, winnerName: room.players.get(other)?.name || '对手', score: score(room), reason: 'disconnect' });
      room.finished = true;
    }, DISCONNECT);
  });

  // === 主动重连（房间码+player_key） ===
  socket.on('reconnect_room', (data) => {
    const code = (data?.code || '').toUpperCase();
    const room = rooms.get(code);
    if (!room || room.finished) return;
    
    let foundPid = null; for (const [pid, p] of room.players) { if (p.playerKey === socket.data.playerKey || p.identityKey === socket.data.identityKey) { foundPid = pid; break; } }
    if (!foundPid) return;
    const player = room.players.get(foundPid);
    if (player.dcTimer) { clearTimeout(player.dcTimer); player.dcTimer = null; }
    room.players.delete(foundPid);
    room.players.set(socket.id, player);
    socket.join(code);
    socket.data.roomCode = code;
    socket.to(code).emit('opponent_reconnected', { playerName: player.name });
    if (room.started) {
      socket.emit('reconnect_state', { code, bestOf: room.bestOf, winsNeeded: room.winsNeeded, score: score(room), target: room.target, players: Array.from(room.players.entries()).map(([id, p]) => ({ id, name: p.name, wins: p.wins })) });
    }
    console.log(`[重连] ${socket.id} → ${code}`);
});
});

http.listen(PORT, () => console.log(`:${PORT}`));
