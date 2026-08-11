'use client';

const TOKEN_KEY = 'arknights-auth-token';
const USER_KEY = 'arknights-auth-user';

export interface AuthUser {
  username: string;
  userId: number;
  displayId?: string;
  email?: string;
  nickname?: string;
  role?: string;
}

export interface ServerStats {
  totalGames: number;
  wins: number;
  losses: number;
  totalGuesses: number;
  bestScore: number;
}

export interface MeResponse {
  username: string;
  displayId: string | null;
  nickname: string | null;
  player_key: string | null;
  email: string | null;
  email_verified: boolean;
  role: string;
  created_at: string;
  stats: ServerStats;
}

let _cachedServerUrl: string | null = null;

export function getServerUrl(): string {
  if (_cachedServerUrl) return _cachedServerUrl;
  if (typeof window !== 'undefined') {
    const wsUrl = process.env.NEXT_PUBLIC_WS_URL;
    let url: string;
    if (wsUrl) {
      // 支持 https://, http://, wss://, ws:// 前缀
      if (wsUrl.startsWith('wss://')) url = wsUrl.replace('wss://', 'https://');
      else if (wsUrl.startsWith('ws://')) url = wsUrl.replace('ws://', 'http://');
      else if (wsUrl.startsWith('https://') || wsUrl.startsWith('http://')) url = wsUrl;
      // 无协议前缀，假定为生产域名
      else url = 'https://' + wsUrl;
    } else {
      // Runtime warning: env var missing in production (not localhost)
      const hostname = window.location.hostname;
      if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
        console.error('[Auth] NEXT_PUBLIC_WS_URL is not set! API calls will fail. Set NEXT_PUBLIC_WS_URL in .env.local');
      }
      url = 'http://localhost:3001';
    }
    // Strip trailing slashes to prevent double slashes in API paths
    _cachedServerUrl = url.replace(/\/+$/, '');
    return _cachedServerUrl;
  }
  return 'http://localhost:3001';
}

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

export function setToken(token: string): void {
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(TOKEN_KEY, token); } catch {}
}

export function clearToken(): void {
  if (typeof window === 'undefined') return;
  try { localStorage.removeItem(TOKEN_KEY); } catch {}
}

let _cachedUser: AuthUser | null = null;
let _cachedUserFetched = false;

export function getUser(): AuthUser | null {
  if (typeof window === 'undefined') return null;
  if (_cachedUserFetched) return _cachedUser;
  _cachedUserFetched = true;
  try {
    const stored = localStorage.getItem(USER_KEY);
    _cachedUser = stored ? JSON.parse(stored) : null;
    return _cachedUser;
  } catch { return null; }
}

export function setUser(user: AuthUser): void {
  if (typeof window === 'undefined') return;
  _cachedUser = user;
  _cachedUserFetched = true;
  try { localStorage.setItem(USER_KEY, JSON.stringify(user)); } catch {}
}

export function clearUser(): void {
  if (typeof window === 'undefined') return;
  _cachedUser = null;
  _cachedUserFetched = false;
  try { localStorage.removeItem(USER_KEY); } catch {}
}

export function clearAuth(): void {
  clearToken();
  clearUser();
}

/**
 * SECURITY NOTE: JWT stored in localStorage — readable by any JS on the page (XSS risk).
 * This is an inherent limitation of static export (no SSR for httpOnly cookies).
 * Mitigations layered:
 *   - Server sets token as HttpOnly cookie too (auto-sent with requests when credentials: 'include')
 *   - Server JWT expires in 30 days (cookie Max-Age also 30 days)
 *   - apiCall() and getAuthHeaders() warn when token is within 1 day of expiry
 *   - Server validates token_version on each request (password change = force logout)
 *
 * DO NOT switch to cookie-only auth — localStorage is required for Bearer token with static export.
 * The HttpOnly cookie serves as a secondary channel; apiCall uses the Authorization header from localStorage.
 */

/** Decode JWT payload without verification (client-side expiry check only) */
function decodeJwtPayload(token: string): { exp?: number; iat?: number } | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '==='.slice(0, (4 - base64.length % 4) % 4);
    const json = atob(padded);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Get auth headers for API requests (internal — use apiCall() instead).
 * Includes Bearer token from localStorage and warns if token is about to expire.
 */
