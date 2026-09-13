'use client';

// 派对模式 - 创建/加入房间界面
import { useState, useEffect, useRef, type MutableRefObject } from 'react';
import { useI18n } from '@/lib/i18n';
import { usePartyStore } from '@/stores/party-store';
import { useRoom } from '@/hooks/useRoom';
import { PARTY_ATTR_KEYS as ATTR_KEYS } from '@/lib/party-constants';
import type { Socket } from 'socket.io-client';

interface LobbyProps {
  onBack: () => void;
  socketRef: MutableRefObject<Socket | null>;
  isConnected: boolean;
  /** 邀请链接 ?room= 参数，预填加入码 */
  initialCode?: string;
}

export function PartyLobby({ onBack, socketRef, isConnected, initialCode }: LobbyProps) {
  const { t } = useI18n();
  const [joinCode, setJoinCode] = useState(initialCode ?? '');
  const { loadRoomCode } = useRoom();
  const error = usePartyStore(s => s.error);
  const setError = usePartyStore(s => s.setError);
  const connecting = usePartyStore(s => s.connecting);
  const setConnecting = usePartyStore(s => s.setConnecting);
  const settings = usePartyStore(s => s.settings);
  const setSettings = usePartyStore(s => s.setSettings);

  const savedCode = loadRoomCode();
  const socket = socketRef.current;

  // 超时定时器统一管理，组件卸载时清理，避免悬空 timer
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timeoutRef.current) clearTimeout(timeoutRef.current); }, []);

  const handleCreate = (difficulty: string, rounds: number, roundTime: number, attributes: string[] | null, maxGuesses: number) => {
    if (!isConnected || !socket) return;
    setError('');
    setSettings({ difficulty, rounds, roundTime, attributes, maxGuesses });
    setConnecting('create');
    // Fix M5-1: 30s 超时保护（可清理，避免组件卸载后仍触发）
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      if (usePartyStore.getState().connecting === 'create') {
        usePartyStore.setState({ connecting: '', error: t('party.connectTimeout') });
      }
    }, 30000);
    socket.emit('party:create', { difficulty, rounds, roundTime, attributes, maxGuesses }, (res: { ok?: boolean; code?: string; message?: string }) => {
      // ack 兜底：失败时快速清除 connecting（错误文案由 party:error 事件负责）
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (res && res.ok === false) usePartyStore.setState({ connecting: '' });
    });
  };

  const handleJoin = (code: string) => {
    if (!isConnected || !socket) return;
    const trimmed = code.trim();
    if (!/^\d{6}$/.test(trimmed)) { setError(t('party.invalidCode')); return; } // Fix: digit validation
    setError('');
    setConnecting('join');
    // Fix: 不在 emit 前设置 roomCode — 只有 successful joined 后才持久化
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      if (usePartyStore.getState().connecting === 'join') {
        usePartyStore.setState({ connecting: '', error: t('party.connectTimeout') });
      }
    }, 30000);
    socket.emit('party:join', { roomCode: trimmed }, (res: { ok?: boolean; code?: string; message?: string }) => {
      // ack 兜底：失败时快速清除 connecting（错误文案由 party:error 事件负责）
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (res && res.ok === false) usePartyStore.setState({ connecting: '' });
    });
  };

  return (
    <div className="text-center w-full max-w-[480px]">
      <h1 className="hero-title">
        🎉 {t('party.title')}
      </h1>
      <p className="sec-note" style={{ marginTop: 0, marginBottom: '20px' }}>
        {t('party.description')}
      </p>

      {/* 创建房间 */}
      <div className="card">
        <h3 className="card-sub">
          {t('party.createRoom')}
        </h3>

        <HostSettings
          settings={settings}
          onChange={(s) => setSettings(s)}
          disabled={!!connecting}
          t={t}
        />

        <button
          data-testid="party-create"
          onClick={() => handleCreate(settings.difficulty, settings.rounds, settings.roundTime, settings.attributes, settings.maxGuesses)}
          disabled={!!connecting || !isConnected}
          className="btn-p w-full mt-2"
        >
          {connecting === 'create' ? t('party.creating') : t('party.createRoom')}
        </button>
      </div>

      {/* 加入房间 */}
      <div className="card">
        <h3 className="card-sub">
          {t('party.joinRoom')}
        </h3>
        <input
          data-testid="party-join-input"
          value={joinCode}
          onChange={e => setJoinCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          placeholder={t('party.codePlaceholder')}
          className="search-input code-input mb-2"
          inputMode="numeric"
          maxLength={6}
        />
        <button
          onClick={() => handleJoin(joinCode)}
          id="party-join-btn"
          disabled={!!connecting || joinCode.length !== 6 || !isConnected}
          className="btn-p w-full"
        >
          {connecting === 'join' ? t('party.joining') : t('party.joinRoom')}
        </button>
      </div>

      {/* 上次房间 */}
      {savedCode && (
        <div className="card hi mb-4">
          <p className="sec-note mb-1">
            {t('party.lastRoom')}
          </p>
          <p className="code-big sm">
            {savedCode}
          </p>
          <button
            onClick={() => {
              if (isConnected && socket) {
                socket.emit('party:reconnect', { roomCode: savedCode });
              }
            }}
            className="btn-o btn-sm mt-2"
          >
            {t('party.rejoin')}
          </button>
        </div>
      )}

      {error && (
        <p className="formmsg err">
          {error}
        </p>
      )}

      <button onClick={onBack} disabled={!!connecting} className="btn-o mt-4">
        {t('party.back')}
      </button>
    </div>
  );
}

