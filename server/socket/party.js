// 派对模式 — 事件路由（薄层，委托给 party-room.js 和 party-game.js）
import { createPartyRoomModule } from './party-room.js';
import { createPartyGameModule } from './party-game.js';

export function registerPartyHandlers({
  io, partyRooms, partyRoomPlayerIndex,
  onlinePlayers, onlineSockets, ONLINE_TIMEOUT,
  rooms, roomPlayerIndex,
}) {
  // ── 创建子模块 ──
  const room = createPartyRoomModule({
    io, partyRooms, partyRoomPlayerIndex,
    onlinePlayers, onlineSockets, ONLINE_TIMEOUT,
    rooms, roomPlayerIndex,
  });

  const game = createPartyGameModule({
    io, partyRooms, partyRoomPlayerIndex, onlinePlayers,
    broadcast: room.broadcast,
    findPlayerInRoom: room.findPlayerInRoom,
  });

  // ── 延迟绑定（打破循环依赖）──
  room.setGameCallbacks({
    checkAllDone: game.checkAllDone,
    partyRoundStart: game.partyRoundStart,
  });
  game.injectConstants({
    DISCONNECT: room.DISCONNECT,
    MIN_PLAYERS: room.MIN_PLAYERS,
  });

  // ── Socket 事件路由 ──
  io.on('connection', (socket) => {

    // 创建房间
    socket.on('party:create', (data) => {
      try { room.createPartyRoom(socket, data); }
      catch (e) { console.error('[party] create error:', e.message); }
    });

    // 加入房间
    socket.on('party:join', (data) => {
      try { room.joinPartyRoom(socket, data); }
      catch (e) { console.error('[party] join error:', e.message); }
    });

    // 离开
    socket.on('party:leave', () => {
      const r = room.findPartyRoomByIdentityKey(socket.data.identityKey);
      if (!r) return;
      room.findPlayerInRoom(r, socket); // 先 re-key
      room.handlePartyLeave(r, socket, false);
    });

    // 踢人
    socket.on('party:kick', (data) => {
      room.handlePartyKick(socket, data);
    });

    // 准备切换
    socket.on('party:toggle_ready', () => {
      room.toggleReady(socket);
    });

    // 更新设置
    socket.on('party:update_settings', (data) => {
      room.updateSettings(socket, data);
    });

    // 开始游戏
    socket.on('party:start', () => {
      room.startGame(socket);
    });

    // 猜测
    socket.on('party:guess', (data) => {
      game.handlePartyGuess(socket, data);
    });

    // 重连
    socket.on('party:reconnect', (data) => {
      try { room.reconnectPartyRoom(socket, data); }
      catch (e) { console.error('[party] reconnect error:', e.message); }
    });

    // 断线
    socket.on('disconnect', () => {
      room.handleDisconnect(socket);
    });
  });

  return {
    runPeriodicCleanup: room.runPeriodicCleanup,
    partyRooms,
    partyRoomPlayerIndex,
  };
}
