'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Header } from '@/components/Header';
import { GameSearch } from '@/components/GameSearch';
import { GuessTable } from '@/components/GuessTable';
import { ScrollSlider } from '@/components/ScrollSlider';
import { ModeArt } from '@/components/ModeArt';
import { useI18n } from '@/lib/i18n';
import { isWin, makeGuess, pickTarget } from '@/lib/game-engine';
import { drawArtIndex } from '@/lib/round-art';
import { saveBotStats } from '@/lib/stats';
import {
  BOT_FIRST_DELAY_MS, BOT_MAX_GUESSES, BOT_POOL_DIFFICULTY, BOT_ROUND_TIME, BOT_TICK_MS,
  botDelayMs, botLearn, botPick, createBrain, pickBotIdentity,
  type BotBrain, type BotTier,
} from '@/lib/bot-engine';
import { ATTR_LABEL_KEYS, PARTY_ATTR_KEYS as ATTR_KEYS } from '@/lib/party-constants';
import type { Character, GuessComparisons, GuessResult } from '@/types/character';
import charactersData from '@/data/characters.json';

/**
 * 人机对战 —— 把一个真人对局压进一个浏览器里。
 *
 * ## 这是什么（以及为什么它不走服务端）
 *
 * 标准多人模式是 1v1 同场竞速、BO5、每局每人 8 次猜测，单局时长由房主在预设里选
 * （默认 120 秒 —— `server/constants.js` 的 `ROUND_TIME`；90 秒只是 `ROUND_TIME_PRESETS`
 * 六档里的一档），谜底只存在于服务端
 * （`room.target`）。本站活跃用户少，多人房常年空置，所以这个页面把**对手换成一个
 * 纯本地的人机**：谜底改由浏览器选，人机由 `@/lib/bot-engine` 驱动。
 *
 * 🔴 三件事**必须**与标准多人房保持一致，否则玩家在两种模式间迁移时会学到错的规则：
 *    ① 赛制 —— BO5 / 先到 3 局 / 每局 8 次 / 单局 90 秒。
 *       ⚠️ 这里说的「一致」是**规则形态**一致，不是两边共用同一个常量：8 次是 `BOT_MAX_GUESSES`
 *       （锁死不可配，因为它是自定标的锚点），与 `PARTY_MAX_GUESSES` 只是**数值相同**；
 *       90 秒也不是多人的**默认**时长，只是房主可选的一档（本页固定取这一档）；
 *    ② 棋盘 —— 标准八列（**删掉了星级列**，左右两块棋盘都是）。改这里同时会改到人机：
 *       它「注意到」的列必须与玩家看得见的列一致，所以 `TIER_ATTRS` 里也没有 rarity；
 *    ③ 同时落子 —— 双方各自计时、互不阻塞，不是回合制。
 *
 * ## 🔴 `data-mode="multi"` 是**故意的**，不是笔误
 *
 * `v12-components.css:1396` 的 `--mc` 强调色与响应式布局规则只认 multi / party 两个值。
 * 写 `data-mode="bot"` 会**退化成单人青绿且丢掉那几条布局规则** —— 而人机对战本质就是
 * 多人赛制的 1v1，视觉上应当与多人页同族。挂 multi 拿满那套样式，零 CSS 改动。
 * （这不是「自行推导形态」：AI 是多人模式的**对手替身**，不是第六种玩法。）
 *
 * ## 人机拿不到答案
 *
 * 谜底确实在本页内存里（`roundRef.current.target`），但人机拿不到它 —— `botPick(brain)`
 * 的入参里根本没有 target，`botLearn` 只吃一行**与玩家棋盘逐字相同的反馈**。
 * 这条不变量的结构保证与哨兵见 `src/lib/bot-engine.ts` 文件头。
 *
 * ## 一局什么时候结束（这条直接决定人机的准确率）
 *
 * 四条出口，任何一条命中即结算：
 *   · 人机猜中 → 人机赢本局
 *   · 玩家猜中 → 玩家赢本局
 *   · **玩家用满 8 次仍未猜中 → 平局**（人机的窗口到此为止，见下）
 *   · 单局 90 秒耗尽 → 平局
 *
 * 第三条是**人机定标的口径来源**：`tests/bot-engine-test.mjs` 量的是「人机在自己的 8 次
 * 之内猜中」，而在真实对局里，人机的可用次数 = 玩家的猜测节奏 × 人机的落子间隔。
 * 玩家猜得快 → 人机的窗口被压缩 → 实际命中率低于标称值。
 * ⚠️ 这不是 bug，是把「你的猜测预算怎么花」变成了真实决策：猜得急 = 可能浪费次数，
 *    猜得慢 = 给人机更多机会。所以定标表里那三个数是**上限**，玩家打得越快、人机越吃亏。
 */

