/**
 * 四格实验 回归测试
 *
 * 验收标准（《LayerText 项目审查报告（2026-09-11）》§二）：
 *   「2%→98% 的实验不能归因：一次同时改变了词表注入、会话记忆、查词和复检，且只有 31 段。
 *     至少做四格实验：独立调用/会话 × 有无全词表，固定温度和同一章；
 *     报告生成覆盖率、最终覆盖率、重复注释率、人工修订率和 token 成本。」
 *
 * 验收标准（《LayerText 工程优化总计划》阶段 4「质量科学与商业验证」）：
 *   「四格实验有可重复的输入快照和原始事件；任一质量结论都能追溯到运行 ID」
 *   「A/M 两条轴分别报告阅读负荷下降与理解支架覆盖率，**禁止综合分数替代**」
 *   后半段是 `experimentrun.ts` 那一批测试在守：快照指纹、漂移检测、原始事件、
 *   指标派生、追溯、两轴不合成、以及"没跑就说没跑"。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  annotationCoverageOf,
  compareCells,
  estimateCost,
  experimentPlan,
  experimentVerdict,
  measureCell,
  segmentFirstResponses,
  type CellInput,
  type CellSegment,
  type CellSpec,
} from '../src/core/experiment.js';
import {
  axesLines,
  assertNoComposite,
  buildExperimentSnapshot,
  cellKeyOf,
  cellRecords,
  compositeFields,
  experimentStatus,
  makeRawEvent,
  metricValue,
  snapshotChapterOf,
  snapshotDrift,
  statusLines,
  tierAxes,
  traceAll,
  traceConclusion,
  truncationReport,
  usageOf,
  type ExperimentSnapshot,
  type RawEvent,
  type RawEventInput,
} from '../src/core/experimentrun.js';

/** 应注词：barn / windmill 两个（简单确定，便于断言比例） */
const oovOf = (t: string): string[] => ['barn', 'windmill'].filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(t));

const seg = (over: Partial<CellSegment> = {}): CellSegment => ({
  id: 'P01',
  chapter: '第一章',
  source: 'The barn was old.',
  final: 'The barn（谷仓） was old.',
  first: 'The barn was old.',
  ...over,
});

const cell = (over: Partial<CellInput> = {}): CellInput => {
  const [spec] = experimentPlan();
  return {
    spec: spec!,
    tier: 'A',
    segments: [seg()],
    oovOf,
    usage: { calls: 2, in: 1000, out: 200, cached: 0 },
    needsReview: 0,
    ...over,
  };
};

test('四格就是四格：独立/会话 × 有无全词表，两两配对不重不漏', () => {
  const plan = experimentPlan();
  assert.equal(plan.length, 4);
  assert.deepEqual([...new Set(plan.map((p) => p.session))].sort(), ['independent', 'session']);
  assert.deepEqual([...new Set(plan.map((p) => p.vocab))].sort(), ['full', 'lite']);
  const keys = new Set(plan.map((p) => `${p.session}+${p.vocab}`));
  assert.equal(keys.size, 4, '四格不能重复');
  // 独立调用必须真的换 scope（否则"独立"只是标签）
  assert.equal(plan.find((p) => p.session === 'independent')?.scope, 'segment');
  assert.equal(plan.find((p) => p.session === 'session')?.scope, 'tier');
});

test('生成覆盖率看**首轮**、最终覆盖率看落盘：两者不同才谈得上归因', () => {
  const m = measureCell(
    cell({
      segments: [
        seg({ first: 'The barn was old.', final: 'The barn（谷仓） was old.' }),
        seg({ id: 'P02', source: 'A windmill stood there.', first: 'A windmill stood there.', final: 'A windmill stood there.' }),
      ],
    }),
  );
  assert.equal(m.genCoverage, 0, '首轮一个都没注 → 生成覆盖率 0');
  assert.equal(m.finalCoverage, 0.5, '最终注了 barn 一个 → 50%');
  assert.equal(m.coverageGain, 50);
});

test('全篇只注一次：后面的段不重复注前面注过的词，不算漏注', () => {
  const m = measureCell(
    cell({
      segments: [seg({ final: 'The barn（谷仓） was old.' }), seg({ id: 'P02', source: 'The barn was cold.', final: 'The barn was cold.', first: 'The barn was cold.' })],
    }),
  );
  assert.equal(m.finalCoverage, 1, '第二段不必再注 barn——账本已记');
});

