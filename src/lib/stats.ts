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
const MAX_HISTORY = 20;

export function loadStats(): StatsData {
  if (typeof window === 'undefined') return { totalGames: 0, wins: 0, losses: 0, totalGuesses: 0, bestScore: 0 };
  try {
    const stored = localStorage.getItem(STATS_KEY);
    if (stored) return JSON.parse(stored);
  } catch { /* ignore */ }
  return { totalGames: 0, wins: 0, losses: 0, totalGuesses: 0, bestScore: 0 };
}

export function loadHistory(): GameRecord[] {
  if (typeof window === 'undefined') return [];
  try {
    const stored = localStorage.getItem(HISTORY_KEY);
    if (stored) return JSON.parse(stored);
  } catch { /* ignore */ }
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
  try { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); } catch { /* ignore */ }

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
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch { /* ignore */ }
}
