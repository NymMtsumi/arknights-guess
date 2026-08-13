'use client';

// 派对模式 - 等待室（准备阶段）
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { usePartyStore } from '@/stores/party-store';
import { HostSettings, type PartyHostSettings } from './Lobby';
import { PARTY_MIN_PLAYERS, PARTY_MAX_PLAYERS } from '@/lib/party-constants';
import { partyErrorMessage } from '@/lib/party-handlers';
import type { Socket } from 'socket.io-client';

interface WaitingRoomProps {
  socket: Socket;
  isConnected: boolean;
}

export function PartyWaitingRoom({ socket, isConnected }: WaitingRoomProps) {
  const { t } = useI18n();
  const roomCode = usePartyStore(s => s.roomCode);
  const hostId = usePartyStore(s => s.hostId);
  const players = usePartyStore(s => s.players);
  const settings = usePartyStore(s => s.settings);
  const socketId = usePartyStore(s => s.socketId);
  const disconnectedPlayers = usePartyStore(s => s.disconnectedPlayers);
  const setSettings = usePartyStore(s => s.setSettings);
  const error = usePartyStore(s => s.error);
  const setError = usePartyStore(s => s.setError);
  const [copySuccess, setCopySuccess] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const isHost = hostId === socketId;
  const readyCount = players.filter(p => p.ready).length;
  const nonHostPlayers = players.filter(p => p.id !== hostId);
  const allReady = nonHostPlayers.every(p => p.ready) && players.length >= PARTY_MIN_PLAYERS;

  // ack 失败统一处理：把服务端错误码映射成 i18n 文案（消灭静默失败）
  const handleAckError = (res?: { ok?: boolean; code?: string; minPlayers?: number }) => {
    if (res && res.ok === false) setError(partyErrorMessage(res.code, t, res.minPlayers));
  };

  const handleStart = () => {
    if (!isHost || !isConnected) return;
    if (players.length < PARTY_MIN_PLAYERS) {
      setError(t('party.needMorePlayers'));
      return;
    }
    if (!allReady) {
      setError(t('party.notAllReady'));
      return;
    }
    setError('');
    socket.emit('party:start', handleAckError);
  };

  const handleToggleReady = () => {
    if (isHost || !isConnected) return;
    socket.emit('party:toggle_ready', handleAckError);
  };

  const handleKick = (playerId: string) => {
    if (!isHost || !isConnected) return;
    socket.emit('party:kick', { playerId }, handleAckError);
  };

  const handleCopyLink = () => {
    const link = `${window.location.origin}/party?room=${roomCode}`;
    navigator.clipboard.writeText(link).then(() => {
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    }).catch(() => {
      // fallback: 复制房间码
      navigator.clipboard.writeText(roomCode).then(() => {
        setCopySuccess(true);
        setTimeout(() => setCopySuccess(false), 2000);
      }).catch(() => {});
    });
  };

  const handleSettingsChange = (s: PartyHostSettings) => {
    setSettings(s);
    socket.emit('party:update_settings', s, handleAckError);
  };

  return (
    <div style={{ textAlign: 'center', maxWidth: '520px' }}>
      {/* 房间码 */}
      <h2 style={{
        fontFamily: 'var(--font-display)',
        fontSize: '1.1rem',
        fontStyle: 'italic',
        fontWeight: 700,
        marginBottom: '8px',
      }}>
        {t('party.waitingTitle')}
      </h2>
      <div data-testid="party-room-code" style={{
        fontFamily: 'monospace', fontSize: '2.5rem', fontWeight: 900,
        color: 'var(--primary)', letterSpacing: '0.15em',
        margin: '12px 0',
      }}>
        {roomCode}
      </div>

      {/* 复制邀请链接 */}
      <button
        onClick={handleCopyLink}
        style={{
          padding: '6px 16px', background: 'var(--card-soft)', color: 'var(--text)',
          border: '1px solid var(--border)', borderRadius: 'var(--radius)',
          cursor: 'pointer', fontSize: '0.85rem', marginBottom: '16px',
        }}
      >
        {copySuccess ? '✅ ' + t('party.copied') : '📋 ' + t('party.copyLink')}
      </button>

      {/* 玩家列表 */}
      <div style={{
        padding: '12px', background: 'var(--card)',
        border: '1px solid var(--border)', borderRadius: 'var(--radius)',
        marginBottom: '12px',
      }}>
        <div data-testid="party-player-count" style={{ fontWeight: 700, fontSize: '0.9rem', marginBottom: '8px' }}>
          {t('party.players')} ({players.length}/{PARTY_MAX_PLAYERS})
        </div>
        {players.map(p => (
          <div
            key={p.id}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '8px 12px', marginBottom: '4px',
              background: 'var(--card-soft)', borderRadius: 'var(--radius)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {p.id === hostId && (
                <span style={{ fontSize: '0.75rem', color: 'var(--accent)' }}>👑</span>
              )}
              <span style={{ fontWeight: 600 }}>{p.name}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {p.id !== hostId && (
                disconnectedPlayers.includes(p.id) ? (
                  <span data-testid="party-disconnected-badge" style={{
                    fontSize: '0.8rem', fontWeight: 600,
                    color: 'var(--warning)',
                  }}>
                    🔌 {t('party.statusDisconnected')}
                  </span>
                ) : (
                  <span style={{
                    fontSize: '0.8rem', fontWeight: 600,
                    color: p.ready ? 'var(--correct)' : 'var(--text-light)',
                  }}>
                    {p.ready ? '✅ ' + t('party.ready') : '⏳ ' + t('party.notReady')}
                  </span>
                )
              )}
              {p.id === hostId && (
                <span style={{ fontSize: '0.75rem', color: 'var(--text-light)' }}>
                  {t('party.host')}
                </span>
              )}
              {isHost && p.id !== hostId && (
                <button
                  onClick={() => handleKick(p.id)}
                  style={{
                    padding: '2px 8px', fontSize: '0.7rem',
                    background: 'transparent', color: 'var(--danger)',
                    border: '1px solid var(--danger)', borderRadius: 'var(--radius)',
                    cursor: 'pointer',
                  }}
                >
                  {t('party.kick')}
                </button>
              )}
            </div>
          </div>
        ))}
        {players.length < PARTY_MIN_PLAYERS && (
          <p style={{ fontSize: '0.8rem', color: 'var(--warning)', marginTop: '8px' }}>
            {t('party.minPlayers', { current: players.length, min: PARTY_MIN_PLAYERS })}
          </p>
        )}
      </div>

      {/* 房主设置面板 */}
      {isHost && (
        <div style={{
          padding: '12px', background: 'var(--card)',
          border: '1px solid var(--border)', borderRadius: 'var(--radius)',
          marginBottom: '12px',
        }}>
          <button
            onClick={() => setShowSettings(!showSettings)}
            style={{
              width: '100%', padding: '8px', background: 'transparent',
              color: 'var(--text)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius)', cursor: 'pointer',
              fontWeight: 700, fontSize: '0.9rem', marginBottom: showSettings ? '12px' : '0',
            }}
          >
            ⚙️ {t('party.roomSettings')} {showSettings ? '▲' : '▼'}
          </button>
          {showSettings && (
            <HostSettings settings={settings} onChange={handleSettingsChange} disabled={false} t={t} />
          )}
        </div>
      )}

      {/* 当前设置摘要 */}
      <div style={{
        display: 'flex', gap: '12px', justifyContent: 'center',
        fontSize: '0.8rem', color: 'var(--text-light)', marginBottom: '12px',
      }}>
        <span>{t('party.difficulty')}: {t(`party.difficulty${settings.difficulty.charAt(0).toUpperCase() + settings.difficulty.slice(1)}`)}</span>
        <span>·</span>
        <span>{t('party.roundsCount', { n: settings.rounds })}</span>
        <span>·</span>
        <span>{t('party.secondsFormat', { s: Math.floor(settings.roundTime / 60) })}</span>
      </div>

      {/* 操作按钮 */}
      <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', flexWrap: 'wrap' }}>
        {!isHost && (
          <button
            data-testid="party-ready"
            onClick={handleToggleReady}
            disabled={!isConnected}
            style={{
              padding: '12px 28px', fontSize: '1rem', fontWeight: 700,
              border: 'none', borderRadius: 'var(--radius)',
              cursor: isConnected ? 'pointer' : 'default', opacity: isConnected ? 1 : 0.5,
              background: players.find(p => p.id === socketId)?.ready ? 'var(--card-soft)' : 'var(--primary)',
              color: players.find(p => p.id === socketId)?.ready ? 'var(--text-light)' : 'var(--bg)',
            }}
          >
            {players.find(p => p.id === socketId)?.ready ? t('party.cancelReady') : t('party.readyUp')}
          </button>
        )}
        {isHost && (
          <button
            data-testid="party-start"
            onClick={handleStart}
            disabled={!isConnected || players.length < PARTY_MIN_PLAYERS || !allReady}
            style={{
              padding: '12px 28px', fontSize: '1.1rem', fontWeight: 700,
              border: 'none', borderRadius: 'var(--radius)',
              cursor: players.length >= PARTY_MIN_PLAYERS && allReady ? 'pointer' : 'default',
              background: players.length >= PARTY_MIN_PLAYERS && allReady ? 'var(--accent)' : 'var(--card-soft)',
              color: players.length >= PARTY_MIN_PLAYERS && allReady ? '#fff' : 'var(--text-light)',
              opacity: players.length >= PARTY_MIN_PLAYERS && allReady ? 1 : 0.6,
            }}
          >
            🚀 {t('party.startGame')}
          </button>
        )}
        <button
          data-testid="party-leave"
          onClick={() => socket.emit('party:leave', handleAckError)}
          disabled={!isConnected}
          style={{
            padding: '12px 20px', fontSize: '0.9rem',
            background: 'transparent', color: 'var(--text)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius)',
            cursor: isConnected ? 'pointer' : 'default',
            fontWeight: 700, opacity: isConnected ? 1 : 0.5,
          }}
        >
          {t('party.leave')}
        </button>
      </div>

      {error && (
        <p style={{ color: 'var(--danger)', fontSize: '0.85rem', marginTop: '12px' }}>
          {error}
        </p>
      )}
    </div>
  );
}
