/**
 * 两轮调适 R2 修订计划 · 单测（B1 批次①，2026-09-26）
 *
 * 锁 planRound2（从 LayerText_AF两轮调适.mjs 抽取的决策唯一实现）四件事：
 * ① 两轮闸门（验收标准 B）：round:2+终稿在 → 拒绝，理由含人话——App 批次②的按钮
 *    状态机直接消费这个 gate；② 档位折算（幅度→单元回退→退学词，手工词库不动）；
 * ③ 复写范围选定（难度问题段 ∪ 词汇维度段 ∪ 点名词段；整篇级 finding 对每段成立）；
 * ④ simpl 点名词与文字反馈合并。CLI 侧等价证据=合成迷你项目 --plan 新旧逐字节一致
 * （2026-09-26 三次对撞，提交信息留痕）；本文件是回归锚。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planRound2, type Round2Ladder } from '../src/core/round2.js';
import type { CheckFinding } from '../src/core/adaptcheck.js';

const SEGS = ['[P01] The boy ran to the house.', '[P02] The zzxqvw saw a mmbvplk today.', '[P03] Birds sang near the barn.', '[P04] "Never forget the qwertyuiop," he said.'];
/* 含 'p'：段标记 [P##] 的字母 P 会被词法扫描当 token（生产行为，移植忠实保留）——
 * 测试词表把它设为已知，使断言表达"选定语义"而非标记伪影。 */
const KNOWN = new Set(['the', 'boy', 'ran', 'to', 'house', 'birds', 'sang', 'near', 'barn', 'he', 'said', 'a', 'and', 'never', 'forget', 'today', 'saw', 'p']);
const isKnown = (w: string) => KNOWN.has(w);

const baseInput = {
  progressText: null as string | null,
  hasFinal: false,
  feedbackRaw: '词汇太难',
  simplWords: [] as string[],
  findings: [] as CheckFinding[],
  srcSegs: SEGS,
  r1Segs: SEGS,
  progressSet: false,
  ladder: null as Round2Ladder | null,
  isKnownWord: isKnown,
};

test('验收B·两轮闸门：round:2+终稿在 → 拒绝且理由是人话', () => {
  const r = planRound2({ ...baseInput, progressText: '{"round":2,"at":"…"}', hasFinal: true });
  assert.equal(r.gate.ok, false);
  assert.equal(r.exhausted, true);
  assert.match(r.gate.reason, /两轮已用完/);
  assert.match(r.gate.reason, /不再自动重试/);
  assert.match(r.gate.reason, /交教师修改/);
});

test('闸门边界：round:2 但终稿不在 → 放行（没完成就不算用完）；round:1 → 放行', () => {
  assert.equal(planRound2({ ...baseInput, progressText: '{"round":2}', hasFinal: false }).gate.ok, true);
  assert.equal(planRound2({ ...baseInput, progressText: '{"round":1}', hasFinal: true }).gate.ok, true);
});

test('闸门容错：进度文件坏 JSON → 当没有（放行），与旧行为一致', () => {
  const r = planRound2({ ...baseInput, progressText: '{oops', hasFinal: true });
  assert.equal(r.gate.ok, true);
});

const ladder: Round2Ladder = {
  currentIndex: 2,
  labelAt: (i) => (i >= 0 ? `九上U${i + 1}` : '课标基础'),
  wordsAt: (i) =>
    [
      ['k1', 'k2'],
      ['j1', 'j2', 'keepme'],
      ['i1', 'i2'],
    ][i] ?? [],
  learnedAt: (i) => new Set(['base', ...(i >= 0 ? ['k1', 'k2', 'j1', 'j2', 'keepme'].slice(0, i * 2 + 2) : [])]),
  manualWords: new Set(['keepme']),
};

test('档位折算：明显(回退2)→边界九上U3→九上U1；退学词剔除更早边界与手工词库', () => {
  const r = planRound2({ ...baseInput, feedbackRaw: '词汇超前一学期', ladder });
  assert.match(r.boundaryNote, /词汇边界从 九上U3 回退到 九上U1/);
  assert.match(r.boundaryNote, /折算 2 个单元/);
  /* 回退掉 idx1..2：j2(在更早边界=learnedAt(0)含k1k2j1j2？——learnedAt(0)={base,k1,k2}，
   * j1/j2/keepme 是 idx1 的词且不在 learnedAt(0)；keepme 在手工词库不动 → 退学=[j1,j2,i1,i2] */
  assert.deepEqual([...r.removedByLadder].sort(), ['i1', 'i2', 'j1', 'j2']);
});

