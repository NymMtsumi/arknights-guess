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
    <div className="text-center max-w-[520px]">
      {/* 房间码 */}
      <h2 className="scr-ttl">
        {t('party.waitingTitle')}
      </h2>
      <div data-testid="party-room-code" className="code-big my-3">
        {roomCode}
      </div>

      {/* 复制邀请链接 */}
      <button
        onClick={handleCopyLink}
        className="btn-o btn-sm mb-4"
      >
        {copySuccess ? '✅ ' + t('party.copied') : '📋 ' + t('party.copyLink')}
      </button>

      {/* 玩家列表 */}
      <div className="card mb-3">
        <div data-testid="party-player-count" className="font-bold text-sm mb-2">
          {t('party.players')} ({players.length}/{PARTY_MAX_PLAYERS})
        </div>
        {players.map(p => {
          const isMe = p.id === socketId;
          const disconnected = disconnectedPlayers.includes(p.id);
          return (
            <div key={p.id} className={`prow${isMe ? ' you' : ''}`}>
              {/* 稿子（index-v12-modes.html:1588-1596）这里放的是 emoji 头像；
                  线上没有头像数据，改用名字首字 —— 是玩家自己的信息，不是编的装饰。 */}
              <span className={`avatar${disconnected ? ' off' : ''}`} aria-hidden="true">
                {p.name.slice(0, 1)}
              </span>
              <div className="pname">
                {p.name}
                {p.id === hostId && (
                  <span className="tag host">{t('party.host')}</span>
                )}
              </div>
              <span className="pstate">
                {/* 房主没有 ready 开关（服务端视其恒为就绪），原来就不给房主渲染状态标，
                    这里保持不变 —— 否则房主行会一直显示「未准备」。 */}
                {p.id !== hostId && (
                  disconnected ? (
                    <span data-testid="party-disconnected-badge" className="st-off">
                      🔌 {t('party.statusDisconnected')}
                    </span>
                  ) : (
                    <span className={p.ready ? 'pill on' : 'st-not'}>
                      {p.ready ? '✅ ' + t('party.ready') : '⏳ ' + t('party.notReady')}
                    </span>
                  )
                )}
              </span>
              {isHost && p.id !== hostId && (
                <button
                  onClick={() => handleKick(p.id)}
                  className="kick-x"
                  title={t('party.kick')}
                >
                  ✕
                </button>
              )}
            </div>
          );
        })}
        {players.length < PARTY_MIN_PLAYERS && (
          <p className="formmsg warn">
            {t('party.minPlayers', { current: players.length, min: PARTY_MIN_PLAYERS })}
          </p>
        )}
      </div>

      {/* 房主设置面板 */}
      {isHost && (
        <div className="card mb-3">
          <button
            onClick={() => setShowSettings(!showSettings)}
            className={showSettings ? 'btn-o w-full mb-3' : 'btn-o w-full'}
          >
            ⚙️ {t('party.roomSettings')} {showSettings ? '▲' : '▼'}
          </button>
          {showSettings && (
            <HostSettings settings={settings} onChange={handleSettingsChange} disabled={false} t={t} />
          )}
        </div>
      )}

      {/* 当前设置摘要 */}
      <div className="cfg-hint flex gap-3 justify-center mb-3">
        <span>{t('party.difficulty')}: {t(`party.difficulty${settings.difficulty.charAt(0).toUpperCase() + settings.difficulty.slice(1)}`)}</span>
        <span>·</span>
        <span>{t('party.roundsCount', { n: settings.rounds })}</span>
        <span>·</span>
        <span>{t('party.secondsFormat', { s: Math.floor(settings.roundTime / 60) })}</span>
      </div>

      {/* 操作按钮 */}
      <div className="flex gap-2.5 justify-center flex-wrap">
        {!isHost && (
          <button
            data-testid="party-ready"
            onClick={handleToggleReady}
            disabled={!isConnected}
            className={players.find(p => p.id === socketId)?.ready ? 'btn-o' : 'btn-p'}
          >
            {players.find(p => p.id === socketId)?.ready ? t('party.cancelReady') : t('party.readyUp')}
          </button>
        )}
        {isHost && (
          <button
            data-testid="party-start"
            onClick={handleStart}
            disabled={!isConnected || players.length < PARTY_MIN_PLAYERS || !allReady}
            className={players.length >= PARTY_MIN_PLAYERS && allReady ? 'btn-p' : 'btn-o'}
          >
            🚀 {t('party.startGame')}
          </button>
        )}
        <button
          data-testid="party-leave"
          onClick={() => socket.emit('party:leave', handleAckError)}
          disabled={!isConnected}
          className="btn-o"
        >
          {t('party.leave')}
        </button>
      </div>

      {error && (
        <p className="alert alert-dan">
          {error}
        </p>
      )}
    </div>
  );
}
