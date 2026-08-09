import { create } from 'zustand';
import type { Character, Difficulty, GameStatus, GuessResult } from '@/types/character';
import { makeGuess, pickTarget, findCharacterByName, isWin } from '@/lib/game-engine';
import charactersData from '@/data/characters.json';

const MAX_GUESSES = 8;
const ANTI_REPEAT = 5;
const RECENT_KEY = 'arknights-recent-targets';
const characters: Character[] = charactersData as Character[];

function getRecentTargets(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const stored = localStorage.getItem(RECENT_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch { return []; }
}

function addRecentTarget(id: string) {
  const recent = getRecentTargets();
  recent.unshift(id);
  if (recent.length > ANTI_REPEAT) recent.length = ANTI_REPEAT;
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent)); } catch {}
}

interface GameState {
  status: GameStatus;
  target: Character | null;
  guesses: GuessResult[];
  remainingGuesses: number;
  difficulty: Difficulty;

  startGame: (difficulty: Difficulty) => void;
  submitGuess: (name: string) => { success: boolean; error?: string };
  giveUp: () => void;
  resetGame: () => void;
}

export const useGameStore = create<GameState>((set, get) => ({
  status: 'idle',
  target: null,
  guesses: [],
  remainingGuesses: MAX_GUESSES,
  difficulty: 'medium',

  startGame: (difficulty: Difficulty) => {
    // 防止在游戏进行中重复开始（如双击按钮）
    if (get().status === 'playing') return;

    const target = pickTarget(characters, difficulty, getRecentTargets());
    addRecentTarget(target.id);
    set({
      status: 'playing',
      target,
      guesses: [],
      remainingGuesses: MAX_GUESSES,
      difficulty,
    });
  },

  submitGuess: (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) {
      return { success: false, error: 'Character not found' };
    }

    const guessedChar = findCharacterByName(characters, trimmed);
    if (!guessedChar) {
      return { success: false, error: 'Character not found' };
    }

    // Pre-check state（常见单线程路径，可返回明确错误）
    const current = get();
    if (current.status !== 'playing' || !current.target) {
      return { success: false, error: 'Game not in progress' };
    }
    if (current.guesses.some(g => g.character.id === guessedChar.id)) {
      return { success: false, error: 'Already guessed this character' };
    }

    const target = current.target;
    const result = makeGuess(target, guessedChar);
    const won = isWin(target, guessedChar);

    // 函数式 updater 防止并发 submitGuess 覆盖彼此的状态
    set((state) => {
      if (state.status !== 'playing' || !state.target) return state;
      // 二次校验：防止并发时同一角色被提交两次
      if (state.guesses.some(g => g.character.id === guessedChar.id)) return state;

      const newGuesses = [...state.guesses, result];
      const newRemaining = state.remainingGuesses - 1;

      if (won) {
        return { ...state, guesses: newGuesses, remainingGuesses: newRemaining, status: 'won' };
      }
      if (newRemaining <= 0) {
        return { ...state, guesses: newGuesses, remainingGuesses: 0, status: 'lost' };
      }
      return { ...state, guesses: newGuesses, remainingGuesses: newRemaining };
    });

    return { success: true };
  },

  giveUp: () => {
    const { status, target } = get();
    if (status !== 'playing' || !target) return;
    set({ status: 'lost' });
  },

  resetGame: () => {
    set({
      status: 'idle',
      target: null,
      guesses: [],
      remainingGuesses: MAX_GUESSES,
      difficulty: 'medium',
    });
  },
}));