test('无进度+有幅度 → 如实提示"未设置教材进度"，不假装折算', () => {
  const r = planRound2({ ...baseInput, feedbackRaw: '词汇超前一学期', progressSet: false, ladder: null });
  assert.match(r.boundaryNote, /未设置教材进度/);
});

test('选定：难度 finding 落段（segId 去方括号比对）', () => {
  const findings: CheckFinding[] = [{ level: '难度', segId: 'P02', note: '一句 3 处注释' }];
  const r = planRound2({ ...baseInput, findings });
  assert.deepEqual(r.targets, [1]);
});

test('选定：整篇级难度 finding（无 segId/注释拥挤）对每一段都成立', () => {
  const findings: CheckFinding[] = [{ level: '难度', note: '注释拥挤：每百词 7 处' }];
  const r = planRound2({ ...baseInput, findings });
  assert.deepEqual(r.targets, [0, 1, 2, 3]);
});

test('选定：词汇维度 → 含≥2个超纲词的段进；点名词段必进；信息变化不算难度', () => {
  const findings: CheckFinding[] = [{ level: '信息变化', segId: 'P03', note: '数字变化' }];
  const r = planRound2({ ...baseInput, feedbackRaw: '词汇太难', findings });
  /* P02(zzxqvw,mmbvplk)=2 超纲进；P04(qwertyuiop)=1 个不进且无难度 finding */
  assert.deepEqual(r.targets, [1]);
  const r2 = planRound2({ ...baseInput, feedbackRaw: '词汇太难', findings, simplWords: ['QWERTYUIOP'] });
  assert.deepEqual(r2.targets, [1, 3]);
  assert.match(r2.fb.raw, /（正文标记太难：qwertyuiop）/);
  assert.ok(r2.fb.tooHardWords.includes('qwertyuiop'));
});

test('选定：维度≥4 或反馈含"整体" → 全篇', () => {
  assert.deepEqual(planRound2({ ...baseInput, feedbackRaw: '整体都太难了' }).targets, [0, 1, 2, 3]);
});

test('空选定：检查与反馈都没有指向 → empty=true（R1 即终稿）', () => {
  const r = planRound2({ ...baseInput, feedbackRaw: '情节可以' });
  assert.deepEqual(r.targets, []);
  assert.equal(r.empty, true);
});

test('golden·合成夹具全量冻结（回归锚：字段集+关键值）', () => {
  const r = planRound2({
    ...baseInput,
    progressText: '{"round":1}',
    feedbackRaw: '词汇太难，超前一学期，情节可以',
    simplWords: ['zzxqvw'],
    findings: [
      { level: '难度', segId: 'P02', note: '一句 3 处注释' },
      { level: '信息变化', note: '否定数变化' },
    ],
    progressSet: true,
    ladder,
  });
  assert.deepEqual(Object.keys(r).sort(), ['boundaryNote', 'empty', 'exhausted', 'fb', 'gate', 'removedByLadder', 'targets', 'whole']);
  assert.equal(r.gate.ok, true);
  assert.deepEqual(r.targets, [1]);
  assert.equal(r.fb.magnitude, '明显');
  assert.deepEqual(r.fb.keep, ['情节']);
  assert.deepEqual(r.fb.dims, ['词汇']);
  assert.equal(r.whole, false);
  assert.equal(r.empty, false);
});

/* ────────── ②a（2026-09-26）：提示词与报告共享端口 ────────── */

import { buildAdaptReportMd, cleanR2Seg, protectionLine, round2SegPrompt, round2SystemPrompt } from '../src/core/round2.js';

test('系统提示词：档位矩阵进文本；annoCap 覆盖默认', () => {
  const a = round2SystemPrompt('A');
  assert.match(a, /独立读通，保留少量原文表达/);
  assert.match(a, /每段注释不超过 2 处/); // A 默认 2
  assert.match(a, /参考原文的约 85%/);
  assert.match(round2SystemPrompt('M'), /每段注释不超过 1 处/);
  assert.match(round2SystemPrompt('B', 3), /每段注释不超过 3 处/); // 显式覆盖
});

