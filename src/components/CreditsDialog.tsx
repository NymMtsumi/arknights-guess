'use client';

import { useI18n } from '@/lib/i18n';

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
  const { t } = useI18n();

  if (!open) return null;

  const isDev = type === 'developers';
  const entries = isDev ? developers : acknowledgements;
  const title = isDev ? t('credits.developersTitle') : t('credits.acknowledgementsTitle');
  const subtitle = isDev
    ? t('credits.developersSubtitle')
    : t('credits.acknowledgementsSubtitle');

  return (
    <div className="modal-mask">
      <div className="dlg mc sm">
        <div className="mdl">
          {/* Header */}
          <div className="mhd">
            <h2>{title}</h2>
            <button onClick={onClose} className="x">
              ✕
            </button>
          </div>

          <p className="sec-note">{subtitle}</p>

          {/* List */}
          {entries.length > 0 ? (
            <div>
              {entries.map((entry, i) => (
                <a
                  key={i}
                  href={entry.bilibiliUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="dev"
                >
                  <span>🎮</span>
                  <div>
                    <div className="dn">{entry.name}</div>
                    {entry.role && <div className="dr">{entry.role}</div>}
                  </div>
                  <span className="bdg bdg-mc ml-auto">{t('credits.bilibiliLabel')}</span>
                </a>
              ))}
            </div>
          ) : (
            <div className="empty">
              <div className="emoj">🏗️</div>
              <p className="etx">{t('credits.emptyTitle')}</p>
              <p className="ehint">{t('credits.emptySubtitle')}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