function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
    // Warn if token expires within 1 day (86,400 seconds)
    const payload = decodeJwtPayload(token);
    if (payload?.exp) {
      const expiresAt = payload.exp * 1000; // JWT exp is in seconds
      const oneDayMs = 86_400_000;
      if (expiresAt - Date.now() < oneDayMs) {
        console.warn('[Auth] JWT token expires soon (within 1 day). Consider re-logging in.');
      }
    }
  }
  return headers;
}

/** 检测是否为鉴权错误（401），供调用方处理过期登录 */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * Centralized API caller. All server requests should go through this function.
 * @param path - API path starting with / (e.g. '/api/me')
 * @param options - fetch options; method defaults to 'GET'
 */
export async function apiCall<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const base = getServerUrl();
  const { method: optMethod, headers: optHeaders, ...restOptions } = options;
  const method = optMethod || 'GET';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((optHeaders as Record<string, string>) || {}),
    ...getAuthHeaders(), // 后展开覆盖，防止 caller 注入假 Authorization（authHeaders 仅含 Authorization）
  };

  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      ...restOptions,
      headers,
      credentials: 'include',
    });
  } catch (fetchErr: any) {
    // NOTE: Hardcoded Chinese error messages bypass i18n.
    // Acceptable trade-off: these are network/server errors where i18n context may be unavailable.
    throw new Error(fetchErr?.message === 'Failed to fetch'
      ? '网络连接失败，请刷新页面后重试'
      : (fetchErr?.message || '网络错误'));
  }

  let data: any;
  try {
    data = await res.json();
  } catch {
    // 非 JSON 响应（如 502/504 网关错误 HTML）
    throw new Error(`服务器错误 (${res.status})，请稍后再试`);
  }
  if (!res.ok) {
    if (res.status === 401) {
      throw new AuthError(data.error || '登录已过期，请重新登录');
    }
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

// ===== 注册 =====
// 不会自动登录——用户需要先去邮箱点击验证链接。
export async function register(username: string, password: string, email: string): Promise<{ ok: boolean; message: string }> {
  const data = await apiCall('/api/register', {
    method: 'POST',
    body: JSON.stringify({ username, password, email }),
  });
  return data;
}

// ===== 忘记密码 =====
export async function forgotPassword(email: string): Promise<{ ok: boolean; message: string }> {
  const data = await apiCall('/api/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
  return data;
}

// ===== 重置密码 =====
export async function resetPassword(token: string, password: string): Promise<{ ok: boolean; message: string }> {
  const data = await apiCall('/api/reset-password', {
    method: 'POST',
    body: JSON.stringify({ token, password }),
  });
  return data;
}

// ===== 登录 =====
// 仅支持邮箱登录
export async function login(identifier: string, password: string): Promise<{
  token: string; username: string; userId: number; role: string;
  nickname: string | null;
  player_key: string | null; email: string | null; email_verified: boolean;
}> {
  const data = await apiCall('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: identifier, password }),
  });
  setToken(data.token);
  setUser({
    username: data.username,
    userId: data.userId,
    displayId: data.displayId,
    email: data.email,
    nickname: data.nickname,
    role: data.role,
  });

  // 存储 player_key 到 localStorage（cookie 是 HttpOnly，JS 无法读取）
  if (data.player_key) {
    const oldGuestPk = getPlayerKey();
    try { localStorage.setItem('player_key', data.player_key); } catch {}

    // 回填旧游客 pk 的 ownerless 游戏（仅回填 user_id，不迁移 player_key！）
    if (oldGuestPk && oldGuestPk !== data.player_key) {
      try { await linkPlayerKey(oldGuestPk); } catch {}
    }

    // 上传本地未同步的单人游戏（以 user_id 写入）
    await migrateGuestDataToAccount(data.player_key, oldGuestPk || undefined);
  }

  return data;
}

/**
 * 登录后调用：把旧游客（无账号时）的本地战绩上传到服务器。
 * 服务端按 user_id（JWT 认证）写入，不再依赖 player_key 迁移，防止战绩串乱。
 * 迁移两类记录：
 *   1. ownerless（无 pk 标签）— 纯游客从未访问多人页面的情况
 *   2. 标记为 oldGuestPk 的记录 — 游客访问多人页面后被 socket 写入了 pk
 */
export async function migrateGuestDataToAccount(accountPlayerKey: string, oldGuestPk?: string): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    const HISTORY_KEY = 'arknights-guess-history';
    const rawHistory = localStorage.getItem(HISTORY_KEY);
    if (!rawHistory) return;

    const history = JSON.parse(rawHistory);
    if (!Array.isArray(history) || history.length === 0) return;

    // 迁移无 pk 的记录，以及标记为旧游客 pk 的记录（如 socket 写入的 pk）
    const ownerlessGames = history.filter((r: any) =>
      r && !r._migrating && (!r.player_key || (oldGuestPk && r.player_key === oldGuestPk))
    );

    if (ownerlessGames.length === 0) return;

    // 立即标记为"迁移中"，防止并发 tab 重复迁移
    // 覆盖所有匹配的记录（无 pk + 旧游客 pk），不仅是 !r.player_key 的
    let updated = history.map((r: any) => {
      if (!r || r._migrating) return r;
      // 已有 pk 且不是旧游客 pk 的记录跳过（属于其他账户）
      if (r.player_key && r.player_key !== oldGuestPk) return r;
      return { ...r, _migrating: accountPlayerKey };
    });
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(updated)); } catch {}

    // 收集成功迁移的记录索引，逐条标记（不再 all-or-nothing）
    const migratedIndices = new Set<number>();

    // 提取单人战绩（移除 headers，apiCall 内部处理认证）
    const singleGames = ownerlessGames
      .filter((r: any) => r.mode !== 'multi' && typeof r.timestamp === 'number')
      .map((r: any) => ({
        timestamp: new Date(r.timestamp).toISOString(),
        targetName: String(r.targetName || ''),
        won: Boolean(r.won),
        guessCount: Number(r.guessCount) || 0,
        difficulty: String(r.difficulty || 'hard'),
      }));

    if (singleGames.length > 0) {
      const data = await apiCall('/api/sync', {
        method: 'POST',
        body: JSON.stringify({ player_key: accountPlayerKey, games: singleGames }),
      });
      console.log(`[Auth] Migrated ${data.synced || singleGames.length} guest single game(s) to account`);
      // 标记所有单人记录为已迁移
      ownerlessGames.forEach((g, i) => {
        if (g.mode !== 'multi' && typeof g.timestamp === 'number') migratedIndices.add(i);
      });
    }

    // 多人战绩逐条保存，每条即刻标记（单条失败不中断其他保存）
    for (let i = 0; i < ownerlessGames.length; i++) {
      const g = ownerlessGames[i];
      if (g.mode !== 'multi' || typeof g.timestamp !== 'number') continue;

      try {
        await apiCall('/api/save-game', {
          method: 'POST',
          body: JSON.stringify({
            player_key: accountPlayerKey,
            won: Boolean(g.won),
            guessCount: Array.isArray(g.rounds) ? g.rounds.reduce((sum: number, rd: any) => sum + (Number(rd.guessCount) || 0), 0) : 0,
            difficulty: 'multi',
            targetName: String(g.opponentName || ''),
            mode: 'multi',
            timestamp: new Date(g.timestamp).toISOString(),
          }),
        });
        migratedIndices.add(i);
        console.log(`[Auth] Migrated multi-game #${i} to account`);
      } catch (err) {
        console.warn(`[Auth] Failed to migrate multi-game #${i}:`, (err as Error)?.message);
      }
    }

    // 逐条标记成功的记录（不再 all-or-nothing）
    if (migratedIndices.size > 0) {
      // 重新读取 localStorage（可能有其他 tab 写入）
      const currentRaw = localStorage.getItem(HISTORY_KEY);
      const currentHistory = currentRaw ? JSON.parse(currentRaw) : history;
      if (Array.isArray(currentHistory)) {
        // 通过内容匹配标记（用 timestamp + targetName + mode 作为唯一标识）
        const migratedSet = new Set<string>();
        for (const idx of migratedIndices) {
          const g = ownerlessGames[idx];
          migratedSet.add(`${g.timestamp}|${g.targetName}|${g.mode}`);
        }
        const finalHistory = currentHistory.map((r: any) => {
          // Skip records belonging to a different account (keep their player_key)
          if (!r || (r.player_key && r.player_key !== oldGuestPk)) return r;
          const key = `${r.timestamp}|${r.targetName}|${r.mode}`;
          if (migratedSet.has(key)) {
            const { _migrating, ...rest } = r;
            return { ...rest, player_key: accountPlayerKey };
          }
          // 清除 _migrating 标记（超时或失败的记录回退为可迁移状态）
          if (r._migrating === accountPlayerKey) {
            const { _migrating, ...rest } = r;
            return rest;
          }
          return r;
        });
        try { localStorage.setItem(HISTORY_KEY, JSON.stringify(finalHistory)); } catch {}
      }
    } else {
      // 完全失败：清除 _migrating 标记，恢复原状
      const currentRaw = localStorage.getItem(HISTORY_KEY);
      const currentHistory = currentRaw ? JSON.parse(currentRaw) : history;
      if (Array.isArray(currentHistory)) {
        const restored = currentHistory.map((r: any) => {
          if (r?._migrating === accountPlayerKey) {
            const { _migrating, ...rest } = r;
            return rest;
          }
          return r;
        });
        try { localStorage.setItem(HISTORY_KEY, JSON.stringify(restored)); } catch {}
      }
    }
  } catch (err) {
    console.warn('[Auth] Guest data migration failed (non-critical):', err);
  }
}

