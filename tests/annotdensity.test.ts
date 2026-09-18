/**
 * 注密度引擎唯一实现 · 单测（第三梯队项 10a，2026-09-18）
 *
 * `annotationDensityOfChapter` 是注密度的唯一实现：`acceptanceV2` 的全书密度块、
 * App 终审门禁的核对表行（项 10b）都消费这一份。这里锁它的口径与边界：
 * 注释=全角（…）对、词数=注释剥掉后的 [a-z]+、最差段定位、零词防除零、
 * 无段标记工作稿的 ¶ 退化，以及 `ANNO_DENSITY_WARN = 8`（v2.1 定值）。
 * （acceptanceV2 消费此函数后的全书密度数值由 tests/acceptance_golden.test.ts 锁。）
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ANNO_DENSITY_WARN, acceptanceV2, annotationDensityOfChapter, segsOfMd } from '../src/core/acceptance.js';

test('10a：注释剥离口径——只数全角（…）对，半角 () 不算注但同样从词数里剥掉', () => {
  // door（门）= 1 注、1 词；half-width (gate) 不是注、内容也不计词（cleanForAcceptance 剥两种括号）
  const r = annotationDensityOfChapter('[P01] the door（门）and the (gate) shut.');
  // 词：the door and the shut = 5；（门）1 注 → per100 = 20
  assert.deepEqual(r, { per100: 20, worst: { d: 20, at: 'P01' } });
});

test('10a：最差段定位——多段时钉在密度最高的段，段号用 [P##]', () => {
  const md = [
    '[P01] the old keeper walked to the light and saw the sea and the boats near the rock.',
    '',
    '[P02] the door（门）was open.',
    '',
    '[P03] the bell（铃）rang three（三）times at dawn.',
  ].join('\n');
  // P01: 0 注/17 词；P02: 1 注/4 词=25；P03: 2 注/7 词=28.6 → 最差 P03；全书 3 注/28 词=10.7
  const r = annotationDensityOfChapter(md);
  assert.equal(r.worst.at, 'P03');
  assert.equal(r.worst.d, 28.6);
  assert.equal(r.per100, Number(((100 * 3) / 28).toFixed(1)));
});

test('10a：Map 段表与整章 md（有标记）给出同一份数——acceptanceV2 内部口径与调用方口径一致', () => {
  const md = '[P01] the door（门）was open.\n\n[P02] the bell（铃）rang three（三）times at dawn.';
  assert.deepEqual(annotationDensityOfChapter(md), annotationDensityOfChapter(segsOfMd(md)));
});

test('10a：零词章防除零——分母护到 1 不出 NaN/Infinity；空段表给零值与空最差段', () => {
  // 只有注没有词：words=0 → 分母 Math.max(1, words)=1，per100=100（有限值，公式与 acceptanceV2 旧实现一致）
  assert.deepEqual(annotationDensityOfChapter('（只有注释没有词）'), { per100: 100, worst: { d: 0, at: '' } });
  assert.deepEqual(annotationDensityOfChapter(new Map()), { per100: 0, worst: { d: 0, at: '' } });
  // 段内有注但零个英文词：该段密度按 0 计，不产生除零
  const r = annotationDensityOfChapter(
    new Map([
      ['P01', '（门）（铃）'],
      ['P02', 'the door（门）'],
    ]),
  );
  assert.equal(r.worst.at, 'P02');
  assert.equal(r.worst.d, 50); // the door（门）= 1 注/2 词
});

test('10a：无 [P##] 标记的工作稿退化为空行分段（¶1…），最差段仍指得到地方', () => {
  const md = 'the old keeper walked to the light and saw the sea.\n\nthe door（门）was open.';
  const r = annotationDensityOfChapter(md);
  assert.equal(r.worst.at, '¶2');
  assert.equal(r.worst.d, 25);
});

test('10a：警戒线 ANNO_DENSITY_WARN = 8（v2.1 定值，独立指标非硬闸）——改它要走 v2 标准重冻结', () => {
  assert.equal(ANNO_DENSITY_WARN, 8);
  // 边界的语义留给消费方（App 行：>8 才警），这里钉住值本身，防止顺手漂移
});

test('10a：acceptanceV2 的全书密度块消费同一实现——golden 之外的口径一致性快照', () => {
  const md = '[P01] the door（门）was open.\n\n[P02] the bell（铃）rang three（三）times at dawn.';
  const r = acceptanceV2({
    tiers: { A: md, B: '[P01] the door was open.\n\n[P02] the bell rang.' },
    known: ['the', 'door', 'was', 'open', 'bell', 'rang', 'three', 'times', 'at', 'dawn'],
    proper: [],
  });
  assert.deepEqual(r.density.A, annotationDensityOfChapter(md));
  assert.deepEqual(r.density.B.worst, { d: 0, at: '' }, '零注层锁零值');
});
