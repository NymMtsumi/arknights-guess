// Socket.IO 初始化、身份中间件、在线追踪
import { Server } from 'socket.io';
import { parseCookies, deriveGuestName } from '../utils.js';

export function createSocketServer(http, { db, verifyToken, generateKey }) {
  const io = new Server(http, {
    cors: { origin: '*' },
    pingInterval: 5000,
    pingTimeout: 15000,
  });

  // ===== 身份中间件 =====
  io.use((socket, next) => {
    // 优先使用 JWT token 进行身份认证（防止 pk 冒充）
    const authToken = socket.handshake.auth?.token;
    if (authToken && typeof authToken === 'string') {
      const decoded = verifyToken(authToken);
      if (decoded) {
        const user = db.prepare('SELECT id, username, nickname, player_key, banned_at, token_version FROM users WHERE id = ?').get(decoded.userId);
        if (user) {
          if (user.banned_at) return next(new Error('账号已被封禁'));
          // 验证 token_version：密码更改后旧 JWT 失效
          if (typeof decoded.tokenVersion === 'number' && decoded.tokenVersion !== (user.token_version || 0)) {
            return next(new Error('密码已更改，请重新登录'));
          }
          socket.data.userId = user.id;
          socket.data.username = user.username;
          socket.data.displayName = user.nickname || user.username;
          socket.data.playerKey = user.player_key || generateKey();
          if (!user.player_key) {
            try { db.prepare('UPDATE users SET player_key = ? WHERE id = ?').run(socket.data.playerKey, user.id); } catch {}
          }
          socket.data.identityKey = socket.data.playerKey;
          return next();
        }
      }
    }

    // 回退到 cookie/URL player_key（游客或 JWT 不可用）
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

  // 记录 socket IP（在 connection 事件中调用）
  io.on('connection', (socket) => {
    const ip = socket.handshake.address || 'unknown';
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
