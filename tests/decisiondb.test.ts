/**
 * 决定索引（SQLite）回归测试
 *
 * 验收标准（《LayerText 项目审查报告（2026-09-11）》§四）：
 *   「文件作为数据层在需要版本、并发、查询『某位教师对某词的所有决定』时崩溃；
 *     不必立刻上重型数据库，可先用 SQLite manifest + append-only events」
 *
 * 关键约束：**JSONL 是正本，SQLite 只是索引**——索引必须能由日志随时重建，
 * 且重建结果必须与日志一致；否则就是又一处口径漂移。
 *
 * 这里直接用真的 `node:sqlite`（Node 22.5+ 内置），**不写假驱动**：
 * 手搓一个 SQL 替身等于再造一份实现，正是本项目反复吃亏的那种"第二套口径"。
 * 拿不到驱动时用 `available=false` 走降级断言（那条路径本身也要被测）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DecisionStore, openDecisionStore, rowOf } from '../src/core/decisiondb.js';
import { makeDecisionEvent, type DecisionEvent, type MakeDecisionInput } from '../src/core/decision.js';

const ev = (over: Partial<MakeDecisionInput> = {}): DecisionEvent =>
  makeDecisionEvent({
    itemId: '第一章#2:ANNO-01:windmill',
    decision: 'accept',
    before: 'The windmill was broken.',
    after: '风车',
    reason: '',
    ruleIds: ['ANNO-01'],
    teacherId: 'wayne',
    sourceVersion: 'sha-1',
    timestamp: '2026-09-11T10:00:00.000Z',
    book: 'Animal Farm',
    chapter: '第一章',
    tier: 'A',
    segIndex: 2,
    subject: { kind: 'word', value: 'windmill' },
    ...over,
  });

/** 每个用例一个内存库；关掉时顺手 close，避免句柄泄漏 */
const withStore = (fn: (s: DecisionStore) => void): void => {
  const s = openDecisionStore(':memory:');
  try {
    fn(s);
  } finally {
    s.close();
  }
};

test('行映射：词的归一键是小写（查"某词"不分大小写）', () => {
  const r = rowOf(ev({ subject: { kind: 'word', value: 'Windmill' } }));
  assert.equal(r.word, 'windmill');
  assert.equal(r.subjectValue, 'Windmill', '原值保留（人看的还是原样）');
  assert.equal(r.ruleIds, 'ANNO-01');
});

test('灌入幂等：同一份日志灌两次不翻倍（这是"随时可重建"的前提）', () => {
  withStore((s) => {
    assert.equal(s.available, true, '索引必须可用（否则这条用例等于没测）');
    const events = [ev(), ev({ itemId: 'b', timestamp: '2026-09-11T10:01:00.000Z' })];
    s.ingest(events);
    assert.equal(s.count(), 2);
    s.ingest(events);
    assert.equal(s.count(), 2, '主键是 (itemId, timestamp, decision)，重复灌入必须被忽略');
  });
});

test('报告点名的那一句：某位教师对某词的所有决定', () => {
  withStore((s) => {
    assert.equal(s.available, true, '索引必须可用（否则这条用例等于没测）');
    s.ingest([
      ev({ itemId: 'a' }),
      ev({ itemId: 'b', decision: 'false-positive', timestamp: '2026-09-11T11:00:00.000Z' }),
      ev({ itemId: 'c', subject: { kind: 'word', value: 'barn' } }),
      ev({ itemId: 'd', teacherId: 'li' }),
    ]);
    const mine = s.decisionsAbout('windmill', 'wayne');
    assert.equal(mine.length, 2);
    assert.equal(mine.every((r) => r.teacherId === 'wayne'), true);
    assert.equal(s.decisionsAbout('windmill').length, 3, '不带教师 = 所有人对这个词的决定');
    assert.equal(s.decisionsAbout('WINDMILL', 'wayne').length, 2, '大小写不该影响查询');
    assert.equal(s.decisionsAbout('windmill', 'nobody').length, 0);
  });
});

test('查询排序：时间倒序（最近的决定先看到）', () => {
  withStore((s) => {
    assert.equal(s.available, true, '索引必须可用（否则这条用例等于没测）');
    s.ingest([
      ev({ itemId: 'old', timestamp: '2026-09-01T10:00:00.000Z' }),
      ev({ itemId: 'new', timestamp: '2026-09-11T10:00:00.000Z' }),
    ]);
    assert.deepEqual(s.query({ word: 'windmill' }).map((r) => r.itemId), ['new', 'old']);
  });
});

