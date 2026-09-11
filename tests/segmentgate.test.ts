/**
 * 段级门禁 + 注释 token 解析 回归测试
 *
 * 对应《LayerText 项目审查报告（2026-09-11）》：
 *   · P0：确定性门禁必须真正阻止错误产物被视为完成 —— 见 tests/pipeline_gate.test.ts 的集成断言
 *   · 第③条：加注覆盖率不能按字符串正则统计（大小写/词形/连字符/同形异义会假通过）
 *   · 第④条：known 并入复现词后必须能单独报告"原始 OOV"与"复现豁免 OOV"
 *
 * 这些用例是**验收标准**：改动 GATE_RULES / gateSegment / parseAnnotations 时若破坏它们，
 * 说明"人一眼能看出的坏产物"又能静默通关了。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chineseOutsideAnnotations, duplicateRate, parseAnnotations } from '../src/core/annot.js';
import {
  GATE_RULES,
  gateSegment,
  normalizeSegmentBody,
  stripMarkers,
  wordCount,
  type SegmentGateInput,
} from '../src/core/segmentgate.js';

const gate = (over: Partial<SegmentGateInput>) =>
  gateSegment({ text: '[P01] The boy ran.', source: '[P01] The boy ran.', target: 5, maxLen: 20, oov: [], ...over });

/* ────────────────── 注释 token 解析（审查报告第③条） ────────────────── */

test('注释解析：保留原词与释义（报告要求"保存原词"）', () => {
  const idx = parseAnnotations('[P01] The Boxer（拳击手） ran to the windmill（风车）.');
  assert.deepEqual(
    idx.list.map((a) => [a.word, a.zh]),
    [['Boxer', '拳击手'], ['windmill', '风车']],
  );
  assert.equal(idx.list[0].index > 0, true, '下标应是原词在正文中的位置');
});

test('③大小写归一：注释写 Boxer、引擎判 boxer，算已注（原先各自为政）', () => {
  const idx = parseAnnotations('[P01] Boxer（拳击手） was there.');
  assert.equal(idx.covers('boxer'), true);
  assert.equal(idx.covers('Boxer'), true);
});

test('③词形归一：注了 trembled 就算 tremble 已注，反向同理', () => {
  const a = parseAnnotations('[P01] He trembled（发抖） and stopped.');
  assert.equal(a.covers('tremble'), true, '屈折形已注 → 原形算已注');
  const b = parseAnnotations('[P01] He began to tremble（发抖） a little.');
  assert.equal(b.covers('trembled'), true, '原形已注 → 屈折形算已注');
});

test('③连字符归一：blood-curdling 已注 → 成分 curdling 算已注', () => {
  const idx = parseAnnotations('[P01] It was a blood-curdling（令人毛骨悚然的） cry.');
  assert.equal(idx.covers('curdling'), true);
  assert.equal(idx.covers('blood-curdling'), true);
});

test('③同形异义不再假通过：释义与统一词典冲突要报出来', () => {
  const dict = new Map([['boxer', '拳师']]);
  const ok = parseAnnotations('[P01] Boxer（拳师） was strong.', dict);
  assert.equal(ok.conflicts.length, 0, '一致 → 无冲突');
  const bad = parseAnnotations('[P01] Boxer（狗） was strong.', dict);
  assert.equal(bad.conflicts.length, 1, '同一词注了另一个释义 → 必须报冲突');
  assert.equal(bad.conflicts[0].expected, '拳师');
});

test('释义等价判定：括注与标点差异不算冲突（避免把噪音当问题）', () => {
  const dict = new Map([['tremble', '发抖']]);
  assert.equal(parseAnnotations('[P01] tremble（（使）发抖） there', dict).conflicts.length, 0);
  assert.equal(parseAnnotations('[P01] tremble（发抖，哆嗦） there', dict).conflicts.length, 0);
});

test('重复注释：同词注第二次起要算多余（正文注释唯一性）', () => {
  const d = duplicateRate('[P01] Boxer（拳击手） and Boxer（拳击手） and windmill（风车）.');
  assert.equal(d.total, 3);
  assert.equal(d.extra, 1, '第二次 Boxer 是多余注释');
  assert.equal(d.rate, 1 / 3);
});

test('注释外的中文是格式红线（注释内的中文不算）', () => {
  assert.deepEqual(chineseOutsideAnnotations('[P01] He ran fast（快地）.') , []);
  assert.deepEqual(chineseOutsideAnnotations('[P01] 他 ran fast.'), ['他']);
});

/* ────────────────── 段级门禁：blocker 语义 ────────────────── */

test('P0：永远超长的响应 → needs-review（篇幅 + 句长双阻塞）', () => {
  const long = `[P01] ${Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ')}.`;
  const v = gate({ text: long, target: 17, maxLen: 20 });
  assert.equal(v.status, 'needs-review', '超长段绝不能被当成通过');
  assert.deepEqual(v.blockers.map((p) => p.ruleId).sort(), ['LEN-01', 'SENT-01']);
  assert.equal(v.words, 121);
  assert.equal(v.overLen, 1);
});

