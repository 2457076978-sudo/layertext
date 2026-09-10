/**
 * 跨版本标记同步 · 单测：词级每处出现建标 / 目标无此词跳过 / 幂等跳过 / 短语词序列匹配 / 句级不同步 / 大小写不敏感
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { syncMarksToMd } from '../app/src/pure.js';
import type { Mark } from '../app/src/types.js';

const TGT_MD = '# B\n\n## Chapter One\n\n[P01] The donkey laughed. The Donkey saw a cynical boar near the hen-houses.\n';

let seq = 0;
const newId = (): string => `t${seq++}`;

const wm = (word: string, type: Mark['type'] = 'simpl'): Mark => ({
  id: 's' + seq,
  level: 'word',
  pi: 0,
  si: 0,
  wi: 1,
  word,
  text: 'The cynica',
  type,
  ts: 1,
});

test('词级同步：目标版本每处出现都建标（大小写不敏感），位置按目标自己的段落/句/词索引', () => {
  seq = 0;
  const plan = syncMarksToMd([wm('boar')], TGT_MD, [], newId);
  assert.equal(plan.totalCreated, 1); // boar 一处
  assert.equal(plan.items[0]!.created[0]!.pi, 0);
  assert.equal(plan.items[0]!.created[0]!.si, 1); // 在第二句（sentsOf 切分后）
  // 大小写：Donkey vs donkey 两处都命中
  const plan2 = syncMarksToMd([wm('donkey')], TGT_MD, [], newId);
  assert.equal(plan2.totalCreated, 2); // The donkey / The Donkey
  // 新建标记字段完整：level/pi/si/wi/word/text/type
  const c = plan2.items[0]!.created[0]!;
  assert.equal(c.level, 'word');
  assert.equal(typeof c.pi, 'number');
  assert.equal(typeof c.si, 'number');
  assert.equal(c.word, 'donkey');
});

test('目标无此词 → 跳过并记因（更简版本已换掉=已处理，属正常语义）', () => {
  seq = 0;
  const plan = syncMarksToMd([wm('cynical', 'hard')], '# T\n\n## Chapter One\n\n[P01] The donkey laughed a lot.\n', [], newId);
  assert.equal(plan.totalCreated, 0);
  assert.equal(plan.items[0]!.skipped, 'not-found');
});

test('幂等：目标已有同词同类型标记 → 整条跳过（不重复建）', () => {
  seq = 0;
  const existing: Mark[] = [wm('boar', 'simpl')];
  const plan = syncMarksToMd([wm('boar', 'simpl')], TGT_MD, existing, newId);
  assert.equal(plan.totalCreated, 0);
  assert.equal(plan.items[0]!.skipped, 'duplicate');
  // 同词不同类型 ≠ 重复（教师可对同一词有另一种意图）
  const plan2 = syncMarksToMd([wm('boar', 'zh')], TGT_MD, existing, newId);
  assert.ok(plan2.totalCreated > 0);
});

test('短语级同步：连续词序列匹配处建标（带 wl），目标无完整短语则跳过', () => {
  seq = 0;
  const pm: Mark = { id: 'p', level: 'phrase', pi: 0, si: 0, wi: 1, wl: 2, word: 'tired of', text: 'x', type: 'zh', ts: 1 };
  const md = '# T\n\n## Chapter One\n\n[P01] Alice was tired of sitting. She was tired of the rain.\n';
  const plan = syncMarksToMd([pm], md, [], newId);
  assert.equal(plan.totalCreated, 2);
  assert.equal(plan.items[0]!.created[0]!.level, 'phrase');
  assert.equal(plan.items[0]!.created[0]!.wl, 2);
  const plan2 = syncMarksToMd([pm], '# T\n\n## Chapter One\n\n[P01] Alice was tired and sat.\n', [], newId);
  assert.equal(plan2.totalCreated, 0);
  assert.equal(plan2.items[0]!.skipped, 'not-found');
});

test('句级标记不同步；无 word 的标记不入同步', () => {
  seq = 0;
  const sm: Mark = { id: 'x', level: 'sent', pi: 0, si: 0, text: 'The cynica', type: 'long', ts: 1 };
  const plan = syncMarksToMd([sm], TGT_MD, [], newId);
  assert.equal(plan.items.length, 0);
});

test('连字符词形态：目标里 hen-houses 被拆句归一成两个词，词序列匹配按归一口径走', () => {
  seq = 0;
  const pm: Mark = { id: 'p', level: 'phrase', pi: 0, si: 0, wi: 0, wl: 2, word: 'hen houses', text: 'x', type: 'zh', ts: 1 };
  const plan = syncMarksToMd([pm], '# T\n\n## Chapter One\n\n[P01] They walked past the hen-houses slowly.\n', [], newId);
  assert.equal(plan.totalCreated, 1); // sentsOf 归一后 hen houses 两词连续命中
});

test('origin 溯源随标记复制（传播感知）：源带 origin → 每处新建标记都带；无 origin → 不带', () => {
  seq = 0;
  const src: Mark = { ...wm('donkey'), origin: 'A层挑战' };
  const plan = syncMarksToMd([src], TGT_MD, [], newId);
  assert.equal(plan.totalCreated, 2);
  for (const c of plan.items[0]!.created) assert.equal(c.origin, 'A层挑战'); // 低层侧栏 ⇄ 徽章/看板传播列的数据载体
  const plan2 = syncMarksToMd([wm('boar')], TGT_MD, [], newId);
  assert.equal(plan2.items[0]!.created[0]!.origin, undefined); // 本地标记不带（向后兼容：旧 JSON 无字段同态）
});
