// 游戏路由：save-game, leaderboard
import { sanitizeString, parseCookies, parseBody, jsonResponse, generateKey } from '../utils.js';

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
    if (authHeader.startsWith('Bearer ')) {
      const decoded = verifyToken(authHeader.slice(7));
      if (decoded) {
        userId = decoded.userId;
        const user = db.prepare('SELECT player_key FROM users WHERE id = ?').get(decoded.userId);
        if (user && !user.player_key) {
          // 始终生成新 key，不复用客户端提供的 pk（防止多用户共享设备时数据归属错误）
          const newPk = generateKey();
          if (player_key && player_key.startsWith('p_')) {
            const pkConflict = db.prepare('SELECT id FROM users WHERE player_key = ? AND id != ?').get(player_key, decoded.userId);
            if (!pkConflict) {
              // 旧 pk 无人认领 → 迁移游戏记录
              db.prepare('UPDATE games SET player_key = ? WHERE player_key = ?').run(newPk, player_key);
            }
          }
          player_key = newPk;
          newPlayerKey = player_key;
          try { db.prepare('UPDATE users SET player_key = ? WHERE id = ?').run(player_key, decoded.userId); } catch {}
        } else if (user && user.player_key) {
          player_key = user.player_key;
        }
      }
    } else {
      // 未认证：拒绝写入已注册用户的 pk（防数据伪造）
      const pkOwner = db.prepare('SELECT id FROM users WHERE player_key = ?').get(player_key);
      if (pkOwner) {
        return jsonResponse(res, { error: '请先登录' }, 401);
      }
    }

    const result = db.prepare(
      'INSERT INTO games (player_key, won, guess_count, difficulty, target_name, timestamp, mode) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(player_key, won ? 1 : 0, guessCount, difficulty, targetName, timestamp, mode);

    const extraHeaders = {};
    if (newPlayerKey) {
      extraHeaders['Set-Cookie'] = `player_key=${newPlayerKey}; SameSite=Lax; Path=/; Max-Age=94608000; HttpOnly`;
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

    let query, params;
    if (difficulty && ['easy', 'medium', 'hard'].includes(difficulty)) {
      query = `
        SELECT g.player_key, u.username, u.display_id, u.nickname,
               SUM(g.won) as wins,
               COUNT(*) as totalGames,
               SUM(g.guess_count) as totalGuesses,
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
               SUM(g.guess_count) as totalGuesses,
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
      totalGuesses: row.totalGuesses || 0,
      winRate: row.winRate,
    }));

    console.log(`[leaderboard] returned ${leaderboard.length} entries mode=${mode} diff=${difficulty || 'all'}`);
    return jsonResponse(res, { leaderboard });
  }

  return {
    handleSaveGame,
    handleLeaderboard,
  };
}