test('重复注释率：同段注两次要被抓住', () => {
  const m = measureCell(cell({ segments: [seg({ final: 'The barn（谷仓） and the barn（仓房） were old.' })] }));
  assert.equal(m.duplicateRate, 0.5);
});

test('人工修订率 = 未过门禁段数 / 段数', () => {
  const m = measureCell(cell({ segments: [seg(), seg({ id: 'P02' }), seg({ id: 'P03' }), seg({ id: 'P04' })], needsReview: 1 }));
  assert.equal(m.manualRate, 0.25);
});

test('未过门禁的段不进最终覆盖率（不能拿没过的段刷分）', () => {
  const m = measureCell(
    cell({
      segments: [seg({ final: 'The barn（谷仓） was old.' }), seg({ id: 'P02', final: undefined, first: 'x' })],
    }),
  );
  assert.equal(m.finalCoverage, 1, '只有通过的段参与最终覆盖率');
  assert.equal(m.segments, 2, '段数仍按全部段算');
  assert.equal(m.finalSegments, 1, '落盘段数要单独记：分母是它，不是段总数');
});

test('★ 一段都没落盘时要说出来：那个"最终覆盖率 100%"是没分母，不是成绩', () => {
  const m = measureCell(cell({ segments: [seg({ final: undefined }), seg({ id: 'P02', final: undefined })], needsReview: 2 }));
  assert.equal(m.finalSegments, 0);
  assert.equal(m.finalCoverage, 1, '分母为零 → 比例退化成 1（这正是必须另记 finalSegments 的原因）');
  const notes = experimentVerdict([m, measureCell(cell())]);
  assert.equal(
    notes.some((n) => n.includes('一段都没落盘')),
    true,
  );
  assert.equal(
    notes.some((n) => n.includes('最终覆盖率 100%"是假的')),
    true,
  );
});

test('token 成本与缓存命中：经济性也算结论的一部分', () => {
  assert.equal(estimateCost({ in: 1e6, out: 0, cached: 0 }), 1);
  assert.equal(estimateCost({ in: 1e6, out: 0, cached: 1e6 }), 0.02);
  const m = measureCell(cell({ usage: { calls: 5, in: 10000, out: 2000, cached: 8000 } }));
  assert.equal(m.cacheHit, 0.8);
  assert.equal(m.calls, 5);
  // (10000-8000)/1e6 未命中 + 8000/1e6*0.02 命中 + 2000/1e6*4 输出
  assert.equal(m.cost, 0.0102);
});

test('缺首轮响应要标出来：生成覆盖率会被高估，结论里不能说满', () => {
  const m = measureCell(cell({ segments: [seg({ first: undefined })] }));
  assert.equal(m.firstFallback, 1);
  const notes = experimentVerdict([m, measureCell(cell())]);
  assert.equal(
    notes.some((n) => n.includes('生成覆盖率会被高估')),
    true,
  );
});

test('★ 对照表在"0 段落盘"的格上印"—"：表里不能出现一个假的 100%', () => {
  const empty = measureCell(cell({ segments: [seg({ final: undefined })], needsReview: 1 }));
  const ok = measureCell(cell({ spec: experimentPlan()[1]!, segments: [seg()] }));
  const md = compareCells([empty, ok]);
  assert.match(md, /—（0 段落盘）/);
  // 覆盖率三列（生成 / 最终 / 提升）都必须是"—"；后面的人工修订率 100% 是真话，不受影响
  assert.match(md.split('\n')[2]!, /^\| 会话 \+ 全词表 \| 1 \| —（0 段落盘） \| —（0 段落盘） \| — \|/);
  assert.equal(
    experimentVerdict([empty, ok]).some((n) => n.includes('比不出') || n.includes('四格都没有落盘正文')),
    true,
  );
});

test('对照表：四格并排，且带相对基准的差', () => {
  const cells = experimentPlan().map((spec, i) => measureCell(cell({ spec, usage: { calls: 2 + i, in: 1000 * (i + 1), out: 100, cached: 0 } })));
  const md = compareCells(cells);
  assert.match(md, /生成覆盖率/);
  assert.match(md, /最终覆盖率/);
  assert.match(md, /重复注释率/);
  assert.match(md, /人工修订率/);
  assert.match(md, /花费/);
  assert.equal(md.split('\n').length, 2 + 4, '表头 + 分隔 + 四格');
  assert.match(md, /vs 基准\(生成\)/);
});

