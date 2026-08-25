// 游戏路由：save-game, leaderboard, daily
import { sanitizeString, parseCookies, parseBody, jsonResponse, generateKey, normalizeTimestamp } from '../utils.js';
import { pickDailyTarget } from '../characters.js';
import { findCharByName, compareGuess, isWin } from '../game-engine.js';
import { ATTR_KEYS, ROUND_TIME_PRESETS } from '../constants.js';

// 排行榜内存缓存（60s TTL，避免每次请求全表聚合扫描）
const leaderboardCache = new Map();

// 每日挑战会话（内存中跟踪猜测状态）
// key: `${userId || playerKey}:${dailyDate}`
const dailySessions = new Map();
const DAILY_MAX_GUESSES = 8;
const SESSION_TTL = 3600_000; // 1 小时后清理

// 定期清理过期会话
setInterval(() => {
  const now = Date.now();
  for (const [key, sess] of dailySessions) {
    if (now - sess.startedAt > SESSION_TTL) dailySessions.delete(key);
  }
}, 300_000); // 每 5 分钟

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
    const guessCount = Number.isInteger(body.guessCount) ? body.guessCount : -1;
    const mode = sanitizeString(body.mode || 'single', 10);
    let difficulty = sanitizeString(body.difficulty || 'hard', 20);
    const targetName = sanitizeString(body.targetName || '', 100);

    // 每日挑战走独立端点 /api/daily/guess（服务端追踪并校验猜测序列），
    // save-game 不接收 daily 存档，防止伪造每日排行榜
    if (mode === 'daily') {
      return jsonResponse(res, { error: '每日挑战请通过 /api/daily/guess 提交' }, 400);
    }

    // 验证 mode 合法性
    if (!['single', 'multi', 'custom'].includes(mode)) {
      return jsonResponse(res, { error: 'mode 必须是 single、multi 或 custom' }, 400);
    }

    let timestamp = normalizeTimestamp(body.timestamp);

    // 多人/自定义模式额外数据（BO 格式、比分、小局详情、房间配置）
    // 白名单字段提取 + 清洗（防存储型 XSS / 超大 JSON 灌库）
    let multiData = null;
    if ((mode === 'multi' || mode === 'custom') && body.multiData && typeof body.multiData === 'object') {
      const md = body.multiData;
      const clean = {
        bestOf: Number.isInteger(md.bestOf) && md.bestOf >= 1 && md.bestOf <= 7 ? md.bestOf : 0,
        myScore: Number.isInteger(md.myScore) && md.myScore >= 0 ? md.myScore : 0,
        opponentScore: Number.isInteger(md.opponentScore) && md.opponentScore >= 0 ? md.opponentScore : 0,
        // 剥离 HTML 标签（防存储型 XSS 注入；前端 React 文本渲染已二次转义，此处为纵深防御）
        opponentName: sanitizeString(typeof md.opponentName === 'string' ? md.opponentName.replace(/<[^>]*>/g, '') : '', 40),
      };
      if (Array.isArray(md.rounds)) {
        clean.rounds = md.rounds.slice(0, 60).map(r => ({
          won: !!r?.won,
          guessCount: Number.isInteger(r?.guessCount) && r.guessCount >= 0 ? r.guessCount : 0,
        }));
      }
      if (mode === 'custom') {
        if (Array.isArray(md.attributes)) {
          clean.attributes = [...new Set(md.attributes.filter(a => typeof a === 'string' && ATTR_KEYS.includes(a)))];
        }
        clean.maxGuesses = Number.isInteger(md.maxGuesses) && md.maxGuesses >= 1 && md.maxGuesses <= 15 ? md.maxGuesses : 8;
        clean.roundTime = ROUND_TIME_PRESETS.includes(md.roundTime) ? md.roundTime : 120000;
        clean.difficulty = ['easy', 'medium', 'hard'].includes(md.difficulty) ? md.difficulty : 'hard';
      }
      const serialized = JSON.stringify(clean);
      if (serialized.length <= 16384) multiData = serialized; // 超过 16KB 丢弃
    }

    if (mode === 'multi') {
      if (difficulty !== 'multi') difficulty = 'multi';
    } else if (mode === 'custom') {
      // 自定义房：难度仅影响题库，校验为 easy|medium|hard（同单人）
      if (!['easy', 'medium', 'hard'].includes(difficulty)) {
        return jsonResponse(res, { error: 'difficulty 必须是 easy、medium 或 hard' }, 400);
      }
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
    // 赢了不可能 0 次猜测（单人）；多人/自定义允许 0 次（对手断线直接判负）
    if (won && guessCount < 1 && mode === 'single') {
      return jsonResponse(res, { error: '获胜时 guessCount 至少为 1' }, 400);
    }
    // 自定义房最多 15 次 × 7 小局 = 105，多人 BO7 也可能超过 50，放宽上限
    if (guessCount > 200) {
      return jsonResponse(res, { error: 'guessCount 超出合理范围' }, 400);
    }

    // 单人模式：校验目标干员真实存在（防伪造空/垃圾记录）
    if (mode === 'single' && (!targetName || !findCharByName(targetName))) {
      return jsonResponse(res, { error: '目标干员不存在' }, 400);
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

    // 防刷榜：单身份单日存档上限（配合 IP 限流兜底）
    const dayStart = new Date().toISOString().slice(0, 10);
    const todayCount = userId
      ? db.prepare('SELECT COUNT(*) AS c FROM games WHERE user_id = ? AND timestamp >= ?').get(userId, dayStart).c
      : db.prepare('SELECT COUNT(*) AS c FROM games WHERE player_key = ? AND user_id IS NULL AND timestamp >= ?').get(player_key, dayStart).c;
    if (todayCount > 300) {
      return jsonResponse(res, { error: '今日存档次数已达上限，请明天再来' }, 429);
    }

    const result = db.prepare(
      'INSERT INTO games (player_key, user_id, won, guess_count, difficulty, target_name, timestamp, mode, daily_date, multi_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(player_key, userId || null, won ? 1 : 0, guessCount, difficulty, targetName, timestamp, mode, null, multiData);

    const extraHeaders = {};
    if (newPlayerKey) {
      extraHeaders['Set-Cookie'] = `player_key=${newPlayerKey}; SameSite=Lax; Secure; Path=/; Max-Age=94608000; HttpOnly`;
    }

    // 清除排行榜缓存（新游戏可能影响排名）
    for (const key of leaderboardCache.keys()) {
      if (key.startsWith(mode + ':')) leaderboardCache.delete(key);
    }

    console.log(`[save-game] pk=${player_key.slice(0, 10)} won=${won} guesses=${guessCount} mode=${mode} diff=${difficulty}`);
    return jsonResponse(res, { saved: true, id: result.lastInsertRowid, player_key: newPlayerKey || undefined }, 200, extraHeaders);
  }

  // ===== GET /api/leaderboard =====
  async function handleLeaderboard(req, res) {
    const ip = getClientIP(req);
    if (!checkRateLimit(`lb:${ip}`, 30, 60_000)) {
      return jsonResponse(res, { error: '请求过于频繁，请稍后再试' }, 429);
    }
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
    // Piggyback cleanup: evict entries older than 90s when the cache reaches 50 entries.
    // Acceptable trade-off — leaderboard reads are infrequent (~1/min at most) and
    // the cache is bounded by unique mode:difficulty:limit combinations (< 20 typically).
    if (leaderboardCache.size >= 50) {
      const cutoff = Date.now() - 90_000;
      for (const [k, v] of leaderboardCache) { if (v.at < cutoff) leaderboardCache.delete(k); }
    }

    console.log(`[leaderboard] returned ${leaderboard.length} entries mode=${mode} diff=${difficulty || 'all'}`);
    return jsonResponse(res, { leaderboard });
  }

  // ===== GET /api/daily/status =====
  async function handleDailyStatus(req, res) {
    const ip = getClientIP(req);
    if (!checkRateLimit(`dstatus:${ip}`, 30, 60_000)) {
      return jsonResponse(res, { error: '请求过于频繁，请稍后再试' }, 429);
    }

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

    // 查询今天是否已挑战（数据库记录）
    let played = false;
    let result = null;
    if (userId) {
      const row = db.prepare(
        'SELECT won, guess_count, timestamp, target_name FROM games WHERE user_id = ? AND daily_date = ?'
      ).get(userId, dailyDate);
      if (row) {
        played = true;
        result = { won: row.won === 1, guessCount: row.guess_count, timestamp: row.timestamp, targetName: row.target_name };
      }
    } else {
      const cookies = parseCookies(req.headers.cookie || '');
      const pk = cookies.player_key || sanitizeString(req.headers['x-player-key'] || '', 64);
      if (pk) {
        const row = db.prepare(
          'SELECT won, guess_count, timestamp, target_name FROM games WHERE player_key = ? AND daily_date = ? AND user_id IS NULL'
        ).get(pk, dailyDate);
        if (row) {
          played = true;
          result = { won: row.won === 1, guessCount: row.guess_count, timestamp: row.timestamp, targetName: row.target_name };
        }
      }
    }

    // 检查是否有进行中的内存会话（服务器重启后丢失，但 DB 记录仍是最终权威）
    const cookies = parseCookies(req.headers.cookie || '');
    const pk = cookies.player_key || '';
    const sessionKey = userId ? `${userId}:${dailyDate}` : (pk ? `${pk}:${dailyDate}` : '');
    const session = sessionKey ? dailySessions.get(sessionKey) : null;
    const inProgress = !played && session && session.status === 'playing';

    // 不再返回 target（服务端校验模式：目标保密）
    return jsonResponse(res, {
      date: dailyDate,
      played,
      inProgress: inProgress || undefined,
      remainingGuesses: inProgress ? session.remaining : undefined,
      guessCount: inProgress ? session.guesses.length : undefined,
      ...(result ? { result } : {}),
    });
  }

  // ===== POST /api/daily/guess =====
  async function handleDailyGuess(req, res) {
    const ip = getClientIP(req);
    if (!checkRateLimit(`dguess:${ip}`, 30, 60_000)) {
      return jsonResponse(res, { error: '请求过于频繁，请稍后再试' }, 429);
    }

    const body = await parseBody(req);
    const giveUp = body.giveUp === true;
    const name = sanitizeString(body.name || '', 100);
    if (!giveUp && !name) {
      return jsonResponse(res, { error: '请提供干员名称' }, 400);
    }

    // 解析用户身份
    const authHeader = req.headers.authorization || '';
    let userId = null;
    let player_key = body.player_key || '';
    const decoded = authHeader.startsWith('Bearer ') ? verifyToken(authHeader.slice(7)) : null;
    if (decoded) {
      const user = db.prepare('SELECT id, banned_at, token_version, player_key FROM users WHERE id = ?').get(decoded.userId);
      if (!user) { /* 用户已删除，按游客处理 */ }
      else if (user.banned_at) return jsonResponse(res, { error: '账号已被封禁' }, 403);
      else if ((decoded.tokenVersion || 0) !== (user.token_version || 0)) return jsonResponse(res, { error: '密码已更改，请重新登录' }, 401);
      else { userId = decoded.userId; player_key = user.player_key || player_key; }
    }

    let newPlayerKey = null;
    if (!player_key) {
      const cookies = parseCookies(req.headers.cookie || '');
      if (cookies.player_key) {
        player_key = cookies.player_key;
      }
    }
    // 新游客自动生成 player_key（与 handleSaveGame 保持一致）
    if (!userId && !player_key) {
      player_key = generateKey();
      newPlayerKey = player_key;
    }

    const extraHeaders = {};
    if (newPlayerKey) {
      extraHeaders['Set-Cookie'] = `player_key=${newPlayerKey}; SameSite=Lax; Secure; Path=/; Max-Age=94608000; HttpOnly`;
    }

    const now = new Date();
    const dailyDate = now.toISOString().slice(0, 10);

    // 检查是否已完成
    let alreadyDone = false;
    if (userId) {
      const row = db.prepare('SELECT id FROM games WHERE user_id = ? AND daily_date = ?').get(userId, dailyDate);
      if (row) alreadyDone = true;
    } else {
      const row = db.prepare('SELECT id FROM games WHERE player_key = ? AND daily_date = ? AND user_id IS NULL').get(player_key, dailyDate);
      if (row) alreadyDone = true;
    }
    if (alreadyDone) {
      return jsonResponse(res, { error: '今日已挑战' }, 409, extraHeaders);
    }

    // 获取或创建会话
    const sessionKey = userId ? `${userId}:${dailyDate}` : `${player_key}:${dailyDate}`;
    let session = dailySessions.get(sessionKey);

    if (!session) {
      const target = pickDailyTarget('hard');
      const fullTarget = findCharByName(target.name);
      if (!fullTarget) {
        return jsonResponse(res, { error: '服务器数据异常，请稍后再试' }, 500, extraHeaders);
      }
      session = {
        target: fullTarget,
        guesses: [],        // 已猜角色名列表
        remaining: DAILY_MAX_GUESSES,
        status: 'playing',
        startedAt: Date.now(),
      };
      dailySessions.set(sessionKey, session);
    }

    if (session.status !== 'playing') {
      return jsonResponse(res, { error: '游戏已结束' }, 400, extraHeaders);
    }

    // 放弃：直接结束游戏，保存为失败
    if (giveUp) {
      const targetName = session.target.name;
      // 去重 + 写入封装在事务中，防止并发请求触发唯一索引冲突
      const saveResult = db.transaction(() => {
        const existing = userId
          ? db.prepare('SELECT id FROM games WHERE user_id = ? AND daily_date = ?').get(userId, dailyDate)
          : db.prepare('SELECT id FROM games WHERE player_key = ? AND daily_date = ? AND user_id IS NULL').get(player_key, dailyDate);
        if (existing) return { conflict: true };
        db.prepare(
          'INSERT INTO games (player_key, user_id, won, guess_count, difficulty, target_name, timestamp, mode, daily_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(player_key, userId || null, 0, session.guesses.length, 'hard', targetName, now.toISOString(), 'daily', dailyDate);
        return { conflict: false };
      })();
      dailySessions.delete(sessionKey);
      for (const k of leaderboardCache.keys()) {
        if (k.startsWith('daily:')) leaderboardCache.delete(k);
      }
      if (saveResult.conflict) {
        return jsonResponse(res, { error: '今日已挑战' }, 409, extraHeaders);
      }
      console.log(`[daily-guess] pk=${player_key.slice(0, 10)} GAVE_UP guesses=${session.guesses.length}`);
      return jsonResponse(res, {
        won: false,
        lost: true,
        gaveUp: true,
        guessCount: session.guesses.length,
        target: { id: session.target.id, name: session.target.name },
        player_key: newPlayerKey || undefined,
      }, 200, extraHeaders);
    }

    // 查找猜测的干员
    const guessed = findCharByName(name);
    if (!guessed) {
      return jsonResponse(res, { error: '未找到该干员' }, 400, extraHeaders);
    }

    // 去重检查
    if (session.guesses.includes(guessed.name)) {
      return jsonResponse(res, { error: '已猜过该干员' }, 400, extraHeaders);
    }

    // 对比
    const comparisons = compareGuess(session.target, guessed);
    session.guesses.push(guessed.name);
    session.remaining--;

    const won = isWin(session.target, guessed);

    if (won || session.remaining <= 0) {
      // 游戏结束：保存到数据库
      const saveWon = won ? 1 : 0;
      const guessCount = session.guesses.length;
      const targetName = session.target.name;

      // 去重 + 写入封装在事务中，防止并发请求触发唯一索引冲突
      const saveResult = db.transaction(() => {
        const existing = userId
          ? db.prepare('SELECT id FROM games WHERE user_id = ? AND daily_date = ?').get(userId, dailyDate)
          : db.prepare('SELECT id FROM games WHERE player_key = ? AND daily_date = ? AND user_id IS NULL').get(player_key, dailyDate);
        if (existing) return { conflict: true };
        db.prepare(
          'INSERT INTO games (player_key, user_id, won, guess_count, difficulty, target_name, timestamp, mode, daily_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(player_key, userId || null, saveWon, guessCount, 'hard', targetName, now.toISOString(), 'daily', dailyDate);
        return { conflict: false };
      })();

      // 清理内存会话
      dailySessions.delete(sessionKey);
      // 失效排行榜缓存
      for (const k of leaderboardCache.keys()) {
        if (k.startsWith('daily:')) leaderboardCache.delete(k);
      }

      if (saveResult.conflict) {
        return jsonResponse(res, { error: '今日已挑战' }, 409, extraHeaders);
      }

      console.log(`[daily-guess] pk=${player_key.slice(0, 10)} ${won ? 'WON' : 'LOST'} guesses=${guessCount}`);
      return jsonResponse(res, {
        won,
        lost: !won,
        guessCount,
        comparisons,
        target: { id: session.target.id, name: session.target.name },
        player_key: newPlayerKey || undefined,
      }, 200, extraHeaders);
    }

    // 继续游戏
    return jsonResponse(res, {
      won: false,
      comparisons,
      remainingGuesses: session.remaining,
      guessCount: session.guesses.length,
      player_key: newPlayerKey || undefined,
    }, 200, extraHeaders);
  }

  // ===== GET /api/daily/leaderboard =====
  async function handleDailyLeaderboard(req, res) {
    const ip = getClientIP(req);
    if (!checkRateLimit(`dlb:${ip}`, 30, 60_000)) {
      return jsonResponse(res, { error: '请求过于频繁，请稍后再试' }, 429);
    }

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
      ORDER BY g.guess_count DESC, g.timestamp ASC
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
    // Same piggyback cleanup as classic leaderboard (see comment above)
    if (leaderboardCache.size >= 50) {
      const cutoff = Date.now() - 90_000;
      for (const [k, v] of leaderboardCache) { if (v.at < cutoff) leaderboardCache.delete(k); }
    }

    console.log(`[daily-leaderboard] returned ${leaderboard.length} entries for ${dailyDate}`);
    return jsonResponse(res, { date: dailyDate, leaderboard });
  }

  return {
    handleSaveGame,
    handleLeaderboard,
    handleDailyGuess,
    handleDailyStatus,
    handleDailyLeaderboard,
    // 昵称变更时清除排行榜缓存（避免改名后最多 60s 显示旧名）
    invalidateLeaderboardCache: () => leaderboardCache.clear(),
  };
}
