'use client';

import { useEffect, useMemo, useRef } from 'react';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import { GameSearch } from '@/components/GameSearch';
import { QuestionPicker } from '@/components/QuestionPicker';
import { saveTurtleStats } from '@/lib/stats';
import { useTurtleStore, turtlePool } from '@/stores/turtle-store';
import { MAX_ATTEMPTS, remainingAttempts } from '@/lib/turtle-engine';
import { FIELD_LABEL_KEY, LEVEL_CLASS, LEVEL_KEY, formatOption } from '@/lib/turtle-ui';
import { useI18n } from '@/lib/i18n';
import type { Difficulty } from '@/types/character';

/**
 * 海龟汤 —— 盲盒变体。
 *
 * 页面只做「把 store 的状态画出来」，判定逻辑全在 `turtle-engine` / `turtle-store` 里，
 * 取值选择在 `QuestionPicker` 里（那一块的形态说明见它的文件头）。
 *
 * 四个**已定**的设计约束（都不是我推导的）：
 *   1. 取值域与谜底**同源**（都用 `turtlePool(difficulty)`）—— 页面把 `pool` 传给
 *      提问面板，面板不自己去取池子；若两边各算一次，会出现「选项里有、ask 反查不到」
 *      的静默错答案。
 *   2. 三档难度都能问全部 9 个维度（不因为难度少一个维度）。
 *   3. 首页**不放**入口卡（栅格是写死的 4 列，第五张会落单）；入口在 `/game` 的单人页里。
 *   4. 提问记录与提问面板**并排两栏**（`.console-2col`），记录在左、面板在右 ——
 *      与弗一把同构。面板有 9 行、记录最多 24 行，竖着堆会一路滚到底。
 *
 * 复用而非新造：难度卡沿用 `.menu-card`、两栏沿用 `.console-2col`、
 * 提问行沿用 `.cfg-row/.cfg-lb/.cfg-ct/.cfg-hint`、取值 chip 沿用 `.tchip`、
 * 三级反馈沿用 `.bdg-ok/-warn/-no`（这套徽标本就是本项目的「状态」语汇）、
 * 猜名沿用 `GameSearch`（拼音索引/下拉/抖动反馈全都在里面）。
 * 因此本页**仍然没有新增任何 CSS**（`QuestionPicker` 也没有）。
 */

const DIFFS: { key: Difficulty; icon: string; color: string }[] = [
  { key: 'easy', icon: '🌱', color: 'var(--success)' },
  { key: 'medium', icon: '⚔️', color: 'var(--primary)' },
  { key: 'hard', icon: '💀', color: 'var(--danger)' },
];