test('保护维度行：有禁改项列明，无则只保数字否定因果（facts 恒不单列）', () => {
  assert.equal(protectionLine(['facts', 'plot', 'characters']), '教师明确认可的方面（本轮禁改）：情节顺序与事件、人物关系与称谓。数字、否定与因果关系任何情况下不得改变。');
  assert.equal(protectionLine([]), '数字、否定与因果关系任何情况下不得改变。');
});

test('cleanR2Seg：剥代码围栏；丢 [P 标记则补回', () => {
  assert.equal(cleanR2Seg('```\n[P01] Hello.\n```', '[P01]'), '[P01] Hello.');
  assert.equal(cleanR2Seg('Hello there.', '[P02]'), '[P02] Hello there.');
  assert.equal(cleanR2Seg('[P03]  已带标记', '[P03]'), '[P03]  已带标记');
});

test('单段 prompt：四要素齐（反馈原话/词汇边界/段问题/否定提示），文本形状锁', () => {
  const u = round2SegPrompt({
    fbRaw: '词汇太难',
    boundaryNote: '词汇边界从 九上U3 回退到 九上U1（按你的反馈折算 2 个单元——档位折算，不是精确换算）',
    removedByLadder: ['j1', 'j2'],
    reasons: ['一句 3 处注释'],
    srcSeg: '[P02] The zzxqvw saw a mmbvplk and never forgot it.',
    r1Seg: '[P02] The zzxqvw saw a mmbvplk today.',
    marker: '[P02]',
    protectedDimensions: ['plot'],
  });
  assert.match(u, /「词汇太难」/);
  assert.match(u, /词汇边界调整：词汇边界从 九上U3 回退到 九上U1/);
  assert.match(u, /以下 2 个词本轮按"未学"处理（教材回退）…：j1, j2|以下 2 个词本轮按"未学"处理（教材回退），换成熟词或用简单英文解释：j1, j2/);
  assert.match(u, /本段的具体问题：一句 3 处注释/);
  assert.match(u, /本段含否定表达，方向不能反/); // srcSeg 含 never
  assert.match(u, /情节顺序与事件/); // protectionLine 生效
  assert.ok(u.endsWith('输出：保持 [P02] 标记开头，直接输出复写文本。'));
});

test('调适报告 md：状态行/阈值/负担剖面/反馈折算段形状锁（与 mjs writeReport 同一文本）', () => {
  const md = buildAdaptReportMd({
    ch: '第一章',
    tierKey: 'M',
    profile: { words: 83, annos: 2, densityPer100: 2.4, worstWindow: { density: 4, head: 'The boy' }, longestSentence: { words: 28 } },
    findings: [
      { level: '结构', note: '段落缺失' },
      { level: '信息变化', note: '数字变化' },
      { level: '难度', segId: 'P02', note: '一句 3 处注释' },
    ],
    ratio: 0.81,
    isFinal: true,
    fb: { raw: '词汇太难', dims: ['词汇'], keep: ['情节'], magnitude: '明显' },
    boundaryNote: '词汇边界从 九上U3 回退到 九上U1',
    changed: 2,
    changedNotes: ['[P01]（30→25 词）', '[P02]（20→18 词）'],
  });
  assert.match(md, /^# 调适报告 · 第一章 · M层（中层）$/m);
  assert.match(md, /状态：\*\*待处理（结构问题阻止发布）\*\*/); // 有结构问题
  assert.match(md, /注释密度 4、句长 17/); // M 档阈值（与 SENT_LEN_CHECK 同值）
  assert.match(md, /## 负担剖面（终稿）/);
  assert.match(md, /英文词数 83｜注释 2 处｜全文每百词 2.4 处/);
  assert.match(md, /篇幅\/原文：81%/);
  assert.match(md, /处理维度 词汇；保留维度 情节；幅度 明显/);
  assert.match(md, /## 第二轮修改（2 段，单段最多两次尝试，无自动重试）/);
  assert.match(md, /- ✗ 段落缺失/);
  assert.match(md, /- ⚠ 数字变化/);
  assert.ok(md.endsWith('- · 一句 3 处注释\n'));
});
