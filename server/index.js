import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { randomBytes } from 'node:crypto';

const PORT = process.env.PORT || 3001;
const ROOM_TIMEOUT = 120_000; // 120 秒对战时间
const CLEANUP_DELAY = 30_000;  // 结束后 30 秒清理房间

const httpServer = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('理一把 对战服务器');
});

const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60_000,
});

// 房间存储：{ roomCode: { players: Map, target: {}, timers: {} } }
const rooms = new Map();

function genRoomCode() {
  return randomBytes(3).toString('base64url').slice(0, 4).toUpperCase();
}

function getTarget() {
  // 目标由服务器随机选（客户端传候选人池不方便，用简单方案：客户端传池子）
  // 实际实现：客户端连接时传角色 id 列表，服务器从中选
  return null;
}

io.on('connection', (socket) => {
  console.log(`[连接] ${socket.id}`);

  // 创建房间
  socket.on('create_room', (data) => {
    let code = genRoomCode();
    while (rooms.has(code)) code = genRoomCode();

    rooms.set(code, {
      players: new Map(),
      targetCharId: data.targetCharId || '',
      targetName: data.targetName || '',
      timer: null,
      started: false,
    });

    const room = rooms.get(code);
    room.players.set(socket.id, { name: data.playerName || '玩家', guesses: 0, finished: false });

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.isHost = true;

    socket.emit('room_created', { code, playerCount: 1 });
    console.log(`[房间] ${code} 创建 by ${socket.id}`);
  });

  // 加入房间
  socket.on('join_room', (data) => {
    const code = (data.code || '').toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      socket.emit('error_msg', { message: '房间不存在' });
      return;
    }
    if (room.players.size >= 2) {
      socket.emit('error_msg', { message: '房间已满' });
      return;
    }
    if (room.started) {
      socket.emit('error_msg', { message: '游戏已开始' });
      return;
    }

    room.players.set(socket.id, { name: data.playerName || '玩家', guesses: 0, finished: false });
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.isHost = false;

    // 通知双方开始
    const target = room.targetCharId;
    const players = Array.from(room.players.entries()).map(([id, p]) => ({ id, name: p.name }));

    io.to(code).emit('game_start', {
      targetCharId: target,
      targetName: room.targetName,
      players,
      startTime: Date.now(),
    });

    room.started = true;

    // 倒计时
    if (room.timer) clearTimeout(room.timer);
    room.timer = setTimeout(() => {
      endGame(code, 'timeout');
    }, ROOM_TIMEOUT);

    console.log(`[房间] ${code} 满员，开始对战`);
  });

  // 实时猜测更新（广播给对手）
  socket.on('guess_update', (data) => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room) return;

    const player = room.players.get(socket.id);
    if (player) {
      player.guesses = data.guessCount || player.guesses;
    }

    // 广播对手的进度（不含具体答案）
    socket.to(code).emit('opponent_update', {
      playerId: socket.id,
      guessCount: data.guessCount,
      comparisons: data.comparisons || [], // 颜色数组，不含具体文字
    });
  });

  // 玩家获胜
  socket.on('player_win', (data) => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room) return;

    const player = room.players.get(socket.id);
    if (player) player.finished = true;

    io.to(code).emit('game_end', {
      winner: socket.id,
      winnerName: player?.name || '玩家',
      reason: 'win',
      targetName: data.targetName || '',
    });

    scheduleCleanup(code);
  });

  // 放弃
  socket.on('player_giveup', () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room) return;

    const otherId = Array.from(room.players.keys()).find(id => id !== socket.id);
    const winner = room.players.get(otherId);

    io.to(code).emit('game_end', {
      winner: otherId,
      winnerName: winner?.name || '对手',
      reason: 'giveup',
    });

    scheduleCleanup(code);
  });

  // 断开连接
  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room) return;

    const otherId = Array.from(room.players.keys()).find(id => id !== socket.id);

    io.to(code).emit('game_end', {
      winner: otherId,
      winnerName: room.players.get(otherId)?.name || '对手',
      reason: 'disconnect',
    });

    scheduleCleanup(code);
    console.log(`[断开] ${socket.id} from ${code}`);
  });
});

function endGame(code, reason) {
  const room = rooms.get(code);
  if (!room) return;
  io.to(code).emit('game_end', { winner: null, reason });
  scheduleCleanup(code);
}

function scheduleCleanup(code) {
  setTimeout(() => {
    rooms.delete(code);
    console.log(`[清理] 房间 ${code}`);
  }, CLEANUP_DELAY);
}

httpServer.listen(PORT, () => {
  console.log(`理一把对战服务器启动 :${PORT}`);
});
