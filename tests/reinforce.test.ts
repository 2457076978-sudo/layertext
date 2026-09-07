/**
 * feature/reinforce 回归测试：已学词集（复现队列）
 * 红线：全部使用假数据（假词/假句），无任何学生数据或真实书稿。
 * 行为约定：
 *  1. 队列词不再计 OOV（生词率下降）
 *  2. ⑩复现指标只在提供 reinforceWords 时出现在结果与 legacy 报告中（旧 schema 零变化）
 *  3. 命中按词形家族计（care 命中 cared/caring），词种计命中、token 计词次
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lexiconFromWords, parseReinforceText } from '../src/core/lexicon.js';
import { runQc, toLegacyReport, type QcOptions } from '../src/core/qc.js';

function qc(paras: string[], known: string[] = [], opts: Partial<QcOptions> = {}) {
  const md =
    '## Chapter One\n\n' +
    paras.map((p, i) => `[P${String(i + 1).padStart(2, '0')}] ${p}`).join('\n\n') +
    '\n';
  return runQc(md, lexiconFromWords(known), { tier: 'M', fileName: 'test.md', ...opts });
}

// ---------- parseReinforceText：宽容格式 ----------

test('parse：纯文本/编号/CSV首列/TSV/注释/表头/去重', () => {
  const txt = [
    '# 复现队列示例',
    'galaxy',
    '2. nebula',
    'asteroid,brought,2026-09-08',
    'comet\t备注列',
    'galaxy',
    '',
    '词',
    'word',
    '中文行应忽略',
  ].join('\n');
  assert.deepEqual(parseReinforceText(txt), ['galaxy', 'nebula', 'asteroid', 'comet']);
});

test('parse：BOM 与多词短语保留', () => {
  assert.deepEqual(parseReinforceText('\uFEFFbring about\nlook after'), ['bring about', 'look after']);
});

// ---------- 引擎：OOV 豁免 + ⑩指标 ----------

test('队列词不再计 OOV（生词率下降）', () => {
  const paras = ['The galaxy was bright.', 'A nebula glowed far away.'];
  const without = qc(paras, ['was', 'bright', 'a', 'far', 'away']);
  assert.ok(without.oov.includes('galaxy'));
  assert.ok(without.oov.includes('nebula'));
  const withR = qc(paras, ['was', 'bright', 'a', 'far', 'away'], { reinforceWords: ['galaxy', 'nebula'] });
  assert.ok(!withR.oov.includes('galaxy'));
  assert.ok(!withR.oov.includes('nebula'));
  assert.ok(withR.newWordRate < without.newWordRate);
});

test('⑩指标：词形家族按词种计命中、token 计词次', () => {
  const r = qc(
    ['She cared for the cat.', 'He cared again and caring was easy.', 'The dog barked.'],
    ['she', 'for', 'the', 'cat', 'he', 'again', 'and', 'was', 'easy', 'dog', 'barked'],
    { reinforceWords: ['care', 'comet'] },
  );
  assert.equal(r.reinforceQueue, 2);
  assert.equal(r.reinforceHits, 1);          // 只有 care 命中；comet 未出现
  assert.ok((r.reinforceTokens ?? 0) >= 3);  // cared ×2 + caring ×1
  assert.deepEqual(r.reinforceHitList, ['care']);
});

test('旧 schema 零变化：不传 reinforceWords 时结果与报告均无 ⑩ 字段', () => {
  const r = qc(['A plain sentence here.'], ['a', 'plain', 'sentence', 'here']);
  assert.equal(r.reinforceQueue, undefined);
  const rep = toLegacyReport(r) as Record<string, unknown>;
  assert.ok(Object.keys(rep).every((k) => !k.includes('⑩') && !k.includes('复现')));
});

test('传 reinforceWords（含空词）也只在提供时出现 ⑩，且空队列命中为 0', () => {
  const r = qc(['A plain sentence here.'], ['a', 'plain', 'sentence', 'here'], { reinforceWords: ['  ', ''] });
  assert.equal(r.reinforceQueue, 0);
  assert.equal(r.reinforceHits, 0);
  const rep = toLegacyReport(r) as Record<string, unknown>;
  assert.equal(rep['⑩复现词命中(队列/命中/词次)'], '0/0/0');
});

// ---------- 基线不变量：其余指标不受影响 ----------

test('基线不变：提供队列时句法计数/句长/覆盖率口径不变（OOV 仅因队列豁免而降）', () => {
  const paras = ['The fence was painted green.', 'The galaxy was bright.'];
  const base = qc(paras, ['the', 'fence', 'was', 'painted', 'green', 'bright']);
  const r = qc(paras, ['the', 'fence', 'was', 'painted', 'green', 'bright'], { reinforceWords: ['galaxy'] });
  assert.equal(r.passive, base.passive);
  assert.equal(r.sentCount, base.sentCount);
  assert.equal(r.maxLen, base.maxLen);
  assert.equal(r.tokenCount, base.tokenCount);
  assert.equal(r.coverage > base.coverage, true);
});
