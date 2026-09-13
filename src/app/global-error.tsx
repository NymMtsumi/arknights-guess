'use client';

// global-error 会**替换整个根布局**，所以 globals.css / v12-components.css 里的
// 自定义属性在这里不保证可用 —— 全部用字面量写死（沿用原实现的策略）。
//
// 配色取自 V12 暗色（blast）令牌，见 v12.css 第 5.2 节与 v12-components.css :root：
//   --bg #0e1a1d / --text #e8f1ef / --text-light #7e9c9b
//   --col-single #2fc8bf / --primary-ink #04231f
// 按钮的 padding / 圆角 / 字号字重逐项对齐 .btn-p（v12-components.css:276）。
// 这里刻意不读主题：本组件不知道用户选的是浅色还是暗色，写死暗色与原实现一致。
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
        margin: 0, padding: 0,
        fontFamily: "'Microsoft YaHei UI', 'Source Han Sans SC', 'Noto Sans SC', 'PingFang SC', system-ui, sans-serif",
        background: '#0e1a1d', color: '#e8f1ef',
      }}>
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          minHeight: '100vh', padding: '2rem', textAlign: 'center',
        }}>
          <h1 style={{ fontSize: '2rem', marginBottom: '1rem' }}>发生了严重错误</h1>
          <p style={{ color: '#7e9c9b', marginBottom: '1.5rem', maxWidth: '400px' }}>
            {error.message || '应用遇到了意外错误，请尝试刷新页面。'}
          </p>
          <button
            onClick={reset}
            style={{
              padding: '10px 20px', borderRadius: '12px', border: '1px solid transparent',
              background: '#2fc8bf', color: '#04231f', cursor: 'pointer',
              fontSize: '13px', fontWeight: 700, fontFamily: 'inherit',
            }}
          >
            刷新页面
          </button>
        </div>
      </body>
    </html>
  );
}
