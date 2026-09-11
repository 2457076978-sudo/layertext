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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { batchImpact, batchPreview, buildRiskQueue, groupQueue, oneHourPlan, sessionState, type RiskItem, type SegmentRiskInput, type TaskGroup } from '../src/core/riskqueue.js';
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
      problems: fact(
        '[P01] The animals met in the barn. [P02] In 1911 Napoleon gave a speech. [P03] Everyone listened quietly.',
        '[P01] The animals met in the barn. [P02] The pig gave a speech. [P03] Everyone listened quietly.',
      )[0],
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
      problems: [{ ruleId: 'FACT-01', category: '事实', severity: 'warn', weight: 22, risk: 13.2, message: '数字丢失', detail: { signals: ['2'] } }],
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
      problems: [{ ruleId: 'ANNO-01', category: '加注', severity: 'blocker', weight: 10, risk: 10, message: '漏注', detail: { missing: ['windmill', 'curdling'] } }],
    },
  ]);
  assert.equal(q.items.length, 2);
  assert.deepEqual(q.items.map((i) => i.id).sort(), ['第三章#0:ANNO-01:curdling', '第三章#0:ANNO-01:windmill']);
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
  assert.equal(
    plan.phases[1].items.every((i) => i.category === '事实'),
    true,
    '第二阶段只放事实类',
  );
});

