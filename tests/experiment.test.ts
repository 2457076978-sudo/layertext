/**
 * 四格实验 回归测试
 *
 * 验收标准（《LayerText 项目审查报告（2026-09-11）》§二）：
 *   「2%→98% 的实验不能归因：一次同时改变了词表注入、会话记忆、查词和复检，且只有 31 段。
 *     至少做四格实验：独立调用/会话 × 有无全词表，固定温度和同一章；
 *     报告生成覆盖率、最终覆盖率、重复注释率、人工修订率和 token 成本。」
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
      segments: [
        seg({ final: 'The barn（谷仓） was old.' }),
        seg({ id: 'P02', source: 'The barn was cold.', final: 'The barn was cold.', first: 'The barn was cold.' }),
      ],
    }),
  );
  assert.equal(m.finalCoverage, 1, '第二段不必再注 barn——账本已记');
});

test('重复注释率：同段注两次要被抓住', () => {
  const m = measureCell(
    cell({ segments: [seg({ final: 'The barn（谷仓） and the barn（仓房） were old.' })] }),
  );
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
  assert.equal(notes.some((n) => n.includes('生成覆盖率会被高估')), true);
});

test('对照表：四格并排，且带相对基准的差', () => {
  const cells = experimentPlan().map((spec, i) =>
    measureCell(cell({ spec, usage: { calls: 2 + i, in: 1000 * (i + 1), out: 100, cached: 0 } })),
  );
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
  assert.equal(notes.some((n) => n.startsWith('会话记忆：')), true);
  assert.equal(notes.some((n) => n.startsWith('全词表注入：')), true);
  assert.equal(notes.some((n) => n.includes('单因子结论')), true);
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
