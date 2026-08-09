// 匹配队列管理
import { sanitizeString } from '../utils.js';

export function createMatchmaking({ io, roomPlayerIndex, genMatchCode, createMatchRoom, onlinePlayers }) {
  const matchmakingQueue = new Map(); // socketId → { socketId, playerKey, playerName, difficulty, bestOf, joinedAt }

  // startRound 延迟注入（由 game.js 初始化后设置）
  let _startRound = null;
  function setStartRound(fn) { _startRound = fn; }

  function tryMatch(difficulty) {
    const entries = Array.from(matchmakingQueue.values())
      .filter(e => e.difficulty === difficulty)
      .sort((a, b) => a.joinedAt - b.joinedAt);

    if (entries.length < 2) return;

    const [p1, p2] = entries;
    // 防止自匹配：同一 player_key 的两个 socket 不能互相对战
    if (p1.playerKey === p2.playerKey) {
      const toEvict = p2.joinedAt >= p1.joinedAt ? p2.socketId : p1.socketId;
      const toKeep = toEvict === p1.socketId ? p2.socketId : p1.socketId;
      matchmakingQueue.delete(toEvict);
      const sock = io.sockets.sockets.get(toEvict);
      if (sock) sock.emit('matchmaking:status', { queued: false, position: 0, difficulty: '' });
      // 通知保留的 socket 更新位置
      const keepSock = io.sockets.sockets.get(toKeep);
      if (keepSock) {
        const newPos = Array.from(matchmakingQueue.values())
          .filter(e => e.difficulty === difficulty)
          .sort((a, b) => a.joinedAt - b.joinedAt)
          .findIndex(e => e.socketId === toKeep) + 1;
        keepSock.emit('matchmaking:status', { queued: true, position: newPos, difficulty });
      }
      // 重新尝试匹配（剩余的单人可能匹配到下一个）
      tryMatch(difficulty);
      return;
    }

    matchmakingQueue.delete(p1.socketId);
    matchmakingQueue.delete(p2.socketId);

    const sock1 = io.sockets.sockets.get(p1.socketId);
    const sock2 = io.sockets.sockets.get(p2.socketId);
    if (!sock1 || !sock2) {
      if (sock1) matchmakingQueue.set(p1.socketId, p1);
      if (sock2) matchmakingQueue.set(p2.socketId, p2);
      return;
    }

    const code = genMatchCode();
    const bestOf = Math.max(
      [3, 5, 7].includes(p1.bestOf) ? p1.bestOf : 5,
      [3, 5, 7].includes(p2.bestOf) ? p2.bestOf : 5
    );
    const winsNeeded = Math.ceil(bestOf / 2);

    const identityKey1 = sock1.data.identityKey;
    const identityKey2 = sock2.data.identityKey;

    const room = createMatchRoom({
      code, bestOf, winsNeeded, difficulty,
      p1: { socketId: p1.socketId, playerKey: p1.playerKey, playerName: p1.playerName, identityKey: identityKey1 },
      p2: { socketId: p2.socketId, playerKey: p2.playerKey, playerName: p2.playerName, identityKey: identityKey2 },
    });

    sock1.join(code);
    sock1.data.roomCode = code;
    sock2.join(code);
    sock2.data.roomCode = code;

    // 在线追踪
    [sock1, sock2].forEach(s => {
      const entry = onlinePlayers.get(s.data.playerKey);
      if (entry) { entry.type = 'multi'; entry.roomCode = code; }
    });

    console.log(`[匹配] ${p1.playerName} vs ${p2.playerName} 房间 ${code} 难度 ${difficulty}`);

    sock1.emit('matchmaking:matched', { roomCode: code, opponent: { name: p2.playerName }, bestOf, difficulty });
    sock2.emit('matchmaking:matched', { roomCode: code, opponent: { name: p1.playerName }, bestOf, difficulty });

    if (_startRound) _startRound(room);
  }

  // 处理 matchmaking:join 事件
  function handleJoinQueue(socket, data) {
    const playerName = sanitizeString(data?.playerName || '玩家', 20);
    const difficulty = ['easy', 'medium', 'hard'].includes(data?.difficulty) ? data?.difficulty : 'hard';
    const bestOf = [3, 5, 7].includes(data?.bestOf) ? data?.bestOf : 5;

    matchmakingQueue.delete(socket.id);
    matchmakingQueue.set(socket.id, {
      socketId: socket.id,
      playerKey: socket.data.playerKey,
      playerName,
      difficulty,
      bestOf,
      joinedAt: Date.now(),
    });

    const position = Array.from(matchmakingQueue.values())
      .filter(e => e.difficulty === difficulty)
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .findIndex(e => e.socketId === socket.id) + 1;

    socket.emit('matchmaking:status', { queued: true, position, difficulty });
    console.log(`[排队] ${playerName} 加入 ${difficulty} 队列 位置 ${position}`);

    tryMatch(difficulty);
  }

  // 处理 matchmaking:leave 事件
  function handleLeaveQueue(socket) {
    const wasInQueue = matchmakingQueue.has(socket.id);
    matchmakingQueue.delete(socket.id);
    if (wasInQueue) {
      socket.emit('matchmaking:status', { queued: false, position: 0, difficulty: '' });
      console.log(`[排队] ${socket.id} 离开队列`);
    }
  }

  // 从队列中移除指定 socket
  function removeFromQueue(socketId) {
    matchmakingQueue.delete(socketId);
  }

  // 清理超时排队（5分钟）
  function cleanupStaleQueue() {
    const now = Date.now();
    for (const [sid, entry] of matchmakingQueue) {
      if (now - entry.joinedAt > 300_000) {
        matchmakingQueue.delete(sid);
        const sock = io.sockets.sockets.get(sid);
        if (sock) {
          sock.emit('matchmaking:status', { queued: false, position: 0, difficulty: '' });
        }
      }
    }
  }

  return {
    matchmakingQueue,
    tryMatch,
    handleJoinQueue,
    handleLeaveQueue,
    removeFromQueue,
    cleanupStaleQueue,
    setStartRound,
  };
}
