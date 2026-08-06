// 用户路由：me, sync, link-player-key, update-profile, send-verification, guest-identity, heartbeat, history
import { randomBytes, createHash } from 'node:crypto';
import { sanitizeString, parseCookies, parseBody, jsonResponse, deriveGuestName, generateKey } from '../utils.js';

export function registerUserRoutes({ app, db, verifyToken, requireAuth, checkNicknameProfanity, transporter, SITE_URL, onlinePlayers, onlineSockets, ONLINE_TIMEOUT }) {

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

    const stats = db.prepare(`
      SELECT
        COUNT(*) as totalGames,
        SUM(won) as wins,
        COUNT(*) - SUM(won) as losses,
        SUM(guess_count) as totalGuesses,
        MIN(CASE WHEN won = 1 THEN guess_count ELSE NULL END) as bestScore
      FROM games WHERE player_key = ?
    `).get(user.player_key || '');

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

    const user = db.prepare('SELECT player_key FROM users WHERE id = ?').get(auth.userId);
    let finalPk = player_key;
    if (user && !user.player_key) {
      // 始终生成新 key，不复用客户端提供的 pk（防止多用户共享设备时数据归属错误）
      const newPk = generateKey();
      if (player_key && player_key.startsWith('p_')) {
        const pkConflict = db.prepare('SELECT id FROM users WHERE player_key = ? AND id != ?').get(player_key, auth.userId);
        if (!pkConflict) {
          // 旧 pk 无人认领 → 迁移游戏记录到新 pk
          db.prepare('UPDATE games SET player_key = ? WHERE player_key = ?').run(newPk, player_key);
        }
      }
      finalPk = newPk;
      try { db.prepare('UPDATE users SET player_key = ? WHERE id = ?').run(finalPk, auth.userId); } catch {}
    } else if (user && user.player_key) {
      finalPk = user.player_key;
    }

    const insert = db.prepare('INSERT INTO games (player_key, won, guess_count, difficulty, target_name, timestamp, mode) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insertMany = db.transaction((rows) => {
      for (const g of rows) {
        const mode = g.mode === 'multi' ? 'multi' : 'single';
        insert.run(finalPk, g.won ? 1 : 0, g.guessCount || 0, g.difficulty || 'hard', sanitizeString(g.targetName || '', 100), g.timestamp || new Date().toISOString(), mode);
      }
    });

    try {
      insertMany(games);
      const extraHeaders = {};
      // 如果生成了新的 pk，用 cookie 告知客户端
      if (finalPk !== player_key && !user?.player_key) {
        extraHeaders['Set-Cookie'] = `player_key=${finalPk}; SameSite=Lax; Path=/; Max-Age=94608000; HttpOnly`;
      }
      return jsonResponse(res, { synced: games.length, player_key: finalPk }, 200, extraHeaders);
    } catch (err) {
      console.error('[sync] error:', err.message);
      return jsonResponse(res, { error: '同步失败' }, 500);
    }
  }

  // ===== POST /api/link-player-key =====
  async function handleLinkPlayerKey(req, res) {
    const auth = requireAuth(req, res);
    if (!auth) return;

    const body = await parseBody(req);
    const oldPk = typeof body.player_key === 'string' ? body.player_key.trim() : '';
    if (!oldPk) {
      return jsonResponse(res, { error: '需要 player_key' }, 400);
    }

    const currentUser = db.prepare('SELECT player_key FROM users WHERE id = ?').get(auth.userId);
    if (currentUser && currentUser.player_key) {
      return jsonResponse(res, { error: '账户已绑定游戏数据，无需重复绑定' }, 400);
    }

    // 检查旧 pk 是否已被其他注册用户认领
    const existing = db.prepare('SELECT id FROM users WHERE player_key = ? AND id != ?').get(oldPk, auth.userId);
    if (existing) {
      return jsonResponse(res, { error: '该游戏数据已绑定其他账户' }, 409);
    }

    // 始终生成新 key，迁移旧 pk 的游戏记录（防止多用户共享设备时数据归属错误）
    const newPk = generateKey();
    const migrated = db.prepare('UPDATE games SET player_key = ? WHERE player_key = ?').run(newPk, oldPk);
    db.prepare('UPDATE users SET player_key = ? WHERE id = ?').run(newPk, auth.userId);
    console.log(`[link-pk] user=${auth.userId} ${oldPk.slice(0, 10)} → ${newPk.slice(0, 10)} migrated=${migrated.changes}`);
    return jsonResponse(res, { success: true, player_key: newPk });
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
    const cookieHeader = `guest_id=${guestKey}; SameSite=Lax; Path=/; Max-Age=94608000; HttpOnly`;
    console.log(`[guest] new key=${guestKey.slice(0, 10)} name=${displayName}`);
    return jsonResponse(res, { key: guestKey, displayName }, 200, {
      'Set-Cookie': cookieHeader,
    });
  }

  // ===== POST /api/heartbeat =====
  async function handleHeartbeat(req, res) {
    const body = await parseBody(req);
    const playerKey = sanitizeString(body.playerKey || '', 64);
    if (!playerKey) return jsonResponse(res, { error: '需要 playerKey' }, 400);

    const userRow = db.prepare('SELECT id, username, nickname, banned_at FROM users WHERE player_key = ?').get(playerKey);
    if (userRow?.banned_at) return jsonResponse(res, { ok: true }); // 静默忽略被封禁用户
    const displayName = userRow?.nickname || userRow?.username || deriveGuestName(playerKey);

    const existing = onlinePlayers.get(playerKey);
    const currentType = (existing && existing.type === 'multi') ? 'multi' : 'single';

    onlinePlayers.set(playerKey, {
      playerKey,
      displayName,
      username: userRow?.username || null,
      userId: userRow?.id || null,
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

    const user = db.prepare('SELECT player_key FROM users WHERE id = ?').get(auth.userId);
    const pk = user?.player_key || '';

    const rows = db.prepare(
      'SELECT won, guess_count, difficulty, target_name, timestamp, mode FROM games WHERE player_key = ? ORDER BY timestamp DESC LIMIT ?'
    ).all(pk, limit);

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
