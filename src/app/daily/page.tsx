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
import { getServerUrl, getPlayerKey, AuthError } from '@/lib/auth';

export default function DailyPage() {
  const { t } = useI18n();
  const router = useRouter();
  const store = useDailyStore();
  const [rulesOpen, setRulesOpen] = useState(false);
  const [dialogClosed, setDialogClosed] = useState(false);
  const [dialogReady, setDialogReady] = useState(false);
  const [flashTrigger, setFlashTrigger] = useState(0);
  const [guessError, setGuessError] = useState('');
  const [authError, setAuthError] = useState(false); // 401 登录过期，持久显示
  const guessErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  // 游戏结束时弹窗（服务端已在 /api/daily/guess 中自动保存战绩）
  const prevStatus = useRef(status);
  useEffect(() => {
    if (prevStatus.current === 'playing' && (status === 'won' || status === 'lost')) {
      if (status === 'won') {
        setDialogReady(false);
        dialogTimer.current = setTimeout(() => setDialogReady(true), 800);
      } else {
        setDialogReady(true);
      }
    }
    if (status === 'playing') {
      setDialogReady(false);
      if (dialogTimer.current) { clearTimeout(dialogTimer.current); dialogTimer.current = null; }
    }
    prevStatus.current = status;
    return () => { if (dialogTimer.current) { clearTimeout(dialogTimer.current); dialogTimer.current = null; } };
  }, [status]);

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

  const handleGuess = async (char: import('@/types/character').Character) => {
    try {
      const result = await submitGuess(char.name);
      if (!result.success && result.error) {
        setGuessError(result.error);
        if (guessErrorTimer.current) clearTimeout(guessErrorTimer.current);
        guessErrorTimer.current = setTimeout(() => setGuessError(''), 3000);
      }
    } catch (err) {
      // AuthError（401）：登录过期，显示持久提示
      if (err instanceof AuthError) {
        setAuthError(true);
      } else {
        setGuessError((err as Error)?.message || '请求失败');
        if (guessErrorTimer.current) clearTimeout(guessErrorTimer.current);
        guessErrorTimer.current = setTimeout(() => setGuessError(''), 3000);
      }
    }
  };

  // 清理 error timer
  useEffect(() => {
    return () => { if (guessErrorTimer.current) clearTimeout(guessErrorTimer.current); };
  }, []);

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
        <div className="page-scroll">
          <div className="gate" style={{ maxWidth: 520, margin: '0 auto' }}>
            <div className="gic">⚠️</div>
            <h2 className="alert-dan">{error || t('common.error')}</h2>
            <button className="btn-p" style={{ marginTop: 20 }} onClick={() => window.location.reload()}>
              {t('common.refresh')}
            </button>
          </div>
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
        <div className="page-scroll">
          <div className="gate" style={{ maxWidth: 520, margin: '0 auto' }}>
            <div className="spin" />
            <p>{t('common.loading')}</p>
          </div>
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
        <div className="page-scroll">
          <div className="view-daily" style={{ maxWidth: 'var(--content-max)', margin: '0 auto' }}>
            <div className="panel-hd">
              <div>
                <h1>📅 {t('daily.alreadyPlayed')}</h1>
                <div className="sub">{t('daily.alreadyPlayedDesc')}</div>
              </div>
            </div>

            {/* 今日成绩 */}
            {previousResult && (
              <div className="card">
                <div className="card-hd">
                  <h2>{t('daily.yourResult')}</h2>
                </div>

                <div className={previousResult.won ? 'verdict' : 'verdict no'}>
                  <span className="vi">{previousResult.won ? '✓' : '✕'}</span>
                  <div>
                    <div className="vt">{previousResult.won ? t('daily.won') : t('daily.lost')}</div>
                    <div className="vs">{t('daily.guesses', { count: previousResult.guessCount })}</div>
                  </div>
                </div>

                {target && (
                  <div className="ansbox">
                    <span className="al">{t('daily.answer')}</span>
                    <span className="av2">{target.name}</span>
                    <span className="ae">{target.nameEn}</span>
                  </div>
                )}
              </div>
            )}

            {/* 倒计时 */}
            <div className="reset">
              <div className="rl">{t('daily.nextReset')}</div>
              <div className="rv">{countdown}</div>
            </div>

            {/* 操作按钮 */}
            <div className="bar-actions">
              <button className="btn-p" onClick={() => router.push('/leaderboard?mode=daily')}>
                🏆 {t('daily.viewLeaderboard')}
              </button>
              <button className="btn-o" onClick={handleBackToHome}>← {t('game.back')}</button>
            </div>
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

      <div className="page-scroll">
        <div className="view-daily" style={{ maxWidth: 'var(--content-max)', margin: '0 auto' }}>
          {/* 游戏状态栏 */}
          <div className="hud" style={{ marginBottom: 20 }}>
            <button className="btn-o" onClick={handleBackToHome}>
              ← {t('game.back')}
            </button>

            {/* 每日挑战标签 */}
            <span className="bdg bdg-mc">
              📅 {t('menu.daily')}
            </span>

            <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginLeft: 'auto' }}>
              {/* 剩余次数 */}
              {status === 'playing' && (
                <span className={remainingGuesses <= 3 ? 'bdg bdg-dan' : 'bdg bdg-no'}>
                  {remainingGuesses <= 3
                    ? <span style={{ animation: 'urgent-pulse 1.2s ease-in-out infinite' }}>{t('game.guessesLeft', { count: remainingGuesses })}</span>
                    : t('game.guessesLeft', { count: remainingGuesses })
                  }
                </span>
              )}

              {status === 'won' && <span className="bdg bdg-ok">🎉 {t('guessCorrect')}</span>}
              {status === 'lost' && <span className="bdg bdg-dan">{t('outOfGuesses')}</span>}

              {status === 'playing' && (
                <button className="btn-o btn-dan" onClick={giveUp}>
                  {t('game.giveUp')}
                </button>
              )}
            </div>
          </div>

          {/* 搜索输入 */}
          <div style={{ display: 'flex', justifyContent: 'center', flexDirection: 'column', alignItems: 'center' }}>
            <GameSearch
              onGuess={handleGuess}
              disabled={status !== 'playing'}
              guessedIds={guessedIds}
              target={target}
              remainingGuesses={remainingGuesses}
            />
            {guessError && (
              <div className="alert alert-dan">
                ⚠ {guessError}
              </div>
            )}
            {authError && (
              <div className="alert alert-dan" style={{ textAlign: 'center' }}>
                <p>登录已过期，请重新登录后继续游戏</p>
                <button className="btn-p" style={{ marginTop: 10 }} onClick={() => router.push('/')}>
                  返回首页登录
                </button>
              </div>
            )}
          </div>

          {/* 猜测表格（每日挑战固定 hard 难度） */}
          <GuessTable guesses={guesses} target={target} hideRarity flashTrigger={flashTrigger} staggerKey={guesses.length} />

          {guesses.length === 0 && (
            <div className="empty">
              <div className="etx">
                {t('searchHint')}
              </div>
              <div className="ehint">
                {t('remainingGuesses', { count: remainingGuesses })}
              </div>
            </div>
          )}

          {/* 游戏结束后的按钮 */}
          {dialogClosed && (status === 'won' || status === 'lost') && (
            <div className="bar-actions" style={{ justifyContent: 'center' }}>
              <button className="btn-p btn-shine" onClick={() => router.push('/leaderboard?mode=daily')}>🏆 {t('daily.viewLeaderboard')}</button>
              <button className="btn-o" onClick={handleBackToHome}>← {t('game.back')}</button>
            </div>
          )}
        </div>
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
