// 明日方舟猜干员 — 服务器入口
// 模块化架构：db → auth → routes + socket → http
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTransport } from 'nodemailer';
import Database from 'better-sqlite3';
import { generateKey, getClientIP, jsonResponse, checkNicknameProfanity, getAllowedOrigins } from './utils.js';
import { initSchema } from './db.js';
import { createAuth } from './auth.js';
import { loadCharacters } from './characters.js';
import { loadGameEngine } from './game-engine.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerUserRoutes } from './routes/user.js';
import { registerGameRoutes } from './routes/game.js';

import { registerAdminRoutes } from './routes/admin.js';
import { createSocketServer } from './socket/index.js';
import { createRoomManager } from './socket/rooms.js';
import { createMatchmaking } from './socket/matchmaking.js';
import { registerGameHandlers } from './socket/game.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ===== 环境变量加载 =====
try {
  const envPath = join(__dirname, '..', '.env');
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (key && !process.env[key]) {
      process.env[key] = val;
    }
  }
  console.log('[env] loaded .env file');
} catch (err) {
  if (err.code === 'ENOENT') {
    // .env 文件不存在则跳过（开发环境可选）
    console.log('[env] no .env file found, using process environment only');
  } else {
    // 权限错误等其他异常应记录警告，不能静默吞掉
    console.warn('[env] failed to load .env file:', err.message, '(code:', err.code || 'none', ')');
  }
}

// ===== 全局错误处理 =====
// uncaughtException 处理器移到了 gracefulShutdown 定义之后，确保能执行完整清理
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection:', reason?.message || reason, reason?.stack?.split('\n')[1] || '');
});

// ===== 配置 =====
const PORT = process.env.PORT || 3001;
if (!process.env.JWT_SECRET) {
  if (process.env.NODE_ENV === 'development' && process.env.ALLOW_DEV_FALLBACK === '1') {
    // 仅本地开发 + 显式环境变量允许使用 dev 密钥（双重防护，防止 NODE_ENV 误设为 development）
    console.warn('[WARN] ⚠️ JWT_SECRET is not set — using dev default (local testing only)');
    console.warn('[WARN] ⚠️ ALLOW_DEV_FALLBACK=1 is active — JWTs are forgeable! Do NOT use in production!');
    process.env.JWT_SECRET = 'arknights-guess-dev-secret-local-only';
  } else if (process.env.NODE_ENV === 'development') {
    // NODE_ENV=development 但未设置 ALLOW_DEV_FALLBACK → 拒绝启动（防误配置）
    console.error('[FATAL] ⚠️ NODE_ENV=development but ALLOW_DEV_FALLBACK is not set!');
    console.error('[FATAL] Set ALLOW_DEV_FALLBACK=1 in .env for local development, or set JWT_SECRET directly.');
    process.exit(1);
  } else {
    // 生产环境必须设置 JWT_SECRET
    console.error('[FATAL] ⚠️ JWT_SECRET is not set in production!');
    console.error('[FATAL] Please set JWT_SECRET in .env: openssl rand -hex 32');
    process.exit(1);
  }
}
const APP_VERSION = process.env.APP_VERSION || '2026-08-06-002';
const DB_PATH = join(__dirname, '..', 'data.db');

