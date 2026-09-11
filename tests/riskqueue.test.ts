/**
 * 段级风险队列 回归测试
 *
 * 验收标准（《LayerText 项目审查报告（2026-09-11）》§一）：
 *   「界面应先显示 风险 = 概率 × 后果 队列：事实差异/专名缺失/数字变化置顶，
 *     其次是漏注和超长，最后才是低风险语言润色」
 *   「每项显示原句、改写句、触发规则、上下文两句」
 *   「若队列超过 60 分钟，停止扩展审校，先修生成规则或词库」
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { batchImpact, buildRiskQueue, groupQueue, oneHourPlan, sessionState, type SegmentRiskInput } from '../src/core/riskqueue.js';
import { gateSegment, type GateProblem } from '../src/core/segmentgate.js';

/** 用真实门禁产出一段的问题清单（门禁规则本身由 segmentgate.test.ts 覆盖） */
function fact(source: string, rewritten: string): GateProblem[][] {
  return [gateSegment({ text: rewritten, source, target: 6, maxLen: 20, oov: [] }).problems];
}

test('风险 = 概率 × 后果：排序必须是 事实 ＞ 漏注/超长 ＞ 低风险润色', () => {
  const q = buildRiskQueue([
    {
      chapter: '第一章',
      segIndex: 0,
      source: '[P01] In 1911 Napoleon and the animals worked hard.',
      rewritten: '[P01] 他 the animals worked hard very much indeed here.',
      // 故意把所有规则都塞进同一段，验证排序只由 risk 决定
      problems: [
        { ruleId: 'ANNO-02', category: '加注', severity: 'warn', weight: 5, risk: 4.5, message: '重复注释', detail: { words: ['windmill'] } },
        { ruleId: 'SENT-01', category: '语言', severity: 'blocker', weight: 8, risk: 8, message: '超长句', detail: { sentences: ['a b c'], maxLen: 20 } },
        { ruleId: 'FACT-01', category: '事实', severity: 'warn', weight: 22, risk: 13.2, message: '数字丢失', detail: { signals: ['1911'] } },
        { ruleId: 'FACT-02', category: '事实', severity: 'warn', weight: 20, risk: 12, message: '专名丢失', detail: { signals: ['Napoleon'] } },
        { ruleId: 'ANNO-01', category: '加注', severity: 'blocker', weight: 10, risk: 10, message: '漏注', detail: { missing: ['windmill'] } },
        { ruleId: 'ZH-01', category: '格式', severity: 'blocker', weight: 11, risk: 11, message: '中文', detail: { samples: ['他'] } },
        { ruleId: 'LEN-01', category: '语言', severity: 'blocker', weight: 6, risk: 6, message: '篇幅', detail: {} },
      ],
    },
  ]);
  assert.deepEqual(
    q.items.map((i) => i.ruleId),
    ['FACT-01', 'FACT-02', 'ZH-01', 'ANNO-01', 'SENT-01', 'LEN-01', 'ANNO-02'],
  );
  assert.deepEqual(q.summary.byCategory, { 事实: 2, 格式: 1, 加注: 2, 语言: 2 });
  assert.equal(q.summary.total, 7);
  assert.equal(q.summary.blockers, 4);
});

test('每项都带原句、改写句、触发规则与上下文两句话', () => {
  const q = buildRiskQueue([
    {
      chapter: '第一章',
      segIndex: 2,
      source: '[P01] The animals met in the barn. [P02] In 1911 Napoleon gave a speech. [P03] Everyone listened quietly.',
      rewritten: '[P01] The animals met in the barn. [P02] The pig gave a speech. [P03] Everyone listened quietly.',
      problems: fact('[P01] The animals met in the barn. [P02] In 1911 Napoleon gave a speech. [P03] Everyone listened quietly.', '[P01] The animals met in the barn. [P02] The pig gave a speech. [P03] Everyone listened quietly.')[0],
    },
  ]);
  const num = q.items.find((i) => i.ruleId === 'FACT-01');
  assert.ok(num, '数字丢失必须进队列');
  assert.match(num.sourceSentence, /1911/);
  assert.equal(num.segLabel, '第一章 第3段');
  assert.equal(num.id, '第一章#2:FACT-01:1911');
  const proper = q.items.find((i) => i.ruleId === 'FACT-02');
  assert.ok(proper);
  assert.match(proper.sourceSentence, /Napoleon/);
  // 上下文：改写句是 P02，则上句是 P01、下句是 P03
  assert.match(proper.context.prev, /met in the barn/);
  assert.match(proper.context.next, /listened quietly/);
});

