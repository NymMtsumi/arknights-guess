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
import { saveBotStats, type GuessLogEntry } from '@/lib/stats';
import {
  BOT_FIRST_DELAY_MS, BOT_MAX_GUESSES, BOT_POOL_DIFFICULTY, BOT_ROUND_TIME, BOT_TICK_MS,
  BOT_TIER_MAX_GUESSES,
  botDelayMs, botLearn, botPick, createBrain, pickBotIdentity, warmUp,
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
 *    ① 赛制 —— BO5 / 先到 3 局 / **玩家每局 8 次** / 单局 90 秒。
 *       ⚠️ 这里说的「一致」是**规则形态**一致，不是两边共用同一个常量：玩家的 8 次是
 *       `BOT_MAX_GUESSES`（锁死不可配，因为它是自定标的锚点），与 `PARTY_MAX_GUESSES`
 *       只是**数值相同**；90 秒也不是多人的**默认**时长，只是房主可选的一档（本页固定取这一档）。
 *       🔴 2026-10-17 起 **人机的出手次数与玩家解耦**：每档有自己的 `BOT_TIER_MAX_GUESSES`
 *       （低/中各 6 次、高档 8 次）—— 这是难度旋钮，不是规则变更：玩家始终是 8 次。
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
 *   · 人机用满**本档**的出手次数（`BOT_TIER_MAX_GUESSES`）仍未猜中 → 它再也赢不了，
 *     状态行提示「对方已用完 N 次猜测」，但本局**不结束**：玩家仍可继续猜并取胜。
 *
 * 第三条是**人机定标的口径来源**：`tests/bot-engine-test.mjs` 量的是「人机在本档出手次数
 * 之内猜中」，而在真实对局里，人机的可用次数还受**玩家的猜测节奏 × 人机的落子间隔**挤压。
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

// 🔴 2026-10-17 起**没有**「结算卡自动进入下一局」这个常量了。
// 原来的 `ROUND_END_MS = 3000` 会在 3 秒后无条件开下一局 —— 玩家刚打完一局、比分还没看清，
// 下一局已经开始计时（90 秒照走）。现在改成**由玩家决定**：结算卡上有明确的「开始下一局」
// 按钮（`bot-next-round`），不点就一直停在结算页，想休息多久都行。
// 为什么不做成「15 秒后自动开始」：那仍然会在玩家放下手机时偷偷开一局并计时，
// 而这正是用户要求修掉的那种体验（「要有休息时间或让玩家决定」）。
// ⚠️ 别把这段改回自动跳转：`tests/bot-smoke.mjs` 现在按「点按钮才进下一局」验证。

const roster = charactersData as Character[];

interface RoundState {
  target: Character;
  brain: BotBrain;
  myGuesses: GuessResult[];
  botGuesses: GuessResult[];
  /** 人机下一次落子的时间戳（由 tick 驱动，不是 setTimeout —— 见 BOT_TICK_MS 的注释） */
  nextBotAt: number;
  startedAt: number;
  /**
   * 页面隐藏的起始时刻（0 = 未暂停）。
   *
   * 🔴 2026-10-17 加。浏览器会把后台标签页的 setInterval 节流到 >=1000ms（>5min 时 1 次/60s），
   * 而回合计时用 Date.now() 照走 —— 结果是**玩家不在场时人机继续落子**：hard 约 49s、
   * easy 约 52s 就能打满本档 6 次/猜中，整场 0:3 输掉**并已落库**（saveBotStats 不阻塞）。
   * 玩家回来看到的是结算卡或残局，观感就是「人机卡住/步时不对/水平没变却输了」。
   * （2026-10-17 晚起结算卡不再自动开下一局，所以「后台连打 3 局」这条链更依赖这道冻结 ——
   *   没有它，玩家切走的 90 秒里人机仍会赢下当小局，只是不会再自动开新局。）
   *
   * 暂停期间 tick 直接返回（计时与人机都冻结），恢复时把 startedAt / nextBotAt
   * 一并后移相同的时长 —— 这样「切走一小时再回来」只是白白过去一小时的墙钟时间。
   */
  pausedAt: number;
  ended: boolean;
}

interface MatchState {
  tier: BotTier;
  botIdentity: Character | null;
  myWins: number;
  botWins: number;
  /** 整场累计的玩家猜测数 —— 落库的 guess_count 是这个值，不是某一小局的 */
  myTotalGuesses: number;
  /**
   * 本场**玩家**的猜测序列 + 每步耗时（见 `GuessLogEntry`，2026-10-18 加了时间维度）。
   *
   * 与人机自己的猜测无关 —— 采的是「人类怎么选点、每步给他多久」，
   * 随存档一起进 `games.guess_log`（用途见 `src/lib/stats.ts` 的 saveBotStats 注释）。
   * `t` 是**相对本小局开始**的毫秒（局间玩家可能休息几分钟，绝不能混进步速里），
   * `r` 是小局序号。只在本地累积，不发中间请求。
   */
  myGuessLog: GuessLogEntry[];
  /** 当前小局序号（0 起）。每局 `newRound` 时更新，用来给 `GuessLogEntry.r` 赋值。 */
  roundIndex: number;
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
  // 否则每一帧都会拿到创建闭包时的那份快照，人机会整档都用开局那份候选集）
  const [botName, setBotName] = useState('');
  const [myGuesses, setMyGuesses] = useState<GuessResult[]>([]);
  const [botGuesses, setBotGuesses] = useState<GuessResult[]>([]);
  const [guessedIds, setGuessedIds] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<Character | null>(null);
  const [myWins, setMyWins] = useState(0);
  const [botWins, setBotWins] = useState(0);
  const [timeLeft, setTimeLeft] = useState(Math.ceil(BOT_ROUND_TIME / 1000));
  const [botOut, setBotOut] = useState(false);
  /**
   * 本局人机**出手次数上限**（`BOT_TIER_MAX_GUESSES[档]`），在 `newRound` 时落到 state。
   *
   * 为什么不直接在渲染里读 `matchRef.current.tier`：**ref 不能在渲染期读** ——
   * eslint 的 `react-hooks/refs` 会直接报 "Cannot access refs during render"，
   * 而且它确实有实际风险（ref 变了不触发重渲染，文案会停在上一档的次数）。
   * tick / botMove 里读 ref 是合法的（那是回调，不在渲染期）。
   */
  const [botMaxGuesses, setBotMaxGuesses] = useState(BOT_MAX_GUESSES);
  const [roundWin, setRoundWin] = useState<RoundWin | null>(null);
  const [matchEnd, setMatchEnd] = useState<{ won: boolean } | null>(null);
  const [showSurrenderConfirm, setShowSurrenderConfirm] = useState(false);

  const roundRef = useRef<RoundState | null>(null);
  const matchRef = useRef<MatchState>({
    tier: 'easy', botIdentity: null, myWins: 0, botWins: 0, myTotalGuesses: 0,
    myGuessLog: [], roundIndex: 0, pastTargets: [], saved: false,
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
        saveBotStats(won, m.myTotalGuesses, m.tier, r.target.name, m.myGuessLog);
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

    // 人机自己的次数预算（每档不同，见 BOT_TIER_MAX_GUESSES）；
    // 玩家的 8 次是另一条独立口径（BOT_MAX_GUESSES），两者别混用。
    if (r.botGuesses.length >= BOT_TIER_MAX_GUESSES[m.tier]) {
      // 人机次数用尽。本局**不因此结束** —— 玩家可能还剩次数，仍可自己猜中取胜。
      // 但人机这边的出口已经关死了（它再也赢不了），所以清掉「思考中」的提示。
      setBotOut(true);
      return;
    }
    // ⚠️ 这里**保持** botDelayMs（档位的思考节奏），不要跟 newRound 那行「顺手统一」成
    //    BOT_FIRST_DELAY_MS —— 需求③只要求**第一猜**快，之后本来就该有思考感。
    // 量化校正（2026-10-17）：以「上一次**期望**落子时刻」为基准推进，而不是 Date.now()。
    // 旧写法每步都被 tick 量化（前台 <=100ms、后台 <=900ms）单边累加，观感是「越走越慢」。
    // 用累加后，落子时刻的抖动只取决于 botDelayMs，与 tick 相位无关。
    const delay = botDelayMs(m.tier);
    r.nextBotAt += delay;
    if (r.nextBotAt < Date.now()) r.nextBotAt = Date.now() + delay; // 兜底：暂停后重置/时钟异常
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
   *    并照常计分结算。表现是「偶尔比本档次多一猜」，只在 100ms 的那一拍里现形。
   */
  const tick = useCallback(() => {
    const r = roundRef.current;
    if (!r || r.ended) return;
    // 页面隐藏期间整局冻结：计时与人机都不推进（见 RoundState.pausedAt）
    if (r.pausedAt > 0) return;
    const now = Date.now();

    const remainMs = BOT_ROUND_TIME - (now - r.startedAt);
    const sec = Math.max(0, Math.ceil(remainMs / 1000));
    // 只在显示值变化时 setState：tick 是 100ms，不加这层闸就是每秒十次重渲染
    setTimeLeft(prev => (prev === sec ? prev : sec));

    if (remainMs <= 0) { finishRound(null); return; }
    if (r.botGuesses.length < BOT_TIER_MAX_GUESSES[matchRef.current.tier] && now >= r.nextBotAt) botMove(r);
  }, [botMove, finishRound]);

  useEffect(() => {
    if (stage !== 'playing') return;
    const id = setInterval(tick, BOT_TICK_MS);
    return () => clearInterval(id);
  }, [stage, tick]);

  /**
   * 页面隐藏 → 冻结本局；恢复 → 把两把时钟一起后移。
   *
   * 🔴 这是本页唯一一处「与浏览器节流正面交锋」的地方。没有它时：切走标签页后 tick 被
   * 压到 >=1000ms（>5min 时 1 次/60s），但 startedAt/nextBotAt 仍按墙钟走 —— 玩家不在场，
   * 人机照样落子、自动打完 3 局、整场记负并落库。加上它之后，隐藏期间的墙钟时间被
   * 「退还」给本局，两端都不再偷跑。
   *
   * ⚠️ 只处理 playing 阶段：结算卡（roundEnd）不冻结是**有意的** —— 那一局已经结束、
   * 计时已停，而且现在**不会再自动开下一局**（要玩家点「开始下一局」），所以后台待着
   * 也不会偷走任何一局。
   */
  useEffect(() => {
    const onVisibility = () => {
      const r = roundRef.current;
      if (!r || r.ended) return;
      if (document.hidden) {
        if (r.pausedAt === 0) r.pausedAt = Date.now();
      } else if (r.pausedAt > 0) {
        const delta = Date.now() - r.pausedAt;
        r.startedAt += delta;
        r.nextBotAt += delta;
        r.pausedAt = 0;
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // ───────────────────────── 开局 / 开新局 ─────────────────────────

  const newRound = useCallback(() => {
    // 防双触发 —— 用**状态**判断，不用时间窗（2026-10-17 晚改）。
    //
    // 原先是 `if (Date.now() - newRoundAtRef.current < 500) return;`。时间窗的问题是
    // **会吞掉合法点击**：只要「上一局开局的时刻」距今不足 500ms，真正的「开始下一局」
    // 就会被静默丢弃（实测：自动化测试里一局只用 91ms，第二局点按钮毫无反应、卡在 roundEnd；
    // 手速极快的真人同样可能撞上，而且没有任何反馈 —— 这类 bug 最难查）。
    //
    // 现在判据换成「**本局是否还活着**」：`roundRef.current && !ended` 说明局还在进行，
    // 此刻再开新局一定是重复触发（双击 / 同拍），直接返回；`ended === true`（结算卡）
    // 或 `null`（还没开过）则放行。
    // 为什么这样仍然挡得住双击：第一次调用末尾就把 `roundRef.current` 换成 `ended: false`
    // 的新局，第二次调用看到「还活着」立刻返回 —— 与时间无关，不会误伤任何合法点击。
    if (roundRef.current && !roundRef.current.ended) return;
    const m = matchRef.current;
    // 谜底从**全量池**里抽（BOT_POOL_DIFFICULTY = 'hard' = 全部 432 人）：
    // 人机的定标就是拿这个池子测的，池子一变那套 48.3/72.3/99.9% 立即作废。
    // recentIds 传人机的名字 + 本场已用过的谜底 → 既防连庄，也保证人机的名字
    // 不会是谜底（否则对面板上会同时出现「人机名」与「答案」，一眼穿帮）。
    const drawn = pickTarget(roster, BOT_POOL_DIFFICULTY, [
      ...(m.botIdentity ? [m.botIdentity.id] : []),
      ...m.pastTargets,
    ]);
    m.pastTargets = [...m.pastTargets, drawn.id];
    // 小局序号（0 起）：pastTargets 刚加进本局谜底，长度 - 1 就是本局序号
    m.roundIndex = m.pastTargets.length - 1;

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
      pausedAt: 0,
      ended: false,
    };
    setTarget(drawn);
    setMyGuesses([]);
    setBotGuesses([]);
    setGuessedIds(new Set());
    setTimeLeft(Math.ceil(BOT_ROUND_TIME / 1000));
    setBotOut(false);
    // 本档的出手次数落到 state（不能靠渲染期读 ref，见 botMaxGuesses 的注释）
    setBotMaxGuesses(BOT_TIER_MAX_GUESSES[m.tier]);
    setRoundWin(null);
    // 🔴 必须清掉投降确认框。它不是「只属于某一局」的 UI —— 框开着的时候计时器照走、
    //    人机照猜，所以**局会自己结束**（超时 / 人机猜中），而框还挂在屏幕上
    //    （modal-mask 是固定层，盖着整页）。此时点「确认放弃」，
    //    `confirmSurrender` 拿到的是**新局**的 `roundRef.current`（ended 仍为 false），
    //    于是新一局零猜测被判负、比分与落库记录全错。`finishRound` 的 r.ended 幂等闸
    //    挡不住它 —— 那道闸挡的是同一局，这里连局都换了。
    //    渲染处的 `stage === 'playing'` 门挡不住「新局又回到 playing」，所以两处都要有。
    //    （自动跳转删掉后这条路更难触发，但手动点「开始下一局」时框仍可能开着 —— 闸门保留。）
    setShowSurrenderConfirm(false);
    setStage('playing');
  }, []);

  /**
   * 菜单期预热 `openingOrder`（每档一次 432x432 全量排序，实测 ~0.25s）。
   *
   * 不预热的话，这笔开销落在**首局首猜的那一拍**上 —— 玩家看到的是「开局后 1.5 秒卡一下」。
   * 放到菜单期，卡顿发生在还没有对局的时候，且只在第一次进页 / 换档时付一次。
   */
  useEffect(() => {
    if (stage !== 'menu') return;
    const id = setTimeout(() => {
      // ⚠️ 走引擎的 warmUp 而不是在这里调 botPick —— check-bot-isolation.mjs 第 5 条
      //    要求 botPick 的实参恰好是 1 个 *.brain（那扇门是「顺手把答案传进来」）。
      try { warmUp(tier, roster); } catch { /* 预热失败不影响对局 */ }
    }, 50);
    return () => clearTimeout(id);
  }, [stage, tier]);

  const startMatch = useCallback(() => {
    const identity = pickBotIdentity(roster);
    matchRef.current = {
      tier, botIdentity: identity, myWins: 0, botWins: 0, myTotalGuesses: 0,
      myGuessLog: [], roundIndex: 0, pastTargets: [], saved: false,
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
   * 结算卡**不再自动进入下一局**（2026-10-17 改，见文件顶部 `ROUND_END_MS` 被删掉的注释）。
   *
   * 这里原先是一个 `setTimeout(newRound, ROUND_END_MS)`：3 秒后强制开新局。它带来两个问题 ——
   *   ① 玩家刚打完一局，还没看清比分/谜底就被推进下一局，且**下一局的 90 秒立刻开始计时**
   *      （`newRound` 里 `startedAt = Date.now()`），等于在他去倒水的 3 秒里白送一局；
   *   ② 它与结算卡的 `onClick` 没有互斥（同拍会 `newRound` 两次，新局谜底被换掉）。
   * 现在入口只有两处、都是玩家主动点击：结算卡上的「开始下一局」按钮（主入口）与整卡点击。
   * 所以这个 effect 被**故意删掉**了，不是漏写。
   *
   * ⚠️ 下次要加「休息多久后自动开始」时，必须先把「计时器什么时候开始走」与「结算页停留」
   *    解耦（例如把 startedAt 延迟到玩家首次落子），否则会自动偷走玩家的局。
   */

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
    // 采样本：玩家的猜测序列 + 每步耗时（t 相对本小局开始；跨小局累积，整场结束时随 saveBotStats 上报）
    matchRef.current.myGuessLog.push({ id: c.id, t: Math.max(0, Date.now() - r.startedAt), r: matchRef.current.roundIndex });
    setMyGuesses(r.myGuesses);
    setGuessedIds(new Set(r.myGuesses.map(g => g.character.id)));

    if (isWin(r.target, c)) { finishRound('me'); return; }
    // 用满次数仍未猜中 → 本局平局。⚠️ 这一条**不是**「双方都用满」：
    // 玩家的 8 次就是本局的窗口（见文件头），所以玩家一出局，本局立即结算，
    // 不让玩家干等人机把剩下的次数猜完。人机那侧另有自己的 `BOT_TIER_MAX_GUESSES`，
    // 它用完只意味着「再也赢不了」，**不**结束本局。
    if (r.myGuesses.length >= BOT_MAX_GUESSES) finishRound(null);
  }, [finishRound]);

  // 放弃本局 = 让出这一小局（人机得 1 分），**当场结算**，赛制继续。整场的退出在结算页。
  //
  // ⚠️ 这里**故意**与多人页不同，别「顺手统一」：
  //   多人页的 confirmSurrender 只置 `iSurrendered` + 发 `surrender_round`，本局**不结算**，
  //   要等对手猜中 / 耗尽 / 超时（那条规则的理由是：A 不该有权替**另一个真人**结束他的回合）。
  //   单人页没有第二个人 —— 照搬只会让玩家被 `inputDisabled` 锁住、干看人机按 4s 的
  //   节奏把本档次数猜满（easy 7 次约 25s、hard 8 次约 30s），而结局几乎一样
  //   （困难档命中率 99.9%，人机照样赢）。
  //   代价是低档那 ~40% 的「人机本来可能耗尽 → 本可平局」被按「认输」语义吃掉了，这是接受的。
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
              {botOut
                ? t('bot.botOut', { count: botMaxGuesses })
                : t('bot.thinking', { name: botName })}
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

        {/* ===== Round End =====
            🔴 2026-10-17 起**不自动**进入下一局：这里从 `<button onClick={newRound}>`
               改成了普通容器 + 显式「开始下一局」按钮。理由见文件顶部（原 ROUND_END_MS 的注释）：
               让玩家打完一局能喘口气、看清比分与谜底，**由他决定何时开始下一局的 90 秒**。
               ⚠️ 别把外层改回按钮：按钮里再放按钮是非法 HTML，且整卡点击会让玩家误触开新局。 */}
        {stage === 'roundEnd' && roundWin && (
          <div
            data-testid="bot-round-end"
            className="card text-center w-full max-w-[400px] mt-4"
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
            <button
              type="button"
              onClick={newRound}
              data-testid="bot-next-round"
              className="btn-p w-full mt-3"
            >
              ▶ {t('bot.nextRound')}
            </button>
          </div>
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
