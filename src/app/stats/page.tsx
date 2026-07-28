'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { useI18n } from '@/lib/i18n';
import type { StatsData, GameRecord } from '@/lib/stats';
import { loadStats, loadHistory } from '@/lib/stats';

const DIFF_LABEL: Record<string, string> = { easy: '简单', medium: '普通', hard: '困难' };

export default function StatsPage() {
  const { t } = useI18n();
  const router = useRouter();
  // 直接读取localStorage，每次渲染都是最新数据
  const [mounted, setMounted] = useState(false);
  const [stats, setStats] = useState<StatsData>({ totalGames: 0, wins: 0, losses: 0, totalGuesses: 0, bestScore: 0 });
  const [history, setHistory] = useState<GameRecord[]>([]);

  useEffect(() => {
    setStats(loadStats());
    setHistory(loadHistory());
    setMounted(true);
  }, []);

  // 手动刷新函数
  const refresh = () => {
    setStats(loadStats());
    setHistory(loadHistory());
  };

  const winRate = stats.totalGames > 0 ? Math.round((stats.wins / stats.totalGames) * 100) : 0;
  const avgGuesses = stats.wins > 0 ? (stats.totalGuesses / stats.wins).toFixed(1) : '-';

  const thStyle: React.CSSProperties = { padding: '8px 10px', textAlign: 'center', fontWeight: 700, fontSize: '0.8rem', color: 'var(--text-light)', borderBottom: '2px solid var(--border)', whiteSpace: 'nowrap' };
  const tdStyle: React.CSSProperties = { padding: '8px 10px', textAlign: 'center', whiteSpace: 'nowrap' };

  return (
    <div className="page">
      <Header />
      <div className="page-scroll" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 'clamp(32px, 6vw, 60px)' }}>
        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 'clamp(2rem, 4vw, 3rem)',
            fontStyle: 'italic',
            fontWeight: 900,
            letterSpacing: '0.06em',
            marginBottom: '32px',
            textAlign: 'center',
          }}
        >
          {t('stats.title')}
        </h1>

        {/* 手动刷新 */}
        <button onClick={refresh} style={{
          marginBottom: '20px', padding: '4px 14px', background: 'transparent',
          color: 'var(--text-light)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius)', cursor: 'pointer', fontSize: '0.8rem',
        }}>
          🔄 刷新数据
        </button>

        {!mounted ? (
          <div style={{ color: 'var(--text-light)' }}>...</div>
        ) : stats.totalGames === 0 ? (
          <div style={{ textAlign: 'center', color: 'var(--text-light)' }}>
            <p style={{ fontSize: '3rem', marginBottom: '16px' }}>📭</p>
            <p style={{ fontSize: '1.1rem' }}>{t('stats.noData')}</p>
            <button
              onClick={() => router.push('/game')}
              style={{
                marginTop: '20px',
                padding: '10px 24px',
                background: 'var(--primary)',
                color: 'var(--bg)',
                border: 'none',
                borderRadius: 'var(--radius)',
                fontWeight: 700,
                cursor: 'pointer',
                fontSize: '1rem',
              }}
            >
              {t('menu.classic')}
            </button>
          </div>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: '16px',
            maxWidth: '600px',
            width: '100%',
          }}>
            {[
              { label: t('stats.totalGames'), value: String(stats.totalGames), icon: '🎮' },
              { label: t('stats.wins'), value: String(stats.wins), icon: '🏆' },
              { label: t('stats.losses'), value: String(stats.losses), icon: '💔' },
              { label: t('stats.winRate'), value: `${winRate}%`, icon: '📈' },
              { label: t('stats.avgGuesses'), value: String(avgGuesses), icon: '📊' },
              { label: t('stats.bestScore'), value: stats.bestScore > 0 ? `${stats.bestScore} 次` : '-', icon: '⭐' },
            ].map(item => (
              <div
                key={item.label}
                className="menu-card"
                style={{
                  '--menu-color': 'var(--accent)',
                  textAlign: 'center',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '20px',
                  minHeight: 'auto',
                } as React.CSSProperties}
              >
                <span style={{ fontSize: '2rem' }}>{item.icon}</span>
                <span style={{ fontSize: 'clamp(1.5rem, 3vw, 2rem)', fontWeight: 900, color: 'var(--text)' }}>
                  {item.value}
                </span>
                <span style={{ fontSize: '0.85rem', color: 'var(--text-light)' }}>{item.label}</span>
              </div>
            ))}
          </div>
        )}

        {/* 最近战绩 - 始终显示 */}
        {mounted && (
          <div style={{ maxWidth: '600px', width: '100%', marginTop: '32px' }}>
            <h2 style={{
              fontFamily: 'var(--font-display)',
              fontSize: 'clamp(1.2rem, 2vw, 1.5rem)',
              fontStyle: 'italic',
              fontWeight: 800,
              letterSpacing: '0.04em',
              marginBottom: '14px',
              color: 'var(--text)',
            }}>
              📋 最近 20 局
            </h2>
            {history.length === 0 ? (
              <p style={{ color: 'var(--text-light)', fontSize: '0.9rem' }}>暂无记录，完成一局游戏后自动记录</p>
            ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="game-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                <thead>
                  <tr>
                    <th style={thStyle}>#</th>
                    <th style={thStyle}>目标</th>
                    <th style={thStyle}>结果</th>
                    <th style={thStyle}>次数</th>
                    <th style={thStyle}>难度</th>
                    <th style={thStyle}>时间</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((rec, i) => (
                    <tr key={rec.timestamp} style={{
                      background: rec.won ? 'var(--primary-soft)' : 'transparent',
                      borderBottom: '1px solid var(--border)',
                    }}>
                      <td style={tdStyle}>{i + 1}</td>
                      <td style={{ ...tdStyle, fontWeight: 600 }}>{rec.targetName}</td>
                      <td style={{ ...tdStyle, color: rec.won ? 'var(--correct)' : 'var(--danger)', fontWeight: 700 }}>
                        {rec.won ? '✅' : '❌'}
                      </td>
                      <td style={tdStyle}>{rec.guessCount}</td>
                      <td style={tdStyle}>{DIFF_LABEL[rec.difficulty] || rec.difficulty}</td>
                      <td style={{ ...tdStyle, color: 'var(--text-light)', fontSize: '0.78rem' }}>
                        {new Date(rec.timestamp).toLocaleDateString('zh-CN')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            )}
          </div>
        )}

        <button
          onClick={() => router.push('/')}
          style={{
            marginTop: '28px',
            padding: '8px 20px',
            background: 'transparent',
            color: 'var(--text-light)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            cursor: 'pointer',
          }}
        >
          {t('game.back')}
        </button>
        <Footer />
      </div>
    </div>
  );
}
