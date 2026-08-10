// 派对模式 — 游戏逻辑（回合管理、排名计算、猜测处理）
import { randomTarget } from '../characters.js';

const REVEAL_TIME = 15_000;
const MAX_GUESSES = 8;
const POINTS = [5, 3, 2, 1, 1, 1];

export function createPartyGameModule(deps) {
  const { io, partyRooms, partyRoomPlayerIndex, onlinePlayers, broadcast, findPlayerInRoom } = deps;

  // 从 room 模块注入的常量（由 party.js 延迟注入）
  let DISCONNECT = 30_000;
  let MIN_PLAYERS = 4;

  function injectConstants(c) {
    DISCONNECT = c.DISCONNECT;
    MIN_PLAYERS = c.MIN_PLAYERS;
  }

  // ===== 回合开始 =====
  function partyRoundStart(room) {
    if (room.finished) return;
    if (room._roundTimer) clearTimeout(room._roundTimer);

    room.currentRound++;
    const roundTime = (room.settings.roundTime || 120) * 1000;
    const target = randomTarget(room.settings.difficulty || 'hard');
    room.target = target;
    room.roundStartAt = Date.now();
    room.roundFinished = false;

    // 重置本回合玩家状态
    room.roundPlayers = new Map();
    for (const [sid, p] of room.players) {
      room.roundPlayers.set(sid, {
        guessed: false,
        exhausted: false,
        guessCount: 0,
        guessChain: [],
      });
    }
    room._foundRank = 0;

    const round = room.currentRound;
    const total = room.settings.rounds;

    room._roundTimer = setTimeout(() => {
      if (room.roundFinished) return;
      endPartyRound(room);
    }, roundTime);

    broadcast(room, 'party:round_start', {
      round,
      totalRounds: total,
      difficulty: room.settings.difficulty || 'hard',
      targetName: target.name,
      timeLimit: roundTime,
      startTime: Date.now(),
    });

    room._tickInterval = setInterval(() => {
      if (room.roundFinished) { clearInterval(room._tickInterval); room._tickInterval = null; return; }
      const elapsed = Date.now() - room.roundStartAt;
      const secondsLeft = Math.max(0, Math.ceil((roundTime - elapsed) / 1000));
      broadcast(room, 'party:timer_tick', { secondsLeft });
      if (secondsLeft <= 0) { clearInterval(room._tickInterval); room._tickInterval = null; }
    }, 1000);

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
      room._revealTimer = setTimeout(() => {
        partyRoundStart(room);
      }, REVEAL_TIME);
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
          rr.rankings.length > 0 && rr.rankings[0].playerKey === player.playerKey
        ).length,
      });
    }
    finalRankings.sort((a, b) => b.totalScore - a.totalScore);
    const champion = finalRankings.length > 0 ? finalRankings[0] : null;

    broadcast(room, 'party:game_end', { finalRankings, champion });

    for (const p of room.players.values()) {
      partyRoomPlayerIndex.delete(p.playerKey);
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
      room._roundTimer = setTimeout(() => endPartyRound(room), 500);
    }
  }

  // ===== 处理猜测 =====
  function handlePartyGuess(socket, data) {
    const room = partyRooms.get(socket.data.roomCode);
    if (!room || !room.started || room.finished || room.roundFinished) return;

    const player = findPlayerInRoom ? findPlayerInRoom(room, socket) : room.players.get(socket.id);
    if (!player) return;

    // re-key roundPlayer 映射
    let rp = room.roundPlayers.get(socket.id);
    if (!rp) {
      for (const [oldSid, rpEntry] of room.roundPlayers) {
        if (player.name === room.players.get(oldSid)?.name) {
          room.roundPlayers.delete(oldSid);
          room.roundPlayers.set(socket.id, rpEntry);
          rp = rpEntry;
          break;
        }
      }
    }
    if (!rp) return;
    if (rp.guessed || rp.exhausted) return;

    const guessedName = String(data?.name || '').trim();
    if (!guessedName) return;

    rp.guessCount++;
    rp.guessChain.push(guessedName);

    const isCorrect = room.target && (
      room.target.name === guessedName ||
      room.target.name.toLowerCase() === guessedName.toLowerCase()
    );

    if (isCorrect) {
      rp.guessed = true;
      room._foundRank++;
      rp.findOrder = room._foundRank;
      const rank = room._foundRank;
      socket.emit('party:guess_result', { correct: true, guessCount: rp.guessCount, name: guessedName });
      broadcast(room, 'party:player_found', {
        playerId: socket.id,
        playerName: player.name,
        rank,
        guessCount: rp.guessCount,
      });
      console.log(`[派对] ${player.name} 在第${rp.guessCount}次猜出 (第${rank}名)`);
      checkAllDone(room);
    } else {
      if (rp.guessCount >= MAX_GUESSES) {
        rp.exhausted = true;
        socket.emit('party:guess_result', { correct: false, guessCount: rp.guessCount, name: guessedName, exhausted: true });
        broadcast(room, 'party:player_exhausted', { playerId: socket.id, playerName: player.name });
        checkAllDone(room);
      } else {
        socket.emit('party:guess_result', { correct: false, guessCount: rp.guessCount, name: guessedName });
      }
    }
  }

  return {
    injectConstants,
    partyRoundStart,
    endPartyRound,
    endPartyGame,
    checkAllDone,
    handlePartyGuess,
  };
}
