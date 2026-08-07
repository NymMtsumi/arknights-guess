import { getServerUrl, getToken, getPlayerKey } from './auth';

export interface StatsData {
  totalGames: number;
  wins: number;
  losses: number;
  totalGuesses: number;
  bestScore: number;
}

export interface GameRecord {
  timestamp: number;
  targetName: string;
  won: boolean;
  guessCount: number;
  difficulty: string;
  player_key?: string; // 游戏时的 pk，用于迁移过滤，防止数据串乱
}

export interface MultiRoundResult {
  targetName: string;
  won: boolean;        // 该小局是否获胜
  guessCount: number;
}

export interface MultiGameRecord {
  timestamp: number;
  mode: 'multi';
  won: boolean;         // 整场比赛是否获胜
  bestOf: number;
  myScore: number;
  opponentScore: number;
  opponentName: string;
  rounds: MultiRoundResult[];
  player_key?: string; // 游戏时的 pk，用于迁移过滤，防止数据串乱
}

export type HistoryRecord = GameRecord | MultiGameRecord;

const STATS_KEY = 'arknights-guess-stats';
const HISTORY_KEY = 'arknights-guess-history';
const VERSION_KEY = 'arknights-guess-data-version';
const MAX_HISTORY = 80;

// 当前数据格式版本（递增此值以触发客户端迁移）
const CURRENT_DATA_VERSION = 2;

/** 检测并迁移旧版数据到当前版本 */
function migrateData(): void {
  if (typeof window === 'undefined') return;
  try {
    const storedVersion = parseInt(localStorage.getItem(VERSION_KEY) || '0', 10);
    if (storedVersion >= CURRENT_DATA_VERSION) return;

    console.log(`[DataMigration] v${storedVersion} → v${CURRENT_DATA_VERSION}, migrating...`);

    // v0 → v1: 无版本号 → 首次标记
    // v1 → v2: 旧版 stats/history 格式兼容
    //   - 修复 stats 中某些字段可能为字符串的问题
    //   - 修复 history 中可能缺少字段的旧记录
    if (storedVersion < 2) {
      // 迁移 stats
      try {
        const rawStats = localStorage.getItem(STATS_KEY);
        if (rawStats) {
          const stats = JSON.parse(rawStats);
          if (stats && typeof stats === 'object') {
            // 确保所有字段都是数字
            stats.totalGames = Number(stats.totalGames) || 0;
            stats.wins = Number(stats.wins) || 0;
            stats.losses = Number(stats.losses) || 0;
            stats.totalGuesses = Number(stats.totalGuesses) || 0;
            stats.bestScore = Number(stats.bestScore) || 0;
            localStorage.setItem(STATS_KEY, JSON.stringify(stats));
          }
        }
      } catch {}

      // 迁移 history
      try {
        const rawHistory = localStorage.getItem(HISTORY_KEY);
        if (rawHistory) {
          const history = JSON.parse(rawHistory);
          if (Array.isArray(history)) {
            const migrated = history
              .filter(r => r && typeof r === 'object')
              .map((r: any) => {
                // 转换旧字段（如果缺失）
                return {
                  timestamp: Number(r.timestamp) || Date.now(),
                  won: Boolean(r.won),
                  guessCount: Number(r.guessCount) || 0,
                  difficulty: String(r.difficulty || 'hard'),
                  targetName: String(r.targetName || r.name || ''),
                  // 保留多人字段（如果存在）
                  ...(r.mode === 'multi' ? {
                    mode: 'multi' as const,
                    bestOf: Number(r.bestOf) || 0,
                    myScore: Number(r.myScore) || 0,
                    opponentScore: Number(r.opponentScore) || 0,
                    opponentName: String(r.opponentName || ''),
                    rounds: Array.isArray(r.rounds) ? r.rounds.map((rd: any) => ({
                      targetName: String(rd.targetName || ''),
                      won: Boolean(rd.won),
                      guessCount: Number(rd.guessCount) || 0,
                    })) : [],
                  } : {}),
                };
              })
              .slice(0, MAX_HISTORY);
            localStorage.setItem(HISTORY_KEY, JSON.stringify(migrated));
          }
        }
      } catch {}
    }

    // 标记当前版本
    localStorage.setItem(VERSION_KEY, String(CURRENT_DATA_VERSION));
    console.log(`[DataMigration] Migration to v${CURRENT_DATA_VERSION} complete`);
  } catch (err) {
    console.warn('[DataMigration] Migration error:', err);
  }
}

// 初始化时执行迁移
if (typeof window !== 'undefined') {
  migrateData();
}

function isValidStatsData(data: unknown): data is StatsData {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return typeof d.totalGames === 'number' &&
    typeof d.wins === 'number' &&
    typeof d.losses === 'number' &&
    typeof d.totalGuesses === 'number' &&
    typeof d.bestScore === 'number';
}

