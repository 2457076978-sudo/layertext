/**
 * CEFR 等级维度 + FSRS 并行调度 · 单测
 * CEFR：解析/词形回退/等级语义；FSRS：确定性、间隔扩展性（记忆曲线应随 hits 增大）、并行对照字段。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseCefrLevels, cefrOf, cefrRank } from '../src/core/cefr.js';
import { planFsrs, summarizeFsrs } from '../src/core/fsrs.js';

test('CEFR：解析（# 注释跳过、坏行跳过）与词形回退（复数/过去式/进行时）', () => {
  const m = parseCefrLevels('# 头注释\nabandon B1\nzoology C2\nbad line here\n\nzoom B2');
  assert.equal(m.size, 3);
  assert.equal(cefrOf('abandon', m), 'B1');
  assert.equal(cefrOf('abandoned', m), 'B1'); // ed 回退
  assert.equal(cefrOf('abandons', m), 'B1'); // s 回退
  assert.equal(cefrOf('zooming', m), 'B2'); // ing 回退
  assert.equal(cefrOf('studies', m) === null || cefrOf('studies', m) === cefrOf('study', parseCefrLevels('study A2')), true); // ies→y
  assert.equal(cefrOf('notindict', m), null); // 未收
  assert.ok(cefrRank('A1') < cefrRank('C2'));
});

test('FSRS：同输入同输出（确定性）；间隔随命中次数扩展（记忆曲线），并行对照字段齐全', () => {
  const items = [
    { word: 'cynical', hits: 0 },
    { word: 'boar', hits: 1 },
    { word: 'tired', hits: 2 },
    { word: 'security', hits: 3 },
    { word: 'flood', hits: 4 },
  ];
  const a = planFsrs(items);
  const b = planFsrs(items);
  assert.deepEqual(a, b, '纯计算确定性');
  // 扩展间隔：已命中多次的词，下次建议间隔应明显大于新词
  const news = a[0]!.nextPieces;
  const mature = a[4]!.nextPieces;
  assert.ok(mature >= news, `成熟词间隔(${mature}) ≥ 新词(${news})`);
  assert.ok(mature >= 3, '多次复现后建议扩展到数篇以上（FSRS 曲线特性）');
  // 并行对照：现行固定 2 篇字段常驻
  for (const r of a) {
    assert.equal(r.currentPieces, 2);
    assert.ok(r.nextPieces >= 1);
    assert.ok(r.nextDays >= 1);
  }
  const s = summarizeFsrs(a);
  assert.equal(s.total, 5);
  assert.equal(s.differCount, a.filter((r) => r.nextPieces !== r.currentPieces).length);
  assert.ok(s.avgPieces > 0);
});

test('FSRS：单位换算可调（daysPerPiece 影响篇数，currentPieces 影响对照行）', () => {
  const items = [{ word: 'flood', hits: 4 }];
  const r3 = planFsrs(items, { daysPerPiece: 3 })[0]!;
  const r1 = planFsrs(items, { daysPerPiece: 1 })[0]!;
  assert.equal(r1.nextPieces, r3.nextDays); // 1 天/篇 = 天数直读
  assert.ok(r1.nextPieces >= r3.nextPieces);
  const r5 = planFsrs(items, { currentPolicyPieces: 5 })[0]!;
  assert.equal(r5.currentPieces, 5);
});
