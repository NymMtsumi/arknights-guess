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

export function getServerUrl(): string {
  if (typeof window !== 'undefined') {
    const wsUrl = process.env.NEXT_PUBLIC_WS_URL;
    if (wsUrl) {
      // 支持 https://, http://, wss://, ws:// 前缀
      if (wsUrl.startsWith('wss://')) return wsUrl.replace('wss://', 'https://');
      if (wsUrl.startsWith('ws://')) return wsUrl.replace('ws://', 'http://');
      if (wsUrl.startsWith('https://') || wsUrl.startsWith('http://')) return wsUrl;
      // 无协议前缀，假定为生产域名
      return 'https://' + wsUrl;
    }
    return 'http://localhost:3001';
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

export function getUser(): AuthUser | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = localStorage.getItem(USER_KEY);
    return stored ? JSON.parse(stored) : null;
  } catch { return null; }
}

export function setUser(user: AuthUser): void {
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(USER_KEY, JSON.stringify(user)); } catch {}
}

export function clearUser(): void {
  if (typeof window === 'undefined') return;
  try { localStorage.removeItem(USER_KEY); } catch {}
}

export function clearAuth(): void {
  clearToken();
  clearUser();
}

/** 检测是否为鉴权错误（401），供调用方处理过期登录 */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export async function apiCall(path: string, options: RequestInit = {}): Promise<any> {
  const base = getServerUrl();
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      ...options,
      headers,
    });
  } catch (fetchErr: any) {
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

// ===== 登录 =====
export async function login(username: string, password: string): Promise<{
  token: string; username: string; userId: number; role: string;
  nickname: string | null;
  player_key: string | null; email: string | null; email_verified: boolean;
}> {
  const data = await apiCall('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
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
    try { localStorage.setItem('player_key', data.player_key); } catch {}
    await migrateGuestDataToAccount(data.player_key);
  }

  return data;
}

/**
 * 登录后调用：把旧游客（无账号时）的本地战绩迁移到账号的 player_key 下。
 * 直接读取 localStorage 原始数据，通过 /api/sync 批量上传，避免引入循环依赖。
 */
export async function migrateGuestDataToAccount(accountPlayerKey: string): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    const HISTORY_KEY = 'arknights-guess-history';
    const rawHistory = localStorage.getItem(HISTORY_KEY);
    if (!rawHistory) return;

    const history = JSON.parse(rawHistory);
    if (!Array.isArray(history) || history.length === 0) return;

    // 提取所有单人战绩（mode !== 'multi'），转换为服务器格式
    const singleGames = history
      .filter((r: any) => r && r.mode !== 'multi' && typeof r.timestamp === 'number')
      .map((r: any) => ({
        timestamp: new Date(r.timestamp).toISOString(),
        targetName: String(r.targetName || ''),
        won: Boolean(r.won),
        guessCount: Number(r.guessCount) || 0,
        difficulty: String(r.difficulty || 'hard'),
      }));

    if (singleGames.length > 0) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const token = getToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const res = await fetch(`${getServerUrl()}/api/sync`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ player_key: accountPlayerKey, games: singleGames }),
      });

      if (res.ok) {
        const data = await res.json();
        console.log(`[Auth] Migrated ${data.synced || singleGames.length} guest game(s) to account`);
      }
    }

    // 多人战绩也同步
    const multiGames = history
      .filter((r: any) => r && r.mode === 'multi' && typeof r.timestamp === 'number')
      .map((r: any) => ({
        timestamp: new Date(r.timestamp).toISOString(),
        targetName: String(r.opponentName || ''),
        won: Boolean(r.won),
        guessCount: (Array.isArray(r.rounds) ? r.rounds.reduce((sum: number, rd: any) => sum + (Number(rd.guessCount) || 0), 0) : 0),
        difficulty: 'multi',
      }));

    if (multiGames.length > 0) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const token = getToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;

      // 多人战绩逐条保存（/api/save-game 对模式有单独校验）
      for (const g of multiGames) {
        await fetch(`${getServerUrl()}/api/save-game`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            player_key: accountPlayerKey,
            won: g.won,
            guessCount: g.guessCount,
            difficulty: 'multi',
            targetName: g.targetName,
            mode: 'multi',
            timestamp: g.timestamp,
          }),
        });
      }
      console.log(`[Auth] Migrated ${multiGames.length} guest multi-game(s) to account`);
    }
  } catch (err) {
    console.warn('[Auth] Guest data migration failed (non-critical):', err);
  }
}

// ===== 退出登录 =====
export function logout(): void {
  clearAuth();
}

// ===== 获取个人信息 =====
export async function fetchMe(): Promise<MeResponse> {
  return apiCall('/api/me');
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
// player_key cookie 是 HttpOnly，JS 无法读取，因此使用 localStorage
export function getPlayerKey(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = localStorage.getItem('player_key');
    if (stored) return stored;
  } catch {}
  // 兜底：尝试从 cookie 读取（非 HttpOnly 场景，如旧版本或开发环境）
  try {
    const match = document.cookie.split('; ').find(r => r.startsWith('player_key='));
    return match ? match.split('=')[1] : null;
  } catch {
    return null;
  }
}
