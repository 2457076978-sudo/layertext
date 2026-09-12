/**
 * 叙事保真度测量 · 纯函数测试（向量合成，无模型依赖）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cosine, smithWatermanAlign, paragraphSimilarities } from '../src/core/narrative.js';

/** 用正交基合成可控相似度的假向量 */
const dim = 8;
const axis = (k: number): number[] => Array.from({ length: dim }, (_, i) => (i === k % dim ? 1 : 0));
const mix = (a: number, b: number, t: number): number[] => axis(a).map((v, i) => v * (1 - t) + axis(b)[i]! * t);

test('cosine：正交=0、同向=1、零向量=0', () => {
  assert.equal(cosine(axis(0), axis(1)), 0);
  assert.ok(Math.abs(cosine(axis(2), axis(2)) - 1) < 1e-9);
  assert.equal(cosine([0, 0], [1, 1]), 0);
});

test('smithWatermanAlign：逐句改写全配对，覆盖率 100%', () => {
  // 原文 3 句 = 纯轴；简化 = 同轴混 20% 噪声（cos≈0.98）
  const base = [axis(0), axis(1), axis(2)];
  const simp = [mix(0, 3, 0.2), mix(1, 4, 0.2), mix(2, 5, 0.2)];
  const r = smithWatermanAlign(base, simp, { tau: 0.6, gap: 0.3 });
  assert.equal(r.pairs.length, 3);
  assert.equal(r.uncoveredBase.length, 0);
  assert.deepEqual([...r.coveredBase].sort(), [0, 1, 2]);
});

test('smithWatermanAlign：简化版丢一句 → 该原文句进未对齐清单（丢事件候选）', () => {
  const base = [axis(0), axis(1), axis(2)];
  const simp = [mix(0, 3, 0.2), mix(2, 5, 0.2)]; // 中句没讲
  const r = smithWatermanAlign(base, simp, { tau: 0.6, gap: 0.3 });
  assert.deepEqual(r.uncoveredBase, [1]);
});

test('smithWatermanAlign：无关句（cos<tau）不进对齐，全部未覆盖', () => {
  const base = [axis(0), axis(1)];
  const simp = [axis(4), axis(5)];
  const r = smithWatermanAlign(base, simp, { tau: 0.6, gap: 0.3 });
  assert.equal(r.pairs.length, 0);
  assert.equal(r.uncoveredBase.length, 2);
});

test('smithWatermanAlign：空输入不崩', () => {
  const r = smithWatermanAlign([], [axis(0)], { tau: 0.6, gap: 0.3 });
  assert.deepEqual(r.uncoveredBase, []);
  const r2 = smithWatermanAlign([axis(0)], [], { tau: 0.6, gap: 0.3 });
  assert.deepEqual(r2.uncoveredBase, [0]);
});

test('paragraphSimilarities：低分与缺段都标 risky', () => {
  const base = new Map([
    ['P01', axis(0)],
    ['P02', axis(1)],
    ['P03', axis(2)],
  ]);
  const simp = new Map([
    ['P01', mix(0, 1, 0.1)],
    ['P02', axis(6)],
  ]); // P03 整段缺失
  const r = paragraphSimilarities(base, simp, 0.6);
  assert.equal(r.find((x) => x.segId === 'P01')!.risky, false);
  assert.equal(r.find((x) => x.segId === 'P02')!.risky, true);
  const p3 = r.find((x) => x.segId === 'P03')!;
  assert.equal(p3.risky, true);
  assert.ok(Number.isNaN(p3.score), '缺段分数为 NaN（无配对可言）');
});
