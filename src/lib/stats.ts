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
}

const STATS_KEY = 'arknights-guess-stats';
const HISTORY_KEY = 'arknights-guess-history';
const MAX_HISTORY = 80;

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

function isValidGameRecord(r: unknown): r is GameRecord {
  if (!r || typeof r !== 'object') return false;
  const rec = r as Record<string, unknown>;
  return typeof rec.timestamp === 'number' &&
    typeof rec.targetName === 'string' &&
    typeof rec.won === 'boolean' &&
    typeof rec.guessCount === 'number' &&
    typeof rec.difficulty === 'string';
}

export function loadHistory(): GameRecord[] {
  if (typeof window === 'undefined') return [];
  try {
    const stored = localStorage.getItem(HISTORY_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.every(isValidGameRecord)) return parsed;
      console.warn('[Stats] Invalid history shape in localStorage, resetting to defaults');
    }
  } catch (err) {
    console.warn('[Stats] Failed to load history from localStorage:', err);
  }
  return [];
}

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

  // 保存历史
  const history = loadHistory();
  console.log('[Stats] Saving game:', { won, guessCount, difficulty, targetName, historyBefore: history.length });
  history.unshift({
    timestamp: Date.now(),
    targetName,
    won,
    guessCount,
    difficulty,
  });
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch (err) { console.warn('[Stats] Failed to save history:', err); }
}
