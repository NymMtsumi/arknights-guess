// 回合管理 + 所有 Socket.IO 事件处理器
import { sanitizeString } from '../utils.js';
import { randomTarget } from '../characters.js';
import { ROUND_TIME, ROUND_TIME_PRESETS, ALL_ATTR_KEYS } from '../constants.js';
import { findCharByName, compareGuess, isAlterRelation, isWin } from '../game-engine.js';
import { createRoomCodeGuard } from './rate-limit.js';

const DISCONNECT = 30_000;
const DISBAND_COOLDOWN = 120_000; // 解散房间后 120 秒内不能创建新房间

/** 房间配置字段（自定义房带 attributes；标准房为 null） */
function roomConfig(room) {
  return {
    maxGuesses: room.maxGuesses ?? 8,
    roundTime: room.roundTime ?? ROUND_TIME,
    attributes: room.attributes ?? null,
    custom: !!room.custom,
  };
}

export function registerGameHandlers({
  io, rooms, roomPlayerIndex,
  findRoomByPlayerKey, findRoomByIdentityKey,
  genCode,
  onlinePlayers, onlineSockets, ONLINE_TIMEOUT,
  handleJoinQueue, handleLeaveQueue, removeFromQueue, cleanupStaleQueue,
}) {

  const roomCooldowns = new Map(); // playerKey → expiry timestamp (ms)
  // 房间码枚举防护：join_room / reconnect_room 都拿房间码当查询键（见 rate-limit.js 顶部注释）
  const roomCodeGuard = createRoomCodeGuard();

  // ===== 回合管理 =====
  function startRound(room) {
    if (room.finished) return;
    if (room._roundTimer) clearTimeout(room._roundTimer);
    // randomTarget 只返回 {id,name}，服务端对比需要完整干员数据，这里解析成完整对象（仅存服务端，不下发）
    const raw = randomTarget(room.difficulty || 'hard');
    const target = findCharByName(raw?.name) || raw;
    room.target = target;
    room.roundSettled = false;
    room.surrendered = new Set();
    room._roundStartAt = Date.now();
    // 跟踪本回合每位玩家的状态
    room._roundPlayers = new Map();
    for (const [sid, p] of room.players) {
      room._roundPlayers.set(sid, { guessed: false, exhausted: false, surrendered: false, guessChain: [], colorRows: [], alterFlags: [] });
    }

    const roundTime = room.roundTime ?? ROUND_TIME;
    const timer = setTimeout(() => {
      // 回合超时 = 平局（双方均未猜出且未放弃）
      if (room.roundSettled) return; // 防御：multi:guess 已先行结算
      room.roundSettled = true;
      room._roundStartAt = null;
      io.to(room.code).emit('round_end', {
        winner: null, winnerName: '', targetName: target.name,
        score: score(room), matchOver: false, reason: 'timeout',
      });
      room._nextRound = setTimeout(() => startRound(room), 5000);
    }, roundTime);
    room._roundTimer = timer;

    io.to(room.code).emit('round_start', {
      startTime: Date.now(), timeLimit: roundTime,
      score: score(room), difficulty: room.difficulty || 'hard',
      players: Array.from(room.players.entries()).map(([id, p]) => ({ id, name: p.name, wins: p.wins })),
      ...roomConfig(room),
    });
  }

  function endRound(room, winnerId, winnerName, targetName, matchOver) {
    if (room.roundSettled) return;
    room.roundSettled = true;
    room._roundStartAt = null; // 清除回合计时，防止重连时计算错误的 remainingTime
    if (room._roundTimer) { clearTimeout(room._roundTimer); room._roundTimer = null; }
    if (room._nextRound) { clearTimeout(room._nextRound); room._nextRound = null; }
    io.to(room.code).emit('round_end', { winner: winnerId, winnerName, targetName, score: score(room), matchOver });

    if (matchOver) {
      room.finished = true;
      room._finishedAt = Date.now();
      if (room._matchEndTimer) clearTimeout(room._matchEndTimer);
      room._matchEndTimer = setTimeout(() => {
        // Re-check: rematch_start may have reset finished flag
        if (!room.finished) return;
        io.to(room.code).emit('match_end', {
          winner: winnerId, winnerName, score: score(room),
          players: Array.from(room.players.entries()).map(([id, p]) => ({ id, name: p.name, wins: p.wins })),
        });
        for (const p of room.players.values()) {
          roomPlayerIndex.delete(p.playerKey);
          const e = onlinePlayers.get(p.playerKey);
          if (e && e.type === 'multi') { e.type = 'idle'; e.roomCode = null; }
        }
      }, 3000);
    } else {
      room._nextRound = setTimeout(() => startRound(room), 6000);
    }
  }

  function score(room) {
    // 按 playerKey 稳定排序，防止重连（delete+set 改变 Map 插入顺序）导致比分方向对调
    const arr = Array.from(room.players.values()).sort((a, b) => a.playerKey.localeCompare(b.playerKey));
    return `${arr[0]?.name || '?'} ${arr[0]?.wins || 0} - ${arr[1]?.wins || 0} ${arr[1]?.name || '?'}`;
  }

  /**
   * 重连快照载荷 —— 三处 reconnect_state（连接自动恢复 / join_room 重连 / reconnect_room）共用一份。
   *
   * ⚠️ 必须带上本回合的进度。原来这三处只发 code/bestOf/score/remainingTime/players，
   *    客户端重连后没有任何数据可以重建棋盘：自己猜过的行没了，对手的色块也没了。
   *    对手色块尤其没救 —— 唯一的推送通道是 opponent_update，而它只在**对手下一次猜测**
   *    时才发；对手若已猜完、已放弃或已断线，就永远补不回来。
   * @param scoreText 显式比分；join_room 分支在不足 2 人时要发空串，故留此口子。
   */
  function reconnectPayload(room, socketId, scoreText) {
    const hasActiveRound = !!room._roundStartAt;
    const roundTime = room.roundTime ?? ROUND_TIME;
    const remainingTime = hasActiveRound
      ? Math.max(0, Math.ceil((roundTime - (Date.now() - room._roundStartAt)) / 1000))
      : 0;
    const mine = room._roundPlayers?.get(socketId) || null;
    const oppId = Array.from(room.players.keys()).find((id) => id !== socketId) || null;
    const opp = oppId ? room._roundPlayers?.get(oppId) || null : null;
    return {
      code: room.code, bestOf: room.bestOf, winsNeeded: room.winsNeeded,
      score: scoreText !== undefined ? scoreText : score(room),
      remainingTime, hasActiveRound,
      difficulty: room.difficulty || 'hard',
      players: Array.from(room.players.entries()).map(([id, p]) => ({ id, name: p.name, wins: p.wins })),
      // 自己本回合的进度（客户端据此重建 GuessTable）
      myGuessChain: mine?.guessChain || [],
      myColorRows: mine?.colorRows || [],
      // 异格标记：与 myGuessChain 平行、只发本人。不入 myColorRows 的原因见
      // multi:guess 里 alterFlags 的注释（colorRows 会原样广播给对手）。
      // 服务端这侧先自证等长：客户端的兜底是「长度不等就整块不还原」，
      // 一份半截记录（chain 有、flags 短）会让整个快照作废、棋盘全空 —— 比只丢高亮更糟。
      // 这里不等长就直接回空数组，与 myColorRows 的失败形态保持一致。
      //
      // ⚠️ 开头的 `mine &&` 不是多余的：`mine?.a?.length === mine?.b?.length` 在 mine 为
      //    null 时两边都是 undefined，而 `undefined === undefined` 为 **true** → 取真分支 →
      //    求值 `mine.alterFlags` → 抛 TypeError。整个 reconnectPayload 随之抛出、被调用方
      //    catch 掉，**reconnect_state 一条都发不出去**（表现：重连后棋盘全空，且没有任何
      //    面向用户的报错）。mine 为 null 本身是异常状态（见 reconnect_room 的守卫），
      //    但快照函数不该因一个字段整体失效 —— 其余字段都已是 `mine?.x || []` 的降级口径。
      myAlterFlags: mine && mine.alterFlags?.length === mine.guessChain?.length ? mine.alterFlags : [],
      myGuessed: !!mine?.guessed,
      myExhausted: !!mine?.exhausted,
      mySurrendered: !!mine?.surrendered,
      // 对手本回合的进度（colorRows 与 opponent_update 的 allComparisons 同构）
      oppGuessCount: opp?.guessChain?.length || 0,
      oppColorRows: opp?.colorRows || [],
      oppSurrendered: !!opp?.surrendered,
      ...roomConfig(room),
    };
  }

  // ===== 注册所有 Socket 事件 =====
  io.on('connection', (socket) => {
    console.log(`[+] ${socket.id} pk=${socket.data.playerKey?.slice(0, 10)}`);

    // 在线追踪（保留已有的 type/roomCode，避免多标签页覆盖游戏状态）
    const pk = socket.data.playerKey;
    if (!onlineSockets.has(pk)) onlineSockets.set(pk, new Set());
    onlineSockets.get(pk).add(socket.id);
    const existingEntry = onlinePlayers.get(pk);
    onlinePlayers.set(pk, {
      playerKey: pk,
      displayName: socket.data.displayName || existingEntry?.displayName || '',
      username: socket.data.username || existingEntry?.username || null,
      userId: socket.data.userId || existingEntry?.userId || null,
      type: existingEntry?.type || 'idle',
      roomCode: existingEntry?.roomCode || null,
      lastSeen: Date.now(),
      lastIp: socket.data.ip || existingEntry?.lastIp || null,
    });

    // === 自动恢复：连接时查旧房 ===
    try {
    const existing = findRoomByPlayerKey(socket.data.playerKey);
    if (existing) {
      for (const [pid, player] of existing.players) {
        if (player.playerKey === socket.data.playerKey || player.identityKey === socket.data.identityKey) {
          // 旧 socket 仍被判定为在线 —— 有两种可能，服务端无法区分：
          //   (1) 真的是另一个标签页在玩；
          //   (2) 网络抖动：客户端 1s 就重连了（reconnectionDelay: 1000），而服务端
          //       要等 pingTimeout(15s) 才判定旧连接死亡，此刻那个「在线」的旧 socket
          //       只是个僵尸。1s~15s 的任意一次网络抖动都会落进这个窗口。
          //
          // 🔴 原先这里是 `socket.emit('error_msg', ...); return;` —— 那个 return 退出的是
          //    整个 io.on('connection') 回调，而下面所有 socket.on(...) 注册都在它后面。
          //    新连接于是「连着但一个事件都不监听」：客户端发得出 multi:guess 但永远收不到
          //    guess_result（表现为输入后毫无反应），重连也没有任何回执。
          //    雪上加霜的是客户端的 error_msg 处理器会 s.disconnect() 关掉自动重连，
          //    而 error 只在菜单/大厅渲染 —— 游戏界面看起来一切正常，只是全哑。
          //
          // 改为让新连接接管，并通知旧连接让位：僵尸收不到这条消息（无害），
          // 真正的第二个标签页会照旧收到 error_msg 并自行断开。
          // 通知放在接管之前发送即可 —— 客户端断开是异步的，届时接管早已完成。
          const oldSocket = io.sockets.sockets.get(pid);
          if (oldSocket && !player.dcTimer) {
            oldSocket.emit('error_msg', { message: '你已在另一标签页的游戏中' });
          }
          if (player.dcTimer) { clearTimeout(player.dcTimer); player.dcTimer = null; }
          player.identityKey = socket.data.identityKey;
          player.lastSocketId = pid;
          existing.players.delete(pid);
          existing.players.set(socket.id, player);
          // 重连后 socket.id 变化，同步迁移本回合玩家状态映射，否则重连者本回合无法继续猜
          // ⚠️ 先证 pid !== socket.id —— 见 reconnect_room 里同一惯用法的长注释：
          //    set 完同一把 key 紧接着 delete 掉 = 自我删除，且失败形态是静默的。
          //    本处 pid 取自旧连接、当前路径下恒不等，这里只是把这个惯用法钉死。
          if (pid !== socket.id && existing._roundPlayers?.has(pid)) {
            existing._roundPlayers.set(socket.id, existing._roundPlayers.get(pid));
            existing._roundPlayers.delete(pid);
          }
          socket.join(existing.code);
          socket.data.roomCode = existing.code;
          socket.to(existing.code).emit('opponent_reconnected', { playerName: player.name });
          socket.emit('existing_room', {
            code: existing.code, bestOf: existing.bestOf, difficulty: existing.difficulty || 'hard',
            started: existing.started, wins: player.wins, _createdAt: existing._createdAt,
            ...roomConfig(existing),
          });
          if (existing.started) {
            socket.emit('reconnect_state', reconnectPayload(existing, socket.id));
          }
          const reEntry = onlinePlayers.get(socket.data.playerKey);
          if (reEntry) { reEntry.type = 'multi'; reEntry.roomCode = existing.code; }
          console.log(`[恢复] ${socket.id} → ${existing.code}`);
          break;
        }
      }
    }
    } catch (e) { console.error('[game] connection auto-restore error:', e.message); }

    // === room:sync ===
    socket.on('room:sync', () => {
      const room = findRoomByIdentityKey(socket.data.identityKey);
      if (room && !room.finished) {
        socket.emit('room:sync', {
          room: { code: room.code, bestOf: room.bestOf, difficulty: room.difficulty || 'hard', started: room.started, status: room.started ? 'playing' : 'waiting', ...roomConfig(room) },
        });
      } else {
        socket.emit('room:sync', { room: null });
      }
    });

    // === matchmaking:join ===
    socket.on('matchmaking:join', (data) => {
      const existingR = findRoomByPlayerKey(socket.data.playerKey);
      if (existingR) {
        // 通过 playerKey/identityKey 查找玩家信息，而非 socket.id（重连后 id 会变）
        let wins = 0;
        for (const [, p] of existingR.players) {
          if (p.playerKey === socket.data.playerKey || p.identityKey === socket.data.identityKey) {
            wins = p.wins; break;
          }
        }
        socket.emit('existing_room', {
          code: existingR.code, bestOf: existingR.bestOf,
          difficulty: existingR.difficulty || 'hard', started: existingR.started,
          wins, _createdAt: existingR._createdAt,
          ...roomConfig(existingR),
        });
        return;
      }
      // 检查解散冷却
      const cooldownUntil = roomCooldowns.get(socket.data.playerKey);
      if (cooldownUntil && Date.now() < cooldownUntil) {
        const remaining = Math.ceil((cooldownUntil - Date.now()) / 1000);
        socket.emit('error_msg', { message: `解散房间后需等待 ${remaining} 秒才能进行快速匹配`, cooldown: remaining });
        return;
      }
      handleJoinQueue(socket, data);
    });

    // === matchmaking:leave ===
    socket.on('matchmaking:leave', () => handleLeaveQueue(socket));

    // === create_room ===
    socket.on('create_room', (data) => {
      try {
      const hasRoom = findRoomByPlayerKey(socket.data.playerKey);
      if (hasRoom) {
        socket.emit('existing_room', {
          code: hasRoom.code, bestOf: hasRoom.bestOf,
          difficulty: hasRoom.difficulty || 'hard', started: hasRoom.started,
          _createdAt: hasRoom._createdAt,
          ...roomConfig(hasRoom),
        });
        return;
      }

      // 检查解散冷却
      const cooldownUntil = roomCooldowns.get(socket.data.playerKey);
      if (cooldownUntil && Date.now() < cooldownUntil) {
        const remaining = Math.ceil((cooldownUntil - Date.now()) / 1000);
        socket.emit('error_msg', { message: `解散房间后需等待 ${remaining} 秒才能创建新房间`, cooldown: remaining });
        return;
      }

      if (data?._fromQuickRejoin) {
        socket.emit('room_expired', { message: '原房间已过期，已为您创建新房间' });
      }

      const code = genCode();
      const bestOf = Number.isInteger(data?.bestOf) && data?.bestOf >= 1 && data?.bestOf <= 7 ? data?.bestOf : 5;
      const difficulty = ['easy', 'medium', 'hard'].includes(data?.difficulty) ? data?.difficulty : 'hard';
      const maxGuesses = Number.isInteger(data?.maxGuesses) && data?.maxGuesses >= 1 && data?.maxGuesses <= 15 ? data?.maxGuesses : 8;
      const roundTime = ROUND_TIME_PRESETS.includes(data?.roundTime) ? data?.roundTime : ROUND_TIME;
      // 至少 3 个合法属性才算自定义房；否则退化为标准房（attributes = null）
      const rawAttrs = Array.isArray(data?.attributes)
        ? [...new Set(data.attributes.filter(a => ALL_ATTR_KEYS.includes(a)))] : [];
      const custom = rawAttrs.length >= 3;
      const attributes = custom ? rawAttrs : null;

      rooms.set(code, {
        code, bestOf, winsNeeded: Math.ceil(bestOf / 2), difficulty, _createdAt: Date.now(),
        maxGuesses, roundTime, attributes, custom,
        players: new Map([[socket.id, {
          name: sanitizeString(data?.playerName || '玩家', 20), wins: 0, dcTimer: null,
          lastSocketId: null, playerKey: socket.data.playerKey,
          identityKey: socket.data.identityKey, ready: false,
        }]]),
        started: false, finished: false,
      });
      socket.join(code);
      socket.data.roomCode = code;
      roomPlayerIndex.set(socket.data.playerKey, code);

      const entry = onlinePlayers.get(socket.data.playerKey);
      if (entry) { entry.type = 'multi'; entry.roomCode = code; }

      socket.emit('room_created', { code, bestOf, difficulty, ...roomConfig({ maxGuesses, roundTime, attributes, custom }) });
      console.log(`[房] ${code} BO${bestOf}${custom ? ' 自定义' : ''}`);
      } catch (e) { console.error('[game] create_room error:', e.message); }
    });

    // === join_room ===
    socket.on('join_room', (data) => {
      if (roomCodeGuard.blocked(socket, (msg) => socket.emit('error_msg', { message: msg }), 'join_room')) return;
      try {
      const code = (data?.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) { socket.emit('error_msg', { message: '房间不存在' }); return; }
      if (room.players.size >= 2) {
        for (const [pid, p] of room.players) {
          if (p.dcTimer && (p.playerKey === socket.data.playerKey || p.identityKey === socket.data.identityKey)) {
            if (p.dcTimer) clearTimeout(p.dcTimer);
            p.lastSocketId = pid;
            room.players.delete(pid);
            room.players.set(socket.id, p);
            // ⚠️ 同 reconnect_room：pid === socket.id 时下面两行会自我删除，先证不等。
            //    本处 pid 来自「带 dcTimer 的旧连接」，当前路径下恒不等。
            if (pid !== socket.id && room._roundPlayers?.has(pid)) {
              room._roundPlayers.set(socket.id, room._roundPlayers.get(pid));
              room._roundPlayers.delete(pid);
            }
            socket.join(code);
            socket.data.roomCode = code;
            roomPlayerIndex.set(socket.data.playerKey, code);
            const entry2 = onlinePlayers.get(socket.data.playerKey);
            if (entry2) { entry2.type = 'multi'; entry2.roomCode = code; }
            socket.to(code).emit('opponent_reconnected', { playerName: p.name });
            socket.emit('existing_room', { code, bestOf: room.bestOf, difficulty: room.difficulty || 'hard', started: room.started, wins: p.wins, _createdAt: room._createdAt, ...roomConfig(room) });
            if (room.started) {
              // 不足 2 人时比分留空（沿用原行为）
              socket.emit('reconnect_state', reconnectPayload(room, socket.id, room.players.size >= 2 ? score(room) : ''));
            }
            console.log(`[重连] ${socket.id} → ${code}`);
            return;
          }
        }
        socket.emit('error_msg', { message: '房间已满' }); return;
      }

      room.players.set(socket.id, {
        name: sanitizeString(data?.playerName || '玩家', 20), wins: 0, dcTimer: null,
        lastSocketId: null, playerKey: socket.data.playerKey,
        identityKey: socket.data.identityKey, ready: false,
      });
      socket.join(code);
      socket.data.roomCode = code;
      roomPlayerIndex.set(socket.data.playerKey, code);

      const entry3 = onlinePlayers.get(socket.data.playerKey);
      if (entry3) { entry3.type = 'multi'; entry3.roomCode = code; }

      room.started = true;
      startRound(room);
      console.log(`[房] ${code} 满员`);
      } catch (e) { console.error('[game] join_room error:', e.message); }
    });

    // === _log ===
    let _logCount = 0, _logResetAt = Date.now();
    socket.on('_log', (d) => {
      const now = Date.now();
      if (now - _logResetAt > 10_000) { _logCount = 0; _logResetAt = now; }
      if (++_logCount > 5) return; // 限速：每 10 秒最多 5 条
      const action = typeof d?.action === 'string' ? d.action.replace(/\n/g, '\\n').slice(0, 200) : '[invalid]';
      console.log(`[日志] ${action}`);
    });

    // === multi:guess ===（服务端权威对比：答案绝不下发客户端）
    socket.on('multi:guess', (data) => {
      try {
        const room = rooms.get(socket.data.roomCode);
        if (!room || room.finished || room.roundSettled) return;
        if (!room.players.has(socket.id)) return; // 防止 stale roomCode 跨房间数据泄露
        const player = room.players.get(socket.id);
        if (!room.target || !player) return;

        const rawName = sanitizeString(data?.name, 40);
        if (!rawName) return;
        const char = findCharByName(rawName);
        if (!char) return;
        const guessedName = char.name;

        const rp = room._roundPlayers?.get(socket.id);
        if (!rp) return;
        // 已猜出/已耗尽/已放弃 → 本回合不再受理任何猜测（防绕过 maxGuesses 的恶意续猜）
        // ⚠️ `surrendered` 这一项是**纵深防御**，不是主闸：客户端放弃后本地已经
        //    `inputDisabled`（multiplayer/page.tsx 的 iSurrendered）。但那是客户端的，
        //    而需求⑥之后「放弃」不再立刻结算本回合 —— 少这道闸，一个放弃了的玩家
        //    就能在回合继续的这段时间里继续猜，甚至把这一局赢回来。
        if (rp.guessed || rp.exhausted || rp.surrendered) return;
        // 去重：同一干员本回合只计一次
        if (rp.guessChain.includes(guessedName)) return;

        rp.guessChain.push(guessedName);
        const guessCount = rp.guessChain.length;
        const maxGuesses = room.maxGuesses ?? 8;
        const remaining = Math.max(0, maxGuesses - guessCount);

        // artist 只在房主选了画师词条时才算、才下发。标准房的 attributes 是 null，
        // 上面那一列本来就不渲染 —— 但载荷里带着它等于凭空开一条侧信道，见 compareGuess 的注释。
        const comparisons = compareGuess(room.target, char, {
          includeArtist: !!room.attributes?.includes('artist'),
        });
        const isAlter = isAlterRelation(room.target, char);
        const isCorrect = isWin(room.target, char);

        // 对手棋盘颜色行（与前端 ALL_ATTR_KEYS / displayCols.dataIdx 顺序一致，含 name 列）
        // 定长位置数组：[0]=name，[1..9]=9 个标准词条，[10]=artist（可选词条）。
        // ⚠️ 只能**末尾追加**。历史上就是靠「新增放末尾」保持前后端可分别部署：
        //    新前端+旧服务端 → row[10] 为 undefined，只有自定义房会去读它，标准房不受影响。
        //    槽位**恒定 11 个**：房间没开画师时第 11 槽置 null（前端 s() 兜成 'wrong'），
        //    不能因为 comparisons 少了 artist 就把数组缩成 10 —— 定长是这条契约的前提。
        const row = [
          isCorrect ? 'correct' : 'wrong',
          comparisons.class, comparisons.subclass, comparisons.faction,
          comparisons.rarity, comparisons.race, comparisons.gender,
          comparisons.releaseYear, comparisons.position, comparisons.tags,
          comparisons.artist ?? null,
        ];
        rp.colorRows.push(row);
        // 异格标记与 colorRows 平行、且**只回给本人**（见 reconnectPayload 的 myAlterFlags）。
        // ⚠️ 绝不能并进 colorRows：那一份经 opponent_update 原样广播给对手，
        //    而 isAlterRelation(target, guess) 直接告诉对手「答案是 X 的异格」——
        //    属性对比是刻意只给颜色的，多加一列等于给对手开一条侧信道。
        rp.alterFlags.push(isAlter);

        // 回执给猜测者（不下发答案，仅对比结果 + 胜负标记）
        socket.emit('guess_result', {
          name: guessedName,
          comparisons,
          correct: isCorrect,
          isAlter,
          guessCount,
          remainingGuesses: remaining,
          exhausted: !isCorrect && remaining <= 0,
        });

        // 广播给对手（只发颜色行，不发名字，防止从对手视角反推答案）
        socket.to(room.code).emit('opponent_update', {
          guessCount,
          allComparisons: rp.colorRows,
        });

        if (isCorrect) {
          // 已猜出：判胜（防重复上报）
          if (rp.guessed) return;
          rp.guessed = true;
          player.wins++;
          const won = player.wins >= room.winsNeeded;
          console.log(`[胜] ${player.name} ${player.wins}/${room.winsNeeded}`);
          endRound(room, socket.id, player.name, room.target.name, won);
          return;
        }

        // 出局检查：**其余所有玩家**都已出局（耗尽或放弃）→ 本回合无人可赢 → 平局。
        // 🔴 必须遍历**全部**对手，不能用 `find(id => id !== socket.id)` 只取一个：
        //    房间允许 >2 人（加入的判定下限只是 `players.size >= 2`，见 server/index.js），
        //    3 人房里「A 已放弃 + B 刚耗尽 + C 还在猜」会被这个 find 误判成「都出局了」，
        //    直接掐掉 C 的回合。需求⑥把「放弃」也并进出局条件之后，这条误判的触发面更大。
        // 🔴 出局 = 耗尽 **或** 放弃：需求⑥之后 A 放弃不再立刻结算，若这里只认 exhausted，
        //    「A 放弃 + B 耗尽」这条组合将**永远**不结算 —— 只能等 90 秒超时兜底。
        if (remaining <= 0) {
          rp.exhausted = true;
          const others = Array.from(room.players.keys()).filter(id => id !== socket.id);
          const allOthersOut = others.length > 0 && others.every((id) => {
            const o = room._roundPlayers?.get(id);
            return !!(o && (o.exhausted || o.surrendered));
          });
          if (allOthersOut) {
            console.log(`[耗尽] 其余玩家均已出局 → 平局`);
            endRound(room, null, '', room.target.name, false);
          }
        }
      } catch (e) { console.error('[game] multi:guess error:', e.message); }
    });

    // === surrender_round ===
    socket.on('surrender_round', (data) => {
      try {
      const room = rooms.get(socket.data.roomCode);
      if (!room || room.finished || room.roundSettled) return;
      const player = room.players.get(socket.id);
      if (!player) return;

      const rp = room._roundPlayers?.get(socket.id);
      if (rp) rp.surrendered = true;

      // 通知对方你已放弃
      socket.to(room.code).emit('opponent_surrendered', { playerName: player.name });

      // 判断胜负：
      // 注：不存在「对方已猜出」分支——multi:guess 猜对会立即 endRound 置 roundSettled=true，
      // 此处已因顶部 roundSettled 检查提前返回，故该分支不可达。

      // 其余玩家**全部**已出局（放弃或耗尽）→ 本回合无人可赢 → 立刻平局。
      // 🔴 遍历全部对手而非 `find(id => id !== socket.id)`：3 人房里 A 放弃、B 还在猜时
      //    只看一个对手会误判成「都出局了」，把 B 的回合掐掉。
      // KNOWN EDGE CASE: If two players surrender_round within the same event-loop tick,
      // the second emit may see the first's surrender flag set and take this "all out → draw"
      // branch. This is rare (< ~1ms race window) and the outcome is the same (draw),
      // so it is accepted without a setTimeout defense.
      const others = Array.from(room.players.keys()).filter(id => id !== socket.id);
      const allOthersOut = others.length > 0 && others.every((id) => {
        const o = room._roundPlayers?.get(id);
        return !!(o && (o.surrendered || o.exhausted));
      });
      if (allOthersOut) {
        console.log(`[弃权] 其余玩家均已出局 → 平局`);
        endRound(room, null, '', room.target?.name || '', false);
        return;
      }

      // 🔴 这里**故意没有任何 endRound** —— 需求⑥：A 放弃后本回合**不立即结算**。
      //    之前这里有一句无条件的 `endRound(..., null, ...)`（判平局），它就是
      //    「A 一放弃这局立刻结束」的来源。删掉之后：
      //      · A 已放弃 → 上面那道 `rp.surrendered` 闸挡住它再猜，它只能等；
      //      · B 猜中 → multi:guess 里的 isCorrect 分支照常 endRound，**B 赢下该局**；
      //      · B 耗尽 → 上面出局检查看到 A 已出局 → 平局；
      //      · 都不发生 → startRound 里那个 90 秒（房主可选）回合定时器兜底判平局。
      //    ⚠️ 别忘了 `startRound` 里那个回合定时器是本文件里这条新语义的**唯一兜底出口**。
      console.log(`[弃权] ${player.name} 弃权 → 本回合继续，等其余玩家猜中/耗尽/超时`);
      } catch (e) { console.error('[game] surrender_round error:', e.message); }
    });

    // === rematch_ready ===
    socket.on('rematch_ready', () => {
      try {
      const room = rooms.get(socket.data.roomCode);
      if (!room || !room.finished) return;
      const player = room.players.get(socket.id);
      if (!player) return;
      player.ready = true;

      if (room._rematchTimer) clearTimeout(room._rematchTimer);
      room._rematchTimer = setTimeout(() => {
        if (!room.finished) return;
        for (const p of room.players.values()) p.ready = false;
        io.to(room.code).emit('rematch_cancelled', { playerName: '系统', reason: 'timeout' });
      }, 60_000);

      if (Array.from(room.players.values()).every(p => p.ready) && room.players.size >= 2) {
        if (room._rematchTimer) { clearTimeout(room._rematchTimer); room._rematchTimer = null; }
        if (room._matchEndTimer) { clearTimeout(room._matchEndTimer); room._matchEndTimer = null; }
        room.players.forEach(p => { p.wins = 0; p.ready = false; });
        room.finished = false; room.target = null;
        for (const p of room.players.values()) roomPlayerIndex.set(p.playerKey, room.code);
        for (const p of room.players.values()) {
          const entry = onlinePlayers.get(p.playerKey);
          if (entry) { entry.type = 'multi'; entry.roomCode = room.code; }
        }
        io.to(room.code).emit('rematch_start', { bestOf: room.bestOf, winsNeeded: room.winsNeeded, difficulty: room.difficulty || 'hard', ...roomConfig(room) });
        setTimeout(() => startRound(room), 1500);
      }
      } catch (e) { console.error('[game] rematch_ready error:', e.message); }
    });

    // === rematch_cancel ===
    socket.on('rematch_cancel', () => {
      const room = rooms.get(socket.data.roomCode);
      if (!room || !room.finished) return;
      // 重置双方 ready 标志，防止一方取消后另一方 stale ready 导致误启动
      for (const p of room.players.values()) p.ready = false;
      if (room._rematchTimer) { clearTimeout(room._rematchTimer); room._rematchTimer = null; }
      socket.to(room.code).emit('rematch_cancelled', { playerName: room.players.get(socket.id)?.name });
    });

    // === disconnect ===
    socket.on('disconnect', () => {
      const pk = socket.data.playerKey;
      const sockSet = onlineSockets.get(pk);
      if (sockSet) {
        sockSet.delete(socket.id);
        if (sockSet.size === 0) {
          const entry = onlinePlayers.get(pk);
          if (entry) entry.lastSeen = Date.now();
        }
      }

      removeFromQueue(socket.id);

      const room = rooms.get(socket.data.roomCode);
      if (!room) return;
      // P1 fix: finished but rematch pending — still handle disconnect
      if (room.finished) {
        if (room._rematchTimer) {
          const p = room.players.get(socket.id);
          if (p) {
            p.dcTimer = null;
            p.ready = false; // R3: 防止断线后 rematch 带幽灵玩家启动
            io.to(room.code).emit('opponent_disconnected', { playerName: p.name });
            // B9 fix: 断线立即取消 rematch，不等待超时
            const other = Array.from(room.players.values()).find(x => x.playerKey !== p.playerKey);
            if (other) other.ready = false;
            clearTimeout(room._rematchTimer);
            room._rematchTimer = null;
            io.to(room.code).emit('rematch_cancelled', { playerName: '系统', reason: 'opponent_left' });
          }
        }
        return;
      }
      const player = room.players.get(socket.id);
      if (!player) return;
      player.lastSocketId = socket.id;
      player.identityKey = socket.data.identityKey;
      io.to(room.code).emit('opponent_disconnected', { playerName: player.name });

      player.dcTimer = setTimeout(() => {
        // 检查对方是否也离线了
        const otherId = Array.from(room.players.keys()).find(id => id !== socket.id);
        const otherPlayer = otherId ? room.players.get(otherId) : null;
        let bothOffline = false;
        if (otherPlayer) {
          const otherPk = otherPlayer.playerKey;
          const otherSocks = onlineSockets.get(otherPk);
          if (!otherSocks || otherSocks.size === 0) {
            bothOffline = true;
          }
        }

        if (bothOffline) {
          // 双方离线 → 解散房间，双方判负
          console.log(`[断线] 双方离线 → 解散房间 ${room.code}`);
          if (room._roundTimer) { clearTimeout(room._roundTimer); room._roundTimer = null; }
          if (room._nextRound) { clearTimeout(room._nextRound); room._nextRound = null; }
          io.to(room.code).emit('match_end', {
            winner: null, winnerName: '', score: score(room), reason: 'both_disconnected',
            players: Array.from(room.players.entries()).map(([id, p]) => ({ id, name: p.name, wins: p.wins })),
          });
          room.finished = true;
          room._finishedAt = Date.now();
          for (const p of room.players.values()) roomPlayerIndex.delete(p.playerKey);
          for (const p of room.players.values()) {
            const entry = onlinePlayers.get(p.playerKey);
            if (entry && entry.type === 'multi') { entry.type = 'idle'; entry.roomCode = null; }
          }
          return;
        }

        // 单方离线 → 离线方判负
        if (room.finished) return; // 比赛已正常结束，match_end 流程已处理
        if (room.roundSettled) {
          // 回合刚结束（等待下一回合），延长宽限期让玩家有机会重连
          if (player.dcTimer) clearTimeout(player.dcTimer);
          player.dcTimer = setTimeout(() => {
            if (room.finished) return;
            if (room._roundTimer) { clearTimeout(room._roundTimer); room._roundTimer = null; }
            if (room._nextRound) { clearTimeout(room._nextRound); room._nextRound = null; }
            io.to(room.code).emit('match_end', {
              winner: otherId, winnerName: otherPlayer?.name || '对手',
              score: score(room), reason: 'disconnect',
              players: Array.from(room.players.entries()).map(([id, p]) => ({ id, name: p.name, wins: p.wins })),
            });
            room.finished = true;
            room._finishedAt = Date.now();
            for (const p of room.players.values()) roomPlayerIndex.delete(p.playerKey);
            for (const p of room.players.values()) {
              const entry = onlinePlayers.get(p.playerKey);
              if (entry && entry.type === 'multi') { entry.type = 'idle'; entry.roomCode = null; }
            }
          }, DISCONNECT);
          return;
        }
        if (room._roundTimer) { clearTimeout(room._roundTimer); room._roundTimer = null; }
        if (room._nextRound) { clearTimeout(room._nextRound); room._nextRound = null; }
        io.to(room.code).emit('match_end', {
          winner: otherId, winnerName: otherPlayer?.name || '对手',
          score: score(room), reason: 'disconnect',
          players: Array.from(room.players.entries()).map(([id, p]) => ({ id, name: p.name, wins: p.wins })),
        });
        room.finished = true;
        room._finishedAt = Date.now();
        for (const p of room.players.values()) roomPlayerIndex.delete(p.playerKey);
        for (const p of room.players.values()) {
          const entry = onlinePlayers.get(p.playerKey);
          if (entry && entry.type === 'multi') { entry.type = 'idle'; entry.roomCode = null; }
        }
      }, DISCONNECT);
    });

    // === reconnect_room ===
    socket.on('reconnect_room', (data) => {
      if (roomCodeGuard.blocked(socket, (msg) => socket.emit('room_expired', { message: msg }), 'reconnect_room')) return;
      try {
      const code = (data?.code || '').toUpperCase();
      const room = rooms.get(code);

      if (!room) {
        socket.emit('room_expired', { message: '房间不存在或已过期' });
        return;
      }
      if (room.finished) {
        socket.emit('room_expired', { message: '比赛已结束' });
        return;
      }

      let foundPid = null;
      for (const [pid, p] of room.players) {
        if (p.playerKey === socket.data.playerKey || p.identityKey === socket.data.identityKey) {
          foundPid = pid; break;
        }
      }
      if (!foundPid) {
        socket.emit('room_expired', { message: '你不在该房间中' });
        return;
      }
      const player = room.players.get(foundPid);
      if (player.dcTimer) { clearTimeout(player.dcTimer); player.dcTimer = null; }
      room.players.delete(foundPid);
      room.players.set(socket.id, player);
      // ⚠️🔴 foundPid === socket.id 时必须**整块跳过**，否则下面两行会自我删除：
      //    自动恢复（本文件 connection 里的 [恢复] 分支）已经把该玩家挂到当前 socket.id
      //    名下了；浏览器重连后 mount 会再发一次 reconnect_room，此刻 foundPid 恰好 ===
      //    socket.id —— set 进去的那条紧接着被 delete 掉，玩家本回合状态凭空消失。
      //    失败形态全是**静默**的，线上没有面向用户的报错：
      //      ① reconnectPayload 的 mine 变 null → myAlterFlags 抛异常 → reconnect_state
      //         一条都发不出去 → 重连后棋盘全空；
      //      ② multi:guess 的 `const rp = ...?.get(socket.id); if (!rp) return;`
      //         → 本回合剩下的时间一次都猜不了（输入毫无反应）。
      //    2026-09-22 引入（7e79b3f）。回归脚本：tests/multi-reconnect-smoke.mjs
      if (foundPid !== socket.id && room._roundPlayers?.has(foundPid)) {
        room._roundPlayers.set(socket.id, room._roundPlayers.get(foundPid));
        room._roundPlayers.delete(foundPid);
      }
      socket.join(code);
      socket.data.roomCode = code;
      socket.to(code).emit('opponent_reconnected', { playerName: player.name });

      if (room.started) {
        socket.emit('reconnect_state', reconnectPayload(room, socket.id));
      } else {
        socket.emit('existing_room', {
          code, bestOf: room.bestOf, difficulty: room.difficulty || 'hard',
          started: false, wins: player.wins, _createdAt: room._createdAt,
          ...roomConfig(room),
        });
      }

      const reEntry = onlinePlayers.get(socket.data.playerKey);
      if (reEntry) { reEntry.type = 'multi'; reEntry.roomCode = code; }
      console.log(`[重连] ${socket.id} → ${code}`);
      } catch (e) { console.error('[game] reconnect_room error:', e.message); }
    });

    // === disband_room ===
    socket.on('disband_room', () => {
      try {
        const room = findRoomByPlayerKey(socket.data.playerKey);
        if (!room) { socket.emit('error_msg', { message: '你没有正在进行的房间' }); return; }
        if (room.started) { socket.emit('error_msg', { message: '游戏已开始，无法解散' }); return; }
        if (room.finished) return;

        const code = room.code;

        // 清理房间定时器
        if (room._roundTimer) clearTimeout(room._roundTimer);
        if (room._nextRound) clearTimeout(room._nextRound);
        if (room._matchEndTimer) clearTimeout(room._matchEndTimer);
        if (room._rematchTimer) clearTimeout(room._rematchTimer);

        // 清理玩家索引
        for (const p of room.players.values()) {
          roomPlayerIndex.delete(p.playerKey);
          const entry = onlinePlayers.get(p.playerKey);
          if (entry && entry.type === 'multi') { entry.type = 'idle'; entry.roomCode = null; }
        }

        // 通知房间内其他人（如果有）
        socket.to(code).emit('room_disbanded', { code, reason: 'host_disbanded' });

        // 删除房间
        rooms.delete(code);

        // 设置冷却时间（仅对房主）
        roomCooldowns.set(socket.data.playerKey, Date.now() + DISBAND_COOLDOWN);

        socket.emit('room_disbanded', { code, reason: 'disbanded', cooldown: DISBAND_COOLDOWN });
        console.log(`[房] ${code} 被房主解散, 冷却 ${DISBAND_COOLDOWN / 1000}s`);
      } catch (e) { console.error('[game] disband_room error:', e.message); }
    });
  });

  // ===== 周期清理（由 index.js 中统一的 setInterval 调用） =====
  function runPeriodicCleanup() {
    // 清理空/过期房间
    for (const [code, room] of rooms) {
      const socks = io.sockets.adapter.rooms.get(code);
      const cnt = socks ? socks.size : 0;
      if (cnt === 0) {
        // 跳过有 dcTimer 的房间（玩家在重连窗口内）
        let hasPendingDC = false;
        for (const p of room.players.values()) {
          if (p.dcTimer) { hasPendingDC = true; break; }
        }
        if (!hasPendingDC) {
          if (room._roundTimer) clearTimeout(room._roundTimer);
          if (room._nextRound) clearTimeout(room._nextRound);
          if (room._matchEndTimer) clearTimeout(room._matchEndTimer);
          if (room._rematchTimer) clearTimeout(room._rematchTimer);
          for (const p of room.players.values()) roomPlayerIndex.delete(p.playerKey);
          rooms.delete(code);
        }
      }
      if (!room.started && !room.finished && room._createdAt && Date.now() - room._createdAt > 300_000) {
        if (room._roundTimer) clearTimeout(room._roundTimer);
        if (room._matchEndTimer) clearTimeout(room._matchEndTimer);
        if (room._rematchTimer) clearTimeout(room._rematchTimer);
        for (const p of room.players.values()) roomPlayerIndex.delete(p.playerKey);
        rooms.delete(code);
      }
      if (room.finished && room._finishedAt && Date.now() - room._finishedAt > 300_000) {
        if (room._roundTimer) clearTimeout(room._roundTimer);
        if (room._matchEndTimer) clearTimeout(room._matchEndTimer);
        if (room._rematchTimer) clearTimeout(room._rematchTimer);
        for (const p of room.players.values()) roomPlayerIndex.delete(p.playerKey);
        rooms.delete(code);
      }
    }

    // 清理超时离线玩家
    const _now = Date.now();
    for (const [pk, entry] of onlinePlayers) {
      const sockSet = onlineSockets.get(pk);
      if ((!sockSet || sockSet.size === 0) && _now - entry.lastSeen > ONLINE_TIMEOUT) {
        onlinePlayers.delete(pk);
        onlineSockets.delete(pk);
      }
    }

    // 清理超时排队（委托给 matchmaking 模块，避免代码重复）
    cleanupStaleQueue();

    // 清理过期冷却
    for (const [pk, expiry] of roomCooldowns) {
      if (Date.now() >= expiry) roomCooldowns.delete(pk);
    }
  }

  return { startRound, endRound, score, runPeriodicCleanup, roomCooldowns };
}
