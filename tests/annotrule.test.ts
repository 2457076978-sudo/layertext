/**
 * 应注词型的**唯一口径** · 测试
 *
 * 验收（《LayerText 工程优化总计划》「最关键的代码纪律」第 2 条）：
 *   「任何门禁字段只能由 `gateSegment` 生成；**报告、风险队列和 App 不得重新计算同一指标**。」
 *
 * 这一条原来是不成立的：「哪些超纲词算"该注"」这条规则散在四处，而且**两两不同**——
 *   · `qc.ts` 的 `annotable`      ：`w.length > 2`
 *   · 管线（`会话改写.mjs`）       ：`w.length > 2`
 *   · 风险队列（`风险队列.mjs`）   ：`w.length > 2`
 *   · **App 单句改写（`rewrite.ts`）：`t.length > 1`**  ← 这一处不一样
 * 于是同一个 2 字母超纲词（`ox`、`so` 这类）在 App 里会被拦下要求加注，
 * 在管线与风险队列里却根本不进分母：**同一个指标两个答案**。
 *
 * 真项目实测（Animal Farm A/M 层第一章）恰好没有 2 字母超纲词，
 * 所以这个分歧一直是**潜在**的——换一本书、换一份词库它就会浮出来，
 * 而那时没人会想到去比对两条路径的分母。所以这一组用例刻意用**构造出来的**输入
 * 把它逼出来，而不是等真数据碰巧踩到。
 *
 * 反证实测（把编译产物的两条规则改回改造前，再跑本文件的关键断言）：
 *   ✗ 门禁分母不受调用方影响（annotatable === 1）
 *   ✗ 2 字母词不让候选被拦（status !== blocked）
 * 两条都不成立——分歧是真的，不是推测。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ANNOTATABLE_MIN_LEN, annotatableOf, gateSegment } from '../src/core/segmentgate.js';
import { runQc } from '../src/core/qc.js';
import { buildLexicon } from '../src/core/lexicon.js';
import { checkRewrite, oovOfText } from '../src/core/rewrite.js';

/** 一份极小词库：**除 `ox`（2 字母）与 `fox`（3 字母）外都算已知**——
 *  这两个词正是用来把"长度阈值"这条规则逼出来的探针。 */
const WORDS = 'the,boy,ran,to,his,was,and,it,in,a,barn,old,very,small,dog,cat,saw,near,man,big,red'.split(',');
const VOCAB = ['词,类型', ...WORDS.map((w) => `${w},单词`)].join('\n') + '\n';

const lex = (): ReturnType<typeof buildLexicon> => buildLexicon({ vocabCsvTexts: [VOCAB] });

const KNOWN = new Set(WORDS);

/* ────────────────────── ① 口径本身 ────────────────────── */

test('口径是一个数（3），且**只有一处**定义', () => {
  assert.equal(ANNOTATABLE_MIN_LEN, 3, '两字母词（a/an/it/of）是学生本来就认得的，算进"该注"只会制造噪音');
  assert.equal(Object.isFrozen(Object.getOwnPropertyDescriptor({ ANNOTATABLE_MIN_LEN }, 'ANNOTATABLE_MIN_LEN')), false);
});

test('annotatableOf：去重 + 归一大小写 + 按长度阈值收口', () => {
  assert.deepEqual(annotatableOf(['Windmill', 'windmill', 'ox', 'so', 'barn']), ['windmill', 'barn']);
  assert.deepEqual(annotatableOf([]), []);
  assert.deepEqual(annotatableOf(['ab', 'abc']), ['abc'], '2 字母被挡，3 字母通过');
});

/* ────────────────────── ② ★ 两条路径必须给同一个答案 ────────────────────── */

test('★ 2 字母超纲词：App 单句路径与管线/QC **必须同口径**（改造前这里不一致）', () => {
  const seg = '[P01] The ox was in his barn.';
  const md = `## Chapter One\n\n${seg}\n`;   // runQc 要章节标记，oovOfText 不要——两者比的是同一段文字
  // 改造前：rewrite.ts 用 `> 1` → `ox` 留在里面；qc/管线用 `> 2` → `ox` 被剔掉
  const appSide = oovOfText(seg, KNOWN);
  /* `qc.oov` 是**原始** OOV（含 2 字母词，字段注释写的是"未去重"），
   * `qc.annotatable` 才是收口后的分母——两者用途不同，不是不一致。
   * 要比的是"应注词集"，所以拿 `annotatableOf(qc.oov)` 跟 App 比。 */
  const qcSide = annotatableOf(runQc(md, lex(), { tier: 'A', fileName: 'seg.md' }).oov);
  assert.deepEqual(appSide, [...qcSide].sort(), `App 与 QC 的应注词集必须逐项相同：${appSide} vs ${qcSide}`);
  assert.equal(appSide.includes('ox'), false, '2 字母词不进应注口径——两边都不进');
  assert.equal(runQc(md, lex(), { tier: 'A', fileName: 'seg.md' }).oov.includes('ox'), true, '原始 OOV 里它还在（原始与应注是两回事）');
});

