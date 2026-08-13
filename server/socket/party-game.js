// 派对模式 — 游戏逻辑（回合管理、排名计算、猜测处理）
import { randomTarget } from '../characters.js';
import { findCharByName, compareGuess, isAlterRelation } from '../game-engine.js';
import { sanitizeString } from '../utils.js';

const REVEAL_TIME = 15_000;
const MAX_GUESSES = 8;
const POINTS = [5, 3, 2, 1, 1, 1, 1, 1];

// 异步定时器兜底：定时器回调若抛错，Node 进程会直接崩溃，统一 try/catch 隔离
function safeTick(fn, label) {
  return (...args) => {
    try { fn(...args); }
    catch (e) { console.error(`[party-game] ${label} tick error:`, e.message); }
  };
}

export function createPartyGameModule(deps) {
  const { io, partyRooms, partyRoomPlayerIndex, onlinePlayers, broadcast, findPlayerInRoom } = deps;

  // ===== 回合开始 =====
  function partyRoundStart(room) {
    if (room.finished) return;
    if (room._roundTimer) clearTimeout(room._roundTimer);

    room.currentRound++;
    const roundTime = (room.settings.roundTime || 120) * 1000;
    // randomTarget 只返回 {id,name}，服务端对比需要完整干员数据，这里解析成完整对象（仅存服务端，不下发）
    const raw = randomTarget(room.settings.difficulty || 'hard');
    room.target = findCharByName(raw?.name) || raw;
    room.roundStartAt = Date.now();
    room.roundFinished = false;

    // 重置本回合玩家状态
    room.roundPlayers = new Map();
    for (const [sid, p] of room.players) {
      room.roundPlayers.set(sid, {
        playerKey: p.playerKey,
        guessed: false,
        exhausted: false,
        guessCount: 0,
        guessChain: [],
      });
    }
    room._foundRank = 0;

    const round = room.currentRound;
    const total = room.settings.rounds;

    room._roundTimer = setTimeout(safeTick(() => {
      if (room.roundFinished) return;
      endPartyRound(room);
    }, 'round_end'), roundTime);

    // 注意：绝不向客户端下发 target.name —— 答案仅存服务端，回合结束才揭晓。
    // 对比逻辑在服务端完成（见 handlePartyGuess），客户端只收到每次猜测的对比结果。
    broadcast(room, 'party:round_start', {
      round,
      totalRounds: total,
      difficulty: room.settings.difficulty || 'hard',
      timeLimit: roundTime,
      startTime: Date.now(),
      attributes: room.settings.attributes ?? null,
      maxGuesses: room.settings.maxGuesses ?? MAX_GUESSES,
    });

    room._tickInterval = setInterval(safeTick(() => {
      if (room.roundFinished) { clearInterval(room._tickInterval); room._tickInterval = null; return; }
      const elapsed = Date.now() - room.roundStartAt;
      const secondsLeft = Math.max(0, Math.ceil((roundTime - elapsed) / 1000));
      broadcast(room, 'party:timer_tick', { secondsLeft });
      if (secondsLeft <= 0) { clearInterval(room._tickInterval); room._tickInterval = null; }
    }, 'tick'), 1000);

    console.log(`[派对] 房间${room.code} 第${round}/${total}回合开始 目标=${target.name}`);
  }

  // ===== 回合结束 =====
  function endPartyRound(room) {
    if (room.roundFinished || !room.target) return;
    room.roundFinished = true;
    room.roundStartAt = null;
    if (room._roundTimer) { clearTimeout(room._roundTimer); room._roundTimer = null; }
    if (room._tickInterval) { clearInterval(room._tickInterval); room._tickInterval = null; }

    const round = room.currentRound;
    const total = room.settings.rounds;

    // 计算本回合排名
    const rankings = [];
    for (const [sid, rp] of room.roundPlayers) {
      if (rp.guessed) {
        const player = room.players.get(sid);
        if (!player) continue;
        rankings.push({
          playerId: sid,
          playerName: player.name,
          playerKey: player.playerKey,
          findOrder: rp.findOrder ?? 999,
          guessCount: rp.guessCount,
          guessChain: rp.guessChain,
        });
      }
    }
    rankings.sort((a, b) => (a.findOrder ?? 999) - (b.findOrder ?? 999));

    // 计算得分
    const roomRankings = [];
    let fewestCount = Infinity;
    rankings.forEach((r, i) => {
      const points = POINTS[i] || 1;
      const current = room.scores.get(r.playerKey) || 0;
      room.scores.set(r.playerKey, current + points);
      roomRankings.push({ ...r, pointsEarned: points });
      if (r.guessCount < fewestCount) fewestCount = r.guessCount;
    });

    // 最少猜测次数 bonus
    if (rankings.length > 0 && fewestCount < Infinity) {
      const fewestPlayers = rankings.filter(r => r.guessCount === fewestCount);
      if (fewestPlayers.length === 1) {
        const bonusPk = fewestPlayers[0].playerKey;
        const current = room.scores.get(bonusPk) || 0;
        room.scores.set(bonusPk, current + 1);
        const idx = roomRankings.findIndex(r => r.playerKey === bonusPk);
        if (idx >= 0) roomRankings[idx].pointsEarned += 1;
      }
    }

    // 未猜出的玩家
    for (const [sid, rp] of room.roundPlayers) {
      if (!rp.guessed) {
        const player = room.players.get(sid);
        if (!player) continue;
        roomRankings.push({
          playerId: sid,
          playerName: player.name,
          playerKey: player.playerKey,
          guessCount: rp.guessCount,
          guessChain: rp.guessChain,
          pointsEarned: 0,
          didNotGuess: true,
        });
      }
    }

    room.roundResults.push({
      round,
      targetName: room.target.name,
      targetId: room.target.id,
      rankings: roomRankings,
    });

    // 当前总分排名
    const totalScores = [];
    for (const [sid, player] of room.players) {
      totalScores.push({
        playerId: sid,
        playerName: player.name,
        playerKey: player.playerKey,
        score: room.scores.get(player.playerKey) || 0,
      });
    }
    totalScores.sort((a, b) => b.score - a.score);

    const isLastRound = round >= total;

    broadcast(room, 'party:round_end', {
      round,
      totalRounds: total,
      target: { name: room.target.name, id: room.target.id },
      rankings: roomRankings,
      totalScores,
      isLastRound,
    });

    console.log(`[派对] 房间${room.code} 第${round}回合结束`);

    if (isLastRound) {
      endPartyGame(room);
    } else {
      room._revealTimer = setTimeout(safeTick(() => {
        partyRoundStart(room);
      }, 'reveal'), REVEAL_TIME);
    }
  }

  // ===== 游戏结束 =====
  function endPartyGame(room) {
    room.finished = true;
    room._finishedAt = Date.now();
    if (room._revealTimer) { clearTimeout(room._revealTimer); room._revealTimer = null; }
    if (room._roundTimer) { clearTimeout(room._roundTimer); room._roundTimer = null; }
    if (room._tickInterval) { clearInterval(room._tickInterval); room._tickInterval = null; }
    if (room._countdownInterval) { clearInterval(room._countdownInterval); room._countdownInterval = null; }
    if (room._lowPlayersTimer) { clearTimeout(room._lowPlayersTimer); room._lowPlayersTimer = null; }

    const finalRankings = [];
    for (const [sid, player] of room.players) {
      finalRankings.push({
        playerId: sid,
        playerName: player.name,
        playerKey: player.playerKey,
        totalScore: room.scores.get(player.playerKey) || 0,
        roundsWon: room.roundResults.filter(rr =>
          rr.rankings.length > 0 && !rr.rankings[0].didNotGuess && rr.rankings[0].playerKey === player.playerKey
        ).length,
      });
    }
    finalRankings.sort((a, b) => b.totalScore - a.totalScore);
    const champion = finalRankings.length > 0 ? finalRankings[0] : null;

    broadcast(room, 'party:game_end', { finalRankings, champion });

    // 游戏结束：主动让所有在线玩家退出 Socket.IO 房间，避免空转等周期清理
    for (const [sid] of room.players) {
      const sock = io.sockets.sockets.get(sid);
      if (sock) { try { sock.leave(room.code); } catch {} }
    }

    for (const p of room.players.values()) {
      if (partyRoomPlayerIndex.get(p.playerKey) === room.code) partyRoomPlayerIndex.delete(p.playerKey);
      const entry = onlinePlayers.get(p.playerKey);
      if (entry && entry.type === 'party') { entry.type = 'idle'; entry.roomCode = null; }
    }

    console.log(`[派对] 房间${room.code} 游戏结束 冠军=${champion?.playerName || '无'}`);
  }

  // ===== 检查是否全部完成 =====
  function checkAllDone(room) {
    if (room.roundFinished || !room.roundStartAt || room.roundPlayers.size === 0) return;
    let allDone = true;
    for (const [, rp] of room.roundPlayers) {
      if (!rp.guessed && !rp.exhausted) { allDone = false; break; }
    }
    if (allDone) {
      if (room._roundTimer) clearTimeout(room._roundTimer);
      room._roundTimer = setTimeout(safeTick(() => endPartyRound(room), 'all_done'), 500);
    }
  }

  // ===== 处理猜测 =====
  function handlePartyGuess(socket, data) {
    const room = partyRooms.get(socket.data.roomCode);
    if (!room || !room.started || room.finished || room.roundFinished) return;

    const player = findPlayerInRoom ? findPlayerInRoom(room, socket) : room.players.get(socket.id);
    if (!player) return;

    // re-key roundPlayer 映射（按 playerKey 精确匹配，避免重名串号）
    let rp = room.roundPlayers.get(socket.id);
    if (!rp) {
      for (const [oldSid, rpEntry] of room.roundPlayers) {
        if (rpEntry.playerKey === player.playerKey) {
          room.roundPlayers.delete(oldSid);
          room.roundPlayers.set(socket.id, rpEntry);
          rp = rpEntry;
          break;
        }
      }
    }
    if (!rp) return;
    if (rp.guessed || rp.exhausted) return;

    const rawName = sanitizeString(data?.name, 40);
    if (!rawName) return;
    // 防御：猜测必须是合法干员名（客户端已校验，这里兜底拒绝无效/恶意输入，避免污染 guessChain 与猜测计数）
    const char = findCharByName(rawName);
    if (!char) return;
    const guessedName = char.name;

    if (!room.target) return;
    // 去重：同一干员本回合只计一次（客户端 UI 已禁用，这里兜底防止快速双击/恶意重复计数）
    if (rp.guessChain.includes(guessedName)) return;

    rp.guessCount++;
    rp.guessChain.push(guessedName);

    // 对比在服务端完成，答案永不离开服务端
    const comparisons = compareGuess(room.target, char);
    const isAlter = isAlterRelation(room.target, char);
    const isCorrect = room.target.id === char.id;

    if (isCorrect) {
      rp.guessed = true;
      room._foundRank++;
      rp.findOrder = room._foundRank;
      const rank = room._foundRank;
      socket.emit('party:guess_result', { correct: true, guessCount: rp.guessCount, name: guessedName, comparisons, isAlter });
      broadcast(room, 'party:player_found', {
        playerId: socket.id,
        playerName: player.name,
        rank,
        guessCount: rp.guessCount,
      });
      console.log(`[派对] ${player.name} 在第${rp.guessCount}次猜出 (第${rank}名)`);
      checkAllDone(room);
    } else {
      if (rp.guessCount >= (room.settings.maxGuesses ?? MAX_GUESSES)) {
        rp.exhausted = true;
        socket.emit('party:guess_result', { correct: false, guessCount: rp.guessCount, name: guessedName, exhausted: true, comparisons, isAlter });
        broadcast(room, 'party:player_exhausted', { playerId: socket.id, playerName: player.name });
        checkAllDone(room);
      } else {
        socket.emit('party:guess_result', { correct: false, guessCount: rp.guessCount, name: guessedName, comparisons, isAlter });
      }
    }
  }

  return {
    partyRoundStart,
    endPartyRound,
    endPartyGame,
    checkAllDone,
    handlePartyGuess,
  };
}
