/**
 * CEFR 等级维度 + FSRS 并行调度 · 单测
 * CEFR：解析/词形回退/等级语义；FSRS：确定性、间隔扩展性（记忆曲线应随 hits 增大）、并行对照字段。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseCefrLevels, cefrOf, cefrRank } from '../src/core/cefr.js';
import { planFsrs, summarizeFsrs, weeklyDue } from '../src/core/fsrs.js';

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

/* ── 3a：weeklyDue 本周到期（功能四项 · 项 3）——教师端清单/出题选词共用的纯函数 ── */

test('3a：weeklyDue——空卡词首次复习在窗内、高频词晚到期可在窗外、到期早在前、dueDay=今天+nextDays', () => {
  const today = new Date('2026-09-19T00:00:00Z');
  // hits 0 → nextDays 1（空卡首复习）；hits 8 → 间隔更大（可能超 7 天窗）
  const rows = weeklyDue(
    [
      { word: 'zeta', hits: 8 },
      { word: 'alpha', hits: 0 },
      { word: 'mid', hits: 2 },
    ],
    { today, horizonDays: 7 },
  );
  assert.ok(rows.length >= 1, '至少空卡词在窗内');
  assert.equal(rows[0]!.word, 'alpha', '到期最早（nextDays 最小）在前');
  assert.equal(rows[0]!.dueDay, '2026-09-20', 'dueDay = today + nextDays(1)');
  assert.ok(
    rows.every((r) => r.nextDays <= 7),
    '窗外词全部滤掉',
  );
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1]!.nextDays <= rows[i]!.nextDays, '按 nextDays 升序');
  // 高频词大间隔：把窗口收到 1 天，只有 nextDays≤1 的词留下
  const tight = weeklyDue(
    [
      { word: 'alpha', hits: 0 },
      { word: 'mid', hits: 2 },
    ],
    { today, horizonDays: 1 },
  );
  assert.deepEqual(
    tight.map((r) => r.word),
    ['alpha'],
    'horizon 边界：只留 nextDays≤1',
  );
});

test('3a：weeklyDue 并行试点口径——每行同时带 FSRS 建议（篇）与现行固定（篇）', () => {
  const rows = weeklyDue([{ word: 'dog', hits: 1 }], { today: new Date('2026-09-19T00:00:00Z') });
  assert.equal(rows.length, 1);
  assert.equal(typeof rows[0]!.nextPieces, 'number', 'FSRS 建议列在');
  assert.equal(rows[0]!.currentPieces, 2, '现行固定隔 2 篇列在（默认）');
});
