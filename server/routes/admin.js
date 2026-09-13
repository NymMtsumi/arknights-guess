// 管理员路由：announcements, users, guests, online, ban, nickname, deploy, version
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeString, parseBody, jsonResponse, deriveGuestName, parseLocale, getClientIP } from '../utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// 与 game-engine.js 的 CHARACTERS_PATH 同源同名（生产不设 → 与原来完全一致）。
// ⚠️ 两处必须指向同一个文件：这里写的是文件，那边读的是内存池，
//    指向不同文件会出现「写成功但游戏里没有」的假象。
//    冒烟测试设这个变量指向临时文件，避免改写 git 跟踪的 characters.json。
const CHARACTERS_PATH = process.env.CHARACTERS_PATH || join(__dirname, '..', 'characters.json');

// 转义 LIKE 通配符（防 % 和 _ 注入，使搜索按字面量匹配）
function escapeLike(str) {
  return str.replace(/[%_]/g, '\\$&');
}

/**
 * 列头排序解析。
 *
 * ⚠️ ORDER BY 的列名**无法参数化**（占位符只对值生效，对标识符无效），
 *    把用户传来的 sort 直接拼进 SQL 就是注入点。所以这里只认一张固定的
 *    白名单映射：请求里的 key 命中不了就整条回退到默认排序，绝不透传。
 *    方向同理，只认 'asc'/'desc' 两个字面量。
 *
 * 之所以做在服务端而不是前端：分页是「先排序再切页」，前端排序只能排到
 * 当前这一页的 30 行，把 5000 行里的 30 行排一下再标上「已排序」是**错的**，
 * 而且看不出错。排序键必须和分页、过滤在同一层。
 *
 * 另外统一补一个 id 兜底排序：created_at 大量重复（同秒批量写入）时，
 * 单键排序的行序在 SQLite 里是未定义的，翻页会出现重复行/漏行。
 */
function parseSort(urlObj, whitelist, defaultExpr) {
  const key = sanitizeString(urlObj.searchParams.get('sort') || '', 32);
  const dir = urlObj.searchParams.get('dir') === 'asc' ? 'ASC' : 'DESC';
  const expr = Object.prototype.hasOwnProperty.call(whitelist, key) ? whitelist[key] : null;
  return { expr: expr || defaultExpr, dir };
}

// deploy 内存频率限制（简单防重放）
const deployRateMap = new Map();
function checkDeployRate(ip) {
  const now = Date.now();
  const entry = deployRateMap.get(ip);
  if (entry && now - entry < 60_000) return false;
  deployRateMap.set(ip, now);
  // Always run cleanup to prevent unbounded growth (runs on every call, O(n) but
  // the map is small because entries older than 120s are evicted on each pass)
  for (const [k, t] of deployRateMap) { if (now - t > 120_000) deployRateMap.delete(k); }
  return true;
}

/* 导出 parseSort 仅供 tests/sort-whitelist-check.mjs 做注入回归。
   它是**唯一**把请求参数拼进 SQL 的地方，光靠读代码证明不了它挡得住。 */
export { parseSort };

