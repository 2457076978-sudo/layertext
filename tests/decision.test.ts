/**
 * 教师决定事件 + 入库提议 回归测试
 *
 * 验收标准（《LayerText 项目审查报告（2026-09-11）》§一）：
 *   「追加不可变事件：decision, before, after, reason, ruleIds, teacherId, timestamp, sourceVersion」
 *   「离线汇总器再把『采纳过的释义』提议进词典、『误报』提议进词表例外、
 *     『同类改写』提议进改写模板；**任何入库都要人工确认**」
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildProposals,
  contestedItems,
  decisionIndex,
  makeDecisionEvent,
  parseDecisionLog,
  summarizeDecisions,
  toDecisionLine,
  type DecisionEvent,
  type MakeDecisionInput,
} from '../src/core/decision.js';

const ev = (over: Partial<MakeDecisionInput> = {}): DecisionEvent =>
  makeDecisionEvent({
    itemId: '第一章#2:ANNO-01:windmill',
    decision: 'accept',
    before: 'The windmill was broken.',
    after: 'The windmill（风车） was broken.',
    reason: '',
    ruleIds: ['ANNO-01'],
    teacherId: 'wayne',
    sourceVersion: 'sha-abc',
    timestamp: '2026-09-11T10:00:00.000Z',
    ...over,
  });

test('事件字段齐备：报告点名的 8 个字段一个不少', () => {
  const e = ev();
  for (const k of ['decision', 'before', 'after', 'reason', 'ruleIds', 'teacherId', 'timestamp', 'sourceVersion']) {
    assert.equal(k in e, true, `缺字段 ${k}`);
  }
  assert.equal(e.schemaVersion, 1);
});

test('缺 itemId 或 teacherId 直接抛错（否则事后无法审计）', () => {
  assert.throws(() => ev({ itemId: '' }), /itemId/);
  assert.throws(() => ev({ teacherId: '' }), /teacherId/);
});

test('ruleIds 去重且不共享外部数组（不可变事件不能被调用方后来改掉）', () => {
  const arr = ['ANNO-01', 'ANNO-01', 'FACT-01'];
  const e = ev({ ruleIds: arr });
  assert.deepEqual(e.ruleIds, ['ANNO-01', 'FACT-01']);
  arr.push('ZH-01');
  assert.deepEqual(e.ruleIds, ['ANNO-01', 'FACT-01']);
});

test('append-only 往返：写一行读回来一模一样', () => {
  const list = [ev(), ev({ decision: 'false-positive', itemId: '第一章#2:FACT-01:1911' })];
  const text = list.map(toDecisionLine).join('');
  const r = parseDecisionLog(text);
  assert.equal(r.badLines, 0);
  assert.deepEqual(r.events, list);
});

test('坏行计数而不抛：一条坏行不能让整份日志不可读', () => {
  const text = toDecisionLine(ev()) + '{这不是 JSON\n' + '{"itemId":"x"}\n' + toDecisionLine(ev({ itemId: 'b' }));
  const r = parseDecisionLog(text);
  assert.equal(r.events.length, 2);
  assert.equal(r.badLines, 2, '解析失败与字段不全各算一条坏行');
});

test('同一项被反复改主意：历史一条不删，索引取最新', () => {
  const a = ev({ decision: 'reject', timestamp: '2026-09-11T10:00:00.000Z' });
  const b = ev({ decision: 'accept', timestamp: '2026-09-11T11:00:00.000Z' });
  const c = ev({ decision: 'false-positive', timestamp: '2026-09-11T09:00:00.000Z' });
  const idx = decisionIndex([a, b, c]);
  assert.equal(idx.get('第一章#2:ANNO-01:windmill')?.decision, 'accept', '时间戳最新的胜出');
  assert.deepEqual(contestedItems([a, b, c]), [{ itemId: '第一章#2:ANNO-01:windmill', flips: 3 }]);
});

test('汇总：误报率是规则噪音水平的直接度量', () => {
  const s = summarizeDecisions([
    ev({ decision: 'accept' }),
    ev({ decision: 'accept', itemId: 'b' }),
    ev({ decision: 'false-positive', itemId: 'c', ruleIds: ['FACT-02'] }),
    ev({ decision: 'reject', itemId: 'd', teacherId: 'li' }),
  ]);
  assert.equal(s.total, 4);
  assert.deepEqual(s.byDecision, { accept: 2, 'false-positive': 1, reject: 1 });
  assert.equal(s.falsePositiveRate, 0.25);
  assert.deepEqual(s.byRule, { 'ANNO-01': 3, 'FACT-02': 1 });
  assert.deepEqual(s.teachers, ['li', 'wayne']);
});

/* ────────────────── 离线汇总：三条提议通道 ────────────────── */