test('单因子结论：把会话记忆与全词表各自的增益拆开说', () => {
  const good = (spec: CellSpec) =>
    measureCell(cell({ spec, segments: [seg({ first: spec.session === 'session' ? 'The barn（谷仓） was old.' : 'The barn was old.', final: 'The barn（谷仓） was old.' })] }));
  const notes = experimentVerdict(experimentPlan().map(good));
  assert.equal(
    notes.some((n) => n.startsWith('会话记忆：')),
    true,
  );
  assert.equal(
    notes.some((n) => n.startsWith('全词表注入：')),
    true,
  );
  assert.equal(
    notes.some((n) => n.includes('单因子结论')),
    true,
  );
});

test('从会话日志取首轮响应：同一段后面的回合不覆盖第一次', () => {
  const log = [
    '{"t":"msg","role":"system","content":"opener"}',
    '{"t":"msg","role":"user","content":"第一章 · 第 1/2 段\\n\\n【原文段落】\\nThe barn was old.\\n\\n请改写这一段。"}',
    '{"t":"msg","role":"assistant","content":"[P01] The barn was old."}',
    '{"t":"msg","role":"user","content":"【本地复检】本段未达标：……"}',
    '{"t":"msg","role":"assistant","content":"[P01] The barn（谷仓） was old."}',
    '{"t":"msg","role":"user","content":"【结转上下文】…\\n\\n第一章 · 第 2/2 段\\n\\n【原文段落】\\nA windmill stood.\\n\\n请改写这一段。"}',
    '{"t":"msg","role":"assistant","content":"[P02] A windmill stood."}',
  ].join('\n');
  const m = segmentFirstResponses(log);
  assert.equal(m.get('第一章#0'), '[P01] The barn was old.', '第一次的才是"生成"的样子');
  assert.equal(m.get('第一章#1'), '[P02] A windmill stood.');
  assert.equal(segmentFirstResponses('不是日志').size, 0);
});

test('annotationCoverageOf：与门禁同一口径（含连字符成分与词形归一）', () => {
  const r = annotationCoverageOf('[P01] The barn（谷仓） was old.', 'The barn was old.', oovOf);
  assert.equal(r.coverage, 1);
  assert.equal(r.annotatable, 1);
  const none = annotationCoverageOf('[P01] The barn was old.', 'The barn was old.', oovOf);
  assert.equal(none.coverage, 0);
  const elsewhere = annotationCoverageOf('[P01] The barn was old.', 'The barn was old.', oovOf, ['barn']);
  assert.equal(elsewhere.annotatable, 0, '别处已注的词不该进本段分母');
});

/* ══════════════════════════════════════════════════════════════════════════
 * 阶段 4 验收之一：「四格实验有**可重复的输入快照**和**原始事件**」
 * ══════════════════════════════════════════════════════════════════════════ */

const chapter = (segs = [{ id: 'P01', text: 'The barn was old.' }]) => snapshotChapterOf('第一章', segs);

const snap = (over: Partial<Parameters<typeof buildExperimentSnapshot>[0]> = {}): ExperimentSnapshot =>
  buildExperimentSnapshot({
    runId: 'A层85-wayne',
    tier: 'A',
    chapter: chapter(),
    lexicon: { version: '词表v1', counts: { known: 2 }, sources: [{ name: '词库', hash: 'h1', count: 2 }] },
    model: { name: 'deepseek-chat', temperature: 0.3, maxTokens: 3000 },
    promptVersion: 'session-v3-20260911',
    code: { version: '1.2.1', commit: 'abc1234', dirty: 'd0' },
    createdAt: '2026-09-12T00:00:00.000Z',
    ...over,
  });

/** 与快照完全一致的"现在的输入" —— 每个用例只改它要测的那一项 */
const current = (over: Partial<Parameters<typeof snapshotDrift>[1]> = {}) => ({
  chapter: chapter(),
  lexiconVersion: '词表v1',
  model: { name: 'deepseek-chat', temperature: 0.3, maxTokens: 3000 },
  promptVersion: 'session-v3-20260911',
  code: { version: '1.2.1', commit: 'abc1234', dirty: 'd0' },
  ...over,
});

