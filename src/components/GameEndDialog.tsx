'use client';

import { useState, useEffect } from 'react';
import { useI18n } from '@/lib/i18n';
import { loadHistory } from '@/lib/stats';
import type { Character, GameStatus } from '@/types/character';

interface GameEndDialogProps {
  status: GameStatus;
  target: Character | null;
  guessCount: number;
  onClose: () => void;
  onNewGame: () => void;
}

/** 从历史记录计算当前连胜/连败数（最近连续同结果数） */
function computeStreak(): { type: 'win' | 'loss' | null; count: number } {
  try {
    const history = loadHistory();
    if (!history.length) return { type: null, count: 0 };
    // 按时间戳降序排列（最新在前）
    const sorted = [...history].sort((a, b) => b.timestamp - a.timestamp);
    const first = sorted[0];
    // 多人模式也计入 streak
    const firstWon = 'won' in first ? first.won : false;
    let count = 0;
    for (const r of sorted) {
      const rWon = 'won' in r ? r.won : false;
      if (rWon === firstWon) count++;
      else break;
    }
    return { type: firstWon ? 'win' : 'loss', count };
  } catch {
    return { type: null, count: 0 };
  }
}

export function GameEndDialog({ status, target, guessCount, onClose, onNewGame }: GameEndDialogProps) {
  const { t } = useI18n();
  const [streak, setStreak] = useState<{ type: 'win' | 'loss' | null; count: number }>({ type: null, count: 0 });
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  useEffect(() => {
    if (status === 'won' || status === 'lost') {
      setStreak(computeStreak());
    }
  }, [status]);

  if (status !== 'won' && status !== 'lost') return null;
  if (!target) return null;

  const won = status === 'won';

  // 结算主图。加载失败退回原来的 emoji（稿子 data-fb 的等价物）。
  // 用 failedSrc 而不是布尔量：胜负图是两张，切到另一张时失败状态要自动作废。
  const artSrc = won ? '/icons/result-win.png' : '/icons/result-lose.png';
  const showArt = failedSrc !== artSrc;

  return (
    <div className="modal-mask">
      {/* end-dlg 是结算弹窗专用的修饰类。
          ⚠️ 不能把居中写进 .dlg 本身 —— 那是全站 9 个弹窗共用的类
             （规则/公告/致谢/更新日志/认证/管理/多人/派对都用 'dlg mc'|'dlg dan'），
             给 .dlg 加 align-items:center 会连它们一起改。 */}
      <div className={won ? 'dlg mc end-dlg' : 'dlg dan end-dlg'}>
        {/* 结算主图 —— 稿子 index-v12.html:1035,1043 的 .dialog-img.has-img
            （108px 圆角井 + 胜负描边光环，样式见 v12-components.css §21.6）。 */}
        <div
          className={showArt ? 'dialog-img has-img' : 'dialog-img'}
          style={{ marginBottom: '16px', flexShrink: 0 }}
        >
          {showArt ? (
            <img
              className="artimg"
              src={artSrc}
              alt=""
              aria-hidden="true"
              onError={() => setFailedSrc(artSrc)}
            />
          ) : (
            won ? '🎉' : '😢'
          )}
        </div>

        {/* 标题 */}
        <h2 className="dt">
          {won ? t('game.won') : t('game.lost')}
        </h2>

        {/* 描述 */}
        <div className="db">
          <p>
            {won
              ? t('game.wonDesc', { name: target.name, count: guessCount })
              : t('game.lostDesc', { name: target.name })
            }
          </p>

          {/* 连胜/连败提示 */}
          {streak.count >= 2 && (
            <span className={`bdg streak-badge ${streak.type === 'win' ? 'bdg-warn' : 'bdg-dan'}`}>
              {streak.type === 'win'
                ? t('game.streakWin', { count: streak.count })
                : t('game.streakLoss', { count: streak.count })
              }
            </span>
          )}

          {/* 目标角色信息 */}
          <div className="meta-row" style={{ marginTop: '14px' }}>
            <span className="mchip mc">{target.class}</span>
            <span className="mchip mc">{'★'.repeat(target.rarity)}</span>
            <span className="mchip mc">{target.faction}</span>
          </div>
        </div>

        {/* 两个按钮 */}
        <div className="df" style={{ justifyContent: 'center' }}>
          <button onClick={onClose} className="btn-o">
            {t('game.viewResult')}
          </button>
          <button onClick={onNewGame} className="btn-p btn-shine">
            {t('game.newGame')}
          </button>
        </div>
      </div>
    </div>
  );
}