test('① 采纳过的释义 → 提议进词典', () => {
  const p = buildProposals([
    ev({ itemId: 'a', subject: { kind: 'word', value: 'windmill' }, after: '风车' }),
    ev({ itemId: 'b', subject: { kind: 'word', value: 'windmill' }, after: '风车' }),
  ]);
  assert.equal(p.length, 1);
  assert.equal(p[0].kind, 'dict-entry');
  assert.equal(p[0].key, 'windmill');
  assert.equal(p[0].value, '风车');
  assert.equal(p[0].count, 2);
});

test('② 误报 → 提议进词表例外（而不是默默不再报警）', () => {
  const p = buildProposals([
    ev({ itemId: 'a', decision: 'false-positive', subject: { kind: 'word', value: 'curiously' }, ruleIds: ['ANNO-01'] }),
    ev({ itemId: 'b', decision: 'false-positive', subject: { kind: 'word', value: 'curiously' }, ruleIds: ['ANNO-01'] }),
  ]);
  assert.equal(p.length, 1);
  assert.equal(p[0].kind, 'kb-exception');
  assert.equal(p[0].key, 'curiously');
});

test('③ 同类直改 → 提议进改写模板（带 before→after 样例）', () => {
  const p = buildProposals([
    ev({ itemId: 'a', decision: 'edit', ruleIds: ['SENT-01'], before: 'A very long one.', after: 'A short one.' }),
    ev({ itemId: 'b', decision: 'edit', ruleIds: ['SENT-01'], before: 'Another long one.', after: 'Another short one.' }),
  ]);
  assert.equal(p.length, 1);
  assert.equal(p[0].kind, 'rewrite-template');
  assert.equal(p[0].key, 'SENT-01');
  assert.match(p[0].value, /A very long one\. → A short one\./);
});

test('任何入库都要人工确认：每条提议都带 requiresConfirmation 与证据', () => {
  const p = buildProposals([
    ev({ itemId: 'a', subject: { kind: 'word', value: 'w' }, after: '甲' }),
    ev({ itemId: 'b', subject: { kind: 'word', value: 'w' }, after: '甲' }),
  ]);
  assert.equal(p[0].requiresConfirmation, true);
  assert.equal(p[0].evidence.length, 2);
  assert.equal(p[0].evidence[0].itemId, 'a');
  assert.equal(typeof p[0].evidence[0].teacherId, 'string');
});

test('支持度不足不提议：一条偶然事件不该改词典', () => {
  const one = buildProposals([ev({ subject: { kind: 'word', value: 'w' }, after: '甲' })]);
  assert.deepEqual(one, [], '默认 minSupport=2');
  const one2 = buildProposals([ev({ subject: { kind: 'word', value: 'w' }, after: '甲' })], { minSupport: 1 });
  assert.equal(one2.length, 1, '可显式放宽，但那是教师的选择');
});

test('决定与提议是纯函数：不写文件、不改输入', () => {
  const events = [ev({ itemId: 'a', subject: { kind: 'word', value: 'w' }, after: '甲' }), ev({ itemId: 'b', subject: { kind: 'word', value: 'w' }, after: '甲' })];
  const before = JSON.stringify(events);
  buildProposals(events);
  summarizeDecisions(events);
  assert.equal(JSON.stringify(events), before);
});

test('提议排序：证据多的先看；同数量按 词典 > 例外 > 模板', () => {
  const p = buildProposals([
    ev({ itemId: 't1', decision: 'edit', ruleIds: ['SENT-01'], before: 'x', after: 'y' }),
    ev({ itemId: 't2', decision: 'edit', ruleIds: ['SENT-01'], before: 'x', after: 'y' }),
    ev({ itemId: 't3', decision: 'edit', ruleIds: ['SENT-01'], before: 'x', after: 'y' }),
    ev({ itemId: 'd1', subject: { kind: 'word', value: 'w' }, after: '甲' }),
    ev({ itemId: 'd2', subject: { kind: 'word', value: 'w' }, after: '甲' }),
    ev({ itemId: 'e1', decision: 'false-positive', subject: { kind: 'word', value: 'z' } }),
    ev({ itemId: 'e2', decision: 'false-positive', subject: { kind: 'word', value: 'z' } }),
  ]);
  assert.deepEqual(p.map((x) => x.kind), ['rewrite-template', 'dict-entry', 'kb-exception']);
});
