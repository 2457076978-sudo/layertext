/**
 * 可观测产品指标 回归测试
 *
 * 验收标准（《LayerText 审查报告 v4_方向》「系统性偏差」一节）：
 *   「manifest、AST、事件账本都必要，但它们不能替代一次成功的编辑闭环。
 *     下一轮评估应加入可观测产品指标：首次点击到可采纳结果的时间、撤销率、
 *     批量动作后的人工回退率、以及教师在 10 次操作后的错误采纳率。」
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeDecisionEvent, type DecisionEvent, type MakeDecisionInput } from '../src/core/decision.js';
import { EARLY_OPS, productMetrics, sessionOpenEvent, SESSION_OPEN } from '../src/core/productmetrics.js';

let seq = 0;
const at = (sec: number): string => new Date(Date.UTC(2026, 8, 11, 10, 0, sec)).toISOString();
const ev = (over: Partial<MakeDecisionInput> = {}): DecisionEvent =>
  makeDecisionEvent({
    itemId: `item-${seq++}`,
    decision: 'accept',
    before: 'a',
    after: 'b',
    reason: '',
    ruleIds: ['ANNO-01'],
    teacherId: 'wayne',
    sourceVersion: 's',
    timestamp: at(0),
    ...over,
  });
const open = (sec = 0): DecisionEvent => sessionOpenEvent({ tier: 'A', teacherId: 'wayne', sourceVersion: 's', pending: 12, timestamp: at(sec) });

test('首次点击到可采纳结果的时间：从打开队列算到第一个采纳', () => {
  const m = productMetrics([open(0), ev({ timestamp: at(3), decision: 'reject' }), ev({ timestamp: at(12) })]);
  assert.equal(m.timeToFirstAdoptMs, 12_000);
  assert.match(m.notes.join('｜'), /首次操作到拿到第一个可采纳结果：12\.0 秒/);
});

test('没有 session-open 时如实说"算不出来"，不假装是 0', () => {
  const m = productMetrics([ev({ timestamp: at(5) })]);
  assert.equal(m.timeToFirstAdoptMs, null);
  assert.match(m.notes.join('｜'), /算不出来（不是 0）/);
});

test('撤销率：分母是"决定数"，且 undo 本身不算决定', () => {
  const a = ev({ timestamp: at(1) });
  const b = ev({ timestamp: at(2) });
  const undo = ev({ decision: 'undo', timestamp: at(3), undoOf: `${a.itemId}@${a.timestamp}` });
  const m = productMetrics([a, b, undo]);
  assert.equal(m.decisions, 2, 'undo 不是决定');
  assert.equal(m.undoRate, 0.5);
  assert.match(m.notes.join('｜'), /撤销率 50\.0%（1\/2）/);
});

test('批量动作后的人工回退率：批量采纳里有多少后来被撤销', () => {
  const b1 = ev({ timestamp: at(1), reason: '批量＋ 补上注释：barn → barn（谷仓）' });
  const b2 = ev({ timestamp: at(2), reason: '批量＋ 补上注释：windmill → windmill（风车）' });
  const one = ev({ timestamp: at(3), reason: '＋ 补上注释：barn → barn（谷仓）' });
  const undo = ev({ decision: 'undo', timestamp: at(4), undoOf: `${b1.itemId}@${b1.timestamp}` });
  const m = productMetrics([b1, b2, one, undo]);
  assert.equal(m.batchShare, 2 / 3);
  assert.equal(m.batchRollbackRate, 0.5, '两条批量里回退了一条');
  assert.match(m.notes.join('｜'), /批量采纳占 67%，其中被回退 50%/);
});

test('没有批量记录时说清楚"这个问题目前无法回答"（不虚构 0%）', () => {
  const m = productMetrics([ev({ timestamp: at(1), reason: '＋ 补上注释' })]);
  assert.equal(m.batchRollbackRate, 0);
  assert.match(m.notes.join('｜'), /目前无法回答/);
});

test('执行失败率：rejected 高说明稿件状态或路径有问题，不是教师的问题', () => {
  const m = productMetrics([
    ev({ timestamp: at(1) }),
    ev({ decision: 'rejected', timestamp: at(2), reason: '读不到正文' }),
    ev({ decision: 'rejected', timestamp: at(3), reason: '找不到段落' }),
  ]);
  assert.equal(m.applyFailureRate, 2 / 3);
  assert.match(m.notes.join('｜'), /执行失败 2 次/);
  assert.match(m.notes.join('｜'), /不是教师的问题/);
});

test('疲劳信号：后段撤销率明显高于前段', () => {
  const evs: DecisionEvent[] = [];
  // 前 10 次：一次都不撤
  for (let i = 0; i < EARLY_OPS; i++) evs.push(ev({ timestamp: at(i) }));
  // 之后 6 次：撤掉 3 个
  const late: DecisionEvent[] = [];
  for (let i = 0; i < 6; i++) late.push(ev({ timestamp: at(20 + i) }));
  evs.push(...late);
  evs.push(...late.slice(0, 3).map((e, i) => ev({ decision: 'undo', timestamp: at(40 + i), undoOf: `${e.itemId}@${e.timestamp}` })));
  const m = productMetrics(evs);
  assert.equal(m.earlyUndoRate, 0);
  assert.equal(m.lateUndoRate, 0.5);
  assert.equal(m.fatigueSignal, true);
  assert.match(m.notes.join('｜'), /后段明显升高/);
});

test('操作数不足以判断疲劳时不下结论（不拿 2 次操作说事）', () => {
  const m = productMetrics([ev({ timestamp: at(1) }), ev({ timestamp: at(2), decision: 'reject' })]);
  assert.equal(m.fatigueSignal, false);
  assert.equal(m.notes.some((n) => /疲劳信号/.test(n)), false);
});

test('★ 「错误采纳率」必须标明是代理指标，不许拿它冒充真值', () => {
  const m = productMetrics([ev({ timestamp: at(1) })]);
  assert.match(m.notes.join('｜'), /代理指标/);
  assert.match(m.notes.join('｜'), /不是错误率本身/);
});

test('session-open 事件：只多这一个类型，且自带当时的待办数', () => {
  const e = open(0);
  assert.equal(e.itemId, SESSION_OPEN);
  assert.match(e.reason, /待办 12 条/);
  assert.deepEqual(e.ruleIds, []);
});

test('时间是按事件顺序算的，与传入顺序无关（日志是 append-only，读出来可能乱序）', () => {
  const a = ev({ timestamp: at(10) });
  const b = ev({ timestamp: at(2) });
  const o = open(0);
  const m = productMetrics([a, b, o]);   // 故意乱序传入
  assert.equal(m.timeToFirstAdoptMs, 2_000, '要取时间最早的那个采纳');
});
