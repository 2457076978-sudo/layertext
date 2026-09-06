/**
 * 采纳率分析（W2）测试：台账解析 → 聚合 → 判读
 * 验收口径：喂入一段模拟真实使用的台账，能回答"哪类 AI 建议最不可靠、该改提示词还是改规则"。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregate, diagnose, LEDGER_HEADER, parseCsvLine, parseLedger, toLedgerLine, type LedgerRow } from '../src/core/adoption.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function row(over: Partial<LedgerRow>): LedgerRow {
  return {
    ts: '2026-09-06 10:00:00', book: '动物农场', chapter: 'ch1.md', tier: 'M', scene: '行内',
    markType: '词汇简化', rule: 'R02', outcome: '采纳', check: '通过',
    provider: 'api.deepseek.com', model: 'deepseek-chat', promptVer: '内置v1',
    original: 'The old man sang a song.', revised: 'The old man sang.', basis: 'test',
    rejectReason: '', ...over,
  };
}

test('parseCsvLine：双引号包裹与转义（表头含逗号的原句/依据）', () => {
  assert.deepEqual(parseCsvLine('a,"b,c","d""e"'), ['a', 'b,c', 'd"e']);
  assert.deepEqual(parseCsvLine('2026-09-06,a,b,M,行内,词汇简化,R02,采纳,通过'), ['2026-09-06', 'a', 'b', 'M', '行内', '词汇简化', 'R02', '采纳', '通过']);
});

test('parseLedger：跳过表头与坏行；台账行往返一致', () => {
  const r = row({ original: 'He said, "go home" now', basis: '含逗号,和"引号"' });
  const line = toLedgerLine(r);
  const parsed = parseLedger(LEDGER_HEADER.join(',') + '\n' + line + '\n坏行\n\n');
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].original, 'He said, "go home" now');
  assert.equal(parsed[0].basis, '含逗号,和"引号"');
  assert.equal(parsed[0].outcome, '采纳');
});

test('aggregate：明确采纳率 vs 总接受率（直改不计入教师过目）', () => {
  const rows = [
    row({ markType: '词汇简化', outcome: '采纳' }),
    row({ markType: '词汇简化', outcome: '采纳' }),
    row({ markType: '词汇简化', outcome: '拒绝' }),
    row({ markType: '词汇简化', outcome: '直改', scene: '自动直改' }),
  ];
  const a = aggregate(rows);
  assert.equal(a.overall.total, 4);
  assert.equal(a.overall.explicitRate, 2 / 3); // 2/(2+1)，直改不进分母
  assert.equal(a.overall.overallRate, 3 / 4);  // (2采纳+1直改)/4
  assert.equal(a.byMark[0].key, '词汇简化');
  assert.equal(a.byMark[0].autoApplied, 1);
});

test('diagnose：复核⚠高被拒 → 指向改提示词；复核通过仍高被拒 → 指向审校约定', () => {
  // 场景A：AI 常违反黑名单（复核⚠且被拒多）→ 判读应提"改提示词/换模型"
  const warnHeavy: LedgerRow[] = [];
  for (let i = 0; i < 6; i++) warnHeavy.push(row({ markType: '词汇简化', check: '⚠', outcome: '拒绝' }));
  for (let i = 0; i < 2; i++) warnHeavy.push(row({ markType: '词汇简化', check: '⚠', outcome: '采纳' }));
  for (let i = 0; i < 6; i++) warnHeavy.push(row({ markType: '句太长', check: '通过', outcome: '采纳' }));
  const dA = diagnose(aggregate(warnHeavy)).join('');
  assert.match(dA, /改提示词|换更稳的模型/);
  assert.match(dA, /词汇简化/); // 点名最不可靠类别

  // 场景B：复核通过的建议仍大量被拒（教师口味）→ 判读应指向"长期审校约定"
  const tasteHeavy: LedgerRow[] = [];
  for (let i = 0; i < 7; i++) tasteHeavy.push(row({ markType: '表达生硬', check: '通过', outcome: '拒绝' }));
  for (let i = 0; i < 5; i++) tasteHeavy.push(row({ markType: '表达生硬', check: '通过', outcome: '采纳' }));
  const dB = diagnose(aggregate(tasteHeavy)).join('');
  assert.match(dB, /长期审校约定|教学偏好/);
});

test('diagnose：提示词版本对比出现且排序正确', () => {
  const rows = [
    ...Array.from({ length: 8 }, () => row({ promptVer: 'v1', outcome: '采纳' })),
    ...Array.from({ length: 2 }, () => row({ promptVer: 'v1', outcome: '拒绝' })),
    ...Array.from({ length: 3 }, () => row({ promptVer: 'v2', outcome: '采纳' })),
    ...Array.from({ length: 6 }, () => row({ promptVer: 'v2', outcome: '拒绝' })),
  ];
  const d = diagnose(aggregate(rows)).join('');
  assert.match(d, /v2 33%/);
  assert.match(d, /v1 80%/);
});

test('端到端：真实格式台账文件 → 聚合出最常被拒 Top 与日期趋势', () => {
  // 与应用写入格式完全一致的样例（含表头），放在 tests/fixtures
  const csv = readFileSync(join(ROOT, 'tests', 'fixtures', 'AI建议台账_样例.csv'), 'utf-8');
  const a = aggregate(parseLedger(csv));
  assert.ok(a.overall.total >= 12);
  assert.equal(a.topRejected[0].key, '词汇简化');
  assert.ok(a.byDate.length >= 2);
  assert.equal(a.byDate[0].date < a.byDate[a.byDate.length - 1].date, true);
});
