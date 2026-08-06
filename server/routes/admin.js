// 管理员路由：announcements, users, guests, online, ban, nickname, deploy, version
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { sanitizeString, parseBody, jsonResponse, deriveGuestName } from '../utils.js';

// deploy 内存频率限制（简单防重放）
const deployRateMap = new Map();
function checkDeployRate(ip) {
  const now = Date.now();
  const entry = deployRateMap.get(ip);
  if (entry && now - entry < 60_000) return false;
  deployRateMap.set(ip, now);
  // 清理旧记录
  if (deployRateMap.size > 100) {
    for (const [k, t] of deployRateMap) { if (now - t > 120_000) deployRateMap.delete(k); }
  }
  return true;
}

export function registerAdminRoutes({ app, db, requireAdmin, checkNicknameProfanity, onlinePlayers, onlineSockets, socketIps, getUserIps, ONLINE_TIMEOUT, APP_VERSION }) {

  // ===== GET /api/announcements (公开) =====
  async function handleGetAnnouncements(req, res) {
    const rows = db.prepare('SELECT id, title, content, is_popup, created_at FROM announcements ORDER BY created_at DESC LIMIT 50').all();
    return jsonResponse(res, rows.map(r => ({
      id: r.id, title: r.title, content: r.content,
      is_popup: !!r.is_popup, created_at: r.created_at,
    })));
  }

  // ===== POST /api/admin/announcements =====
  async function handleCreateAnnouncement(req, res) {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await parseBody(req);
    const title = sanitizeString(body.title, 128);
    const content = sanitizeString(body.content, 10000);
    if (!title || !content) return jsonResponse(res, { error: '标题和内容不能为空' }, 400);
    const result = db.prepare('INSERT INTO announcements (title, content, is_popup) VALUES (?, ?, ?)').run(title, content, body.is_popup ? 1 : 0);
    return jsonResponse(res, { ok: true, id: result.lastInsertRowid });
  }

  // ===== DELETE /api/admin/announcements/:id =====
  async function handleDeleteAnnouncement(req, res, id) {
    const admin = requireAdmin(req, res); if (!admin) return;
    if (!id || id < 1) return jsonResponse(res, { error: '无效的公告ID' }, 400);
    const result = db.prepare('DELETE FROM announcements WHERE id = ?').run(id);
    if (result.changes === 0) return jsonResponse(res, { error: '公告不存在' }, 404);
    return jsonResponse(res, { ok: true });
  }

  // ===== GET /api/admin/users =====
  async function handleAdminUsers(req, res) {
    const admin = requireAdmin(req, res); if (!admin) return;
    const urlObj = new URL(req.url, 'http://localhost');
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

  // ===== PATCH /api/admin/users/:id/ban =====
  async function handleBanUser(req, res, userId, io) {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await parseBody(req);
    if (typeof body.banned !== 'boolean') return jsonResponse(res, { error: 'banned 字段必填 (boolean)' }, 400);

    if (body.banned && userId === admin.userId) {
      return jsonResponse(res, { error: '不能封禁自己' }, 400);
    }

    const user = db.prepare('SELECT id, player_key FROM users WHERE id = ?').get(userId);
    if (!user) return jsonResponse(res, { error: '用户不存在' }, 404);

    db.prepare('UPDATE users SET banned_at = ? WHERE id = ?').run(body.banned ? new Date().toISOString() : null, userId);

    if (body.banned) {
      // 收集被ban用户的所有活跃 IP（用于踢出同IP游客）
      const banIps = getUserIps ? getUserIps(userId) : new Set();
      // 清理在线状态
      if (user.player_key) {
        onlinePlayers.delete(user.player_key);
        onlineSockets.delete(user.player_key);
      }
      // 断开所有活跃 socket（包括同IP游客，防止换 pk 绕过）
      if (io) {
        for (const [sid, s] of io.sockets.sockets) {
          const sockIp = socketIps ? socketIps.get(sid) : null;
          if (s.data?.userId === userId || s.data?.playerKey === user.player_key) {
            s.disconnect(true);
          } else if (!s.data?.userId && sockIp && banIps.has(sockIp)) {
            // 同 IP 的游客 socket 一并断开（防止换 pk 绕过封禁）
            s.disconnect(true);
          }
        }
      }
    }

    return jsonResponse(res, { ok: true, id: userId, banned: body.banned });
  }

  // ===== PATCH /api/admin/users/:id/nickname =====
  async function handleAdminNickname(req, res, userId) {
    const admin = requireAdmin(req, res); if (!admin) return;
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

  // ===== GET /api/admin/guests =====
  async function handleAdminGuests(req, res) {
    const admin = requireAdmin(req, res); if (!admin) return;
    const urlObj = new URL(req.url, 'http://localhost');
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

  // ===== GET /api/admin/online =====
  async function handleAdminOnline(req, res) {
    const admin = requireAdmin(req, res); if (!admin) return;

    const now = Date.now();
    const result = { totalOnline: 0, inMultiplayer: 0, inSinglePlayer: 0, idle: 0, players: [] };

    for (const [pk, entry] of onlinePlayers) {
      const sockSet = onlineSockets.get(pk);
      if ((!sockSet || sockSet.size === 0) && now - entry.lastSeen > ONLINE_TIMEOUT) continue;

      result.totalOnline++;
      if (entry.type === 'multi') result.inMultiplayer++;
      else if (entry.type === 'single') result.inSinglePlayer++;
      else result.idle++;

      result.players.push({
        playerKey: pk.slice(0, 10),
        displayName: entry.displayName || deriveGuestName(pk),
        username: entry.username,
        type: entry.type,
        roomCode: entry.roomCode || null,
        lastSeen: new Date(entry.lastSeen).toISOString(),
      });
    }

    return jsonResponse(res, result);
  }

  // ===== GET /api/version =====
  async function handleVersion(req, res) {
    return jsonResponse(res, { version: APP_VERSION });
  }

  // ===== POST /api/deploy =====
  async function handleDeploy(req, res) {
    const ip = req.socket.remoteAddress || 'unknown';
    if (!checkDeployRate(ip)) {
      return jsonResponse(res, { error: '请求过于频繁，请稍后再试' }, 429);
    }
    const body = await parseBody(req);
    const DEPLOY_TOKEN = process.env.DEPLOY_TOKEN || '';
    if (!DEPLOY_TOKEN) {
      return jsonResponse(res, { error: 'DEPLOY_TOKEN not configured' }, 500);
    }
    const tokenBuf = Buffer.from(body.token || '');
    const expectedBuf = Buffer.from(DEPLOY_TOKEN);
    if (tokenBuf.length !== expectedBuf.length || !timingSafeEqual(tokenBuf, expectedBuf)) {
      return jsonResponse(res, { error: 'invalid token' }, 403);
    }
    jsonResponse(res, { ok: true, message: 'deploy triggered' });
    setTimeout(() => {
      spawn('bash', ['-c',
        'cd /opt/liyiba && echo "=== Deploy $(date -Iseconds) ===" >> deploy.log && BACKUP_FILE="data.db.bak-$(date +%Y%m%d-%H%M)" && sqlite3 data.db ".backup $BACKUP_FILE" && echo " Backup: $BACKUP_FILE" >> deploy.log && git fetch origin main >> deploy.log 2>&1 && git pull --ff-only origin main >> deploy.log 2>&1 && export PATH=$PATH:/root/.nvm/versions/node/v18.20.4/bin && npm install --production >> deploy.log 2>&1 && pm2 restart liyiba >> deploy.log 2>&1 && find /opt/liyiba -maxdepth 1 -name "data.db.bak-*" -mtime +7 -delete 2>/dev/null && echo "=== Deploy OK ===" >> deploy.log || echo "=== Deploy FAILED ===" >> deploy.log'
      ], { detached: true, stdio: 'ignore' }).unref();
    }, 500);
  }

  return {
    handleGetAnnouncements,
    handleCreateAnnouncement,
    handleDeleteAnnouncement,
    handleAdminUsers,
    handleBanUser,
    handleAdminNickname,
    handleAdminGuests,
    handleAdminOnline,
    handleVersion,
    handleDeploy,
  };
}