export function loadStats(): StatsData {
  if (typeof window === 'undefined') return { totalGames: 0, wins: 0, losses: 0, totalGuesses: 0, bestScore: 0 };
  try {
    const stored = localStorage.getItem(STATS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (isValidStatsData(parsed)) return parsed;
      console.warn('[Stats] Invalid stats shape in localStorage, resetting to defaults');
    }
  } catch (err) {
    console.warn('[Stats] Failed to load stats from localStorage:', err);
  }
  return { totalGames: 0, wins: 0, losses: 0, totalGuesses: 0, bestScore: 0 };
}

function isValidRecord(r: unknown): r is HistoryRecord {
  if (!r || typeof r !== 'object') return false;
  const rec = r as Record<string, unknown>;
  // MultiGameRecord check
  if (rec.mode === 'multi') {
    return typeof rec.timestamp === 'number' &&
      typeof rec.won === 'boolean' &&
      typeof rec.bestOf === 'number' &&
      typeof rec.myScore === 'number' &&
      typeof rec.opponentScore === 'number' &&
      typeof rec.opponentName === 'string' &&
      Array.isArray(rec.rounds) &&
      rec.rounds.every((rd: any) =>
        typeof rd.targetName === 'string' &&
        typeof rd.won === 'boolean' &&
        typeof rd.guessCount === 'number'
      );
  }
  // Single GameRecord check
  return typeof rec.timestamp === 'number' &&
    typeof rec.won === 'boolean' &&
    typeof rec.guessCount === 'number' &&
    typeof rec.difficulty === 'string';
}

function isValidGameRecord(r: unknown): r is GameRecord {
  if (!r || typeof r !== 'object') return false;
  const rec = r as Record<string, unknown>;
  return typeof rec.timestamp === 'number' &&
    typeof rec.won === 'boolean' &&
    typeof rec.guessCount === 'number' &&
    typeof rec.difficulty === 'string' &&
    typeof rec.targetName === 'string';
}

/**
 * 合并本地历史和服务端历史，按 timestamp 降序排序并去重。
 * 始终以有效记录数多的数据源为准，缺失的用另一个数据源补齐。
 */
export function mergeHistories(local: HistoryRecord[], server: HistoryRecord[]): HistoryRecord[] {
  // 以更长的数据源为主体
  const primary = local.length >= server.length ? local : server;
  const secondary = local.length >= server.length ? server : local;

  const seen = new Set<string>();
  const result: HistoryRecord[] = [];

  for (const r of primary) {
    const key = `${r.timestamp}-${(r as any).mode || 'single'}-${(r as GameRecord).targetName || (r as MultiGameRecord).opponentName || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(r);
  }

  for (const r of secondary) {
    const key = `${r.timestamp}-${(r as any).mode || 'single'}-${(r as GameRecord).targetName || (r as MultiGameRecord).opponentName || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(r);
  }

  // 按时间戳降序排列
  result.sort((a, b) => b.timestamp - a.timestamp);

  // 限制最大条数
  if (result.length > MAX_HISTORY) {
    return result.slice(0, MAX_HISTORY);
  }
  return result;
}

export function loadHistory(): HistoryRecord[] {
  if (typeof window === 'undefined') return [];
  try {
    const stored = localStorage.getItem(HISTORY_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        // 逐个校验每条记录，过滤掉不合法的而非全部丢弃
        const valid = parsed.filter(isValidRecord);
        if (valid.length < parsed.length) {
          console.warn(`[Stats] ${parsed.length - valid.length} invalid record(s) filtered out, saving cleaned history`);
          // 写回清洗后的数据
          try { localStorage.setItem(HISTORY_KEY, JSON.stringify(valid)); } catch {}
        }
        return valid;
      }
      console.warn('[Stats] History data is not an array, resetting to defaults');
    }
  } catch (err) {
    console.warn('[Stats] Failed to load history from localStorage:', err);
  }
  return [];
}

function saveHistory(record: HistoryRecord) {
  const history = loadHistory();
  console.log('[Stats] Saving record:', record);
  history.unshift(record);
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch (err) { console.warn('[Stats] Failed to save history:', err); }
}

/**
 * 把本地旧游客（无账号时）的游戏数据同步到服务端的指定 player_key。
 * 用于登录后迁移数据，调用 /api/sync 批量上传。
 */
