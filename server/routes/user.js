// 用户路由：me, sync, link-player-key, update-profile, send-verification, guest-identity, heartbeat, history
import { randomBytes, createHash } from 'node:crypto';
import { sanitizeString, parseCookies, parseBody, jsonResponse, deriveGuestName, generateKey } from '../utils.js';

export function registerUserRoutes({ app, db, verifyToken, requireAuth, checkNicknameProfanity, transporter, SITE_URL, onlinePlayers, onlineSockets, ONLINE_TIMEOUT, checkRateLimit, getClientIP }) {

  // ===== GET /api/me =====
  async function handleMe(req, res) {
    const auth = requireAuth(req, res);
    if (!auth) return;

    const user = db.prepare(
      'SELECT id, username, display_id, nickname, player_key, email, email_verified_at, role, created_at FROM users WHERE id = ?'
    ).get(auth.userId);
    if (!user) {
      return jsonResponse(res, { error: '用户不存在' }, 404);
    }

    // 按 user_id 查询（一级归属），player_key 仅作兜底
    const stats = db.prepare(`
      SELECT
        COUNT(*) as totalGames,
        SUM(won) as wins,
        COUNT(*) - SUM(won) as losses,
        SUM(guess_count) as totalGuesses,
        MIN(CASE WHEN won = 1 THEN guess_count ELSE NULL END) as bestScore
      FROM games WHERE user_id = ?
    `).get(auth.userId);

    return jsonResponse(res, {
      username: user.username,
      displayId: user.display_id || null,
      nickname: user.nickname || null,
      player_key: user.player_key,
      email: user.email || null,
      email_verified: !!user.email_verified_at,
      role: user.role || 'user',
      created_at: user.created_at,
      stats: {
        totalGames: stats?.totalGames || 0,
        wins: stats?.wins || 0,
        losses: stats?.losses || 0,
        totalGuesses: stats?.totalGuesses || 0,
        bestScore: stats?.bestScore || 0,
      },
    });
  }

  // ===== POST /api/sync (需要登录) =====
  async function handleSync(req, res) {
    const auth = requireAuth(req, res);
    if (!auth) return;

    const body = await parseBody(req);
    const player_key = typeof body.player_key === 'string' ? body.player_key.trim() : '';
    const games = body.games;

    if (!Array.isArray(games)) {
      return jsonResponse(res, { error: '需要 games 数组' }, 400);
    }
    // 防御：限制单次同步数量，防止客户端批量 dump 他人数据
    if (games.length > 500) {
      return jsonResponse(res, { error: '单次最多同步 500 条记录' }, 400);
    }

    const user = db.prepare('SELECT player_key FROM users WHERE id = ?').get(auth.userId);
    let finalPk = player_key;

    // 确保用户有 pk（生成新的，不迁移旧 pk 的游戏！）
    if (user && !user.player_key) {
      const newPk = generateKey();
      const updRes = db.prepare('UPDATE users SET player_key = ? WHERE id = ? AND player_key IS NULL').run(newPk, auth.userId);
      if (updRes.changes > 0) {
        finalPk = newPk;
        if (player_key && player_key.startsWith('p_') && player_key !== newPk) {
          // 回填旧 pk 的 ownerless 游戏的 user_id（不迁移 player_key！）
          // 只有当前用户能认领且没有其他用户绑定了这个 pk
          const pkConflict = db.prepare('SELECT id FROM users WHERE player_key = ? AND id != ?').get(player_key, auth.userId);
          if (!pkConflict) {
            const backfilled = db.prepare('UPDATE games SET user_id = ? WHERE player_key = ? AND user_id IS NULL').run(auth.userId, player_key);
            if (backfilled.changes > 0) {
              console.log(`[sync] backfilled user_id=${auth.userId} for ${backfilled.changes} games from pk=${player_key.slice(0, 10)}`);
            }
          }
        }
      } else {
        const refreshed = db.prepare('SELECT player_key FROM users WHERE id = ?').get(auth.userId);
        finalPk = refreshed?.player_key || player_key;
      }
    } else if (user && user.player_key) {
      finalPk = user.player_key;
    }

    const insert = db.prepare('INSERT INTO games (player_key, user_id, won, guess_count, difficulty, target_name, timestamp, mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const insertMany = db.transaction((rows) => {
      for (const g of rows) {
        const mode = g.mode === 'multi' ? 'multi' : 'single';
        insert.run(finalPk, auth.userId, g.won ? 1 : 0, g.guessCount || 0, g.difficulty || 'hard', sanitizeString(g.targetName || '', 100), g.timestamp || new Date().toISOString(), mode);
      }
    });

    try {
      insertMany(games);
      const extraHeaders = {};
      // 如果生成了新的 pk，用 cookie 告知客户端
      if (finalPk !== player_key) {
        extraHeaders['Set-Cookie'] = `player_key=${finalPk}; SameSite=Lax; Secure; Path=/; Max-Age=94608000; HttpOnly`;
      }
      return jsonResponse(res, { synced: games.length, player_key: finalPk }, 200, extraHeaders);
    } catch (err) {
      console.error('[sync] error:', err.message);
      return jsonResponse(res, { error: '同步失败' }, 500);
    }
  }

  // ===== POST /api/link-player-key =====
  // 将旧游客 pk 的 ownerless 游戏回填 user_id（不迁移 player_key，防止战绩串乱）
  async function handleLinkPlayerKey(req, res) {
    const auth = requireAuth(req, res);
    if (!auth) return;

    const body = await parseBody(req);
    const oldPk = typeof body.player_key === 'string' ? body.player_key.trim() : '';
    if (!oldPk) {
      return jsonResponse(res, { error: '需要 player_key' }, 400);
    }

    const currentUser = db.prepare('SELECT player_key FROM users WHERE id = ?').get(auth.userId);

    // 已绑定且 oldPk 与账户 pk 一致 → 幂等返回成功
    if (currentUser && currentUser.player_key === oldPk) {
      return jsonResponse(res, { success: true, player_key: currentUser.player_key });
    }

    // 确保用户有 pk
    if (currentUser && !currentUser.player_key) {
      const newPk = generateKey();
      db.prepare('UPDATE users SET player_key = ? WHERE id = ? AND player_key IS NULL').run(newPk, auth.userId);
      const refreshed = db.prepare('SELECT player_key FROM users WHERE id = ?').get(auth.userId);
      const finalPk = refreshed?.player_key || newPk;

      // 回填旧 pk 的 ownerless 游戏的 user_id（不改 player_key！）
      const pkConflict = db.prepare('SELECT id FROM users WHERE player_key = ? AND id != ?').get(oldPk, auth.userId);
      if (!pkConflict) {
        const backfilled = db.prepare('UPDATE games SET user_id = ? WHERE player_key = ? AND user_id IS NULL').run(auth.userId, oldPk);
        if (backfilled.changes > 0) {
          console.log(`[link-pk] backfilled user_id=${auth.userId} for ${backfilled.changes} games from pk=${oldPk.slice(0, 10)}`);
        }
      }
      return jsonResponse(res, { success: true, player_key: finalPk });
    }

    // 账户已有 pk 且不同于 oldPk
    if (currentUser && currentUser.player_key && currentUser.player_key !== oldPk) {
      // 回填 oldPk 的 ownerless 游戏（如果 oldPk 未被其他用户认领）
      const conflict = db.prepare('SELECT id FROM users WHERE player_key = ? AND id != ?').get(oldPk, auth.userId);
      if (conflict) {
        return jsonResponse(res, { error: '该游戏数据已绑定其他账户' }, 409);
      }
      const backfilled = db.prepare('UPDATE games SET user_id = ? WHERE player_key = ? AND user_id IS NULL').run(auth.userId, oldPk);
      console.log(`[link-pk] user=${auth.userId} backfilled ${backfilled.changes} ownerless games from pk=${oldPk.slice(0, 10)}`);
      return jsonResponse(res, { success: true, player_key: currentUser.player_key });
    }

    return jsonResponse(res, { success: true, player_key: currentUser?.player_key || '' });
  }

  // ===== PATCH /api/me — 修改个人信息 =====
  async function handleUpdateProfile(req, res) {
    const auth = requireAuth(req, res);
    if (!auth) return;

    const body = await parseBody(req);
    const nickname = typeof body.nickname === 'string' ? sanitizeString(body.nickname, 30) : null;

    if (nickname !== null) {
      if (nickname.length < 1 || nickname.length > 30) {
        return jsonResponse(res, { error: '昵称需要 1-30 个字符' }, 400);
      }
      const badWord = checkNicknameProfanity(nickname);
      if (badWord) {
        return jsonResponse(res, { error: '昵称包含违禁内容，请修改' }, 400);
      }
    }

    if (nickname === null) {
      return jsonResponse(res, { error: '没有需要修改的字段' }, 400);
    }

    db.prepare('UPDATE users SET nickname = ? WHERE id = ?').run(nickname, auth.userId);

    const user = db.prepare(
      'SELECT id, username, display_id, nickname, email, email_verified_at, created_at FROM users WHERE id = ?'
    ).get(auth.userId);

    return jsonResponse(res, {
      username: user.username,
      displayId: user.display_id || null,
      nickname: user.nickname || null,
      email: user.email || null,
      email_verified: !!user.email_verified_at,
      created_at: user.created_at,
    });
  }

  // ===== POST /api/send-verification =====
  async function handleSendVerification(req, res) {
    const auth = requireAuth(req, res);
    if (!auth) return;

    const body = await parseBody(req);
    const email = sanitizeString(body.email, 320);

    if (!email || !email.includes('@')) {
      return jsonResponse(res, { error: '请输入有效的邮箱地址' }, 400);
    }

    const user = db.prepare('SELECT id, email, email_verified_at FROM users WHERE id = ?').get(auth.userId);
    if (!user) {
      return jsonResponse(res, { error: '用户不存在' }, 404);
    }
    if (user.email_verified_at) {
      return jsonResponse(res, { error: '邮箱已验证' }, 400);
    }

    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, auth.userId);

    const verifyToken_ = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(verifyToken_).digest('hex');
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();

    db.prepare('DELETE FROM email_verifications WHERE user_id = ?').run(auth.userId);
    db.prepare('INSERT INTO email_verifications (user_id, email, token_hash, expires_at) VALUES (?, ?, ?, ?)').run(auth.userId, email, tokenHash, expiresAt);

    const verifyLink = `${SITE_URL}/verify?token=${verifyToken_}`;

    try {
      await transporter.sendMail({
        from: '"明日方舟猜干员" <3479083602@qq.com>',
        to: email,
        subject: '验证你的邮箱 - 明日方舟猜干员',
        html: `<div style="max-width:480px;margin:0 auto;font-family:sans-serif"><h2>验证你的邮箱</h2><p>感谢注册！点击下方按钮验证你的邮箱地址：</p><a href="${verifyLink}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none;font-weight:bold">验证邮箱</a><p style="color:#666;margin-top:20px;font-size:0.85rem">或者复制此链接到浏览器：<br>${verifyLink}</p><p style="color:#999;font-size:0.8rem">此链接1小时内有效。如果你没有注册此账号，请忽略此邮件。</p><p style="color:#999;font-size:0.8rem;margin-top:12px">如果未收到邮件，请检查垃圾邮件箱。</p></div>`,
      });
      return jsonResponse(res, { ok: true, message: '验证邮件已发送' });
    } catch (err) {
      console.error('[send-verification] email error:', err.message);
      return jsonResponse(res, { error: '邮件发送失败，请稍后再试' }, 500);
    }
  }

  // ===== GET /api/guest-identity =====
  async function handleGuestIdentity(req, res) {
    const cookies = parseCookies(req.headers.cookie || '');
    let guestKey = cookies.guest_id || '';

    if (guestKey && typeof guestKey === 'string' && guestKey.startsWith('g_') && guestKey.length > 10) {
      const displayName = deriveGuestName(guestKey);
      console.log(`[guest] existing key=${guestKey.slice(0, 10)} name=${displayName}`);
      return jsonResponse(res, { key: guestKey, displayName });
    }

    guestKey = 'g_' + randomBytes(12).toString('base64url');
    const displayName = deriveGuestName(guestKey);
    const cookieHeader = `guest_id=${guestKey}; SameSite=Lax; Secure; Path=/; Max-Age=94608000; HttpOnly`;
    console.log(`[guest] new key=${guestKey.slice(0, 10)} name=${displayName}`);
    return jsonResponse(res, { key: guestKey, displayName }, 200, {
      'Set-Cookie': cookieHeader,
    });
  }

  // ===== POST /api/heartbeat =====
  async function handleHeartbeat(req, res) {
    const ip = getClientIP(req);
    if (!checkRateLimit('hb:' + ip, 30, 60_000)) {
      return jsonResponse(res, { error: '请求过于频繁' }, 429);
    }
    const body = await parseBody(req);
    const playerKey = sanitizeString(body.playerKey || '', 64);
    if (!playerKey) return jsonResponse(res, { error: '需要 playerKey' }, 400);

    // 优先从内存读取（心跳是最频繁的请求，减少 DB 查询）
    const existing = onlinePlayers.get(playerKey);
    const isFresh = existing && Date.now() - (existing.lastSeen || 0) < 30_000;
    let displayName, username, userId;
    if (isFresh) {
      displayName = existing.displayName;
      username = existing.username;
      userId = existing.userId;
    } else {
      const userRow = db.prepare('SELECT id, username, nickname, banned_at FROM users WHERE player_key = ?').get(playerKey);
      if (userRow?.banned_at) return jsonResponse(res, { ok: true }); // 静默忽略被封禁用户
      displayName = userRow?.nickname || userRow?.username || deriveGuestName(playerKey);
      username = userRow?.username || null;
      userId = userRow?.id || null;
    }

    const currentType = existing?.type || 'idle';

    onlinePlayers.set(playerKey, {
      playerKey,
      displayName,
      username,
      userId,
      type: currentType,
      roomCode: existing?.roomCode || null,
      lastSeen: Date.now(),
    });

    return jsonResponse(res, { ok: true });
  }

  // ===== GET /api/history =====
  async function handleHistory(req, res) {
    const auth = requireAuth(req, res);
    if (!auth) return;

    const urlObj = new URL(req.url, 'http://localhost');
    let limit = parseInt(urlObj.searchParams.get('limit')) || 80;
    if (limit < 1) limit = 1;
    if (limit > 200) limit = 200;

    // 按 user_id 查询（一级归属），不再仅靠 player_key
    const rows = db.prepare(
      'SELECT won, guess_count, difficulty, target_name, timestamp, mode FROM games WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?'
    ).all(auth.userId, limit);

    const history = rows.map(r => ({
      timestamp: new Date(r.timestamp).getTime(),
      won: !!r.won,
      guessCount: r.guess_count,
      difficulty: r.difficulty,
      targetName: r.target_name || '',
      mode: r.mode || 'single',
    }));

    return jsonResponse(res, { history, count: history.length });
  }

  return {
    handleMe,
    handleSync,
    handleLinkPlayerKey,
    handleUpdateProfile,
    handleSendVerification,
    handleGuestIdentity,
    handleHeartbeat,
    handleHistory,
  };
}
