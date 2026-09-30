'use client';

import { useCallback, useMemo, useState } from 'react';
import { buildQuestionOptions, QUESTION_FIELDS } from '@/lib/turtle-engine';
import { FIELD_LABEL_KEY, formatOption, valueSearchIndex } from '@/lib/turtle-ui';
import { useI18n } from '@/lib/i18n';
import type { QuestionField, TurtleQuestion } from '@/lib/turtle-engine';
import type { Character } from '@/types/character';

/**
 * 海龟汤的提问面板 —— 替掉原来的「维度下拉 + 取值下拉 + 提问按钮」。
 *
 * ## 为什么不是三个下拉
 * 原来问一次要四个动作：开维度下拉 → 选 → 开取值下拉 → 在最多 72 项里滚 → 点提问。
 * 而且「维度」是一个**模式**：不打开下拉就看不见自己有哪些维度可选，
 * 切换维度还会把已选的取值重置掉。海龟汤的核心节奏是「快速缩小范围」，
 * 这个形态每一步都在打断它。
 *
 * ## 借鉴弗一把（`shnlfriberg/csgofriberg`）的三条
 *   1. **没有「选维度」这一步** —— 9 个维度作为常驻行**同时可见**，
 *      「问哪一维」由「用哪一行」直接表达。
 *   2. **一个动作完成一次提问** —— 它的可搜索组合框在「选中候选项」时就提交
 *      （`onSelect={(value) => submitQuestion(field, value)}`）。这里所有取值
 *      都是**点一下即提问**，没有提交按钮。
 *   3. **两栏**：记录在左、提问面板在右，记录按序号排列（`01` / `02` …）。
 *
 * ## 为我们的数据改掉的一条
 * 弗一把按字段类型分控件（team/nationality 用组合框、role/isActive 用原生 select、
 * 数值用 number input）。我们的 9 个维度基数是 2 → 72，分界线在 **18 与 30 之间**：
 *   小字集（位置 2 / 性别 5 / 星级 6 / 职业 8 / 上线年份 8 / 词缀 18）→ **全部铺成 chip**。
 *     这一档本来就不该藏进下拉：星级只有 6 级、性别只有 2 种，
 *     一眼看全比点开下拉更快，而且星级排成一条阶梯后「高还是低」是看得见的。
 *   大字集（种族 30-45 / 阵营 41-45 / 子职业 68-72）→ **只有筛选框，候选要敲了字才出**。
 *     68 个 chip 全铺出来是十行，反而没法看；带拼音的筛选框（`valueSearchIndex`）
 *     敲 `jinwei` 就能出「近卫」。
 *   阈值是**按实际取值数**判定的，不是写死一张字段名单 —— 数据变了会自动换挡。
 *
 * ## 我们比弗一把多做的一条
 * **问过的取值会变暗**。弗一把不消减已问项（选项开局取一次、之后不再减），重复问
 * 照样扣一次机会。我们这里给一个提示：24 次是提问与猜测共享的，在 68 个子职业里
 * 重复问同一个纯属浪费。**只是变暗、仍然可点** —— 禁用会让玩家点不动又不知道为什么，
 * 比浪费一次更难解释；变暗是建议，不是拦截。
 *
 * ⚠️ 取值域必须与谜底**同源**：`pool` 由调用方传入（页面用 `turtlePool(difficulty)`），
 *    本组件不自己去取池子。各取各的会出现「面板里有这个子职业、但 `ask` 反查不到它
 *    隐含的职业」这种只在特定难度下现形的静默错答案（见 `turtle-engine.classOfSubclass`）。
 */

/** chip 铺满的上限。观测到的空档是 18（词缀）→ 30（种族），取中间的 20 */
const CHIP_LIMIT = 20;
/**
 * 筛选行出候选的上限。
 *
 * **空查询时一个候选都不出**（曾经先露 6 个，已去掉）：
 *   - 露出来的那几个既不是「最可能的」—— 取值域没有排序，第一个和第五十个一样冷门；
 *   - 又会让三行大字集各占一到两行 chip，把真正该一眼看全的小字集（位置/性别/星级）
 *     挤出首屏。去掉后这三行各只剩一个输入框，高度从 1362px 降到 1100px 里的一大截。
 * 输入框 + 行尾的「共 {{total}} 项 · 输入可筛选」已经说清了「这里有多少取值、怎么找」，
 * 不需要再靠铺几个样本证明「这行加载出来了」。
 *
 * 敲了字才出候选，这时每一行都是玩家自己在找的东西，给满 12 个是有用的。
 */
const SEARCH_RESULT_LIMIT = 12;

interface PickerProps {
  pool: Character[];
  /** 已问过的记录 —— 只用来把对应的取值标暗 */
  questions: TurtleQuestion[];
  onAsk: (field: QuestionField, value: string | number) => void;
}

