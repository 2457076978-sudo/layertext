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
