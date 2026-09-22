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
// 被清扫掉的「未完成」会话留下的墓碑：同 key 一份，值为 dailyDate。
// 为什么需要它：会话被 TTL 清扫后，下一次猜测走「查无此会话 → 新建」，
// 而新建时 remaining 恒等于 DAILY_MAX_GUESSES —— 等于把这一天的次数回满。
// 未完成的局在 DB 里**没有任何记录可回填**（落库只发生在猜完/放弃时），
// 所以只能在这里留痕。不留的话，挂机满 1 小时再猜就能无限刷当日排行榜。
// 日切后墓碑失去意义（新的一天本来就是全新一次挑战），随清扫一起删。
// ⚠️ 进程重启会连同 dailySessions 一起丢失 —— 这与既有设计一致
//    （重启后本来所有进行中的会话就没了），不是本次引入的新缺口。
const dailyVoided = new Map();
const DAILY_MAX_GUESSES = 8;
// 两个时间常量可由环境变量覆盖，**仅供测试**：默认值即线上行为，不设变量时逐字不变。
// 没有这两个口子的话，「会话被清扫后不再发放次数」那段逻辑只能等满 1 小时才观察得到，
// 等于永远不会有自动化覆盖 —— 而它正是挡住「挂机刷当日排行榜」的那道门。
// 用 `||` 而非 `??`：环境变量给 0 或非数字时回落到默认值，不会把 TTL 变成 0。
const SESSION_TTL = Number(process.env.DAILY_SESSION_TTL_MS) || 3600_000; // 1 小时后清理
const SWEEP_INTERVAL = Number(process.env.DAILY_SWEEP_INTERVAL_MS) || 300_000; // 每 5 分钟