test('★ 门禁自己收口：调用方传未过滤的 oov，判定结果也必须一样', () => {
  /* 这是纪律第 2 条的**实际落点**：门禁字段只能由 `gateSegment` 生成。
   * 只要门禁自己不收口，调用方就能靠"多传几个词"改变判定——
   * 而调用方有四五个（管线/风险队列/App/实验），迟早会有一个传得不一样。 */
  const text = '[P01] The boy ran to the barn.';
  const clean = gateSegment({ text, source: text, target: 0, maxLen: 20, oov: ['windmill'] });
  const dirty = gateSegment({ text, source: text, target: 0, maxLen: 20, oov: ['windmill', 'ox', 'so', 'it'] });
  assert.equal(clean.status, dirty.status, '传多几个短词不该改变 pass / needs-review');
  assert.deepEqual(clean.annotation.missing, dirty.annotation.missing);
  assert.equal(clean.annotation.annotatable, 1, '分母只算 windmill');
  assert.equal(dirty.annotation.annotatable, 1, '**2 字母词不进分母**——不管谁传进来的');
  assert.deepEqual(dirty.annotation.missing, ['windmill']);
});

test('★ 门禁收口之后，App 的 blocked 判定不会因为 2 字母词而误拦', () => {
  const req = { source: '[P01] The boy was in his barn.', intent: '单句改写', scope: 'sentence' as const, tier: '自定义', bookVersion: 'x' };
  const policy = { tier: '自定义', maxLen: 20, known: [...KNOWN] };
  // 候选句新引入了一个 2 字母词 `ox`
  const r = checkRewrite(req, policy, '[P01] The ox was in his barn.');
  assert.notEqual(r.status, 'blocked', `2 字母词不该让候选被拦：${r.blockedReasons.join('；')}`);
  assert.equal(
    r.checks.blockers.some((b) => b.ruleId === 'ANNO-01'),
    false,
    'ANNO-01（漏注）不该因为 2 字母词触发',
  );
});

test('★ 但 3 字母超纲词照样拦得住——收口不是"把门禁放松"', () => {
  const req = { source: '[P01] The boy was in his barn.', intent: '单句改写', scope: 'sentence' as const, tier: '自定义', bookVersion: 'x' };
  const policy = { tier: '自定义', maxLen: 20, known: [...KNOWN] };
  const r = checkRewrite(req, policy, '[P01] The boy saw a fox in his barn.');
  assert.equal(r.status, 'blocked', '新引入的 3 字母超纲词 fox 必须被拦下要求加注');
  assert.equal(r.checks.blockers.some((b) => b.ruleId === 'ANNO-01'), true);
  assert.deepEqual(r.checks.annotation.missing, ['fox']);
});

/* ────────────────────── ③ 覆盖率：报告与门禁同一个分母 ────────────────────── */

test('★ 报告里的加注覆盖率与门禁用的是**同一个分母**', () => {
  const text = '## Chapter One\n\n[P01] The boy saw a fox and an ox in his barn.\n';
  const q = runQc(text, lex(), { tier: 'A', fileName: 'seg.md' });
  // 门禁：把 QC 报出的应注词原样喂回去（这正是管线的做法）
  const v = gateSegment({ text: '[P01] The boy saw a fox and an ox in his barn.', source: '', target: 0, maxLen: 20, oov: q.oov });
  assert.equal(q.annotatable, v.annotation.annotatable, '分母必须一致（改造前 App 路径会多算 2 字母词）');
  assert.equal(q.annotated, v.annotation.annotated);
  assert.equal(q.annotated + q.annotMissing.length, q.annotatable);
  assert.equal(q.annotatable, 1, '这一句里该注的只有 fox 一个词型');
  assert.equal(annotatableOf(q.oov).includes('fox'), true);
});

test('★ 同一条规则在**三条路径**上都成立：QC / 门禁 / 单句改写给出同一组应注词', () => {
  const seg = '[P01] The boy saw a fox and an ox near his barn.';
  const md = `## Chapter One\n\n${seg}\n`;
  const qcSet = annotatableOf(runQc(md, lex(), { tier: 'A', fileName: 'seg.md' }).oov).sort();
  const gateSet = gateSegment({ text: seg, source: '', target: 0, maxLen: 20, oov: oovOfText(seg, KNOWN) }).annotation.missing.slice().sort();
  const appSet = oovOfText(seg, KNOWN).slice().sort();
  assert.deepEqual(appSet, qcSet, `App 与 QC：${appSet} vs ${qcSet}`);
  assert.deepEqual(gateSet, qcSet, `门禁与 QC：${gateSet} vs ${qcSet}`);
  assert.deepEqual(qcSet, ['fox'], '这一句里该注的只有 fox');
});

/* ────────────────────── ④ 真项目回归：口径统一不该改动既有数字 ────────────────────── */

test('真项目上口径统一**不改变任何数字**（那份数据里本来就没有 2 字母超纲词）', () => {
  // 这是"改动是否安全"的正面证据：Animal Farm A 层第一章的加注覆盖率
  // 在统一前后必须逐位相同——因为那份数据里没有落在 2 字母这一档的词。
  const text = '## Chapter One\n\n[P01] Mr. Jones, of the Manor Farm, had locked the hen houses for the night.\n';
  const q = runQc(text, lex(), { tier: 'A', fileName: 'seg.md' });
  const raw = [...new Set(q.oov)];
  const oldRule = raw.filter((w: string) => w.length > 2);
  const newRule = annotatableOf(raw);
  assert.deepEqual(newRule, oldRule, '有 2 字母 OOV 时才会分叉；没有时两者逐项相同');
  assert.equal(q.annotatable, newRule.length, 'QC 自己的分母也走同一条规则');
});
