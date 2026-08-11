'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Header } from '@/components/Header';
import { GameSearch } from '@/components/GameSearch';
import { GuessTable } from '@/components/GuessTable';
import { GameEndDialog } from '@/components/GameEndDialog';
import { RulesDialog } from '@/components/RulesDialog';
import { Footer } from '@/components/Footer';
import { ScrollSlider } from '@/components/ScrollSlider';
import { useGameStore } from '@/stores/game-store';
import { useEnemyStore } from '@/stores/enemy-store';
import { searchEnemies } from '@/lib/enemy-engine';
import { useI18n } from '@/lib/i18n';
import { saveGameStats } from '@/lib/stats';
import { getServerUrl, getPlayerKey } from '@/lib/auth';
import enemiesData from '@/data/enemy-characters.json';
import type { Difficulty } from '@/types/character';
import type { Enemy, EnemyDifficulty, EnemyGuessComparisons, GuessStatus } from '@/types/enemy';

const enemies = enemiesData as Enemy[];

type GameMode = 'operator' | 'enemy';

const DIFFICULTY_GUESSES: Record<EnemyDifficulty, number> = { easy: 15, normal: 15, hard: 15 };

const RATING_STYLE: Record<GuessStatus, { bg: string; color: string }> = {
  correct: { bg: 'var(--correct)', color: '#fff' },
  close: { bg: 'var(--close)', color: '#fff' },
  wrong: { bg: 'var(--card-soft)', color: 'var(--text-light)' },
};

const ENEMY_COLUMNS: { key: keyof EnemyGuessComparisons | 'name'; label: string; wide?: boolean }[] = [
  { key: 'name', label: '名称', wide: true },
  { key: 'race', label: '种类', wide: true },
  { key: 'level', label: '地位' },
  { key: 'attackType', label: '攻击方式', wide: true },
  { key: 'damageType', label: '伤害类型', wide: true },
  { key: 'motion', label: '行动方式' },
  { key: 'endure', label: '生命值' },
  { key: 'attack', label: '攻击力' },
  { key: 'defence', label: '防御力' },
  { key: 'moveSpeed', label: '移速' },
  { key: 'attackSpeed', label: '攻速' },
  { key: 'resistance', label: '法抗' },
];

function getEnemyDisplayValue(enemy: Enemy, key: keyof EnemyGuessComparisons): string {
  const map: Record<string, string> = {
    race: enemy.race, level: enemy.level, attackType: enemy.attackType,
    damageType: enemy.damageType, motion: enemy.motion, endure: enemy.endure,
    attack: enemy.attack, defence: enemy.defence, moveSpeed: enemy.moveSpeed,
    attackSpeed: enemy.attackSpeed, resistance: enemy.resistance,
  };
  return map[key] || '';
}

function estimateTextWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    if (ch === ' ') { w += 4; }
    else if (/[一-鿿　-〿＀-￯★]/.test(ch)) { w += 14; }
    else { w += 8; }
  }
  return w;
}

function computeEnemyColWidths(guesses: { enemy: Enemy }[]): number[] {
  const widths = ENEMY_COLUMNS.map(col => estimateTextWidth(col.label) + 28);
  for (const g of guesses) {
    for (let i = 0; i < ENEMY_COLUMNS.length; i++) {
      const col = ENEMY_COLUMNS[i];
      const text = col.key === 'name' ? g.enemy.name : getEnemyDisplayValue(g.enemy, col.key as keyof EnemyGuessComparisons);
      const w = estimateTextWidth(text) + 28;
      if (w > widths[i]) widths[i] = w;
    }
  }
  return widths;
}

