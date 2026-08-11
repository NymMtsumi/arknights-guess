import { create } from 'zustand';
import type { Character, GuessResult, GuessComparisons } from '@/types/character';
import { findCharacterByName } from '@/lib/game-engine';
import charactersData from '@/data/characters.json';
import { apiCall, getPlayerKey, AuthError } from '@/lib/auth';

const MAX_GUESSES = 8;
const characters: Character[] = charactersData as Character[];

export interface DailyResult {
  won: boolean;
  guessCount: number;
  timestamp: string;
  targetName?: string;
}

type DailyStatus = 'loading' | 'already-played' | 'playing' | 'won' | 'lost' | 'error';

/** 将服务端返回的 comparisons 对象转为 GuessResult 的 comparisons */
function toGuessComparisons(raw: Record<string, string>): GuessComparisons {
  const valid = ['correct', 'close', 'wrong'];
  const s = (v: string) => valid.includes(v) ? v as 'correct' | 'close' | 'wrong' : 'wrong';
  return {
    class: s(raw.class || 'wrong'),
    subclass: s(raw.subclass || 'wrong'),
    faction: s(raw.faction || 'wrong'),
    rarity: s(raw.rarity || 'wrong'),
    race: s(raw.race || 'wrong'),
    gender: s(raw.gender || 'wrong'),
    releaseYear: s(raw.releaseYear || 'wrong'),
    tags: s(raw.tags || 'wrong'),
    position: s(raw.position || 'wrong'),
  };
}

interface DailyState {
  status: DailyStatus;
  target: Character | null;          // null until revealed (win/loss/already-played)
  guesses: GuessResult[];
  remainingGuesses: number;
  previousResult: DailyResult | null;
  dailyDate: string;
  error: string | null;

  initDaily: () => Promise<void>;
  submitGuess: (name: string) => Promise<{ success: boolean; error?: string }>;
  giveUp: () => void;
}

export const useDailyStore = create<DailyState>((set, get) => ({
  status: 'loading',
  target: null,
  guesses: [],
  remainingGuesses: MAX_GUESSES,
  previousResult: null,
  dailyDate: '',
  error: null,

  initDaily: async () => {
    set({ status: 'loading', error: null });

    try {
      const data = await apiCall('/api/daily/status', { method: 'GET' });

      if (!data || typeof data.played !== 'boolean') {
        set({ status: 'error', error: '服务器响应异常，请稍后再试' });
        return;
      }

      if (data.played) {
        // 已完成：显示结果
        const target = (data.result?.targetName && findCharacterByName(characters, data.result.targetName)) || null;
        set({
          status: 'already-played',
          target,
          previousResult: data.result || null,
          dailyDate: data.date || '',
        });
        return;
      }

      // 未玩过：目标保密（服务器校验模式）
      if (data.inProgress) {
        // 恢复进行中的会话（刷新页面/重连场景）
        set({
          status: 'playing',
          target: null,       // 目标保密
          guesses: [],        // 服务端跟踪猜测历史，客户端用 guesses.length 做本地显示
          remainingGuesses: typeof data.remainingGuesses === 'number' ? data.remainingGuesses : MAX_GUESSES,
          dailyDate: data.date || '',
        });
      } else {
        // 全新游戏
        set({
          status: 'playing',
          target: null,
          guesses: [],
          remainingGuesses: MAX_GUESSES,
          dailyDate: data.date || '',
        });
      }
    } catch (err: any) {
      console.error('[Daily] Failed to initialize:', err);
      set({ status: 'error', error: err.message || '无法连接服务器，请稍后再试' });
    }
  },

  submitGuess: async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) {
      return { success: false, error: '请输入干员名称' };
    }

    const current = get();
    if (current.status !== 'playing') {
      return { success: false, error: '游戏未在进行中' };
    }

    // 本地先去重检查
    const guessedChar = findCharacterByName(characters, trimmed);
    if (!guessedChar) {
      return { success: false, error: '未找到该干员' };
    }
    if (current.guesses.some(g => g.character.id === guessedChar.id)) {
      return { success: false, error: '已猜过该干员' };
    }

    try {
      const data = await apiCall('/api/daily/guess', {
        method: 'POST',
        body: JSON.stringify({ name: trimmed, player_key: getPlayerKey() || '' }),
      });

      // 服务端返回了新的 player_key → 保存到 localStorage
      if (data.player_key && typeof data.player_key === 'string') {
        try { localStorage.setItem('player_key', data.player_key); } catch {}
      }

      // 构建 GuessResult
      const comparisons = toGuessComparisons(data.comparisons || {});
      const guessResult: GuessResult = {
        character: guessedChar,
        comparisons,
        timestamp: Date.now(),
      };

      if (data.won) {
        // 猜对了
        const target = findCharacterByName(characters, data.target.name);
        set((state) => ({
          ...state,
          guesses: [...state.guesses, guessResult],
          target,
          status: 'won',
        }));
        return { success: true };
      }

      if (data.lost) {
        // 次数用尽
        const target = findCharacterByName(characters, data.target.name);
        set((state) => ({
          ...state,
          guesses: [...state.guesses, guessResult],
          target,
          remainingGuesses: 0,
          status: 'lost',
        }));
        return { success: true };
      }

      // 继续游戏
      set((state) => ({
        ...state,
        guesses: [...state.guesses, guessResult],
        remainingGuesses: typeof data.remainingGuesses === 'number' ? data.remainingGuesses : state.remainingGuesses - 1,
      }));

      return { success: true };
    } catch (err: any) {
      // AuthError（401 登录过期）向上抛出让页面处理
      if (err instanceof AuthError) throw err;
      return { success: false, error: err.message || '请求失败' };
    }
  },

  giveUp: async () => {
    const { status } = get();
    if (status !== 'playing') return;

    try {
      const data = await apiCall('/api/daily/guess', {
        method: 'POST',
        body: JSON.stringify({ giveUp: true, player_key: getPlayerKey() || '' }),
      });

      // 服务端返回了新的 player_key → 保存到 localStorage
      if (data.player_key && typeof data.player_key === 'string') {
        try { localStorage.setItem('player_key', data.player_key); } catch {}
      }

      const target = findCharacterByName(characters, data.target?.name);
      set({
        status: 'lost',
        target,
        guesses: [], // 服务端已保存，客户端清空
      });
    } catch (err: any) {
      console.error('[Daily] giveUp failed:', err);
      // 即使请求失败也设为 lost（网络问题时至少客户端停止游戏）
      set({ status: 'lost' });
    }
  },
}));
