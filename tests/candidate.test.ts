/**
 * 修改资产的复用与晋级 · 候选资产层测试（四方向方案 v2 方向三验收）
 *
 * 锁四条：
 *   ① 最小有效范围：一次局部替换停在当前句，同章两次升本章，同书同层升本书同层，跨书=本班；
 *   ② 人物/地点/情节类资产自动范围封顶本书——永不自动跨书；
 *   ③ 所有资产能指回决定事件；撤销降低证据（approved 也要降回 candidate）；
 *   ④ 跨层=策略族变换不是复制：只有出过证据的层有动作，其余层留白。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DecisionEvent } from '../src/core/decision.js';
import {
  candidatesFromEvents, reusable, promote, rejectCandidate, applyUndo,
  defaultScopeFor, familiesFromCandidates, scopeRank, SCOPE_ORDER,
} from '../src/core/candidate.js';

const ev = (over: Partial<DecisionEvent>): DecisionEvent => ({
  schemaVersion: 1,
  itemId: `item-${Math.random().toString(36).slice(2, 8)}`,
  decision: 'accept',
  before: 'tyrannise',
  after: 'rule unfairly',
  reason: '',
  ruleIds: [],
  teacherId: 'wayne',
  timestamp: `2026-09-12T10:00:0${Math.floor(Math.random() * 9)}.000Z`,
  sourceVersion: 'v1',
  subject: { kind: 'word', value: 'tyrannise' },
  eventId: `evt-${Math.random().toString(36).slice(2, 10)}`,
  ...over,
});

test('范围序：sentence < segment < chapter < book-tier < book < class < global', () => {
  assert.deepEqual(SCOPE_ORDER.map(scopeRank), [0, 1, 2, 3, 4, 5, 6]);
});

test('最小有效范围：证据分布决定默认档位', () => {
  assert.equal(defaultScopeFor({ chapters: ['第一章'], books: ['AF'], tiers: ['A'], count: 1 }, 'gloss-entry'), 'sentence', '一次局部替换=当前句');
  assert.equal(defaultScopeFor({ chapters: ['第一章'], books: ['AF'], tiers: ['A'], count: 2 }, 'gloss-entry'), 'chapter', '同章同类两次=本章');
  assert.equal(defaultScopeFor({ chapters: ['第一章', '第三章'], books: ['AF'], tiers: ['A'], count: 3 }, 'gloss-entry'), 'book-tier', '同书同层=本书同层');
  assert.equal(defaultScopeFor({ chapters: ['第一章', '第三章'], books: ['AF'], tiers: ['A', 'M'], count: 4 }, 'gloss-entry'), 'book', '同书跨层=本书');
  assert.equal(defaultScopeFor({ chapters: ['c1', 'c2'], books: ['AF', 'Alice'], tiers: ['A'], count: 3 }, 'gloss-entry'), 'class', '跨书=本班');
});

test('人物/情节类资产自动范围封顶本书——永不自动跨书', () => {
  assert.equal(
    defaultScopeFor({ chapters: ['c1', 'c2'], books: ['AF', 'Alice'], tiers: ['A'], count: 3 }, 'plot-protection'),
    'book',
    '跨书证据也只升到本书',
  );
  assert.equal(
    defaultScopeFor({ chapters: ['c1', 'c2'], books: ['AF', 'Alice'], tiers: ['A'], count: 3 }, 'proper-name-rule'),
    'book',
  );
});

test('聚合：同类决定聚成候选，能指回决定事件；误报→词汇口径、编辑→改写偏好', () => {
  const events = [
    ev({ decision: 'accept', after: '统治', chapter: '第一章', book: 'AF', tier: 'A' }),
    ev({ decision: 'accept', after: '统治', chapter: '第一章', book: 'AF', tier: 'A' }),
    ev({ decision: 'false-positive', before: 'blame', after: 'blame', chapter: '第三章', book: 'AF', tier: 'M', reason: '课标词', subject: { kind: 'word', value: 'blame' } }),
    ev({ decision: 'edit', ruleIds: ['SENT-01'], before: '长句A', after: '拆成两句', chapter: '第二章', book: 'AF', tier: 'M', subject: { kind: 'sentence', value: '长句A' } }),
  ];
  const cands = candidatesFromEvents(events);
  const gloss = cands.find((c) => c.kind === 'gloss-entry' && c.key === 'tyrannise')!;
  assert.equal(gloss.evidenceCount, 2);
  assert.equal(gloss.proposedScope, 'chapter');
  assert.ok(gloss.sourceDecisionIds.length === 2, '指回决定事件');
  assert.ok(cands.some((c) => c.kind === 'lexicon-entry' && c.key === 'blame'));
  assert.ok(cands.some((c) => c.kind === 'rewrite-rule' && c.key === 'SENT-01'));
  assert.ok(cands.every((c) => c.status === 'candidate'), '聚合产物默认候选，不是批准');
});

test('消费侧：只有 approved 且范围达标的资产可复用', () => {
  let cands = candidatesFromEvents([
    ev({ decision: 'accept', after: '统治', chapter: 'c1', book: 'AF', tier: 'A' }),
    ev({ decision: 'accept', after: '统治', chapter: 'c2', book: 'AF', tier: 'A' }),
  ]);
  assert.equal(cands[0]!.proposedScope, 'book-tier', '两章证据先落本书同层');
  assert.equal(reusable(cands, 'chapter').length, 0, '候选期不可复用');
  cands = promote(cands, cands[0]!.id, 'chapter');
  assert.equal(reusable(cands, 'chapter').length, 1, '批准到本章→本章可用');
  assert.equal(reusable(cands, 'book').length, 0, '批准到本章→本书范围不可用');
  cands = rejectCandidate(cands, cands[0]!.id);
  assert.equal(reusable(cands, 'chapter').length, 0);
});

test('撤销降低证据：approved 也降回 candidate；证据清零转 rejected', () => {
  const e1 = ev({ decision: 'accept', after: '统治', chapter: 'c1', book: 'AF', tier: 'A' });
  let cands = candidatesFromEvents([e1]);
  cands = promote(cands, cands[0]!.id);
  cands = applyUndo(cands, e1.eventId!);
  assert.equal(cands[0]!.evidenceCount, 0);
  assert.equal(cands[0]!.status, 'rejected', '证据清零=候选作废');
});

test('策略族：只有出过证据的层有动作，其余层留白（跨层=变换不是复制）', () => {
  const cands = candidatesFromEvents([
    ev({ decision: 'accept', before: 'rebellion', after: '反抗', chapter: 'c1', book: 'AF', tier: 'A', subject: { kind: 'word', value: 'rebellion' } }),
    ev({ decision: 'accept', before: 'rebellion', after: 'animals fighting against unfair control', chapter: 'c1', book: 'AF', tier: 'B', subject: { kind: 'word', value: 'rebellion' } }),
  ]);
  const families = familiesFromCandidates(cands);
  const f = families.find((x) => x.sourceTerm === 'rebellion')!;
  assert.equal(f.byTier.A?.action, 'gloss');
  assert.equal(f.byTier.B?.action, 'rewrite');
  assert.equal(f.byTier.M, undefined, 'M 层没出过证据=留白，不自动复制 A/B');
});

test('回流红线：撤销与执行失败不产生正证据', () => {
  const e1 = ev({ decision: 'accept', after: '统治', chapter: 'c1', book: 'AF', tier: 'A', timestamp: '2026-09-12T10:00:00.000Z', itemId: 'x1' });
  const undo = ev({ decision: 'undo', undoOf: 'x1\u00012026-09-12T10:00:00.000Z', before: '', after: '', chapter: 'c1', book: 'AF', tier: 'A' });
  const failed = ev({ decision: 'rejected', before: 'a', after: 'b', chapter: 'c1', book: 'AF', tier: 'A' });
  const cands = candidatesFromEvents([e1, undo, failed]);
  const gloss = cands.find((c) => c.key === 'tyrannise');
  assert.equal(gloss, undefined, '唯一正证据被撤销：不成为候选（而不是顶着撤销上岗）');
});