test('小队列不报警，给的是照单子走的建议', () => {
  const q = buildRiskQueue([
    {
      chapter: '第一章',
      segIndex: 0,
      source: '[P01] A cat sat.',
      rewritten: '[P01] A cat sat 5 times.',
      problems: [{ ruleId: 'ANNO-02', category: '加注', severity: 'warn', weight: 5, risk: 4.5, message: '重复注释', detail: { words: ['cat'] } }],
    },
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
  assert.deepEqual(
    q.items.map((i) => i.segLabel),
    ['第一章 第2段', '第一章 第6段', '第二章 第4段'],
  );
});

/* ────────────────── 任务组：卡片流 → 一次处理一类（v4 方向第 3 条） ────────────────── */

const MUTATING = ['ANNO-01', 'ANNO-02', 'ANNO-03', 'AST-02'];

/** 真实样本：Animal Farm A 层第一章，`摘要.total === 70`（《总计划》阶段 2 的验收就是拿它比的） */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
function realQueue(): RiskItem[] {
  const raw = JSON.parse(readFileSync(join(REPO_ROOT, 'tests', 'fixtures', '风险队列_A层85_70条.json'), 'utf-8')) as {
    队列: RiskItem[];
  };
  return raw.队列;
}

test('聚合优先级：同一词 → 同一段同一规则 → 同章同类型', () => {
  const q = buildRiskQueue([
    // 同一个词（windmill）在三个不同段里漏注 → 一组
    {
      chapter: '第一章',
      segIndex: 0,
      source: 'a',
      rewritten: 'a',
      problems: [{ ruleId: 'ANNO-01', category: '加注', severity: 'blocker', weight: 10, risk: 10, message: 'm', detail: { missing: ['windmill'] } }],
    },
    {
      chapter: '第一章',
      segIndex: 3,
      source: 'b',
      rewritten: 'b',
      problems: [{ ruleId: 'ANNO-01', category: '加注', severity: 'blocker', weight: 10, risk: 10, message: 'm', detail: { missing: ['windmill'] } }],
    },
    {
      chapter: '第二章',
      segIndex: 1,
      source: 'c',
      rewritten: 'c',
      problems: [{ ruleId: 'ANNO-01', category: '加注', severity: 'blocker', weight: 10, risk: 10, message: 'm', detail: { missing: ['windmill'] } }],
    },
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
    {
      chapter: '第一章',
      segIndex: 2,
      source: 'In 1911 there were 12 pigs.',
      rewritten: 'Some pigs.',
      problems: [{ ruleId: 'FACT-01', category: '事实', severity: 'warn', weight: 22, risk: 13.2, message: 'm', detail: { signals: ['1911', '12'] } }],
    },
  ]);
  const groups = groupQueue(q.items, { mutatingRules: MUTATING });
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.kind, 'segment-rule', '同段的两个数字归一组，不是散成两张卡');
  assert.equal(groups[0]!.count, 2);
  assert.equal(groups[0]!.uniformAction, false, '事实类不改正文，不给"全部应用"');
});

test('同章同类型的散项归一组（语言类）', () => {
  const q = buildRiskQueue([
    {
      chapter: '第一章',
      segIndex: 0,
      source: 's',
      rewritten: '[P01] a',
      problems: [{ ruleId: 'SENT-01', category: '语言', severity: 'blocker', weight: 8, risk: 8, message: 'm', detail: { sentences: ['a'], maxLen: 5 } }],
    },
    {
      chapter: '第一章',
      segIndex: 5,
      source: 's',
      rewritten: '[P06] b',
      problems: [{ ruleId: 'SENT-01', category: '语言', severity: 'blocker', weight: 8, risk: 8, message: 'm', detail: { sentences: ['b'], maxLen: 5 } }],
    },
  ]);
  const groups = groupQueue(q.items, { mutatingRules: MUTATING });
  // 两段各只有一条超长句：第二档（同段同规则）聚不起来，正是第三档"同章同类型"该接的散项。
  // 老实现里第三档被上一档的守卫挡死，这里会散成 2 组、kind 全是 'segment-rule'——
  // 用例名说的和断言说的不是一回事，改完两边才对齐。
  assert.equal(groups.length, 1, '同章的两条散项归一组，不是散成两张卡');
  assert.equal(groups[0]!.kind, 'chapter-category', '走第三档：同章同类型的散项（老实现这一档是死代码，永远产不出）');
  assert.equal(groups[0]!.count, 2);
  assert.equal(groups[0]!.id, 'ch:第一章:语言');
});

test('代表样本最多 3 条（报告给的数），组里其余靠展开看', () => {
  const problems = Array.from({ length: 7 }, (_, i) => ({
    chapter: '第一章',
    segIndex: i,
    source: 's',
    rewritten: 's',
    problems: [{ ruleId: 'ANNO-01', category: '加注' as const, severity: 'blocker' as const, weight: 10, risk: 10, message: 'm', detail: { missing: ['barn'] } }],
  }));
  const groups = groupQueue(buildRiskQueue(problems).items, { mutatingRules: MUTATING });
  assert.equal(groups[0]!.samples.length, 3);
  assert.equal(groups[0]!.items.length, 7, '展开能拿到全部');
});

test('组间排序按组内最高风险（事实类那组排在语言类前面）', () => {
  const q = buildRiskQueue([
    {
      chapter: '第一章',
      segIndex: 0,
      source: 'In 1911 x',
      rewritten: 'y',
      problems: [{ ruleId: 'FACT-01', category: '事实', severity: 'warn', weight: 22, risk: 13.2, message: 'm', detail: { signals: ['1911'] } }],
    },
    {
      chapter: '第一章',
      segIndex: 9,
      source: 's',
      rewritten: '[P10] z',
      problems: [{ ruleId: 'SENT-01', category: '语言', severity: 'blocker', weight: 8, risk: 8, message: 'm', detail: { sentences: ['z'], maxLen: 5 } }],
    },
  ]);
  const groups = groupQueue(q.items, { mutatingRules: MUTATING });
  assert.equal(groups[0]!.topRisk, 13.2);
  assert.equal(groups[0]!.rules[0], 'FACT-01');
});

test('动作不统一的组不给"全部应用"（宁可少给一个按钮，也不做半对的事）', () => {
  const q = buildRiskQueue([
    {
      chapter: '第一章',
      segIndex: 1,
      source: 's',
      rewritten: 's',
      problems: [
        { ruleId: 'ANNO-01', category: '加注', severity: 'blocker', weight: 10, risk: 10, message: 'm', detail: { missing: ['barn'] } },
        { ruleId: 'ANNO-03', category: '加注', severity: 'warn', weight: 9, risk: 6.3, message: 'm', detail: { conflicts: [{ word: 'barn', zh: '仓房', expected: '谷仓' }] } },
      ],
    },
  ]);
  const groups = groupQueue(q.items, { mutatingRules: MUTATING });
  assert.equal(groups[0]!.count, 2);
  assert.equal(groups[0]!.uniformAction, false, '同一个词但两种动作 → 只能逐条');
});

test('批量应用前说清影响面（会改动多少处 / 多少段 / 多少章）', () => {
  const q = buildRiskQueue([
    {
      chapter: '第一章',
      segIndex: 0,
      source: 's',
      rewritten: 's',
      problems: [{ ruleId: 'ANNO-01', category: '加注', severity: 'blocker', weight: 10, risk: 10, message: 'm', detail: { missing: ['barn'] } }],
    },
    {
      chapter: '第二章',
      segIndex: 4,
      source: 's',
      rewritten: 's',
      problems: [{ ruleId: 'ANNO-01', category: '加注', severity: 'blocker', weight: 10, risk: 10, message: 'm', detail: { missing: ['barn'] } }],
    },
  ]);
  const g = groupQueue(q.items, { mutatingRules: MUTATING })[0]!;
  const text = batchImpact(g);
  assert.match(text, /改动 2 处/);
  assert.match(text, /2 段/);
  assert.match(text, /2 章/);
});

test('「本次完成」只看"还有没有未处理的条目"，不看估时', () => {
  const q = buildRiskQueue([
    {
      chapter: '第一章',
      segIndex: 0,
      source: 's',
      rewritten: 's',
      problems: [{ ruleId: 'ANNO-01', category: '加注', severity: 'blocker', weight: 10, risk: 10, message: 'm', detail: { missing: ['barn'] } }],
    },
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

/* ───────── 阶段 2 验收：真实样本 70 条 ≤ 25 组（《LayerText工程优化总计划》「任务工作台」） ───────── */

test('只出现一次的词不建"同一个词"组（那不是同一词，是一张卡片套了个组的壳）', () => {
  const two = buildRiskQueue([
    {
      chapter: '第一章',
      segIndex: 0,
      source: 's',
      rewritten: 's',
      problems: [{ ruleId: 'ANNO-01', category: '加注', severity: 'blocker', weight: 10, risk: 10, message: 'm', detail: { missing: ['abolished'] } }],
    },
    {
      chapter: '第一章',
      segIndex: 1,
      source: 's',
      rewritten: 's',
      problems: [{ ruleId: 'ANNO-01', category: '加注', severity: 'blocker', weight: 10, risk: 10, message: 'm', detail: { missing: ['adopt'] } }],
    },
  ]);
  const spare = groupQueue(two.items, { mutatingRules: MUTATING });
  // 老实现对任何带词的条目都先建 word 组，这两个生僻词各成一组（2 组）——
  // 真实样本 44 条漏注里 36 个词只出现一次，正是 55 组压不下来的根因。
  assert.equal(spare.length, 1, '两个只出现一次的词不该各占一组');
  assert.equal(spare[0]!.kind, 'chapter-category', '聚不起来的条目往下掉，由"同章同类型"接住');
  assert.equal(spare[0]!.count, 2);

  // 真的重复出现（同章两段各一次）才算"同一个词"
  const recurring = buildRiskQueue([
    {
      chapter: '第一章',
      segIndex: 0,
      source: 's',
      rewritten: 's',
      problems: [{ ruleId: 'ANNO-01', category: '加注', severity: 'blocker', weight: 10, risk: 10, message: 'm', detail: { missing: ['abolished'] } }],
    },
    {
      chapter: '第一章',
      segIndex: 6,
      source: 's',
      rewritten: 's',
      problems: [{ ruleId: 'ANNO-01', category: '加注', severity: 'blocker', weight: 10, risk: 10, message: 'm', detail: { missing: ['abolished', 'adopt'] } }],
    },
  ]);
  const groups = groupQueue(recurring.items, { mutatingRules: MUTATING });
  const word = groups.find((g) => g.id === 'word:abolished');
  assert.ok(word, '出现两次的词必须成组');
  assert.equal(word.kind, 'word');
  assert.equal(word.count, 2);
  assert.deepEqual(word.segments, ['第一章 第1段', '第一章 第7段']);
});

test('真实样本（A 层第一章 70 条）必须压到 25 组以内，且三档都要真的在用', () => {
  const items = realQueue();
  assert.equal(items.length, 70, '样本就是阶段 2 拿来比的那 70 条');
  assert.deepEqual(
    items.reduce<Record<string, number>>((acc, i) => ({ ...acc, [i.ruleId]: (acc[i.ruleId] ?? 0) + 1 }), {}),
    { 'FACT-02': 2, 'ANNO-01': 44, 'SENT-01': 19, 'LEN-01': 4, 'ANNO-02': 1 },
    '规则分布要跟台账一致，否则这个样本就不是那个样本了',
  );

  const groups = groupQueue(items, { mutatingRules: MUTATING });
  const tier = (k: TaskGroup['kind']): number => groups.filter((g) => g.kind === k).length;
  // 老实现：55 组（word 39 / segment-rule 16 / chapter-category 0）——验收「不超过 25 个任务组」直接不合格。
  assert.equal(groups.length, 19, `实测 19 组（word ${tier('word')} / segment-rule ${tier('segment-rule')} / chapter-category ${tier('chapter-category')}），老实现是 55 组`);
  assert.ok(groups.length <= 25, '阶段 2 验收：70 条原始问题至少压缩为不超过 25 个任务组');
  assert.deepEqual(
    { word: tier('word'), 'segment-rule': tier('segment-rule'), 'chapter-category': tier('chapter-category') },
    { word: 3, 'segment-rule': 13, 'chapter-category': 3 },
    '三档的分布；chapter-category 必须 > 0——老实现这一档是死代码，产出恒为 0',
  );

  // 组数上界 = 真的重复出现的词数 + 真的聚起来的段规则数 + 章数 × 类别数（= 第三档的兜底）
  const wordFreq = new Map<string, number>();
  for (const it of items) {
    const w = typeof it.detail?.word === 'string' ? it.detail.word.toLowerCase() : '';
    if (w) wordFreq.set(w, (wordFreq.get(w) ?? 0) + 1);
  }
  const recurring = [...wordFreq.values()].filter((n) => n >= 2).length;
  const cats = new Set(items.map((i) => `${i.chapter}:${i.category}`)).size;
  assert.ok(groups.length <= recurring + 13 + cats, '组数不该超过"重复词 + 聚集的段规则 + 章 × 类别"这个上界');
  assert.equal(19, recurring + 13 + cats, `上界本身要算得准：重复词 ${recurring} + 聚集段规则 13 + 章 × 类别 ${cats}`);

  // 前两档认领的组一定至少两条（不然"同一词/同一段同类"就成了空话）；散项只走第三档
  for (const g of groups.filter((x) => x.kind !== 'chapter-category')) {
    assert.ok(g.count >= 2, `${g.id} 只有 ${g.count} 条，不该被前两档认领`);
  }
  assert.equal(
    groups.reduce((n, g) => n + g.count, 0),
    70,
    '分组是一次划分：每条都要落在且只落在一个组里',
  );
  assert.equal(new Set(groups.flatMap((g) => g.items.map((i) => i.id))).size, 70, '不能有重复归组');
  assert.ok(
    groups.every((g) => g.samples.length <= 3),
    '代表样本默认 3 条',
  );
  assert.equal(groups.find((g) => g.id === 'ch:第一章:语言')!.samples.length, 3, '8 条的语言类散项组也只给 3 条代表例');
  assert.equal(groups.find((g) => g.id === 'word:comrades')!.count, 4, '4 条同一个词的漏注仍然是同一组');
});

test('单章散项最多「章 × 类别」个组：一条一组的卡片流不允许再出现', () => {
  const mk = (i: number, ruleId: string, category: '事实' | '加注' | '语言' | '格式'): SegmentRiskInput => ({
    chapter: '第一章',
    segIndex: i,
    source: '[P01] s',
    rewritten: '[P01] s',
    problems: [
      {
        ruleId,
        category,
        severity: 'warn',
        weight: 10,
        risk: 10,
        message: 'm',
        detail:
          ruleId === 'FACT-01' ? { signals: [`19${10 + i}`] } : ruleId === 'SENT-01' ? { sentences: [`a very long sentence ${i}`], maxLen: 5 } : ruleId === 'ANNO-01' ? { missing: [`word${i}`] } : {},
      },
    ],
  });
  // 20 条散项：20 个段、20 个互不重复的词、4 个类别 → 老实现是 20 组，新实现必须收敛到 4 组
  const segs: SegmentRiskInput[] = [];
  for (let i = 0; i < 20; i++) segs.push(mk(i, ['FACT-01', 'ANNO-01', 'SENT-01', 'ZH-01'][i % 4]!, (['事实', '加注', '语言', '格式'] as const)[i % 4]!));
  const items = buildRiskQueue(segs).items;
  const groups = groupQueue(items, { mutatingRules: MUTATING });
  assert.equal(items.length, 20);
  assert.equal(groups.length, 4, '散项按"同章同类型"兜底，上限就是 章 × 类别');
  assert.ok(groups.every((g) => g.kind === 'chapter-category'));
  assert.ok(groups.length <= items.length, '兜底保证：组数永远不会超过条数');
  assert.equal(
    groups.reduce((n, g) => n + g.count, 0),
    20,
  );
});

/* ───────── 阶段 2 验收：批量动作前能列出将改变的词 / 段（batchPreview） ───────── */

test('批量预览列出将改动的词与段（不是只给"改动 N 处"三个数）', () => {
  const items = realQueue();
  const g = groupQueue(items, { mutatingRules: MUTATING }).find((x) => x.id === 'word:straw')!;
  const p = batchPreview(g);
  assert.equal(p.batchable, true);
  assert.deepEqual(p.words, ['straw'], '"将改变的词"要真的是词，不是计数');
  assert.deepEqual(p.segments, ['第一章 第4段', '第一章 第8段', '第一章 第14段'], '"将改变的段"要列出段标签本身');
  assert.deepEqual(p.chapters, ['第一章']);
  assert.equal(p.changes.length, 1, '同一个词只算一处改动');
  assert.equal(p.changes[0]!.count, 3);
  assert.equal(p.changes[0]!.kind, 'word');
  assert.match(p.text, /「straw」/);
  assert.match(p.text, /3 段/);
  assert.match(p.lines[0]!, /straw/);
  assert.match(p.lines[0]!, /第一章 第4段/);
  assert.match(p.lines[0]!, /第一章 第14段/);
  assert.notEqual(p.changes[0]!.before, p.changes[0]!.after, '要能看见"改动前 → 改动后"，两边一样就说明没取到文本');
  assert.ok(p.changes[0]!.before.length > 0 && p.changes[0]!.after.length > 0);
  // batchImpact 仍是老口径那句话（其他代码在用），但段/章数取自预览
  assert.match(batchImpact(g), /^全部应用会改动 3 处，涉及 3 段、1 章$/);
});

test('批量预览：detail 里带了整段就用整段，没带才退回 item 上的原句', () => {
  const withDetail = buildRiskQueue([
    {
      chapter: '第一章',
      segIndex: 0,
      source: 's',
      rewritten: 's',
      problems: [{ ruleId: 'ANNO-01', category: '加注', severity: 'blocker', weight: 10, risk: 10, message: 'm', detail: { missing: ['barn'], source: '整段原文', rewritten: '整段改写' } }],
    },
  ]);
  const a = batchPreview(groupQueue(withDetail.items, { mutatingRules: MUTATING })[0]!);
  assert.equal(a.changes[0]!.before, '整段原文');
  assert.equal(a.changes[0]!.after, '整段改写');

  const noDetail = buildRiskQueue([
    {
      chapter: '第一章',
      segIndex: 0,
      source: '[P01] The barn was big.',
      rewritten: '[P01] The barn was huge.',
      problems: [{ ruleId: 'ANNO-01', category: '加注', severity: 'blocker', weight: 10, risk: 10, message: 'm', detail: { missing: ['barn'] } }],
    },
  ]);
  const b = batchPreview(groupQueue(noDetail.items, { mutatingRules: MUTATING })[0]!);
  assert.match(b.changes[0]!.before, /The barn was big/);
  assert.match(b.changes[0]!.after, /The barn was huge/);
});

test('批量预览不假装有批量：没确定性动作 / 组内动作不统一时都给不出清单', () => {
  // 事实类：要回原文核对，没有确定性修法
  const facts = buildRiskQueue([
    {
      chapter: '第一章',
      segIndex: 2,
      source: 'In 1911 there were 12 pigs.',
      rewritten: 'Some pigs.',
      problems: [{ ruleId: 'FACT-01', category: '事实', severity: 'warn', weight: 22, risk: 13.2, message: 'm', detail: { signals: ['1911', '12'] } }],
    },
  ]);
  const fg = groupQueue(facts.items, { mutatingRules: MUTATING })[0]!;
  const fp = batchPreview(fg);
  assert.equal(fp.batchable, false);
  assert.deepEqual(fp.changes, []);
  assert.deepEqual(fp.words, []);
  assert.match(fp.text, /都没有确定性修法/);

  // 同一个词、两种动作 → 界面上根本没有"全部应用"按钮，预览就不该报"将改动 N 处"
  const mixed = buildRiskQueue([
    {
      chapter: '第一章',
      segIndex: 1,
      source: 's',
      rewritten: 's',
      problems: [
        { ruleId: 'ANNO-01', category: '加注', severity: 'blocker', weight: 10, risk: 10, message: 'm', detail: { missing: ['barn'] } },
        { ruleId: 'ANNO-03', category: '加注', severity: 'warn', weight: 9, risk: 6.3, message: 'm', detail: { conflicts: [{ word: 'barn', zh: '仓房', expected: '谷仓' }] } },
      ],
    },
  ]);
  const mg = groupQueue(mixed.items, { mutatingRules: MUTATING })[0]!;
  assert.equal(mg.uniformAction, false, '前提：动作不统一的组不给批量');
  const mp = batchPreview(mg);
  assert.equal(mp.batchable, false);
  assert.deepEqual(mp.changes, []);
  assert.match(mp.text, /动作不统一/);
  // 老 batchImpact 对"动作不统一"的组照样报「全部应用会改动 2 处」——按钮都没有，那是个假承诺
  assert.doesNotMatch(batchImpact(mg), /全部应用会改动/);
});

test('真实样本里的散项组：批量预览给出的段标签与组自身一致', () => {
  const g = groupQueue(realQueue(), { mutatingRules: MUTATING }).find((x) => x.id === 'ch:第一章:加注')!;
  assert.equal(g.count, 6);
  assert.equal(g.uniformAction, false, '组里混了漏注与重复注两种动作 → 不给批量（保留原有约束）');
  assert.equal(batchPreview(g).batchable, false);
  assert.deepEqual(batchPreview(g).segments, [], '给不出批量就不列清单，免得教师以为点一下就能改掉这 6 条');
});
