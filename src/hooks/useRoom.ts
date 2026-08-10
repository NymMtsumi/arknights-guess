'use client';

import { useState, useCallback } from 'react';

const ROOM_KEY = 'liyiba-room';
const BEST_OF_OPTIONS = [3, 5, 7] as const;
const DIFFICULTY_OPTIONS = ['easy', 'medium', 'hard'] as const;

export type BestOf = (typeof BEST_OF_OPTIONS)[number];
export type Difficulty = (typeof DIFFICULTY_OPTIONS)[number];

function loadRoomCode(): string {
  if (typeof window === 'undefined') return '';
  try { return localStorage.getItem(ROOM_KEY) || ''; } catch { return ''; }
}

function saveRoomCode(code: string) {
  try { localStorage.setItem(ROOM_KEY, code); } catch { /* ignore */ }
}

function clearRoomCode() {
  try { localStorage.removeItem(ROOM_KEY); } catch { /* ignore */ }
}

/**
 * 房间状态管理 hook。
 * 多人和派对模式共用：roomCode 持久化、bestOf、difficulty。
 *
 * @param defaultBestOf — 默认 BO 值（多人默认 5，派对可覆盖）
 */
export function useRoom(defaultBestOf: BestOf = 5) {
  const [roomCode, setRoomCode] = useState('');
  const [bestOf, setBestOf] = useState<BestOf>(defaultBestOf);
  const [difficulty, setDifficulty] = useState<Difficulty>('hard');

  /** 保存房间号到 localStorage + state */
  const persistRoomCode = useCallback((code: string) => {
    setRoomCode(code);
    saveRoomCode(code);
  }, []);

  /** 清除房间号（退出房间时调用） */
  const forgetRoom = useCallback(() => {
    setRoomCode('');
    clearRoomCode();
  }, []);

  /** 尝试恢复上次房间号（页面加载时调用） */
  const restoreRoomCode = useCallback((): string => {
    const saved = loadRoomCode();
    if (saved) setRoomCode(saved);
    return saved;
  }, []);

  /** 获取制胜所需胜场数 */
  const winsNeeded = Math.ceil(bestOf / 2);

  return {
    roomCode,
    setRoomCode,
    persistRoomCode,
    forgetRoom,
    restoreRoomCode,
    loadRoomCode,
    bestOf,
    setBestOf,
    difficulty,
    setDifficulty,
    winsNeeded,
    BEST_OF_OPTIONS,
    DIFFICULTY_OPTIONS,
  };
}
