export interface StatsData {
  totalGames: number;
  wins: number;
  losses: number;
  totalGuesses: number;
  bestScore: number;
}

const STORAGE_KEY = 'arknights-guess-stats';

export function loadStats(): StatsData {
  if (typeof window === 'undefined') return { totalGames: 0, wins: 0, losses: 0, totalGuesses: 0, bestScore: 0 };
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return JSON.parse(stored);
  } catch { /* ignore */ }
  return { totalGames: 0, wins: 0, losses: 0, totalGuesses: 0, bestScore: 0 };
}

export function saveGameStats(won: boolean, guessCount: number) {
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
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(stats)); } catch { /* ignore */ }
}
