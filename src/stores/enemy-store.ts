import { create } from 'zustand';
import type { Enemy, EnemyDifficulty, EnemyGuessResult } from '@/types/enemy';
import { makeEnemyGuess, findEnemyByName, isEnemyWin, getEnemyPoolByDifficulty } from '@/lib/enemy-engine';
import enemiesData from '@/data/enemy-characters.json';
import { apiCall } from '@/lib/auth';

const MAX_GUESSES: Record<EnemyDifficulty, number> = {
  easy: 15,
  normal: 15,
  hard: 15,
};

const enemies: Enemy[] = enemiesData as Enemy[];

type EnemyStatus = 'idle' | 'playing' | 'won' | 'lost' | 'error';

interface EnemyState {
  status: EnemyStatus;
  target: Enemy | null;
  guesses: EnemyGuessResult[];
  remainingGuesses: number;
  difficulty: EnemyDifficulty;
  error: string | null;

  startGame: (difficulty: EnemyDifficulty, targetOverride?: Enemy) => void;
  submitGuess: (name: string) => { success: boolean; error?: string };
  giveUp: () => void;
  reset: () => void;
}

export const useEnemyStore = create<EnemyState>((set, get) => ({
  status: 'idle',
  target: null,
  guesses: [],
  remainingGuesses: MAX_GUESSES.hard,
  difficulty: 'hard',
  error: null,

  startGame: (difficulty: EnemyDifficulty, targetOverride?: Enemy) => {
    const pool = getEnemyPoolByDifficulty(enemies, difficulty);
    if (pool.length === 0) {
      set({ status: 'error', error: '无法加载敌人数据' });
      return;
    }
    const target = targetOverride || pool[Math.floor(Math.random() * pool.length)];
    set({
      status: 'playing',
      target,
      guesses: [],
      remainingGuesses: MAX_GUESSES[difficulty],
      difficulty,
      error: null,
    });
  },

  submitGuess: (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) {
      return { success: false, error: '未找到该敌人' };
    }

    const guessed = findEnemyByName(enemies, trimmed);
    if (!guessed) {
      return { success: false, error: '未找到该敌人' };
    }

    const current = get();
    if (current.status !== 'playing' || !current.target) {
      return { success: false, error: '游戏未在进行中' };
    }
    if (current.guesses.some(g => g.enemy.id === guessed.id)) {
      return { success: false, error: '已猜过该敌人' };
    }

    const result = makeEnemyGuess(current.target, guessed);
    const won = isEnemyWin(current.target, guessed);

    set((state) => {
      if (state.status !== 'playing' || !state.target) return state;
      if (state.guesses.some(g => g.enemy.id === guessed.id)) return state;

      const newGuesses = [...state.guesses, result];
      const newRemaining = state.remainingGuesses - 1;

      if (won) return { ...state, guesses: newGuesses, remainingGuesses: newRemaining, status: 'won' };
      if (newRemaining <= 0) return { ...state, guesses: newGuesses, remainingGuesses: 0, status: 'lost' };
      return { ...state, guesses: newGuesses, remainingGuesses: newRemaining };
    });

    return { success: true };
  },

  giveUp: () => {
    const { status } = get();
    if (status !== 'playing') return;
    set({ status: 'lost' });
  },

  reset: () => {
    set({
      status: 'idle',
      target: null,
      guesses: [],
      remainingGuesses: MAX_GUESSES.hard,
      difficulty: 'hard',
      error: null,
    });
  },
}));