export default function GamePage() {
  const { t } = useI18n();
  const router = useRouter();

  // Operator store
  const opStore = useGameStore();
  // Enemy store
  const enStore = useEnemyStore();

  const [gameMode, setGameMode] = useState<GameMode>('operator');
  const [rulesOpen, setRulesOpen] = useState(false);
  const [dialogClosed, setDialogClosed] = useState(false);
  const [dialogReady, setDialogReady] = useState(false);
  const [flashTrigger, setFlashTrigger] = useState(0);
  const dialogTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Enemy search state
  const [enemyQuery, setEnemyQuery] = useState('');
  const [enemySuggestions, setEnemySuggestions] = useState<Enemy[]>([]);
  const [enemyDropdown, setEnemyDropdown] = useState(false);
  const [enemySelIdx, setEnemySelIdx] = useState(-1);
  const enemyInputRef = useRef<HTMLInputElement>(null);
  const enemyDropdownRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Determine which store is active
  const isEnemy = gameMode === 'enemy';
  const status = isEnemy ? enStore.status : opStore.status;
  const target = isEnemy ? enStore.target : opStore.target;
  const guesses = isEnemy ? enStore.guesses : opStore.guesses;
  const remainingGuesses = isEnemy ? enStore.remainingGuesses : opStore.remainingGuesses;
  const difficulty = isEnemy ? enStore.difficulty : opStore.difficulty;

  const guessedIds: Set<number | string> = useMemo(() => {
    if (isEnemy) {
      return new Set<number | string>((guesses as typeof enStore.guesses).map((g: { enemy: Enemy }) => g.enemy.id));
    }
    return new Set<number | string>((guesses as typeof opStore.guesses).map((g: { character: { id: string } }) => g.character.id));
  }, [guesses, isEnemy]);

  // Enemy search
  const handleEnemyQueryChange = (val: string) => {
    setEnemyQuery(val);
    if (val.trim()) {
      setEnemySuggestions(searchEnemies(enemies, val).filter(e => !guessedIds.has(e.id)));
      setEnemyDropdown(true);
      setEnemySelIdx(-1);
    } else {
      setEnemySuggestions([]);
      setEnemyDropdown(false);
    }
  };

  const selectEnemy = (enemy: Enemy) => {
    setEnemyQuery('');
    setEnemyDropdown(false);
    if (enStore.status !== 'playing') return;
    enStore.submitGuess(enemy.name);
  };

  const handleEnemyKey = (e: React.KeyboardEvent) => {
    if (!enemyDropdown || enemySuggestions.length === 0) {
      if (e.key === 'Enter' && enemyQuery.trim()) {
        const found = searchEnemies(enemies, enemyQuery).filter(en => !guessedIds.has(en.id));
        if (found.length > 0) selectEnemy(found[0]);
      }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setEnemySelIdx(i => Math.min(i + 1, enemySuggestions.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setEnemySelIdx(i => Math.max(i - 1, -1)); }
    else if (e.key === 'Enter' && enemySelIdx >= 0) { e.preventDefault(); selectEnemy(enemySuggestions[enemySelIdx]); }
    else if (e.key === 'Escape') { setEnemyDropdown(false); }
  };

  // Click outside enemy dropdown
  useEffect(() => {
    if (!enemyDropdown) return;
    const handler = (e: MouseEvent) => {
      if (enemyDropdownRef.current && !enemyDropdownRef.current.contains(e.target as Node)) {
        setEnemyDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [enemyDropdown]);

  // Save game stats (operator mode only — enemy mode is not saved)
  const prevStatus = useRef(status);
  const savedRef = useRef(false);
  useEffect(() => {
    if (prevStatus.current === 'playing' && (status === 'won' || status === 'lost')) {
      if (!savedRef.current && !isEnemy) {
        saveGameStats(status === 'won', guesses.length, difficulty, (target as { name?: string })?.name || '');
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
      if (dialogTimer.current) { clearTimeout(dialogTimer.current); dialogTimer.current = null; }
    }
    prevStatus.current = status;
    return () => { if (dialogTimer.current) { clearTimeout(dialogTimer.current); dialogTimer.current = null; } };
  }, [status, guesses.length, difficulty, target, isEnemy]);

  // Heartbeat (operator mode only)
  useEffect(() => {
    if (status !== 'playing' || isEnemy) return;
    const ac = new AbortController();
    const send = () => {
      const pk = getPlayerKey();
      if (!pk) return;
      fetch(`${getServerUrl()}/api/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerKey: pk }),
        signal: ac.signal,
      }).catch(() => {});
    };
    send();
    const interval = setInterval(send, 30_000);
    return () => { clearInterval(interval); ac.abort(); };
  }, [status, isEnemy]);

  // Operator handlers
  const handleOpStart = (diff: Difficulty) => { opStore.startGame(diff); };
  const handleOpGuess = (char: import('@/types/character').Character) => { opStore.submitGuess(char.name); };
  const handleOpGiveUp = () => { opStore.giveUp(); };

  // Enemy handlers
  const handleEnStart = (diff: EnemyDifficulty) => { enStore.startGame(diff); };
  const handleEnGiveUp = () => { enStore.giveUp(); };

  const handleClose = () => {
    setDialogClosed(true);
    setFlashTrigger(t => t + 1);
  };

  const handleNewGame = () => {
    setDialogClosed(false);
    if (isEnemy) {
      enStore.startGame(enStore.difficulty);
    } else {
      opStore.startGame(opStore.difficulty);
    }
  };

  const handleBackToHome = () => {
    opStore.resetGame();
    enStore.reset();
    router.push('/');
  };

  const switchMode = (mode: GameMode) => {
    if (status === 'playing') return; // can't switch mid-game
    setGameMode(mode);
    opStore.resetGame();
    enStore.reset();
    setDialogClosed(false);
    setEnemyQuery('');
    setEnemyDropdown(false);
  };

  // Enemy column widths
  const enemyColWidths = useMemo(
    () => isEnemy ? computeEnemyColWidths(guesses as typeof enStore.guesses) : [],
    [guesses, isEnemy]
  );
  const enemyTotalW = enemyColWidths.reduce((a: number, b: number) => a + b, 0);
  const enemyColPcts = enemyColWidths.map((w: number) => `${(w / Math.max(enemyTotalW, 1)) * 100}%`);

  // ===== IDLE SCREEN: Mode selection + Difficulty =====
  if (status === 'idle') {
    return (
      <div className="page">
        <Header />
        <div className="page-scroll" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 'clamp(32px, 6vw, 60px)' }}>
          {/* Mode toggle */}
          <div style={{
            display: 'flex', gap: '0', marginBottom: 'clamp(20px, 3vw, 32px)',
            background: 'var(--card-soft)', borderRadius: 'var(--radius)',
            border: '1px solid var(--border)', overflow: 'hidden',
          }}>
            <button
              onClick={() => switchMode('operator')}
              style={{
                padding: '10px 28px', border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: '0.95rem',
                background: gameMode === 'operator' ? 'var(--primary)' : 'transparent',
                color: gameMode === 'operator' ? 'var(--bg)' : 'var(--text-light)',
                transition: 'all 0.2s',
              }}
            >
              🎯 {t('menu.classic')}
            </button>
            <button
              onClick={() => switchMode('enemy')}
              style={{
                padding: '10px 28px', border: 'none', cursor: 'pointer', fontWeight: 700, fontSize: '0.95rem',
                background: gameMode === 'enemy' ? 'var(--primary)' : 'transparent',
                color: gameMode === 'enemy' ? 'var(--bg)' : 'var(--text-light)',
                transition: 'all 0.2s',
              }}
            >
              ⚔️ 敌方猜谜
            </button>
          </div>

          {/* Title & description */}
          <h1 style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'clamp(2.2rem, 5vw, 3.5rem)',
            fontStyle: 'italic', fontWeight: 900,
            letterSpacing: '0.06em', marginBottom: '8px', textAlign: 'center',
          }}>
            {isEnemy ? '⚔️ 敌方单位猜谜' : t('menu.classic')}
          </h1>
          <p style={{ color: 'var(--text-light)', marginBottom: 'clamp(24px, 4vw, 40px)', textAlign: 'center', fontSize: 'var(--fs-xs)' }}>
            {isEnemy ? '基于 PRTS 数据 · 1674 个敌方单位 · 11 个属性维度' : t('selectDifficulty')}
          </p>

          {/* Difficulty cards */}
          {!isEnemy ? (
            // Operator difficulties
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))',
              gap: '16px', maxWidth: '720px', width: '100%',
            }}>
              {(['easy', 'medium', 'hard'] as Difficulty[]).map((diff, i) => (
                <button key={diff} onClick={() => handleOpStart(diff)} className="menu-card" style={{
                  '--menu-color': i === 0 ? 'var(--success)' : i === 1 ? 'var(--primary)' : 'var(--danger)',
                  cursor: 'pointer', border: 'none', textAlign: 'left', width: '100%',
                } as React.CSSProperties}>
                  <span className="menu-icon">{i === 0 ? '🌱' : i === 1 ? '⚔️' : '💀'}</span>
                  <span style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <span className="menu-label">{t(`difficulty.${diff}`)}</span>
                    <span className="menu-description">{t(`difficulty.${diff}Desc`)}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            // Enemy difficulties
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))',
              gap: '16px', maxWidth: '780px', width: '100%',
            }}>
              {([
                { key: 'easy' as EnemyDifficulty, label: '简单', color: '#4caf50', pool: '230 个领袖', guesses: 15, icon: '🌱' },
                { key: 'normal' as EnemyDifficulty, label: '普通', color: '#ff9800', pool: '938 个领袖+精英', guesses: 15, icon: '⚔️' },
                { key: 'hard' as EnemyDifficulty, label: '困难', color: '#f44336', pool: '1674 个全部单位', guesses: 15, icon: '💀' },
              ]).map(d => (
                <button key={d.key} onClick={() => handleEnStart(d.key)} className="menu-card" style={{
                  '--menu-color': d.color, cursor: 'pointer', border: 'none', textAlign: 'left', width: '100%',
                } as React.CSSProperties}>
                  <span className="menu-icon">{d.icon}</span>
                  <span style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <span className="menu-label">{d.label}</span>
                    <span className="menu-description">{d.pool} · {d.guesses} 次猜测</span>
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* Back + Rules buttons */}
          <div style={{ marginTop: '24px', display: 'flex', gap: '12px' }}>
            <button onClick={handleBackToHome} style={{
              padding: '8px 20px', background: 'transparent', color: 'var(--text-light)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius)', cursor: 'pointer', fontSize: '0.9rem',
            }}>
              {t('game.back')}
            </button>
            <button onClick={() => setRulesOpen(true)} style={{
              padding: '8px 20px', background: 'transparent', color: 'var(--accent)',
              border: '1px solid var(--accent)', borderRadius: 'var(--radius)', cursor: 'pointer', fontSize: '0.9rem',
            }}>
              {t('menu.rules')}
            </button>
          </div>
        </div>
        <RulesDialog open={rulesOpen} onClose={() => setRulesOpen(false)} />
        <Footer />
      </div>
    );
  }

  // ===== PLAYING/WON/LOST SCREEN =====
  return (
    <div className="page">
      <Header />
      <div className="page-scroll" style={{ paddingTop: 'clamp(16px, 2vw, 24px)' }}>
        {/* Status bar */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap',
          gap: '12px', marginBottom: '20px', maxWidth: 'var(--content-max)', margin: '0 auto 20px',
        }}>
          <button onClick={handleBackToHome} style={{
            padding: '6px 14px', background: 'transparent', color: 'var(--text-light)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius)', cursor: 'pointer', fontSize: '0.85rem',
          }}>
            ← {t('game.back')}
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            {/* Mode badge */}
            <span style={{
              fontWeight: 700, fontSize: '0.8rem', color: 'var(--primary)',
              background: 'var(--card-soft)', padding: '4px 10px', borderRadius: 'var(--radius)',
              border: '1px solid var(--primary)',
            }}>
              {isEnemy ? '⚔️ 敌方' : '🎯 干员'}
            </span>

            {status === 'playing' && (
              <span style={{
                fontWeight: 700, fontSize: '1.1rem',
                color: remainingGuesses <= 3 ? 'var(--danger)' : 'var(--text)',
              }}>
                {remainingGuesses <= 3 ? (
                  <span style={{ animation: 'urgent-pulse 1.2s ease-in-out infinite' }}>
                    {t('game.guessesLeft', { count: remainingGuesses })}
                  </span>
                ) : (
                  t('game.guessesLeft', { count: remainingGuesses })
                )}
              </span>
            )}

            {status === 'won' && <span style={{ color: 'var(--correct)', fontWeight: 700 }}>🎉 {t('guessCorrect')}</span>}
            {status === 'lost' && <span style={{ color: 'var(--danger)', fontWeight: 700 }}>{t('outOfGuesses')}</span>}

            {status === 'playing' && (
              <button
                onClick={isEnemy ? handleEnGiveUp : handleOpGiveUp}
                style={{
                  padding: '6px 14px', background: 'transparent', color: 'var(--danger)',
                  border: '1px solid var(--danger)', borderRadius: 'var(--radius)', cursor: 'pointer', fontSize: '0.85rem',
                }}
              >
                {t('game.giveUp')}
              </button>
            )}
          </div>
        </div>

        {/* Search input */}
        <div style={{ maxWidth: 'var(--content-max)', margin: '0 auto' }}>
          {!isEnemy ? (
            // Operator search
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <GameSearch
                onGuess={handleOpGuess}
                disabled={status !== 'playing'}
                guessedIds={guessedIds as Set<string>}
                target={target as import('@/types/character').Character | null}
                remainingGuesses={remainingGuesses}
              />
            </div>
          ) : (
            // Enemy search
            <div style={{ display: 'flex', justifyContent: 'center', position: 'relative', marginBottom: '20px' }}>
              <input
                ref={enemyInputRef}
                type="text"
                value={enemyQuery}
                onChange={e => handleEnemyQueryChange(e.target.value)}
                onKeyDown={handleEnemyKey}
                placeholder="输入敌方单位名称..."
                disabled={status !== 'playing'}
                style={{
                  width: '100%', maxWidth: '500px', padding: '12px 16px', fontSize: '1rem',
                  border: '1px solid var(--border)', borderRadius: 'var(--radius)',
                  background: 'var(--input-bg)', color: 'var(--text)', outline: 'none',
                  opacity: status !== 'playing' ? 0.5 : 1,
                  transition: 'border-color 0.2s',
                }}
              />
              {enemyDropdown && enemySuggestions.length > 0 && (
                <div ref={enemyDropdownRef} style={{
                  position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)',
                  width: '100%', maxWidth: '500px', maxHeight: '300px', overflowY: 'auto',
                  background: 'var(--card)', border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)', zIndex: 50, boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
                  marginTop: '4px',
                }}>
                  {enemySuggestions.map((e, i) => (
                    <div key={e.id} onClick={() => selectEnemy(e)} style={{
                      padding: '10px 16px', cursor: 'pointer',
                      background: i === enemySelIdx ? 'var(--card-soft)' : 'transparent',
                      borderBottom: '1px solid var(--border)',
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    }}>
                      <span style={{ fontWeight: 600 }}>{e.name}</span>
                      <span style={{ fontSize: '0.8rem', color: 'var(--text-light)' }}>{e.race} · {e.level}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Guess table */}
          {!isEnemy ? (
            // Operator table
            <GuessTable
              guesses={guesses as typeof opStore.guesses}
              target={target as import('@/types/character').Character | null}
              hideRarity={difficulty === 'hard'}
              flashTrigger={flashTrigger}
              staggerKey={guesses.length}
            />
          ) : (
            // Enemy table — optimized 12-column layout
            <div style={{ marginTop: '4px' }}>
              <div ref={scrollRef} style={{ overflowX: 'auto', scrollBehavior: 'smooth' }} className="scroll-slider-container">
                <table style={{
                  width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse',
                  fontSize: '0.82rem', minWidth: `${Math.max(enemyTotalW, 700)}px`,
                }}>
                  <thead>
                    <tr>
                      {ENEMY_COLUMNS.map((col, i) => (
                        <th key={col.key} style={{
                          width: enemyColPcts[i] || undefined,
                          padding: '8px 4px', borderBottom: '2px solid var(--border)',
                          color: 'var(--text-light)', fontWeight: 700, textAlign: 'center',
                          fontSize: '0.78rem', whiteSpace: 'nowrap',
                        }}>
                          {col.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(guesses as typeof enStore.guesses).slice().reverse().map((g, i) => (
                      <tr key={i} style={{ animation: 'rowSlide 0.3s ease-out' }}>
                        {ENEMY_COLUMNS.map(col => {
                          if (col.key === 'name') {
                            const isCorrect = target && g.enemy.id === (target as Enemy).id;
                            return (
                              <td key={col.key} style={{
                                padding: '8px 6px', borderBottom: '1px solid var(--border)',
                                textAlign: 'center', fontWeight: 600, fontSize: '0.82rem',
                                background: isCorrect ? 'var(--correct)' : undefined,
                                color: isCorrect ? '#fff' : 'var(--text)',
                              }}>
                                {g.enemy.name}
                              </td>
                            );
                          }
                          const key = col.key as keyof EnemyGuessComparisons;
                          const s = g.comparisons[key];
                          const sty = RATING_STYLE[s] || RATING_STYLE.wrong;
                          return (
                            <td key={col.key} style={{
                              padding: '4px 2px', borderBottom: '1px solid var(--border)', textAlign: 'center',
                            }}>
                              <span style={{
                                display: 'inline-block', padding: '2px 6px', borderRadius: '3px',
                                background: sty.bg, color: sty.color, fontSize: '0.75rem', fontWeight: 700,
                                whiteSpace: 'nowrap',
                              }}>
                                {getEnemyDisplayValue(g.enemy, key)}
                              </span>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ScrollSlider containerRef={scrollRef} />
              {guesses.length === 0 && (
                <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-light)' }}>
                  <p style={{ fontSize: '1.1rem', marginBottom: '8px' }}>输入敌方单位名称开始猜测</p>
                  <p style={{ fontSize: '0.85rem' }}>{t('remainingGuesses', { count: remainingGuesses })}</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* End state — replay button */}
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

      {/* End dialog */}
      {!dialogClosed && dialogReady && (status === 'won' || status === 'lost') && (
        <GameEndDialog
          status={status as 'won' | 'lost'}
          target={target as import('@/types/character').Character | null}
          guessCount={guesses.length}
          onClose={handleClose}
          onNewGame={handleNewGame}
        />
      )}
      <Footer />
    </div>
  );
}
