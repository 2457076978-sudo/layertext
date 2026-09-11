/**
 * 「查词」工具 回归测试
 *
 * 验收标准（《LayerText 项目审查报告（2026-09-11）》§二）：
 *   「『查词』目前是文本标记往返，应改为严格 schema 的 tool call。」
 * 关键在**严格**：宽松解析等于把文本标记往返的问题换个地方重演。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  collectLookups,
  formatLookupAnswer,
  LOOKUP_MAX_WORDS,
  LOOKUP_TOOL,
  parseLookupArgs,
} from '../src/core/lookuptool.js';

test('schema 本身：工具名/必填/上限/禁额外字段都写死在定义里', () => {
  assert.equal(LOOKUP_TOOL.function.name, 'lookup_words');
  assert.deepEqual(LOOKUP_TOOL.function.parameters.required, ['words']);
  assert.equal(LOOKUP_TOOL.function.parameters.additionalProperties, false);
  assert.equal(LOOKUP_TOOL.function.parameters.properties.words.maxItems, LOOKUP_MAX_WORDS);
});

test('合规参数：去重、小写化', () => {
  const r = parseLookupArgs({ words: ['Windmill', 'barn', 'windmill'] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok && r.words, ['windmill', 'barn']);
});

test('不合规一律报错（这是"严格"的实质）', () => {
  const cases: [unknown, RegExp][] = [
    [null, /必须是对象/],
    [[], /必须是对象/],
    [{}, /words 必须是字符串数组/],
    [{ words: [] }, /不能为空/],
    [{ words: 'windmill' }, /必须是字符串数组/],
    [{ words: [1] }, /非字符串项/],
    [{ words: ['The windmill was broken.'] }, /不是单个英文单词/],
    [{ words: ['风车'] }, /不是单个英文单词/],
    [{ words: ['windmill,' ] }, /不是单个英文单词/],
    [{ words: Array.from({ length: 9 }, (_, i) => `w${i}`) }, /最多查 8 个词/],
    [{ words: ['ok'], extra: 1 }, /未定义的参数/],
  ];
  for (const [input, re] of cases) {
    const r = parseLookupArgs(input);
    assert.equal(r.ok, false, `${JSON.stringify(input)} 应当被拒绝`);
    assert.match(r.ok ? '' : r.error, re);
  }
});

test('刚好到上限可以用，超一个就拒', () => {
  const ok = parseLookupArgs({ words: Array.from({ length: 8 }, () => 'a') });
  assert.equal(ok.ok, true);
  assert.equal(parseLookupArgs({ words: Array.from({ length: 9 }, () => 'a') }).ok, false);
});

test('collectLookups：从 tool_calls 里取参数、解析 JSON 字符串、合并去重', () => {
  const r = collectLookups([
    { id: 'c1', function: { name: 'lookup_words', arguments: '{"words":["windmill","barn"]}' } },
    { id: 'c2', function: { name: 'lookup_words', arguments: { words: ['barn', 'boxer'] } } },
    { id: 'c3', function: { name: '其他的工具', arguments: '{}' } },
  ]);
  assert.deepEqual(r.words, ['windmill', 'barn', 'boxer']);
  assert.deepEqual(r.ids, ['c1', 'c2']);
  assert.deepEqual(r.errors, []);
});

test('collectLookups：坏 JSON / 不合规参数 → 记错误（让上层回一句"请重发"），不猜', () => {
  const r = collectLookups([
    { id: 'c1', function: { name: 'lookup_words', arguments: '{words: windmill}' } },
    { id: 'c2', function: { name: 'lookup_words', arguments: { words: ['The whole sentence.'] } } },
  ]);
  assert.deepEqual(r.words, []);
  assert.equal(r.errors.length, 2);
  assert.match(r.errors[0], /不是合法 JSON/);
});

test('collectLookups：没有 tool_calls 时安静返回空（文本标记回退路径仍可用）', () => {
  assert.deepEqual(collectLookups(undefined), { words: [], ids: [], errors: [] });
  assert.deepEqual(collectLookups([]), { words: [], ids: [], errors: [] });
});

test('问答回灌：状态说清楚，模型才知道"要不要加注"', () => {
  const text = formatLookupAnswer([
    { word: 'barn', known: true },
    { word: 'windmill', known: false, zh: '风车', source: '统一词典已有，按此释义加注' },
  ]);
  assert.match(text, /barn：已收录（学生学过）→ 不要加注/);
  assert.match(text, /windmill：释义「风车」/);
  assert.equal(formatLookupAnswer([]), '（没有需要查的词）');
});
