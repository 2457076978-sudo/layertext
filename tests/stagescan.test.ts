/**
 * 工序化调适 · 本地工序扫描测试（四方向方案 v2 §3.2）
 *
 * 锁三件事：
 *   ① 每道工序的判定复用既有口径（阈值断言对着 adaptcheck 的试运行阈值表打）；
 *   ② 「零调用」判定：干净段在各道工序都返回空清单；
 *   ③ 家族容错与专名豁免（running→run 命中已知；Napoleon 不计 OOV）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { scanFor, annoDensityOf } from '../src/core/stagescan.js';
import type { ScanCtx } from '../src/core/stagescan.js';

const ctx = (over: Partial<ScanCtx> = {}): ScanCtx => ({
  tier: 'M',
  knownWords: new Set(['the', 'run', 'work', 'hard', 'day', 'animal', 'farm', 'was', 'big', 'wind', 'mill', 'and', 'all', 'were', 'fast', 'they']),
  properNouns: ['Napoleon'],
  glossary: new Map([['harvest', '收获']]),
  ...over,
});

test('词汇粗筛：词表外实词命中，专名与短词不计', () => {
  const seg = { id: 'P01', source: '[P01] src', draft: '[P01] Napoleon worked hard and tyrannised the animals.' };
  const issues = scanFor('vocab-primary', seg, ctx());
  assert.deepEqual(issues, ['tyrannised'], 'tyrannised 命中；Napoleon 专名不计；三字母以下不计');
});

test('词汇粗筛：家族容错——running 命中已知 run，不算 OOV', () => {
  const seg = { id: 'P01', source: '[P01] s', draft: '[P01] They were running fast.' };
  assert.deepEqual(scanFor('vocab-primary', seg, ctx()), []);
});

test('词汇粗筛：已加注的词仍算 OOV（注释不改变词汇边界，只是显示层）', () => {
  const seg = { id: 'P01', source: '[P01] s', draft: '[P01] The harvest（收获） came.' };
  const issues = scanFor('vocab-primary', seg, { ...ctx(), knownWords: new Set(['the', 'came']) });
  assert.deepEqual(issues, ['harvest']);
});

test('句法调适：超长句/被动/定从/过去完成按层检查线命中', () => {
  const long = '[P01] ' + 'word '.repeat(20).trim() + '.';
  assert.ok(scanFor('syntax', { id: 'P01', source: '', draft: long }, { ...ctx(), tier: 'M' })[0]?.includes('超长句'), 'M 层 20 词超 17 检查线');
  assert.deepEqual(scanFor('syntax', { id: 'P01', source: '', draft: '[P01] They worked hard.' }, ctx()), [], '干净段零命中');

  const passive = '[P01] The plan was completed by the animals.';
  const kinds = scanFor('syntax', { id: 'P01', source: '', draft: passive }, ctx());
  assert.ok(kinds.includes('被动语态'), `被动命中（实得 ${kinds.join(',')}）`);

  const pastperf = '[P01] Napoleon had finished the task before sunset.';
  assert.ok(scanFor('syntax', { id: 'P01', source: '', draft: pastperf }, ctx()).includes('过去完成'));
});

test('词汇复筛：对上一道产稿取差集，只报新引入的词表外词', () => {
  const c = ctx({ prevStageText: '[P01] Napoleon worked hard. [P02] The animals ran.' });
  const seg = { id: 'P02', source: '[P02] s', draft: '[P02] The animals fabricated a story.' };
  const issues = scanFor('vocab-secondary', seg, c);
  assert.equal(issues.length, 1);
  assert.ok(issues[0]!.includes('fabricated'), 'ran/worked 在上一道稿里，不算引入');
  assert.deepEqual(scanFor('vocab-secondary', seg, ctx()), [], '没有 prevStageText 时复筛不空转');
});

test('连贯性：原文信号丢失、否定/因果整段清零都要点名', () => {
  const src = '[P01] Napoleon kept 9 dogs and did not feed them because they failed.';
  const lost = scanFor('coherence', { id: 'P01', source: src, draft: '[P01] Napoleon kept some dogs.' }, ctx());
  assert.ok(lost.some((x) => x.includes('9')), '数字 9 丢失');
  assert.ok(lost.some((x) => x.includes('否定')), '否定整段消失');
  assert.ok(lost.some((x) => x.includes('因果')), '因果连接消失');

  const kept = scanFor('coherence', { id: 'P01', source: src, draft: '[P01] Napoleon kept 9 dogs and did not feed them because they failed.' }, ctx());
  assert.deepEqual(kept, [], '原样段零命中');
});

test('最终加注：只报未进账本的词（一词一注，注过不重复）', () => {
  const seg = { id: 'P01', source: '[P01] s', draft: '[P01] The harvest came and tyrannised everyone.' };
  const issues = scanFor('annotation', seg, ctx());
  assert.ok(issues.length === 1 && issues[0]!.includes('tyrannised'), 'harvest 已在账本，只剩 tyrannised');
  assert.ok(!issues[0]!.includes('harvest'));
});

test('干净段五道工序全部零命中（零调用判定的事实依据）', () => {
  const seg = { id: 'P01', source: '[P01] Napoleon worked hard.', draft: '[P01] Napoleon worked hard.' };
  for (const stage of ['vocab-primary', 'syntax', 'vocab-secondary', 'coherence', 'annotation'] as const) {
    assert.deepEqual(scanFor(stage, seg, ctx()), [], `${stage} 应零命中`);
  }
});

test('加注配额：教师必注词优先、层配额封顶；超额必须点名返工而非静默', () => {
  const seg = { id: 'P01', source: '[P01] s', draft: '[P01] alpha tyrannised beta grudge gamma hitherto.' };
  const c = ctx({ annoCap: 2, mustAnnotate: new Set(['grudge']) });
  const issues = scanFor('annotation', seg, c);
  assert.equal(issues.length, 2, '配额行 + 超额行分开说');
  assert.ok(issues[0]!.includes('grudge'), 'KB 必注词插队进配额');
  assert.ok(issues[1]!.includes('超出本层注释配额') && issues[1]!.includes('返工替换'), '超额词点名且必须返工（不许静默不注）');
  assert.ok(issues[1]!.includes('hitherto'), '配额外的词在超额清单里可见');
  assert.ok(!issues[0]!.slice(0, issues[0]!.indexOf('：', 6)).includes('hitherto'), '配额行不含超额词');
});

test('注释密度：处/百词口径，加注预算与检查同尺', () => {
  const d = annoDensityOf(['[P01] word word word word word', '[P02] a（一） b（二） word word']);
  assert.equal(d.annos, 2);
  assert.equal(d.words, 9, '注释括号里的中文不算英文词、段标记的 P 不算词');
});
