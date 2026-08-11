// 认证路由：register, login, verify-email, forgot-password, reset-password, auth-cookie
import { randomBytes, createHash } from 'node:crypto';
import { promises as dns } from 'node:dns';
import bcrypt from 'bcryptjs';
import { sanitizeString, parseCookies, parseBody, jsonResponse, generateKey, generateDisplayCode, SMTP_SENDER } from '../utils.js';

// ===== 邮箱 MX 记录验证 =====
async function checkEmailMX(email) {
  const domain = email.split('@')[1];
  if (!domain) return false;
  try {
    // Node.js dns.promises 不支持 AbortController，用 Promise.race 实现超时
    const records = await Promise.race([
      dns.resolveMx(domain),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
    ]);
    return Array.isArray(records) && records.length > 0;
  } catch {
    return false;
  }
}

export function registerAuthRoutes({ app, db, signToken, verifyToken, requireAuth, checkRateLimit, transporter, SITE_URL, getClientIP }) {

  // ===== POST /api/register =====
  async function handleRegister(req, res, ip) {
    if (!checkRateLimit(`reg:${ip}`, 5, 600_000)) {
      return jsonResponse(res, { error: '注册请求过于频繁，请10分钟后再试' }, 429);
    }

    const body = await parseBody(req);
    const username = sanitizeString(body.username, 20);
    const password = typeof body.password === 'string' ? body.password : '';
    const email = sanitizeString(body.email, 320).toLowerCase();

    // 额外按邮箱限流（IP 绕过防御）
    // 注意：必须先 toLowerCase 再构 建 rate limit key，否则大小写变体可绕过敏率限制
    if (!checkRateLimit(`regmail:${email}`, 3, 3600_000)) {
      return jsonResponse(res, { error: '该邮箱验证请求过于频繁，请稍后再试' }, 429);
    }

    if (!username || !password || !email) {
      return jsonResponse(res, { error: '用户名、密码和邮箱不能为空' }, 400);
    }
    if (username.length < 2 || username.length > 20) {
      return jsonResponse(res, { error: '用户名需要 2-20 个字符' }, 400);
    }
    if (password.length < 8) {
      return jsonResponse(res, { error: '密码至少需要 8 个字符' }, 400);
    }
    if (!/^[a-zA-Z0-9_一-鿿]+$/.test(username)) {
      return jsonResponse(res, { error: '用户名只能包含字母、数字、下划线和中文' }, 400);
    }
    const atIndex = email.indexOf('@');
    if (atIndex < 1 || email.length > 320) {
      // atIndex < 1 同时守卫了：不存在 @、@ 在开头（空本地部分）、@ 在末尾（空域部分）
      return jsonResponse(res, { error: '请输入有效的邮箱地址' }, 400);
    }

    // 验证邮箱域名 MX 记录（防止虚假邮箱）
    const mxValid = await checkEmailMX(email);
    if (!mxValid) {
      return jsonResponse(res, { error: '邮箱域名无效，请使用真实邮箱' }, 400);
    }

    const existingUser = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existingUser) {
      return jsonResponse(res, { error: '该邮箱或用户名不可用' }, 409);
    }

    const existingEmail = db.prepare("SELECT id FROM users WHERE LOWER(email) = ? AND email_verified_at IS NOT NULL").get(email);
    if (existingEmail) {
      // P2 fix: 不透露邮箱是否已注册，返回统一消息
      return jsonResponse(res, { error: '该邮箱或用户名不可用' }, 409);
    }

    const existingPending = db.prepare(
      "SELECT id FROM pending_registrations WHERE (username = ? OR LOWER(email) = ?) AND datetime(expires_at) > datetime('now')"
    ).get(username, email);
    if (existingPending) {
      return jsonResponse(res, { error: '该邮箱或用户名不可用' }, 409);
    }

    let password_hash;
    try {
      password_hash = await bcrypt.hash(password, 10);
    } catch (err) {
      console.error('[register] bcrypt.hash error:', err.message);
      return jsonResponse(res, { error: '服务器内部错误，请稍后再试' }, 500);
    }

    const verifyTokenRaw = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(verifyTokenRaw).digest('hex');
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();

    try {
      db.prepare(
        'INSERT INTO pending_registrations (username, password_hash, email, token_hash, expires_at) VALUES (?, ?, ?, ?, ?)'
      ).run(username, password_hash, email, tokenHash, expiresAt);
    } catch (err) {
      console.error('[register] pending_registrations INSERT error:', err.message);
      return jsonResponse(res, { error: '注册失败，请稍后重试' }, 500);
    }

    const verifyLink = `${SITE_URL}/verify?token=${verifyTokenRaw}`;
    const isDev = process.env.NODE_ENV === 'development';

    if (isDev) {
      console.log('[DEV] 验证链接:', verifyLink);
      return jsonResponse(res, {
        ok: true,
        message: '[DEV] 验证邮件已跳过，请使用控制台打印的链接完成验证',
        devVerifyLink: verifyLink,
      });
    }

    // 生产环境必须配置 SMTP，否则不能泄露验证链接
    if (!process.env.SMTP_PASS) {
      console.error('[register] SMTP_PASS not configured in production');
      return jsonResponse(res, { error: '邮件服务未配置，请稍后再试' }, 500);
    }

    try {
      await transporter.sendMail({
        from: SMTP_SENDER,
        to: email,
        subject: '完成注册 - 明日方舟猜干员',
        html: `<div style="max-width:480px;margin:0 auto;font-family:sans-serif"><h2>完成你的注册</h2><p>感谢注册！点击下方按钮完成注册：</p><a href="${verifyLink}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none;font-weight:bold">完成注册</a><p style="color:#666;margin-top:20px;font-size:0.85rem">或者复制此链接到浏览器：<br>${verifyLink}</p><p style="color:#999;font-size:0.8rem">此链接1小时内有效。如果你没有注册此账号，请忽略此邮件。</p><p style="color:#999;font-size:0.8rem;margin-top:12px">如果未收到邮件，请检查垃圾邮件箱。</p></div>`,
      });
      return jsonResponse(res, { ok: true, message: '验证邮件已发送，请查收邮件并点击链接完成注册' });
    } catch (err) {
      db.prepare('DELETE FROM pending_registrations WHERE token_hash = ?').run(tokenHash);
      console.error('[register] email error:', err.message);
      return jsonResponse(res, { error: '邮件发送失败，请稍后再试' }, 500);
    }
  }

  // ===== POST /api/login =====
  async function handleLogin(req, res, ip) {
    if (!checkRateLimit(`login:${ip}`, 10, 900_000)) {
      return jsonResponse(res, { error: '登录请求过于频繁，请15分钟后再试' }, 429);
    }

    const body = await parseBody(req);
    const email = sanitizeString(body.username, 320).toLowerCase();
    const password = typeof body.password === 'string' ? body.password : '';

    if (!email || !password) {
      return jsonResponse(res, { error: '邮箱和密码不能为空' }, 400);
    }

    if (!email.includes('@')) {
      return jsonResponse(res, { error: '请使用邮箱登录' }, 400);
    }

    // 邮箱登录（大小写不敏感）
    const user = db.prepare('SELECT id, username, display_id, nickname, role, password_hash, player_key, email, email_verified_at, banned_at, token_version FROM users WHERE LOWER(email) = ?').get(email);
    if (!user) {
      // 时序防御：即使未找到用户也执行 bcrypt.compare，防止通过响应时间枚举账号
      try { await bcrypt.compare('timing-defense', '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy'); } catch {}
      return jsonResponse(res, { error: '账号或密码错误' }, 401);
    }

    if (user.banned_at) {
      return jsonResponse(res, { error: '账号已被封禁' }, 403);
    }

    let valid;
    try {
      valid = await bcrypt.compare(password, user.password_hash);
    } catch (err) {
      console.error('[login] bcrypt.compare error:', err.message);
      return jsonResponse(res, { error: '服务器内部错误，请稍后再试' }, 500);
    }
    if (!valid) {
      return jsonResponse(res, { error: '账号或密码错误' }, 401);
    }

    const token = signToken({ userId: user.id, username: user.username, tokenVersion: user.token_version || 0 });

    // 确保用户有 player_key，并回填 cookie 中的游客游戏数据 user_id（不改 player_key！）
    let playerKey = user.player_key;
    const cookies = parseCookies(req.headers.cookie || '');
    const cookiePk = typeof cookies.player_key === 'string' && cookies.player_key.startsWith('p_') ? cookies.player_key : null;

    if (!playerKey) {
      // 首次登录：生成新 pk（条件 UPDATE 防并发登录竞态）
      playerKey = generateKey();
      const updRes = db.prepare('UPDATE users SET player_key = ? WHERE id = ? AND player_key IS NULL').run(playerKey, user.id);
      if (updRes.changes === 0) {
        // 并发登录：另一请求先绑定了 pk，重新读取
        const refreshed = db.prepare('SELECT player_key FROM users WHERE id = ?').get(user.id);
        playerKey = refreshed?.player_key || playerKey;
      }
    }

    // 回填 cookie pk 的 ownerless 游戏 user_id（不改 player_key！防止战绩串乱）
    // 解决：从其他设备/浏览器登录时，之前游客玩的游戏查询 /api/me 和 /api/history 找不到
    if (cookiePk && cookiePk !== playerKey) {
      const conflict = db.prepare('SELECT id FROM users WHERE player_key = ? AND id != ?').get(cookiePk, user.id);
      if (!conflict) {
        // cookie pk 无人认领 → 回填 user_id（不再迁移 player_key！）
        const backfilled = db.prepare('UPDATE games SET user_id = ? WHERE player_key = ? AND user_id IS NULL').run(user.id, cookiePk);
        if (backfilled.changes > 0) {
          console.log(`[login] backfilled user_id=${user.id} for ${backfilled.changes} games from cookie pk=${cookiePk.slice(0, 10)}`);
        }
      }
    }

    // 始终设置 player_key cookie 为账户 pk（收敛多设备身份，覆盖旧的游客/其他账户 cookie）
    const setPlayerKeyCookie = `player_key=${playerKey}; SameSite=Lax; Secure; Path=/; Max-Age=94608000; HttpOnly`;

    const cookieHeaders = [`token=${token}; SameSite=None; Secure; HttpOnly; Path=/; Max-Age=2592000`];
    cookieHeaders.push(setPlayerKeyCookie);

    return jsonResponse(res, {
      token, username: user.username, displayId: user.display_id || null,
      nickname: user.nickname || null, userId: user.id, role: user.role || 'user',
      player_key: playerKey, email: user.email || null, email_verified: !!user.email_verified_at,
    }, 200, { 'Set-Cookie': cookieHeaders });
  }

  // ===== POST /api/auth-cookie =====
  async function handleAuthCookie(req, res) {
    const body = await parseBody(req);
    let token = body.token;
    if (!token) {
      const authHeader = req.headers.authorization || '';
      if (authHeader.startsWith('Bearer ')) token = authHeader.slice(7);
    }
    if (!token) return jsonResponse(res, { error: '需要 token' }, 400);

    const decoded = verifyToken(token);
    if (!decoded) return jsonResponse(res, { error: 'token 无效或已过期' }, 401);

    const cookieHeader = `token=${token}; SameSite=None; Secure; HttpOnly; Path=/; Max-Age=2592000`;
    return jsonResponse(res, { ok: true }, 200, { 'Set-Cookie': cookieHeader });
  }

  // ===== GET /api/verify-email =====
  async function handleVerifyEmail(req, res) {
    const urlObj = new URL(req.url, 'http://localhost');
    const token = urlObj.searchParams.get('token');
    if (!token) return jsonResponse(res, { error: '缺少验证 token' }, 400);

    const tokenHash = createHash('sha256').update(token).digest('hex');

    // 情况1：新注册流程
    const pending = db.prepare(
      "SELECT id, username, password_hash, email, expires_at FROM pending_registrations WHERE token_hash = ?"
    ).get(tokenHash);

    if (pending) {
      if (new Date(pending.expires_at) < new Date()) {
        db.prepare('DELETE FROM pending_registrations WHERE id = ?').run(pending.id);
        return jsonResponse(res, { error: '验证链接已过期，请重新注册' }, 400);
      }

      const existingUser = db.prepare('SELECT id FROM users WHERE username = ?').get(pending.username);
      if (existingUser) {
        db.prepare('DELETE FROM pending_registrations WHERE id = ?').run(pending.id);
        return jsonResponse(res, { error: '用户名已被注册' }, 409);
      }

      const emailTaken = db.prepare("SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND email_verified_at IS NOT NULL").get(pending.email);
      if (emailTaken) {
        db.prepare('DELETE FROM pending_registrations WHERE id = ?').run(pending.id);
        return jsonResponse(res, { error: '该邮箱已被注册' }, 409);
      }

      let result;
      try {
        const doVerify = db.transaction(() => {
          const r = db.prepare(
            "INSERT INTO users (username, password_hash, email, email_verified_at, created_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))"
          ).run(pending.username, pending.password_hash, pending.email);
          const uid = r.lastInsertRowid;
          const displayId = generateDisplayCode(uid);
          db.prepare('UPDATE users SET display_id = ? WHERE id = ?').run(displayId, uid);
          db.prepare('DELETE FROM pending_registrations WHERE id = ?').run(pending.id);
          return { userId: uid, displayId };
        });
        result = doVerify();
      } catch (err) {
        console.error('[verify-email] transaction failed:', err.message);
        return jsonResponse(res, { error: '注册失败，请稍后重试' }, 500);
      }

      // 自动登录：生成 player_key 和 JWT token
      const playerKey = generateKey();
      db.prepare('UPDATE users SET player_key = ? WHERE id = ?').run(playerKey, result.userId);
      const token = signToken({ userId: result.userId, username: pending.username, tokenVersion: 0 });

      return jsonResponse(res, {
        ok: true, token, userId: result.userId, username: pending.username,
        nickname: null, role: 'user',
        email: pending.email, displayId: result.displayId, player_key: playerKey,
        email_verified: true,
      });
    }

    // 情况2：已注册用户补验证邮箱
    const record = db.prepare(
      'SELECT id, user_id, email, expires_at FROM email_verifications WHERE token_hash = ?'
    ).get(tokenHash);

    if (!record) return jsonResponse(res, { error: '无效的验证链接' }, 400);
    if (new Date(record.expires_at) < new Date()) {
      db.prepare('DELETE FROM email_verifications WHERE id = ?').run(record.id);
      return jsonResponse(res, { error: '验证链接已过期，请重新发送' }, 400);
    }

    const emailConflict = db.prepare("SELECT id FROM users WHERE email = ? AND email_verified_at IS NOT NULL AND id != ?").get(record.email, record.user_id);
    if (emailConflict) {
      db.prepare('DELETE FROM email_verifications WHERE id = ?').run(record.id);
      return jsonResponse(res, { error: '该邮箱已被其他用户验证' }, 409);
    }

    db.prepare("UPDATE users SET email = ?, email_verified_at = datetime('now') WHERE id = ?").run(record.email, record.user_id);
    db.prepare('DELETE FROM email_verifications WHERE id = ?').run(record.id);
    return jsonResponse(res, { ok: true, email: record.email });
  }

  // ===== POST /api/forgot-password =====
  async function handleForgotPassword(req, res, ip) {
    if (!checkRateLimit(`forgot:${ip}`, 3, 900_000)) {
      return jsonResponse(res, { error: '请求过于频繁，请15分钟后再试' }, 429);
    }

    const body = await parseBody(req);
    const email = sanitizeString(body.email, 320).toLowerCase();
    if (!email || !email.includes('@')) {
      return jsonResponse(res, { error: '请输入有效的邮箱地址' }, 400);
    }

    if (!checkRateLimit(`forgotmail:${email}`, 1, 900_000)) {
      // 静默吞掉：对同一邮箱15分钟内重复请求，仍返回相同成功消息
      return jsonResponse(res, { ok: true, message: '如果该邮箱已注册，重置邮件已发送' });
    }

    const user = db.prepare('SELECT id, username, email FROM users WHERE LOWER(email) = ? AND email_verified_at IS NOT NULL').get(email);
    if (!user) {
      // 时序防御：即使未找到也执行 bcrypt（与登录路径一致的防御策略）
      try { await bcrypt.compare('timing-defense', '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy'); } catch {}
      return jsonResponse(res, { ok: true, message: '如果该邮箱已注册，重置邮件已发送' });
    }

    const resetToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(resetToken).digest('hex');
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();

    try {
      const doForgot = db.transaction(() => {
        db.prepare('UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0').run(user.id);
        db.prepare('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)').run(user.id, tokenHash, expiresAt);
      });
      doForgot();
    } catch (err) {
      console.error('[forgot-pw] transaction failed:', err.message);
      return jsonResponse(res, { error: '操作失败，请稍后再试' }, 500);
    }

    const resetLink = `${SITE_URL}/reset-password?token=${resetToken}`;
    const isDev = process.env.NODE_ENV === 'development';

    if (isDev) {
      console.log('[DEV] 重置密码链接:', resetLink);
      return jsonResponse(res, { ok: true, message: `[DEV] 重置链接已打印到控制台` });
    }

    // 生产环境必须配置 SMTP
    if (!process.env.SMTP_PASS) {
      console.error('[forgot-pw] SMTP_PASS not configured in production');
      return jsonResponse(res, { error: '邮件服务未配置，请稍后再试' }, 500);
    }

    try {
      await transporter.sendMail({
        from: SMTP_SENDER,
        to: email,
        subject: '重置你的密码 - 明日方舟猜干员',
        html: `<div style="max-width:480px;margin:0 auto;font-family:sans-serif"><h2>重置密码</h2><p>你好 ${user.username}，我们收到了重置密码的请求。</p><p>点击下方按钮设置新密码：</p><a href="${resetLink}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none;font-weight:bold">重置密码</a><p style="color:#666;margin-top:20px;font-size:0.85rem">或者复制此链接到浏览器：<br>${resetLink}</p><p style="color:#999;font-size:0.8rem">此链接1小时内有效。如果你没有请求重置密码，请忽略此邮件。</p></div>`,
      });
      console.log(`[forgot-pw] sent to ${user.username} (${email})`);
    } catch (err) {
      console.error('[forgot-pw] email error:', err.message);
      return jsonResponse(res, { ok: true, message: '如果该邮箱已注册，重置邮件已发送' });
    }

    return jsonResponse(res, { ok: true, message: '如果该邮箱已注册，重置邮件已发送' });
  }

  // ===== POST /api/reset-password =====
  async function handleResetPassword(req, res, ip) {
    if (!checkRateLimit(`reset:${ip}`, 5, 900_000)) {
      return jsonResponse(res, { error: '请求过于频繁，请15分钟后再试' }, 429);
    }

    const body = await parseBody(req);
    const token = sanitizeString(body.token, 128);
    const newPassword = typeof body.password === 'string' ? body.password : '';

    if (!token || !newPassword) {
      return jsonResponse(res, { error: '缺少 token 或新密码' }, 400);
    }
    if (newPassword.length < 8) {
      return jsonResponse(res, { error: '密码至少需要8个字符' }, 400);
    }

    const tokenHash = createHash('sha256').update(token).digest('hex');
    const record = db.prepare('SELECT id, user_id, expires_at, used FROM password_resets WHERE token_hash = ?').get(tokenHash);

    // 前置检查：尽早拒绝明显无效的请求（事务内仍会做最终原子检查）
    if (!record) return jsonResponse(res, { error: '无效的重置链接' }, 400);
    if (record.used) return jsonResponse(res, { error: '此重置链接已被使用' }, 400);
    if (new Date(record.expires_at) < new Date()) {
      return jsonResponse(res, { error: '重置链接已过期，请重新申请' }, 400);
    }

    let passwordHash;
    try {
      passwordHash = await bcrypt.hash(newPassword, 10);
    } catch (err) {
      console.error('[reset-pw] bcrypt.hash error:', err.message);
      return jsonResponse(res, { error: '服务器内部错误，请稍后再试' }, 500);
    }

    try {
      const doReset = db.transaction(() => {
        // 原子检查：AND used = 0 防止并发重复消费同一 token
        const updRes = db.prepare('UPDATE password_resets SET used = 1 WHERE id = ? AND used = 0').run(record.id);
        if (updRes.changes === 0) {
          throw new Error('TOKEN_ALREADY_USED');
        }
        db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(passwordHash, record.user_id);
      });
      doReset();
    } catch (err) {
      if (err.message === 'TOKEN_ALREADY_USED') {
        return jsonResponse(res, { error: '此重置链接已被使用' }, 400);
      }
      console.error('[reset-pw] transaction failed:', err.message);
      return jsonResponse(res, { error: '密码重置失败，请稍后重试' }, 500);
    }

    console.log(`[reset-pw] user=${record.user_id} password changed`);
    return jsonResponse(res, { ok: true, message: '密码重置成功，请使用新密码登录' });
  }

  // ===== POST /api/logout =====
  async function handleLogout(req, res) {
    const clearCookies = [
      'token=; SameSite=None; Secure; HttpOnly; Path=/; Max-Age=0',
      'player_key=; SameSite=Lax; Secure; Path=/; Max-Age=0; HttpOnly',
    ];
    return jsonResponse(res, { ok: true }, 200, { 'Set-Cookie': clearCookies });
  }

  // ===== 导出路由处理器 =====
  return {
    handleRegister,
    handleLogin,
    handleAuthCookie,
    handleVerifyEmail,
    handleForgotPassword,
    handleResetPassword,
    handleLogout,
  };
}
