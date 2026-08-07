// 明日方舟猜干员 — 服务器入口
// 模块化架构：db → auth → routes + socket → http
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTransport } from 'nodemailer';
import Database from 'better-sqlite3';
import { generateKey, getClientIP, jsonResponse, checkNicknameProfanity } from './utils.js';
import { initSchema } from './db.js';
import { createAuth } from './auth.js';
import { loadCharacters } from './characters.js';
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
} catch { /* .env 不存在则跳过 */ }

// ===== 全局错误处理 =====
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err.message, err.stack?.split('\n')[1] || '');
  console.error('[FATAL] exiting to avoid corrupted in-memory state');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection:', reason?.message || reason, reason?.stack?.split('\n')[1] || '');
});

// ===== 配置 =====
const PORT = process.env.PORT || 3001;
if (!process.env.JWT_SECRET) {
  if (process.env.NODE_ENV === 'development' || (!process.env.SMTP_PASS && !process.env.DEPLOY_TOKEN)) {
    // 本地开发：无 SMTP/DEPLOY 也无 JWT_SECRET → 使用 dev 密钥
    console.warn('[WARN] ⚠️ JWT_SECRET is not set — using dev default (local testing only)');
    process.env.JWT_SECRET = 'arknights-guess-dev-secret-local-only';
  } else {
    // 生产环境：SMTP_PASS 或 DEPLOY_TOKEN 已设置 → JWT_SECRET 必须设置
    console.error('[FATAL] ⚠️ JWT_SECRET is not set in production!');
    console.error('[FATAL] Please set JWT_SECRET in .env: openssl rand -hex 32');
    process.exit(1);
  }
}
const APP_VERSION = '2026-08-06-002';
const DB_PATH = join(__dirname, '..', 'data.db');

const SMTP_CONFIG = {
  host: 'smtp.qq.com',
  port: 465,
  secure: true,
  auth: {
    user: process.env.SMTP_USER || '3479083602@qq.com',
    pass: process.env.SMTP_PASS || '',
  },
};
const transporter = createTransport(SMTP_CONFIG);
const SITE_URL = process.env.SITE_URL || 'http://localhost:3000';

// ===== 初始化数据库 & 认证 =====
loadCharacters();
console.log('[init] step 1: characters loaded');
// 必须在 index.js 顶层创建 Database（better-sqlite3 在此 VPS 上跨文件调用会 segfault）
const db = new Database(DB_PATH);
initSchema(db);
console.log('[init] step 2: db initialized');
const auth = createAuth({ db, JWT_SECRET: process.env.JWT_SECRET });
console.log('[init] step 3: auth created');
const { signToken, verifyToken, requireAuth, requireAdmin, checkRateLimit } = auth;

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
  matchmakingQueue: matchmaking.matchmakingQueue,
  handleJoinQueue: matchmaking.handleJoinQueue,
  handleLeaveQueue: matchmaking.handleLeaveQueue,
  removeFromQueue: matchmaking.removeFromQueue,
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
  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Credentials': 'false',
      'Access-Control-Max-Age': '600',
    });
    return res.end();
  }

  const url = req.url || '';
  // 标准化路径（去掉 query string，防止 ?v= 等参数导致路由匹配失败）
  const path = (() => { try { return new URL(url, 'http://localhost').pathname; } catch { return url.split('?')[0]; } })();
  const ip = getClientIP(req);

  // 旧统计端点
  if (path.startsWith('/stats')) {
    return jsonResponse(res, {
      connections: io.engine.clientsCount,
      rooms: roomManager.rooms.size,
      playing: Array.from(roomManager.rooms.values()).filter(r => r.started && !r.finished).length,
    });
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
      return await adminRoutes.handleRevokeToken(req, res, tid);
    }
    if (req.method === 'POST' && path === '/api/admin/announcements') return await adminRoutes.handleCreateAnnouncement(req, res);
    if (req.method === 'PUT' && path.startsWith('/api/admin/announcements/')) {
      const id = parseInt(path.split('/').pop(), 10);
      return await adminRoutes.handleUpdateAnnouncement(req, res, id);
    }
    if (req.method === 'DELETE' && path.startsWith('/api/admin/announcements/')) {
      const id = parseInt(path.split('/').pop(), 10);
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
    return jsonResponse(res, { error: '服务器内部错误' }, 500);
  }

  // 未匹配的路由
  return jsonResponse(res, { error: 'Not found' }, 404);
}

// ===== 统一周期清理（每分钟） =====
setInterval(() => {
  gameHandlers.runPeriodicCleanup();
  try { db.pragma('wal_checkpoint(PASSIVE)'); } catch {}
}, 60_000);

// ===== 启动服务器 =====
http.listen(PORT, () => console.log(`:${PORT}`));

// ===== 优雅关闭 =====
process.on('SIGTERM', () => {
  console.log('[shutdown] SIGTERM received, closing...');
  io.close();
  http.close(() => { db.close(); process.exit(0); });
});
process.on('SIGINT', () => {
  console.log('[shutdown] SIGINT received, closing...');
  io.close();
  http.close(() => { db.close(); process.exit(0); });
});