let transporter = null;
if (process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = createTransport({
    host: process.env.SMTP_HOST || 'smtp.qq.com',
    port: parseInt(process.env.SMTP_PORT, 10) || 465,
    secure: true,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
} else {
  console.warn('[WARN] SMTP_USER or SMTP_PASS not set — email sending will be unavailable');
}
const SITE_URL = process.env.SITE_URL || 'http://localhost:3000';

// ===== 初始化数据库 & 认证 =====
loadCharacters();
console.log('[init] step 1: characters loaded');
loadGameEngine();
	console.log("[init] step 1b: game engine loaded");
// 必须在 index.js 顶层创建 Database（better-sqlite3 在此 VPS 上跨文件调用会 segfault）
const db = new Database(DB_PATH);
initSchema(db);
console.log('[init] step 2: db initialized');

const auth = createAuth({ db, JWT_SECRET: process.env.JWT_SECRET });
console.log('[init] step 3: auth created');
const { signToken, verifyToken, requireAuth, requireAdmin, checkRateLimit, _rlCleanupInterval } = auth;

// ===== 初始化 Socket.IO（先创建，路由需要引用 onlinePlayers） =====
console.log('[init] step 4: creating HTTP server...');
const http = createServer((req, res) => handleRequest(req, res));
console.log('[init] step 5: creating socket server...');
const socketServer = createSocketServer(http, { db, verifyToken, generateKey });
const { io, onlinePlayers, onlineSockets, socketIps, getUserIps, ONLINE_TIMEOUT } = socketServer;

// ===== 初始化房间管理 & 匹配 & 游戏 =====
const roomManager = createRoomManager();

const matchmaking = createMatchmaking({
  io,
  roomPlayerIndex: roomManager.roomPlayerIndex,
  genMatchCode: roomManager.genMatchCode,
  createMatchRoom: roomManager.createMatchRoom,
  onlinePlayers,
});

const gameHandlers = registerGameHandlers({
  io,
  rooms: roomManager.rooms,
  roomPlayerIndex: roomManager.roomPlayerIndex,
  findRoomByPlayerKey: roomManager.findRoomByPlayerKey,
  findRoomByIdentityKey: roomManager.findRoomByIdentityKey,
  genCode: roomManager.genCode,
  onlinePlayers, onlineSockets, ONLINE_TIMEOUT,
  handleJoinQueue: matchmaking.handleJoinQueue,
  handleLeaveQueue: matchmaking.handleLeaveQueue,
  removeFromQueue: matchmaking.removeFromQueue,
  cleanupStaleQueue: matchmaking.cleanupStaleQueue,
});

// 延迟注入：matchmaking 需要 startRound（由 gameHandlers 提供）
matchmaking.setStartRound(gameHandlers.startRound);


// ===== 注册路由处理器 =====
const authRoutes = registerAuthRoutes({
  app: {}, db, signToken, verifyToken, requireAuth, checkRateLimit,
  transporter, SITE_URL, getClientIP,
});

const gameRoutes = registerGameRoutes({
  app: {}, db, verifyToken, checkRateLimit, getClientIP,
});


const userRoutes = registerUserRoutes({
  app: {}, db, verifyToken, requireAuth,
  checkNicknameProfanity, transporter, SITE_URL,
  onlinePlayers, onlineSockets, ONLINE_TIMEOUT,
  checkRateLimit, getClientIP,
  invalidateLeaderboardCache: gameRoutes.invalidateLeaderboardCache,
});

const adminRoutes = registerAdminRoutes({
  app: {}, db, requireAdmin, checkNicknameProfanity,
  onlinePlayers, onlineSockets, socketIps, getUserIps, ONLINE_TIMEOUT, APP_VERSION,
  reloadCharacters: loadCharacters,
  invalidateLeaderboardCache: gameRoutes.invalidateLeaderboardCache,
});

// ===== HTTP 请求处理 =====
async function handleRequest(req, res) {
  // CORS 预检（与 socket/index.js 共用同一个 ALLOWED_ORIGINS 列表，不再使用通配符 *）
  if (req.method === 'OPTIONS') {
    const allowedOrigins = getAllowedOrigins();
    const requestOrigin = req.headers.origin || '';
    const corsOrigin = allowedOrigins.includes(requestOrigin) ? requestOrigin : allowedOrigins[0];
    res.writeHead(204, {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Max-Age': '600',
    });
    return res.end();
  }

  // 存储请求 origin 供 jsonResponse 动态匹配 CORS
  res._requestOrigin = req.headers.origin || '';

  const url = req.url || '';
  // 标准化路径（去掉 query string，防止 ?v= 等参数导致路由匹配失败）
  const path = (() => { try { return new URL(url, 'http://localhost').pathname; } catch { return url.split('?')[0]; } })();
  const ip = getClientIP(req);

  // 旧统计端点（带 5 秒缓存，避免重复轮询时迭代 rooms）
  let statsCache = null;
  let statsCacheTime = 0;
  const STATS_CACHE_TTL = 5000;
  if (path.startsWith('/stats')) {
    const now = Date.now();
    if (!statsCache || (now - statsCacheTime) > STATS_CACHE_TTL) {
      statsCache = {
        connections: io.engine.clientsCount,
        rooms: roomManager.rooms.size,
        playing: Array.from(roomManager.rooms.values()).filter(r => r.started && !r.finished).length,
      };
      statsCacheTime = now;
    }
    return jsonResponse(res, statsCache);
  }

  // ===== 路由分发（统一 try/catch 防止 handler 抛异常导致请求挂起） =====
  try {
    // Auth
    if (req.method === 'POST' && path === '/api/register') return await authRoutes.handleRegister(req, res, ip);
    if (req.method === 'POST' && path === '/api/login') return await authRoutes.handleLogin(req, res, ip);
    if (req.method === 'POST' && path === '/api/auth-cookie') return await authRoutes.handleAuthCookie(req, res);
    if (req.method === 'GET' && path.startsWith('/api/verify-email')) return await authRoutes.handleVerifyEmail(req, res);
    if (req.method === 'POST' && path === '/api/forgot-password') return await authRoutes.handleForgotPassword(req, res, ip);
    if (req.method === 'POST' && path === '/api/reset-password') return await authRoutes.handleResetPassword(req, res, ip);
    if (req.method === 'POST' && path === '/api/logout') return await authRoutes.handleLogout(req, res);

    // User
    if (req.method === 'GET' && path === '/api/me') return await userRoutes.handleMe(req, res);
    if (req.method === 'POST' && path === '/api/sync') return await userRoutes.handleSync(req, res);
    if (req.method === 'POST' && path === '/api/link-player-key') return await userRoutes.handleLinkPlayerKey(req, res);
    if (req.method === 'PATCH' && path === '/api/me') return await userRoutes.handleUpdateProfile(req, res);
    if (req.method === 'POST' && path === '/api/send-verification') return await userRoutes.handleSendVerification(req, res);
    if (req.method === 'GET' && path === '/api/guest-identity') return await userRoutes.handleGuestIdentity(req, res);
    if (req.method === 'POST' && path === '/api/heartbeat') return await userRoutes.handleHeartbeat(req, res);
    if (req.method === 'GET' && path.startsWith('/api/history')) return await userRoutes.handleHistory(req, res);

    // Game
    if (req.method === 'POST' && path === '/api/save-game') return await gameRoutes.handleSaveGame(req, res);
    if (req.method === 'GET' && path.startsWith('/api/leaderboard')) return await gameRoutes.handleLeaderboard(req, res);
    if (req.method === 'GET' && path === '/api/daily/status') return await gameRoutes.handleDailyStatus(req, res);
    if (req.method === 'POST' && path === '/api/daily/guess') return await gameRoutes.handleDailyGuess(req, res);
    if (req.method === 'GET' && path.startsWith('/api/daily/leaderboard')) return await gameRoutes.handleDailyLeaderboard(req, res);

    // Enemy

    // Admin (public)
    if (req.method === 'GET' && path === '/api/announcements') return await adminRoutes.handleGetAnnouncements(req, res);
    if (req.method === 'GET' && path === '/api/version') return await adminRoutes.handleVersion(req, res);

    // Admin (protected)
    if (req.method === 'GET' && path === '/api/admin/dashboard') return await adminRoutes.handleDashboard(req, res);
    if (req.method === 'POST' && path === '/api/admin/characters/import') return await adminRoutes.handleImportCharacters(req, res);
    if (req.method === 'GET' && path === '/api/admin/characters/export') return await adminRoutes.handleExportCharacters(req, res);

    const charMatch = path.match(/^\/api\/admin\/characters\/(.+)$/);
    if (charMatch) {
      if (req.method === 'PUT') return await adminRoutes.handleUpdateCharacter(req, res, charMatch[1]);
      if (req.method === 'DELETE') return await adminRoutes.handleDeleteCharacter(req, res, charMatch[1]);
    }

    if (req.method === 'GET' && path === '/api/admin/characters') return await adminRoutes.handleAdminCharacters(req, res);
    if (req.method === 'POST' && path === '/api/admin/characters') return await adminRoutes.handleCreateCharacter(req, res);
    if (req.method === 'GET' && path === '/api/admin/audit-log') return await adminRoutes.handleAuditLog(req, res);
    if (req.method === 'POST' && path === '/api/admin/tokens') return await adminRoutes.handleCreateToken(req, res);
    if (req.method === 'GET' && path === '/api/admin/tokens') return await adminRoutes.handleListTokens(req, res);
    if (req.method === 'DELETE' && path.startsWith('/api/admin/tokens/')) {
      const tid = parseInt(path.split('/').pop(), 10);
      if (!Number.isFinite(tid)) return jsonResponse(res, { error: '无效的 token ID' }, 400);
      return await adminRoutes.handleRevokeToken(req, res, tid);
    }
    if (req.method === 'POST' && path === '/api/admin/announcements') return await adminRoutes.handleCreateAnnouncement(req, res);
    if (req.method === 'PUT' && path.startsWith('/api/admin/announcements/')) {
      const id = parseInt(path.split('/').pop(), 10);
      if (!Number.isFinite(id)) return jsonResponse(res, { error: '无效的公告 ID' }, 400);
      return await adminRoutes.handleUpdateAnnouncement(req, res, id);
    }
    if (req.method === 'DELETE' && path.startsWith('/api/admin/announcements/')) {
      const id = parseInt(path.split('/').pop(), 10);
      if (!Number.isFinite(id)) return jsonResponse(res, { error: '无效的公告 ID' }, 400);
      return await adminRoutes.handleDeleteAnnouncement(req, res, id);
    }
    if (req.method === 'GET' && path.startsWith('/api/admin/users')) return await adminRoutes.handleAdminUsers(req, res);

    const banMatch = path.match(/^\/api\/admin\/users\/(\d+)\/ban$/);
    if (req.method === 'PATCH' && banMatch) {
      return await adminRoutes.handleBanUser(req, res, parseInt(banMatch[1], 10), io);
    }
    const roleMatch = path.match(/^\/api\/admin\/users\/(\d+)\/role$/);
    if (req.method === 'PATCH' && roleMatch) {
      return await adminRoutes.handleAdminRole(req, res, parseInt(roleMatch[1], 10));
    }
    const nickMatch = path.match(/^\/api\/admin\/users\/(\d+)\/nickname$/);
    if (req.method === 'PATCH' && nickMatch) {
      return await adminRoutes.handleAdminNickname(req, res, parseInt(nickMatch[1], 10));
    }

    if (req.method === 'GET' && path.startsWith('/api/admin/guests')) return await adminRoutes.handleAdminGuests(req, res);
    if (req.method === 'GET' && path === '/api/admin/online') return await adminRoutes.handleAdminOnline(req, res);
    if (req.method === 'POST' && path === '/api/deploy') return await adminRoutes.handleDeploy(req, res);
  } catch (err) {
    console.error('[route] handler error:', err.message, err.stack?.split('\n')[1] || '');
    if (!res.headersSent && !res.writableEnded) return jsonResponse(res, { error: '服务器内部错误' }, 500);
  }

  // 未匹配的路由
  return jsonResponse(res, { error: 'Not found' }, 404);
}

// ===== 统一周期清理（每分钟） =====
const cleanupInterval = setInterval(() => {
  try { gameHandlers.runPeriodicCleanup(); } catch (e) { console.error('[cleanup] periodicCleanup failed:', e.message); }
  try { db.pragma('wal_checkpoint(PASSIVE)'); } catch (e) { console.error('[wal] checkpoint failed:', e.message); }
}, 60_000);

// ===== 启动服务器 =====
http.listen(PORT, () => console.log(`[init] Server listening on http://localhost:${PORT}`));

// ===== 优雅关闭 =====
function gracefulShutdown(signal) {
  console.log(`[shutdown] ${signal} received, closing...`);
  clearInterval(cleanupInterval);
  if (db._cleanupInterval) clearInterval(db._cleanupInterval);
  if (_rlCleanupInterval) clearInterval(_rlCleanupInterval);
  let shutdownTimer = null;
  io.close();
  http.close(() => {
    if (shutdownTimer) clearTimeout(shutdownTimer);
    db.close();
    process.exit(0);
  });
  // 10 秒强制退出
  shutdownTimer = setTimeout(() => {
    console.warn('[shutdown] timed out after 10s, forcing exit');
    process.exit(1);
  }, 10_000);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err.message, err.stack?.split('\n')[1] || '');
  gracefulShutdown('uncaughtException');
});
