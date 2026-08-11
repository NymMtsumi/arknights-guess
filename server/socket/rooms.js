// 房间管理：创建、查找、代码生成
import { randomBytes } from 'node:crypto';

export function createRoomManager() {
  const rooms = new Map();
  const roomPlayerIndex = new Map(); // playerKey → roomCode

  function genCode() {
    let c;
    let attempts = 0;
    do {
      c = String(Math.floor(1000 + Math.random() * 9000));
      if (++attempts > 100) {
        do {
          c = randomBytes(2).toString('hex').toUpperCase();
        } while (rooms.has(c));
        break;
      }
    } while (rooms.has(c));
    return c;
  }

  function genMatchCode() {
    let code;
    let attempts = 0;
    do {
      code = randomBytes(3).toString('hex').toUpperCase(); // 6 hex chars
      if (++attempts > 100) {
        code = randomBytes(4).toString('hex').toUpperCase(); // 8 hex fallback
        break;
      }
    } while (rooms.has(code));
    return code;
  }

  function createMatchRoom({ code, bestOf, winsNeeded, difficulty, p1, p2 }) {
    const room = {
      code, bestOf, winsNeeded, difficulty, _createdAt: Date.now(),
      players: new Map([
        [p1.socketId, { name: p1.playerName, wins: 0, dcTimer: null, lastSocketId: null, playerKey: p1.playerKey, identityKey: p1.identityKey, ready: false }],
        [p2.socketId, { name: p2.playerName, wins: 0, dcTimer: null, lastSocketId: null, playerKey: p2.playerKey, identityKey: p2.identityKey, ready: false }],
      ]),
      started: true, finished: false,
    };
    rooms.set(code, room);
    roomPlayerIndex.set(p1.playerKey, code);
    roomPlayerIndex.set(p2.playerKey, code);
    return room;
  }

  function findRoomByPlayerKey(pk) {
    const code = roomPlayerIndex.get(pk);
    if (!code) return null;
    const room = rooms.get(code);
    if (!room || room.finished) {
      roomPlayerIndex.delete(pk);
      return null;
    }
    return room;
  }

  function findRoomByIdentityKey(ik) {
    for (const [code, r] of rooms) {
      if (r.finished) continue;
      for (const p of r.players.values()) {
        if (p.identityKey === ik || p.playerKey === ik) return r;
      }
    }
    return null;
  }

  return {
    rooms,
    roomPlayerIndex,
    genCode,
    genMatchCode,
    createMatchRoom,
    findRoomByPlayerKey,
    findRoomByIdentityKey,
  };
}
