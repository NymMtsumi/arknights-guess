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
import type { Difficulty } from '@/types/character';

export default function GamePage() {
  const { t } = useI18n();
  const router = useRouter();
  const store = useGameStore();
  const [rulesOpen, setRulesOpen] = useState(false);
  const [dialogClosed, setDialogClosed] = useState(false);

  const { status, target, guesses, remainingGuesses, difficulty, startGame, submitGuess, giveUp, resetGame } = store;

  const guessedIds = useMemo(() => new Set(guesses.map(g => g.character.id)), [guesses]);

  // 游戏结束时保存统计
  const prevStatus = useRef(status);
  useEffect(() => {
    if (prevStatus.current === 'playing' && (status === 'won' || status === 'lost')) {
      saveGameStats(status === 'won', guesses.length, difficulty, target?.name || '');
    }
    prevStatus.current = status;
  }, [status, guesses.length, difficulty, target]);

  const handleStart = (diff: Difficulty) => {
    startGame(diff);
  };

  const handleGuess = (char: import('@/types/character').Character) => {
    submitGuess(char.name);
  };

  const handleClose = () => {
    setDialogClosed(true);
  };

  const handleNewGame = () => {
    setDialogClosed(false);
    startGame(difficulty);
  };

  const handleBackToHome = () => {
    resetGame();
    router.push('/');
  };

  const formatRarity = (r: number) => '★'.repeat(r) + '☆'.repeat(6 - r);

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
            选择难度开始游戏
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
            {status === 'won' && <span style={{ color: 'var(--correct)', fontWeight: 700 }}>🎉 猜对了！</span>}
            {status === 'lost' && <span style={{ color: 'var(--danger)', fontWeight: 700 }}>猜测次数用尽</span>}

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
            />
          </div>

          {/* 猜测表格 */}
          <GuessTable guesses={guesses} target={target} hideRarity={difficulty === 'hard'} />

          {/* 空状态提示 */}
          {guesses.length === 0 && (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-light)' }}>
              <p style={{ fontSize: '1.1rem', marginBottom: '8px' }}>
                输入干员名字开始猜测 👆
              </p>
              <p style={{ fontSize: '0.85rem' }}>
                你有 {remainingGuesses} 次机会
              </p>
            </div>
          )}
        </div>
      </div>

      {/* 胜利/失败弹窗 */}
      {!dialogClosed && (
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