test('数字信号渲染成人话：归一后的 2 要写出原文的 two（否则教师看不懂）', () => {
  const q = buildRiskQueue([
    {
      chapter: '第四章',
      segIndex: 0,
      source: '[P01] Their most faithful disciples were the two cart-horses.',
      rewritten: '[P01] Their best followers were the cart-horses.',
      problems: [
        { ruleId: 'FACT-01', category: '事实', severity: 'warn', weight: 22, risk: 13.2, message: '数字丢失', detail: { signals: ['2'] } },
      ],
    },
  ]);
  assert.equal(q.items[0].title, '原文的「2」（原文写的是 two）在改写里找不到');
  assert.equal(q.items[0].detail?.numberWord, 'two');
  assert.equal(q.items[0].id, '第四章#0:FACT-01:2', 'ID 仍用归一后的信号（稳定，不随措辞变）');
});

test('事实类是逐条展开的：两个数字就是两条待办，不是一条', () => {
  const q = buildRiskQueue([
    {
      chapter: '第二章',
      segIndex: 1,
      source: '[P01] In 1911 there were 12 pigs and 7 dogs.',
      rewritten: '[P01] There were some pigs and dogs.',
      problems: fact('[P01] In 1911 there were 12 pigs and 7 dogs.', '[P01] There were some pigs and dogs.')[0],
    },
  ]);
  const facts = q.items.filter((i) => i.ruleId === 'FACT-01');
  assert.equal(facts.length, 3, '3 个数字就是 3 条待办');
  assert.deepEqual(facts.map((i) => i.detail?.signal).sort(), ['12', '1911', '7'].sort());
});

test('漏注也逐词展开，且带原句定位（教师是逐词决定，不是整段决定）', () => {
  const q = buildRiskQueue([
    {
      chapter: '第三章',
      segIndex: 0,
      source: '[P01] The windmill（风车） was broken.',
      rewritten: '[P01] The windmill was broken.',
      problems: [
        { ruleId: 'ANNO-01', category: '加注', severity: 'blocker', weight: 10, risk: 10, message: '漏注', detail: { missing: ['windmill', 'curdling'] } },
      ],
    },
  ]);
  assert.equal(q.items.length, 2);
  assert.deepEqual(
    q.items.map((i) => i.id).sort(),
    ['第三章#0:ANNO-01:curdling', '第三章#0:ANNO-01:windmill'],
  );
  const w = q.items.find((i) => i.detail?.word === 'windmill');
  assert.ok(w);
  assert.match(w.sourceSentence, /windmill/);
  assert.equal(w.id, '第三章#0:ANNO-01:windmill', 'ID 必须含具体词——教师决策事件靠它关联');
});

test('人工时长估算与一小时路径：超预算时建议是"先修规则或词库"，不是"加班"', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    chapter: `第${i + 1}章`,
    segIndex: 0,
    source: `[P01] In 19${i} Napoleon spoke.`,
    rewritten: '[P01] The pig spoke.',
    problems: fact(`[P01] In 19${i} Napoleon spoke.`, '[P01] The pig spoke.')[0],
  }));
  const q = buildRiskQueue(many);
  const plan = oneHourPlan(q);
  assert.equal(plan.overBudget, true, '80 分钟以上的队列必须报警');
  assert.match(plan.advice, /先修生成规则或词库/);
  assert.equal(plan.phases.length, 4);
  assert.equal(plan.phases[0].budget, 10);
  assert.equal(plan.phases[1].budget, 25);
  assert.equal(plan.phases[2].budget, 15);
  assert.equal(plan.phases[3].budget, 10);
  assert.equal(plan.phases[1].items.every((i) => i.category === '事实'), true, '第二阶段只放事实类');
});

test('小队列不报警，给的是照单子走的建议', () => {
  const q = buildRiskQueue([
    { chapter: '第一章', segIndex: 0, source: '[P01] A cat sat.', rewritten: '[P01] A cat sat 5 times.', problems: [
      { ruleId: 'ANNO-02', category: '加注', severity: 'warn', weight: 5, risk: 4.5, message: '重复注释', detail: { words: ['cat'] } },
    ] },
  ]);
  const plan = oneHourPlan(q);
  assert.equal(plan.overBudget, false);
  assert.match(plan.advice, /按阶段顺序走/);
});