test('★ 快照指纹只认输入：换了运行 ID / 生成时间，指纹不变（同一批输入才对得上）', () => {
  const a = snap();
  const b = snap({ runId: 'A层85-另一位教师', createdAt: '2026-09-13T10:00:00.000Z' });
  assert.equal(a.hash, b.hash, 'runId 与时间戳是运行身份，不是输入');
  assert.equal(a.hash.length, 16);
});

test('★ 快照指纹认全六项输入：原文 / 词表 / 模型温度 / 提示词 / 代码 / 格定义，改任何一项都换指纹', () => {
  const base = snap().hash;
  const variants: [string, Partial<Parameters<typeof buildExperimentSnapshot>[0]>][] = [
    ['原文', { chapter: chapter([{ id: 'P01', text: 'The barn was very old.' }]) }],
    ['词表', { lexicon: { version: '词表v2', counts: { known: 3 }, sources: [{ name: '词库', hash: 'h2', count: 3 }] } }],
    ['温度', { model: { name: 'deepseek-chat', temperature: 0.7, maxTokens: 3000 } }],
    ['模型', { model: { name: 'deepseek-reasoner', temperature: 0.3, maxTokens: 3000 } }],
    ['提示词', { promptVersion: 'session-v4-20260912' }],
    ['代码', { code: { version: '1.2.1', commit: 'deadbee', dirty: 'd0' } }],
    ['格定义', { cells: [...experimentPlan()].map((c, i) => (i === 0 ? { ...c, label: '会话 + 全词表（改过）' } : c)) }],
  ];
  for (const [name, over] of variants) assert.notEqual(snap(over).hash, base, `换${name}必须换快照指纹`);
});

test('★ 输入漂移要检测出来，而且点名是哪一项、从什么变成什么', () => {
  const s = snap();
  assert.deepEqual(snapshotDrift(s, current()), { ok: true, drift: [], blocksConclusion: false });
  const d = snapshotDrift(s, current({ lexiconVersion: '词表v2' }));
  assert.equal(d.ok, false);
  assert.equal(d.blocksConclusion, true, '有漂移就不许把数字当结论——这是硬规则');
  assert.match(d.drift.join('\n'), /词表/);
  assert.match(d.drift.join('\n'), /词表v1 → 词表v2/);
});

test('★ 原文漂移要定位到段，不是笼统一句"哈希不一致"', () => {
  const s = snap({
    chapter: chapter([
      { id: 'P01', text: 'The barn was old.' },
      { id: 'P02', text: 'A windmill stood there.' },
    ]),
  });
  const d = snapshotDrift(
    s,
    current({
      chapter: chapter([
        { id: 'P01', text: 'The barn was old.' },
        { id: 'P02', text: 'A windmill stood.' },
      ]),
    }),
  );
  assert.equal(d.blocksConclusion, true);
  assert.match(d.drift[0]!, /P02/, '要说清是 P02 变了，否则复核的人无从下手');
});

test('温度用浮点比较：0.3 与 0.30000000000000004 不该被当成两次实验', () => {
  const d = snapshotDrift(snap(), current({ model: { name: 'deepseek-chat', temperature: 0.1 + 0.2, maxTokens: 3000 } }));
  assert.equal(d.ok, true);
});