/** 先到 3 局者胜（BO5），与多人模式的默认赛制一致 */
const WINS_NEEDED = 3;

/**
 * 档位 → i18n 键。**写成显式映射而不是模板字面量 `` t(`bot.tier${k}`) ``**：
 * 模板字面量虽然能过 `check-i18n-keys.mjs`（它靠 `/`([A-Za-z0-9._]+?)\$\{/` 收前缀，
 * 把 `bot.tier` 整段算作「被动态覆盖」），但那同时也意味着**键名打错时没有任何东西会拦**，
 * 只会在界面上原样显示 `bot.tierEsay`。写成字面量后，这些键会进 referenced 集合，
 * 键名一漂就在哨兵输出里现形。
 */
const TIER_LABEL_KEY: Record<BotTier, string> = {
  easy: 'bot.tierEasy',
  medium: 'bot.tierMedium',
  hard: 'bot.tierHard',
};

/**
 * 档位的**说明文案**（「低级人机：只看种族/阵营/性别…」）已按需求④整段删除 ——
 * 连同 `bot.description`（「为什么要搞人机」）一起。
 * ⚠️ 三档的**档位名**（`TIER_LABEL_KEY`）与局内状态文字**保留**，别顺手删。
 */

/** 回合结算卡自动进入下一局的停留时长（ms）。玩家点一下可立刻跳过。 */
const ROUND_END_MS = 3_000;

const roster = charactersData as Character[];

interface RoundState {
  target: Character;
  brain: BotBrain;
  myGuesses: GuessResult[];
  botGuesses: GuessResult[];
  /** 人机下一次落子的时间戳（由 tick 驱动，不是 setTimeout —— 见 BOT_TICK_MS 的注释） */
  nextBotAt: number;
  startedAt: number;
  ended: boolean;
}

interface MatchState {
  tier: BotTier;
  botIdentity: Character | null;
  myWins: number;
  botWins: number;
  /** 整场累计的玩家猜测数 —— 落库的 guess_count 是这个值，不是某一小局的 */
  myTotalGuesses: number;
  /** 本场已用过的谜底 id：既防连庄，也用来把人机的名字排除出谜底池 */
  pastTargets: string[];
  /** 存档只发一次（finishRound 可能被多条出口同时命中） */
  saved: boolean;
}

interface RoundWin {
  winner: 'me' | 'bot' | null;
  targetName: string;
  score: string;
}

/**
 * 一行 GuessComparisons → `colorRows` 形状的 11 槽颜色行。
 *
 * 槽位与 `server/socket/game.js` 的 `colorRows` 逐字对齐：
 *   [0] 名称列、[1..9] = class, subclass, faction, rarity, race, gender, releaseYear,
 *   position, tags、[10] artist。
 * 本页没有服务端，所以这行由前端**自己拼**，但形状必须一致 —— 右侧棋盘靠
 * `col.dataIdx` 取值，槽位错一格就是整块棋盘串色。
 *
 * ⚠️ `[0]` 名称列：多人房里由服务端判定「这次猜测是不是答案」。这里同样如实算 ——
 *    人机猜中的那一行名字列会变绿。但那一格**根本渲染不出来**：`isAnswer` 为真的那一步
 *    紧接着就 `finishRound('bot')`（见 botMove），而右侧棋盘整块挂在 `stage === 'playing'`
 *    之下，局一结就整块卸掉。所以绿格子只存在于 state 里，没有一个瞬间是可见的。
 *    （早先这里写的是「只在本局已结束时才可能被看到」—— 那是错的：局末渲染的是结算卡，
 *     棋盘不在场，所谓「看到了」的窗口并不存在。）
 */
