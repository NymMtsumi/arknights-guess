'use client';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      minHeight: '60vh', padding: '2rem', textAlign: 'center',
    }}>
      <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem', marginBottom: '1rem' }}>
        出错了
      </h2>
      <p style={{ color: 'var(--text-light)', marginBottom: '1.5rem', maxWidth: '400px' }}>
        {error.message || '页面遇到了意外错误，请尝试刷新。'}
      </p>
      <button
        onClick={reset}
        style={{
          padding: '10px 24px', borderRadius: '8px', border: 'none',
          background: 'var(--accent)', color: '#fff', cursor: 'pointer',
          fontSize: '1rem', fontWeight: 600,
        }}
      >
        重试
      </button>
    </div>
  );
}
