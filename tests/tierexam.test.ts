/**
 * 分档 × 考试表现回溯（功能四项 · 项 4）· join 纯函数测试（仓内合成夹具，无学生个体数据）
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EXAM_DISCLAIMER, aggregateByBand, bandsOfWord, baselineRates, bandVerdict, examWordsOf, type Band, type ExamItemInput } from '../src/core/tierexam.js';

/** 合成允许表：良 ⊂ 中 ⊂ 优 的包含结构（真实分档允许表同构）+ 变形归并锚点 keep */
const TABLES: Record<Band, Set<string>> = {
  良: new Set(['keep', 'dog', 'run']),
  中: new Set(['keep', 'dog', 'run', 'honest', 'move']),
  优: new Set(['keep', 'dog', 'run', 'honest', 'move', 'sustain', 'debate']),
};

test('4b：examWordsOf——小写/去标点/去重/连字符保形', () => {
  assert.deepEqual(examWordsOf('Keeping busy; the dogs ran—and The DOGS ran!'), ['keeping', 'busy', 'the', 'dogs', 'ran', 'and']);
});

test('4b：bandsOfWord——hitOrigin 归并（keeping→keep）命中含 keep 的三档；重叠词如实返回多档；词表外为空', () => {
  assert.deepEqual(bandsOfWord('keeping', TABLES), ['良', '中', '优'], 'keeping 归并到 keep，三档都含 keep');
  assert.deepEqual(bandsOfWord('honest', TABLES), ['中', '优'], 'honest 在中/优，不在良');
  assert.deepEqual(bandsOfWord('sustain', TABLES), ['优']);
  assert.deepEqual(bandsOfWord('zebra', TABLES), [], '词表外');
});

test('4b：aggregateByBand——档×梯队均值/题数、词表外题、一题多档各记一次', () => {
  const items: ExamItemInput[] = [
    { words: ['keeping'], rates: { A: 0.9, M: 0.8, B: 0.7 } }, // 良中优
    { words: ['honest'], rates: { A: 0.8, M: 0.6, B: 0.5 } }, // 中优
    { words: ['sustain'], rates: { A: 0.7, M: 0.5, B: 0.3 } }, // 优
    { words: ['zebra'], rates: { A: 0.6, M: 0.6, B: 0.6 } }, // 词表外
  ];
  const aggs = aggregateByBand(items, TABLES);
  const by = Object.fromEntries(aggs.map((a) => [a.band, a])) as Record<string, (typeof aggs)[number]>;
  assert.equal(by['良']!.items, 1, '只有 keeping 题命中良');
  assert.equal(by['良']!.tierRates.B!.mean, 0.7);
  assert.equal(by['中']!.items, 2, 'keeping+honest 两题命中中');
  assert.equal(by['中']!.tierRates.B!.mean, 0.6, '(0.7+0.5)/2');
  assert.equal(by['优']!.items, 3);
  assert.equal(by['优']!.tierRates.M!.mean, (0.8 + 0.6 + 0.5) / 3);
  assert.equal(by['词表外']!.items, 1);
  assert.equal(by['词表外']!.tierRates.B!.mean, 0.6);
  // 缺梯队的题不进该梯队均值（n 如实）
  const aggs2 = aggregateByBand([{ words: ['dog'], rates: { A: 1 } }], TABLES);
  assert.equal(aggs2.find((a) => a.band === '良')!.tierRates.A!.n, 1);
  assert.equal(aggs2.find((a) => a.band === '良')!.tierRates.B, undefined);
});

test('4b：baselineRates + bandVerdict——差值点名最伤/最稳组合，含回溯相关声明', () => {
  const items: ExamItemInput[] = [
    { words: ['keeping'], rates: { A: 0.9, M: 0.8, B: 0.5 } },
    { words: ['zebra'], rates: { A: 0.9, M: 0.9, B: 0.9 } },
  ];
  const base = baselineRates(items);
  assert.ok(Math.abs((base.B ?? 0) - 0.7) < 1e-9, '浮点均值近似 0.7');
  const v = bandVerdict(aggregateByBand(items, TABLES), base);
  assert.match(v, /最伤：[良中优]档词的题在 B 层 -20\.0pp/, '本夹具良中优同含 keeping——并列最伤，任一档皆真');
  assert.match(v, /回溯相关，不作因果解读/);
  assert.match(bandVerdict([], {}), /没有可判读/);
});

test('4d：EXAM_DISCLAIMER 固定声明——exposure≠acquisition 与回溯非因果都在', () => {
  assert.match(EXAM_DISCLAIMER, /exposure ≠ acquisition/);
  assert.match(EXAM_DISCLAIMER, /回溯相关/);
  assert.match(EXAM_DISCLAIMER, /不构成因果证据/);
  assert.match(EXAM_DISCLAIMER, /无学生个体数据/);
});
