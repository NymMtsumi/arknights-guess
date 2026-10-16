'use client';

import { useRef, useState, useCallback, useEffect } from 'react';
import { io, Socket } from 'socket.io-client';
import { getToken, getPlayerKey } from '@/lib/auth';

const WS_BASE = process.env.NEXT_PUBLIC_WS_URL || 'https://ws.arknights-guess.online';

interface UseSocketOptions {
  /** 连接失败回调 */
  onError?: (message: string) => void;
  /** 房间过期回调 */
  onRoomExpired?: (message: string) => void;
  /** 重连成功回调 */
  onReconnect?: (socket: Socket) => void;
  /**
   * Socket 创建后调用，用于注册使用方特有的 Socket 事件处理器（如 party:xxx）。
   * 此时 common 处理器（error_msg, set_cookie 等）已注册完成。
   */
  onBeforeConnect?: (socket: Socket) => void;
}

/**
 * Socket.IO 连接管理 hook。
 * 多人和派对模式共用：统一处理认证、错误、重连、set_cookie。
 *
 * isConnected 是 state（非 ref），变化时触发组件重渲染。
 * 这是按钮能响应连接状态的关键 — useRef 不会触发重渲染。
 */
export function useSocket(options: UseSocketOptions = {}) {
  // 用 ref 保持 options 最新，避免 connect 因内联回调重建
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const socketRef = useRef<Socket | null>(null);
  const connectTimerRef = useRef<NodeJS.Timeout | null>(null);

  // ── 关键修复：isConnected 必须是 state，才能触发依赖它的组件重渲染 ──
  const [isConnected, setIsConnected] = useState(false);

  const clearConnectTimer = useCallback(() => {
    if (connectTimerRef.current) {
      clearTimeout(connectTimerRef.current);
      connectTimerRef.current = null;
    }
  }, []);

  /**
   * 创建并连接 Socket。使用 autoConnect: true（与测试页一致的稳定模式）。
   * connect 引用稳定（仅依赖 clearConnectTimer），不会随渲染重建。
   */
  const connect = useCallback((): Socket => {
    // 如果已有活跃 socket，直接返回
    if (socketRef.current) {
      if (socketRef.current.connected || socketRef.current.active) {
        setIsConnected(socketRef.current.connected);
        return socketRef.current;
      }
      // 旧 socket 已断开且不在连接中 → 清理后重建
      socketRef.current.removeAllListeners();
      socketRef.current.disconnect();
      socketRef.current = null;
      setIsConnected(false);
    }

    clearConnectTimer();

    const s = io(WS_BASE, {
      // 🔴 顺序不能反。写 ['websocket','polling'] 等于**只**用 WebSocket：
      //    engine.io-client 默认只认 transports[0]，不会在 WS 失败时自动落到下一项
      //    （那要显式开 `tryAllTransports`），所以第二项是死配置 ——
      //    WS 被中间设备/运营商/企业网络挡掉时，直接连接失败，没有兜底。
      //    这里用 Socket.IO 的默认顺序：先用轮询握手，随后自动升级到 WebSocket，
      //    稳态传输仍是 WS，只在 WS 不可用时留在轮询上。
      transports: ['polling', 'websocket'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: 10,
      auth: { token: getToken() || '', pk: getPlayerKey() || '' },
    });

    // 通用错误事件（通过 ref 读取最新的回调，避免闭包陈旧）
    s.on('connect_error', (err: Error) => {
      clearConnectTimer();
      setIsConnected(false);
      optionsRef.current.onError?.(err?.message || 'Connection failed');
      // 🔴 这里**不能**调 s.disconnect()：它会置 Manager 的 skipReconnect=true，
      //    把 reconnectionAttempts=10 / reconnectionDelay* 整套重连彻底废掉 ——
      //    连「后端重启几十秒后自己恢复」这种瞬时失败也永不重连。
      //    交给 Manager 按 reconnection* 自己退避重试即可。
      //    （error_msg 那条是应用层终态错误，仍照旧主动断开，别一起改。）
    });

    s.on('connect_timeout', () => {
      clearConnectTimer();
      setIsConnected(false);
      optionsRef.current.onError?.('Connection timeout');
    });

    s.on('error_msg', (d: { message: string }) => {
      clearConnectTimer();
      setIsConnected(false);
      optionsRef.current.onError?.(d.message);
      s.disconnect();
    });

    s.on('room_expired', (d: { message?: string }) => {
      clearConnectTimer();
      setIsConnected(false);
      optionsRef.current.onRoomExpired?.(d?.message || 'Room expired');
    });

    // 游客 cookie 下发（仅允许 player_key，防任意 key 写入）
    s.on('set_cookie', (d: { name: string; value: string }) => {
      if (d.name !== 'player_key') return;
      if (typeof document !== 'undefined') {
        try { localStorage.setItem(d.name, d.value); } catch { /* ignore */ }
      }
    });

    // Socket.IO Manager 级别的重连
    s.io.on('reconnect', () => {
      setIsConnected(true);
      optionsRef.current.onReconnect?.(s);
    });

    // 连接成功时清除超时定时器 + 标记已连接（触发组件重渲染）
    s.on('connect', () => {
      clearConnectTimer();
      setIsConnected(true);
    });

    // 断线时标记未连接
    s.on('disconnect', () => {
      setIsConnected(false);
    });

    // 使用方注册自定义事件
    optionsRef.current.onBeforeConnect?.(s);

    socketRef.current = s;

    // 连接超时保护（15s），连接成功时会被 connect 事件清除
    connectTimerRef.current = setTimeout(() => {
      clearConnectTimer();
      setIsConnected(false);
      optionsRef.current.onError?.('Connection timeout');
      socketRef.current?.disconnect();
      socketRef.current = null;
    }, 15000);

    return s;
  }, [clearConnectTimer]);

  /** 断开并清理 */
  const disconnect = useCallback(() => {
    clearConnectTimer();
    if (socketRef.current) {
      socketRef.current.removeAllListeners();
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    setIsConnected(false);
  }, [clearConnectTimer]);

  // 组件卸载时清理
  useEffect(() => {
    return () => { disconnect(); };
  }, [disconnect]);

  return {
    socketRef,
    isConnected,
    connect,
    disconnect,
    connectTimerRef,
    clearConnectTimer,
  };
}
