// 鉴权模块：JWT、requireAuth、requireAdmin、频率限制
import jwt from 'jsonwebtoken';

export function createAuth({ db, JWT_SECRET }) {
  // ===== JWT =====
  function signToken(payload) {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
  }

  function verifyToken(token) {
    try {
      return jwt.verify(token, JWT_SECRET);
    } catch {
      return null;
    }
  }

  // ===== 鉴权中间件 =====
  function requireAuth(req, res) {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      jsonResponse(res, { error: '未登录，请先登录' }, 401);
      return null;
    }
    const decoded = verifyToken(authHeader.slice(7));
    if (!decoded) {
      jsonResponse(res, { error: '登录已过期，请重新登录' }, 401);
      return null;
    }
    const user = db.prepare('SELECT banned_at, token_version FROM users WHERE id = ?').get(decoded.userId);
    if (!user) {
      jsonResponse(res, { error: '用户不存在' }, 401);
      return null;
    }
    if (user.banned_at) {
      jsonResponse(res, { error: '账号已被封禁' }, 403);
      return null;
    }
    if ((decoded.tokenVersion || 0) !== (user.token_version || 0)) {
      jsonResponse(res, { error: '密码已更改，请重新登录' }, 401);
      return null;
    }
    return decoded;
  }

  function requireAdmin(req, res) {
    const user = requireAuth(req, res);
    if (!user) return null;
    const row = db.prepare('SELECT role FROM users WHERE id = ?').get(user.userId);
    if (!row || row.role !== 'admin') {
      jsonResponse(res, { error: '无管理员权限' }, 403);
      return null;
    }
    return user;
  }

  // ===== 频率限制（内存） =====
  const rateLimitStore = new Map();

  function checkRateLimit(key, maxRequests, windowMs) {
    const now = Date.now();
    let entry = rateLimitStore.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      rateLimitStore.set(key, entry);
    }
    entry.count++;
    return entry.count <= maxRequests;
  }

  // 定期清理过期记录
  const _rlCleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimitStore) {
      if (now > entry.resetAt) rateLimitStore.delete(key);
    }
  }, 120_000);

  return { signToken, verifyToken, requireAuth, requireAdmin, checkRateLimit, _rlCleanupInterval };
}

// 需要从 utils.js 的 jsonResponse（循环引用问题，在 index.js 中解决）
import { jsonResponse } from './utils.js';