function toColorRow(c: GuessComparisons, isAnswer: boolean): string[] {
  return [
    isAnswer ? 'correct' : 'wrong',
    c.class, c.subclass, c.faction, c.rarity, c.race, c.gender,
    c.releaseYear, c.position, c.tags,
    c.artist ?? 'wrong',
  ];
}

export default function BotPage() {
  const { t } = useI18n();
  const router = useRouter();

  const [stage, setStage] = useState<'menu' | 'playing' | 'roundEnd' | 'matchEnd'>('menu');
  const [tier, setTier] = useState<BotTier>('easy');

  // 渲染用的镜像 —— 权威状态全在下面两个 ref 里（tick 驱动的逻辑读 ref，不读 state，
  // 否则每一帧都会拿到创建闭包时的那份快照，人机会用 8 次第一步的候选集）
  const [botName, setBotName] = useState('');
  const [myGuesses, setMyGuesses] = useState<GuessResult[]>([]);
  const [botGuesses, setBotGuesses] = useState<GuessResult[]>([]);
  const [guessedIds, setGuessedIds] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<Character | null>(null);
  const [myWins, setMyWins] = useState(0);
  const [botWins, setBotWins] = useState(0);
  const [timeLeft, setTimeLeft] = useState(Math.ceil(BOT_ROUND_TIME / 1000));
  const [botOut, setBotOut] = useState(false);
  const [roundWin, setRoundWin] = useState<RoundWin | null>(null);
  const [matchEnd, setMatchEnd] = useState<{ won: boolean } | null>(null);
  const [showSurrenderConfirm, setShowSurrenderConfirm] = useState(false);

  const roundRef = useRef<RoundState | null>(null);
  const matchRef = useRef<MatchState>({
    tier: 'easy', botIdentity: null, myWins: 0, botWins: 0, myTotalGuesses: 0,
    pastTargets: [], saved: false,
  });
  const myBoardScrollRef = useRef<HTMLDivElement>(null);
  const botBoardScrollRef = useRef<HTMLDivElement>(null);

  /**
   * 右侧棋盘的列定义。**与左盘逐字相同**（多人房也是两侧同列），本页两盘都去掉星级。
   *
   * dataIdx 用 ATTR_KEYS 的下标 +1 —— 前 9 个词条在 ATTR_KEYS 与 ALL_ATTR_KEYS 里下标相同，
   * 所以直接 `1 + i` 是对的。⚠️ 若日后把 artist 也放进右盘，必须改成
   * `1 + ALL_ATTR_KEYS.indexOf(a)`，否则画师列会去读**名字列**的颜色（静默串色）。
   *
   * 🔴 **删列时顺序不能反**：先 `.map()` 拿到原下标算好 `dataIdx`，**再** `.filter()` 掉
   *    rarity。反过来的话 `i` 变成过滤后的新下标，从 rarity 之后的所有列都会去读前一列的
   *    颜色 —— 而且是**看起来很正常**的错色，只有逐格对答案才看得出来。
   */
  const displayCols = useMemo(() => ([
    { key: 'name', label: t('table.name'), dataIdx: 0 },
    ...ATTR_KEYS
      .map((a, i) => ({ key: a as string, label: t(ATTR_LABEL_KEYS[a]), dataIdx: 1 + i }))
      .filter(c => c.key !== 'rarity'),
  ]), [t]);

  const botColorRows = useMemo(
    () => botGuesses.map(g => toColorRow(g.comparisons, target ? g.character.id === target.id : false)),
    [botGuesses, target],
  );

  // ───────────────────────── 结算 ─────────────────────────

  /**
   * 结算本局。**多条出口可能同时命中**（例如玩家第 8 猜正好也是「用满次数」），
   * 所以入口用 `r.ended` 做了幂等闸 —— 重复调用直接返回，不会多加一胜。
   */
  const finishRound = useCallback((winner: 'me' | 'bot' | null) => {
    const r = roundRef.current;
    if (!r || r.ended) return;
    r.ended = true;

    const m = matchRef.current;
    if (winner === 'me') m.myWins++;
    else if (winner === 'bot') m.botWins++;

    setMyWins(m.myWins);
    setBotWins(m.botWins);

    const score = `${m.myWins}-${m.botWins}`;
    if (m.myWins >= WINS_NEEDED || m.botWins >= WINS_NEEDED) {
      const won = m.myWins >= WINS_NEEDED;
      // 存档走 mode='bot'：只进人机专属榜，不进个人战绩聚合，也不进个人历史
      // （服务端三处谓词见 routes/user.js）。这里守一次 saved，避免双开。
      if (!m.saved) {
        m.saved = true;
        saveBotStats(won, m.myTotalGuesses, m.tier, r.target.name);
      }
      // 🔴 终局也要把**最后一局的谜底**亮出来（和多人房同形态：那边是在结算卡上
      //    加一行「本场结束」，同样会揭晓答案）。只 setMatchEnd 不 setRoundWin 的话，
      //    整场里唯一看不到答案的就是决定胜负的那一局 —— 而它恰恰是最想看的那局。
      setRoundWin({ winner, targetName: r.target.name, score });
      setMatchEnd({ won });
      setStage('matchEnd');
    } else {
      setRoundWin({ winner, targetName: r.target.name, score });
      setStage('roundEnd');
    }
  }, []);

  // ───────────────────────── 人机落子 ─────────────────────────

  const botMove = useCallback((r: RoundState) => {
    const m = matchRef.current;
    const guess = botPick(r.brain);
    if (!guess) { finishRound(null); return; }   // 候选集空（理论不发生，见 BotBrain 不变量）

    const result = makeGuess(r.target, guess);   // 谜底在这里，但只用来产出**反馈行**
    r.botGuesses = [...r.botGuesses, result];
    setBotGuesses(r.botGuesses);

    if (isWin(r.target, guess)) { finishRound('bot'); return; }

    // 收窄候选集：吃的是上面那行反馈，与玩家在自己棋盘上看到的逐字相同
    r.brain = botLearn(r.brain, guess, result.comparisons);

    if (r.botGuesses.length >= BOT_MAX_GUESSES) {
      // 人机次数用尽。本局**不因此结束** —— 玩家可能还剩次数，仍可自己猜中取胜。
      // 但人机这边的出口已经关死了（它再也赢不了），所以清掉「思考中」的提示。
      setBotOut(true);
      return;
    }
    // ⚠️ 这里**保持** botDelayMs（档位的思考节奏），不要跟 newRound 那行「顺手统一」成
    //    BOT_FIRST_DELAY_MS —— 需求③只要求**第一猜**快，之后本来就该有思考感。
    r.nextBotAt = Date.now() + botDelayMs(m.tier);
  }, [finishRound]);

  // ───────────────────────── 玩家的 tick ─────────────────────────

  /**
   * 单局的心跳：推进计时器 + 到点让人机落子。
   *
   * 两件事共用**一个** interval 是有意的 —— 拆成两个定时器后，「人机该落子」与
   * 「时间到」会在同一瞬间竞争，落在那条缝里的一猜会被吞掉，且只在极偶然的时序下复现。
   *
   * ⚠️ 到点判定必须排在 `botMove` **之前**，且判定成立时直接 return。
   *    反过来写时，超时那一拍里 `botMove` 会先跑完 —— 而 `botMove` 内部的 `finishRound`
   *    只挡 `r.ended`（幂等闸），它并不知道「已经超时」，于是人机在时间到之后仍能补一猜
   *    并照常计分结算。表现是「偶尔比 8 次多一猜」，只在 100ms 的那一拍里现形。
   */
  const tick = useCallback(() => {
    const r = roundRef.current;
    if (!r || r.ended) return;
    const now = Date.now();

    const remainMs = BOT_ROUND_TIME - (now - r.startedAt);
    const sec = Math.max(0, Math.ceil(remainMs / 1000));
    // 只在显示值变化时 setState：tick 是 100ms，不加这层闸就是每秒十次重渲染
    setTimeLeft(prev => (prev === sec ? prev : sec));

    if (remainMs <= 0) { finishRound(null); return; }
    if (r.botGuesses.length < BOT_MAX_GUESSES && now >= r.nextBotAt) botMove(r);
  }, [botMove, finishRound]);

  useEffect(() => {
    if (stage !== 'playing') return;
    const id = setInterval(tick, BOT_TICK_MS);
    return () => clearInterval(id);
  }, [stage, tick]);

  // ───────────────────────── 开局 / 开新局 ─────────────────────────

  const newRound = useCallback(() => {
    const m = matchRef.current;
    // 谜底从**全量池**里抽（BOT_POOL_DIFFICULTY = 'hard' = 全部 429 人）：
    // 人机的定标就是拿这个池子测的，池子一变那套 40/60/78.5% 立即作废。
    // recentIds 传人机的名字 + 本场已用过的谜底 → 既防连庄，也保证人机的名字
    // 不会是谜底（否则对面板上会同时出现「人机名」与「答案」，一眼穿帮）。
    const drawn = pickTarget(roster, BOT_POOL_DIFFICULTY, [
      ...(m.botIdentity ? [m.botIdentity.id] : []),
      ...m.pastTargets,
    ]);
    m.pastTargets = [...m.pastTargets, drawn.id];

    const now = Date.now();
    roundRef.current = {
      target: drawn,
      brain: createBrain(m.tier, roster),
      myGuesses: [],
      botGuesses: [],
      // 需求③：**每局的第一猜要快**（像真人一样先随手点一个熟悉的，而不是长考）。
      // 之后每一步回落到 botDelayMs —— 见 botMove 尾部那行，两处**故意不同**。
      nextBotAt: now + BOT_FIRST_DELAY_MS[m.tier],
      startedAt: now,
      ended: false,
    };
    setTarget(drawn);
    setMyGuesses([]);
    setBotGuesses([]);
    setGuessedIds(new Set());
    setTimeLeft(Math.ceil(BOT_ROUND_TIME / 1000));
    setBotOut(false);
    setRoundWin(null);
    // 🔴 必须清掉投降确认框。它不是「只属于某一局」的 UI —— 框开着的时候计时器照走、
    //    人机照猜，所以**局会自己结束**（超时 / 人机猜中），3 秒后本函数又开了新局，
    //    而框还挂在屏幕上（modal-mask 是固定层，盖着整页）。此时点「确认放弃」，
    //    `confirmSurrender` 拿到的是**新局**的 `roundRef.current`（ended 仍为 false），
    //    于是新一局零猜测被判负、比分与落库记录全错。`finishRound` 的 r.ended 幂等闸
    //    挡不住它 —— 那道闸挡的是同一局，这里连局都换了。
    //    渲染处的 `stage === 'playing'` 门只挡「结算卡那 3 秒」，挡不住「新局又回到 playing」，
    //    所以两处都要有。
    setShowSurrenderConfirm(false);
    setStage('playing');
  }, []);

  const startMatch = useCallback(() => {
    const identity = pickBotIdentity(roster);
    matchRef.current = {
      tier, botIdentity: identity, myWins: 0, botWins: 0, myTotalGuesses: 0,
      pastTargets: [], saved: false,
    };
    setBotName(identity.name);
    setMyWins(0);
    setBotWins(0);
    setMatchEnd(null);
    newRound();
  }, [tier, newRound]);

  const backToMenu = useCallback(() => {
    roundRef.current = null;
    setStage('menu');
    setShowSurrenderConfirm(false);
  }, []);

  /**
   * 结算卡停留 ROUND_END_MS 后**自动开下一局**（点卡片可立刻跳过）。
   *
   * 🔴 必须调 `newRound()`，不能只 `setStage('playing')` —— 后者只是把**已经结束的**
   *    那一局重新显示出来：`roundRef.current.ended` 仍是 true，tick 第一行就返回，
   *    棋盘定格、计时器不动、人机也再不落子，整个页面看着像卡死。
   *    （第一版就是这么写的，靠 stage 回到 playing 触发 tick 才没在静态检查里露出来。）
   *
   * stage 变成 matchEnd 时本 effect 不跑（依赖是 stage），所以不会误开新局。
   * 本 effect 必须声明在 newRound 之后：deps 数组里的 newRound 在渲染体里求值，
   * 放在前面会落在 const 的暂时性死区。
   */
  useEffect(() => {
    if (stage !== 'roundEnd') return;
    const id = setTimeout(newRound, ROUND_END_MS);
    return () => clearTimeout(id);
  }, [stage, newRound]);

  // ───────────────────────── 玩家落子 ─────────────────────────

  const handleGuess = useCallback((c: Character) => {
    const r = roundRef.current;
    if (!r || r.ended) return;
    // ⚠️ 到点后的那一猜不能算。tick 是 100ms 轮询，玩家在最后一拍里点下去时
    //    「时间到」还没被 tick 看到，这一猜会连同 isWin 一起结算 —— 表现是
    //    「计时器显示 0 秒了却还能猜中翻盘」。这里按 startedAt 自己判一次，不依赖 tick。
    if (Date.now() - r.startedAt >= BOT_ROUND_TIME) { finishRound(null); return; }
    if (r.myGuesses.length >= BOT_MAX_GUESSES) return;
    if (r.myGuesses.some(g => g.character.id === c.id)) return;   // 兜底（GameSearch 已禁用重复项）

    const result = makeGuess(r.target, c);
    r.myGuesses = [...r.myGuesses, result];
    matchRef.current.myTotalGuesses++;
    setMyGuesses(r.myGuesses);
    setGuessedIds(new Set(r.myGuesses.map(g => g.character.id)));

    if (isWin(r.target, c)) { finishRound('me'); return; }
    // 用满次数仍未猜中 → 本局平局。⚠️ 这一条**不是**「双方都用满」：
    // 玩家的 8 次就是人机的窗口（见文件头），所以玩家一出局，本局立即结算，
    // 不让玩家干等人机把剩下的次数猜完。
    if (r.myGuesses.length >= BOT_MAX_GUESSES) finishRound(null);
  }, [finishRound]);

  // 放弃本局 = 让出这一小局（人机得 1 分），**当场结算**，赛制继续。整场的退出在结算页。
  //
  // ⚠️ 这里**故意**与多人页不同，别「顺手统一」：
  //   多人页的 confirmSurrender 只置 `iSurrendered` + 发 `surrender_round`，本局**不结算**，
  //   要等对手猜中 / 耗尽 / 超时（那条规则的理由是：A 不该有权替**另一个真人**结束他的回合）。
  //   单人页没有第二个人 —— 照搬只会让玩家被 `inputDisabled` 锁住、干看人机按 6.8–10s 的
  //   节奏猜满 8 步（约一分钟），而结局几乎一样（困难档命中率 100%，人机照样赢）。
  //   代价是简单档那 ~46% 的「人机本来可能耗尽 → 本可平局」被按「认输」语义吃掉了，这是接受的。
  //   因此**不能**复用多人页的 `multi.confirmSurrenderDesc`（那句只说「无法继续猜测」，
  //   对多人页准确，对人机页漏说了「本局当场判负」），人机页用 `bot.confirmSurrenderDesc`。
  const confirmSurrender = useCallback(() => {
    setShowSurrenderConfirm(false);
    finishRound('bot');
  }, [finishRound]);

  const inputDisabled = myGuesses.length >= BOT_MAX_GUESSES;
  const remainingGuesses = Math.max(0, BOT_MAX_GUESSES - myGuesses.length);

  return (
    // data-mode 用 multi 而不是 bot —— 理由见文件头（bot 拿不到 --mc 与布局规则）
    <div className="page" data-mode="multi">
      <Header />
      <div className="page-scroll flex flex-col items-center">

        {/* ===== Menu ===== */}
        {stage === 'menu' && (
          <div className="card text-center w-full max-w-[450px]">
            <button onClick={() => router.push('/multiplayer')} className="btn-o mb-3">
              ← {t('multi.back')}
            </button>
            <ModeArt src="/icons/menu-multi.png" />
            <h1 className="scr-ttl mb-3.5">🤖 {t('bot.title')}</h1>

            <div className="sec-note mb-2">{t('bot.tierLabel')}</div>
            <div className="flex justify-center gap-2 mb-2 flex-wrap">
              {(['easy', 'medium', 'hard'] as const).map(k => (
                <button
                  key={k}
                  data-testid={`bot-tier-${k}`}
                  onClick={() => setTier(k)}
                  className={tier === k ? 'tchip on' : 'tchip off'}
                >
                  {t(TIER_LABEL_KEY[k])}
                </button>
              ))}
            </div>
            {/* 这里原本还有一行「本档注意到哪几列」的说明文案 + 顶上那句「为什么要搞人机」，
                已按需求④整段删除。⚠️ 档位按钮（`bot-tier-*`）与档位名保留。 */}

            <button onClick={startMatch} data-testid="bot-start" className="btn-p w-full">🤖 {t('bot.start')}</button>
          </div>
        )}

        {/* ===== Playing ===== */}
        {stage === 'playing' && (
          <div className="w-full">
            <div className="hud mb-3">
              <span className="lb2">{t('bot.you')} <span className="n" data-testid="bot-my-wins">{myWins}</span></span>
              <span className={timeLeft <= 30 ? 'n low' : 'n'} data-testid="bot-time">
                {String(Math.floor(timeLeft / 60)).padStart(2, '0')}:{String(timeLeft % 60).padStart(2, '0')}
              </span>
              <span className="lb2 sp" data-testid="bot-name">{botName} <span className="n" data-testid="bot-opp-wins">{botWins}</span></span>
            </div>
            <div className="flex justify-center gap-2 mb-3 flex-wrap">
              {/* ⚠️ 不给 GameSearch 传 target —— 它的 target 是「开发者 cheat（预留，暂未使用）」，
                  传真谜底等于把后门预先接好，日后有人实现那个 cheat 就会静默生效。 */}
              <GameSearch
                onGuess={handleGuess}
                disabled={inputDisabled}
                guessedIds={guessedIds}
                remainingGuesses={remainingGuesses}
              />
              {!inputDisabled && (
                <button onClick={() => setShowSurrenderConfirm(true)} data-testid="bot-surrender" className="btn-o btn-dan">
                  {t('multi.surrender')}
                </button>
              )}
            </div>
            <div className="sec-note text-center mb-3" data-testid="bot-status">
              {botOut ? t('bot.botOut') : t('bot.thinking', { name: botName })}
            </div>
            <div className="flex flex-wrap gap-3">
              <div className="flex-1 basis-[48%] min-w-[260px]">
                <div className="board-ttl">{t('multi.yourGuesses')}</div>
                <div ref={myBoardScrollRef} className="scroll-slider-container overflow-x-auto scroll-smooth">
                  {/* 恒 hideRarity（需求②：人机页棋盘删掉星级列）。
                      ⚠️ 收的必须是**常量 true**、不是 `{tier === 'hard'}` —— 本页的 difficulty
                      是**人机档位**而不是题库难度，把两者焊在一起会让三档的强度无法归因。
                      三档一律不显示星级：右侧人机盘同步删列，人机内部读的 `TIER_ATTRS` 也
                      去掉了 rarity（玩家看不见的信号，人机也不许用 —— 两边同信息才是干净基准）。 */}
                  <GuessTable
                    guesses={myGuesses}
                    target={target}
                    hideRarity
                    displayAttributes={null}
                    staggerKey={myGuesses.length}
                  />
                </div>
                <ScrollSlider containerRef={myBoardScrollRef} />
              </div>
              <div className="flex-1 basis-[48%] min-w-[260px]">
                <div className="board-ttl mc" data-testid="bot-board-title">{t('multi.oppGuesses', { name: botName, count: botGuesses.length })}</div>
                <div ref={botBoardScrollRef} className="scroll-slider-container overflow-x-auto scroll-smooth">
                  <table className="opp-grid" data-testid="bot-opp-grid">
                    <thead><tr>{displayCols.map((c, i) => <th key={i} className="zh">{c.label}</th>)}</tr></thead>
                    <tbody>
                      {botColorRows.length === 0
                        ? <tr><td colSpan={displayCols.length} className="empty">{t('multi.waitingOppGuess')}</td></tr>
                        : [...botColorRows].reverse().map((row, i) => (
                          <tr key={i} data-testid="bot-opp-row" className="animate-[surface-enter_0.35s_both]">
                            {displayCols.map((col, j) => {
                              const color = row[col.dataIdx] ?? '#444';
                              return (
                                <td key={j}>
                                  <span className={color === 'correct' ? 'opp-dot d-ok' : color === 'close' ? 'opp-dot d-cl' : color === 'wrong' ? 'opp-dot d-no' : 'opp-dot'} />
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
                <ScrollSlider containerRef={botBoardScrollRef} />
              </div>
            </div>
          </div>
        )}

        {/* ===== Round End ===== */}
        {stage === 'roundEnd' && roundWin && (
          <button
            onClick={newRound}
            data-testid="bot-round-end"
            className="card text-center w-full max-w-[400px] mt-4 cursor-pointer"
          >
            {/* 单局情绪图 —— 与多人页**取同一组图、同一个函数**（需求⑤）：
                  猜中 → right、战败 → error、平局/超时 → draw-1..5（FNV 哈希，不闪）。
                ⚠️ 这里传 `{ targetName, score }`（不含 reason）—— 人机局的平局与超时在
                   客户端**区分不出来**（`finishRound(null)` 两种来源共用一条出口），
                   所以取图种子只有名字与比分。这不影响「同一局恒定」，只是超时那一支
                   与多人页落到哪张图上可能不同 —— 这是**已知且可接受**的：
                   两边可用的信号本来就不同，硬凑只会让这段代码撒谎。 */}
            <ModeArt src={
              roundWin.winner === 'me' ? '/icons/right.png'
                : roundWin.winner === 'bot' ? '/icons/error.png'
                  : `/icons/draw-${drawArtIndex(roundWin)}.png`
            } />
            <div className="emoji-lg sm" data-testid="bot-round-result">
              {roundWin.winner === 'me' ? t('multi.youWinRound')
                : roundWin.winner === 'bot' ? t('multi.oppWinRound')
                  : t('multi.roundDraw')}
            </div>
            <p className="sec-note" data-testid="bot-answer">{t('multi.answerWithScore', { name: roundWin.targetName, score: roundWin.score })}</p>
            <p className="sec-note mt-3">{t('bot.nextRoundHint')}</p>
          </button>
        )}

        {/* ===== Match End ===== */}
        {stage === 'matchEnd' && matchEnd && (
          <div className="card text-center w-full max-w-[400px] mt-4" data-testid="bot-match-end">
            {/* 整场情绪图（需求⑤拍板）：整场胜 → happy.png、整场负 → error.png。
                与多人页 matchEnd 同图。 */}
            <ModeArt src={matchEnd.won ? '/icons/happy.png' : '/icons/error.png'} />
            <h2 className="scr-ttl mb-2" data-testid="bot-match-result">{matchEnd.won ? t('bot.matchWin') : t('bot.matchLose')}</h2>
            {/* 最后一局的谜底 —— 决定胜负的那一局反而最该看到答案（见 finishRound 的注释） */}
            {roundWin && (
              <p className="sec-note" data-testid="bot-final-answer">
                {t('multi.answerWithScore', { name: roundWin.targetName, score: roundWin.score })}
              </p>
            )}
            <p className="sec-note mb-4" data-testid="bot-match-score">{t('bot.matchScore', { mine: myWins, theirs: botWins })}</p>
            <div className="bar-actions justify-center">
              <button onClick={startMatch} data-testid="bot-restart" className="btn-p">🔄 {t('multi.playAgain')}</button>
              <button onClick={backToMenu} data-testid="bot-exit" className="btn-o">{t('multi.exit')}</button>
            </div>
          </div>
        )}

        {/* ===== Surrender Confirm ===== */}
        {/* `stage === 'playing'` 这道门**不是**冗余：确认框只对「正在打的这一局」有意义，
            而 stage 在局末会离开 playing（roundEnd / matchEnd）。少了它，框会盖在结算卡上。 */}
        {stage === 'playing' && showSurrenderConfirm && (
          <div className="modal-mask">
            <div className="dlg dan text-center">
              <p className="dt justify-center">{t('multi.confirmSurrenderTitle')}</p>
              {/* ⚠️ 人机页**不能**用 `multi.confirmSurrenderDesc`：那边「放弃」后本局还在打
                  （只是你不能猜了），这边是当场判负 —— 同一个字符串描述不了两种后果。
                  理由详见 confirmSurrender 上方的注释。标题（确定放弃本局？）两页同义，可共用。 */}
              <p className="db">{t('bot.confirmSurrenderDesc')}</p>
              <div className="df justify-center">
                {/* testid 给冒烟用：确认按钮与「放弃本局」按钮在同一屏上不会同时出现，
                    但按文案定位会随 i18n 改词而失效，故钉 testid。 */}
                <button onClick={() => setShowSurrenderConfirm(false)} data-testid="bot-surrender-cancel" className="btn-o">{t('multi.cancel')}</button>
                <button onClick={confirmSurrender} data-testid="bot-surrender-confirm" className="btn-bandan">{t('multi.confirmSurrender')}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
