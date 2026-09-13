'use client';

// V12 换肤：形态一字未动（居中标题 + 消息 + 重试按钮），只把内联的字面量换成
// 设计语言的令牌与共享按钮类。稿子没有覆盖错误页，所以这里**不新造形态**。
//
// 外面包 .page / .page-scroll 是必需的，不是装饰：layout.tsx 把 V12 氛围层
// （.aurora / .grid-lines / .motes）挂在 <body> 顶层，fixed + z-index:0；
// 内容根不提权就会被盖住 —— v12-components.css 第 17 节用
// `.ui-v12 .page { position: relative; z-index: 1 }` 提权。
// 原来的实现没有这层包裹，属于既有的被遮挡缺陷，顺手修掉。
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="page">
      <div
        className="page-scroll"
        style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          textAlign: 'center',
        }}
      >
        <h2 style={{
          fontFamily: 'var(--f-cn)', fontSize: '1.5rem', fontWeight: 700,
          color: 'var(--text)', marginBottom: '1rem',
        }}>
          出错了
        </h2>
        <p style={{ color: 'var(--text-3)', marginBottom: '1.5rem', maxWidth: '400px' }}>
          {error.message || '页面遇到了意外错误，请尝试刷新。'}
        </p>
        <button onClick={reset} className="btn-p">
          重试
        </button>
      </div>
    </div>
  );
}
