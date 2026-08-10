// 派对模式 — 共享类型定义
// Socket 连接管理已迁移到 useSocket() hook，localStorage 已迁移到 useRoom()/usePlayerName()

/** 服务器错误消息 */
export interface PartyError {
  code?: string;
  message: string;
  minPlayers?: number;
}

/** 玩家信息 */
export interface PartyPlayer {
  id: string;        // socket id
  name: string;      // 显示名称
  ready?: boolean;
  guessed?: boolean;
  exhausted?: boolean;
  guessCount?: number;
  score?: number;
  rank?: number;
}

/** 房间设置 */
export interface PartySettings {
  difficulty: string;
  rounds: number;
  roundTime: number;
}

/** 房间信息 */
export interface PartyRoom {
  code: string;
  hostId: string;
  settings: PartySettings;
  started: boolean;
}

/** 排名条目 */
export interface PartyRanking {
  playerId: string;
  playerName: string;
  playerKey?: string;
  guessCount: number;
  guessChain: string[];
  pointsEarned: number;
  didNotGuess?: boolean;
}

/** 最终排名条目 */
export interface PartyFinalRanking {
  playerId: string;
  playerName: string;
  playerKey: string;
  totalScore: number;
  roundsWon: number;
}

/** 回合结束数据 */
export interface PartyRoundEnd {
  round: number;
  totalRounds: number;
  target: { name: string; id: string };
  rankings: PartyRanking[];
  totalScores: { playerId: string; playerName: string; playerKey: string; score: number }[];
  isLastRound: boolean;
}

/** 游戏结束数据 */
export interface PartyGameEnd {
  finalRankings: PartyFinalRanking[];
  champion: PartyFinalRanking | null;
}

/** 重连状态 */
export interface PartyReconnectState {
  room: PartyRoom;
  players: PartyPlayer[];
  currentRound?: number;
  targetName?: string;
  roundFinished?: boolean;
  remainingTime?: number;
  roundPlayers?: { playerId: string; playerName: string; guessed: boolean; exhausted: boolean; guessCount: number; findOrder?: number }[];
  scores?: { playerKey: string; playerName: string; score: number }[];
  roundRankings?: PartyRanking[];
  totalScores?: { playerId: string; playerName: string; playerKey: string; score: number }[];
  finalRankings?: { playerId: string; playerName: string; totalScore: number }[];
}

/** 回合开始数据 */
export interface PartyRoundStart {
  round: number;
  totalRounds: number;
  difficulty: string;
  targetName: string;
  timeLimit: number;
  startTime: number;
}

/** 有人猜出 */
export interface PartyPlayerFound {
  playerId: string;
  playerName: string;
  rank: number;
  guessCount: number;
}

/** 猜测结果 */
export interface PartyGuessResult {
  correct: boolean;
  guessCount: number;
  name: string;
  exhausted?: boolean;
}
