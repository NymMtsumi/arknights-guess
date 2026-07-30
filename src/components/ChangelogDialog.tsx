'use client';

interface ChangelogDialogProps {
  open: boolean;
  onClose: () => void;
}

const changelog = [
  { date: '2026-07-29', items: [
    '难度曲线重做：简单=热门+六星(150个)，普通=全部，困难=隐藏星级',
    '防连庄：最近5局不重复出现同一干员',
    '战绩历史扩展至最近80局',
    '阵营系统重构：统一 主阵营,子阵营 格式',
    '阵营匹配优化：同主阵营不同子阵营标黄',
    '首页新增更新日志弹窗',
    '首页描述文案更新',
  ]},
];

export function ChangelogDialog({ open, onClose }: ChangelogDialogProps) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        className="relative max-w-lg w-full max-h-[80vh] overflow-y-auto p-6 rounded-lg"
        style={{
          background: 'var(--card)',
          color: 'var(--text)',
          boxShadow: 'var(--shadow-lg)',
          border: '1px solid var(--border)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute top-3 right-3 text-[var(--text-light)] hover:text-[var(--text)] text-xl leading-none"
        >
          ✕
        </button>

        <h2
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: '1.5rem',
            fontStyle: 'italic',
            fontWeight: 900,
            letterSpacing: '0.06em',
            color: 'var(--primary)',
            marginBottom: '20px',
          }}
        >
          📋 更新日志
        </h2>

        {changelog.map((entry) => (
          <div key={entry.date} style={{ marginBottom: '18px' }}>
            <div style={{
              fontSize: '0.82rem',
              fontWeight: 700,
              color: 'var(--text-light)',
              marginBottom: '6px',
              borderBottom: '1px solid var(--border)',
              paddingBottom: '4px',
            }}>
              {entry.date}
            </div>
            <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '0.9rem', lineHeight: 1.7, color: 'var(--text-sec)' }}>
              {entry.items.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