const ATTR_LABEL_KEYS: Record<string, string> = {
  class: 'table.class', subclass: 'table.subclass', faction: 'table.faction',
  rarity: 'table.rarity', race: 'table.race', gender: 'table.gender',
  releaseYear: 'table.year', position: 'table.position', tags: 'table.tags',
};

export interface PartyHostSettings {
  difficulty: string;
  rounds: number;
  roundTime: number;
  attributes: string[] | null;
  maxGuesses: number;
}

/** 房主设置面板（嵌入创建界面） */
export function HostSettings({
  settings, onChange, disabled, t,
}: {
  settings: PartyHostSettings;
  onChange: (s: PartyHostSettings) => void;
  disabled: boolean;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const diffLabels: Record<string, string> = {
    easy: 'party.difficultyEasy',
    medium: 'party.difficultyMedium',
    hard: 'party.difficultyHard',
  };

  const toggleAttr = (a: string) => {
    if (disabled) return;
    const attrs = settings.attributes;
    if (attrs === null) {
      // 标准 → 自定义：默认移除点击的列（其余 8 列保留）
      onChange({ ...settings, attributes: ATTR_KEYS.filter(k => k !== a) });
    } else if (attrs.includes(a)) {
      onChange({ ...settings, attributes: attrs.filter(k => k !== a) });
    } else {
      onChange({ ...settings, attributes: [...attrs, a] });
    }
  };

  return (
    <div className="mb-3">
      {/* 难度 */}
      <div className="cfg-row">
        <span className="cfg-lb">
          {t('party.difficulty')}:
        </span>
        <div className="seg">
          {['easy', 'medium', 'hard'].map(d => (
            <button
              key={d}
              disabled={disabled}
              onClick={() => onChange({ ...settings, difficulty: d })}
              className={settings.difficulty === d ? 'on' : undefined}
            >
              {t(diffLabels[d])}
            </button>
          ))}
        </div>
      </div>

      {/* 回合数 */}
      <div className="cfg-row">
        <span className="cfg-lb">
          {t('party.rounds')}:
        </span>
        <div className="seg">
          {[5, 7, 10].map(n => (
            <button
              key={n}
              disabled={disabled}
              onClick={() => onChange({ ...settings, rounds: n })}
              className={settings.rounds === n ? 'on' : undefined}
            >
              {t('party.roundsCount', { n })}
            </button>
          ))}
        </div>
      </div>

      {/* 回合时间 */}
      <div className="cfg-row">
        <span className="cfg-lb">
          {t('party.roundTime')}:
        </span>
        <div className="seg">
          {[60, 120, 180, 240, 300].map(s => (
            <button
              key={s}
              disabled={disabled}
              onClick={() => onChange({ ...settings, roundTime: s })}
              className={settings.roundTime === s ? 'on' : undefined}
            >
              {t('party.secondsFormat', { s: Math.floor(s / 60) })}
            </button>
          ))}
        </div>
      </div>

      {/* 每局猜测次数 */}
      <div className="cfg-row">
        <span className="cfg-lb">
          {t('party.maxGuesses')}:
        </span>
        <div className="seg">
          {[5, 8, 10, 12, 15].map(n => (
            <button
              key={n}
              disabled={disabled}
              onClick={() => onChange({ ...settings, maxGuesses: n })}
              className={settings.maxGuesses === n ? 'on' : undefined}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      {/* 词条列 */}
      <div className="cfg-row">
        <span className="cfg-lb">
          {t('party.attributes')}:
        </span>
        <span className="cfg-hint">
          {settings.attributes === null ? t('party.standardColumns') : `${settings.attributes.length}/${ATTR_KEYS.length}`}
        </span>
        <div className="cfg-ct">
          {ATTR_KEYS.map(a => {
            const on = settings.attributes === null || settings.attributes.includes(a);
            return (
              <button
                key={a}
                disabled={disabled}
                onClick={() => toggleAttr(a)}
                className={on ? 'tchip on' : 'tchip off'}
              >
                {t(ATTR_LABEL_KEYS[a])}
              </button>
            );
          })}
        </div>
        {settings.attributes !== null && (
          <button
            disabled={disabled}
            onClick={() => onChange({ ...settings, attributes: null })}
            className="btn-o btn-sm mt-1.5"
          >
            {t('party.resetStandard')}
          </button>
        )}
      </div>
    </div>
  );
}
