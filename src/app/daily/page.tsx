'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Header } from '@/components/Header';
import { GameSearch } from '@/components/GameSearch';
import { GuessTable } from '@/components/GuessTable';
import { GameEndDialog } from '@/components/GameEndDialog';
import { RulesDialog } from '@/components/RulesDialog';
import { Footer } from '@/components/Footer';
import { useDailyStore } from '@/stores/daily-store';
import { useI18n } from '@/lib/i18n';
import { getServerUrl, getPlayerKey, getToken } from '@/lib/auth';
import { saveGameStats } from '@/lib/stats';

export default function DailyPage() {
  const { t } = useI18n();
  const router = useRouter();
  const store = useDailyStore();
  const [rulesOpen, setRulesOpen] = useState(false);
  const [dialogClosed, setDialogClosed] = useState(false);
  const [dialogReady, setDialogReady] = useState(false);
  const [flashTrigger, setFlashTrigger] = useState(0);
  const [saveError, setSaveError] = useState('');
  const dialogTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [countdown, setCountdown] = useState('');

  const { status, target, guesses, remainingGuesses, previousResult, error, initDaily, submitGuess, giveUp } = store;

  const guessedIds = useMemo(() => new Set(guesses.map(g => g.character.id)), [guesses]);

  // 初始化：获取每日目标
  useEffect(() => {
    initDaily();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 倒计时到 UTC 午夜
  useEffect(() => {
    const update = () => {
      const now = new Date();
      const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
      const diff = tomorrow.getTime() - now.getTime();
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setCountdown(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`);
    };
    update();
    const t = setInterval(update, 1000);
    return () => clearInterval(t);
  }, []);

  // 游戏结束时保存统计 + 提交到服务端
  const prevStatus = useRef(status);
  const savedRef = useRef(false);
  useEffect(() => {
    if (prevStatus.current === 'playing' && (status === 'won' || status === 'lost')) {
      if (!savedRef.current) {
        const won = status === 'won';
        // 本地统计
        saveGameStats(won, guesses.length, 'hard', target?.name || '', 'daily');

        // 提交到服务端（mode='daily'）
        const base = getServerUrl();
        const token = getToken();
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        fetch(`${base}/api/save-game`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            player_key: getPlayerKey() || '',
            won,
            guessCount: guesses.length,
            difficulty: 'hard',
            targetName: target?.name || '',
            mode: 'daily',
            timestamp: Date.now(),
          }),
        }).then(async (res) => {
          if (!res.ok) {
            const err = await res.json();
            if (res.status === 400 && err.error?.includes('跨日')) {
              setSaveError(t('daily.crossDayError'));
            } else if (res.status === 409) {
              // 已提交过，忽略
            } else {
              setSaveError(err.error || t('daily.saveError'));
            }
          }
        }).catch(() => {});

        savedRef.current = true;
      }
      if (status === 'won') {
        setDialogReady(false);
        dialogTimer.current = setTimeout(() => setDialogReady(true), 800);
      } else {
        setDialogReady(true);
      }
    }
    if (status === 'playing') {
      savedRef.current = false;
      setDialogReady(false);
      setSaveError('');
      if (dialogTimer.current) { clearTimeout(dialogTimer.current); dialogTimer.current = null; }
    }
    prevStatus.current = status;
    return () => { if (dialogTimer.current) { clearTimeout(dialogTimer.current); dialogTimer.current = null; } };
  }, [status, guesses.length, target]);

  // 心跳：告知服务器正在玩游戏
  useEffect(() => {
    if (status !== 'playing') return;
    const abortController = new AbortController();
    const sendHeartbeat = () => {
      const pk = getPlayerKey();
      if (!pk) return;
      fetch(`${getServerUrl()}/api/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerKey: pk }),
        signal: abortController.signal,
      }).catch(() => {});
    };
    sendHeartbeat();
    const interval = setInterval(sendHeartbeat, 30_000);
    return () => {
      clearInterval(interval);
      abortController.abort();
    };
  }, [status]);

  const handleGuess = (char: import('@/types/character').Character) => {
    submitGuess(char.name);
  };

  const handleClose = () => {
    setDialogClosed(true);
    setFlashTrigger(t => t + 1);
  };

  const handleBackToHome = () => {
    router.push('/');
  };

  // ===== 错误状态 =====
  if (status === 'error') {
    return (
      <div className="page">
        <Header />
        <div className="page-scroll" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingTop: 'clamp(60px, 10vw, 120px)' }}>
          <div style={{ fontSize: '2.5rem', marginBottom: '16px' }}>⚠️</div>
          <p style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--danger)', marginBottom: '24px' }}>{error || t('common.error')}</p>
          <button onClick={() => window.location.reload()} style={{
            padding: '10px 24px', background: 'var(--primary)', color: 'var(--bg)',
            border: 'none', borderRadius: 'var(--radius)', fontWeight: 700, cursor: 'pointer', fontSize: '1rem',
          }}>
            {t('common.refresh')}
          </button>
        </div>
        <Footer />
      </div>
    );
  }

  // ===== 加载状态 =====
  if (status === 'loading') {
    return (
      <div className="page">
        <Header />
        <div className="page-scroll" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingTop: 'clamp(60px, 10vw, 120px)' }}>
          <div style={{ fontSize: '2.5rem', marginBottom: '16px', animation: 'neon-pulse 1.5s infinite' }}>📅</div>
          <p style={{ fontSize: '1.2rem', fontWeight: 700 }}>{t('common.loading')}</p>
        </div>
        <Footer />
      </div>
    );
  }

  // ===== 今日已挑战 =====
  if (status === 'already-played') {
    return (
      <div className="page">
        <Header />
        <div className="page-scroll" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 'clamp(32px, 6vw, 60px)' }}>
          <h1 style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'clamp(1.8rem, 4vw, 2.5rem)',
            fontStyle: 'italic',
            fontWeight: 900,
            letterSpacing: '0.06em',
            marginBottom: '8px',
            textAlign: 'center',
          }}>
            📅 {t('daily.alreadyPlayed')}
          </h1>
          <p style={{ color: 'var(--text-light)', marginBottom: '24px', textAlign: 'center' }}>
            {t('daily.alreadyPlayedDesc')}
          </p>

          {/* 今日成绩 */}
          {previousResult && (
            <div style={{
              background: 'var(--card)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              padding: '20px 28px',
              textAlign: 'center',
              marginBottom: '24px',
              maxWidth: '360px',
              width: '100%',
            }}>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-light)', marginBottom: '4px' }}>{t('daily.yourResult')}</p>
              <p style={{ fontSize: '2rem', fontWeight: 900, color: previousResult.won ? 'var(--correct)' : 'var(--danger)' }}>
                {previousResult.won ? t('daily.won') : t('daily.lost')}
              </p>
              <p style={{ fontSize: '0.9rem', color: 'var(--text-light)' }}>
                {t('daily.guesses', { count: previousResult.guessCount })}
              </p>
              {target && (
                <p style={{ fontSize: '0.85rem', color: 'var(--text-light)', marginTop: '8px' }}>
                  {t('daily.answer')}：{target.name}
                </p>
              )}
            </div>
          )}

          {/* 倒计时 */}
          <div style={{ textAlign: 'center', marginBottom: '24px' }}>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-light)', marginBottom: '4px' }}>{t('daily.nextReset')}</p>
            <p style={{ fontSize: '1.8rem', fontFamily: 'monospace', fontWeight: 900, color: 'var(--primary)' }}>{countdown}</p>
          </div>

          {/* 操作按钮 */}
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', justifyContent: 'center' }}>
            <button onClick={() => router.push('/leaderboard?mode=daily')} style={{
              padding: '10px 24px', background: 'var(--primary)', color: 'var(--bg)',
              border: 'none', borderRadius: 'var(--radius)', fontWeight: 700, cursor: 'pointer', fontSize: '1rem',
            }}>
              🏆 {t('daily.viewLeaderboard')}
            </button>
            <button onClick={handleBackToHome} style={{
              padding: '10px 24px', background: 'transparent', color: 'var(--text)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontWeight: 700, cursor: 'pointer', fontSize: '1rem',
            }}>
              ← {t('game.back')}
            </button>
          </div>
        </div>
        <Footer />
      </div>
    );
  }

  // ===== 游戏界面 =====
  return (
    <div className="page">
      <Header />

      <div className="page-scroll" style={{ paddingTop: 'clamp(16px, 2vw, 24px)' }}>
        {/* 游戏状态栏 */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '12px',
          marginBottom: '20px',
          maxWidth: 'var(--content-max)',
          margin: '0 auto 20px',
        }}>
          <button
            onClick={handleBackToHome}
            style={{
              padding: '6px 14px',
              background: 'transparent',
              color: 'var(--text-light)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              cursor: 'pointer',
              fontSize: '0.85rem',
            }}
          >
            ← {t('game.back')}
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            {/* 每日挑战标签 */}
            <span style={{
              fontWeight: 700, fontSize: '0.85rem', color: 'var(--primary)',
              background: 'var(--card-soft)', padding: '4px 10px', borderRadius: 'var(--radius)',
              border: '1px solid var(--primary)',
            }}>
              📅 {t('menu.daily')}
            </span>

            {/* 剩余次数 */}
            {status === 'playing' && (
              <span style={{
                fontWeight: 700,
                fontSize: '1.1rem',
                color: remainingGuesses <= 3 ? 'var(--danger)' : 'var(--text)',
              }}>
                {remainingGuesses <= 3
                  ? <span style={{ animation: 'urgent-pulse 1.2s ease-in-out infinite' }}>{t('game.guessesLeft', { count: remainingGuesses })}</span>
                  : t('game.guessesLeft', { count: remainingGuesses })
                }
              </span>
            )}

            {status === 'won' && <span style={{ color: 'var(--correct)', fontWeight: 700 }}>🎉 {t('guessCorrect')}</span>}
            {status === 'lost' && <span style={{ color: 'var(--danger)', fontWeight: 700 }}>{t('outOfGuesses')}</span>}

            {status === 'playing' && (
              <button
                onClick={giveUp}
                style={{
                  padding: '6px 14px',
                  background: 'transparent',
                  color: 'var(--danger)',
                  border: '1px solid var(--danger)',
                  borderRadius: 'var(--radius)',
                  cursor: 'pointer',
                  fontSize: '0.85rem',
                }}
              >
                {t('game.giveUp')}
              </button>
            )}
          </div>
        </div>

        {/* 保存错误提示 */}
        {saveError && (
          <div style={{
            textAlign: 'center', padding: '8px', marginBottom: '12px',
            background: 'var(--card-soft)', color: 'var(--warning)',
            borderRadius: 'var(--radius)', fontSize: '0.85rem',
          }}>
            {saveError}
          </div>
        )}

        {/* 搜索输入 */}
        <div style={{ maxWidth: 'var(--content-max)', margin: '0 auto' }}>
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <GameSearch
              onGuess={handleGuess}
              disabled={status !== 'playing'}
              guessedIds={guessedIds}
              target={target}
              remainingGuesses={remainingGuesses}
            />
          </div>

          {/* 猜测表格（每日挑战固定 hard 难度） */}
          <GuessTable guesses={guesses} target={target} hideRarity flashTrigger={flashTrigger} staggerKey={guesses.length} />

          {guesses.length === 0 && (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-light)' }}>
              <p style={{ fontSize: '1.1rem', marginBottom: '8px' }}>
                {t('searchHint')}
              </p>
              <p style={{ fontSize: '0.85rem' }}>
                {t('remainingGuesses', { count: remainingGuesses })}
              </p>
            </div>
          )}
        </div>

        {/* 游戏结束后的按钮 */}
        {dialogClosed && (status === 'won' || status === 'lost') && (
          <div style={{ textAlign: 'center', marginTop: '20px', display: 'flex', gap: '12px', justifyContent: 'center', flexWrap: 'wrap' }}>
            <button onClick={() => router.push('/leaderboard?mode=daily')} className="btn-shine" style={{
              padding: '12px 32px', background: 'var(--primary)', color: 'var(--bg)',
              border: 'none', borderRadius: 'var(--radius)', fontSize: '1rem',
              fontWeight: 700, cursor: 'pointer',
            }}>🏆 {t('daily.viewLeaderboard')}</button>
            <button onClick={handleBackToHome} style={{
              padding: '12px 32px', background: 'transparent', color: 'var(--text)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius)',
              fontWeight: 700, cursor: 'pointer', fontSize: '1rem',
            }}>← {t('game.back')}</button>
          </div>
        )}
      </div>

      {/* 结算弹窗 */}
      {!dialogClosed && dialogReady && (
        <GameEndDialog
          status={status}
          target={target}
          guessCount={guesses.length}
          onClose={handleClose}
          onNewGame={() => router.push('/leaderboard?mode=daily')}
        />
      )}
      <Footer />
    </div>
  );
}