test('代码在工作区里被改过（脏指纹变了）也要报出来：那说明跑的不是同一版引擎', () => {
  const d = snapshotDrift(snap(), current({ code: { version: '1.2.1', commit: 'abc1234', dirty: 'd1' } }));
  assert.equal(d.blocksConclusion, true);
  assert.match(d.drift.join('\n'), /工作区在运行期间被改过/);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 阶段 4 验收：「原始事件」——五个指标从事件派生，不另算一份
 * ══════════════════════════════════════════════════════════════════════════ */

const specOf = (i = 0): CellSpec => experimentPlan()[i]!;

const raw = (over: Partial<RawEventInput> = {}): RawEvent =>
  makeRawEvent({
    runId: 'R1',
    spec: specOf(),
    tier: 'A',
    segment: 'P01',
    model: 'deepseek-chat',
    temperature: 0.3,
    promptVersion: 'session-v3-20260911',
    usage: { calls: 2, in: 1000, out: 200, cached: 0 },
    source: 'The barn was old.',
    first: 'The barn was old.',
    final: 'The barn（谷仓） was old.',
    ...over,
  });

const derive = { oovOf };

test('★ 截断事实是三态：没记 finish_reason 就是 unknown，**绝不能写成"没截断"**', () => {
  const unknown = raw();
  assert.equal(unknown.truncated, 'unknown');
  assert.notEqual(unknown.truncated, 'no', '把"不知道"写成 false，截断率就成了编出来的小数');
  assert.match(unknown.truncatedWhy, /没记 finish_reason/);
  assert.equal(raw({ finishReason: 'length' }).truncated, 'yes');
  assert.equal(raw({ finishReason: 'stop' }).truncated, 'no');
  assert.match(raw({ finishReason: 'length' }).truncatedWhy, /max_tokens/);
});

test('★ 截断率：事实不全时是 null（算不出来），有据可查时才给数；代理信号单独报', () => {
  const none = truncationReport([raw({ segment: 'P01' }), raw({ segment: 'P02' })]);
  assert.equal(none.rate, null, '"还没记"与"没截断"不是一回事 —— 这里必须是 null 而不是 0');
  assert.equal(none.unknown, 2);
  assert.match(none.why, /算不出来/);

  const some = truncationReport([raw({ segment: 'P01', finishReason: 'length' }), raw({ segment: 'P02', finishReason: 'stop' }), raw({ segment: 'P03' })]);
  assert.equal(some.rate, 0.5);
  assert.equal(some.unknown, 1, '没记的那段不进分子也不进分母，但要说出来');
  assert.match(some.why, /1 段没有 finish_reason/);
});

test('★ 代理信号不等于截断事实：响应末尾没有句终标点只是"看起来被切断"', () => {
  assert.equal(raw({ first: 'The barn was old', finishReason: 'stop' }).suspectedTruncation, true);
  assert.equal(raw({ first: 'The barn was old.', finishReason: 'stop' }).suspectedTruncation, false);
  assert.equal(raw({ first: '' }).suspectedTruncation, true, '空响应无论是不是截断，都不是"写完了"');
  const r = truncationReport([raw({ first: 'The barn was old', finishReason: 'stop' })]);
  assert.equal(r.rate, 0, '事实说没截断 → 截断率 0');
  assert.equal(r.suspected, 1, '代理信号单独计数，不并进截断率');
});

test('事件的成本与调用次数走 estimateCost 同一口径，不另立价目', () => {
  const u = usageOf({ calls: 3, in: 10000, out: 2000, cached: 8000 });
  assert.equal(u.cost, estimateCost({ in: 10000, out: 2000, cached: 8000 }));
  assert.deepEqual([u.calls, u.in, u.out, u.cached], [3, 10000, 2000, 8000]);
});

test('格键就是两个因子的组合（四格四键，不重不漏）', () => {
  assert.deepEqual(experimentPlan().map(cellKeyOf), ['session+full', 'session+lite', 'independent+full', 'independent+lite']);
});

test('事件 ID 稳定：同一次运行同格同段永远同一个 ID，追溯才指得准', () => {
  assert.equal(raw().eventId, raw({ first: '改了响应' }).eventId, '响应变了不该换事件 ID——那是同一行事件');
  assert.notEqual(raw().eventId, raw({ segment: 'P02' }).eventId);
  assert.notEqual(raw().eventId, raw({ runId: 'R2' }).eventId);
});

test('★ 五个指标从原始事件派生：改事件里的落盘正文，覆盖率跟着变（说明没有第二份算法）', () => {
  const [before] = cellRecords([raw()], derive);
  assert.equal(before!.metric.finalCoverage, 1, '事件里的 final 注了 barn → 覆盖率 1');
  const [after] = cellRecords([raw({ final: 'The barn was old.' })], derive);
  assert.equal(after!.metric.finalCoverage, 0, '把事件里的 final 换成没加注的 → 覆盖率必须跟着变 0');
  assert.equal(after!.metric.genCoverage, 0);
  assert.equal(after!.metric.segments, 1);
});

test('人工修订率与重复注释率同样由事件推出（outcome / 正文里的重复注释）', () => {
  const [r] = cellRecords([raw({ segment: 'P01', outcome: 'needs-review' }), raw({ segment: 'P02', final: 'The barn was old.' })], derive);
  assert.equal(r!.metric.segments, 2);
  assert.equal(r!.metric.manualRate, 0.5);
  assert.equal(r!.needsReview, 1);
  const [dup] = cellRecords([raw({ final: 'The barn（谷仓） and the barn（仓房） were old.' })], derive);
  assert.equal(dup!.metric.duplicateRate, 0.5);
});

test('花费取"格级事件"（权威合计）；只有段级事件时用汇总，并标出来源', () => {
  const cell = specOf(1);
  const segEv = raw({ spec: cell, usage: { calls: 2, in: 1000, out: 100, cached: 0 } });
  const total = raw({ spec: cell, segment: null, usage: { calls: 9, in: 9000, out: 900, cached: 0 } });
  const [withTotal] = cellRecords([segEv, total], derive);
  assert.equal(withTotal!.usageSource, '格级事件');
  assert.equal(withTotal!.metric.calls, 9);
  assert.equal(withTotal!.metric.cost, Number(estimateCost({ in: 9000, out: 900, cached: 0 }).toFixed(4)));
  const [onlySeg] = cellRecords([segEv], derive);
  assert.equal(onlySeg!.usageSource, '段级汇总');
  assert.equal(onlySeg!.metric.calls, 2);
});

test('按增量推定的段级用量被标出来（推定值不该装成直接测得的）', () => {
  const [r] = cellRecords([raw({ usageApprox: true })], derive);
  assert.equal(r!.usageSource, '段级汇总');
});

/* ══════════════════════════════════════════════════════════════════════════
 * 阶段 4 验收：「任一质量结论都能追溯到运行 ID」
 * ══════════════════════════════════════════════════════════════════════════ */

test('★ 追溯：结论 → 运行 ID + 事件行；追不到就明说追不到，不给一个空数组充数', () => {
  const events = [raw({ runId: 'R1', segment: 'P01' }), raw({ runId: 'R1', segment: 'P02' })];
  const t = traceConclusion({ metric: '最终覆盖率', cell: 'session+full' }, events);
  assert.equal(t.ok, true);
  assert.deepEqual(t.runIds, ['R1']);
  assert.deepEqual(t.eventIds, ['R1|session+full|P01', 'R1|session+full|P02']);
  assert.equal(t.segments, 2);

  const missing = traceConclusion({ metric: '最终覆盖率', cell: 'independent+lite' }, events);
  assert.equal(missing.ok, false);
  assert.match(missing.why, /没有任何原始事件/);
  assert.deepEqual(missing.eventIds, []);
});

test('★ 追溯只认受控指标名：自造一个"整体质量分"追溯不到（它本来就不该存在）', () => {
  const t = traceConclusion({ metric: '整体质量分', cell: 'session+full' }, [raw()]);
  assert.equal(t.ok, false);
  assert.match(t.why, /不是本实验定义的指标/);
});

test('★ 截断率没事实支撑时**不能**作为结论：追溯会拒绝它', () => {
  const noFact = traceConclusion({ metric: '截断率', cell: 'session+full' }, [raw()]);
  assert.equal(noFact.ok, false);
  assert.match(noFact.why, /截断事实不可得/);
  const withFact = traceConclusion({ metric: '截断率', cell: 'session+full' }, [raw({ finishReason: 'stop' })]);
  assert.equal(withFact.ok, true);
});

test('成本追溯指向格级事件，逐段指标指向段级事件', () => {
  const events = [raw({ segment: 'P01' }), raw({ segment: null })];
  const cost = traceConclusion({ metric: '成本', cell: 'session+full' }, events);
  assert.deepEqual(cost.eventIds, ['R1|session+full|(格)|合计']);
  const cov = traceConclusion({ metric: '最终覆盖率', cell: 'session+full' }, events);
  assert.deepEqual(cov.eventIds, ['R1|session+full|P01']);
});

test('traceAll 把"追得到的"和"追不到的"分开交出来（后者只能报不可追溯）', () => {
  const events = [raw()];
  const { traceable, untraceable } = traceAll(
    [
      { metric: '最终覆盖率', cell: 'session+full' },
      { metric: '截断率', cell: 'session+full' },
      { metric: '最终覆盖率', cell: 'independent+full' },
    ],
    events,
  );
  assert.equal(traceable.length, 1);
  assert.equal(untraceable.length, 2);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 阶段 4 验收：「A/M 两条轴分别报告……禁止综合分数替代」
 * ══════════════════════════════════════════════════════════════════════════ */

const qc = (newWordRate: number, annotationCoverage = 1, annotated = 0, annotatable = 0) => ({ newWordRate, annotationCoverage, annotated, annotatable });

test('★ 两轴分开报：对象上只有 load 与 scaffolding 两个数，没有任何整体分', () => {
  const a = tierAxes('A', qc(0.24), qc(0.12, 0.86, 43, 50));
  assert.deepEqual(Object.keys(a).sort(), ['load', 'scaffolding', 'tier'], '多一个键都要问一句：它是不是偷偷把两件事合成了一件');
  assert.equal(a.load.name, '阅读负荷下降');
  assert.equal(a.scaffolding.name, '理解支架覆盖率');
  assert.equal(Math.round(a.load.value * 100), 50);
  assert.equal(a.scaffolding.value, 0.86);
  assert.deepEqual(compositeFields(a), []);
});

test('★ 合成分字段要被抓出来：塞一个"综合得分"就抛，别等它进了销售文案', () => {
  const a = tierAxes('A', qc(0.2), qc(0.1, 0.9, 9, 10));
  assert.doesNotThrow(() => assertNoComposite(a));
  const bad = { A: { ...a, 综合得分: 0.87 } };
  assert.deepEqual(compositeFields(bad), ['A.综合得分']);
  assert.throws(() => assertNoComposite(bad), /禁止综合分数替代/);
  assert.deepEqual(compositeFields({ overallScore: 1, weighted: 2, 总评: 3 }).length, 3);
});

test('两轴各写一句"它不是什么"：两行一组，永不合并', () => {
  const lines = axesLines(tierAxes('M', qc(0.2), qc(0.1, 0.9, 9, 10)));
  assert.equal(lines.length, 4);
  assert.match(lines[0]!, /^(\*\*M｜阅读负荷下降\*\*：)/);
  assert.match(lines[2]!, /^(\*\*M｜理解支架覆盖率\*\*：)/);
  assert.match(lines.join('\n'), /不减少阅读负荷/);
});

test('★ 生词率反而上升时要多说一句：公式写的是"降到"，不能让人把它读成进步', () => {
  const rose = axesLines(tierAxes('A', qc(0.15), qc(0.2, 1, 3, 3)));
  assert.equal(rose.length, 5, '负荷为负时多一行提醒');
  assert.match(rose.join('\n'), /反而上升/);
  assert.match(rose.join('\n'), /别把它读成进步/);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 阶段 4 验收的落点：诚实降级 ——「还没跑」和「跑出来是 0」必须长得不一样
 * ══════════════════════════════════════════════════════════════════════════ */

const fourCellEvents = ({ noFinal = false } = {}): RawEvent[] =>
  experimentPlan().flatMap((spec) => [
    raw({ spec, segment: 'P01', ...(noFinal ? { final: undefined, outcome: 'needs-review' as const } : {}) }),
    raw({ spec, segment: null, usage: { calls: 3, in: 3000, out: 300, cached: 0 } }),
  ]);

test('★ 没跑就明说没跑：metrics 是 null（不是空数组，更不是四个 0）', () => {
  const none = experimentStatus({ snapshot: null, events: [], opt: derive });
  assert.equal(none.state, '未跑');
  assert.equal(none.metrics, null, '返回 [] 会被下游读成"跑过但一格都没有"');
  assert.equal(none.cells.length, 0);
  assert.match(none.why, /一次都没跑过/);

  const snapOnly = experimentStatus({ snapshot: snap(), events: [], opt: derive });
  assert.equal(snapOnly.state, '未跑');
  assert.equal(snapOnly.metrics, null);
  assert.match(snapOnly.why, /不是"跑出来是 0"/);
});

test('★ 没跑时每个指标都取不到数：available=false 且 value=null（不是 0）', () => {
  const st = experimentStatus({ snapshot: snap(), events: [], opt: derive });
  for (const m of ['生成覆盖率', '最终覆盖率', '重复注释率', '人工修订率', '成本', '截断率'] as const) {
    const v = metricValue(st, 'session+full', m);
    assert.equal(v.available, false, `${m} 没跑就该说取不到`);
    assert.equal(v.value, null, `${m} 不许用 0 冒充"还没跑"`);
    assert.match(v.why, /还没跑|没有原始事件/);
  }
});

test('★ 整格都没交付时覆盖率不出数：100% 与"没交付"必须长得不一样', () => {
  // 事件里没有 final = 这一段没过门禁、没落盘（正文里只有占位注释）
  const st = experimentStatus({ snapshot: snap(), events: fourCellEvents({ noFinal: true }), opt: derive });
  assert.equal(st.state, '可出结论');
  const cov = metricValue(st, 'session+full', '最终覆盖率');
  assert.equal(cov.available, false);
  assert.equal(cov.value, null);
  assert.match(cov.why, /没有分母/);
  assert.match(cov.why, /不是 100%/);
  assert.equal(metricValue(st, 'session+full', '人工修订率').available, true, '人工修订率不依赖落盘正文，照常给');
  assert.equal(metricValue(st, 'session+full', '人工修订率').value, 1);
});

test('★ 四格齐、输入没变 → 可出结论；取数拿到的是真值', () => {
  const st = experimentStatus({ snapshot: snap(), events: fourCellEvents(), opt: derive });
  assert.equal(st.state, '可出结论');
  assert.match(st.why, /可以当结论用/);
  const v = metricValue(st, 'session+full', '最终覆盖率');
  assert.equal(v.available, true);
  assert.equal(v.value, 1);
  const cost = metricValue(st, 'session+full', '成本');
  assert.equal(cost.available, true, `成本应当取到（${cost.why}）`);
});

test('★ 只跑了一部分 → 有缺口，且说清缺哪一格', () => {
  const two = [experimentPlan()[0]!, experimentPlan()[1]!].flatMap((spec) => [raw({ spec }), raw({ spec, segment: null })]);
  const st = experimentStatus({ snapshot: snap(), events: two, opt: derive });
  assert.equal(st.state, '有缺口');
  assert.match(st.why, /四格还缺/);
  assert.match(st.why, /独立调用/);
  assert.equal(metricValue(st, 'session+full', '最终覆盖率').available, false, '有缺口时不许报数当结论');
});

test('★ 输入在跑的过程中变了（漂移）→ 有缺口，指标一律不可用：不静默容忍', () => {
  const d = snapshotDrift(snap(), current({ promptVersion: 'session-v9-20260920' }));
  const st = experimentStatus({ snapshot: snap(), events: fourCellEvents(), drift: d, opt: derive });
  assert.equal(st.state, '有缺口');
  assert.match(st.why, /提示词版本变了/);
  assert.equal(metricValue(st, 'session+full', '最终覆盖率').value, null);
});

test('截断事实不可得时，其余四个指标照样能报，但截断率单独说"算不出来"', () => {
  const st = experimentStatus({ snapshot: snap(), events: fourCellEvents(), opt: derive });
  assert.equal(metricValue(st, 'session+full', '最终覆盖率').available, true, '别的指标不该被截断率的缺口连坐');
  const t = metricValue(st, 'session+full', '截断率');
  assert.equal(t.available, false);
  assert.equal(t.value, null);
  assert.match(t.why, /算不出来/);
  assert.equal(
    st.verdict.some((v) => v.includes('截断率算不出来')),
    true,
    '报告里要有一句：截断率是算不出来，不是 0',
  );
});

test('报告抬头把"这批数到底算不算数"说清楚（状态 + 为什么 + 警告）', () => {
  const lines = statusLines(experimentStatus({ snapshot: snap(), events: fourCellEvents(), opt: derive }));
  assert.match(lines[0]!, /可出结论/);
  assert.match(lines[1]!, /为什么/);
  assert.equal(
    lines.some((l) => l.startsWith('- ⚠')),
    true,
    '至少要有一条警告，全绿的报告反而可疑',
  );
  const notRun = statusLines(experimentStatus({ snapshot: null, events: [], opt: derive }));
  assert.match(notRun[0]!, /未跑 ⚠/);
});