export function QuestionPicker({ pool, questions, onAsk }: PickerProps) {
  // 每维的取值域。「维度 → 取值」一次算完（9 次去重），别在 render 里逐行重算
  const options = useMemo(() => {
    const m = {} as Record<QuestionField, (string | number)[]>;
    for (const f of QUESTION_FIELDS) m[f] = buildQuestionOptions(pool, f);
    return m;
  }, [pool]);

  // 已问过的取值：维度 → 该维度问过的取值集合。
  // ⚠️ 用嵌套 Map 而不是把 `field + 分隔符 + value` 拼成一个字符串键 ——
  //    后者要先证明「任何取值都不含这个分隔符」，而取值来自上游数据（词缀里就有
  //    标点），这个前提将来可能悄悄失效。分层查表不需要任何前提。
  const askedByField = useMemo(() => {
    const m = new Map<QuestionField, Set<string>>();
    for (const q of questions) {
      let s = m.get(q.field);
      if (!s) { s = new Set(); m.set(q.field, s); }
      s.add(String(q.value));
    }
    return m;
  }, [questions]);

  // 两个调用点各要判一次，收成一个回调，免得把取值转字符串的写法抄两遍
  const isAsked = useCallback(
    (field: QuestionField, value: string | number) => askedByField.get(field)?.has(String(value)) ?? false,
    [askedByField],
  );

  return (
    <>
      {QUESTION_FIELDS.map(f => {
        const opts = options[f];
        return opts.length > CHIP_LIMIT ? (
          <SearchRow key={f} field={f} options={opts} isAsked={isAsked} onAsk={onAsk} />
        ) : (
          <ChipRow key={f} field={f} options={opts} isAsked={isAsked} onAsk={onAsk} />
        );
      })}
    </>
  );
}

interface RowProps {
  field: QuestionField;
  options: (string | number)[];
  isAsked: (field: QuestionField, value: string | number) => boolean;
  onAsk: (field: QuestionField, value: string | number) => void;
}

/** 一个取值 chip。点一下就是一次提问 —— 没有提交按钮（见文件头第 2 条） */
function ValueChip({ field, value, asked, onAsk }: {
  field: QuestionField;
  value: string | number;
  asked: boolean;
  onAsk: (field: QuestionField, value: string | number) => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      data-testid={`turtle-chip-${field}-${value}`}
      // 变暗只是提示，不禁用：见文件头「我们比弗一把多做的一条」
      className={asked ? 'tchip off' : 'tchip'}
      title={asked ? t('turtle.askedMark') : undefined}
      onClick={() => onAsk(field, value)}
    >
      {formatOption(field, value)}
    </button>
  );
}

/** 小字集：全部取值铺成 chip */
function ChipRow({ field, options, isAsked, onAsk }: RowProps) {
  const { t } = useI18n();
  return (
    <div className="cfg-row" data-testid={`turtle-row-${field}`}>
      <span className="cfg-lb">{t(FIELD_LABEL_KEY[field])}</span>
      <span className="cfg-ct">
        {options.map(o => (
          <ValueChip key={String(o)} field={field} value={o} asked={isAsked(field, o)} onAsk={onAsk} />
        ))}
      </span>
    </div>
  );
}

/** 大字集：只有筛选框，敲了字才出候选 chip */
function SearchRow({ field, options, isAsked, onAsk }: RowProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');

  const needle = query.trim().toLowerCase();
  const hits = useMemo(() => {
    if (!needle) return []; // 空查询不出候选，见 SEARCH_RESULT_LIMIT 的注释
    return options
      .filter(o => valueSearchIndex(String(o)).includes(needle))
      .slice(0, SEARCH_RESULT_LIMIT);
  }, [options, needle]);

  return (
    // 筛选框 + 候选是**上下两段**，所以这一行顶端对齐（chip 行居中对齐即可）
    <div className="cfg-row" style={{ alignItems: 'flex-start' }} data-testid={`turtle-row-${field}`}>
      <span className="cfg-lb">{t(FIELD_LABEL_KEY[field])}</span>
      <span className="cfg-ct" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
        <input
          type="text"
          className="search-input"
          data-testid={`turtle-search-${field}`}
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t('turtle.searchPlaceholder')}
        />
        {/* 「没有匹配项」只在**敲了字还找不到**时说 —— 空查询也不是没匹配，
            是还没开始找。空查询下这一行什么都不出（见 SEARCH_RESULT_LIMIT）。 */}
        {needle && (
          hits.length === 0 ? (
            <span className="cfg-hint" data-testid={`turtle-nomatch-${field}`}>{t('turtle.noMatch')}</span>
          ) : (
            <span style={{ display: 'flex', flexWrap: 'wrap', gap: '9px' }}>
              {hits.map(o => (
                <ValueChip key={String(o)} field={field} value={o} asked={isAsked(field, o)} onAsk={onAsk} />
              ))}
            </span>
          )
        )}
        {/* 取值域大小的可见出处。候选只在敲字后出现且上限 12，所以这一行是**唯一**能看出
            「这个维度到底有多少取值」的地方（chip 行全铺，数 chip 就行、不需要它）。
            空查询时更是全靠它 —— 候选一个都不出，这行是那三行大字集里唯一的文字。
            它同时是「池子接对了没有」的现场证据：接成全量池子职业会显示 72，
            接 easy 池是 68。tests/turtle-smoke.mjs 的 a5 读的就是这个数 ——
            不去数被截断的候选 chip，因为候选上限是展示策略，取值域大小才是被断言的事实。 */}
        <span className="cfg-hint" data-testid={`turtle-count-${field}`}>
          {needle
            ? t('turtle.optShown', { shown: hits.length, total: options.length })
            : t('turtle.optHint', { total: options.length })}
        </span>
      </span>
    </div>
  );
}
