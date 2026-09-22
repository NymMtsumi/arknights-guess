'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { io, Socket } from 'socket.io-client';
import { Header } from '@/components/Header';
import { GameSearch } from '@/components/GameSearch';
import { GuessTable } from '@/components/GuessTable';
import { ScrollSlider } from '@/components/ScrollSlider';
import { ModeArt } from '@/components/ModeArt';
import { useGameStore } from '@/stores/game-store';
import { saveMultiGameStats, saveCustomGameStats, type MultiRoundResult } from '@/lib/stats';
import { getUser, getServerUrl, getToken, getPlayerKey } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { findCharacterByName } from '@/lib/game-engine';
import type { Character, GuessResult, GuessComparisons, GuessStatus } from '@/types/character';
import charactersData from '@/data/characters.json';

// NOTE: Socket event payloads use `any` types throughout this file.
// Proper TypeScript interfaces for all socket events would be a future improvement.
// WebSocket server address
const WS_BASE = process.env.NEXT_PUBLIC_WS_URL || 'https://ws.arknights-guess.online';
const allChars = charactersData as Character[];
const ROOM_KEY = 'liyiba-room';
function saveRoomCode(code: string) { try { localStorage.setItem(ROOM_KEY, code); } catch {} }
function loadRoomCode(): string { try { return localStorage.getItem(ROOM_KEY) || ''; } catch { return ''; } }
function clearRoomCode() { try { localStorage.removeItem(ROOM_KEY); } catch {} }

type Stage = 'menu' | 'lobby' | 'custom' | 'waiting' | 'playing' | 'roundEnd' | 'matchEnd' | 'matchmaking';

const DIFF_KEY_MAP: Record<string, string> = {
  easy: 'multi.difficultyEasy',
  medium: 'multi.difficultyMedium',
  hard: 'multi.difficultyHard',
};

// 自定义房：属性规范顺序（与服务端 ATTR_KEYS 一致）及单局时间预设
const ATTR_KEYS = ['class', 'subclass', 'faction', 'rarity', 'race', 'gender', 'releaseYear', 'position', 'tags'];
const ATTR_LABEL_KEYS: Record<string, string> = {
  class: 'table.class',
  subclass: 'table.subclass',
  faction: 'table.faction',
  rarity: 'table.rarity',
  race: 'table.race',
  gender: 'table.gender',
  releaseYear: 'table.year',
  position: 'table.position',
  tags: 'table.tags',
};
const ROUND_TIME_OPTIONS = [30000, 60000, 90000, 120000, 180000, 300000];

// 平局/超时插图的取图序号（public/icons/draw-1..5.png）。
// ⚠️ 用 hashCode 而不是 Math.random()：这个函数在 render 里跑，用随机数会在
//    任何一次重渲染时换图（计时器每 100ms setState 一次 → 会疯狂闪烁）。
//    以「目标名 + 比分 + 服务端给的 reason」为种 → 同一局恒定，不同局大概率不同。
//    ⚠️ reason 只有超时那一支才有（server/socket/game.js:55 发 'timeout'），
//       其余平局分支不发该字段，所以这里必须容忍 undefined。
function drawArtIndex(d: { targetName?: string; score?: number; reason?: string }): number {
  const seed = `${d.targetName ?? ''}|${d.score ?? 0}|${d.reason ?? ''}`;
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 5 + 1;
}

/**
 * 服务端 colorRows 的一行 → GuessComparisons。
 * 行结构（server/socket/game.js `multi:guess` 里构造，与 ATTR_KEYS 同序）：
 *   [0] 名称列 correct/wrong，[1..9] = class, subclass, faction, rarity, race,
 *   gender, releaseYear, position, tags。
 * 重连时服务端只回传这种压缩行（它同时是发给对手看的那份），这里还原成前端棋盘用的形状。
 */
function rowToComparisons(row?: string[]): GuessComparisons {
  const s = (v?: string): GuessStatus => (v === 'correct' || v === 'close' ? v : 'wrong');
  return {
    class: s(row?.[1]), subclass: s(row?.[2]), faction: s(row?.[3]),
    rarity: s(row?.[4]), race: s(row?.[5]), gender: s(row?.[6]),
    releaseYear: s(row?.[7]), position: s(row?.[8]), tags: s(row?.[9]),
  };
}

