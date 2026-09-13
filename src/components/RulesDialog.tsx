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
    <div className="modal-mask" onClick={onClose}>
      <div className="dlg mc" onClick={(e) => e.stopPropagation()}>
        <div className="mdl">
          {/* 关闭按钮 */}
          <div className="mhd">
            <h2>{t('rules.title')}</h2>
            <button onClick={onClose} className="x" aria-label="Close">
              ✕
            </button>
          </div>

          <p className="sec-note">{t('rules.intro')}</p>

          {/* 如何游戏 */}
          <div className="msec">
            <h3>{t('rules.howTo')}</h3>
            <ol className="steps">
              <li>{t('rules.step1')}</li>
              <li>{t('rules.step2')}</li>
              <li>{t('rules.step3')}</li>
              <li>{t('rules.step4')}</li>
              <li>{t('rules.step5')}</li>
            </ol>
          </div>

          {/* 颜色含义 */}
          <div className="msec">
            <h3>{t('rules.colors')}</h3>
            <div>
              <div className="crow">
                <span className="sw2 sw-ok" />
                <span className="cn2 k-ok">
                  <strong>{t('rules.correct')}</strong>
                </span>
                <span className="cd2">— {t('rules.correctDesc')}</span>
              </div>
              <div className="crow">
                <span className="sw2 sw-warn" />
                <span className="cn2 k-warn">
                  <strong>{t('rules.close')}</strong>
                </span>
                <span className="cd2">— {t('rules.closeDesc')}</span>
              </div>
              <div className="crow">
                <span className="sw2 sw-no" />
                <span className="cn2 k-no">
                  <strong>{t('rules.wrong')}</strong>
                </span>
                <span className="cd2">— {t('rules.wrongDesc')}</span>
              </div>
            </div>
          </div>

          {/* 接近判定规则 */}
          <div className="msec">
            <h3>{t('rules.closeRules')}</h3>
            <ul className="rlist">
              <li>{t('rules.closeRuleRarity')}</li>
              <li>{t('rules.closeRuleSubclass')}</li>
              <li>{t('rules.closeRuleFaction')}</li>
              <li>{t('rules.closeRuleYear')}</li>
              <li>{t('rules.closeRuleTags')}</li>
              <li>{t('rules.closeRulePosition')}</li>
              <li>{t('rules.closeRuleAlter')}</li>
            </ul>
          </div>

          <p className="tip">💡 {t('rules.tip')}</p>
        </div>
      </div>
    </div>
  );
}
