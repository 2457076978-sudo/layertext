/**
 * 待确认队列回归测试
 *
 * 验收的是"三路结论合成一张表"这件事里最容易出错的三处：
 *   1. **层写法归一**——补注队列写 `A层85`、正本核对写 `A`；不归一就会出现
 *      "同一个词算两件事"，教师点两遍、台账记两条，而人以为只点了一次；
 *   2. **重算不抹决定**——队列可以随时重跑，但教师点过的 status 必须带回来；
 *   3. **同处双来源合并成一条**——不该让教师为同一处点两次。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fromAnnotateItem, fromCanonRow, mergePending, normalizeTier, pendingCountOf, parseSpecifiedReplacement, pendingIdOf, type PendingItem } from '../src/core/pendingqueue.js';

const sent = (w: string, p: string) => `（${p} 里含 ${w} 的那句）`;

const anno = (over: Partial<Parameters<typeof fromAnnotateItem>[0]> = {}): PendingItem =>
  fromAnnotateItem({ word: 'unsteady', chapter: '第一章', tier: 'A层85', para: 'P01', sentence: 'He walked with unsteady steps.', gloss: '摇晃的', source: 'model', ...over });

const canon = (over: Partial<Parameters<typeof fromCanonRow>[0]> = {}): PendingItem =>
  fromCanonRow({ tier: 'A', chapter: '第一章', para: 'P03', word: 'straw', zh: '稻草', star: false, ...over }, sent);

test('层写法归一：A → A层85，tag 原样，认不出不猜', () => {
  assert.equal(normalizeTier('A'), 'A层85');
  assert.equal(normalizeTier('M'), 'M层75');
  assert.equal(normalizeTier('B'), 'B层60');
  assert.equal(normalizeTier('A层85'), 'A层85');
  assert.equal(normalizeTier('A层挑战'), 'A层85', '带后缀也认得出来');
  assert.equal(normalizeTier('X'), 'X', '认不出就原样——不猜');
});

test('稳定 ID：与层写法无关（A 和 A层85 是同一条）', () => {
  const a = pendingIdOf({ tier: 'A', chapter: '第一章', para: 'P01', word: 'Straw' });
  const b = pendingIdOf({ tier: 'A层85', chapter: '第一章', para: 'P01', word: 'straw' });
  assert.equal(a, b, '层写法与大小写都不该造成两条');
});

test('补注项：why 说清它为什么在这里；词典命中的与模型候选的要分开', () => {
  assert.match(anno({ source: 'dict' }).why, /词典里已有释义/);
  assert.match(anno({ source: 'model' }).why, /给不出注释支持/);
  assert.equal(anno().kind, 'annotate');
});

test('正本项：★加注词的措辞要不一样（判据更硬）', () => {
  assert.match(canon({ star: true }).why, /★加注词/);
  assert.match(canon({ star: false }).why, /词典登记过/);
  assert.equal(canon().kind, 'restore');
});

test('合并排序：★加注词 → 正本 → 补注（教师从上往下扫，先看判据最硬的）', () => {
  const items = mergePending([anno({ word: 'w1' }), anno({ word: 'w2' })], [canon({ word: 'c1', star: true }), canon({ word: 'c2' })]);
  assert.deepEqual(
    items.map((i) => i.word),
    ['c1', 'c2', 'w1', 'w2'],
  );
});

test('同处双来源合并成一条（不让教师为同一处点两次）', () => {
  const a = anno({ word: 'straw', para: 'P03' });
  const c = canon({ word: 'straw', para: 'P03' });
  const items = mergePending([a], [c]);
  assert.equal(items.length, 1, '同层章段词只该留一条');
  assert.equal(items[0]!.kind, 'restore', '呈现按**更强的判据**——教师自己的词典优先于引擎的缺口报告');
  assert.equal(items[0]!.gloss, '稻草', '释义取正本的（那才是要插进正文的那个）');
  assert.match(items[0]!.why, /｜/, '两个来源的理由都要看得见');
});

test('重算不抹决定：教师点过的 status 必须带回来', () => {
  const before = mergePending([anno()], [canon()]);
  const decided = before.map((i) => ({ ...i, status: 'annotated', decidedAt: '2026-09-13T00:00:00.000Z' }));
  const after = mergePending([anno()], [canon()], decided);
  assert.equal(after.length, decided.length);
  assert.equal(after[0]!.status, 'annotated', '队列重跑一次，教师点过的东西不能又冒出来');
  assert.equal(after[0]!.decidedAt, '2026-09-13T00:00:00.000Z');
});

test('待处理计数：已决定的不算，可按章过滤', () => {
  const items = [anno({ chapter: '第一章' }), anno({ word: 'x', chapter: '第二章' }), { ...anno({ word: 'y' }), status: 'keep' }];
  assert.equal(pendingCountOf(items), 2);
  assert.equal(pendingCountOf(items, '第一章'), 1);
  assert.equal(pendingCountOf(items, '第三章'), 0);
});

test('教师指定的替换词要能从备注里解出来（人定的不能被机器再问一遍覆盖）', () => {
  assert.deepEqual(parseSpecifiedReplacement('教师指定替换：cynical → unkind'), { word: 'cynical', replacement: 'unkind' });
  assert.deepEqual(parseSpecifiedReplacement('教师指定替换：overlooked → missed'), { word: 'overlooked', replacement: 'missed' });
  assert.equal(parseSpecifiedReplacement('教师判定：这个词忽略，不注也不换'), null);
  assert.equal(parseSpecifiedReplacement(undefined), null);
  assert.equal(parseSpecifiedReplacement('教师指定替换： → x'), null, '空原词不算');
});