export function registerAdminRoutes({ app, db, requireAdmin, checkNicknameProfanity, onlinePlayers, onlineSockets, socketIps, getUserIps, ONLINE_TIMEOUT, APP_VERSION, reloadCharacters, invalidateLeaderboardCache }) {

  const SERVER_START_TIME = Date.now();
  let _charactersCache = null; // 内存缓存，避免每次请求都读盘+JSON.parse

  function readCharacters() {
    if (_charactersCache) return _charactersCache;
    try {
      _charactersCache = JSON.parse(readFileSync(CHARACTERS_PATH, 'utf-8'));
      return _charactersCache;
    } catch (err) {
      console.error('[admin] Failed to read characters.json:', err.message);
      return null; // 读取失败返回 null，调用者应中止操作而非覆盖为空数组
    }
  }

  function writeCharacters(data) {
    // 原子写入：先写临时文件，再 rename（POSIX 保证原子性）
    const tmpPath = CHARACTERS_PATH + '.tmp.' + Date.now();
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    try {
      renameSync(tmpPath, CHARACTERS_PATH);
    } catch (e) {
      try { unlinkSync(tmpPath); } catch {}
      throw e;
    }
    // 更新内存缓存 + 通知游戏服务器重载角色池
    _charactersCache = data;
    if (reloadCharacters) {
      try { reloadCharacters(); } catch (err) { console.error('[admin] reloadCharacters failed:', err.message); }
    }
  }

  // 共享：计算当前在线人数
  function countOnline() {
    const now = Date.now();
    let count = 0;
    for (const [pk, entry] of onlinePlayers) {
      const sockSet = onlineSockets.get(pk);
      if ((!sockSet || sockSet.size === 0) && now - entry.lastSeen > ONLINE_TIMEOUT) continue;
      count++;
    }
    return count;
  }

  // ===== GET /api/admin/dashboard =====
  async function handleDashboard(req, res) {
    const admin = requireAdmin(req, res); if (!admin) return;

    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    // 范围查询代替 date() 函数，可利用 idx_users_created 索引
    const tomorrowStr = new Date(now.getTime() + 86400000).toISOString().slice(0, 10);

    const counts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM users) as totalUsers,
        (SELECT COUNT(*) FROM users WHERE created_at >= ? AND created_at < ?) as newUsersToday,
        (SELECT COUNT(*) FROM games) as totalGames
    `).get(todayStr, tomorrowStr);

    const onlineNow = countOnline();

    // 最近注册
    const recentUsers = db.prepare(
      'SELECT id, username, display_id, created_at FROM users ORDER BY created_at DESC LIMIT 5'
    ).all().map(u => ({
      id: u.id, username: u.username, displayId: u.display_id || '', createdAt: u.created_at,
    }));

    // 最近游戏（按 user_id 关联用户，不再依赖 player_key）
    const recentGames = db.prepare(`
      SELECT g.id, g.player_key, g.won, g.guess_count, g.difficulty, g.target_name, g.mode, g.timestamp,
             COALESCE(u.nickname, u.username) as playerName
      FROM games g LEFT JOIN users u ON u.id = g.user_id
      ORDER BY g.id DESC LIMIT 10
    `).all().map(g => ({
      id: g.id, playerKey: g.player_key?.slice(0, 10),
      // 未关联用户的游戏回退到游客名（而非 null）；语言取管理员的，因为读的人是管理员
      playerName: g.playerName || deriveGuestName(g.player_key || '', parseLocale(req.headers['accept-language'])),
      won: !!g.won, guessCount: g.guess_count, difficulty: g.difficulty,
      targetName: g.target_name, mode: g.mode || 'single', timestamp: g.timestamp,
    }));

    // 数据库大小 (通过 SQLite page_count 估算)
    let dbSize = 0;
    try {
      const pageCount = db.pragma('page_count');
      const pageSize = db.pragma('page_size');
      if (pageCount?.length && pageSize?.length) {
        dbSize = pageCount[0].page_count * pageSize[0].page_size;
      }
    } catch {}

    return jsonResponse(res, {
      totalUsers: counts.totalUsers,
      newUsersToday: counts.newUsersToday,
      totalGames: counts.totalGames,
      onlineNow,
      recentUsers,
      recentGames,
      dbSize: dbSize ? Math.round(dbSize / 1024) : 0, // KB
      uptime: Math.floor((now.getTime() - SERVER_START_TIME) / 1000),
      version: APP_VERSION,
    });
  }

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
    const result = db.prepare('INSERT INTO announcements (title, content, is_popup) VALUES (?, ?, ?)').run(title, content, body.is_popup === true ? 1 : 0);
    logAdminAction(admin.userId, 'create_announcement', 'announcement', result.lastInsertRowid, title, getClientIP(req));
    return jsonResponse(res, { ok: true, id: result.lastInsertRowid });
  }

  // ===== PUT /api/admin/announcements/:id =====
  async function handleUpdateAnnouncement(req, res, id) {
    const admin = requireAdmin(req, res); if (!admin) return;
    if (!id || id < 1) return jsonResponse(res, { error: '无效的公告ID' }, 400);
    const body = await parseBody(req);
    const title = sanitizeString(body.title, 128);
    const content = sanitizeString(body.content, 10000);
    if (!title && !content && typeof body.is_popup !== 'boolean') return jsonResponse(res, { error: '标题、内容或弹窗标志至少提供一个' }, 400);

    const existing = db.prepare('SELECT id FROM announcements WHERE id = ?').get(id);
    if (!existing) return jsonResponse(res, { error: '公告不存在' }, 404);

    const sets = [];
    const vals = [];
    if (title) { sets.push('title = ?'); vals.push(title); }
    if (content) { sets.push('content = ?'); vals.push(content); }
    if (typeof body.is_popup === 'boolean') { sets.push('is_popup = ?'); vals.push(body.is_popup ? 1 : 0); }
    vals.push(id);
    db.prepare(`UPDATE announcements SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    logAdminAction(admin.userId, 'update_announcement', 'announcement', id, title || content?.slice(0, 60), getClientIP(req));
    return jsonResponse(res, { ok: true });
  }

  // ===== DELETE /api/admin/announcements/:id =====
  async function handleDeleteAnnouncement(req, res, id) {
    const admin = requireAdmin(req, res); if (!admin) return;
    if (!id || id < 1) return jsonResponse(res, { error: '无效的公告ID' }, 400);
    const result = db.prepare('DELETE FROM announcements WHERE id = ?').run(id);
    if (result.changes === 0) return jsonResponse(res, { error: '公告不存在' }, 404);
    logAdminAction(admin.userId, 'delete_announcement', 'announcement', id, '', getClientIP(req));
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
      const escapedSearch = escapeLike(search);
      query += " AND (username LIKE ? ESCAPE '\\' OR display_id LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')";
      params.push(`%${escapedSearch}%`, `%${escapedSearch}%`, `%${escapedSearch}%`);
    }

    const countRow = db.prepare(`SELECT COUNT(*) as total FROM (${query})`).get(...params);
    const total = countRow.total;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const p = Math.min(page, totalPages);
    const { expr: orderExpr, dir: orderDir } = parseSort(urlObj, {
      username: 'username', email: 'email', role: 'role', created: 'created_at',
      banned: 'banned_at', verified: 'email_verified_at',
    }, 'created_at');
    const users = db.prepare(`${query} ORDER BY ${orderExpr} ${orderDir}, id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (p - 1) * pageSize);

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

    const user = db.prepare('SELECT id, username, player_key, role FROM users WHERE id = ?').get(userId);
    if (!user) return jsonResponse(res, { error: '用户不存在' }, 404);

    // 保护其他管理员：禁止封禁/解封管理员账号（防止单个被攻破的管理员锁死所有管理员）
    if (user.role === 'admin') {
      return jsonResponse(res, { error: '不能封禁或解封管理员账号' }, 403);
    }

    db.prepare('UPDATE users SET banned_at = ? WHERE id = ?').run(body.banned ? new Date().toISOString() : null, userId);
    logAdminAction(admin.userId, body.banned ? 'ban_user' : 'unban_user', 'user', userId, user.username, getClientIP(req));

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

    if (!newNickname) {
      return jsonResponse(res, { error: '昵称不能为空' }, 400);
    }

    const badWord = checkNicknameProfanity(newNickname);
    if (badWord) return jsonResponse(res, { error: `昵称包含违禁内容: ${badWord}` }, 400);

    const oldUser = db.prepare('SELECT id, nickname FROM users WHERE id = ?').get(userId);
    if (!oldUser) return jsonResponse(res, { error: '用户不存在' }, 404);
    const oldNickname = oldUser.nickname || '';

    db.prepare('UPDATE users SET nickname = ? WHERE id = ?').run(newNickname, userId);
    // 审计日志：记录旧昵称→新昵称（便于排查问题）
    logAdminAction(admin.userId, 'change_nickname', 'user', userId, `${oldNickname} → ${newNickname}`, getClientIP(req));

    // 昵称变更后清除排行榜缓存
    if (invalidateLeaderboardCache) invalidateLeaderboardCache();

    return jsonResponse(res, { ok: true, id: userId, nickname: newNickname });
  }

  // ===== PATCH /api/admin/users/:id/role =====
  async function handleAdminRole(req, res, userId) {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await parseBody(req);
    const role = sanitizeString(body.role, 16);
    if (!role || !['admin', 'user'].includes(role)) {
      return jsonResponse(res, { error: 'role 必须是 admin 或 user' }, 400);
    }

    if (userId === admin.userId) {
      return jsonResponse(res, { error: '不能修改自己的角色' }, 400);
    }

    const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(userId);
    if (!user) return jsonResponse(res, { error: '用户不存在' }, 404);

    // 保护其他管理员：禁止降级其他管理员（防止单个被攻破的管理员移除所有其他管理员）
    if (user.role === 'admin') {
      return jsonResponse(res, { error: '不能修改其他管理员的角色' }, 403);
    }

    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
    logAdminAction(admin.userId, 'change_role', 'user', userId, role, getClientIP(req));
    return jsonResponse(res, { ok: true, id: userId, role });
  }

  // ===== GET /api/admin/guests =====
  async function handleAdminGuests(req, res) {
    const admin = requireAdmin(req, res); if (!admin) return;
    const urlObj = new URL(req.url, 'http://localhost');
    const search = sanitizeString(urlObj.searchParams.get('search') || '', 64);
    const page = Math.max(1, parseInt(urlObj.searchParams.get('page')) || 1);
    const pageSize = Math.min(100, Math.max(10, parseInt(urlObj.searchParams.get('pageSize')) || 50));

    const escapedSearch = search ? escapeLike(search) : '';
    const whereClause = search ? "AND (g.player_key LIKE ? ESCAPE '\\' OR g.target_name LIKE ? ESCAPE '\\')" : '';
    const searchParams = search ? [`%${escapedSearch}%`, `%${escapedSearch}%`] : [];

    // 匿名用户 = user_id IS NULL（不再用 LEFT JOIN 技巧）
    const countQuery = `
      SELECT COUNT(DISTINCT g.player_key) as total
      FROM games g
      WHERE g.user_id IS NULL
      ${whereClause}
    `;
    const total = db.prepare(countQuery).get(...searchParams)?.total || 0;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const p = Math.min(page, totalPages);

    /* ⚠️ 可排序列刻意**不含玩家名**。显示的访客名是 deriveGuestName(player_key)
       在 JS 里算出来的，SQL 排不了；按 player_key 排出来的顺序和显示的名字顺序
       也对不上。给一个「点了没反应/顺序诡异」的排序按钮比不给更糟，所以这里的
       排序只开放真正有意义的三个数值/时间列。 */
    const { expr: orderExpr, dir: orderDir } = parseSort(urlObj, {
      playerKey: 'g.player_key', totalGames: 'totalGames', wins: 'wins', lastSeen: 'lastSeen',
    }, 'lastSeen');
    const dataQuery = `
      SELECT g.player_key, COUNT(*) as totalGames, SUM(g.won) as wins, MAX(g.timestamp) as lastSeen
      FROM games g
      WHERE g.user_id IS NULL
      ${whereClause}
      GROUP BY g.player_key ORDER BY ${orderExpr} ${orderDir}
      LIMIT ? OFFSET ?
    `;
    const guests = db.prepare(dataQuery).all(...searchParams, pageSize, (p - 1) * pageSize);

    return jsonResponse(res, {
      guests: guests.map(g => ({
        playerKey: g.player_key?.slice(0, 10),
        displayName: deriveGuestName(g.player_key, parseLocale(req.headers['accept-language'])),
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
      if ((!sockSet || sockSet.size === 0) && now - (entry.lastSeen || 0) > ONLINE_TIMEOUT) continue;

      result.totalOnline++;
      if (entry.type === 'multi') result.inMultiplayer++;
      else if (entry.type === 'single') result.inSinglePlayer++;
      else result.idle++;

      // 获取 IP（脱敏：仅保留前两段）— read from onlinePlayers.lastIp
      // stored during socket connection, avoiding O(sockets) iteration per request
      let maskedIp = '';
      const storedIp = entry.lastIp;
      if (storedIp) {
        const parts = storedIp.replace(/^::ffff:/, '').split('.');
        maskedIp = parts.length === 4 ? `${parts[0]}.${parts[1]}.*.*` : storedIp.slice(0, 6) + '...';
      }

      result.players.push({
        playerKey: pk.slice(0, 10),
        // entry.displayName 由该游客自己的心跳/socket 生成，语言可能与管理员的界面不同
        displayName: entry.displayName || deriveGuestName(pk, parseLocale(req.headers['accept-language'])),
        username: entry.username,
        type: entry.type,
        roomCode: entry.roomCode || null,
        ip: maskedIp || null,
        lastSeen: entry.lastSeen ? new Date(entry.lastSeen).toISOString() : new Date().toISOString(),
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
    // 先验证 token，避免未认证请求消耗 rate-limit 预算
    const body = await parseBody(req);
    const DEPLOY_TOKEN = process.env.DEPLOY_TOKEN || '';
    if (!DEPLOY_TOKEN) {
      return jsonResponse(res, { error: 'DEPLOY_TOKEN 未配置' }, 500);
    }
    if (typeof body.token !== 'string') {
      return jsonResponse(res, { error: '部署令牌无效' }, 403);
    }
    const tokenBuf = Buffer.from(body.token || '');
    const expectedBuf = Buffer.from(DEPLOY_TOKEN);
    if (tokenBuf.length !== expectedBuf.length || !timingSafeEqual(tokenBuf, expectedBuf)) {
      return jsonResponse(res, { error: '部署令牌无效' }, 403);
    }

    // 认证成功后再限流（使用真实客户端 IP）
    const ip = getClientIP(req) || req.socket.remoteAddress || 'unknown';
    if (!checkDeployRate(ip)) {
      return jsonResponse(res, { error: '请求过于频繁，请稍后再试' }, 429);
    }

    jsonResponse(res, { ok: true, message: 'deploy triggered' });
    // admin_id = 0 表示系统操作（users 表 id 从 1 开始，0 不会冲突）
    logAdminAction(0, 'deploy', 'system', null, 'webhook triggered', ip);

    // 部署流程已移至 server/deploy.sh，包含：
    // - 6 步结构化部署（备份→语法检查→fetch→pull→npm install→重启+健康检查）
    // - 逐步骤错误处理 + 详细日志（/opt/liyiba/deploy.log）
    // - 健康检查失败自动回滚（git reset --hard + pm2 restart）
    // - 备份由 cron 独立执行（server/backup-db.cjs），与部署解耦
    const deployLock = join(process.cwd(), '.deploy.lock');
    const deployScript = join(process.cwd(), 'server', 'deploy.sh');
    setTimeout(() => {
      spawn('bash', ['-c',
        `flock -n "${deployLock}" bash "${deployScript}" 2>&1 || echo "[deploy] flock: another deploy is in progress"`
      ], { detached: true, stdio: 'ignore' }).unref();
    }, 500);
  }

  // ===== Character Management =====

  // GET /api/admin/characters
  async function handleAdminCharacters(req, res) {
    const admin = requireAdmin(req, res); if (!admin) return;
    const urlObj = new URL(req.url, 'http://localhost');
    const search = sanitizeString(urlObj.searchParams.get('search') || '', 64);
    const rarityFilter = parseInt(urlObj.searchParams.get('rarity')) || 0;
    const page = Math.max(1, parseInt(urlObj.searchParams.get('page')) || 1);
    const pageSize = Math.min(100, Math.max(10, parseInt(urlObj.searchParams.get('pageSize')) || 30));

    let chars = readCharacters();
    if (!chars) return jsonResponse(res, { error: '干员数据读取失败' }, 500);
    if (search) {
      const s = search.toLowerCase();
      chars = chars.filter(c =>
        c.name?.toLowerCase().includes(s) ||
        c.nameEn?.toLowerCase().includes(s) ||
        (Array.isArray(c.tags) && c.tags.some(t => t.toLowerCase().includes(s)))
      );
    }
    if (rarityFilter >= 1 && rarityFilter <= 6) {
      chars = chars.filter(c => Number(c.rarity) === rarityFilter);
    }

    /* 干员数据来自内存里的 characters.json，不走 SQL —— 排序也得在 JS 里做。
       同样只认白名单，且同样必须**先排序再切页**（否则排的只是当前页）。 */
    const { expr: orderExpr, dir: orderDir } = parseSort(urlObj, {
      name: 'name', nameEn: 'nameEn', rarity: 'rarity',
    }, 'name');
    const sign = orderDir === 'ASC' ? 1 : -1;
    chars = [...chars].sort((a, b) => {
      const av = a[orderExpr], bv = b[orderExpr];
      // 星级按数值排，名字按本地化排 —— 都用字符串比较的话 ★10 会排在 ★2 前面
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av ?? '').localeCompare(String(bv ?? ''), 'zh-Hans-CN');
      return cmp * sign;
    });

    const total = chars.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const p = Math.min(page, totalPages);
    const start = (p - 1) * pageSize;
    const pageChars = chars.slice(start, start + pageSize);

    return jsonResponse(res, { characters: pageChars, total, page: p, pageSize, totalPages });
  }

  // POST /api/admin/characters
  async function handleCreateCharacter(req, res) {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await parseBody(req);
    const name = sanitizeString(body.name, 64);
    if (!name) return jsonResponse(res, { error: '干员名称不能为空' }, 400);
    const rarity = Math.min(6, Math.max(1, parseInt(body.rarity) || 1));

    // WARNING: characters.json is read-modify-written without a mutex. Concurrent
    // admin requests (create/update/delete/import) may race and lose writes.
    // This is acceptable for a low-traffic admin panel; if concurrent edits become
    // common, replace with a per-file lock or a proper DB table.
    const chars = readCharacters();
    if (!chars) return jsonResponse(res, { error: '干员数据读取失败' }, 500);
    if (chars.some(c => c.name === name)) {
      return jsonResponse(res, { error: '干员已存在' }, 409);
    }

    const newChar = {
      id: sanitizeString(body.id, 64) || `char_custom_${Date.now()}`,
      name,
      nameEn: sanitizeString(body.nameEn, 64) || name,
      class: sanitizeString(body.class, 32) || '未知',
      classEn: sanitizeString(body.classEn, 32) || 'Unknown',
      subclass: sanitizeString(body.subclass, 32) || '',
      subclassEn: sanitizeString(body.subclassEn, 32) || '',
      faction: sanitizeString(body.faction, 32) || '',
      factionEn: sanitizeString(body.factionEn, 32) || '',
      rarity,
      race: sanitizeString(body.race, 32) || '',
      raceEn: sanitizeString(body.raceEn, 32) || '',
      gender: sanitizeString(body.gender, 8) || '',
      genderEn: sanitizeString(body.genderEn, 16) || '',
      releaseYear: parseInt(body.releaseYear) || new Date().getFullYear(),
      tags: Array.isArray(body.tags) ? body.tags.map(t => sanitizeString(t, 32)).filter(Boolean) : [],
      alterBase: sanitizeString(body.alterBase, 64) || '',
      position: sanitizeString(body.position, 16) || '',
      positionEn: sanitizeString(body.positionEn, 16) || '',
      popularity: ['hot', 'normal', 'cold'].includes(body.popularity) ? body.popularity : 'normal',
    };

    chars.push(newChar);
    writeCharacters(chars);
    logAdminAction(admin.userId, 'create_character', 'character', null, name, getClientIP(req));
    return jsonResponse(res, { ok: true, character: newChar });
  }

  // PUT /api/admin/characters/:name
  async function handleUpdateCharacter(req, res, encodedName) {
    const admin = requireAdmin(req, res); if (!admin) return;
    let name;
    try { name = decodeURIComponent(encodedName); } catch {
      return jsonResponse(res, { error: '无效的干员名称' }, 400);
    }
    const body = await parseBody(req);

    const chars = readCharacters();
    if (!chars) return jsonResponse(res, { error: '干员数据读取失败' }, 500);
    const idx = chars.findIndex(c => c.name === name);
    if (idx === -1) return jsonResponse(res, { error: '干员不存在' }, 404);

    const existing = chars[idx];
    const updates = {};
    if (body.name !== undefined) {
      const newName = sanitizeString(body.name, 64) || existing.name;
      // 检查改名是否与已有干员冲突
      if (newName !== existing.name && chars.some(c => c.name === newName)) {
        return jsonResponse(res, { error: '干员名称已存在' }, 409);
      }
      updates.name = newName;
    }
    if (body.nameEn !== undefined) updates.nameEn = sanitizeString(body.nameEn, 64) || existing.nameEn;
    if (body.class !== undefined) updates.class = sanitizeString(body.class, 32);
    if (body.classEn !== undefined) updates.classEn = sanitizeString(body.classEn, 32);
    if (body.subclass !== undefined) updates.subclass = sanitizeString(body.subclass, 32);
    if (body.subclassEn !== undefined) updates.subclassEn = sanitizeString(body.subclassEn, 32);
    if (body.faction !== undefined) updates.faction = sanitizeString(body.faction, 32);
    if (body.factionEn !== undefined) updates.factionEn = sanitizeString(body.factionEn, 32);
    if (body.rarity !== undefined) updates.rarity = Math.min(6, Math.max(1, parseInt(body.rarity) || 1));
    if (body.race !== undefined) updates.race = sanitizeString(body.race, 32);
    if (body.raceEn !== undefined) updates.raceEn = sanitizeString(body.raceEn, 32);
    if (body.gender !== undefined) updates.gender = sanitizeString(body.gender, 8);
    if (body.genderEn !== undefined) updates.genderEn = sanitizeString(body.genderEn, 16);
    if (body.releaseYear !== undefined) updates.releaseYear = parseInt(body.releaseYear) || existing.releaseYear;
    if (body.tags !== undefined) updates.tags = Array.isArray(body.tags) ? body.tags.map(t => sanitizeString(t, 32)).filter(Boolean) : existing.tags;
    if (body.alterBase !== undefined) updates.alterBase = sanitizeString(body.alterBase, 64);
    if (body.position !== undefined) updates.position = sanitizeString(body.position, 16);
    if (body.positionEn !== undefined) updates.positionEn = sanitizeString(body.positionEn, 16);
    if (body.popularity !== undefined) updates.popularity = ['hot', 'normal', 'cold'].includes(body.popularity) ? body.popularity : existing.popularity;

    chars[idx] = { ...existing, ...updates };
    writeCharacters(chars);
    logAdminAction(admin.userId, 'update_character', 'character', null, name, getClientIP(req));
    return jsonResponse(res, { ok: true, character: chars[idx] });
  }

  // DELETE /api/admin/characters/:name
  async function handleDeleteCharacter(req, res, encodedName) {
    const admin = requireAdmin(req, res); if (!admin) return;
    let name;
    try { name = decodeURIComponent(encodedName); } catch {
      return jsonResponse(res, { error: '无效的干员名称' }, 400);
    }
    const chars = readCharacters();
    if (!chars) return jsonResponse(res, { error: '干员数据读取失败' }, 500);
    const idx = chars.findIndex(c => c.name === name);
    if (idx === -1) return jsonResponse(res, { error: '干员不存在' }, 404);
    chars.splice(idx, 1);
    writeCharacters(chars);
    logAdminAction(admin.userId, 'delete_character', 'character', null, name, getClientIP(req));
    return jsonResponse(res, { ok: true });
  }

  // POST /api/admin/characters/import
  async function handleImportCharacters(req, res) {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await parseBody(req);

    // 预览模式：返回变更摘要
    if (!body.confirm) {
      if (!Array.isArray(body.characters)) {
        return jsonResponse(res, { error: 'characters 必须是数组' }, 400);
      }
      const current = readCharacters();
      if (!current) return jsonResponse(res, { error: '干员数据读取失败' }, 500);
      const currentNames = new Set(current.map(c => c.name));
      let added = 0, updated = 0, skipped = 0;
      for (const c of body.characters) {
        if (!c.name) { skipped++; continue; }
        if (currentNames.has(c.name)) updated++;
        else added++;
      }
      return jsonResponse(res, {
        preview: true,
        total: body.characters.length,
        added,
        updated,
        skipped,
      });
    }

    // 确认写入
    if (!Array.isArray(body.characters)) {
      return jsonResponse(res, { error: 'characters 必须是数组' }, 400);
    }
    const current = readCharacters();
    if (!current) return jsonResponse(res, { error: '干员数据读取失败' }, 500);
    const nameIndex = new Map(current.map((c, i) => [c.name, i]));
    let actualImported = 0;
    const seenInBatch = new Set();

    for (const raw of body.characters) {
      if (!raw || !raw.name) continue;

      // Sanitize: same rules as create
      const c = {
        id: sanitizeString(raw.id || `char_import_${Date.now()}_${actualImported}`, 64),
        name: sanitizeString(raw.name, 64),
        nameEn: sanitizeString(raw.nameEn, 64) || sanitizeString(raw.name, 64),
        class: sanitizeString(raw.class, 32) || '未知',
        classEn: sanitizeString(raw.classEn, 32) || 'Unknown',
        subclass: sanitizeString(raw.subclass, 32) || '',
        subclassEn: sanitizeString(raw.subclassEn, 32) || '',
        faction: sanitizeString(raw.faction, 32) || '',
        factionEn: sanitizeString(raw.factionEn, 32) || '',
        rarity: Math.min(6, Math.max(1, parseInt(raw.rarity) || 1)),
        race: sanitizeString(raw.race, 32) || '',
        raceEn: sanitizeString(raw.raceEn, 32) || '',
        gender: sanitizeString(raw.gender, 8) || '',
        genderEn: sanitizeString(raw.genderEn, 16) || '',
        releaseYear: parseInt(raw.releaseYear) || new Date().getFullYear(),
        tags: Array.isArray(raw.tags) ? raw.tags.map(t => sanitizeString(t, 32)).filter(Boolean) : [],
        alterBase: sanitizeString(raw.alterBase, 64) || '',
        position: sanitizeString(raw.position, 16) || '',
        positionEn: sanitizeString(raw.positionEn, 16) || '',
        popularity: ['hot', 'normal', 'cold'].includes(raw.popularity) ? raw.popularity : 'normal',
      };

      // 批内去重：同一导入中同名以最后一条为准
      if (seenInBatch.has(c.name)) continue;
      seenInBatch.add(c.name);

      const existing = nameIndex.get(c.name);
      if (existing !== undefined) {
        current[existing] = { ...current[existing], ...c };
      } else {
        current.push(c);
      }
      actualImported++;
    }
    writeCharacters(current);
    logAdminAction(admin.userId, 'import_characters', 'character', null, `${actualImported} chars`, getClientIP(req));
    return jsonResponse(res, { ok: true, imported: actualImported });
  }

  // GET /api/admin/characters/export
  async function handleExportCharacters(req, res) {
    const admin = requireAdmin(req, res); if (!admin) return;
    const chars = readCharacters();
    if (!chars) return jsonResponse(res, { error: '干员数据读取失败' }, 500);
    return jsonResponse(res, chars);
  }

  // ===== API Token Management =====

  // POST /api/admin/tokens
  async function handleCreateToken(req, res) {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await parseBody(req);
    const name = sanitizeString(body.name, 64);
    if (!name) return jsonResponse(res, { error: '令牌名称不能为空' }, 400);

    const token = 'atk_' + randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    /* 存真实前缀，供列表页辨认「这条记录是哪个令牌」。
       只存前 12 位（atk_ + 8 位十六进制 = 32 bit）：明文只出现一次，
       哈希不可逆，所以**不存前缀就永远无法把列表行和手里的令牌对上**。
       余下 224 bit 熵足够，泄露这 12 位不构成风险。 */
    const tokenPrefix = token.slice(0, 12);

    db.prepare('INSERT INTO api_tokens (name, token_hash, token_prefix, created_by) VALUES (?, ?, ?, ?)').run(name, tokenHash, tokenPrefix, admin.userId);
    logAdminAction(admin.userId, 'create_token', 'api_token', null, name, getClientIP(req));
    return jsonResponse(res, { ok: true, token, name }); // 完整 token 仅返回一次
  }

  // GET /api/admin/tokens
  async function handleListTokens(req, res) {
    const admin = requireAdmin(req, res); if (!admin) return;
    const tokens = db.prepare(`
      SELECT t.id, t.name, t.token_prefix, t.created_at, t.last_used_at, t.revoked_at,
             u.username as created_by_name
      FROM api_tokens t LEFT JOIN users u ON u.id = t.created_by
      ORDER BY t.created_at DESC
    `).all().map(t => ({
      id: t.id,
      name: t.name,
      /* 迁移前创建的令牌没有存前缀，返回 null 让前端显示「旧令牌」而不是
         编一个看起来像前缀的假值 —— 假前缀比没前缀更糟，管理员会拿它去比对。 */
      prefix: t.token_prefix || null,
      createdBy: t.created_by_name,
      createdAt: t.created_at,
      lastUsedAt: t.last_used_at,
      revoked: !!t.revoked_at,
    }));
    return jsonResponse(res, { tokens, total: tokens.length });
  }

  // DELETE /api/admin/tokens/:id
  async function handleRevokeToken(req, res, id) {
    const admin = requireAdmin(req, res); if (!admin) return;
    if (!id || id < 1) return jsonResponse(res, { error: '无效的令牌ID' }, 400);
    const result = db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(new Date().toISOString(), id);
    if (result.changes === 0) return jsonResponse(res, { error: '令牌不存在或已被吊销' }, 404);
    logAdminAction(admin.userId, 'revoke_token', 'api_token', id, '', getClientIP(req));
    return jsonResponse(res, { ok: true });
  }

  // ===== Audit Log =====

  function logAdminAction(adminId, action, targetType, targetId, detail, ip) {
    try {
      db.prepare('INSERT INTO admin_actions (admin_id, action, target_type, target_id, detail, ip) VALUES (?, ?, ?, ?, ?, ?)').run(
        adminId, action, targetType || null, targetId ? String(targetId) : null, detail || null, ip || null
      );
    } catch (err) { console.error('[audit] log error:', err.message); }
  }

  // GET /api/admin/audit-log
  async function handleAuditLog(req, res) {
    const admin = requireAdmin(req, res); if (!admin) return;
    const urlObj = new URL(req.url, 'http://localhost');
    const actionFilter = sanitizeString(urlObj.searchParams.get('action') || '', 32);
    const page = Math.max(1, parseInt(urlObj.searchParams.get('page')) || 1);
    const pageSize = Math.min(100, Math.max(10, parseInt(urlObj.searchParams.get('pageSize')) || 30));

    let query = `
      SELECT a.id, a.action, a.target_type, a.target_id, a.detail, a.ip, a.created_at,
             COALESCE(u.nickname, u.username) as admin_name
      FROM admin_actions a LEFT JOIN users u ON u.id = a.admin_id
      WHERE 1=1
    `;
    const params = [];
    if (actionFilter) { query += ' AND a.action = ?'; params.push(actionFilter); }

    const countRow = db.prepare(`SELECT COUNT(*) as total FROM (${query})`).get(...params);
    const total = countRow.total;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const p = Math.min(page, totalPages);
    const { expr: orderExpr, dir: orderDir } = parseSort(urlObj, {
      action: 'a.action', created: 'a.id', actor: 'admin_name', ip: 'a.ip',
    }, 'a.id');
    const rows = db.prepare(`${query} ORDER BY ${orderExpr} ${orderDir}, a.id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (p - 1) * pageSize);

    return jsonResponse(res, {
      logs: rows.map(r => ({
        id: r.id,
        adminName: r.admin_name || 'System',
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        detail: r.detail,
        ip: r.ip,
        createdAt: r.created_at,
      })),
      total, page: p, pageSize, totalPages,
    });
  }

  return {
    handleDashboard,
    handleAdminCharacters,
    handleCreateCharacter,
    handleUpdateCharacter,
    handleDeleteCharacter,
    handleImportCharacters,
    handleExportCharacters,
    handleCreateToken,
    handleListTokens,
    handleRevokeToken,
    handleAuditLog,
    handleGetAnnouncements,
    handleCreateAnnouncement,
    handleUpdateAnnouncement,
    handleDeleteAnnouncement,
    handleAdminUsers,
    handleBanUser,
    handleAdminRole,
    handleAdminNickname,
    handleAdminGuests,
    handleAdminOnline,
    handleVersion,
    handleDeploy,
  };
}
