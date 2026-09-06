/**
 * 诊断包摘要（W5）测试：隐私口径——只含域名/开关/数量，绝不含书稿文本与 Key
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDiagSummary, mergeQuotaTexts, pickSentMarkType } from '../app/src/pure.js';

const summaryOf = (cfg: Parameters<typeof buildDiagSummary>[0], v = '1.0.0') =>
  buildDiagSummary(cfg, v, 'ua')['配置摘要'] as Record<string, unknown>;

test('配置摘要：域名化 baseUrl、布尔与数量，不含 Key/约定内容/文件路径', () => {
  const s = buildDiagSummary({
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    failover: [{ name: 'x', baseUrl: 'y', model: 'z' }],
    autoRewriteOnMark: true,
    trustEdit: false,
    inPlaceEdit: true,
    lowThinking: true,
    tiers: { B: {} },
    recentFiles: ['/a.md', '/b.md'],
    instructions: '人名保留原文，歌篇不改写',
  }, '1.0.0', 'Mozilla/5.0 test');
  const text = JSON.stringify(s);
  const c = summaryOf({
    baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat',
    failover: [{ name: 'x', baseUrl: 'y', model: 'z' }],
    autoRewriteOnMark: true, trustEdit: false, inPlaceEdit: true, lowThinking: true,
    tiers: { B: {} }, recentFiles: ['/a.md', '/b.md'], instructions: '人名保留原文，歌篇不改写',
  });
  assert.match(text, /api\.deepseek\.com/);        // 域名保留（定位服务商问题需要）
  assert.match(text, /deepseek-chat/);             // 模型名保留
  assert.equal(c['备用供应商数'], 1);
  assert.equal(c['全局AI直改'], true);
  assert.equal(c['分层方案自定义'], true);
  assert.equal(c['最近文件数'], 2);
  assert.equal(c['长期审校约定字数'], 12); // 只记长度（12 字符含全角逗号）
  // 隐私红线：不出现约定内容与文件路径
  assert.doesNotMatch(text, /人名保留原文/);
  assert.doesNotMatch(text, /\/a\.md/);
  assert.doesNotMatch(text, /sk-/);
});

test('配置摘要：空配置与坏地址的兜底', () => {
  assert.equal(summaryOf({})['AI服务商域名'], '(未配置)');
  assert.equal(summaryOf({})['模型'], '(未配置)');
  assert.equal(summaryOf({})['备用供应商数'], 0);
  assert.equal(summaryOf({ baseUrl: '不是网址' })['AI服务商域名'], '(自定义地址)');
});

test('初步诊断：句法风险 → 句标记类型（被/从/完归语法太难，仅超长归句太长）', () => {
  assert.equal(pickSentMarkType({ passive: true, relcl: false, pastperf: false, overlong: false }), 'syntax');
  assert.equal(pickSentMarkType({ passive: false, relcl: true, pastperf: false, overlong: true }), 'syntax'); // 多风险并归语法
  assert.equal(pickSentMarkType({ passive: false, relcl: false, pastperf: true, overlong: false }), 'syntax');
  assert.equal(pickSentMarkType({ passive: false, relcl: false, pastperf: false, overlong: true }), 'long');
});

test('初步诊断：AI 情节要点并入配额——按文本去重、空串剔除、保持顺序', () => {
  assert.deepEqual(
    mergeQuotaTexts(['保留风车线索', '少校的梦'], [' 少校的梦 ', '雪球被赶走', '', '  ', '保留风车线索']),
    ['雪球被赶走'],
  );
  assert.deepEqual(mergeQuotaTexts([], [' A ', 'B', 'A']), ['A', 'B']);
  assert.deepEqual(mergeQuotaTexts(['X'], ['X', 'X']), []);
});
