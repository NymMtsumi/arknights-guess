'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { useI18n } from '@/lib/i18n';
import type { StatsData } from '@/lib/stats';
import { loadStats } from '@/lib/stats';

export default function StatsPage() {
  const { t } = useI18n();
  const router = useRouter();
  const [stats, setStats] = useState<StatsData>({ totalGames: 0, wins: 0, losses: 0, totalGuesses: 0, bestScore: 0 });
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setStats(loadStats());
    setMounted(true);
  }, []);

  const winRate = stats.totalGames > 0 ? Math.round((stats.wins / stats.totalGames) * 100) : 0;
  const avgGuesses = stats.wins > 0 ? (stats.totalGuesses / stats.wins).toFixed(1) : '-';

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
