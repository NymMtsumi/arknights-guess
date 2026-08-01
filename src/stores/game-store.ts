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
    const { status, target, guesses, remainingGuesses } = get();
    if (status !== 'playing' || !target) {
      return { success: false, error: 'Game not in progress' };
    }

    // 查找角色
    const guessedChar = findCharacterByName(characters, name);
    if (!guessedChar) {
      return { success: false, error: 'Character not found' };
    }

    // 检查是否已经猜过
    const alreadyGuessed = guesses.some(g => g.character.id === guessedChar.id);
    if (alreadyGuessed) {
      return { success: false, error: 'Already guessed this character' };
    }

    // 创建猜测结果
    const result = makeGuess(target, guessedChar);
    const newGuesses = [...guesses, result];
    const newRemaining = remainingGuesses - 1;

    // 检查游戏是否结束
    if (isWin(target, guessedChar)) {
      set({ guesses: newGuesses, remainingGuesses: newRemaining, status: 'won' });
    } else if (newRemaining <= 0) {
      set({ guesses: newGuesses, remainingGuesses: 0, status: 'lost' });
    } else {
      set({ guesses: newGuesses, remainingGuesses: newRemaining });
    }

    return { success: true };
  },

  giveUp: () => {
    const { status } = get();
    if (status !== 'playing') return;
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