test('队列为空时不报错（干净的层应该是常态，不是异常）', () => {
  const q = buildRiskQueue([]);
  assert.equal(q.items.length, 0);
  assert.equal(q.summary.estimatedMinutes, 0);
  assert.equal(oneHourPlan(q).overBudget, false);
});

test('排序稳定：同 risk 同时按章序、段序排（可回读、可比较）', () => {
  const mk = (chapter: string, segIndex: number): SegmentRiskInput => ({
    chapter,
    segIndex,
    source: '[P01] x',
    rewritten: '[P01] y',
    problems: [{ ruleId: 'ANNO-01', category: '加注', severity: 'blocker', weight: 10, risk: 10, message: 'm', detail: { missing: ['w'] } }],
  });
  const q = buildRiskQueue([mk('第二章', 3), mk('第一章', 5), mk('第一章', 1)]);
  assert.deepEqual(q.items.map((i) => i.segLabel), ['第一章 第2段', '第一章 第6段', '第二章 第4段']);
});

/* ────────────────── 任务组：卡片流 → 一次处理一类（v4 方向第 3 条） ────────────────── */

const MUTATING = ['ANNO-01', 'ANNO-02', 'ANNO-03', 'AST-02'];

test('聚合优先级：同一词 → 同一段同一规则 → 同章同类型', () => {
  const q = buildRiskQueue([
    // 同一个词（windmill）在三个不同段里漏注 → 一组
    { chapter: '第一章', segIndex: 0, source: 'a', rewritten: 'a', problems: [{ ruleId: 'ANNO-01', category: '加注', severity: 'blocker', weight: 10, risk: 10, message: 'm', detail: { missing: ['windmill'] } }] },
    { chapter: '第一章', segIndex: 3, source: 'b', rewritten: 'b', problems: [{ ruleId: 'ANNO-01', category: '加注', severity: 'blocker', weight: 10, risk: 10, message: 'm', detail: { missing: ['windmill'] } }] },
    { chapter: '第二章', segIndex: 1, source: 'c', rewritten: 'c', problems: [{ ruleId: 'ANNO-01', category: '加注', severity: 'blocker', weight: 10, risk: 10, message: 'm', detail: { missing: ['windmill'] } }] },
  ]);
  const groups = groupQueue(q.items, { mutatingRules: MUTATING });
  assert.equal(groups.length, 1, '同一个词跨章也要归一组');
  assert.equal(groups[0]!.kind, 'word');
  assert.equal(groups[0]!.count, 3);
  assert.equal(groups[0]!.chapters.length, 2, '涉及两章要显示出来（批量应用前让人知道影响面）');
  assert.equal(groups[0]!.uniformAction, true, '全是 ANNO-01 → 可以一键批量');
  assert.equal(groups[0]!.actionable, 3);
});

test('同一段同一规则归一组（数字/专名类）', () => {
  const q = buildRiskQueue([
    { chapter: '第一章', segIndex: 2, source: 'In 1911 there were 12 pigs.', rewritten: 'Some pigs.', problems: [
      { ruleId: 'FACT-01', category: '事实', severity: 'warn', weight: 22, risk: 13.2, message: 'm', detail: { signals: ['1911', '12'] } },
    ] },
  ]);
  const groups = groupQueue(q.items, { mutatingRules: MUTATING });
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.kind, 'segment-rule', '同段的两个数字归一组，不是散成两张卡');
  assert.equal(groups[0]!.count, 2);
  assert.equal(groups[0]!.uniformAction, false, '事实类不改正文，不给"全部应用"');
});

test('同章同类型的散项归一组（语言类）', () => {
  const q = buildRiskQueue([
    { chapter: '第一章', segIndex: 0, source: 's', rewritten: '[P01] a', problems: [{ ruleId: 'SENT-01', category: '语言', severity: 'blocker', weight: 8, risk: 8, message: 'm', detail: { sentences: ['a'], maxLen: 5 } }] },
    { chapter: '第一章', segIndex: 5, source: 's', rewritten: '[P06] b', problems: [{ ruleId: 'SENT-01', category: '语言', severity: 'blocker', weight: 8, risk: 8, message: 'm', detail: { sentences: ['b'], maxLen: 5 } }] },
  ]);
  const groups = groupQueue(q.items, { mutatingRules: MUTATING });
  assert.equal(groups[0]!.kind, 'segment-rule', '超长句是按句定位的，落在"同一段同一规则"这一档');
});