// ===== 退出登录 =====
export async function logout(): Promise<void> {
  const hadToken = !!getToken();
  // 通知服务器清除 HttpOnly cookies（token + player_key）
  try {
    const headers: Record<string, string> = {};
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    await fetch(`${getServerUrl()}/api/logout`, { method: 'POST', headers });
  } catch {}
  clearAuth();
  // 清除 player_key，防止登出后新游戏仍用旧 pk（导致数据归属错误）
  try { localStorage.removeItem('player_key'); } catch {}
  // Clear only server-synced data; guest-only data is preserved.
  // These keys must match the definitions in src/lib/stats.ts (HISTORY_KEY, STATS_KEY).
  if (hadToken) {
    try { localStorage.removeItem('arknights-guess-history'); } catch {}
    try { localStorage.removeItem('arknights-guess-stats'); } catch {}
  }
}

// ===== 获取个人信息 =====
export async function fetchMe(): Promise<MeResponse> {
  return apiCall('/api/me', { method: 'GET' });
}

// ===== 修改个人信息 =====
export async function updateProfile(data: { nickname?: string }): Promise<{
  username: string; nickname: string | null;
  email: string | null; email_verified: boolean; created_at: string;
}> {
  const result = await apiCall('/api/me', {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
  // 同步更新本地存储
  const user = getUser();
  if (user) {
    if (result.nickname !== undefined) user.nickname = result.nickname;
    setUser(user);
  }
  return result;
}

// ===== 游戏同步 =====
export async function syncGames(playerKey: string, games: Array<{
  timestamp: number;
  targetName: string;
  won: boolean;
  guessCount: number;
  difficulty: string;
}>): Promise<{ synced: number }> {
  return apiCall('/api/sync', {
    method: 'POST',
    body: JSON.stringify({ player_key: playerKey, games }),
  });
}

// ===== 关联 player_key =====
export async function linkPlayerKey(playerKey: string): Promise<void> {
  await apiCall('/api/link-player-key', {
    method: 'POST',
    body: JSON.stringify({ player_key: playerKey }),
  });
}

// ===== 获取 player_key =====
// player_key cookie 是 HttpOnly，JS 无法读取，因此唯一来源是 localStorage
// （登录/注册/set_cookie 事件会写入 localStorage；不使用 document.cookie 兜底，防止读到过期的 socket cookie）
export function getPlayerKey(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem('player_key');
  } catch {
    return null;
  }
}
