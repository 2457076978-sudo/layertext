/**
 * M1 防坑规则回归测试（含验收标准四条必测用例）
 * 权威行为 = 原型 qc_chapter.py；每条用例注明对应的坑。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lexiconFromWords } from '../src/core/lexicon.js';
import { pyRound1, runQc, type QcOptions } from '../src/core/qc.js';
import { hit, pendHit } from '../src/core/textpipe.js';

function qc(paras: string[], known: string[] = [], opts: Partial<QcOptions> = {}, pending: string[] = []) {
  const md =
    '## Chapter One\n\n' +
    paras.map((p, i) => `[P${String(i + 1).padStart(2, '0')}] ${p}`).join('\n\n') +
    '\n';
  return runQc(md, lexiconFromWords(known, pending), { tier: 'M', fileName: 'test.md', ...opts });
}

// ---------- 验收标准：四条防坑回归 ----------

test('坑1a：倒装 "Never had I seen" 计为过去完成', () => {
  const r = qc(['Never had I seen such a tall windmill before.']);
  assert.equal(r.pastperf, 1);
});

test('坑1b：常规 "I had seen" 计为过去完成（不规则分词表）', () => {
  const r = qc(['I had seen the film before that day.']);
  assert.equal(r.pastperf, 1);
});

test('坑2："that morning" 不计定语从句（时间名词豁免）', () => {
  const r = qc(['They left that evening in a hurry.', 'We started work that morning.']);
  assert.equal(r.relcl, 0);
});

test('坑3："said that he was" 不计定语从句（代词先行豁免）', () => {
  const r = qc(['He said that he was tired.', 'She agreed that they were ready.']);
  assert.equal(r.relcl, 0);
});

test('坑4：引号内被动不计数（直接引语豁免 R08）', () => {
  const r = qc(['He said, "The bridge was destroyed by the storm."']);
  assert.equal(r.passive, 0);
  // 对照：引号外同样的被动要计数
  const r2 = qc(['Later the fence was painted green.']);
  assert.equal(r2.passive, 1);
});

// ---------- 假阳性豁免表 ----------

test('坑5：had/was + 形容词或实义过去式的误判全部豁免', () => {
  const r = qc([
    'The barn was red.',        // was red ≠ 被动
    'She was exhausted.',       // 形容词
    'The team was mixed.',      // 形容词
    'He had mixed the seeds.',  // had mixed ≠ 过去完成（实义过去式）
    'The boys were interested in the plan.',
  ]);
  assert.equal(r.passive, 0);
  assert.equal(r.pastperf, 0);
});

// ---------- 其余移植规则 ----------

test('倒装：Hardly/No sooner + had + 分词（须以 ed/en 结尾）', () => {
  const r = qc(['Hardly had she spoken when the bell rang.']);
  assert.equal(r.pastperf, 1);
  const r2 = qc(['No sooner had he eaten than the rain stopped.']);
  assert.equal(r2.pastperf, 1);
});

test('had + 规则分词 ed 计数，且不与倒装重复计数', () => {
  const r = qc(['He had finished his homework before dinner.']);
  assert.equal(r.pastperf, 1);
  // Hardly had she spoken：倒装计 1，"had she" 不构成 had+分词，总数应为 1 而非 2
  const r2 = qc(['Hardly had she spoken when the bell rang.']);
  assert.equal(r2.pastperf, 1);
});

test('that + 实义动词型定从计数；that+名词/代词豁免', () => {
  const r = qc(['The horse that pulled the cart was old and thin.']);
  assert.equal(r.relcl, 1);
});

test('who/which 定从计数（含逗号引导）', () => {
  const r = qc(['The girl who lived next door kept two rabbits.', 'The dog, which barked all night, slept at noon.']);
  assert.equal(r.relcl, 2);
});

test('was/were + 不规则分词被动计数', () => {
  const r = qc(['The geese were driven across the road.']);
  assert.equal(r.passive, 1);
});

test('过去分词被动后置定语 ", lived by" 计数', () => {
  const r = qc(['He led a quiet life, lived by the river.']);
  assert.equal(r.passive, 1);
});

test('锚点白名单：锚点短语内的句法不计（豁免开关）', () => {
  const body = ['By the next morning, the milk had disappeared from the kitchen.'];
  const noAnchor = qc(body);
  assert.equal(noAnchor.pastperf, 1);
  const withAnchor = qc(body, [], { anchors: ['the milk had disappeared'] });
  assert.equal(withAnchor.pastperf, 0);
});

test('词形还原 hit()：不规则名词与后缀剥离', () => {
  const k = new Set(['goose', 'carry', 'stop', 'fire', 'box', 'study', 'tooth', 'sing', 'went']);
  assert.equal(hit('geese', k), true, 'geese→goose（不规则名词表）');
  assert.equal(hit('carried', k), true, 'carried→carry（ied→y）');
  assert.equal(hit('stopped', k), true, 'stopped→stop（双写辅音）');
  assert.equal(hit('fired', k), true, 'fired→fire（去 e 型）');
  assert.equal(hit('boxes', k), true, 'boxes→box（es）');
  assert.equal(hit('studies', k), true, 'studies→study（ies→y）');
  assert.equal(hit('teeth', k), true, 'teeth→tooth');
  assert.equal(hit('went', k), true, '不规则表直查');
  assert.equal(hit('xylophone', k), false, '词表外不命中');
});

test('待定词 token 命中（缩窄后缀集，含复数还原）', () => {
  const p = new Set(['windmill', 'meadow']);
  assert.equal(pendHit('windmills', p), true);
  assert.equal(pendHit('meadow', p), true);
  assert.equal(pendHit('meadows', p), true);
  assert.equal(pendHit('harvest', p), false);
});

test('⑨ 待定词命中数指标', () => {
  const r = qc(['Two windmills stood in the meadow.'], [], {}, ['windmill', 'meadow']);
  assert.equal(r.pendingHits, 2);
});

test('句长指标：超 20 词句计数与最长句', () => {
  const long = 'The old farmer walked slowly along the narrow road between two green fields and thought about the long cold winter that was coming to the small quiet village near the river again this year.';
  const r = qc([long, 'She slept.']);
  assert.equal(r.over20, 1);
  assert.ok(r.maxLen >= 30);
});

test('词句卡首列词条并入已知（注释后口径）', () => {
  const md =
    '## Chapter One\n\n[P01] The windmill turned slowly.\n\n## 词句卡\n\n| 词 | 释义 |\n|---|---|\n| windmill | 风车 |\n';
  const r = runQc(md, lexiconFromWords([]), { tier: 'M', fileName: 't.md' });
  assert.ok(!r.oov.includes('windmill'), '词句卡词条不应进 OOV');
});

test('引号内定从/过去完成同样豁免（引语只降词不降句式的对偶面）', () => {
  const r = qc(['She said, "The house that Jack built had fallen."']);
  assert.equal(r.relcl, 0);
  assert.equal(r.pastperf, 0);
});

test('已知保守行为：无认知动词前导的 that+动词仍计定从（Python 版 _CO 未启用的忠实行为）', () => {
  // "said that surprised everyone" 在 Python 版会计 1（_CO 表定义了但未接线）。
  // 本测试锁定该保守行为；若产品层决定启用认知动词豁免，需同步更新本测试与对照报告。
  const r = qc(['She said that surprised everyone in the room.']);
  assert.equal(r.relcl, 1);
});

test('pyRound1 与 Python round(x,1) 一致（半偶 + 二进制真值）', () => {
  assert.equal(pyRound1(6.25), 6.2); // 6.25 精确可表示，半偶 → 6.2
  assert.equal(pyRound1(6.35), 6.3); // 6.35 二进制真值 6.3499… → 6.3
  assert.equal(pyRound1(7.75), 7.8); // 精确 .75，77.5 半偶 → 7.8
});
