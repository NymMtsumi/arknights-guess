'use client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html>
      <body style={{
        margin: 0, padding: 0, fontFamily: 'system-ui, sans-serif',
        background: '#0a0a0f', color: '#e0e0e0',
      }}>
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          minHeight: '100vh', padding: '2rem', textAlign: 'center',
        }}>
          <h1 style={{ fontSize: '2rem', marginBottom: '1rem' }}>发生了严重错误</h1>
          <p style={{ color: '#888', marginBottom: '1.5rem', maxWidth: '400px' }}>
            {error.message || '应用遇到了意外错误，请尝试刷新页面。'}
          </p>
          <button
            onClick={reset}
            style={{
              padding: '10px 24px', borderRadius: '8px', border: 'none',
              background: '#2563eb', color: '#fff', cursor: 'pointer',
              fontSize: '1rem', fontWeight: 600,
            }}
          >
            刷新页面
          </button>
        </div>
      </body>
    </html>
  );
}
