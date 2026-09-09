/**
 * normalizeGlossMap（AI 边界 #22）· 单测：AI"词→替换"映射的真实形态全兼容
 * 真事故 09-09：parseAiJson 恒返数组（单对象被包一层），Object.assign(gloss, 数组)={0:{…}} 恒空——
 * AI 给的简单词全丢、每个词被误判"换不出"而降级加注（Wayne 实测"词汇简化最后都变成标中文"）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeGlossMap } from '../app/src/pure.js';

test('形态一：纯映射对象被 parseAiJson 包成数组（真事故形态，AI 老实按提示输出）', () => {
  const g = normalizeGlossMap([{ cynical: 'bitter', boar: 'wild pig' }]);
  assert.deepEqual(g, { cynical: 'bitter', boar: 'wild pig' });
});

test('形态二：字段对对象数组（word+simple / 原词+简单词 / from+to 变体）', () => {
  assert.deepEqual(
    normalizeGlossMap([
      { word: 'cynical', simple: 'bitter' },
      { 原词: 'boar', 简单词: '野猪不对，应为 wild pig' },
    ]),
    { cynical: 'bitter', boar: '野猪不对，应为 wild pig' },
  );
  assert.deepEqual(normalizeGlossMap([{ from: 'flood', to: 'big water' }]), { flood: 'big water' });
});

test('容错：非对象元素/空对象/纯字符串值过滤/长键跳过（>48 字符非词条）', () => {
  const longKey = '排版说明'.repeat(13); // 52 字符：真实词条（词/短语）不可能这么长
  const g = normalizeGlossMap(['oops', {}, null, 42, { ok: 'good', [longKey]: 'x' }]);
  assert.deepEqual(g, { ok: 'good' });
});

test('直接对象输入（不经 parseAiJson 的调用方）也能归一化', () => {
  assert.deepEqual(normalizeGlossMap({ cynical: 'bitter' }), { cynical: 'bitter' });
});

import { glossLookup, hasAnyChinese } from '../app/src/pure.js';

test('#23 子集匹配：短语键被 AI 答成子词——剩余词全已知才整块替换（真事故：Seven Commandments）', () => {
  const gloss = { Commandments: 'rules' };
  const known = new Set(['seven', 'the', 'of']);
  const hit = glossLookup(gloss, 'Seven Commandments', known);
  assert.ok(hit);
  assert.equal(hit!.simple, 'rules');
  assert.equal(hit!.via, 'subset');
  // 反例：剩余词未知的短语不整换（防语义破坏）
  const hit2 = glossLookup(gloss, 'Commandments of Animalism', new Set(['of']));
  assert.equal(hit2, null);
});

test('#23 精确命中优先；单词条不走子集匹配；同词值跳过', () => {
  assert.equal(glossLookup({ cynical: 'bitter' }, 'cynical')!.via, 'exact');
  assert.equal(glossLookup({ cynical: 'bitter' }, 'dog'), null);
  assert.equal(glossLookup({ commandments: 'rules' }, 'commandments', new Set(['x']))?.simple, 'rules'); // 小写兜底
  assert.equal(glossLookup({ dog: 'dog' }, 'dog'), null); // AI 回传同词=换不出
});

test('#24 hasAnyChinese：单汉字也算（"七诫"曾漏过 ≥4 字防线）', () => {
  assert.ok(hasAnyChinese('七诫'));
  assert.ok(hasAnyChinese('七诫 rules'));
  assert.ok(!hasAnyChinese('wild pig'));
  assert.ok(!hasAnyChinese(''));
});
