'use client';

import { useI18n } from '@/lib/i18n';

interface RulesDialogProps {
  open: boolean;
  onClose: () => void;
}

export function RulesDialog({ open, onClose }: RulesDialogProps) {
  const { t } = useI18n();

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        className="relative max-w-lg w-full max-h-[85vh] overflow-y-auto p-6 rounded-lg"
        style={{
          background: 'var(--card)',
          color: 'var(--text)',
          boxShadow: 'var(--shadow-lg)',
          border: '1px solid var(--border)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 关闭按钮 */}
        <button
          onClick={onClose}
          className="absolute top-3 right-3 text-[var(--text-light)] hover:text-[var(--text)] text-xl leading-none"
          aria-label="Close"
        >
          ✕
        </button>

        <h2
          className="rules-title text-2xl font-extrabold mb-4 italic tracking-wide"
          style={{
            fontFamily: 'var(--font-display)',
            color: 'var(--primary)',
            letterSpacing: '0.06em',
          }}
        >
          {t('rules.title')}
        </h2>

        <p className="mb-4 text-sm" style={{ color: 'var(--text-sec)' }}>
          {t('rules.intro')}
        </p>

        {/* 如何游戏 */}
        <h3 className="text-lg font-bold mb-2">{t('rules.howTo')}</h3>
        <ol
          className="list-decimal list-inside mb-5 space-y-1 text-sm"
          style={{ color: 'var(--text-sec)' }}
        >
          <li>{t('rules.step1')}</li>
          <li>{t('rules.step2')}</li>
          <li>{t('rules.step3')}</li>
          <li>{t('rules.step4')}</li>
          <li>{t('rules.step5')}</li>
        </ol>

        {/* 颜色含义 */}
        <h3 className="text-lg font-bold mb-2">{t('rules.colors')}</h3>
        <div className="space-y-2 mb-5 text-sm">
          <div className="flex items-center gap-3">
            <span
              className="inline-block w-4 h-4 rounded-sm flex-shrink-0"
              style={{ background: 'var(--correct)' }}
            />
            <span style={{ color: 'var(--correct)' }}><strong>{t('rules.correct')}</strong></span>
            <span style={{ color: 'var(--text-light)' }}>— {t('rules.correctDesc')}</span>
          </div>
          <div className="flex items-center gap-3">
            <span
              className="inline-block w-4 h-4 rounded-sm flex-shrink-0"
              style={{ background: 'var(--close)' }}
            />
            <span style={{ color: 'var(--close)' }}><strong>{t('rules.close')}</strong></span>
            <span style={{ color: 'var(--text-light)' }}>— {t('rules.closeDesc')}</span>
          </div>
          <div className="flex items-center gap-3">
            <span
              className="inline-block w-4 h-4 rounded-sm flex-shrink-0"
              style={{ background: 'var(--wrong)' }}
            />
            <span style={{ color: 'var(--wrong)' }}><strong>{t('rules.wrong')}</strong></span>
            <span style={{ color: 'var(--text-light)' }}>— {t('rules.wrongDesc')}</span>
          </div>
        </div>

        {/* 接近判定规则 */}
        <h3 className="text-md font-bold mb-2">{t('rules.closeRules')}</h3>
        <ul
          className="list-disc list-inside mb-4 text-sm space-y-1"
          style={{ color: 'var(--text-sec)' }}
        >
          <li>{t('rules.closeRuleRarity')}</li>
          <li>{t('rules.closeRuleSubclass')}</li>
          <li>{t('rules.closeRuleFaction')}</li>
        </ul>

        <p className="text-xs italic" style={{ color: 'var(--primary)' }}>
          💡 {t('rules.tip')}
        </p>
      </div>
    </div>
  );
}
