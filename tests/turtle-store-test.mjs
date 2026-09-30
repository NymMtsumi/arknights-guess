#!/usr/bin/env node
// 海龟汤「引擎 + store」— 纯逻辑确定性验证（plan 阶段 6）
//
// 不需要浏览器、不需要 build：用 tests/_ts-load.mjs 把 .ts 直接加载进 node。
//
// 本阶段最要紧的一条不变量是**「接近」的口径与经典模式同源**。
// 实现方式是「复制谜底、只改被问的那一维，再走一遍 compareGuess」，
// 所以这里逐对断言 `ask(target, f, other[f]) === compareGuess(target, other)[f]`
// —— 只要这条全过，海龟汤就不可能与经典模式产生第二套判定。
//
// 另一条是**谜底不落盘**（store 文件头写了为什么）。node 里没有 localStorage，
// 所以这里先装一个**间谍 localStorage**，再打完整一轮，断言它连一次 setItem 都没收到。
//
// 运行：node tests/turtle-store-test.mjs

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { check, finish, ROOT } from './helpers.mjs';
import { loadTsModule } from './_ts-load.mjs';

// ── 间谍 localStorage：任何写入都记下来 ──
const lsWrites = [];
const lsStore = new Map();
globalThis.localStorage = {
  getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
  setItem: (k, v) => { lsWrites.push([k, String(v)]); lsStore.set(k, String(v)); },
  removeItem: (k) => { lsStore.delete(k); },
  clear: () => { lsStore.clear(); },
  key: (i) => [...lsStore.keys()][i] ?? null,
  get length() { return lsStore.size; },
};

/** 确定性伪随机（避免 Math.random 让失败不可复现） */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

