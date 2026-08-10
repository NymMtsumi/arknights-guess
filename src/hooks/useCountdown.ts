'use client';

import { useState, useRef, useCallback, useEffect } from 'react';

interface UseCountdownOptions {
  /** 倒计时归零回调 */
  onExpire?: () => void;
}

/**
 * 倒计时 hook。
 * 多人和派对模式共用：统一管理 setInterval 生命周期，防止定时器泄漏。
 *
 * @example
 * const { timeLeft, start, stop, isRunning } = useCountdown({ onExpire: () => console.log('time up') });
 * start(120); // 开始 120 秒倒计时
 */
export function useCountdown(options: UseCountdownOptions = {}) {
  const { onExpire } = options;
  const [timeLeft, setTimeLeft] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const expireTimerRef = useRef<NodeJS.Timeout | null>(null);
  const timeLeftRef = useRef(0);
  const onExpireRef = useRef(onExpire);

  // 保持回调引用最新，避免 useEffect 重新绑定
  useEffect(() => {
    onExpireRef.current = onExpire;
  }, [onExpire]);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    // Fix M4-4: 取消待执行的 onExpire 回调（防止在新 round 中误触发）
    if (expireTimerRef.current) {
      clearTimeout(expireTimerRef.current);
      expireTimerRef.current = null;
    }
  }, []);

  const start = useCallback((seconds: number) => {
    clearTimer();
    const sec = Math.max(0, Math.floor(seconds));
    timeLeftRef.current = sec;
    setTimeLeft(sec);
    setIsRunning(sec > 0);

    if (sec <= 0) {
      expireTimerRef.current = setTimeout(() => onExpireRef.current?.(), 0);
      return;
    }

    timerRef.current = setInterval(() => {
      // Fix M4-3: 副作用移出 setState updater（纯函数化）
      const next = timeLeftRef.current - 1;
      timeLeftRef.current = next;
      setTimeLeft(next);
      if (next <= 0) {
        clearTimer();
        setIsRunning(false);
        expireTimerRef.current = setTimeout(() => onExpireRef.current?.(), 0);
      }
    }, 1000);
  }, [clearTimer]);

  const stop = useCallback(() => {
    clearTimer();
    setIsRunning(false);
  }, [clearTimer]);

  const reset = useCallback((seconds?: number) => {
    clearTimer();
    setIsRunning(false);
    if (seconds !== undefined) {
      const sec = Math.max(0, Math.floor(seconds));
      timeLeftRef.current = sec;
      setTimeLeft(sec);
    } else {
      timeLeftRef.current = 0;
      setTimeLeft(0);
    }
  }, [clearTimer]);

  // 组件卸载清理
  useEffect(() => {
    return () => { clearTimer(); };
  }, [clearTimer]);

  return { timeLeft, isRunning, start, stop, reset };
}
