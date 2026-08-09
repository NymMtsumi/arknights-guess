// 游戏路由：save-game, leaderboard
import { sanitizeString, parseCookies, parseBody, jsonResponse, generateKey } from '../utils.js';
import { pickDailyTarget } from '../characters.js';

// 排行榜内存缓存（60s TTL，避免每次请求全表聚合扫描）
const leaderboardCache = new Map();

export function registerGameRoutes({ app, db, verifyToken, checkRateLimit, getClientIP }) {

  // ===== POST /api/save-game =====
  async function handleSaveGame(req, res) {
    const ip = getClientIP(req);
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

    let timestamp = body.timestamp;
    if (typeof timestamp === 'number') {
      if (timestamp <= 0 || !Number.isFinite(timestamp)) {
        timestamp = new Date().toISOString();
      } else if (timestamp < 1e11) {
        // 秒级时间戳 → 转换为毫秒
        try { timestamp = new Date(timestamp * 1000).toISOString(); } catch { timestamp = new Date().toISOString(); }
      } else if (timestamp <= 1e13) {
        // 毫秒级时间戳（1e12 ≈ 2001, 1e13 ≈ 2286）
        try { timestamp = new Date(timestamp).toISOString(); } catch { timestamp = new Date().toISOString(); }
      } else {
        timestamp = new Date().toISOString();
      }
    } else if (typeof timestamp !== 'string' || !timestamp) {
      timestamp = new Date().toISOString();
    }

    if (mode === 'multi') {
      if (difficulty !== 'multi') difficulty = 'multi';
    } else if (mode === 'daily') {
      // 每日挑战：固定 hard 难度
      difficulty = 'hard';
    } else if (!['easy', 'medium', 'hard'].includes(difficulty)) {
      return jsonResponse(res, { error: 'difficulty 必须是 easy、medium 或 hard' }, 400);
    }

    let newPlayerKey = null;
    if (!player_key) {
      const cookies = parseCookies(req.headers.cookie || '');
      if (cookies.player_key) {
        player_key = cookies.player_key;
      } else {
        player_key = generateKey();
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
    let userId = null;
    // 尝试解析 JWT（可能为 null、过期、或有效）
    const decoded = authHeader.startsWith('Bearer ') ? verifyToken(authHeader.slice(7)) : null;

    if (decoded) {
      // 全面鉴权检查（与 requireAuth 一致：token_version + banned_at）
      const user = db.prepare('SELECT player_key, banned_at, token_version FROM users WHERE id = ?').get(decoded.userId);
      if (!user) {
        // 用户已被删除 → 按未认证处理
      } else if (user.banned_at) {
        return jsonResponse(res, { error: '账号已被封禁' }, 403);
      } else if ((decoded.tokenVersion || 0) !== (user.token_version || 0)) {
        return jsonResponse(res, { error: '密码已更改，请重新登录' }, 401);
      } else {
        // 认证有效 → 使用 user_id 作为一级归属
        userId = decoded.userId;
        // 确保用户有 pk（生成或使用已有的）
        if (user.player_key) {
          player_key = user.player_key;
        } else {
          // 生成新 pk 并绑定到用户（不迁移旧 pk 的游戏！避免战绩串乱）
          const newPk = generateKey();
          const updRes = db.prepare('UPDATE users SET player_key = ? WHERE id = ? AND player_key IS NULL').run(newPk, decoded.userId);
          if (updRes.changes > 0) {
            player_key = newPk;
            newPlayerKey = player_key;
          } else {
            const refreshed = db.prepare('SELECT player_key FROM users WHERE id = ?').get(decoded.userId);
            player_key = refreshed?.player_key || player_key;
          }
        }
      }
    }

    // 未认证（无 token / token 无效 / 用户已删除）：拒绝写入已注册用户的 pk（防数据伪造）
    if (!userId) {
      const pkOwner = db.prepare('SELECT id FROM users WHERE player_key = ?').get(player_key);
      if (pkOwner) {
        return jsonResponse(res, { error: '请先登录' }, 401);
      }
    }

    let dailyDate = null;
    if (mode === 'daily') {
      // 计算当天 UTC 日期
      const now = new Date();
      dailyDate = now.toISOString().slice(0, 10); // 'YYYY-MM-DD'

      // 验证目标干员与服务器每日目标一致
      const expectedTarget = pickDailyTarget('hard');
      if (targetName !== expectedTarget.name) {
        console.log(`[daily-mismatch] raw.body.targetName=${JSON.stringify(body.targetName)} sanitized=${JSON.stringify(targetName)} len=${targetName.length} hex=${Buffer.from(targetName, 'utf8').toString('hex')} expected=${JSON.stringify(expectedTarget.name)} elen=${expectedTarget.name.length} ehex=${Buffer.from(expectedTarget.name, 'utf8').toString('hex')}`);
        return jsonResponse(res, { error: '每日目标不匹配，可能已跨日，请刷新重试' }, 400);
      }

      // 去重：每人每天只能提交一次
      if (userId) {
        const existing = db.prepare(
          'SELECT id FROM games WHERE user_id = ? AND daily_date = ?'
        ).get(userId, dailyDate);
        if (existing) {
          return jsonResponse(res, { error: '今日已挑战' }, 409);
        }
      } else {
        // 游客：按 player_key 去重
        const existing = db.prepare(
          'SELECT id FROM games WHERE player_key = ? AND daily_date = ? AND user_id IS NULL'
        ).get(player_key, dailyDate);
        if (existing) {
          return jsonResponse(res, { error: '今日已挑战' }, 409);
        }
      }
    }

    const result = db.prepare(
      'INSERT INTO games (player_key, user_id, won, guess_count, difficulty, target_name, timestamp, mode, daily_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(player_key, userId || null, won ? 1 : 0, guessCount, difficulty, targetName, timestamp, mode, dailyDate);

    const extraHeaders = {};
    if (newPlayerKey) {
      extraHeaders['Set-Cookie'] = `player_key=${newPlayerKey}; SameSite=Lax; Secure; Path=/; Max-Age=94608000; HttpOnly`;
    }

    // 清除排行榜缓存（新游戏可能影响排名）
    for (const key of leaderboardCache.keys()) {
      if (key.startsWith(mode + ':') || (mode === 'daily' && key.startsWith('daily:'))) leaderboardCache.delete(key);
    }

    console.log(`[save-game] pk=${player_key.slice(0, 10)} won=${won} guesses=${guessCount} mode=${mode} diff=${difficulty}`);
    return jsonResponse(res, { saved: true, id: result.lastInsertRowid, player_key: newPlayerKey || undefined }, 200, extraHeaders);
  }

  // ===== GET /api/leaderboard =====
  async function handleLeaderboard(req, res) {
    const urlObj = new URL(req.url, 'http://localhost');
    let limit = parseInt(urlObj.searchParams.get('limit')) || 50;
    const difficulty = sanitizeString(urlObj.searchParams.get('difficulty') || '', 20);
    let mode = sanitizeString(urlObj.searchParams.get('mode') || 'single', 10);

    if (limit < 1) limit = 1;
    if (limit > 100) limit = 100;
    if (!['single', 'multi'].includes(mode)) mode = 'single';

    // 内存缓存（60s TTL），避免每次请求全表聚合扫描
    const cacheKey = `${mode}:${difficulty || 'all'}:${limit}`;
    const cached = leaderboardCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 60_000) {
      return jsonResponse(res, { leaderboard: cached.data });
    }

    let query, params;
    if (difficulty && ['easy', 'medium', 'hard'].includes(difficulty)) {
      query = `
        SELECT u.username, u.display_id, u.nickname,
               SUM(g.won) as wins,
               COUNT(*) as totalGames,
               SUM(g.guess_count) as totalGuesses,
               ROUND(CAST(SUM(g.won) AS REAL) / CAST(COUNT(*) AS REAL) * 100, 1) as winRate
        FROM games g
        INNER JOIN users u ON u.id = g.user_id
        WHERE g.difficulty = ? AND g.mode = ?
        GROUP BY g.user_id
        ORDER BY wins DESC, winRate DESC
        LIMIT ?
      `;
      params = [difficulty, mode, limit];
    } else {
      query = `
        SELECT u.username, u.display_id, u.nickname,
               SUM(g.won) as wins,
               COUNT(*) as totalGames,
               SUM(g.guess_count) as totalGuesses,
               ROUND(CAST(SUM(g.won) AS REAL) / CAST(COUNT(*) AS REAL) * 100, 1) as winRate
        FROM games g
        INNER JOIN users u ON u.id = g.user_id
        WHERE g.mode = ?
        GROUP BY g.user_id
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
      // displayName 优先级：用户设置的昵称 > 注册用户名
      // 客户端 getDisplayName 使用相同优先级二次兜底
      displayName: row.nickname || row.username,
      wins: row.wins,
      totalGames: row.totalGames,
      totalGuesses: row.totalGuesses || 0,
      winRate: row.winRate,
    }));

    leaderboardCache.set(cacheKey, { data: leaderboard, at: Date.now() });
    // 清理过期缓存（超过 90s 的条目）
    if (leaderboardCache.size > 50) {
      const cutoff = Date.now() - 90_000;
      for (const [k, v] of leaderboardCache) { if (v.at < cutoff) leaderboardCache.delete(k); }
    }

    console.log(`[leaderboard] returned ${leaderboard.length} entries mode=${mode} diff=${difficulty || 'all'}`);
    return jsonResponse(res, { leaderboard });
  }

  // ===== GET /api/daily/status =====
  async function handleDailyStatus(req, res) {
    // 计算当天每日目标
    const target = pickDailyTarget('hard');
    const now = new Date();
    const dailyDate = now.toISOString().slice(0, 10);

    // 尝试解析用户身份
    const authHeader = req.headers.authorization || '';
    let userId = null;
    const decoded = authHeader.startsWith('Bearer ') ? verifyToken(authHeader.slice(7)) : null;
    if (decoded) {
      const user = db.prepare('SELECT id, banned_at, token_version FROM users WHERE id = ?').get(decoded.userId);
      if (user && !user.banned_at && (decoded.tokenVersion || 0) === (user.token_version || 0)) {
        userId = decoded.userId;
      }
    }

    // 查询今天是否已挑战
    let played = false;
    let result = null;
    if (userId) {
      const row = db.prepare(
        'SELECT won, guess_count, timestamp FROM games WHERE user_id = ? AND daily_date = ?'
      ).get(userId, dailyDate);
      if (row) {
        played = true;
        result = { won: row.won === 1, guessCount: row.guess_count, timestamp: row.timestamp };
      }
    }

    return jsonResponse(res, {
      date: dailyDate,
      targetId: target.id,
      targetName: target.name,
      played,
      result,
    });
  }

  // ===== GET /api/daily/leaderboard =====
  async function handleDailyLeaderboard(req, res) {
    const urlObj = new URL(req.url, 'http://localhost');
    let limit = parseInt(urlObj.searchParams.get('limit')) || 50;
    if (limit < 1) limit = 1;
    if (limit > 100) limit = 100;

    const now = new Date();
    const dailyDate = now.toISOString().slice(0, 10);

    // 内存缓存（60s TTL）
    const cacheKey = `daily:${dailyDate}:${limit}`;
    const cached = leaderboardCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 60_000) {
      return jsonResponse(res, { date: dailyDate, leaderboard: cached.data });
    }

    const rows = db.prepare(`
      SELECT u.username, u.nickname, g.guess_count, g.timestamp
      FROM games g
      INNER JOIN users u ON u.id = g.user_id
      WHERE g.mode = 'daily' AND g.daily_date = ? AND g.won = 1
      ORDER BY g.guess_count ASC, g.timestamp ASC
      LIMIT ?
    `).all(dailyDate, limit);

    const leaderboard = rows.map((row, idx) => ({
      rank: idx + 1,
      username: row.username,
      displayName: row.nickname || row.username,
      guessCount: row.guess_count,
      timestamp: row.timestamp,
    }));

    leaderboardCache.set(cacheKey, { data: leaderboard, at: Date.now() });
    // 定期清理过期缓存
    if (leaderboardCache.size > 50) {
      const cutoff = Date.now() - 90_000;
      for (const [k, v] of leaderboardCache) { if (v.at < cutoff) leaderboardCache.delete(k); }
    }

    console.log(`[daily-leaderboard] returned ${leaderboard.length} entries for ${dailyDate}`);
    return jsonResponse(res, { date: dailyDate, leaderboard });
  }

  return {
    handleSaveGame,
    handleLeaderboard,
    handleDailyStatus,
    handleDailyLeaderboard,
    // 昵称变更时清除排行榜缓存（避免改名后最多 60s 显示旧名）
    invalidateLeaderboardCache: () => leaderboardCache.clear(),
  };
}