test('P0：漏注的超纲词是 blocker（不可完成）', () => {
  const v = gate({ text: '[P01] The boy ran.', oov: ['windmill'], target: 4 });
  assert.equal(v.status, 'needs-review');
  assert.deepEqual(v.blockers.map((p) => p.ruleId), ['ANNO-01']);
  assert.deepEqual(v.annotation.missing, ['windmill']);
  assert.equal(v.annotation.coverage, 0);
});

test('P0：注了就通过（含词形归一命中）', () => {
  const v = gate({ text: '[P01] The boy saw a windmill（风车） and smiled.', oov: ['windmill'], target: 9, maxLen: 20 });
  assert.equal(v.status, 'pass');
  assert.equal(v.annotation.coverage, 1);
  assert.equal(v.annotation.annotated, 1);
});

test('P0：正文混入中文是 blocker', () => {
  const v = gate({ text: '[P01] The boy 跑了 fast.', target: 4 });
  assert.equal(v.status, 'needs-review');
  assert.deepEqual(v.blockers.map((p) => p.ruleId), ['ZH-01']);
});

test('事实类只 warn 不阻塞：数字/专名丢失进风险队列，但仍算通过', () => {
  const v = gate({
    text: '[P01] The animals worked hard.',
    source: '[P01] In 1911 Napoleon and the animals worked hard.',
    target: 5,
  });
  assert.equal(v.status, 'pass', '机器判不准的事实差异不能阻塞完成');
  const ids = v.warns.map((p) => p.ruleId).sort();
  assert.deepEqual(ids, ['FACT-01', 'FACT-02']);
  const sig = v.warns.find((p) => p.ruleId === 'FACT-01')?.detail?.signals as string[] | undefined;
  assert.equal(sig?.includes('1911'), true, '数字 1911 必须被抽出作为事实信号');
});

test('重复注释与释义冲突是 warn，不是 blocker', () => {
  const v = gate({
    text: '[P01] Boxer（拳击手） met Boxer（拳击手） again.',
    target: 5,
    dict: new Map([['boxer', '狗']]),
  });
  assert.equal(v.status, 'pass');
  assert.deepEqual(v.warns.map((p) => p.ruleId).sort(), ['ANNO-02', 'ANNO-03']);
});

/* ────────────────── 规则表本身是唯一口径 ────────────────── */

test('规则表：四条 blocker 恰好是篇幅/句长/漏注/中文，其余都是 warn', () => {
  const all = Object.values(GATE_RULES);
  const blockers = all.filter((r) => r.severity === 'blocker').map((r) => r.id).sort();
  assert.deepEqual(blockers, ['ANNO-01', 'LEN-01', 'SENT-01', 'ZH-01']);
  // 规则号前缀必须与风险类别对得上（风险队列按类别渲染时依赖这一点）
  assert.deepEqual(
    all.filter((r) => r.id.startsWith('FACT')).map((r) => r.category),
    ['事实', '事实'],
  );
  assert.deepEqual(
    all.filter((r) => r.id.startsWith('ANNO')).map((r) => r.category),
    ['加注', '加注', '加注'],
  );
  for (const r of all) assert.equal(typeof r.weight, 'number');
  // 事实类权重必须最高（风险 = 概率 × 后果 里的"后果"）
  const maxWarn = Math.max(...all.filter((r) => r.severity === 'warn').map((r) => r.weight));
  assert.equal(maxWarn, GATE_RULES['FACT-01'].weight);
});

test('判定是纯函数：同一输入永远同一结论（可回放、可单测）', () => {
  const input: SegmentGateInput = { text: '[P01] He ran to the windmill.', source: '[P01] He ran to the mill in 1900.', target: 6, maxLen: 20, oov: ['windmill'] };
  const a = gateSegment(input);
  const b = gateSegment(input);
  assert.deepEqual(a, b);
});

test('normalizeSegmentBody：去掉「查词」回合标记、补/纠正段号（段号是段落对齐的稳定 ID）', () => {
  assert.equal(normalizeSegmentBody('He ran.【查 windmill】'), '[P01] He ran.');
  assert.equal(normalizeSegmentBody('[P07] He ran.'), '[P07] He ran.');
  // 模型漏写或写错段号时必须纠正：否则产物里出现重复段号，
  // 台账/风险队列按标记配对会整体错位（把第 8 段的原句配到第 7 段的改写上）
  assert.equal(normalizeSegmentBody('He ran.', 'P09'), '[P09] He ran.');
  assert.equal(normalizeSegmentBody('[P01] He ran.', 'P09'), '[P09] He ran.');
});

test('段标记不参与事实信号：不会报「原文的 03 在改写里找不到」', () => {
  const v = gateSegment({
    text: '[P03] The animals met in the barn.',
    source: '[P03] The animals met in the barn.',
    target: 7,
    maxLen: 20,
    oov: [],
  });
  assert.deepEqual(v.warns.map((p) => p.ruleId), [], '同一段去的段标记后不该有任何假警报');
  assert.deepEqual(stripMarkers('[P03] The animals.'), '  The animals.');
});

test('wordCount：[P01] 标记里的 P 也计入（与管线各处口径一致）', () => {
  assert.equal(wordCount('[P01] The boy ran.'), 4);
});
