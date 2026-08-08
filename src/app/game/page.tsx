'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Header } from '@/components/Header';
import { GameSearch } from '@/components/GameSearch';
import { GuessTable } from '@/components/GuessTable';
import { GameEndDialog } from '@/components/GameEndDialog';
import { RulesDialog } from '@/components/RulesDialog';
import { Footer } from '@/components/Footer';
import { useGameStore } from '@/stores/game-store';
import { useI18n } from '@/lib/i18n';
import { saveGameStats } from '@/lib/stats';
import { getServerUrl, getPlayerKey } from '@/lib/auth';
import type { Difficulty } from '@/types/character';

export default function GamePage() {
  const { t } = useI18n();
  const router = useRouter();
  const store = useGameStore();
  const [rulesOpen, setRulesOpen] = useState(false);
  const [dialogClosed, setDialogClosed] = useState(false);
  const [dialogReady, setDialogReady] = useState(false);
  const [flashTrigger, setFlashTrigger] = useState(0);
  const dialogTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { status, target, guesses, remainingGuesses, difficulty, startGame, submitGuess, giveUp, resetGame } = store;

  const guessedIds = useMemo(() => new Set(guesses.map(g => g.character.id)), [guesses]);

  // 游戏结束时保存统计（带 double-fire 保护）
  const prevStatus = useRef(status);
  const savedRef = useRef(false);
  useEffect(() => {
    if (prevStatus.current === 'playing' && (status === 'won' || status === 'lost')) {
      if (!savedRef.current) {
        saveGameStats(status === 'won', guesses.length, difficulty, target?.name || '');
        savedRef.current = true;
      }
      // 猜对：延迟 800ms 再弹出结算窗口，让用户看到金色闪烁
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
      if (dialogTimer.current) { clearTimeout(dialogTimer.current); dialogTimer.current = null; }
    }
    prevStatus.current = status;
    return () => { if (dialogTimer.current) { clearTimeout(dialogTimer.current); dialogTimer.current = null; } };
  }, [status, guesses.length, difficulty, target]);

  // 心跳：告知服务器正在玩单人模式
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

  const handleStart = (diff: Difficulty) => {
    startGame(diff);
  };

  const handleGuess = (char: import('@/types/character').Character) => {
    submitGuess(char.name);
  };

  const handleClose = () => {
    setDialogClosed(true);
    // 关闭弹窗时重新触发猜对行的金色闪烁动画
    setFlashTrigger(t => t + 1);
  };

  const handleNewGame = () => {
    setDialogClosed(false);
    startGame(difficulty);
  };

  const handleBackToHome = () => {
    resetGame();
    router.push('/');
  };

  // 难度选择界面
  if (status === 'idle') {
    return (
      <div className="page">
        <Header />
        <div className="page-scroll" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 'clamp(32px, 6vw, 60px)' }}>
          {/* 标题 */}
          <h1
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 'clamp(2.2rem, 5vw, 3.5rem)',
              fontStyle: 'italic',
              fontWeight: 900,
              letterSpacing: '0.06em',
              marginBottom: '8px',
              textAlign: 'center',
            }}
          >
            {t('menu.classic')}
          </h1>
          <p style={{ color: 'var(--text-light)', marginBottom: 'clamp(24px, 4vw, 40px)', textAlign: 'center', fontSize: 'var(--fs-xs)' }}>
            {t('selectDifficulty')}
          </p>

          {/* 难度卡片 */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))',
            gap: '16px',
            maxWidth: '720px',
            width: '100%',
          }}>
            {(['easy', 'medium', 'hard'] as Difficulty[]).map((diff, i) => (
              <button
                key={diff}
                onClick={() => handleStart(diff)}
                className="menu-card"
                style={{
                  '--menu-color': i === 0 ? 'var(--success)' : i === 1 ? 'var(--primary)' : 'var(--danger)',
                  cursor: 'pointer',
                  border: 'none',
                  textAlign: 'left',
                  width: '100%',
                } as React.CSSProperties}
              >
                <span className="menu-icon">
                  {i === 0 ? '🌱' : i === 1 ? '⚔️' : '💀'}
                </span>
                <span style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <span className="menu-label">{t(`difficulty.${diff}`)}</span>
                  <span className="menu-description">{t(`difficulty.${diff}Desc`)}</span>
                </span>
              </button>
            ))}
          </div>

          {/* 返回首页 + 规则按钮 */}
          <div style={{ marginTop: '24px', display: 'flex', gap: '12px' }}>
            <button
              onClick={handleBackToHome}
              style={{
                padding: '8px 20px',
                background: 'transparent',
                color: 'var(--text-light)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius)',
                cursor: 'pointer',
                fontSize: '0.9rem',
              }}
            >
              {t('game.back')}
            </button>
            <button
              onClick={() => setRulesOpen(true)}
              style={{
                padding: '8px 20px',
                background: 'transparent',
                color: 'var(--accent)',
                border: '1px solid var(--accent)',
                borderRadius: 'var(--radius)',
                cursor: 'pointer',
                fontSize: '0.9rem',
              }}
            >
              {t('menu.rules')}
            </button>
          </div>
        </div>
        <RulesDialog open={rulesOpen} onClose={() => setRulesOpen(false)} />
        <Footer />
      </div>
    );
  }

  // 游戏界面
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
            {/* 剩余次数 */}
            {status === 'playing' && (
              <span style={{
                fontWeight: 700,
                fontSize: '1.1rem',
                color: remainingGuesses <= 3 ? 'var(--danger)' : 'var(--text)',
              }}>
                {remainingGuesses <= 3 && (
                  <span style={{ animation: 'urgent-pulse 1.2s ease-in-out infinite' }}>
                    {t('game.guessesLeft', { count: remainingGuesses })}
                  </span>
                )}
                {remainingGuesses > 3 && t('game.guessesLeft', { count: remainingGuesses })}
              </span>
            )}

            {/* 结束状态提示 */}
            {status === 'won' && <span style={{ color: 'var(--correct)', fontWeight: 700 }}>🎉 {t('guessCorrect')}</span>}
            {status === 'lost' && <span style={{ color: 'var(--danger)', fontWeight: 700 }}>{t('outOfGuesses')}</span>}

            {/* 放弃 */}
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

          {/* 猜测表格 */}
          <GuessTable guesses={guesses} target={target} hideRarity={difficulty === 'hard'} flashTrigger={flashTrigger} staggerKey={guesses.length} />

          {/* 空状态提示 */}
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

        {/* 查看战绩模式：再来一把 */}
        {dialogClosed && (status === 'won' || status === 'lost') && (
          <div style={{ textAlign: 'center', marginTop: '20px' }}>
            <button onClick={handleNewGame} className="btn-shine" style={{
              padding: '12px 32px', background: 'var(--primary)', color: 'var(--bg)',
              border: 'none', borderRadius: 'var(--radius)', fontSize: '1rem',
              fontWeight: 700, cursor: 'pointer',
            }}>🔄 {t('playAgain')}</button>
          </div>
        )}
      </div>

      {/* 胜利/失败弹窗（猜对延迟 800ms，失败立即弹出） */}
      {!dialogClosed && dialogReady && (
        <GameEndDialog
          status={status}
          target={target}
          guessCount={guesses.length}
          onClose={handleClose}
          onNewGame={handleNewGame}
        />
      )}
      <Footer />
    </div>
  );
}
