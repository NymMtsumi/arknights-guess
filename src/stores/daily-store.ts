import { create } from 'zustand';
import type { Character, GuessResult } from '@/types/character';
import { makeGuess, findCharacterByName, isWin, pickDailyTarget } from '@/lib/game-engine';
import charactersData from '@/data/characters.json';
import { apiCall } from '@/lib/auth';

// NOTE: Store error messages are hardcoded Chinese strings.
// i18n integration (via useI18n hook) would be ideal for consistency with the rest of the UI,
// but Zustand stores run outside React component tree and cannot directly consume React context.

const MAX_GUESSES = 8;
const characters: Character[] = charactersData as Character[];

export interface DailyResult {
  won: boolean;
  guessCount: number;
  timestamp: string;
}

type DailyStatus = 'loading' | 'already-played' | 'playing' | 'won' | 'lost' | 'error';

interface DailyState {
  status: DailyStatus;
  target: Character | null;
  guesses: GuessResult[];
  remainingGuesses: number;
  previousResult: DailyResult | null;
  dailyDate: string;
  error: string | null;

  initDaily: () => Promise<void>;
  submitGuess: (name: string) => { success: boolean; error?: string };
  giveUp: () => void;
}

export const useDailyStore = create<DailyState>((set, get) => {
  /** 离线降级：当服务端不可用时，用客户端确定性算法初始化每日挑战 */
  function initDailyOfflineFallback() {
    try {
      const target = pickDailyTarget(characters, 'hard');
      set({
        status: 'playing',
        target,
        guesses: [],
        remainingGuesses: MAX_GUESSES,
        dailyDate: new Date().toISOString().slice(0, 10),
      });
    } catch (fallbackErr) {
      console.error('[Daily] Offline fallback also failed:', fallbackErr);
      set({ status: 'error', error: '无法初始化每日挑战，请稍后再试' });
    }
  }

  return {
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

        // 验证 API 响应基本有效性
        if (!data || typeof data.played !== 'boolean') {
          console.warn('[Daily] Invalid API response shape, falling back to offline mode');
          initDailyOfflineFallback();
          return;
        }

        if (data.played) {
          // 已玩过：尽力展示已有信息，缺失字段优雅降级
          const target = (data.targetName && findCharacterByName(characters, data.targetName)) || null;
          set({
            status: 'already-played',
            target,
            previousResult: data.result || null,
            dailyDate: data.date || '',
          });
          return;
        }

        // 未玩过：targetId 和 targetName 必须存在，否则无法验证客户端一致性
        if (!data.targetId || !data.targetName || !data.date) {
          console.warn('[Daily] API missing required fields for unplayed game, falling back to offline mode');
          initDailyOfflineFallback();
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
          // 服务端目标在本地数据库中找不到，说明客户端数据版本落后，不应继续游戏
          set({ status: 'error', error: '数据不一致，请刷新页面' });
          return;
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
        // 仅当 API 调用本身失败时才降级到离线模式（网络错误/服务器宕机）
        // API 成功但处理失败的场景已在 try 块内部处理
        initDailyOfflineFallback();
      }
    },

  // NOTE: submitGuess logic is duplicated between game-store.ts and daily-store.ts.
  // A shared helper (e.g. makeGuessAndUpdateState) would be ideal but is deferred
  // to avoid coupling the two stores prematurely.
  submitGuess: (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) {
      return { success: false, error: '未找到该干员' };
    }

    const guessedChar = findCharacterByName(characters, trimmed);
    if (!guessedChar) {
      return { success: false, error: '未找到该干员' };
    }

    // Pre-check state（常见单线程路径，可返回明确错误）
    const current = get();
    if (current.status !== 'playing' || !current.target) {
      return { success: false, error: '游戏未在进行中' };
    }
    if (current.guesses.some(g => g.character.id === guessedChar.id)) {
      return { success: false, error: '已猜过该干员' };
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
  };
});