// 定期清理过期会话
setInterval(() => {
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  for (const [key, sess] of dailySessions) {
    // 按 lastActiveAt（成功猜测、以及 status 被读取时刷新）而非 startedAt 计时。
    // 原先只看 startedAt —— 它只在创建会话时写一次，玩得越久越接近被清扫：
    // 一个玩家从开局起玩了 59 分钟、中间去看了两眼攻略，第 61 分钟的清扫就会
    // 直接删掉他还在用的会话；下一次猜测「查无此会话」就新建一个，
    // **次数回满、已猜记录清空**（目标本身在同 UTC 日内由日期种子决定，不变）。
    // 玩家看到的就是 BUG 3 报的「中途退出后猜测记录消失、次数减少又变回来」。
    if (now - (sess.lastActiveAt || sess.startedAt) > SESSION_TTL) {
      // 只给「还在进行」的会话立碑：已结束的会话对应的局早就落库了，
      // played=true 本来就会挡住重开，再立碑只会让 Map 白白多存一份。
      if (sess.status === 'playing') dailyVoided.set(key, today);
      dailySessions.delete(key);
    }
  }
  for (const [key, date] of dailyVoided) if (date !== today) dailyVoided.delete(key);
}, SWEEP_INTERVAL);

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
    // header 兜底与 /api/daily/guess 的 `body.player_key` 优先级保持一致：
    // 若这里只认 Cookie，而客户端把 pk 放在 body/header 里，同一个玩家在
    // status 里查不到会话（显示未开局）却在 guess 里命中会话。
    let pk = cookies.player_key || sanitizeString(req.headers['x-player-key'] || '', 64);
    // ⚠️ 与 handleDailyGuess 的同名守卫对齐（见那边「未认证时拒绝用已注册用户的 pk」注释）。
    //    Cookie 由浏览器自动携带，请求方无法替他人指定；但 header 是**请求方完全可控**的，
    //    且这里刚新增了 history（完整猜测记录 + 逐属性 comparisons）。
    //    没有这道门，拿到他人 pk 的人可以用 X-Player-Key 直接读到对方进行中的整张棋盘 ——
    //    而 guess 早就有这道守卫，status 漏了就成了绕过它的旁路。
    if (!userId && pk) {
      if (db.prepare('SELECT id FROM users WHERE player_key = ?').get(pk)) pk = '';
    }
    // ⚠️ `u:` / `p:` 前缀是**安全边界**，不是装饰（与 handleDailyGuess 的那行必须逐字一致）。
    //    userId 是 AUTOINCREMENT 小整数，而真实 player_key 恒为 `p_` 前缀，两者原先
    //    共用 `${x}:${date}` 这一种形状 —— 游客传 `player_key:"1"` 生成的键与 id=1 的
    //    登录用户逐字相同。上面 363 行那道守卫只查 users.player_key（恒 `p_` 开头），
    //    拦不住 `"1"`，于是游客能读走对方的进行中棋盘、消耗对方的次数。
    //    （已实测复现：游客 X-Player-Key:"1" 读到 id=1 用户的完整 history。）
    //    加前缀后 `u:1:date` ≠ `p:1:date`，且游客造不出 `u:` 开头的键。
    const sessionKey = userId ? `u:${userId}:${dailyDate}` : (pk ? `p:${pk}:${dailyDate}` : '');
    const session = sessionKey ? dailySessions.get(sessionKey) : null;
    const inProgress = !played && session && session.status === 'playing';
    // 今日有过会话但被清扫了：告诉客户端「今天这次已经作废」，
    // 否则前端会照常渲染一块可玩的棋盘，玩家点下去才吃 409。
    const voided = !played && !inProgress && !!sessionKey && dailyVoided.has(sessionKey);

    // 读一次进行中的会话就算「玩家还在」，续期 TTL。
    // 刷新页面/重连走的就是这条路径，而它原先不刷新 lastActiveAt ——
    // 只靠「成功猜测」续期的话，猜错几次后去翻攻略超过 1 小时的玩家
    // 照样会被清扫，会话没了、次数回满（见上方清扫处的注释）。
    if (inProgress) session.lastActiveAt = Date.now();

    // 不再返回 target（服务端校验模式：目标保密）
    return jsonResponse(res, {
      date: dailyDate,
      played,
      voided: voided || undefined,
      inProgress: inProgress || undefined,
      remainingGuesses: inProgress ? session.remaining : undefined,
      guessCount: inProgress ? session.guesses.length : undefined,
      // 已猜记录（含逐属性对比），供客户端在刷新/重连后重建整张猜测表。
      // 原来只回 remainingGuesses + guessCount：次数对得上，但 guessChain 是空的 ——
      // 前端 GuessTable 直接 return null，已猜过的干员也不再置灰，玩家看到「记录消失」。
      history: inProgress && Array.isArray(session.history) ? session.history : undefined,
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
    // 与 handleSaveGame 的同一行、以及 status 处理器读 header 的写法对齐
    // （typeof 校验 + 去控制字符 + 64 长度上限）。原先这里是裸 `body.player_key || ''`：
    // 非字符串会被当成原样使用，且长度无上限，而它随后要进 Map 的键。
    let player_key = sanitizeString(body.player_key || '', 64);
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

    // 未认证时拒绝用「已注册用户」的 pk 提交每日猜测 —— 与 handleSaveGame 的同名守卫对齐
    // （见上文「未认证（无 token / token 无效）：拒绝写入已注册用户的 pk」）。
    // 不对称的后果：拿到他人 p_ 键就能替对方占掉当日挑战，对方再来会收到 409「今日已挑战」。
    // ⚠️ 登录用户不受影响：上面的 token 分支已把 player_key 换成账号权威 pk 且 userId 非空，
    //    守卫直接跳过；未被认领的游客 pk 也不在 users 表里，同样放行。
    if (!userId) {
      const pkOwner = db.prepare('SELECT id FROM users WHERE player_key = ?').get(player_key);
      if (pkOwner) {
        return jsonResponse(res, { error: '请先登录' }, 401);
      }
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
    // ⚠️ `u:` / `p:` 前缀是安全边界，与 status 处理器的那行必须逐字一致（理由见那边注释）。
    const sessionKey = userId ? `u:${userId}:${dailyDate}` : `p:${player_key}:${dailyDate}`;
    let session = dailySessions.get(sessionKey);

    if (!session) {
      // 这个 key 今天有过一次进行中的会话、且已被 TTL 清扫 —— 不再新开。
      // 不拦的话等于白送一整天次数（见 dailyVoided 声明处的注释）。
      // 上面那道 `今日已挑战` 只挡「已落库的完整局」，这里补的是「未完成」那半边。
      if (dailyVoided.has(sessionKey)) {
        return jsonResponse(res, { error: '今日挑战已结束，请明天再来', voided: true }, 409, extraHeaders);
      }
      const target = pickDailyTarget('hard');
      const fullTarget = findCharByName(target.name);
      if (!fullTarget) {
        return jsonResponse(res, { error: '服务器数据异常，请稍后再试' }, 500, extraHeaders);
      }
      session = {
        target: fullTarget,
        guesses: [],        // 已猜角色名列表（去重 + 计数用，形状保持不变）
        // 与 guesses 并行：多存一份带 comparisons 的完整记录，
        // 专门给「刷新后用 /api/daily/status 重建棋盘」用。
        // 不直接把 guesses 改成对象数组 —— 上面 479/485/493 行的 includes/push/length
        // 和放弃分支的 guess_count 都依赖它是字符串数组，改形状会连带炸掉这些逻辑。
        history: [],
        remaining: DAILY_MAX_GUESSES,
        status: 'playing',
        startedAt: Date.now(),
        lastActiveAt: Date.now(),
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
    // 并行记录完整的一条（名字 + 逐属性对比），供刷新后重建棋盘
    if (!Array.isArray(session.history)) session.history = [];
    session.history.push({ name: guessed.name, comparisons });
    session.remaining--;
    session.lastActiveAt = Date.now();   // 刷新 TTL，活跃玩家不会被清扫

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