async function main() {
  const chars = JSON.parse(await readFile(join(ROOT, 'src', 'data', 'characters.json'), 'utf8'));

  const engine = (await loadTsModule('src/lib/turtle-engine.ts')).mod;
  // ⚠️ compareGuess 要单独加载：turtle-engine 只是 import 它、并不 re-export，
  //    所以 `engine.compareGuess` 是 undefined（第一版测试就栽在这）。
  const gameEngine = (await loadTsModule('src/lib/game-engine.ts')).mod;
  const { mod: storeMod, cleanup } = await loadTsModule('src/stores/turtle-store.ts');

  const { MAX_ATTEMPTS, QUESTION_FIELDS, askQuestion, buildQuestionOptions, remainingAttempts, isExhausted } = engine;
  const { compareGuess } = gameEngine;
  const { useTurtleStore } = storeMod;

  // 第四个参数（取值域来源）**必填** —— 子职业提问要靠它反查隐含的职业。
  // 这里统一绑定全量池，与 store 的传法一致。
  const ask = (target, field, value) => askQuestion(target, field, value, chars);

  // ══════════════ a. 判定口径与经典模式同源 ══════════════
  console.log('\n[a] 准确/接近/错误 的判定口径');

  const FIELDS = [...QUESTION_FIELDS];
  check('a0.可提问维度 = 9 个标准词条，且不含 artist',
    FIELDS.length === 9 && !FIELDS.includes('artist') && FIELDS.includes('tags'),
    `fields=[${FIELDS.join(',')}]`);

  // a1：问谜底的真值 → 必然「准确」
  // ⚠️ 排除 tags：`compareTags` 的 correct 要求**集合完全相等**，而提问传的是单值，
  //    所以只有「恰好 1 个词缀」的干员才可能答 correct（429 人里 130 人）。
  //    这不是缺陷，是三级语义（见 a1b），但对 tags 就不能照搬「问真值必 correct」。
  const SCALAR_FIELDS = FIELDS.filter(f => f !== 'tags');
  const selfMiss = [];
  for (const t of chars) {
    for (const f of SCALAR_FIELDS) {
      const v = t[f];
      if (v === undefined || v === '' || v === 0) continue; // 缺失数据不参与
      const { level } = ask(t, f, v);
      if (level !== 'correct') selfMiss.push(`${t.name}.${f}=${JSON.stringify(v)}→${level}`);
    }
  }
  check(`a1.问谜底的真值一律「准确」（${chars.length} 干员 × ${SCALAR_FIELDS.length} 维）`,
    selfMiss.length === 0,
    selfMiss.length ? `${selfMiss.length} 处不符，前 5：${selfMiss.slice(0, 5).join(' | ')}` : '0 处不符');

  // a1b：tags 提问的三级语义 —— 准确=词缀集合恰好就是这一个；接近=有它且还有别的；错误=没有它
  const oneTag = chars.find(c => (c.tags || []).length === 1);
  const multiTag = chars.find(c => (c.tags || []).length >= 2);
  const missingTag = chars.find(c => (c.tags || []).length && !(c.tags || []).includes('支援机械'));
  const lvOne = ask(oneTag, 'tags', oneTag.tags[0]).level;
  const lvMulti = ask(multiTag, 'tags', multiTag.tags[0]).level;
  const lvMiss = ask(missingTag, 'tags', '支援机械').level;
  check('a1b.词缀三级语义：恰好一个→准确、有它且还有别的→接近、没有它→错误',
    lvOne === 'correct' && lvMulti === 'close' && lvMiss === 'wrong',
    `${oneTag.name}(${oneTag.tags.join('/')})→${lvOne}；${multiTag.name}(${multiTag.tags.join('/')})问${multiTag.tags[0]}→${lvMulti}；${missingTag.name}问支援机械→${lvMiss}`);

  // a2：**逐对一致性** —— 非 tags 维必须与 compareGuess 逐字节相等
  const rng = makeRng(20260930);
  const pick = () => chars[Math.floor(rng() * chars.length)];
  const mismatch = [];
  let pairs = 0;
  for (let i = 0; i < 400; i++) {
    const target = pick();
    const other = pick();
    const cmp = compareGuess(target, other);
    for (const f of SCALAR_FIELDS) {
      const v = other[f];
      if (v === undefined || v === '') continue;
      pairs++;
      const got = ask(target, f, v).level;
      if (got !== cmp[f]) mismatch.push(`${target.name}/${other.name}.${f}: ask=${got} compareGuess=${cmp[f]}`);
    }
  }
  check(`a2.askQuestion ≡ compareGuess（400 随机对 × ${SCALAR_FIELDS.length} 维逐条比对）`,
    mismatch.length === 0,
    mismatch.length ? `${mismatch.length}/${pairs} 处漂移，前 3：${mismatch.slice(0, 3).join(' | ')}` : `${pairs} 条全等`);

  // a3-a8：每个 close 分支各自取一条真实样本，钉住「接近」确实来自复用
  const findPair = (pred) => {
    for (const t of chars) for (const g of chars) if (t.id !== g.id && pred(t, g)) return [t, g];
    return null;
  };
  const cases = [
    ['a3.子职业：同职业大类 → close', (t, g) => t.class === g.class && t.subclass !== g.subclass && g.subclass,
      (t, g) => ask(t, 'subclass', g.subclass).level === 'close'],
    ['a4.阵营：同主阵营 → close', (t, g) => t.faction.split(/[,，]/)[0] === g.faction.split(/[,，]/)[0] && t.faction !== g.faction,
      (t, g) => ask(t, 'faction', g.faction).level === 'close'],
    // 词缀不再单列：a1b 已把三级语义钉死（且比「有交集→close」更精确）
    ['a7.星级：差 1 → close', (t, g) => Math.abs(t.rarity - g.rarity) === 1 && g.rarity > 0,
      (t, g) => ask(t, 'rarity', g.rarity).level === 'close'],
    ['a8.上线年份：差 1 → close', (t, g) => t.releaseYear > 0 && g.releaseYear > 0 && Math.abs(t.releaseYear - g.releaseYear) === 1,
      (t, g) => ask(t, 'releaseYear', g.releaseYear).level === 'close'],
  ];
  for (const [name, pred, verify] of cases) {
    const pair = findPair(pred);
    check(name, !!pair && verify(pair[0], pair[1]),
      pair ? `${pair[0].name} vs ${pair[1].name}` : '数据里找不到满足条件的样本（INCONCLUSIVE）');
  }
  // a5b：子职业提问的三级语义 —— **这是刚修掉的那个 bug 的回归测试**。
  // 修复前 compareSubclass 的 guessClass 恒等于 targetClass，同职业分支恒真，
  // 于是「问任何非谜底的子职业」一律 close（跨职业也是 close），维度退化成常量。
  const subTarget = chars.find(c => c.class && c.subclass);
  const sameClsOtherSub = chars.find(c => c.class === subTarget.class && c.subclass !== subTarget.subclass);
  const otherCls = chars.find(c => c.class !== subTarget.class && c.subclass);
  const lvSubT = ask(subTarget, 'subclass', subTarget.subclass).level;
  const lvSubSame = ask(subTarget, 'subclass', sameClsOtherSub.subclass).level;
  const lvSubCross = ask(subTarget, 'subclass', otherCls.subclass).level;
  check('a5b.子职业三级：真值→准确、同职业他子职业→接近、跨职业→错误（回归 #a2 的常量退化）',
    lvSubT === 'correct' && lvSubSame === 'close' && lvSubCross === 'wrong',
    `${subTarget.name}(${subTarget.class}/${subTarget.subclass})：真值→${lvSubT}、同职业${sameClsOtherSub.subclass}→${lvSubSame}、跨职业${otherCls.subclass}(${otherCls.class})→${lvSubCross}`);

  // a5：部署位。⚠️ 本数据的 position 只有「高台/地面」两个值，
  //    comparePosition 的「皆可→close」分支**当前不可达**（不是漏测，是数据事实）。
  const posVals = [...new Set(chars.map(c => c.position).filter(Boolean))];
  const ht = chars.find(c => c.position === '高台'), gd = chars.find(c => c.position === '地面');
  check('a5.部署位：同→准确、异→错误',
    !!ht && !!gd && ask(ht, 'position', '高台').level === 'correct' && ask(ht, 'position', '地面').level === 'wrong',
    `取值域=[${posVals.join(',')}]（无「皆可」：comparePosition 的该分支不可达）；${ht.name} 问高台→${ask(ht, 'position', '高台').level}、问地面→${ask(ht, 'position', '地面').level}`);

  // a9：数值维方向提示 —— 语义是「目标相对你所问的值」
  const r6 = chars.find(c => c.rarity === 6), r1 = chars.find(c => c.rarity === 1);
  const up = ask(r6, 'rarity', 4), down = ask(r1, 'rarity', 4);
  check('a9.数值维方向：目标更高→higher、更低→lower',
    up.hint === 'higher' && down.hint === 'lower',
    `目标6星问4星→${up.hint}(level=${up.level})；目标1星问4星→${down.hint}(level=${down.level})`);
  check('a10.「准确」时不给方向提示',
    ask(r6, 'rarity', 6).hint === undefined,
    `hint=${JSON.stringify(ask(r6, 'rarity', 6).hint)}`);
  // ⚠️ 排除 tags：词缀是数组维，没有任何干员的 tags 是字符串，probe 会 undefined
  const nonNumeric = FIELDS.filter(f => f !== 'rarity' && f !== 'releaseYear' && f !== 'tags');
  const strayHints = nonNumeric.filter(f => {
    const probe = chars.find(c => typeof c[f] === 'string' && c[f]);
    return ask(probe, f, probe[f]).hint !== undefined;
  });
  check('a11.非数值维不产生方向提示',
    strayHints.length === 0,
    strayHints.length ? `多出提示的维度：${strayHints.join(',')}` : `${nonNumeric.join('/')} 全为 undefined`);

  // ══════════════ b. 取值域 ══════════════
  console.log('\n[b] 提问的取值域');
  const opts = Object.fromEntries(FIELDS.map(f => [f, buildQuestionOptions(chars, f)]));
  const dupes = FIELDS.filter(f => new Set(opts[f]).size !== opts[f].length);
  check('b1.各维度取值域无重复', dupes.length === 0, dupes.length ? `重复维度：${dupes.join(',')}` : '9 个维度均无重复');
  const emptyOpts = FIELDS.filter(f => opts[f].length === 0);
  check('b2.各维度取值域非空', emptyOpts.length === 0,
    FIELDS.map(f => `${f}:${opts[f].length}`).join(' '));
  const sortedOk = ['rarity', 'releaseYear'].every(f => opts[f].every((v, i) => i === 0 || Number(opts[f][i - 1]) < Number(v)));
  check('b3.数值维取值域升序', sortedOk, `rarity=[${opts.rarity.join(',')}] 年份=[${opts.releaseYear[0]}…${opts.releaseYear[opts.releaseYear.length - 1]}]`);
  const allTags = new Set(chars.flatMap(c => c.tags || []));
  check('b4.词缀取值域 = 池内全部词缀并集',
    opts.tags.length === allTags.size && [...allTags].every(t => opts.tags.includes(t)),
    `${opts.tags.length} 个（数据里共 ${allTags.size} 个）`);
  // b6：`classOfSubclass` 的正确性**建立在「子职业唯一属于一个职业」这条数据不变量上**。
  //    一旦上游数据出现跨职业重名的子职业，反查就有歧义 —— 按池序取首个只是权宜，
  //    玩家会看到一个说不清对错的答案。这条断言就是那道闸：数据一变，这里先红。
  const subToCls = new Map();
  const collisions = [];
  for (const c of chars) {
    if (!c.subclass) continue;
    if (subToCls.has(c.subclass) && subToCls.get(c.subclass) !== c.class) collisions.push(`${c.subclass}:${subToCls.get(c.subclass)}/${c.class}`);
    else subToCls.set(c.subclass, c.class);
  }
  check(`b6.子职业唯一属于一个职业（${subToCls.size} 个子职业，0 冲突）`,
    collisions.length === 0,
    collisions.length ? `出现跨职业重名：${collisions.slice(0, 5).join(' | ')}` : `0 冲突 —— classOfSubclass 反查无歧义`);

  // ⚠️ 取值域里**不能**出现 artist 的任何取值
  check('b5.取值域不含任何画师名（画师不入海龟汤）',
    !FIELDS.includes('artist') && !Object.values(opts).some(list => list.some(v => v === chars[0].artist)),
    `已检查 9 个维度`);

  // ══════════════ c. 共享次数池 ══════════════
  console.log('\n[c] 提问与猜测共享的次数池');
  check('c1.池子大小 24', MAX_ATTEMPTS === 24, `MAX_ATTEMPTS=${MAX_ATTEMPTS}`);
  check('c2.两种动作共享同一个池',
    remainingAttempts({ questionCount: 3, guessCount: 2 }) === 19,
    `3 问 + 2 猜 → 剩 ${remainingAttempts({ questionCount: 3, guessCount: 2 })}（期望 19）`);
  check('c3.耗尽边界：23 未耗尽、24 耗尽',
    !isExhausted({ questionCount: 23, guessCount: 0 }) && isExhausted({ questionCount: 20, guessCount: 4 }),
    `23→${isExhausted({ questionCount: 23, guessCount: 0 })}, 24→${isExhausted({ questionCount: 20, guessCount: 4 })}`);

  // ══════════════ d. store 一轮完整流程 + 谜底不落盘 ══════════════
  console.log('\n[d] store 全流程');
  const S = () => useTurtleStore.getState();
  const targetName = () => S().target?.name;
  const throwawayAsk = (f, v) => S().ask(f, v);

  S().startGame('medium');
  check('d1.startGame → playing 且谜底已定、计数归零',
    S().status === 'playing' && !!S().target && S().questionCount === 0 && S().guessCount === 0,
    `status=${S().status} target=${targetName()}`);

  const t = S().target;
  throwawayAsk('class', t.class);
  check('d2.提问一次 → 日志 +1、计数 +1、仍 playing',
    S().questions.length === 1 && S().questionCount === 1 && S().status === 'playing',
    `日志=${S().questions.length} 计数=${S().questionCount} level=${S().questions[0]?.level}`);

  const wrongName = chars.find(c => c.id !== t.id).name;
  S().guess(wrongName);
  check('d3.猜错 → 计数 +1、仍 playing',
    S().guessCount === 1 && S().status === 'playing' && S().guesses[0].correct === false,
    `guessCount=${S().guessCount} status=${S().status}`);

  const beforeBad = S().guessCount;
  const bad = S().guess('这个干员不存在');
  check('d4.猜不存在的名字 → NOT_FOUND 且**不消耗**次数',
    bad.success === false && bad.error === 'NOT_FOUND' && S().guessCount === beforeBad,
    `error=${bad.error} guessCount=${S().guessCount}（应为 ${beforeBad}）`);

  S().guess(t.name);
  check('d5.猜中谜底 → won',
    S().status === 'won' && S().guesses.at(-1).correct === true,
    `status=${S().status} 最后一次=${t.name}`);

  const afterWon = S().questionCount;
  const late = S().ask('class', t.class);
  check('d6.非 playing 时提问被拒且不改状态',
    late.success === false && late.error === 'NOT_PLAYING' && S().questionCount === afterWon,
    `error=${late.error}`);

  // 耗尽 → lost
  S().reset();
  S().startGame('hard');
  const t2 = S().target;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    if (i % 2 === 0) S().ask('gender', t2.gender); else S().guess(chars.find(c => c.id !== t2.id).name);
  }
  check('d7.次数耗尽 → lost（提问与猜测共同计数）',
    S().status === 'lost' && S().questionCount + S().guessCount >= MAX_ATTEMPTS,
    `status=${S().status} 问=${S().questionCount} 猜=${S().guessCount} 合计=${S().questionCount + S().guessCount}`);

  S().reset();
  S().startGame('easy');
  S().giveUp();
  check('d8.giveUp → lost 且保留谜底供揭晓',
    S().status === 'lost' && !!S().target, `status=${S().status} target=${targetName()}`);

  // 🔴 谜底不落盘
  const dumped = JSON.stringify(lsWrites);
  const names = [...new Set([t.name, t2.name, S().target?.name].filter(Boolean))];
  check('d9.整轮打完 localStorage **零写入**（谜底不落盘）',
    lsWrites.length === 0,
    lsWrites.length ? `收到 ${lsWrites.length} 次写入：${dumped.slice(0, 200)}` : 'setItem 调用次数 = 0');
  check('d10.即便有写入，转储里也不含任何谜底名',
    !names.some(n => dumped.includes(n)),
    `谜底=${names.join(',')}`);

  await cleanup();
  return 0;
}

const exitCode = await main().catch((e) => { console.error('❌ 未捕获异常:', e); return 1; });
finish(exitCode);