export default function TurtlePage() {
  const { t } = useI18n();
  const {
    status, difficulty, target, questions, guesses, questionCount, guessCount,
    startGame, ask, guess, giveUp, reset,
  } = useTurtleStore();

  // 取值域与谜底同源：同一难度池。useMemo 只是别在每次渲染重算 72 项的去重。
  const pool = useMemo(() => turtlePool(difficulty), [difficulty]);

  const left = remainingAttempts({ questionCount, guessCount });
  const guessedIds = useMemo(() => new Set(guesses.map(g => g.id)), [guesses]);
  const playing = status === 'playing';

  // 结算落档：只提交服务端（进海龟汤专属榜），**不写本地历史、不碰本地聚合**
  // —— 理由见 saveTurtleStats 的注释。与 /game 的存档同一套「上一次状态是 playing
  // 才触发」的写法（game/page.tsx），避免重挂载时对已结算的局面重复提交。
  // 两个计数器都上报：榜算的是**提问次数**（questionCount），点名次数只用来维持
  // guess_count 在服务端的既有含义（获胜守卫 / bestScore 口径），见 saveTurtleStats。
  const prevStatus = useRef(status);
  const savedRef = useRef(false);
  useEffect(() => {
    if (prevStatus.current === 'playing' && (status === 'won' || status === 'lost')) {
      if (!savedRef.current && target) {
        saveTurtleStats(status === 'won', questionCount, guesses.length, difficulty, target.name);
        savedRef.current = true;
      }
    }
    if (status === 'playing') savedRef.current = false;
    prevStatus.current = status;
  }, [status, questionCount, guesses.length, difficulty, target]);

  // ══════════════ 未开局 ══════════════
  if (status === 'idle') {
    return (
      <div className="page">
        <Header />
        <div className="page-scroll">
          <div style={{ maxWidth: 'var(--content-max)', margin: '0 auto' }}>
            <div className="panel-hd">
              <div>
                <h1 className="scr-ttl">🐢 {t('turtle.title')}</h1>
                <p className="sub">{t('turtle.subtitle')}</p>
              </div>
            </div>

            {/* 难度卡：形态与 /game 的三张难度卡一致（.menu-card + --menu-color） */}
            <div className="stats stats-3" style={{ marginTop: '16px' }}>
              {DIFFS.map(d => (
                <button
                  key={d.key}
                  onClick={() => startGame(d.key)}
                  data-testid={`turtle-start-${d.key}`}
                  className="menu-card"
                  style={{
                    '--menu-color': d.color,
                    cursor: 'pointer',
                    textAlign: 'left',
                  } as React.CSSProperties}
                >
                  <span className="menu-icon">{d.icon}</span>
                  <span style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <span className="menu-label">{t(`difficulty.${d.key}`)}</span>
                    <span className="menu-description">
                      {t('turtle.difficultyDesc', {
                        count: turtlePool(d.key).length,
                        // ⚠️ 必须引常量而不是写 24：次数池是唯一事实源，写死会让
                        //    改 MAX_ATTEMPTS 时卡片先撒谎，而没有任何哨兵拦得住。
                        attempts: MAX_ATTEMPTS,
                      })}
                    </span>
                  </span>
                </button>
              ))}
            </div>

            <div className="card" style={{ marginTop: '16px' }}>
              <h3 className="card-sub">{t('turtle.howToTitle')}</h3>
              {/* howTo1 / howTo4 里写着次数，走 {{attempts}} 占位符 —— 译文里写死数字
                  会在改 MAX_ATTEMPTS 时与「剩余 N 次」互相矛盾，且不报错。 */}
              <p className="sec-note" style={{ marginTop: 0 }}>{t('turtle.howTo1', { attempts: MAX_ATTEMPTS })}</p>
              <p className="sec-note">{t('turtle.howTo2')}</p>
              <p className="sec-note">{t('turtle.howTo3')}</p>
              <p className="sec-note">{t('turtle.howTo4', { attempts: MAX_ATTEMPTS })}</p>
              <p className="sec-note">{t('turtle.noRecord')}</p>
            </div>

            <div className="bar-actions" style={{ justifyContent: 'center' }}>
              <a href="/" className="btn-o">{t('game.back')}</a>
            </div>
          </div>
          <Footer />
        </div>
      </div>
    );
  }

  // ══════════════ 提问记录 ══════════════
  // 序号（01 / 02 …）是弗一把日志的形态：24 行记录里要能一眼说清「第几次问的」，
  // 光靠左对齐的短横线分不出来。顺序保持**时间正序**（最新的在最后）——
  // 读起来是一条「逐步缩小范围」的线索链，倒序会把因果读反。
  const logCard = (
    <div className="card" style={{ marginTop: 0 }}>
      <h3 className="card-sub">{t('turtle.logTitle')}</h3>
      {questions.length === 0 ? (
        <p className="empty">{t('turtle.logEmpty')}</p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {questions.map((q, i) => (
            <li
              key={i}
              data-testid="turtle-log-row"
              style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}
            >
              <span style={{ fontFamily: 'var(--f-mono)', fontSize: '10.5px', color: 'var(--text-3)' }}>
                {String(i + 1).padStart(2, '0')}
              </span>
              <span style={{ color: 'var(--text-2)' }}>
                {t(FIELD_LABEL_KEY[q.field])} ={' '}
                {/* `data-raw` 是**未格式化的取值**（星级是 6 而不是六颗星）。
                    展示与断言分开：记录里画星条与面板一致，而「这一行问的是哪个取值」
                    是机器可读的事实，不该靠拆展示字符串拿回来。 */}
                <b data-testid="turtle-log-value" data-raw={String(q.value)}>
                  {formatOption(q.field, q.value)}
                </b>
              </span>
              <span data-testid="turtle-log-level" className={LEVEL_CLASS[q.level]}>
                {t(LEVEL_KEY[q.level])}
              </span>
              {q.hint && (
                <span data-testid="turtle-log-hint" className="bdg bdg-mc">
                  {q.hint === 'higher' ? `↑ ${t('turtle.hintHigher')}` : `↓ ${t('turtle.hintLower')}`}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  // ══════════════ 局中 / 结算 ══════════════
  return (
    <div className="page">
      <Header />
      <div className="page-scroll">
        <div className="hud" style={{ flexWrap: 'wrap', maxWidth: 'var(--content-max)', margin: '0 auto 20px' }}>
          <button onClick={reset} className="btn-o">← {t('game.back')}</button>

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginLeft: 'auto' }}>
            <span className="bdg bdg-mc">🐢 {t(`difficulty.${difficulty}`)}</span>

            {playing && (
              <span data-testid="turtle-attempts" className={left <= 3 ? 'bdg bdg-dan' : 'bdg bdg-no'}>
                {t('turtle.attemptsLeft', { count: left })}
              </span>
            )}
            {status === 'won' && <span className="bdg bdg-ok">🎉 {t('turtle.won')}</span>}
            {status === 'lost' && <span className="bdg bdg-dan">{t('turtle.lost')}</span>}

            {playing && (
              <button onClick={giveUp} data-testid="turtle-give-up" className="btn-o btn-dan">
                {t('game.giveUp')}
              </button>
            )}
          </div>
        </div>

        <div style={{ maxWidth: 'var(--content-max)', margin: '0 auto' }}>
          {/* 揭晓：非 playing 时把谜底摆出来 */}
          {!playing && target && (
            <div className="card" style={{ marginTop: 0, marginBottom: '16px' }}>
              <h3 className="card-sub">{t('turtle.answerTitle')}</h3>
              <p data-testid="turtle-answer" style={{ margin: 0, fontSize: '1.15rem', fontWeight: 700 }}>
                {target.name}
              </p>
              <p data-testid="turtle-answer-meta" className="sec-note" style={{ marginTop: '4px' }}>
                {t('turtle.answerMeta', {
                  cls: target.class,
                  rarity: target.rarity,
                  year: target.releaseYear || '—',
                })}
              </p>
            </div>
          )}

          {/* 局中：记录 + 面板并排。结算后提问面板收起，记录单独占满一行
              （仍用 .console-2col 的话右栏会空一半，看起来像没加载出来）。 */}
          {playing ? (
            // `alignItems: start` 覆盖栅格默认的 stretch：面板比记录高得多（9 行取值），
            // 拉伸会把刚开局的空记录卡撑成一整块空白（实测 582×1362 的空盒子）。
            // 改成各自自然高度、顶端对齐。
            <div className="console-2col" style={{ alignItems: 'start' }}>
              {logCard}
              <div className="card" style={{ marginTop: 0 }}>
                <h3 className="card-sub">{t('turtle.askTitle')}</h3>
                <p className="sec-note" style={{ marginTop: 0 }}>{t('turtle.askHint')}</p>
                <QuestionPicker pool={pool} questions={questions} onAsk={ask} />
              </div>
            </div>
          ) : (
            logCard
          )}

          {/* 点名猜测。
              ⚠️ `overflow: visible` 不是装饰，是本页唯一需要它的一处：
              `.card` 自带 `overflow: hidden`，而 GameSearch 的下拉框是
              `position: absolute; top: calc(100% + 7px)` —— 会被卡片底边裁掉，
              表现就是「下拉框显示不全」（只剩输入框下面一条）。
              四个调用点里只有本页把 GameSearch 放进了 `.card`，/game、/daily、
              /multiplayer、/party 用的都是裸的居中 flex 容器，所以这是海龟汤独有的。
              本卡内部没有贴边的背景元素（只有标题、输入框和 .bdg 徽标），
              放开裁切不会让任何内容溢出圆角，其余卡片行为不变。 */}
          <div className="card" style={{ overflow: 'visible' }}>
            <h3 className="card-sub">{t('turtle.guessTitle')}</h3>
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <GameSearch
                onGuess={c => guess(c.name)}
                disabled={!playing}
                guessedIds={guessedIds}
                remainingGuesses={playing ? left : undefined}
                placeholder={t('turtle.placeholder')}
              />
            </div>

            {guesses.length > 0 && (
              <ul
                data-testid="turtle-guess-list"
                style={{
                  listStyle: 'none', margin: '12px 0 0', padding: 0,
                  display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'center',
                }}
              >
                {guesses.map((g, i) => (
                  <li key={i} data-testid="turtle-guess-item" className={g.correct ? 'bdg bdg-ok' : 'bdg bdg-no'}>
                    {g.name}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {!playing && (
            <div className="bar-actions" style={{ justifyContent: 'center', marginTop: '16px' }}>
              <button onClick={reset} data-testid="turtle-restart" className="btn-p">
                {t('game.newGame')}
              </button>
              <a href="/" className="btn-o">{t('game.back')}</a>
            </div>
          )}
        </div>
        <Footer />
      </div>
    </div>
  );
}
