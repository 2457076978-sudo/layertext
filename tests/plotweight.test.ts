/**
 * 情节先验（plotSignalScore）回归测试
 *
 * 验收标准（《LayerText 审查报告 v4_方向》）：
 *   「可以部分估算，但**不能冒充事实判断**。用全书底线中的人物、地点、事件动词和数字做句子对齐，
 *     得到 plotSignalScore；再以『事件数、角色数、因果连接词、章节转折位置』加权，
 *     作为排序的 tie-breaker，**不能升级为 blocker**。卡片必须显示『机器估计：高/中/低』
 *     和命中的底线条目，教师仍作最终判断。」
 *
 * 三件事必须锁死：① 只做 tie-breaker，不改 risk、不拦截；② 命中项要能贴给人看；
 * ③ 拿不到底线时"没算"≠"低"。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractAnchors,
  extractExplicitAnchors,
  parsePlotBaseline,
  plotLine,
  plotSignalOf,
  plotTieBreak,
  PLOT_LEVELS,
} from '../src/core/plotweight.js';
import { buildRiskQueue } from '../src/core/riskqueue.js';
import { GATE_RULES } from '../src/core/segmentgate.js';

const BASELINE = parsePlotBaseline(
  [
    '# 底线',
    '',
    '### A层 · 事件链（不可删）',
    '1. 老少校的演讲与《Beasts of England》（革命理论来源）',
    '终局：农场改名回 Manor Farm',
    '',
    '锚点：windmill、gun',
    '',
    'B层：鲍克瑟口头禅 "I will work harder"；"All animals are equal"',
  ].join('\n'),
  ['Boxer', 'Napoleon', 'Snowball', 'Jones'],
  '底线样例.md',
);

/* ────────────────── 抽取 ────────────────── */

test('自动抽取：引号内/书名号内/连续拉丁词都算锚点', () => {
  const a = extractAnchors('写"All animals are equal"、《Beasts of England》、以及 Manor Farm 这个名字');
  assert.equal(a.includes('all animals are equal'), true);
  assert.equal(a.includes('beasts of england'), true);
  assert.equal(a.includes('manor farm'), true);
});

test('抽取清洗：掐头去尾是功能词的片段丢掉（and slavery 这种命中了对教师没意义）', () => {
  const a = extractAnchors('原文 "misery and slavery" 与 "of the barn"');
  assert.equal(a.includes('and slavery'), false);
  assert.equal(a.includes('of the barn'), false);
  assert.equal(a.includes('misery and slavery'), true, '整体是好的锚点，留着');
});

test('抽取清洗：被更长锚点包含的短片段丢掉（只留最完整那句）', () => {
  const a = extractAnchors('"I have no wish to take life, not even a human life"');
  assert.equal(a.includes('i have no wish to take life, not even a human life'), true);
  assert.equal(a.some((x) => x !== 'i have no wish to take life, not even a human life'), false, '子串不留');
});

test('显式锚点：底线里写 `锚点：windmill、gun`，单词也收（教师知道而机器猜不到的出口）', () => {
  assert.deepEqual(extractExplicitAnchors('## 底线\n\n锚点：windmill、gun\n- 锚点: the wind, gun\n'), ['windmill', 'gun', 'the wind']);
  const b = parsePlotBaseline('锚点：windmill', [], 'x');
  assert.equal(b.anchors.includes('windmill'), true);
});

test('专名表：角色/地名不猜，直接来自机器可读的名单', () => {
  assert.deepEqual(BASELINE.names, ['boxer', 'napoleon', 'snowball', 'jones']);
});

/* ────────────────── 打分 ────────────────── */

test('分数能区分重不重要：底线锚点 + 角色 → 高；什么都没有 → 低', () => {
  const heavy = plotSignalOf('Boxer said, "I will work harder!" and went back.', BASELINE);
  assert.equal(heavy.level, '高');
  const light = plotSignalOf('One evening, a sheep said that the grass tasted nice.', BASELINE);
  assert.equal(light.level, '低');
  assert.equal(PLOT_LEVELS.includes(heavy.level), true);
  assert.equal(heavy.score > light.score, true);
});

test('命中项能贴给人看：说明**凭什么**给这个分（不给依据等于让人信黑盒）', () => {
  const s = plotSignalOf('Boxer carried the windmill stones.', BASELINE);
  assert.equal(s.hits.some((h) => h.includes('windmill')), true, '显式锚点要出现在命中项里');
  assert.equal(s.hits.some((h) => h.includes('boxer')), true, '角色要出现在命中项里');
  assert.equal(s.hits.some((h) => h.startsWith('底线原文锚点：')), true, '要标明命中的是哪一类');
  assert.match(plotLine(plotSignalOf('Nothing here.', BASELINE)), /未命中底线元素/, '没命中时也要给一句人话，不能空白');
});