test('代表样本最多 3 条（报告给的数），组里其余靠展开看', () => {
  const problems = Array.from({ length: 7 }, (_, i) => ({ chapter: '第一章', segIndex: i, source: 's', rewritten: 's', problems: [{ ruleId: 'ANNO-01', category: '加注' as const, severity: 'blocker' as const, weight: 10, risk: 10, message: 'm', detail: { missing: ['barn'] } }] }));
  const groups = groupQueue(buildRiskQueue(problems).items, { mutatingRules: MUTATING });
  assert.equal(groups[0]!.samples.length, 3);
  assert.equal(groups[0]!.items.length, 7, '展开能拿到全部');
});

test('组间排序按组内最高风险（事实类那组排在语言类前面）', () => {
  const q = buildRiskQueue([
    { chapter: '第一章', segIndex: 0, source: 'In 1911 x', rewritten: 'y', problems: [{ ruleId: 'FACT-01', category: '事实', severity: 'warn', weight: 22, risk: 13.2, message: 'm', detail: { signals: ['1911'] } }] },
    { chapter: '第一章', segIndex: 9, source: 's', rewritten: '[P10] z', problems: [{ ruleId: 'SENT-01', category: '语言', severity: 'blocker', weight: 8, risk: 8, message: 'm', detail: { sentences: ['z'], maxLen: 5 } }] },
  ]);
  const groups = groupQueue(q.items, { mutatingRules: MUTATING });
  assert.equal(groups[0]!.topRisk, 13.2);
  assert.equal(groups[0]!.rules[0], 'FACT-01');
});

test('动作不统一的组不给"全部应用"（宁可少给一个按钮，也不做半对的事）', () => {
  const q = buildRiskQueue([
    { chapter: '第一章', segIndex: 1, source: 's', rewritten: 's', problems: [
      { ruleId: 'ANNO-01', category: '加注', severity: 'blocker', weight: 10, risk: 10, message: 'm', detail: { missing: ['barn'] } },
      { ruleId: 'ANNO-03', category: '加注', severity: 'warn', weight: 9, risk: 6.3, message: 'm', detail: { conflicts: [{ word: 'barn', zh: '仓房', expected: '谷仓' }] } },
    ] },
  ]);
  const groups = groupQueue(q.items, { mutatingRules: MUTATING });
  assert.equal(groups[0]!.count, 2);
  assert.equal(groups[0]!.uniformAction, false, '同一个词但两种动作 → 只能逐条');
});

test('批量应用前说清影响面（会改动多少处 / 多少段 / 多少章）', () => {
  const q = buildRiskQueue([
    { chapter: '第一章', segIndex: 0, source: 's', rewritten: 's', problems: [{ ruleId: 'ANNO-01', category: '加注', severity: 'blocker', weight: 10, risk: 10, message: 'm', detail: { missing: ['barn'] } }] },
    { chapter: '第二章', segIndex: 4, source: 's', rewritten: 's', problems: [{ ruleId: 'ANNO-01', category: '加注', severity: 'blocker', weight: 10, risk: 10, message: 'm', detail: { missing: ['barn'] } }] },
  ]);
  const g = groupQueue(q.items, { mutatingRules: MUTATING })[0]!;
  const text = batchImpact(g);
  assert.match(text, /改动 2 处/);
  assert.match(text, /2 段/);
  assert.match(text, /2 章/);
});

test('「本次完成」只看"还有没有未处理的条目"，不看估时', () => {
  const q = buildRiskQueue([
    { chapter: '第一章', segIndex: 0, source: 's', rewritten: 's', problems: [{ ruleId: 'ANNO-01', category: '加注', severity: 'blocker', weight: 10, risk: 10, message: 'm', detail: { missing: ['barn'] } }] },
  ]);
  const groups = groupQueue(q.items, { mutatingRules: MUTATING });
  const pending = sessionState(q.items, groups);
  assert.equal(pending.done, false);
  assert.match(pending.text, /还没完：剩 1 条/);
  assert.match(pending.text, /可批量/);

  const finished = sessionState([], []);
  assert.equal(finished.done, true);
  assert.match(finished.text, /本次完成/);
});
