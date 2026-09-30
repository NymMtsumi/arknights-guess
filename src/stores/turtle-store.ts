import { create } from 'zustand';
import type { Character, Difficulty } from '@/types/character';
import { findCharacterByName, getPoolByDifficulty, isWin, pickTarget } from '@/lib/game-engine';
import {
  askQuestion, isExhausted,
  type QuestionField, type TurtleGuess, type TurtleQuestion,
} from '@/lib/turtle-engine';
import charactersData from '@/data/characters.json';

/**
 * 海龟汤（盲盒变体）—— 客户端 store。
 *
 * 🔴 **局中不落任何盘：谜底不写 localStorage / sessionStorage，也不下发。**
 *    经典单人模式会把最近几个谜底存进 localStorage 做「防连庄」（game-store 的
 *    RECENT_KEY），海龟汤**不能照抄那一条** —— 那个键里就躺着答案，刷新页面或
 *    开一次 devtools 就白给了。这里连 `pickTarget` 的第三个参数 recentIds 都**整个省略**。
 *    代价：刷新即失去本局进度（谜底不存 → 无从恢复）。这是有意的取舍，
 *    `tests/turtle-store-test.mjs` 有一条「整轮打完 localStorage 仍不含谜底」的断言钉住它。
 *
 * ⚠️ **但结算后会上报 `targetName`。** 本文件不管这一步，是 `src/app/turtle/page.tsx`
 *    的结算 effect 调 `saveTurtleStats(..., target.name)` 写进 `games.target_name`
 *    —— 与经典单人同形，榜要按人聚合就得有它。所以别把上面那条读成「答案从未
 *    离开浏览器」：准确的表述是**局中**只在内存，结算时会上报一个名字。
 *    （无公开暴露面：`/api/leaderboard` 不 SELECT target_name，`/api/history` 也排除了 turtle。）
 *
 * ⚠️ 信任级别与经典单人模式**相同**（成绩由浏览器上报、谜底在浏览器里选）。
 *    做服务端逐步校验要照每日挑战另建一套端点，本方案不做 —— 见 plan 的 B3。
 */

const characters: Character[] = charactersData as Character[];

interface TurtleState {
  status: 'idle' | 'playing' | 'won' | 'lost';
  difficulty: Difficulty;
  /** 谜底。只活在这个 store 的内存里 —— 见文件头的「不落盘」 */
  target: Character | null;
  /** 提问日志（按时间序，供 UI 渲染） */
  questions: TurtleQuestion[];
  /** 点名猜测日志 */
  guesses: TurtleGuess[];
  questionCount: number;
  guessCount: number;

  startGame: (difficulty: Difficulty) => void;
  /** 提问一次，花掉 1 次共享次数 */
  ask: (field: QuestionField, value: string | number) => { success: boolean; error?: string };
  /** 点名猜一个干员，花掉 1 次共享次数 */
  guess: (name: string) => { success: boolean; error?: string };
  /** 放弃（判负并揭晓谜底，与次数耗尽同一条收尾路径） */
  giveUp: () => void;
  reset: () => void;
}

const IDLE = {
  status: 'idle' as const,
  target: null,
  questions: [] as TurtleQuestion[],
  guesses: [] as TurtleGuess[],
  questionCount: 0,
  guessCount: 0,
};

/**
 * 当前难度的池子 —— **谜底与「提问取值域」共用它**（用户决策：取值域与谜底同源）。
 *
 * 🔴 唯一来源。页面的 `buildQuestionOptions(turtlePool(d), f)` 与 store 的 `ask()`
 *    都必须走这里；两边各算一次就会出现「下拉里有这个子职业、但 ask 反查不到它隐含的职业」
 *    这种只在特定难度下现形的静默错答案。
 */
export function turtlePool(difficulty: Difficulty): Character[] {
  return getPoolByDifficulty(characters, difficulty);
}

export const useTurtleStore = create<TurtleState>((set, get) => ({
  ...IDLE,
  difficulty: 'medium',

  startGame: (difficulty: Difficulty) => {
    // 防止游戏进行中重复开始（如双击按钮）
    if (get().status === 'playing') return;
    // ⚠️ 第三个参数 recentIds **故意省略**。传了它会在池子里排除最近几个谜底
    //    （防连庄），而那份「最近谜底」正是 game-store 写进 localStorage 的东西 ——
    //    等于把答案落盘。见文件头的「不落盘」。
    const target = pickTarget(characters, difficulty);
    set({ ...IDLE, status: 'playing', difficulty, target });
  },

  ask: (field, value) => {
    const s = get();
    if (s.status !== 'playing' || !s.target) return { success: false, error: 'NOT_PLAYING' };
    if (isExhausted(s)) return { success: false, error: 'EXHAUSTED' };

    // ⚠️ 第四个参数是**取值域来源**，不是可选装饰：子职业提问要靠它反查隐含的职业
    //    （见 turtle-engine 的 classOfSubclass）。必须与页面生成下拉的池子**同一个**
    //    —— 走 turtlePool(s.difficulty)。谜底也出自这个池，所以任何合法选项都反查得到。
    const answer = askQuestion(s.target, field, value, turtlePool(s.difficulty));
    const questions = [...s.questions, { field, value, level: answer.level, ...(answer.hint ? { hint: answer.hint } : {}) }];
    const questionCount = s.questionCount + 1;
    // 提问**不能**赢，但可能把次数用光 → 判负
    set({
      questions,
      questionCount,
      status: isExhausted({ questionCount, guessCount: s.guessCount }) ? 'lost' : 'playing',
    });
    return { success: true };
  },

  guess: (name) => {
    const s = get();
    if (s.status !== 'playing' || !s.target) return { success: false, error: 'NOT_PLAYING' };
    if (isExhausted(s)) return { success: false, error: 'EXHAUSTED' };

    const char = findCharacterByName(characters, name);
    if (!char) return { success: false, error: 'NOT_FOUND' };

    const correct = isWin(s.target, char);
    const guesses = [...s.guesses, { id: char.id, name: char.name, correct }];
    const guessCount = s.guessCount + 1;
    set({
      guesses,
      guessCount,
      // 猜中即胜；否则看次数是否用光（与弗一把 guessSoup 同一顺序）
      status: correct ? 'won' : (isExhausted({ questionCount: s.questionCount, guessCount }) ? 'lost' : 'playing'),
    });
    return { success: true };
  },

  giveUp: () => {
    const s = get();
    if (s.status !== 'playing') return;
    // 与次数耗尽走同一条路径：status 变 lost，谜底由 UI 在有 target 时揭晓
    set({ status: 'lost' });
  },

  reset: () => set({ ...IDLE }),
}));

// 这里曾再导出一个 `TURTLE_MAX_ATTEMPTS = MAX_ATTEMPTS`，全仓无人 import（死导出）。
// 次数池的唯一事实源是 turtle-engine 的 MAX_ATTEMPTS —— 要引用就直接从那里取，
// 少一个同义名就少一处会漂移的地方。
