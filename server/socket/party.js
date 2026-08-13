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

  // 统一异常兜底：所有事件处理器都套 try/catch，防止单个事件抛错导致进程崩溃
  const safe = (fn, label) => (...args) => {
    try { fn(...args); }
    catch (e) { console.error(`[party] ${label} error:`, e.message); }
  };

  // ── Socket 事件路由 ──
  io.on('connection', (socket) => {

    // 创建房间（带 ack：直接确认创建结果，消灭静默失败）
    socket.on('party:create', (data, ack) => {
      try { room.createPartyRoom(socket, data, ack); }
      catch (e) {
        console.error('[party] create error:', e.message);
        socket.emit('party:error', { code: 'INTERNAL_ERROR', message: e.message });
        ack?.({ ok: false, code: 'INTERNAL_ERROR', message: e.message });
      }
    });

    // 加入房间（带 ack）
    socket.on('party:join', (data, ack) => {
      try { room.joinPartyRoom(socket, data, ack); }
      catch (e) {
        console.error('[party] join error:', e.message);
        socket.emit('party:error', { code: 'INTERNAL_ERROR', message: e.message });
        ack?.({ ok: false, code: 'INTERNAL_ERROR', message: e.message });
      }
    });

    // 离开
    socket.on('party:leave', safe(() => {
      const r = room.findPartyRoomByIdentityKey(socket.data.identityKey);
      if (!r) return;
      room.findPlayerInRoom(r, socket); // 先 re-key
      room.handlePartyLeave(r, socket, false);
    }, 'leave'));

    // 踢人
    socket.on('party:kick', safe((data) => {
      room.handlePartyKick(socket, data);
    }, 'kick'));

    // 准备切换
    socket.on('party:toggle_ready', safe(() => {
      room.toggleReady(socket);
    }, 'toggle_ready'));

    // 更新设置
    socket.on('party:update_settings', safe((data) => {
      room.updateSettings(socket, data);
    }, 'update_settings'));

    // 开始游戏
    socket.on('party:start', safe(() => {
      room.startGame(socket);
    }, 'start'));

    // 猜测（party:guess_result 事件即为响应，无需 ack）
    socket.on('party:guess', safe((data) => {
      game.handlePartyGuess(socket, data);
    }, 'guess'));

    // 重连
    socket.on('party:reconnect', (data) => {
      try { room.reconnectPartyRoom(socket, data); }
      catch (e) {
        console.error('[party] reconnect error:', e.message);
        socket.emit('party:error', { code: 'INTERNAL_ERROR', message: e.message });
      }
    });

    // 断线
    socket.on('disconnect', safe(() => {
      room.handleDisconnect(socket);
    }, 'disconnect'));
  });

  // ── 启动自检：打印已注册事件清单（对上次 import 缺失根因的直接防护）──
  console.log('[party] ✅ 派对事件处理器已注册:', [
    'party:create', 'party:join', 'party:leave', 'party:kick',
    'party:toggle_ready', 'party:update_settings', 'party:start',
    'party:guess', 'party:reconnect', 'disconnect',
  ].join(', '));

  return {
    runPeriodicCleanup: room.runPeriodicCleanup,
    partyRooms,
    partyRoomPlayerIndex,
  };
}
