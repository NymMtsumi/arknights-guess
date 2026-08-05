'use client';

export function Footer() {
  return (
    <footer
      style={{
        textAlign: 'center',
        padding: 'clamp(24px, 4vw, 40px) 0 clamp(16px, 3vw, 24px)',
        color: 'var(--text-light)',
        fontSize: 'var(--fs-2xs)',
      }}
    >
      <span>Made with ❤️ by 若叶家若麦</span>
      <span style={{ margin: '0 8px', color: 'var(--border)' }}>·</span>
      <span>Based on PRTS data & Friberg open-source project</span>
    </footer>
  );
}