test('因果连接词与数字各算一项（情节因果链的显式标记）', () => {
  const s = plotSignalOf('The animals worked harder because 9 hens had died.', BASELINE);
  assert.equal(s.parts.find((p) => p.label === '因果连接词')?.hits.includes('because'), true);
  assert.equal(s.parts.find((p) => p.label === '数字')?.hits.includes('9'), true);
});

test('章节转折位置只加一点点：它是这里最弱的一项', () => {
  const mid = plotSignalOf('Ordinary sentence.', BASELINE, { segIndex: 10, segCount: 20 });
  const edge = plotSignalOf('Ordinary sentence.', BASELINE, { segIndex: 0, segCount: 20 });
  assert.equal(edge.score > mid.score, true);
  const positionPart = edge.parts.find((p) => p.label === '章节转折位置')!;
  for (const p of edge.parts) {
    if (p.label !== '章节转折位置') assert.equal(p.weight > positionPart.weight, true, `${p.label} 的权重该高于位置项`);
  }
});

test('分数封顶在 1，且同一句话重复打分结果一致（可复现）', () => {
  const long = 'Boxer said "I will work harder" because 9 animals and Manor Farm and "All animals are equal" and Napoleon and Snowball and Jones.';
  const a = plotSignalOf(long, BASELINE);
  const b = plotSignalOf(long, BASELINE);
  assert.equal(a.score <= 1, true);
  assert.deepEqual(a, b);
});

/* ────────────────── 只做 tie-breaker，不能升级为 blocker ────────────────── */

test('★ 情节分不改变 risk、也不进入规则表：它不是判定', () => {
  const probs = (['FACT-01', 'ANNO-01'] as const).map((id) => ({
    ruleId: id,
    category: GATE_RULES[id].category,
    severity: GATE_RULES[id].severity,
    weight: GATE_RULES[id].weight,
    risk: GATE_RULES[id].weight * GATE_RULES[id].probability,
    message: 'm',
    detail: id === 'ANNO-01' ? { missing: ['windmill'] } : { signals: ['1911'] },
  }));
  const seg = [{ chapter: '第一章', segIndex: 0, source: 'Boxer said "I will work harder" in 1911.', rewritten: 'x', problems: probs }];
  const withPlot = buildRiskQueue(seg, { baseline: BASELINE, segCountOf: () => 20 });
  const without = buildRiskQueue(seg);
  assert.deepEqual(
    withPlot.items.map((i) => i.risk),
    without.items.map((i) => i.risk),
    '情节分不许改动 risk',
  );
  assert.equal((withPlot.items[0]!.plot?.score ?? 0) > 0, true, '但要有 plot 信号');
  assert.equal(without.items[0]!.plot, undefined, '没给底线 = 信号缺席');
});

/** 情节先验按**段**打分：句级会被引号切断成碎片（`Boxer said "…" in 1911.` 切成两半），
 *  而这项先验要回答的是"这一段值不值得先看"。 */
test('★ 同 risk 档内按情节分排：重的先看（tie-breaker 的确切含义）', () => {
  const mk = (source: string) => ({
    chapter: '第一章',
    segIndex: 0,
    source,
    rewritten: 'x',
    problems: [{ ruleId: 'FACT-01' as const, category: '事实' as const, severity: 'warn' as const, weight: 22, risk: 13.2, message: 'm', detail: { signals: ['1911'] } }],
  });
  const q = buildRiskQueue(
    [mk('A sheep ate grass in 1911.'), mk('Boxer said "I will work harder" in 1911.')],
    { baseline: BASELINE, segCountOf: () => 20 },
  );
  assert.equal(q.items[0]!.risk, q.items[1]!.risk, '前提：两条 risk 相同');
  const s0 = q.items[0]!.plot?.score ?? -1;
  const s1 = q.items[1]!.plot?.score ?? -1;
  assert.equal(s0 > s1, true, `情节重的排前面（实得 ${s0} vs ${s1}）`);
  assert.match(q.items[0]!.sourceSentence, /Boxer/);
});

test('plotTieBreak：不同 risk 时情节分完全不起作用', () => {
  const low = { risk: 6, plot: { score: 1, level: '高' as const, hits: [], parts: [] } };
  const high = { risk: 13.2, plot: { score: 0, level: '低' as const, hits: [], parts: [] } };
  assert.equal(plotTieBreak(low, high) > 0, true, 'risk 高的仍然在前，情节分不能翻盘');
  assert.equal(plotTieBreak({ risk: 10, plot: low.plot }, { risk: 10, plot: high.plot }) < 0, true, '同 risk 时情节分才起作用');
});

/* ────────────────── 界面文案 ────────────────── */

test('卡片文案：给等级也给依据；没提供底线时说"没算"，不说"低"', () => {
  assert.match(plotLine(plotSignalOf('Boxer ran.', BASELINE)), /情节估计：.｜命中/);
  assert.match(plotLine(undefined), /未提供底线/);
  assert.match(plotLine(undefined), /不是低/);
  assert.match(plotLine(plotSignalOf('Nothing special happens.', BASELINE, { segIndex: 10, segCount: 20 })), /未命中底线元素/);
});
