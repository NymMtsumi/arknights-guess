// Socket.IO 初始化、身份中间件、在线追踪
import { Server } from 'socket.io';
import { parseCookies, deriveGuestName, getAllowedOrigins } from '../utils.js';

export function createSocketServer(http, { db, verifyToken, generateKey }) {
  const allowedOrigins = getAllowedOrigins();

  const io = new Server(http, {
    cors: { origin: allowedOrigins },
    pingInterval: 5000,
    pingTimeout: 15000,
  });

  // ===== 身份中间件 =====
  io.use((socket, next) => {
    // 优先使用 JWT token 进行身份认证（防止 pk 冒充）
    const authToken = socket.handshake.auth?.token;
    const cookies = parseCookies(socket.handshake.headers.cookie || '');
    const cookiePk = typeof cookies.player_key === 'string' && cookies.player_key.startsWith('p_') ? cookies.player_key : null;

    if (authToken && typeof authToken === 'string') {
      try {
        const decoded = verifyToken(authToken);
      if (decoded) {
        const user = db.prepare('SELECT id, username, nickname, player_key, banned_at, token_version FROM users WHERE id = ?').get(decoded.userId);
        if (user) {
          if (user.banned_at) return next(new Error('账号已被封禁'));
          // 验证 token_version：密码更改后旧 JWT 失效
          if ((decoded.tokenVersion || 0) !== (user.token_version || 0)) {
            return next(new Error('密码已更改，请重新登录'));
          }
          socket.data.userId = user.id;
          socket.data.username = user.username;
          socket.data.displayName = user.nickname || user.username;

          if (user.player_key) {
            socket.data.playerKey = user.player_key;
          } else {
            // 生成新 pk（使用条件 UPDATE 防并发：多 tab 同时连接时只有第一个成功）
            socket.data.playerKey = generateKey();
            const updRes = db.prepare('UPDATE users SET player_key = ? WHERE id = ? AND player_key IS NULL').run(socket.data.playerKey, user.id);
            if (updRes.changes === 0) {
              // 并发竞争：另一条连接先设置了 pk，重新读取
              const refreshed = db.prepare('SELECT player_key FROM users WHERE id = ?').get(user.id);
              if (refreshed?.player_key) socket.data.playerKey = refreshed.player_key;
            }
          }

          // 回填 cookie 游客 pk 的 ownerless 游戏 user_id（不改 player_key！防止战绩串乱）
          if (cookiePk && cookiePk !== socket.data.playerKey) {
            const conflict = db.prepare('SELECT id FROM users WHERE player_key = ? AND id != ?').get(cookiePk, user.id);
            if (!conflict) {
              const backfilled = db.prepare('UPDATE games SET user_id = ? WHERE player_key = ? AND user_id IS NULL').run(user.id, cookiePk);
              if (backfilled.changes > 0) {
                console.log(`[socket] backfilled user_id=${user.id} for ${backfilled.changes} games from cookie pk=${cookiePk.slice(0, 10)}`);
              }
            }
          }

          socket.data.identityKey = socket.data.playerKey;
          return next();
        }
      }
      } catch (err) {
        console.error('[socket] auth middleware JWT error:', err.message);
        // Fall through to cookie-based auth
      }
    }

    // 回退到 cookie/auth/URL player_key（游客或 JWT 不可用）
    const authPk = socket.handshake.auth?.pk;
    const urlPk = socket.handshake.query?.pk; // 兼容旧客户端（逐步废弃）
    if (cookies.player_key) {
      socket.data.playerKey = cookies.player_key;
    } else if (authPk && typeof authPk === 'string' && authPk.startsWith('p_')) {
      socket.data.playerKey = authPk;
    } else if (urlPk && typeof urlPk === 'string' && urlPk.startsWith('p_')) {
      socket.data.playerKey = urlPk;
    } else {
      socket.data.playerKey = generateKey();
      socket.emit('set_cookie', { name: 'player_key', value: socket.data.playerKey });
    }
    socket.data.identityKey = socket.data.playerKey;

    // 查询用户信息，检查封禁 + pk 冒充防护
    try {
      const userRow = db.prepare('SELECT id, username, nickname, banned_at FROM users WHERE player_key = ?').get(socket.data.playerKey);
      if (userRow?.banned_at) {
        return next(new Error('账号已被封禁'));
      }
      // P2 fix: pk 映射到注册用户但未提供 JWT → 拒绝（防冒充）
      if (userRow?.id && !socket.data.userId) {
        return next(new Error('请先登录'));
      }
      socket.data.userId = userRow?.id || null;
      socket.data.username = userRow?.username || null;
      socket.data.displayName = userRow?.nickname || userRow?.username || deriveGuestName(socket.data.playerKey);
    } catch { /* ignore */ }
    next();
  });

  // ===== 在线追踪数据结构 =====
  const onlinePlayers = new Map(); // playerKey → { playerKey, displayName, username, userId, type, roomCode, lastSeen }
  const onlineSockets = new Map(); // playerKey → Set<socketId>
  const socketIps = new Map();     // socketId → IP (用于封禁时追踪游客)
  const ONLINE_TIMEOUT = 90_000;

  // 记录 socket IP（穿过代理获取真实 IP）
  io.on('connection', (socket) => {
    const headers = socket.handshake.headers || {};
    const remoteAddr = socket.handshake.address || 'unknown';
    const isLocalProxy = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
    let ip;
    // 仅信任本地代理转发的头（与 getClientIP 保持一致）
    if (isLocalProxy) {
      ip = headers['x-real-ip'] || headers['cf-connecting-ip'] || headers['x-forwarded-for']?.split(',')[0]?.trim();
    }
    if (!ip) {
      ip = remoteAddr;
    }
    // 规范化 IPv6-mapped IPv4（无论来源都执行）
    ip = ip.replace(/^::ffff:/, '');
    socketIps.set(socket.id, ip);
    socket.on('disconnect', () => socketIps.delete(socket.id));
  });

  // 封禁辅助：获取指定 userId 的所有活跃 IP
  function getUserIps(userId) {
    const ips = new Set();
    for (const [sid, ip] of socketIps) {
      const sock = io.sockets.sockets.get(sid);
      if (sock && sock.data?.userId === userId) ips.add(ip);
    }
    return ips;
  }

  return { io, onlinePlayers, onlineSockets, socketIps, getUserIps, ONLINE_TIMEOUT };
}
