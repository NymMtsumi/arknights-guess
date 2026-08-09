import { create } from 'zustand';
import type { Character, GuessResult } from '@/types/character';
import { makeGuess, findCharacterByName, isWin, pickDailyTarget } from '@/lib/game-engine';
import charactersData from '@/data/characters.json';
import { getServerUrl, getToken } from '@/lib/auth';

const MAX_GUESSES = 8;
const characters: Character[] = charactersData as Character[];

export interface DailyResult {
  won: boolean;
  guessCount: number;
  timestamp: string;
}

type DailyStatus = 'loading' | 'already-played' | 'playing' | 'won' | 'lost';

interface DailyState {
  status: DailyStatus;
  target: Character | null;
  guesses: GuessResult[];
  remainingGuesses: number;
  previousResult: DailyResult | null;
  dailyDate: string;

  initDaily: () => Promise<void>;
  submitGuess: (name: string) => { success: boolean; error?: string };
  giveUp: () => void;
}

export const useDailyStore = create<DailyState>((set, get) => ({
  status: 'loading',
  target: null,
  guesses: [],
  remainingGuesses: MAX_GUESSES,
  previousResult: null,
  dailyDate: '',

  initDaily: async () => {
    set({ status: 'loading' });

    try {
      const base = getServerUrl();
      const token = getToken();
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const res = await fetch(`${base}/api/daily/status`, { headers });
      const data = await res.json();

      if (data.played) {
        const target = findCharacterByName(characters, data.targetName) || null;
        set({
          status: 'already-played',
          target,
          previousResult: data.result,
          dailyDate: data.date,
        });
        return;
      }

      // 客户端也用确定性算法计算目标，作为 UI 预览（服务端权威验证）
      const target = pickDailyTarget(characters, 'hard');

      // 防御性检查：如果客户端与服务器目标不一致，以服务器为准
      if (target.id !== data.targetId) {
        console.warn('[Daily] Client-server target mismatch, using server target');
        const serverTarget = findCharacterByName(characters, data.targetName);
        if (serverTarget) {
          set({
            status: 'playing',
            target: serverTarget,
            guesses: [],
            remainingGuesses: MAX_GUESSES,
            dailyDate: data.date,
          });
          return;
        }
      }

      set({
        status: 'playing',
        target,
        guesses: [],
        remainingGuesses: MAX_GUESSES,
        dailyDate: data.date,
      });
    } catch (err) {
      console.error('[Daily] Failed to initialize:', err);
      // 降级：纯客户端模式（服务端不可用时仍可玩）
      const target = pickDailyTarget(characters, 'hard');
      set({
        status: 'playing',
        target,
        guesses: [],
        remainingGuesses: MAX_GUESSES,
        dailyDate: new Date().toISOString().slice(0, 10),
      });
    }
  },

  submitGuess: (name: string) => {
    const { status, target, guesses, remainingGuesses } = get();
    if (status !== 'playing' || !target) {
      return { success: false, error: '游戏未在进行中' };
    }

    const guessedChar = findCharacterByName(characters, name);
    if (!guessedChar) {
      return { success: false, error: '未找到该干员' };
    }

    const alreadyGuessed = guesses.some(g => g.character.id === guessedChar.id);
    if (alreadyGuessed) {
      return { success: false, error: '已猜过该干员' };
    }

    const result = makeGuess(target, guessedChar);
    const newGuesses = [...guesses, result];
    const newRemaining = remainingGuesses - 1;

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
}));