export default function MultiplayerPage() {
  const { t } = useI18n();
  const router = useRouter();

  // 从服务端载荷同步自定义房配置（标准房重置为 null）
  const applyConfig = (d: any) => {
    if (d.custom && Array.isArray(d.attributes)) {
      const cfg = {
        attributes: d.attributes,
        maxGuesses: typeof d.maxGuesses === 'number' ? d.maxGuesses : 8,
        roundTime: typeof d.roundTime === 'number' ? d.roundTime : 120000,
        difficulty: d.difficulty || 'hard',
      };
      customConfigRef.current = cfg;
      setDisplayAttributes(cfg.attributes);
    } else {
      customConfigRef.current = null;
      setDisplayAttributes(null);
    }
  };

  const [stage, setStage] = useState<Stage>('menu');
  const [socket, setSocket] = useState<Socket | null>(null);
  const [roomCode, setRoomCode] = useState('');
  // 上次房间码（菜单页「上次房间」卡片用）。
  // ⚠️ 必须是 state 而不是渲染期直接读 localStorage：静态导出的 HTML 里 localStorage
  //    读不到（Node 侧抛错被 catch 成 ''），而客户端读得到 → 两边首屏不一致 →
  //    水合不匹配。改为「首屏一律空、挂载后由 effect 填充」，两边首屏就一致了。
  //    顺带把原来每渲染 3 次 localStorage 同步读降成 1 次。
  const [lastRoomCode, setLastRoomCode] = useState('');
  const [playerName, setPlayerName] = useState('');
  const [bestOf, setBestOf] = useState(5);
  const [difficulty, setDifficulty] = useState<string>('hard');
  const [oppName, setOppName] = useState('');
  const [oppWins, setOppWins] = useState(0);
  const [myWins, setMyWins] = useState(0);
  const [oppGuessCount, setOppGuessCount] = useState(0);
  const [oppGrid, setOppGrid] = useState<string[][]>([]);
  const [timeLeft, setTimeLeft] = useState(120);
  const [error, setError] = useState('');
  const [endMsg, setEndMsg] = useState('');
  const [roundEndData, setRoundEndData] = useState<any>(null);
  const [iSurrendered, setISurrendered] = useState(false);
  const [oppSurrendered, setOppSurrendered] = useState(false);
  const [showSurrenderConfirm, setShowSurrenderConfirm] = useState(false);
  const [connecting, setConnecting] = useState('');
  const [oppDisconnected, setOppDisconnected] = useState(false);
  const [roomExpireTime, setRoomExpireTime] = useState(0);
  const [rematchReady, setRematchReady] = useState(false);
  const [queuePosition, setQueuePosition] = useState(0);
  const [matchDifficulty, setMatchDifficulty] = useState('');
  const [disbandCooldown, setDisbandCooldown] = useState(0); // 解散房间冷却到期时间戳
  // 自定义房运行时配置（从服务端载荷同步）
  const [displayAttributes, setDisplayAttributes] = useState<string[] | null>(null);
  // 自定义房表单状态
  const [customAttrs, setCustomAttrs] = useState<string[]>(['class', 'faction', 'rarity']);
  const [customMaxGuesses, setCustomMaxGuesses] = useState(8);
  const [customRoundTime, setCustomRoundTime] = useState(120000);
  const [customBestOf, setCustomBestOf] = useState(5);
  const [customDifficulty, setCustomDifficulty] = useState('hard');

  // 展示列（自定义房按配置过滤；标准房 hard 隐藏 rarity）
  const displayCols = useMemo(() => {
    const attrs = displayAttributes ?? ATTR_KEYS.filter(a => !(difficulty === 'hard' && a === 'rarity'));
    return [
      { key: 'name', label: t('table.name'), dataIdx: 0 },
      ...attrs.map(a => ({ key: a, label: t(ATTR_LABEL_KEYS[a]), dataIdx: 1 + ATTR_KEYS.indexOf(a) })),
    ];
  }, [displayAttributes, difficulty, t]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const connectTimer = useRef<NodeJS.Timeout | null>(null);
  const rematchTimer = useRef<NodeJS.Timeout | null>(null);
  const roundResultsRef = useRef<MultiRoundResult[]>([]);
  const customConfigRef = useRef<{ attributes: string[]; maxGuesses: number; roundTime: number; difficulty: string } | null>(null);
  const bestOfRef = useRef(5);
  const oppNameRef = useRef('');
  const roomCodeRef = useRef('');
  const socketRef = useRef<Socket | null>(null);
  const myBoardScrollRef = useRef<HTMLDivElement>(null);
  const oppBoardScrollRef = useRef<HTMLDivElement>(null);

  // Auto-reconnect to saved room on page load
  useEffect(() => {
    const savedCode = loadRoomCode();
    setLastRoomCode(savedCode); // 菜单页「上次房间」卡片的数据源
    if (!savedCode) return;
    if (socketRef.current?.connected) return;
    const s = connect();
    s.emit("reconnect_room", { code: savedCode });
    s.emit("_log", { action: "auto_reconnect" });
    connectTimer.current = setTimeout(() => { s.disconnect(); setConnecting(""); }, 15000);
    return () => {
      if (connectTimer.current) { clearTimeout(connectTimer.current); connectTimer.current = null; }
      // 清理未被 socketRef 持有的 socket（避免孤立连接泄漏）
      if (socketRef.current !== s) { s.disconnect(); }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Derive player name from auth or guest identity (full name, no truncation)
  useEffect(() => {
    const user = getUser();
    if (user) {
      const name = user.nickname || user.username;
      if (name) setPlayerName(name);
      return;
    }

    fetch(`${getServerUrl()}/api/guest-identity`)
      .then(res => res.json())
      .then(data => {
        if (data.displayName) setPlayerName(data.displayName);
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep refs in sync for socket event handlers
  useEffect(() => { bestOfRef.current = bestOf; }, [bestOf]);
  useEffect(() => { oppNameRef.current = oppName; }, [oppName]);

  const store = useGameStore();

  const clearConnecting = () => {
    if (connectTimer.current) { clearTimeout(connectTimer.current); connectTimer.current = null; }
    setConnecting('');
  };

  const connect = () => {
    // Disconnect old socket if active
    if (socketRef.current?.connected) {
      socketRef.current.removeAllListeners();
      socketRef.current.disconnect();
    }
    const s = io(WS_BASE, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: 10,
      autoConnect: false,
      auth: { token: getToken() || '', pk: getPlayerKey() || '' },
    });

    // Register event listeners before connecting
    s.on('connect_error', (err) => { clearConnecting(); setError(t('multi.serverConnectFail', { msg: err?.message || '' })); s.disconnect(); });
    s.on('connect_timeout', () => { clearConnecting(); setError(t('multi.connectTimeout')); });
    s.on('error_msg', (d: any) => { clearConnecting(); setError(d.message); s.disconnect(); });
    s.on('room_expired', (d: any) => {
      clearConnecting();
      clearRoomCode();
      setStage('menu');
      setError(d?.message || t('multi.roomExpired'));
    });
    s.on('existing_room', (d: any) => {
      clearConnecting();
      setRoomCode(d.code); roomCodeRef.current = d.code; saveRoomCode(d.code);
      setBestOf(d.bestOf); if (d.difficulty) setDifficulty(d.difficulty);
      applyConfig(d);
      if (d.started) { setStage('playing'); setMyWins(d.wins||0); }
      else {
        // 基于服务端 _createdAt 计算剩余倒计时，防止重连时倒计时重置
        const createdAt = d._createdAt || Date.now();
        setRoomExpireTime(createdAt + 120_000);
        setStage('waiting');
      }
    });

    s.on('set_cookie', (d: any) => {
      if (typeof document !== 'undefined') {
        try { localStorage.setItem('player_key', d.value); } catch {}
      }
    });
    s.io.on('reconnect', () => {
      const code = roomCodeRef.current;
      if (code) s.emit('reconnect_room', { code });
    });

    s.on('room_created', (d) => { clearConnecting(); setRoomCode(d.code); roomCodeRef.current = d.code; saveRoomCode(d.code); setBestOf(d.bestOf); if (d.difficulty) setDifficulty(d.difficulty); applyConfig(d); setRoomExpireTime(Date.now() + 120_000); setStage('waiting'); });

    s.on('room_disbanded', (d: any) => {
      clearRoomCode();
      if (d.cooldown) {
        setDisbandCooldown(Date.now() + d.cooldown);
      }
      setStage('menu');
      setConnecting('');
      if (d.reason === 'host_disbanded') {
        setError('房主已解散房间');
        setTimeout(() => setError(''), 4000);
      }
    });

    s.on("reconnect_state", (d) => {
      clearConnecting();
      setRoomCode(d.code); roomCodeRef.current = d.code; saveRoomCode(d.code);
      setBestOf(d.bestOf); if (d.difficulty) setDifficulty(d.difficulty);
      applyConfig(d);
      setStage("playing");
      const hasActiveRound = d.hasActiveRound !== false;
      const remaining = typeof d.remainingTime === 'number' ? Math.max(0, d.remainingTime) : 120;
      if (hasActiveRound && remaining > 0) { setTimeLeft(remaining); }
      else { setTimeLeft(0); }
      const me = s.id;
      const opp = d.players.find((p: any) => p.id !== me);
      if (opp) { setOppName(opp.name); setOppWins(opp.wins); }
      const meP = d.players.find((p: any) => p.id === me);
      if (meP) setMyWins(meP.wins);

      // ── 用服务端快照恢复本回合进度 ───────────────────────────────
      // 此处原先无条件 setOppGuessCount(0) / setOppGrid([])，把对手棋盘清空，
      // 而对手色块只有 opponent_update 一个补发通道（对手下次猜测时才发），
      // 对手若已猜完或已放弃就再也补不回来 → 「重连后看不到对手色块」。
      // 同理自己的棋盘也一并从快照恢复：旧代码只重置 remainingGuesses 不恢复 guesses，
      // 重连者（尤其刷新过页面的）看到空棋盘，且已猜过的干员不再被本地去重拦截，
      // 再次提交会被服务端静默丢弃 → 「输入后无法响应」。
      // ⚠️ 老服务端不带这些字段时的退化**不等于**改动前的行为：
      //    改动前 guesses 根本不在 setState 里，本地棋盘会在抖动重连后原样保留；
      //    所以下面用 hasSnapshot 门控，缺字段时一律不碰 guesses（见末尾注释）。
      // 快照能否采信：两个平行数组必须都在且等长。
      // 只到 myGuessChain 而缺 myColorRows（版本错配/字段被裁剪）时，
      // rowToComparisons(undefined) 会把 9 列全部判成 wrong —— 棋盘静默显示成
      // 一片全错，比不还原更糟。宁可不还原。
      //
      // ⚠️ 这里对 hasActiveRound 用**严格**判断（=== true），与上面第 281 行那个
      //    宽松的 `!== false`（为兼容老服务端，把缺失当活跃）刻意不同，两者不能合并：
      //    快照里的猜测链只在回合进行中才有意义。endRound/超时会清掉 room._roundStartAt，
      //    却**不清 _roundPlayers** —— 于是「回合已结算、下一回合还没开」的那 5 秒空窗里
      //    重连，服务端会原样回上一回合的 guessChain/colorRows，客户端照着重建，
      //    玩家看到的是上一回合**已经结算过**的棋盘，还带着上一回合的胜负状态。
      //    round_start 到达后会复位，但中间这段是实打实的错显。
      const roundActive = d.hasActiveRound === true;
      // 明确的「当前没有进行中的回合」。与 roundActive 分开判断，是为了把
      // 「新服务端说 false」和「老服务端根本没有这个字段」区分开 —— 前者可以放心清棋盘，
      // 后者必须保持不动（见下方 setState 里 guesses 那段兼容性注释）。
      const roundSettledGap = d.hasActiveRound === false;
      const hasSnapshot = roundActive
        && Array.isArray(d.myGuessChain)
        && Array.isArray(d.myColorRows)
        && d.myColorRows.length === d.myGuessChain.length;
      const chain: string[] = hasSnapshot ? d.myGuessChain : [];
      const rows: string[][] = hasSnapshot ? d.myColorRows : [];
      // 异格标记：与 myGuessChain 平行的第三个数组成员，**只发给本人**。
      // 不进 myColorRows 的原因见 server/socket/game.js 的 alterFlags 注释
      //（那份会经 opponent_update 原样广播给对手，等于泄露「答案是某人的异格」）。
      // 老服务端不带这个字段 → 全 false → 与改动前一样只丢异格高亮，不影响其余还原。
      //
      // ⚠️ 必须和 myColorRows 一样校验**等长**，不能只判 Array.isArray。
      //    下面 restored 是按 chain 的下标 i 取 alterFlags[i] 的：长度短了只是越界取到
      //    undefined（退化成丢高亮，无害），但若数组在，只是**顺序/长度被裁剪错位**，
      //    就会把 isAlter 挂到错误的那一行上 —— 等于凭空告诉玩家「答案是这一行的异格」，
      //    而那份信息正是服务端刻意不广播给对手的（见上面 alterFlags 的注释）。
      //    宁可整块不还原，也不能错位还原。
      const alterFlags: boolean[] = hasSnapshot
        && Array.isArray(d.myAlterFlags)
        && d.myAlterFlags.length === d.myGuessChain.length
        ? d.myAlterFlags
        : [];
      const restored: GuessResult[] = [];
      // ⚠️ timestamp 在这里**不是排序占位，是行 key**。
      //    GuessTable.tsx:154-157：既不是最新一行、也没猜中的行，key 直接取
      //    `String(guess.timestamp)`。恢复出来的行若全填 0，这些行的 key 全是 "0"，
      //    React 报 "Encountered two children with the same key"，且在玩家追加下一条
      //    猜测触发 reconciliation 时按 key 配对，可能错位或丢行。
      //    给一个按序号唯一且递增的值：GuessTable 只按数组顺序渲染、不按时间戳排序，
      //    但保持递增可以让「后猜的更新」这一语义与实时路径一致。
      const restoreBase = Date.now();
      for (let i = 0; i < chain.length; i++) {
        const ch = findCharacterByName(allChars, chain[i]);
        if (!ch) continue;
        restored.push({
          character: ch,
          comparisons: rowToComparisons(rows[i]),
          timestamp: restoreBase - (chain.length - i),
          ...(rows[i]?.[0] === 'correct' ? { correct: true as const } : {}),
          // 异格高亮（GuessTable 读 guess.isAlter；多人页 target 恒为 null，
          // 它没有第二个判断源，所以这里不还原就真的丢了）
          ...(alterFlags[i] ? { isAlter: true as const } : {}),
        });
      }
      // 对手棋盘同样只在回合进行中采信：oppColorRows 也来自 _roundPlayers，
      // 空窗里回的是上一回合的色块（与 myColorRows 同一个成因）。
      setOppGuessCount(roundSettledGap ? 0 : (typeof d.oppGuessCount === 'number' ? d.oppGuessCount : 0));
      setOppGrid(roundSettledGap ? [] : (Array.isArray(d.oppColorRows) ? d.oppColorRows : []));
      setISurrendered(!!d.mySurrendered);
      setOppSurrendered(!!d.oppSurrendered);
      setOppDisconnected(false);
      setRoundEndData(null);
      // 重连后不持有答案（服务端权威）：status 由快照里的胜负标记决定，
      // 否则已结束的回合会被当成进行中，让玩家继续提交必被丢弃的猜测。
      // 只在回合进行中才采信这两个标记：回合结算后的空窗里重连时，
      // myGuessed/myExhausted 还是**上一回合**的值，照抄会让玩家凭空看到一次胜负。
      // 老服务端没有 hasActiveRound 也没有这两个标记，两支都落到 "playing"，与改动前一致。
      const maxGuesses = d.maxGuesses ?? 8;
      useGameStore.setState({
        status: roundActive ? (d.myGuessed ? "won" : (d.myExhausted ? "lost" : "playing")) : "playing",
        target: null,
        // 剩余次数按**服务端链条长度**算，不是按本地成功还原的条数：
        // 某个干员在本地 roster 里查不到时 restored 会短一截（上面的 continue），
        // 用 restored.length 会高估剩余次数 —— 3 次以内的红色预警就不会出现。
        remainingGuesses: Math.max(0, maxGuesses - chain.length),
        difficulty: "hard",
        // ⚠️ 只有在真的拿到快照时才覆盖 guesses。
        //    改动前的处理器根本没有 guesses 这一项，网络抖动触发 socket.io 自动重连时
        //    本地棋盘原样保留；若无条件写 guesses，在「新前端 + 旧后端」窗口期
        //    （Pages 分钟级上线，VPS 要等 deploy.yml 两道 gate）restored 恒为空数组，
        //    每次抖动都清空棋盘，而已猜的干员仍被服务端记账 → 再猜同一个会被静默丢弃，
        //    表现正是 BUG 4 的「输入后无法响应」。
        //    注意 roundSettledGap 分支不会踩到这个坑：它要求服务端**明确**发了 false，
        //    老服务端根本没有这个字段（undefined），走不到这里。
        ...(roundSettledGap ? { guesses: [] } : hasSnapshot ? { guesses: restored } : {}),
      });
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      if (hasActiveRound && remaining > 0) {
        timerRef.current = setInterval(() => {
          setTimeLeft(t => { if (t <= 1) { clearInterval(timerRef.current!); timerRef.current = null; return 0; } return t - 1; });
        }, 1000);
      }
    });

    s.on('round_start', (d) => {
      clearConnecting();
      if (d.difficulty) setDifficulty(d.difficulty);
      applyConfig(d);
      setStage('playing');
      const roundSec = typeof d.timeLimit === 'number' ? Math.ceil(d.timeLimit / 1000) : 120;
      setTimeLeft(roundSec);
      setOppGuessCount(0); setOppGrid([]);
      setISurrendered(false); setOppSurrendered(false);
      setOppDisconnected(false);
      setRoundEndData(null);
      const me = s.id;
      const opp = d.players.find((p: any) => p.id !== me);
      if (opp) { setOppName(opp.name); setOppWins(opp.wins); }
      const meP = d.players.find((p: any) => p.id === me);
      if (meP) setMyWins(meP.wins);
      // 服务端不下发答案：客户端不持有 target，对比结果由服务端回传 guess_result
      useGameStore.setState({ status: 'playing', target: null, guesses: [], remainingGuesses: d.maxGuesses ?? 8, difficulty: 'hard' });
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      timerRef.current = setInterval(() => {
        setTimeLeft(t => { if (t <= 1) { clearInterval(timerRef.current!); timerRef.current = null; return 0; } return t - 1; });
      }, 1000);
    });

    s.on('opponent_update', (d) => { setOppGuessCount(d.guessCount); if (d.allComparisons?.length) setOppGrid(d.allComparisons); });

    // 服务端回传的猜测结果（对比 + 胜负标记；答案仍保密，仅存服务端）
    s.on('guess_result', (d) => {
      const gs = useGameStore.getState();
      if (gs.status !== 'playing') return;
      const char = findCharacterByName(allChars, d.name);
      if (!char) return;
      if (gs.guesses.some(g => g.character.id === char.id)) return;
      const result: GuessResult = {
        character: char,
        comparisons: d.comparisons,
        timestamp: Date.now(),
        ...(d.correct ? { correct: true } : {}),
        ...(d.isAlter ? { isAlter: true } : {}),
      };
      useGameStore.setState({
        guesses: [...gs.guesses, result],
        remainingGuesses: typeof d.remainingGuesses === 'number' ? d.remainingGuesses : 0,
        status: d.correct ? 'won' : (d.exhausted ? 'lost' : 'playing'),
      });
    });
    s.on('opponent_surrendered', (d) => { setOppSurrendered(true); });
    s.on('opponent_disconnected', (d) => { setOppDisconnected(true); });
    s.on('opponent_reconnected', (d) => { setOppDisconnected(false); });

    s.on('round_end', (d) => {
      setStage('roundEnd'); setRoundEndData(d);
      const mySid = s.id as string;
      const state = useGameStore.getState();
      roundResultsRef.current.push({
        targetName: d.targetName || '?',
        won: d.winner === mySid,
        guessCount: state.guesses.length,
      });
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    });

    s.on('match_end', (d) => {
      const mySid = s.id as string;
      const players = d.players || [];
      const me = players.find((p: { id: string }) => p.id === mySid);
      const opp = players.find((p: { id: string }) => p.id !== mySid);
      const myScore = me?.wins || 0;
      const oppScore = opp?.wins || 0;
      const won = d.winner === mySid;
      const rounds = [...roundResultsRef.current];
      const customCfg = customConfigRef.current;
      if (customCfg) {
        // 自定义房：不计入聚合，仅写入历史
        saveCustomGameStats({
          won,
          bestOf: bestOfRef.current || 1,
          myScore,
          opponentScore: oppScore,
          opponentName: oppNameRef.current || 'Opponent',
          rounds,
          custom: customCfg,
        });
      } else {
        saveMultiGameStats({
          won,
          bestOf: bestOfRef.current || 1,
          myScore,
          opponentScore: oppScore,
          opponentName: oppNameRef.current || 'Opponent',
          rounds,
        });
      }
      roundResultsRef.current = [];
      clearRoomCode();
      setStage('matchEnd');
      setEndMsg(
        d.reason === 'both_disconnected' ? t('multi.matchEndBothDisconnected')
        : d.reason === 'disconnect' ? t('multi.matchEndDisconnect', { name: d.winnerName })
        : d.winner === null ? t('multi.matchEndDraw')
        : t('multi.matchEndWin', { name: d.winnerName, score: d.score })
      );
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    });

    s.on('rematch_start', (d) => {
      setStage('playing'); setMyWins(0); setOppWins(0);
      setRematchReady(false);
      setBestOf(d.bestOf);
      if (d.difficulty) setDifficulty(d.difficulty);
      applyConfig(d);
      setTimeLeft(Math.ceil((d.roundTime ?? 120000) / 1000)); setOppGuessCount(0); setOppGrid([]);
      setISurrendered(false); setOppSurrendered(false);
      roundResultsRef.current = [];
      setOppDisconnected(false); setRoundEndData(null);
      useGameStore.setState({ status: 'idle', target: null, guesses: [], remainingGuesses: d.maxGuesses ?? 8, difficulty: 'hard' });
    });

    s.on('rematch_cancelled', (d: any) => {
      setError(t('multi.rematchCancelled', { name: d?.playerName || '' }));
      setTimeout(() => setError(''), 3000);
    });

    // Matchmaking queue events
    s.on('matchmaking:status', (d: any) => {
      if (d.queued) {
        setQueuePosition(d.position);
        setMatchDifficulty(d.difficulty);
        setStage('matchmaking');
        clearConnecting();
      } else {
        setStage('menu');
        setQueuePosition(0);
        setMatchDifficulty('');
      }
    });

    s.on('matchmaking:matched', (d: any) => {
      clearConnecting();
      setRoomCode(d.roomCode);
      roomCodeRef.current = d.roomCode;
      saveRoomCode(d.roomCode);
      setBestOf(d.bestOf);
      if (d.difficulty) setDifficulty(d.difficulty);
      applyConfig({});
      setOppName(d.opponent.name);
      setMyWins(0); setOppWins(0);
      setOppGuessCount(0); setOppGrid([]);
      setTimeLeft(120);
      setISurrendered(false); setOppSurrendered(false);
      setOppDisconnected(false);
      setRoundEndData(null);
      setQueuePosition(0); setMatchDifficulty('');
    });

    s.connect();
    setSocket(s); socketRef.current = s;
    return s;
  };

  const handleCreate = () => {
    clearConnecting();
    if (disbandCooldown > Date.now()) {
      setError(t('multi.cooldownMsg', { seconds: Math.ceil((disbandCooldown - Date.now()) / 1000) }));
      return;
    }
    setError(''); setConnecting('create');
    const s = connect();
    s.emit('create_room', { playerName: playerName.trim() || undefined, bestOf, difficulty });
    s.emit('_log', { action: 'create_room' });
    connectTimer.current = setTimeout(() => { s.disconnect(); setConnecting(''); setError(t('multi.createTimeout')); }, 30000);
  };

  const handleCreateCustom = () => {
    clearConnecting();
    if (customAttrs.length < 3) {
      setError(t('multi.custom.minAttrs'));
      return;
    }
    if (disbandCooldown > Date.now()) {
      setError(t('multi.cooldownMsg', { seconds: Math.ceil((disbandCooldown - Date.now()) / 1000) }));
      return;
    }
    setError(''); setConnecting('create');
    const s = connect();
    s.emit('create_room', {
      playerName: playerName.trim() || undefined,
      bestOf: customBestOf,
      difficulty: customDifficulty,
      maxGuesses: customMaxGuesses,
      roundTime: customRoundTime,
      attributes: customAttrs,
    });
    s.emit('_log', { action: 'create_custom_room' });
    connectTimer.current = setTimeout(() => { s.disconnect(); setConnecting(''); setError(t('multi.createTimeout')); }, 30000);
  };

  const handleJoin = () => {
    clearConnecting();
    if (!roomCode.trim()) { setError(t('multi.enterRoomCode')); return; }
    setError(''); setConnecting('join');
    roomCodeRef.current = roomCode.trim().toUpperCase();
    saveRoomCode(roomCodeRef.current);
    const s = connect();
    s.emit('join_room', { code: roomCodeRef.current, playerName: playerName.trim() });
    s.emit('_log', { action: 'join_room' });
    connectTimer.current = setTimeout(() => { s.disconnect(); setConnecting(''); setError(t('multi.joinTimeout')); }, 30000);
  };

  const handleQuickMatch = () => {
    clearConnecting();
    if (disbandCooldown > Date.now()) {
      setError(t('multi.cooldownMsg', { seconds: Math.ceil((disbandCooldown - Date.now()) / 1000) }));
      return;
    }
    setError(''); setConnecting('quickmatch');
    const s = connect();
    s.emit('matchmaking:join', { playerName: playerName.trim() || undefined, difficulty, bestOf });
    s.emit('_log', { action: 'quickmatch' });
    connectTimer.current = setTimeout(() => { s.disconnect(); setConnecting(''); setError(t('multi.matchTimeout')); }, 60000);
  };

  const handleLeaveQueue = () => {
    const s = socketRef.current;
    if (s?.connected) { s.emit('matchmaking:leave'); s.emit('_log', { action: 'leave_queue' }); }
    setStage('menu'); setQueuePosition(0); setMatchDifficulty(''); setConnecting('');
    if (connectTimer.current) { clearTimeout(connectTimer.current); connectTimer.current = null; }
  };

  // Waiting page countdown tick
  // OPTIMIZATION: This forces a full page re-render every second. Could be extracted
  // into a sub-component (e.g. <WaitingRoom />) to isolate re-renders, but the
  // current approach is acceptable given the low complexity of the waiting view.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (stage !== 'waiting' && !(disbandCooldown > Date.now())) return;
    const timer = setInterval(() => setTick(x => x + 1), 1000);
    return () => clearInterval(timer);
  }, [stage, disbandCooldown]);

  const handleGuess = (char: Character) => {
    if (useGameStore.getState().status !== 'playing') return;
    // 本地去重防御（服务端亦去重，防止快速双击重复计数）
    if (useGameStore.getState().guesses.some(g => g.character.id === char.id)) return;
    const sock = socketRef.current;
    if (!sock?.connected) return;
    // 只发名字：对比在服务端完成，客户端不持有答案（结果由 guess_result 回传）
    sock.emit('multi:guess', { name: char.name });
  };

  const handleSurrender = () => setShowSurrenderConfirm(true);
  const confirmSurrender = () => {
    setShowSurrenderConfirm(false);
    const sock = socketRef.current;
    if (!sock?.connected || useGameStore.getState().status !== 'playing') return;
    setISurrendered(true);
    sock.emit('surrender_round', {}); // 答案由服务端持有，无需上报 targetName
    useGameStore.setState({ status: 'lost' });
  };

  const handleRematch = () => {
    setRematchReady(true);
    socketRef.current?.emit('rematch_ready');
    if (rematchTimer.current) clearTimeout(rematchTimer.current);
    rematchTimer.current = setTimeout(() => {
      setRematchReady(prev => {
        if (prev) { socketRef.current?.emit('rematch_cancel'); return false; }
        return prev;
      });
    }, 60000);
  };

  const handleCancelRematch = () => {
    setRematchReady(false);
    if (rematchTimer.current) { clearTimeout(rematchTimer.current); rematchTimer.current = null; }
    socketRef.current?.emit('rematch_cancel');
  };

  // 离开比赛 / 房间过期后回到大厅：断开 socket 并复位全部对局状态
  const resetToMenu = () => {
    const sock = socketRef.current;
    if (sock) {
      sock.removeAllListeners();
      sock.disconnect();
      socketRef.current = null;
      setSocket(null);
    }
    clearRoomCode();
    setLastRoomCode(''); // 与 storage 同步清掉，否则菜单页「上次房间」卡片会复活
    roomCodeRef.current = '';
    setStage('menu');
    setRoomCode('');
    setOppGrid([]);
    setOppGuessCount(0);
    setMyWins(0);
    setOppWins(0);
    setOppName('');
    setEndMsg('');
    setRoundEndData(null);
    setRematchReady(false);
    setISurrendered(false);
    setOppSurrendered(false);
    setOppDisconnected(false);
    setError('');
    setConnecting('');
    roundResultsRef.current = [];
    customConfigRef.current = null;
    setDisplayAttributes(null);
    useGameStore.getState().resetGame();
  };

  useEffect(() => { return () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } if (rematchTimer.current) { clearTimeout(rematchTimer.current); rematchTimer.current = null; } if (socket) { socket.removeAllListeners(); socket.disconnect(); } }; }, [socket]);

  // 卸载时复位共享的单人 store。
  // ⚠️ 必须单开一个 deps=[] 的 effect，不能并进上面那个 —— 它的依赖是 [socket]，
  //    而 connect()（第 518 行附近）每次建房/加房都会换 socket 实例，并进去会在
  //    换实例的瞬间清空 store。
  // 为什么需要：useGameStore 是模块级单例，/multiplayer 与 /game 共用同一个实例。
  // 本页在 round_start / guess_result / reconnect_state 里把它写成
  // `status:'playing', target:null`，而 game/page.tsx:266 只在 status==='idle' 时
  // 渲染模式选择、switchMode 又被 `if (status === 'playing') return` 挡住 ——
  // 于是 Header 用 next/link 客户端跳回经典模式时（不刷新页面），玩家看到的是一块
  // 没有目标、点不动（store 的 submitGuess 遇 target=null 直接 return，
  // game/page.tsx:220 又丢弃返回值）的棋盘，且选不了难度。
  // 同类问题派对模式已经修过（components/party/PartyEnd.tsx:21 的 "Fix #9"），这里是补上。
  useEffect(() => () => { useGameStore.getState().resetGame(); }, []);

  const guessedIds = useMemo(() => new Set(store.guesses.map(g => g.character.id)), [store.guesses]);
  const inputDisabled = store.status !== 'playing' || iSurrendered;
  const winTarget = bestOf === 3 ? 2 : bestOf === 5 ? 3 : 4;

  return (
    <div className="page" data-mode="multi">
      <Header />
      <div className="page-scroll flex flex-col items-center">

        {/* ===== Menu ===== */}
        {stage === 'menu' && (
          <div className="card text-center w-full max-w-[450px]">
            <button onClick={() => router.push('/')} className="btn-o mb-3">
              ← {t('game.back')}
            </button>
            {/* 顶部装饰插画 —— 稿子 index-v12-modes.html:975 的 .mode-art wide */}
            <ModeArt src="/icons/menu-multi.png" />
            <h1 className="scr-ttl mb-4">⚔️ {t('multi.title')}</h1>
            <p className="sec-note mb-3.5">{t('multi.description')}</p>
            <div className="multi-select-row">
              <label className="multi-select-wrapper">
                <span className="multi-select-label">{t('multi.difficultyLabel')}</span>
                <select value={difficulty} onChange={e => setDifficulty(e.target.value)} className="multi-select">
                  <option value="easy">{t('multi.difficultyEasy')}</option>
                  <option value="medium">{t('multi.difficultyMedium')}</option>
                  <option value="hard">{t('multi.difficultyHard')}</option>
                </select>
              </label>
              <label className="multi-select-wrapper">
                <span className="multi-select-label">{t('multi.formatLabel')}</span>
                <select value={bestOf} onChange={e => setBestOf(Number(e.target.value))} className="multi-select">
                  <option value={3}>BO3</option>
                  <option value={5}>BO5</option>
                  <option value={7}>BO7</option>
                </select>
              </label>
            </div>
            <button onClick={handleQuickMatch} disabled={!!connecting} className="btn-p w-full mt-1">{connecting ? t('multi.connecting') : '⚡ ' + t('multi.quickMatch')}</button>
            {error && <p className="formmsg err">{error}</p>}
            {lastRoomCode && (
              <div className="card w-full max-w-[320px] mx-auto my-3">
                <p className="sec-note">📋 {t('multi.lastRoom')}</p>
                <p className="code-big sm">{lastRoomCode}</p>
                <button onClick={() => { setConnecting('join'); const s = connect(); s.emit('reconnect_room', { code: lastRoomCode }); s.emit('_log', { action: 'quick_rejoin' }); connectTimer.current = setTimeout(() => { s.disconnect(); setConnecting(''); setError(t('multi.reconnectTimeout')); }, 30000); }} className="btn-o btn-sm mt-2">🚪 {t('multi.quickRejoin')}</button>
              </div>
            )}
            <button onClick={() => setStage('lobby')} className="btn-p mt-2">🏠 {t('multi.createJoinRoom')}</button>
            <button onClick={() => { setError(''); setStage('custom'); }} className="btn-o mt-2">🎨 {t('multi.custom.title')}</button>
          </div>
        )}

        {/* ===== Lobby ===== */}
        {stage === 'lobby' && (
          <div className="card text-center w-full max-w-[400px]">
            <button onClick={() => { setStage('menu'); setError(''); }} className="btn-o mb-3">
              ← {t('multi.back')}
            </button>
            <h2 className="scr-ttl mb-3">
              BO{bestOf} · {t('multi.winFormat', { n: winTarget })}制
            </h2>
            <div className="mt-3">
              <button onClick={handleCreate} className="btn-p" disabled={disbandCooldown > Date.now()}>{t('multi.createRoom')}</button>
              {disbandCooldown > Date.now() && (
                <p className="formmsg warn">
                  ⏳ {t('multi.cooldownMsg', { seconds: Math.max(0, Math.ceil((disbandCooldown - Date.now()) / 1000)) })}
                </p>
              )}
            </div>
            <div className="div-top">
              <input value={roomCode} onChange={e => setRoomCode(e.target.value.replace(/\D/g,''))} placeholder={t('multi.roomCodePlaceholder')} className="search-input text-center mb-2" maxLength={4} inputMode="numeric" />
              <button onClick={handleJoin} className="btn-p">{t('multi.joinRoom')}</button>
            </div>
            {error && <p className="formmsg err">{error}</p>}
          </div>
        )}

        {/* ===== Custom Room ===== */}
        {stage === 'custom' && (
          <div className="card text-center w-full max-w-[460px]">
            <button onClick={() => { setStage('menu'); setError(''); }} className="btn-o mb-3">
              ← {t('multi.back')}
            </button>
            <h2 className="scr-ttl mb-1">🎨 {t('multi.custom.title')}</h2>
            <p className="sec-note mb-3.5">{t('multi.custom.desc')}</p>

            <div className="multi-select-row">
              <label className="multi-select-wrapper">
                <span className="multi-select-label">{t('multi.difficultyLabel')}</span>
                <select value={customDifficulty} onChange={e => setCustomDifficulty(e.target.value)} className="multi-select">
                  <option value="easy">{t('multi.difficultyEasy')}</option>
                  <option value="medium">{t('multi.difficultyMedium')}</option>
                  <option value="hard">{t('multi.difficultyHard')}</option>
                </select>
              </label>
              <label className="multi-select-wrapper">
                <span className="multi-select-label">{t('multi.formatLabel')}</span>
                <select value={customBestOf} onChange={e => setCustomBestOf(Number(e.target.value))} className="multi-select">
                  {[1, 2, 3, 4, 5, 6, 7].map(n => <option key={n} value={n}>BO{n}</option>)}
                </select>
              </label>
              <label className="multi-select-wrapper">
                <span className="multi-select-label">{t('multi.custom.maxGuesses')}</span>
                <select value={customMaxGuesses} onChange={e => setCustomMaxGuesses(Number(e.target.value))} className="multi-select">
                  {Array.from({ length: 15 }, (_, i) => i + 1).map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              <label className="multi-select-wrapper">
                <span className="multi-select-label">{t('multi.custom.roundTime')}</span>
                <select value={customRoundTime} onChange={e => setCustomRoundTime(Number(e.target.value))} className="multi-select">
                  {ROUND_TIME_OPTIONS.map(ms => <option key={ms} value={ms}>{Math.round(ms / 1000)}s</option>)}
                </select>
              </label>
            </div>

            <div className="mt-3.5 text-left">
              <p className="cfg-lb">
                {t('multi.custom.attributes')} <span className="cfg-hint">({customAttrs.length}/9)</span>
              </p>
              <div className="flex flex-wrap gap-2">
                {ATTR_KEYS.map(a => {
                  const on = customAttrs.includes(a);
                  return (
                    <button
                      key={a}
                      onClick={() => setCustomAttrs(prev => on ? prev.filter(x => x !== a) : [...prev, a])}
                      className={on ? 'tchip on' : 'tchip off'}
                    >
                      {t(ATTR_LABEL_KEYS[a])}
                    </button>
                  );
                })}
              </div>
            </div>

            <button
              onClick={handleCreateCustom}
              disabled={!!connecting || customAttrs.length < 3}
              className="btn-p w-full mt-4"
            >
              {connecting ? t('multi.connecting') : t('multi.createRoom')}
            </button>
            {error && <p className="formmsg err">{error}</p>}
          </div>
        )}

        {/* ===== Waiting ===== */}
        {stage === 'waiting' && (
          <div className="card text-center w-full max-w-[440px]">
            {roomExpireTime > 0 && roomExpireTime - Date.now() <= 0 ? (
              <>
                <p className="alert alert-dan mb-4">{t('multi.roomExpired')}</p>
                <button onClick={resetToMenu} className="btn-p">{t('multi.back')}</button>
              </>
            ) : (
              <>
                <p>⏳ {t('multi.waitingOpponent')}</p>
                <p className="code-big">{roomCode}</p>
                <p className="sec-note">{t('multi.shareRoom', { bo: bestOf })}</p>
                <p className="sec-note">
                  {t('multi.roomExpireIn', { seconds: Math.max(0, Math.ceil((roomExpireTime - Date.now()) / 1000)) })}
                </p>
                <button
                  onClick={() => {
                    const s = socketRef.current;
                    if (s?.connected) {
                      s.emit('disband_room');
                      s.emit('_log', { action: 'disband_room' });
                    }
                  }}
                  className="btn-o btn-dan mt-5"
                >
                  {t('multi.disbandRoom')}
                </button>
              </>
            )}
          </div>
        )}

        {/* ===== Matchmaking ===== */}
        {stage === 'matchmaking' && (
          <div className="card text-center w-full max-w-[440px]">
            <div className="emoji-lg animate-[neon-pulse_1.5s_infinite]">⚡</div>
            <h2 className="scr-ttl mb-2">
              {t('multi.searching')}
            </h2>
            <p className="sec-note mb-2">
              {t('multi.matchDifficultyAndBo', { difficulty: t(DIFF_KEY_MAP[matchDifficulty] || 'multi.difficultyHard'), bo: bestOf })}
            </p>
            {queuePosition > 0 && (
              <p className="sec-note mb-4">
                {t('multi.queuePosition', { position: queuePosition })}
              </p>
            )}
            <button onClick={handleLeaveQueue} className="btn-o">{t('multi.cancelMatch')}</button>
          </div>
        )}

        {/* ===== Playing ===== */}
        {stage === 'playing' && (
          <div className="w-full">
            <div className="hud mb-3">
              <span className="lb2">{playerName} <span className="n">{myWins}</span></span>
              <span className={timeLeft <= 30 ? 'n low' : 'n'}>
                {String(Math.floor(timeLeft/60)).padStart(2,'0')}:{String(timeLeft%60).padStart(2,'0')}
              </span>
              <span className="lb2 sp">{oppName} <span className="n">{oppWins}</span></span>
            </div>
            {oppDisconnected && (
              <div className="formmsg warn justify-center">
                ⚠ {t('multi.oppDisconnected', { name: oppName })}
              </div>
            )}
            <div className="flex justify-center gap-2 mb-3 flex-wrap">
              <GameSearch onGuess={handleGuess} disabled={inputDisabled} guessedIds={guessedIds} target={store.target} remainingGuesses={store.remainingGuesses} />
              {!inputDisabled && <button onClick={handleSurrender} className="btn-o btn-dan">{t('multi.surrender')}</button>}
              {iSurrendered && <span className="bdg bdg-warn self-center">{t('multi.youSurrendered')}</span>}
              {oppSurrendered && <span className="bdg bdg-warn self-center">{t('multi.oppSurrendered')}</span>}
            </div>
            <div className="flex flex-wrap gap-3">
              <div className="flex-1 basis-[48%] min-w-[260px]">
                <div className="board-ttl">{t('multi.yourGuesses')}</div>
                <div ref={myBoardScrollRef} className="scroll-slider-container overflow-x-auto scroll-smooth"><GuessTable guesses={store.guesses} target={store.target} hideRarity={difficulty === 'hard'} displayAttributes={displayAttributes} staggerKey={store.guesses.length} /></div>
                <ScrollSlider containerRef={myBoardScrollRef} />
              </div>
              <div className="flex-1 basis-[48%] min-w-[260px]">
                <div className="board-ttl mc">{t('multi.oppGuesses', { name: oppName, count: oppGuessCount })}</div>
                <div ref={oppBoardScrollRef} className="scroll-slider-container overflow-x-auto scroll-smooth">
                  <table className="opp-grid">
                    <thead><tr>{displayCols.map((c,i)=><th key={i}>{c.label}</th>)}</tr></thead>
                    <tbody>
                      {oppGrid.length===0
                        ? <tr><td colSpan={displayCols.length} className="empty">{t('multi.waitingOppGuess')}</td></tr>
                        : [...oppGrid].reverse().map((row,i)=>(
                          <tr key={i} className="animate-[surface-enter_0.35s_both]">
                            {displayCols.map((col,j)=>{
                              const color = row[col.dataIdx] ?? '#444';
                              return (
                                <td key={j}>
                                  <span className={color==='correct'?'opp-dot d-ok':color==='close'?'opp-dot d-cl':color==='wrong'?'opp-dot d-no':'opp-dot'}/>
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
                <ScrollSlider containerRef={oppBoardScrollRef} />
              </div>
            </div>
          </div>
        )}

        {/* ===== Round End ===== */}
        {stage === 'roundEnd' && roundEndData && (
          <div className="card text-center w-full max-w-[400px] mt-4">
            {/* 平局 / 超时 → 稿子 modes:1389 的随机插图（draw-1..5 取一张）。
                只在 winner 为空时出现：赢/输那两种沿用内联 emoji，
                与 docs/icons-prep.md:32「多人回合横幅保留 emoji」的定稿一致。 */}
            {!roundEndData.winner && <ModeArt src={`/icons/draw-${drawArtIndex(roundEndData)}.png`} />}
            <div className="emoji-lg sm">
              {roundEndData.winner ? (roundEndData.winner === socket?.id ? '🎉 ' + t('multi.youWinRound') : '😔 ' + t('multi.oppWinRound')) : '🤝 ' + t('multi.roundDraw')}
            </div>
            <p className="sec-note">{t('multi.answerWithScore', { name: roundEndData.targetName, score: roundEndData.score })}</p>
            {roundEndData.matchOver
              ? <div className="mt-3"><p className="sec-note">{t('multi.matchOver', { score: roundEndData.score })}</p></div>
              : <p className="sec-note">{t('multi.waitingServer')}</p>
            }
          </div>
        )}

        {/* ===== Match End ===== */}
        {stage === 'matchEnd' && (
          <div className="card text-center w-full max-w-[400px] mt-4">
            <div className="emoji-lg">🏆</div>
            <h2 className="scr-ttl whitespace-pre-line">{endMsg}</h2>
            <div className="bar-actions justify-center">
              <button onClick={handleRematch} disabled={rematchReady} className="btn-p">
                {rematchReady ? '⏳ ' + t('multi.waitingOpp') : '🔄 ' + t('multi.playAgain')}
              </button>
              {rematchReady && (
                <button onClick={handleCancelRematch} className="btn-o">{t('multi.cancelReady')}</button>
              )}
              <button onClick={resetToMenu} className="btn-o">{t('multi.exit')}</button>
            </div>
          </div>
        )}

        {/* ===== Surrender Confirm Dialog ===== */}
        {showSurrenderConfirm && (
          <div className="modal-mask">
            <div className="dlg dan text-center">
              <p className="dt justify-center">{t('multi.confirmSurrenderTitle')}</p>
              <p className="db">{t('multi.confirmSurrenderDesc')}</p>
              <div className="df justify-center">
                <button onClick={()=>setShowSurrenderConfirm(false)} className="btn-o">{t('multi.cancel')}</button>
                <button onClick={confirmSurrender} className="btn-bandan">{t('multi.confirmSurrender')}</button>
              </div>
            </div>
          </div>
        )}

        {/* ===== Connecting Dialog ===== */}
        {connecting && (
          <div className="modal-mask">
            <div className="dlg mc text-center">
              <div className="emoji-lg sm animate-[neon-pulse_1.5s_infinite]">{connecting==='create'?'🏠':connecting==='quickmatch'?'⚡':'🚪'}</div>
              <p className="dt justify-center">{connecting==='create' ? t('multi.creating') : connecting==='quickmatch' ? t('multi.searchingOpp') : t('multi.joining')}</p>
              <p className="db">{connecting==='quickmatch' ? t('multi.connectingTimeout60') : t('multi.connectingTimeout30')}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
