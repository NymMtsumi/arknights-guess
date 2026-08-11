// 敌方单位猜谜路由：save-game, leaderboard, daily
import { sanitizeString, parseCookies, parseBody, jsonResponse, generateKey, normalizeTimestamp } from '../utils.js';
import { pickDailyEnemy } from '../enemy-engine.js';
import { getEnemyDb } from '../enemy-db.js';

const leaderboardCache = new Map();

export function registerEnemyRoutes({ app, db, verifyToken, checkRateLimit, getClientIP }) {
  const enemyDb = getEnemyDb();

  // ===== POST /api/enemy/save-game =====
  async function handleEnemySaveGame(req, res) {
    const ip = getClientIP(req);
    if (!checkRateLimit(`esave:${ip}`, 30, 60_000)) {
      return jsonResponse(res, { error: '请求过于频繁，请稍后再试' }, 429);
    }

    const body = await parseBody(req);
    let player_key = typeof body.player_key === 'string' ? body.player_key.trim() : '';
    const won = body.won;
    const guessCount = typeof body.guessCount === 'number' ? body.guessCount : -1;
    const mode = sanitizeString(body.mode || 'enemy_single', 15);
    let difficulty = sanitizeString(body.difficulty || 'hard', 10);
    const targetName = sanitizeString(body.targetName || '', 100);

    if (!['enemy_single', 'enemy_daily'].includes(mode)) {
      return jsonResponse(res, { error: 'mode 必须是 enemy_single 或 enemy_daily' }, 400);
    }

    let timestamp = normalizeTimestamp(body.timestamp);

    if (mode === 'enemy_daily') {
      difficulty = 'hard';
    } else if (!['easy', 'normal', 'hard'].includes(difficulty)) {
      return jsonResponse(res, { error: 'difficulty 必须是 easy、normal 或 hard' }, 400);
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
    if (won && guessCount < 1) {
      return jsonResponse(res, { error: '获胜时 guessCount 至少为 1' }, 400);
    }
    if (guessCount > 50) {
      return jsonResponse(res, { error: 'guessCount 超出合理范围' }, 400);
    }

    const authHeader = req.headers.authorization || '';
    let userId = null;
    const decoded = authHeader.startsWith('Bearer ') ? verifyToken(authHeader.slice(7)) : null;

    if (decoded) {
      const user = db.prepare('SELECT player_key, banned_at, token_version FROM users WHERE id = ?').get(decoded.userId);
      if (!user) {
        // 用户已删除 → 按未认证处理
      } else if (user.banned_at) {
        return jsonResponse(res, { error: '账号已被封禁' }, 403);
      } else if ((decoded.tokenVersion || 0) !== (user.token_version || 0)) {
        return jsonResponse(res, { error: '密码已更改，请重新登录' }, 401);
      } else {
        userId = decoded.userId;
        if (user.player_key) {
          player_key = user.player_key;
        } else {
          const newPk = generateKey();
          db.prepare('UPDATE users SET player_key = ? WHERE id = ? AND player_key IS NULL').run(newPk, decoded.userId);
          player_key = newPk;
          newPlayerKey = player_key;
        }
      }
    }

    if (!userId) {
      const pkOwner = db.prepare('SELECT id FROM users WHERE player_key = ?').get(player_key);
      if (pkOwner) {
        return jsonResponse(res, { error: '请先登录' }, 401);
      }
    }

    let dailyDate = null;
    if (mode === 'enemy_daily') {
      const now = new Date();
      dailyDate = now.toISOString().slice(0, 10);
      timestamp = now.toISOString();

      const expectedTarget = pickDailyEnemy('hard');
      if (targetName !== expectedTarget.name) {
        return jsonResponse(res, { error: '每日目标不匹配，可能已跨日，请刷新重试' }, 400);
      }

      if (guessCount < 1 || guessCount > 15) {
        return jsonResponse(res, { error: 'guessCount 必须在 1-15 之间' }, 400);
      }
    }

    // 每日模式：事务中去重 + 写入
    let result;
    if (mode === 'enemy_daily') {
      const txnResult = enemyDb.transaction(() => {
        if (userId) {
          const existing = enemyDb.prepare(
            'SELECT id FROM enemy_games WHERE user_id = ? AND daily_date = ?'
          ).get(userId, dailyDate);
          if (existing) return { conflict: true };
        } else {
          const existing = enemyDb.prepare(
            'SELECT id FROM enemy_games WHERE player_key = ? AND daily_date = ? AND user_id IS NULL'
          ).get(player_key, dailyDate);
          if (existing) return { conflict: true };
        }

        return enemyDb.prepare(
          'INSERT INTO enemy_games (player_key, user_id, won, guess_count, difficulty, target_name, timestamp, mode, daily_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(player_key, userId || null, won ? 1 : 0, guessCount, difficulty, targetName, timestamp, mode, dailyDate);
      })();

      if (txnResult.conflict) {
        return jsonResponse(res, { error: '今日已挑战' }, 409);
      }
      result = txnResult;
    } else {
      try {
        result = enemyDb.prepare(
          'INSERT INTO enemy_games (player_key, user_id, won, guess_count, difficulty, target_name, timestamp, mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(player_key, userId || null, won ? 1 : 0, guessCount, difficulty, targetName, timestamp, mode);
      } catch (e) {
        throw e;
      }
    }

    const extraHeaders = {};
    if (newPlayerKey) {
      extraHeaders['Set-Cookie'] = `player_key=${newPlayerKey}; SameSite=Lax; Secure; Path=/; Max-Age=94608000; HttpOnly`;
    }

    for (const key of leaderboardCache.keys()) {
      if (key.startsWith(mode + ':')) leaderboardCache.delete(key);
    }

    console.log(`[enemy-save] pk=${player_key.slice(0, 10)} won=${won} guesses=${guessCount} mode=${mode} diff=${difficulty}`);
    return jsonResponse(res, { saved: true, id: result.lastInsertRowid, player_key: newPlayerKey || undefined }, 200, extraHeaders);
  }

  // ===== GET /api/enemy/status =====
  async function handleEnemyStatus(req, res) {
    const ip = getClientIP(req);
    if (!checkRateLimit(`estatus:${ip}`, 30, 60_000)) {
      return jsonResponse(res, { error: '请求过于频繁，请稍后再试' }, 429);
    }

    const target = pickDailyEnemy('hard');
    const now = new Date();
    const dailyDate = now.toISOString().slice(0, 10);

    const authHeader = req.headers.authorization || '';
    let userId = null;
    const decoded = authHeader.startsWith('Bearer ') ? verifyToken(authHeader.slice(7)) : null;
    if (decoded) {
      const user = db.prepare('SELECT id, banned_at, token_version FROM users WHERE id = ?').get(decoded.userId);
      if (user && !user.banned_at && (decoded.tokenVersion || 0) === (user.token_version || 0)) {
        userId = decoded.userId;
      }
    }

    let played = false;
    let result = null;
    if (userId) {
      const row = enemyDb.prepare(
        'SELECT won, guess_count, timestamp FROM enemy_games WHERE user_id = ? AND daily_date = ?'
      ).get(userId, dailyDate);
      if (row) {
        played = true;
        result = { won: row.won === 1, guessCount: row.guess_count, timestamp: row.timestamp };
      }
    } else {
      const cookies = parseCookies(req.headers.cookie || '');
      const pk = cookies.player_key || sanitizeString(req.headers['x-player-key'] || '', 64);
      if (pk) {
        const row = enemyDb.prepare(
          'SELECT won, guess_count, timestamp FROM enemy_games WHERE player_key = ? AND daily_date = ? AND user_id IS NULL'
        ).get(pk, dailyDate);
        if (row) {
          played = true;
          result = { won: row.won === 1, guessCount: row.guess_count, timestamp: row.timestamp };
        }
      }
    }

    return jsonResponse(res, {
      date: dailyDate,
      played,
      targetId: target.id,
      targetName: target.name,
      ...(result ? { result } : {}),
    });
  }

  // ===== GET /api/enemy/leaderboard =====
  async function handleEnemyLeaderboard(req, res) {
    const ip = getClientIP(req);
    if (!checkRateLimit(`elb:${ip}`, 30, 60_000)) {
      return jsonResponse(res, { error: '请求过于频繁，请稍后再试' }, 429);
    }
    const urlObj = new URL(req.url, 'http://localhost');
    let limit = parseInt(urlObj.searchParams.get('limit')) || 50;
    const difficulty = sanitizeString(urlObj.searchParams.get('difficulty') || '', 10);
    let mode = sanitizeString(urlObj.searchParams.get('mode') || 'enemy_single', 15);

    if (limit < 1) limit = 1;
    if (limit > 100) limit = 100;
    if (!['enemy_single'].includes(mode)) mode = 'enemy_single';

    const cacheKey = `enemy_single:${difficulty || 'all'}:${limit}`;
    const cached = leaderboardCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 60_000) {
      return jsonResponse(res, { leaderboard: cached.data });
    }

    let query, params;
    if (difficulty && ['easy', 'normal', 'hard'].includes(difficulty)) {
      query = `
        SELECT u.username, u.nickname,
               SUM(g.won) as wins,
               COUNT(*) as totalGames,
               SUM(g.guess_count) as totalGuesses,
               ROUND(CAST(SUM(g.won) AS REAL) / CAST(COUNT(*) AS REAL) * 100, 1) as winRate
        FROM enemy_games g
        LEFT JOIN users u ON u.id = g.user_id
        WHERE g.difficulty = ? AND g.mode = 'enemy_single'
        GROUP BY g.user_id
        ORDER BY wins DESC, winRate DESC
        LIMIT ?
      `;
      params = [difficulty, limit];
    } else {
      query = `
        SELECT u.username, u.nickname,
               SUM(g.won) as wins,
               COUNT(*) as totalGames,
               SUM(g.guess_count) as totalGuesses,
               ROUND(CAST(SUM(g.won) AS REAL) / CAST(COUNT(*) AS REAL) * 100, 1) as winRate
        FROM enemy_games g
        LEFT JOIN users u ON u.id = g.user_id
        WHERE g.mode = 'enemy_single'
        GROUP BY g.user_id
        ORDER BY wins DESC, winRate DESC
        LIMIT ?
      `;
      params = [limit];
    }

    const rows = enemyDb.prepare(query).all(...params);
    const leaderboard = rows.map((row, idx) => ({
      rank: idx + 1,
      username: row.username || '游客',
      displayName: row.nickname || row.username || '游客',
      wins: row.wins,
      totalGames: row.totalGames,
      totalGuesses: row.totalGuesses || 0,
      winRate: row.winRate,
    }));

    leaderboardCache.set(cacheKey, { data: leaderboard, at: Date.now() });
    return jsonResponse(res, { leaderboard });
  }

  // ===== GET /api/enemy/daily/leaderboard =====
  async function handleEnemyDailyLeaderboard(req, res) {
    const ip = getClientIP(req);
    if (!checkRateLimit(`edlb:${ip}`, 30, 60_000)) {
      return jsonResponse(res, { error: '请求过于频繁，请稍后再试' }, 429);
    }

    const urlObj = new URL(req.url, 'http://localhost');
    let limit = parseInt(urlObj.searchParams.get('limit')) || 50;
    if (limit < 1) limit = 1;
    if (limit > 100) limit = 100;

    const now = new Date();
    const dailyDate = now.toISOString().slice(0, 10);

    const cacheKey = `enemy_daily:${dailyDate}:${limit}`;
    const cached = leaderboardCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 60_000) {
      return jsonResponse(res, { date: dailyDate, leaderboard: cached.data });
    }

    const rows = enemyDb.prepare(`
      SELECT u.username, u.nickname, g.guess_count, g.timestamp
      FROM enemy_games g
      LEFT JOIN users u ON u.id = g.user_id
      WHERE g.mode = 'enemy_daily' AND g.daily_date = ? AND g.won = 1
      ORDER BY g.guess_count ASC, g.timestamp ASC
      LIMIT ?
    `).all(dailyDate, limit);

    const leaderboard = rows.map((row, idx) => ({
      rank: idx + 1,
      username: row.username || '游客',
      displayName: row.nickname || row.username || '游客',
      guessCount: row.guess_count,
      timestamp: row.timestamp,
    }));

    leaderboardCache.set(cacheKey, { data: leaderboard, at: Date.now() });
    return jsonResponse(res, { date: dailyDate, leaderboard });
  }

  return {
    handleEnemySaveGame,
    handleEnemyStatus,
    handleEnemyLeaderboard,
    handleEnemyDailyLeaderboard,
  };
}
