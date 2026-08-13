'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { getUser, getServerUrl } from '@/lib/auth';

const NICK_KEY = 'liyiba-nickname';
const MAX_LENGTH = 12; // Fix M4-6: 与 lobby 对齐（派对模式 12 字上限）

function loadNick(): string {
  if (typeof window === 'undefined') return '';
  try { return localStorage.getItem(NICK_KEY) || ''; } catch { return ''; }
}

function saveNick(n: string) {
  if (typeof window === 'undefined') return; // Fix: SSR guard
  try { localStorage.setItem(NICK_KEY, n); } catch { /* ignore */ }
}

/**
 * 玩家名管理 hook。
 * 多人和派对模式共用：localStorage 持久化 + 认证用户回退 + 游客身份 API 回退。
 *
 * @returns playerName — 当前名字（最多 12 字）
 * @returns setPlayerName — 受控输入更新（不持久化）
 * @returns savePlayerName — 受控输入 + 持久化
 */
export function usePlayerName() {
  const [playerName, setPlayerName] = useState('');
  const userSetRef = useRef(false); // Fix M4-5: 防止 guest identity API 覆盖用户输入

  // 客户端挂载时初始化名字
  useEffect(() => {
    const stored = loadNick();
    if (stored) {
      setPlayerName(stored);
      userSetRef.current = true;
      return;
    }

    const user = getUser();
    if (user) {
      const name = user.nickname || user.username;
      if (name) {
        setPlayerName(name.slice(0, MAX_LENGTH));
        userSetRef.current = true;
        return;
      }
    }

    // 游客身份 API
    const controller = new AbortController();
    fetch(`${getServerUrl()}/api/guest-identity`, { signal: controller.signal })
      .then(res => res.json())
      .then(data => {
        // Fix M4-5: 如果用户已手动输入了名字，不覆盖
        if (!userSetRef.current && data.displayName) {
          setPlayerName(data.displayName.slice(0, MAX_LENGTH));
        }
      })
      .catch(() => { /* 静默失败 */ });
    return () => controller.abort();
  }, []);

  /** 持久化名字并更新 state */
  const savePlayerName = useCallback((name: string) => {
    const trimmed = name.trim().slice(0, MAX_LENGTH);
    userSetRef.current = true;
    setPlayerName(trimmed);
    saveNick(trimmed);
  }, []);

  return { playerName, setPlayerName, savePlayerName };
}
