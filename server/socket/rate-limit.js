// Socket 层限流 —— HTTP 层的 checkRate 管不到 socket 事件。
//
// 为什么需要：房间码只有 6 位数字（10^6）。party:join 失败时回
// 「房间不存在」、party:reconnect 失败时区分「房间不存在」和「你不在该房间中」——
// 两种都是**可判别的枚举预言机**。一条连接每秒能试几百次，几分钟扫完全空间，
// 扫到的房间就能直接挤进去（派对房里还有踢人权）。
// 按 IP 限流后，扫完 10^6 的耗时从分钟级变成数天，枚举不再划算。
//
// 键选 IP，不选 playerKey / socket.id：后两者都攥在攻击者手里
// （握手能自带 pk，重连换 socket.id），只有 IP 有成本。

/**
 * 滑动窗口计数器。
 * @param {number} limit     窗口内允许的次数
 * @param {number} windowMs  窗口长度
 * @param {number} maxKeys   键数量上限（内存兜底）
 */
export function createRateLimiter({ limit, windowMs, maxKeys = 20_000 }) {
  const hits = new Map(); // key → number[]（窗口内命中时刻，升序）

  // 清掉整条窗口已滑出的键。定期调用，避免只靠 maxKeys 兜底。
  function sweep(now = Date.now()) {
    for (const [key, arr] of hits) {
      if (!arr.length || now - arr[arr.length - 1] >= windowMs) hits.delete(key);
    }
  }

  function check(key) {
    const now = Date.now();
    let arr = hits.get(key);
    if (!arr) {
      // 内存兜底：先扫，仍满则按插入序淘汰最旧的一条（Map 保留插入序）。
      // 选淘汰而不是拒绝 —— 限流器自己拒服务会把内存压力转成可用性故障。
      if (hits.size >= maxKeys) {
        sweep(now);
        if (hits.size >= maxKeys) {
          const oldest = hits.keys().next().value;
          if (oldest !== undefined) hits.delete(oldest);
        }
      }
      arr = [];
      hits.set(key, arr);
    }
    while (arr.length && now - arr[0] >= windowMs) arr.shift();
    if (arr.length >= limit) {
      return { ok: false, retryAfterMs: windowMs - (now - arr[0]) };
    }
    arr.push(now);
    return { ok: true, retryAfterMs: 0 };
  }

  return { check, sweep, size: () => hits.size };
}

// 单连接档：枚举的真实形状就是「一条连接 + 紧循环」，这一档直接掐死它。
// 20 次 / 10 秒 —— 正常玩家加房/重连各一次，连着点也到不了。
const PER_SOCKET = { limit: 20, windowMs: 10_000 };
// 同 IP 档：防「断线重连换 socket.id 绕过上一档」。
// 300 这个值当初是为了迁就一个已修掉的缺陷而放宽的：那时线上 nginx 没配
// set_real_ip_from / real_ip_header CF-Connecting-IP，socket.data.ip 拿到的是
// Cloudflare 边缘 IP，被整片用户共用，在共享桶上卡死线 = 误伤。
// 该缺陷已于 2026-09-13 修掉（/etc/nginx/conf.d/cloudflare-realip.conf），
// 现在这个键是真实客户端 IP，所以**可以**按需要收紧；
// 之所以仍留 300：同一出口 NAT 后可能坐着多个玩家（校园网/公司网），
// 而真正掐死枚举的是上面那一档（20 次/10 秒/连接），这里只是兜底换 socket.id 的情形。
const PER_IP = { limit: 300, windowMs: 10_000 };

/** 取限流键：优先真实 IP，取不到时退回 socket.id（至少不会全站共用一个桶）。 */
export function rateKey(socket) {
  return socket.data?.ip || socket.handshake?.address || socket.id;
}

/**
 * 房间码守卫：把「检查 + 回绝」的样板收在一处，party.js 与 game.js 共用。
 * 回绝方式是回调而不是写死 —— 两个模块的错误事件名不同
 * （派对是 party:error，多人是 error_msg），且派对还要额外回 ack。
 *
 * 用法：`if (guard.blocked(socket, msg => ..., 'join_room')) return;`
 */
export function createRoomCodeGuard() {
  const perSocket = createRateLimiter(PER_SOCKET);
  const perIp = createRateLimiter(PER_IP);
  return {
    /** @returns {boolean} true = 已拒绝，调用方必须立即 return */
    blocked(socket, emit, event) {
      const vSocket = perSocket.check(socket.id);
      const vIp = perIp.check(rateKey(socket));
      if (vSocket.ok && vIp.ok) return false;
      const wait = Math.ceil(Math.max(vSocket.retryAfterMs, vIp.retryAfterMs) / 1000);
      console.warn(`[socket] 限流 ${event} socket=${socket.id} ip=${rateKey(socket)}`);
      emit(`操作过于频繁，请 ${wait} 秒后再试`);
      return true;
    },
  };
}
