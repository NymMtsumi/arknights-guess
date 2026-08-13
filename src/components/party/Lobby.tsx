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
  const playerName = usePartyStore(s => s.playerName);
  const setPlayerName = usePartyStore(s => s.setPlayerName);
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

  const isValid = playerName.trim().length > 0 && playerName.trim().length <= 12;

  const handleCreate = (difficulty: string, rounds: number, roundTime: number, attributes: string[] | null, maxGuesses: number) => {
    if (!isConnected || !socket) return;
    if (!isValid) { setError(t('party.enterNick')); return; }
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
    socket.emit('party:create', { playerName: playerName.trim(), difficulty, rounds, roundTime, attributes, maxGuesses }, (res: { ok?: boolean; code?: string; message?: string }) => {
      // ack 兜底：失败时快速清除 connecting（错误文案由 party:error 事件负责）
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (res && res.ok === false) usePartyStore.setState({ connecting: '' });
    });
  };

  const handleJoin = (code: string) => {
    if (!isConnected || !socket) return;
    if (!isValid) { setError(t('party.enterNick')); return; }
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
    socket.emit('party:join', { roomCode: trimmed, playerName: playerName.trim() }, (res: { ok?: boolean; code?: string; message?: string }) => {
      // ack 兜底：失败时快速清除 connecting（错误文案由 party:error 事件负责）
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (res && res.ok === false) usePartyStore.setState({ connecting: '' });
    });
  };

  return (
    <div style={{ textAlign: 'center', maxWidth: '480px' }}>
      <h1 style={{
        fontFamily: 'var(--font-display)',
        fontSize: 'clamp(1.5rem, 4vw, 2rem)',
        fontStyle: 'italic',
        fontWeight: 900,
        marginBottom: '8px',
      }}>
        🎉 {t('party.title')}
      </h1>
      <p style={{ color: 'var(--text-light)', fontSize: '0.9rem', marginBottom: '20px' }}>
        {t('party.description')}
      </p>

      {/* 昵称输入 */}
      <input
        value={playerName}
        onChange={e => setPlayerName(e.target.value)}
        placeholder={t('party.nickPlaceholder')}
        style={{
          width: '100%', maxWidth: '300px', padding: '10px',
          background: 'var(--input-bg)', color: 'var(--text)',
          border: '1px solid var(--border)', borderRadius: 'var(--radius)',
          fontSize: '1rem', textAlign: 'center', marginBottom: '16px',
        }}
        maxLength={12}
      />

      {/* 创建房间 */}
      <div style={{
        padding: '16px', background: 'var(--card)',
        border: '1px solid var(--border)', borderRadius: 'var(--radius)',
        marginBottom: '16px',
      }}>
        <h3 style={{ fontWeight: 700, fontSize: '0.95rem', marginBottom: '12px' }}>
          {t('party.createRoom')}
        </h3>

        <HostSettings
          settings={settings}
          onChange={(s) => setSettings(s)}
          disabled={!!connecting}
          t={t}
        />

        <button
          onClick={() => handleCreate(settings.difficulty, settings.rounds, settings.roundTime, settings.attributes, settings.maxGuesses)}
          disabled={!!connecting || !isValid || !isConnected}
          style={{
            width: '100%', padding: '12px', background: connecting ? 'var(--card-soft)' : 'var(--primary)',
            color: connecting ? 'var(--text-light)' : 'var(--bg)', border: 'none',
            borderRadius: 'var(--radius)', fontSize: '1rem', fontWeight: 700,
            cursor: connecting ? 'default' : 'pointer', opacity: connecting ? 0.7 : 1,
            marginTop: '8px',
          }}
        >
          {connecting === 'create' ? t('party.creating') : t('party.createRoom')}
        </button>
      </div>

      {/* 加入房间 */}
      <div style={{
        padding: '16px', background: 'var(--card)',
        border: '1px solid var(--border)', borderRadius: 'var(--radius)',
        marginBottom: '16px',
      }}>
        <h3 style={{ fontWeight: 700, fontSize: '0.95rem', marginBottom: '12px' }}>
          {t('party.joinRoom')}
        </h3>
        <input
          value={joinCode}
          onChange={e => setJoinCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          placeholder={t('party.codePlaceholder')}
          style={{
            width: '100%', padding: '10px',
            background: 'var(--input-bg)', color: 'var(--text)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius)',
            fontSize: '1.2rem', textAlign: 'center', fontFamily: 'monospace',
            letterSpacing: '0.2em', marginBottom: '8px',
          }}
          inputMode="numeric"
          maxLength={6}
        />
        <button
          onClick={() => handleJoin(joinCode)}
          id="party-join-btn"
          disabled={!!connecting || !isValid || joinCode.length !== 6 || !isConnected}
          style={{
            width: '100%', padding: '12px', background: connecting ? 'var(--card-soft)' : 'var(--accent)',
            color: connecting ? 'var(--text-light)' : '#fff', border: 'none',
            borderRadius: 'var(--radius)', fontSize: '1rem', fontWeight: 700,
            cursor: connecting ? 'default' : 'pointer', opacity: connecting ? 0.7 : 1,
          }}
        >
          {connecting === 'join' ? t('party.joining') : t('party.joinRoom')}
        </button>
      </div>

      {/* 上次房间 */}
      {savedCode && (
        <div style={{
          padding: '12px', background: 'var(--card-soft)',
          borderRadius: 'var(--radius)', border: '1px solid var(--primary)',
          marginBottom: '16px',
        }}>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-light)', marginBottom: '4px' }}>
            {t('party.lastRoom')}
          </p>
          <p style={{ fontSize: '1.3rem', fontFamily: 'monospace', fontWeight: 900, color: 'var(--primary)' }}>
            {savedCode}
          </p>
          <button
            onClick={() => {
              if (isConnected && socket) {
                socket.emit('party:reconnect', { roomCode: savedCode });
              }
            }}
            style={{
              marginTop: '8px', padding: '8px 20px',
              background: 'var(--primary)', color: 'var(--bg)',
              border: 'none', borderRadius: 'var(--radius)',
              fontWeight: 700, cursor: 'pointer',
            }}
          >
            {t('party.rejoin')}
          </button>
        </div>
      )}

      {error && (
        <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginBottom: '12px' }}>
          {error}
        </p>
      )}

      <button onClick={onBack} disabled={!!connecting} style={{
        padding: '8px 20px', background: 'transparent', color: 'var(--text)',
        border: '1px solid var(--border)', borderRadius: 'var(--radius)',
        cursor: connecting ? 'default' : 'pointer', fontWeight: 700,
        opacity: connecting ? 0.5 : 1,
      }}>
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
    <div style={{ marginBottom: '12px' }}>
      {/* 难度 */}
      <div style={{ marginBottom: '10px' }}>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-light)', marginRight: '8px' }}>
          {t('party.difficulty')}:
        </span>
        <div style={{ display: 'flex', gap: '6px', justifyContent: 'center', marginTop: '4px' }}>
          {['easy', 'medium', 'hard'].map(d => (
            <button
              key={d}
              disabled={disabled}
              onClick={() => onChange({ ...settings, difficulty: d })}
              style={{
                padding: '4px 12px', fontSize: '0.8rem',
                background: settings.difficulty === d ? 'var(--primary)' : 'transparent',
                color: settings.difficulty === d ? 'var(--bg)' : 'var(--text)',
                border: `1px solid ${settings.difficulty === d ? 'var(--primary)' : 'var(--border)'}`,
                borderRadius: 'var(--radius)', cursor: disabled ? 'default' : 'pointer',
                fontWeight: settings.difficulty === d ? 700 : 400,
              }}
            >
              {t(diffLabels[d])}
            </button>
          ))}
        </div>
      </div>

      {/* 回合数 */}
      <div style={{ marginBottom: '10px' }}>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-light)', marginRight: '8px' }}>
          {t('party.rounds')}:
        </span>
        <div style={{ display: 'flex', gap: '6px', justifyContent: 'center', marginTop: '4px' }}>
          {[5, 7, 10].map(n => (
            <button
              key={n}
              disabled={disabled}
              onClick={() => onChange({ ...settings, rounds: n })}
              style={{
                padding: '4px 12px', fontSize: '0.8rem',
                background: settings.rounds === n ? 'var(--primary)' : 'transparent',
                color: settings.rounds === n ? 'var(--bg)' : 'var(--text)',
                border: `1px solid ${settings.rounds === n ? 'var(--primary)' : 'var(--border)'}`,
                borderRadius: 'var(--radius)', cursor: disabled ? 'default' : 'pointer',
                fontWeight: settings.rounds === n ? 700 : 400,
              }}
            >
              {t('party.roundsCount', { n })}
            </button>
          ))}
        </div>
      </div>

      {/* 回合时间 */}
      <div>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-light)', marginRight: '8px' }}>
          {t('party.roundTime')}:
        </span>
        <div style={{ display: 'flex', gap: '6px', justifyContent: 'center', marginTop: '4px', flexWrap: 'wrap' }}>
          {[60, 120, 180, 240, 300].map(s => (
            <button
              key={s}
              disabled={disabled}
              onClick={() => onChange({ ...settings, roundTime: s })}
              style={{
                padding: '4px 10px', fontSize: '0.78rem',
                background: settings.roundTime === s ? 'var(--primary)' : 'transparent',
                color: settings.roundTime === s ? 'var(--bg)' : 'var(--text)',
                border: `1px solid ${settings.roundTime === s ? 'var(--primary)' : 'var(--border)'}`,
                borderRadius: 'var(--radius)', cursor: disabled ? 'default' : 'pointer',
                fontWeight: settings.roundTime === s ? 700 : 400,
              }}
            >
              {t('party.secondsFormat', { s: Math.floor(s / 60) })}
            </button>
          ))}
        </div>
      </div>

      {/* 每局猜测次数 */}
      <div style={{ marginBottom: '10px' }}>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-light)', marginRight: '8px' }}>
          {t('party.maxGuesses')}:
        </span>
        <div style={{ display: 'flex', gap: '6px', justifyContent: 'center', marginTop: '4px', flexWrap: 'wrap' }}>
          {[5, 8, 10, 12, 15].map(n => (
            <button
              key={n}
              disabled={disabled}
              onClick={() => onChange({ ...settings, maxGuesses: n })}
              style={{
                padding: '4px 10px', fontSize: '0.78rem',
                background: settings.maxGuesses === n ? 'var(--primary)' : 'transparent',
                color: settings.maxGuesses === n ? 'var(--bg)' : 'var(--text)',
                border: `1px solid ${settings.maxGuesses === n ? 'var(--primary)' : 'var(--border)'}`,
                borderRadius: 'var(--radius)', cursor: disabled ? 'default' : 'pointer',
                fontWeight: settings.maxGuesses === n ? 700 : 400,
              }}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      {/* 词条列 */}
      <div>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-light)', marginRight: '8px' }}>
          {t('party.attributes')}:
        </span>
        <span style={{ fontSize: '0.72rem', color: 'var(--text-light)' }}>
          {settings.attributes === null ? t('party.standardColumns') : `${settings.attributes.length}/${ATTR_KEYS.length}`}
        </span>
        <div style={{ display: 'flex', gap: '6px', justifyContent: 'center', marginTop: '4px', flexWrap: 'wrap' }}>
          {ATTR_KEYS.map(a => {
            const on = settings.attributes === null || settings.attributes.includes(a);
            return (
              <button
                key={a}
                disabled={disabled}
                onClick={() => toggleAttr(a)}
                style={{
                  padding: '3px 8px', fontSize: '0.72rem',
                  background: on ? 'var(--primary)' : 'transparent',
                  color: on ? 'var(--bg)' : 'var(--text)',
                  border: `1px solid ${on ? 'var(--primary)' : 'var(--border)'}`,
                  borderRadius: 'var(--radius)', cursor: disabled ? 'default' : 'pointer',
                  fontWeight: on ? 700 : 400,
                  opacity: settings.attributes === null ? 0.85 : 1,
                }}
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
            style={{
              marginTop: '6px', padding: '3px 10px', fontSize: '0.72rem',
              background: 'transparent', color: 'var(--text-light)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius)',
              cursor: disabled ? 'default' : 'pointer',
            }}
          >
            {t('party.resetStandard')}
          </button>
        )}
      </div>
    </div>
  );
}