test('按规则查：ruleIds 是拼起来的，必须按分隔符包围匹配（不能 substr 蒙）', () => {
  withStore((s) => {
    assert.equal(s.available, true, '索引必须可用（否则这条用例等于没测）');
    s.ingest([ev({ ruleIds: ['ANNO-01', 'FACT-02'] }), ev({ itemId: 'b', ruleIds: ['ANNO-01'], timestamp: '2026-09-11T10:01:00.000Z' })]);
    assert.equal(s.query({ ruleId: 'ANNO-01' }).length, 2);
    assert.equal(s.query({ ruleId: 'FACT-02' }).length, 1);
    assert.equal(s.query({ ruleId: 'ANNO' }).length, 0, '前缀不该命中完整规则号');
    assert.equal(s.query({ ruleId: 'FACT-01' }).length, 0);
  });
});

test('时间过滤：since 只看某时间点之后的（复核新增决定时用）', () => {
  withStore((s) => {
    assert.equal(s.available, true, '索引必须可用（否则这条用例等于没测）');
    s.ingest([
      ev({ itemId: 'old', timestamp: '2026-09-01T10:00:00.000Z' }),
      ev({ itemId: 'new', timestamp: '2026-09-11T10:00:00.000Z' }),
    ]);
    assert.deepEqual(s.query({ since: '2026-09-10T00:00:00.000Z' }).map((r) => r.itemId), ['new']);
  });
});

test('重建：索引可随时删掉从日志重建，结果与灌入一致', () => {
  withStore((s) => {
    assert.equal(s.available, true, '索引必须可用（否则这条用例等于没测）');
    s.ingest([ev()]);
    const events = [ev(), ev({ itemId: 'b', subject: { kind: 'word', value: 'barn' }, timestamp: '2026-09-11T12:00:00.000Z' })];
    s.rebuild(events);
    assert.equal(s.count(), 2);
    assert.equal(s.decisionsAbout('barn').length, 1);
    // 索引与日志一致 = 索引里没有日志之外的东西（它是可丢弃的派生视图）
    const all = s.query({ limit: 100 });
    assert.deepEqual(all.map((r) => r.itemId).sort(), events.map((e) => e.itemId).sort());
  });
});

test('按规则聚合：一条决定挂两条规则时，两条各自的计数都要算对（不能按 A+B 整串分组）', () => {
  withStore((s) => {
    assert.equal(s.available, true, '索引必须可用（否则这条用例等于没测）');
    s.ingest([
      ev({ itemId: 'a', ruleIds: ['ANNO-01', 'FACT-02'] }),
      ev({ itemId: 'b', ruleIds: ['ANNO-01'], timestamp: '2026-09-11T10:01:00.000Z' }),
    ]);
    const by = s.byRule();
    assert.deepEqual(by, [
      { ruleId: 'ANNO-01', total: 2, falsePositive: 0 },
      { ruleId: 'FACT-02', total: 1, falsePositive: 0 },
    ]);
  });
});

test('按规则聚合：误报数是规则噪音水平的直接度量', () => {
  withStore((s) => {
    assert.equal(s.available, true, '索引必须可用（否则这条用例等于没测）');
    s.ingest([
      ev({ itemId: 'a', ruleIds: ['FACT-01'], decision: 'false-positive' }),
      ev({ itemId: 'b', ruleIds: ['FACT-01'], decision: 'accept', timestamp: '2026-09-11T10:01:00.000Z' }),
      ev({ itemId: 'c', ruleIds: ['ANNO-01'], decision: 'accept', timestamp: '2026-09-11T10:02:00.000Z' }),
    ]);
    const by = s.byRule();
    assert.equal(by.find((x) => x.ruleId === 'FACT-01')?.total, 2);
    assert.equal(by.find((x) => x.ruleId === 'FACT-01')?.falsePositive, 1);
    assert.equal(by.find((x) => x.ruleId === 'ANNO-01')?.total, 1);
    assert.equal(new Set(by.map((x) => x.ruleId)).size, by.length, '同一个规则不许在结果里出现两次');
  });
});

test('降级：拿不到驱动时 available=false、查询返回空——调用方据此回落 JSONL 全扫', () => {
  const s = new DecisionStore(null);
  assert.equal(s.available, false);
  assert.deepEqual(s.query({ word: 'x' }), []);
  assert.deepEqual(s.decisionsAbout('x'), []);
  assert.deepEqual(s.byRule(), []);
  assert.equal(s.ingest([ev()]), 0);
  assert.equal(s.count(), 0);
  s.close();
});

test('驱动必须真的可用：不可用时宁可响亮地失败，也不要空跑出一片绿', () => {
  const s = openDecisionStore(':memory:');
  try {
    assert.equal(
      s.available,
      true,
      'node:sqlite 不可用（需要 Node ≥ 22.5）。注意：本模块曾经因为"在 ESM 里用了 require"而永远静默降级，' +
        '所有查询用例跟着空跑成绿——所以这一条必须硬断言，不许 skip。',
    );
    s.ingest([ev()]);
    assert.equal(s.count(), 1);
  } finally {
    s.close();
  }
});
