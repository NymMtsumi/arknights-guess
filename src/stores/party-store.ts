// 派对模式 Zustand Store — 管理派对游戏UI状态
import { create } from 'zustand';

export type PartyStage =
  | 'menu'       // 入口菜单
  | 'lobby'      // 创建/加入房间
  | 'waiting'    // 等待室
  | 'countdown'  // 开始倒计时
  | 'playing'    // 游戏中
  | 'reveal'     // 回合展示
  | 'end';       // 游戏结束

export interface PartyPlayerState {
  id: string;
  name: string;
  ready: boolean;
  score: number;       // 累计得分（按 playerKey 回迁）
  playerKey?: string;  // 稳定身份标识（重连后 socket.id 会变，用 playerKey 精确匹配，避免重名串号）
}

export interface PartyRankingState {
  playerId: string;
  playerName: string;
  playerKey?: string;
  guessCount: number;
  guessChain: string[];
  pointsEarned: number;
  didNotGuess?: boolean;
}

export interface TotalScoreState {
  playerId: string;
  playerName: string;
  playerKey?: string;
  score: number;
}

export interface FinalRankingState {
  playerId: string;
  playerName: string;
  playerKey?: string;
  totalScore: number;
  roundsWon?: number;
}

export interface RoundStatusPlayer {
  playerId: string;
  playerName: string;
  playerKey?: string;
  score: number;        // 累计分
  guessed: boolean;     // 已猜中
  exhausted: boolean;   // 次数用尽
  guessCount: number;   // 已用次数
  remaining: number;    // 剩余次数
}

interface PartyState {
  // 连接状态
  stage: PartyStage;
  socketId: string;
  connecting: string;       // 'create' | 'join' | ''
  error: string;
  playerName: string;

  // 房间状态
  roomCode: string;
  hostId: string;
  players: PartyPlayerState[];
  settings: { difficulty: string; rounds: number; roundTime: number; attributes: string[] | null; maxGuesses: number };

  // 游戏状态
  currentRound: number;
  totalRounds: number;
  targetName: string;
  timeLeft: number;
  roundFinished: boolean;

  // 本回合结果
  roundRankings: PartyRankingState[];
  totalScores: TotalScoreState[];

  // 最终结果
  finalRankings: FinalRankingState[];
  champion: FinalRankingState | null;

  // 猜中排行（本回合）
  foundPlayers: { playerId: string; playerName: string; rank: number; guessCount: number }[];
  exhaustedPlayers: string[]; // playerId[]
  disconnectedPlayers: string[]; // playerId[]
  roundStatus: RoundStatusPlayer[]; // 局内实时排行（剩余次数/累计分）

  // Actions — 仅保留被实际调用的
  setStage: (stage: PartyStage) => void;
  setConnecting: (s: string) => void;
  setError: (e: string) => void;
  setPlayerName: (n: string) => void;
  setRoomCode: (c: string) => void;
  setSettings: (s: { difficulty: string; rounds: number; roundTime: number; attributes: string[] | null; maxGuesses: number }) => void;
  addFoundPlayer: (p: { playerId: string; playerName: string; rank: number; guessCount: number }) => void;
  addExhaustedPlayer: (playerId: string) => void;
  addDisconnectedPlayer: (playerId: string) => void;
  removeDisconnectedPlayer: (playerId: string) => void;
  updatePlayerReady: (playerId: string, ready: boolean) => void;
  setRoundStatus: (players: RoundStatusPlayer[]) => void;
  resetRoundState: () => void;
  resetAll: () => void;
}

export const usePartyStore = create<PartyState>((set, get) => ({
  stage: 'menu',
  socketId: '',
  connecting: '',
  error: '',
  playerName: '',

  roomCode: '',
  hostId: '',
  players: [],
  settings: { difficulty: 'hard', rounds: 7, roundTime: 120, attributes: null, maxGuesses: 8 },

  currentRound: 0,
  totalRounds: 7,
  targetName: '',
  timeLeft: 120,
  roundFinished: false,

  roundRankings: [],
  totalScores: [],

  finalRankings: [],
  champion: null,

  foundPlayers: [],
  exhaustedPlayers: [],
  disconnectedPlayers: [],
  roundStatus: [],

  setStage: (stage) => set({ stage }),
  setConnecting: (s) => set({ connecting: s }),
  setError: (e) => set({ error: e }),
  setPlayerName: (n) => set({ playerName: n }),
  setRoomCode: (c) => set({ roomCode: c }),
  setSettings: (s) => set({ settings: s }),

  addFoundPlayer: (p) => set((state) => {
    const exists = state.foundPlayers.some(fp => fp.playerId === p.playerId);
    if (exists) return state;
    return { foundPlayers: [...state.foundPlayers, p] };
  }),
  addExhaustedPlayer: (playerId) => set((state) => {
    if (state.exhaustedPlayers.includes(playerId)) return state;
    return { exhaustedPlayers: [...state.exhaustedPlayers, playerId] };
  }),
  addDisconnectedPlayer: (playerId) => set((state) => {
    if (state.disconnectedPlayers.includes(playerId)) return state;
    return { disconnectedPlayers: [...state.disconnectedPlayers, playerId] };
  }),
  removeDisconnectedPlayer: (playerId) => set((state) => ({
    disconnectedPlayers: state.disconnectedPlayers.filter(id => id !== playerId),
  })),
  updatePlayerReady: (playerId, ready) => set((state) => ({
    players: state.players.map(p => p.id === playerId ? { ...p, ready } : p),
  })),

  setRoundStatus: (players) => set({ roundStatus: players }),

  resetRoundState: () => set({
    foundPlayers: [],
    exhaustedPlayers: [],
    roundRankings: [],
    totalScores: [],
    roundStatus: [],
    roundFinished: false,
  }),

  resetAll: () => set({
    stage: 'menu',
    // socketId 保留：socket 仍然连接，下次 create/join 需要它（Fix R2-H4）
    // playerName 保留：跨房间保持昵称
    connecting: '',
    error: '',
    roomCode: '',
    hostId: '',
    players: [],
    settings: { difficulty: 'hard', rounds: 7, roundTime: 120, attributes: null, maxGuesses: 8 },
    currentRound: 0,
    totalRounds: 7,
    targetName: '',
    timeLeft: 120,
    roundFinished: false,
    roundRankings: [],
    totalScores: [],
    finalRankings: [],
    champion: null,
    foundPlayers: [],
    exhaustedPlayers: [],
    disconnectedPlayers: [],
    roundStatus: [],
  }),
}));