export async function syncGames(playerKey: string, games: Array<{
  timestamp: string;
  targetName: string;
  won: boolean;
  guessCount: number;
  difficulty: string;
}>): Promise<{ synced: number }> {
  const base = getServerUrl();
  const token = getToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${base}/api/sync`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ player_key: playerKey, games }),
  });
  if (!res.ok) {
    console.warn(`[Stats] syncGames failed: HTTP ${res.status}`);
    return { synced: 0 };
  }
  return res.json();
}

export async function saveGameToServer(won: boolean, guessCount: number, difficulty: string, targetName: string): Promise<void> {
  if (typeof window === 'undefined') return;

  try {
    const base = getServerUrl();
    const token = getToken();
    const playerKey = getPlayerKey();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    // 发送 ISO 字符串格式的时间戳（服务端期望字符串）
    const res = await fetch(`${base}/api/save-game`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        player_key: playerKey,
        won,
        guessCount,
        difficulty,
        targetName,
        mode: 'single',
        timestamp: new Date(Date.now()).toISOString(),
      }),
    });

    if (res.ok) {
      console.log('[Stats] Game saved to server');
    } else {
      console.warn('[Stats] Server save-game returned non-ok:', res.status);
    }
  } catch (err) {
    console.warn('[Stats] Failed to save game to server:', err);
  }
}

/** 单人游戏存档 */
export function saveGameStats(won: boolean, guessCount: number, difficulty: string, targetName: string) {
  const stats = loadStats();
  stats.totalGames++;
  if (won) {
    stats.wins++;
    stats.totalGuesses += guessCount;
    if (stats.bestScore === 0 || guessCount < stats.bestScore) {
      stats.bestScore = guessCount;
    }
  } else {
    stats.losses++;
  }
  try { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); } catch (err) { console.warn('[Stats] Failed to save stats:', err); }

  saveHistory({
    timestamp: Date.now(),
    targetName,
    won,
    guessCount,
    difficulty,
    player_key: getPlayerKey() || undefined,
  });

  // Fire-and-forget server sync
  saveGameToServer(won, guessCount, difficulty, targetName).catch(() => {});
}

/** 多人比赛存档 */
export function saveMultiGameStats(result: {
  won: boolean;
  bestOf: number;
  myScore: number;
  opponentScore: number;
  opponentName: string;
  rounds: MultiRoundResult[];
}) {
  const stats = loadStats();
  stats.totalGames++;
  if (result.won) {
    stats.wins++;
    // 多人模式不计 bestScore（逻辑不适用）
  } else {
    stats.losses++;
  }
  try { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); } catch (err) { console.warn('[Stats] Failed to save stats:', err); }

  saveHistory({
    timestamp: Date.now(),
    mode: 'multi',
    won: result.won,
    bestOf: result.bestOf,
    myScore: result.myScore,
    opponentScore: result.opponentScore,
    opponentName: result.opponentName,
    rounds: result.rounds,
    player_key: getPlayerKey() || undefined,
  });

  // 同步到服务器
  saveMultiToServer(result).catch(() => {});
}

/** 从服务器获取游戏历史 */
export async function fetchHistoryFromServer(limit = 80): Promise<HistoryRecord[]> {
  if (typeof window === 'undefined') return [];
  try {
    const base = getServerUrl();
    const token = getToken();
    if (!token) return [];

    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
    const res = await fetch(`${base}/api/history?limit=${limit}`, { headers });
    if (!res.ok) return [];
    const data = await res.json();
    if (Array.isArray(data.history)) {
      return data.history.map((r: any) => {
        if (r.mode === 'multi') {
          return {
            timestamp: r.timestamp,
            mode: 'multi' as const,
            won: r.won,
            bestOf: r.bestOf || 0,
            myScore: r.myScore || 0,
            opponentScore: r.opponentScore || 0,
            opponentName: r.opponentName || r.targetName || '',
            rounds: r.rounds || [],
          };
        }
        return {
          timestamp: r.timestamp,
          targetName: r.targetName || '',
          won: r.won,
          guessCount: r.guessCount || 0,
          difficulty: r.difficulty || 'hard',
        };
      });
    }
    return [];
  } catch (err) {
    console.warn('[Stats] Failed to fetch history from server:', err);
    return [];
  }
}

/** 检测是否为鉴权错误（401），供调用方处理过期登录 */
export function isAuthError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('登录已过期');
}

/** 多人比赛存档到服务器 */
async function saveMultiToServer(result: {
  won: boolean;
  bestOf: number;
  myScore: number;
  opponentScore: number;
  opponentName: string;
  rounds: MultiRoundResult[];
}) {
  if (typeof window === 'undefined') return;
  try {
    const base = getServerUrl();
    const token = getToken();
    const playerKey = getPlayerKey();

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    await fetch(`${base}/api/save-game`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        player_key: playerKey,
        won: result.won,
        guessCount: result.rounds.reduce((sum, r) => sum + r.guessCount, 0),
        difficulty: 'multi',
        targetName: result.opponentName,
        mode: 'multi',
        timestamp: new Date(Date.now()).toISOString(),
      }),
    });
  } catch (err) {
    console.warn('[Stats] Failed to save multi game to server:', err);
  }
}
