import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { randomBytes } from 'node:crypto';

const PORT = process.env.PORT || 3001;
const ROUND_TIME = 120_000;  // 每局2分钟
const DISCONNECT_LIMIT = 30_000; // 断线30秒判负
const CLEANUP = 60_000;

const httpServer = createServer((req, res) => { res.writeHead(200); res.end('理一把 对战服务器'); });
const io = new Server(httpServer, { cors: { origin: '*' }, pingTimeout: 60_000 });

const rooms = new Map();

function genRoomCode() {
  let code;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000)); // 4位纯数字
  } while (rooms.has(code));
  return code;
}

io.on('connection', (socket) => {
  console.log(`[+] ${socket.id}`);

  // 创建房间 (data: { playerName, bestOf: 3|5|7 })
  socket.on('create_room', (data) => {
    const code = genRoomCode();
    const bestOf = [3,5,7].includes(data.bestOf) ? data.bestOf : 5;
    const winsNeeded = Math.ceil(bestOf / 2);

    rooms.set(code, {
      code, bestOf, winsNeeded,
      host: socket.id,
      players: new Map([[socket.id, { name: data.playerName || '玩家', wins: 0, disconnectTimer: null }]]),
      rounds: [],
      currentRound: null,
      started: false, finished: false,
    });

    socket.join(code);
    socket.data.roomCode = code;
    socket.emit('room_created', { code, bestOf, playerCount: 1 });
    console.log(`[房] ${code} BO${bestOf} by ${socket.id}`);
  });

  // 加入房间
  socket.on('join_room', (data) => {
    const code = (data.code || '').toUpperCase();
    const room = rooms.get(code);
    if (!room) { socket.emit('error_msg', { message: '房间不存在' }); return; }
    if (room.players.size >= 2) { socket.emit('error_msg', { message: '房间已满' }); return; }

    room.players.set(socket.id, { name: data.playerName || '玩家', wins: 0, disconnectTimer: null });
    socket.join(code);
    socket.data.roomCode = code;
    room.started = true;

    startRound(room);
    console.log(`[房] ${code} 满员开战`);
  });

  // 客户端操作日志
  socket.on('_log', (data) => {
    console.log(`[日志] ${socket.id}: ${JSON.stringify(data)}`);
  });
  });

  // 提交猜测 (广播所有历史颜色行给对手)
  socket.on('guess_update', (data) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room?.currentRound) return;
    socket.to(room.code).emit('opponent_update', {
      guessCount: data.guessCount,
      allComparisons: data.allComparisons || [], // 所有历史行的颜色数组
    });
  });

  // 猜中
  socket.on('player_win_round', (data) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room?.currentRound || room.finished) return;

    const player = room.players.get(socket.id);
    if (!player) return;
    player.wins++;
    const won = player.wins >= room.winsNeeded;

    clearRoundTimer(room);
    io.to(room.code).emit('round_end', {
      winner: socket.id,
      winnerName: player.name,
      targetName: data.targetName || '',
      score: formatScore(room),
      roundOver: true,
      matchOver: won,
    });

    if (won) {
      room.finished = true;
      io.to(room.code).emit('match_end', { winner: socket.id, winnerName: player.name, score: formatScore(room) });
      scheduleCleanup(code);
    } else {
      setTimeout(() => startRound(room), 5000);
    }
  });

  // 放弃本局
  socket.on('surrender_round', (data) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room?.currentRound || room.finished) return;

    // 标记该玩家已放弃
    room.currentRound.surrendered = room.currentRound.surrendered || new Set();
    room.currentRound.surrendered.add(socket.id);

    // 双方都放弃 → 直接平局进入下一局
    if (room.currentRound.surrendered.size >= 2) {
      clearRoundTimer(room);
      io.to(room.code).emit('round_end', {
        winner: null, winnerName: '', targetName: data.targetName || '',
        score: formatScore(room), roundOver: true, matchOver: false,
      });
      setTimeout(() => startRound(room), 5000);
      return;
    }

    // 只有一方放弃：通知对方
    io.to(room.code).emit('opponent_surrendered', {
      playerId: socket.id,
      playerName: room.players.get(socket.id)?.name,
      targetName: data.targetName || '',
    });

    // 倒计时继续走，另一方猜中才得分，否则超时平局
    const timeout = setTimeout(() => {
      io.to(room.code).emit('round_end', {
        winner: null, winnerName: '', targetName: data.targetName || '',
        score: formatScore(room), roundOver: true, matchOver: false,
      });
      setTimeout(() => startRound(room), 5000);
    }, room.currentRound.remaining);

    room.currentRound.timeout = timeout;
  });

  // 断开
  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || room.finished) return;

    // 30秒倒计时，超时判负
    const player = room.players.get(socket.id);
    if (player) {
      player.disconnectTimer = setTimeout(() => {
        const other = Array.from(room.players.keys()).find(id => id !== socket.id);
        const winner = room.players.get(other);
        io.to(code).emit('match_end', {
          winner: other, winnerName: winner?.name || '对手',
          score: formatScore(room), reason: 'disconnect',
        });
        room.finished = true;
        clearRoundTimer(room);
        scheduleCleanup(code);
      }, DISCONNECT_LIMIT);
    }
  });

  // 重连
  socket.on('reconnect_room', (data) => {
    const code = (data.code || '').toUpperCase();
    const room = rooms.get(code);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (player?.disconnectTimer) {
      clearTimeout(player.disconnectTimer);
      player.disconnectTimer = null;
      socket.join(code);
      socket.data.roomCode = code;
    }
  });
});

function startRound(room) {
  const target = ''; // 目标由客户端各自独立选择（同种子）
  room.currentRound = {
    target: '', targetName: '',
    startTime: Date.now(), remaining: ROUND_TIME,
    timeout: setTimeout(() => {
      io.to(room.code).emit('round_end', {
        winner: null, winnerName: '',
        score: formatScore(room), roundOver: true, matchOver: false,
      });
      setTimeout(() => startRound(room), 5000);
    }, ROUND_TIME),
  };
  io.to(room.code).emit('round_start', {
    startTime: Date.now(),
    timeLimit: ROUND_TIME,
    score: formatScore(room),
    players: Array.from(room.players.entries()).map(([id, p]) => ({ id, name: p.name, wins: p.wins })),
  });
}

function clearRoundTimer(room) {
  if (room?.currentRound?.timeout) { clearTimeout(room.currentRound.timeout); room.currentRound.timeout = null; }
}

function formatScore(room) {
  const arr = Array.from(room.players.values());
  return `${arr[0]?.name || '?'} ${arr[0]?.wins || 0} - ${arr[1]?.wins || 0} ${arr[1]?.name || '?'}`;
}

function scheduleCleanup(code) { setTimeout(() => rooms.delete(code), CLEANUP); }

httpServer.listen(PORT, () => console.log(`服务器启动 :${PORT}`));
