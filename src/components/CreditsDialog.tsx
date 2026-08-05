'use client';

interface CreditEntry {
  name: string;
  bilibiliUrl: string;
  role?: string;
}

interface CreditsDialogProps {
  open: boolean;
  onClose: () => void;
  type: 'developers' | 'acknowledgements';
}

// 开发者名单
const developers: CreditEntry[] = [
  { name: '若叶家若麦', bilibiliUrl: 'https://b23.tv/9UCMXBn', role: '数据库更新与服务器维护' },
  { name: '_Lutra_', bilibiliUrl: 'https://b23.tv/9um9Aao', role: '账号系统制作者与UI优化' },
];

// 致谢名单
const acknowledgements: CreditEntry[] = [
  { name: '怂皇的一天', bilibiliUrl: 'https://b23.tv/hlrXhSs', role: 'GitHub开源与思路提供' },
  { name: 'Decolv', bilibiliUrl: 'https://b23.tv/N8g9fx3', role: '搜索体验优化' },
];

export function CreditsDialog({ open, onClose, type }: CreditsDialogProps) {
  if (!open) return null;

  const isDev = type === 'developers';
  const entries = isDev ? developers : acknowledgements;
  const title = isDev ? '开发者名单' : '致谢名单';
  const subtitle = isDev
    ? '感谢以下开发者对本项目的贡献'
    : '感谢以下朋友对本项目的支持与帮助';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)' }}>
      <div
        style={{
          background: 'var(--card)',
          padding: '28px',
          borderRadius: 'var(--radius)',
          boxShadow: 'var(--shadow-lg)',
          maxWidth: '440px',
          width: '100%',
          maxHeight: '80vh',
          overflowY: 'auto',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <h2 style={{
            fontFamily: 'var(--font-display)',
            fontSize: '1.3rem',
            fontStyle: 'italic',
            fontWeight: 900,
            margin: 0,
          }}>
            {title}
          </h2>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-light)',
              fontSize: '1.4rem',
              cursor: 'pointer',
              padding: '4px 8px',
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>

        <p style={{ color: 'var(--text-light)', fontSize: '0.9rem', marginBottom: '20px' }}>
          {subtitle}
        </p>

        {/* List */}
        {entries.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {entries.map((entry, i) => (
              <a
                key={i}
                href={entry.bilibiliUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  padding: '10px 14px',
                  background: 'var(--card-soft)',
                  borderRadius: 'var(--radius)',
                  textDecoration: 'none',
                  color: 'var(--text)',
                  border: '1px solid var(--border)',
                  transition: 'border-color 0.2s, background 0.2s',
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.borderColor = 'var(--primary)';
                  e.currentTarget.style.background = 'var(--primary-soft)';
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.borderColor = 'var(--border)';
                  e.currentTarget.style.background = 'var(--card-soft)';
                }}
              >
                <span style={{ fontSize: '1.2rem' }}>🎮</span>
                <span style={{ fontWeight: 700, flex: 1 }}>{entry.name}</span>
                {entry.role && (
                  <span style={{ color: 'var(--text-light)', fontSize: '0.85rem' }}>{entry.role}</span>
                )}
                <span style={{ color: 'var(--primary)', fontSize: '0.8rem' }}>B站</span>
              </a>
            ))}
          </div>
        ) : (
          <div style={{
            textAlign: 'center',
            padding: '40px 20px',
            color: 'var(--text-light)',
          }}>
            <p style={{ fontSize: '3rem', margin: '0 0 12px' }}>🏗️</p>
            <p>名单正在整理中，敬请期待</p>
            <p style={{ fontSize: '0.8rem', marginTop: '8px' }}>List is being compiled, stay tuned</p>
          </div>
        )}
      </div>
    </div>
  );
}
