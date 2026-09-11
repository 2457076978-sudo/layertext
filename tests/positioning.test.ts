/**
 * 产品定位：两条轴分开说 回归测试
 *
 * 验收标准（《LayerText 审查报告 v4_方向》）：
 *   「产品定位应明确为『受控的分层阅读适配』：简化负责句法和词汇负荷，加注负责即时理解支架。
 *     **不要把两者包装成同一指标**；销售文案和界面都应分别显示『阅读负荷下降』和
 *     『理解支架覆盖率』。」
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { POSITIONING_LINE, positioningLines, positioningOf } from '../src/core/positioning.js';

const qc = (newWordRate: number, annotationCoverage = 1, annotated = 0, annotatable = 0) => ({
  newWordRate, annotationCoverage, annotated, annotatable,
});

test('两条轴各算各的：负荷看生词率降幅，支架看加注覆盖率', () => {
  const p = positioningOf(qc(0.24), qc(0.12, 0.86, 43, 50));
  assert.equal(p.load.name, '阅读负荷下降');
  assert.equal(p.scaffolding.name, '理解支架覆盖率');
  assert.equal(Math.round(p.load.value * 100), 50, '24% → 12% 是相对下降 50%');
  assert.equal(p.scaffolding.value, 0.86);
  assert.deepEqual(p.newWordRate, { source: 0.24, out: 0.12 });
});

test('★ 不合成一个数：headline 里两个名字都在，没有"综合得分"这种字段', () => {
  const p = positioningOf(qc(0.2), qc(0.1, 0.9, 9, 10));
  assert.match(p.headline, /阅读负荷下降 50%/);
  assert.match(p.headline, /理解支架覆盖率 90%/);
  assert.deepEqual(Object.keys(p).sort(), ['headline', 'load', 'newWordRate', 'scaffolding'], '不许偷偷多一个"综合指标"');
});

test('★ 每条轴都要写清它**不**代表什么（防误读比解释更值钱）', () => {
  const p = positioningOf(qc(0.2), qc(0.1, 0.9, 9, 10));
  assert.match(p.scaffolding.notThis, /不减少阅读负荷/);
  assert.match(p.load.notThis, /不代表学生读起来更轻松/);
  const lines = positioningLines(p).join('\n');
  assert.match(lines, /给难词配拐杖/);
});

test('相对降幅而不是绝对百分点：4% → 2% 与 24% → 12% 不该被说成同一件事', () => {
  const small = positioningOf(qc(0.04), qc(0.02, 1, 1, 1));
  const big = positioningOf(qc(0.24), qc(0.12, 1, 1, 1));
  assert.equal(Math.round(small.load.value * 100), Math.round(big.load.value * 100), '两处都降了一半——数值相同');
  // 但"是什么"那句里带着两端的绝对数，人不会看错
  assert.match(small.load.what, /4\.0% 降到 2\.0%/);
  assert.match(big.load.what, /24\.0% 降到 12\.0%/);
});

test('原文生词率为 0 时不除零，也不编一个下降率出来', () => {
  const p = positioningOf(qc(0), qc(0.5, 5, 10));
  assert.equal(p.load.value, 0);
  assert.equal(Number.isFinite(p.load.value), true);
});

test('定位一句话进得了文案（说清"是什么"，不吹"变简单了"）', () => {
  assert.match(POSITIONING_LINE, /受控的分层阅读适配/);
  assert.match(POSITIONING_LINE, /不合成一个数/);
});

test('报告两行：先轴名、再含义、再"不是什么"', () => {
  const lines = positioningLines(positioningOf(qc(0.3), qc(0.15, 0.8, 8, 10)));
  assert.equal(lines.length, 4);
  assert.match(lines[0]!, /^\*\*阅读负荷下降\*\*：/);
  assert.match(lines[2]!, /^\*\*理解支架覆盖率\*\*：/);
});
