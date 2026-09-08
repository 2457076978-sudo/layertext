/** 双栏逐句对照纯逻辑测试：句级对齐（锚点/间隙配对/换序）+ 信号丢失检测（数字/专名） */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alignSentencePairs, lostSignals, signalsOf, type AlignSentRef } from '../app/src/pure.js';

const ref = (texts: string[]): AlignSentRef[] => texts.map((text, i) => ({ pi: Math.floor(i / 3), si: i % 3, text }));

test('alignSentencePairs：完全相同 → 全部 match 锚点，无丢失', () => {
  const s = ref(['Mr. Jones locked the hen-houses.', 'He was too drunk.', 'The animals sang three songs.']);
  const rows = alignSentencePairs(s, ref([...s.map((x) => x.text)]));
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.kind === 'match' && !r.lostSignals));
});

test('alignSentencePairs：基准删句 → lost 行；当前加句 → added 行', () => {
  const base = ref(['A big storm came in the night.', 'The wind broke the windmill.', 'All the animals were sad.']);
  const cur = ref(['A big storm came in the night.', 'All the animals were sad.', 'They started to rebuild it.']);
  const rows = alignSentencePairs(base, cur);
  const lost = rows.filter((r) => r.kind === 'lost');
  const added = rows.filter((r) => r.kind === 'added');
  assert.equal(lost.length, 1);
  assert.equal(lost[0].base?.text, 'The wind broke the windmill.');
  assert.equal(added.length, 1);
  assert.equal(added[0].cur?.text, 'They started to rebuild it.');
});

test('alignSentencePairs：改写句（词换结构近）→ match 配对而非丢失', () => {
  const base = ref(['Napoleon gave the two pigs seven commandments to remember.']);
  const cur = ref(['Napoleon told the pigs to remember the seven commandments.']);
  const rows = alignSentencePairs(base, cur);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'match');
});

test('alignSentencePairs：两句换序 → 都配对上（间隙贪心按相似度）', () => {
  const base = ref(['The hens laid two hundred eggs in the barn.', 'Snowball ran quickly across the field.']);
  const cur = ref(['Snowball ran quickly across the big field.', 'The hens laid two hundred eggs in the new barn.']);
  const rows = alignSentencePairs(base, cur);
  assert.equal(rows.filter((r) => r.kind === 'match').length, 2);
  assert.equal(rows.find((r) => r.base === base[0])?.cur?.text, cur[1].text); // 换序：base[0] ↔ cur[1]
  assert.equal(rows.find((r) => r.base === base[1])?.cur?.text, cur[0].text);
});

test('lostSignals：数字消失被检出，数字词与阿拉伯数字互认不误报', () => {
  assert.deepEqual(lostSignals('They had seven dogs and 3 horses.', 'They had seven dogs and three horses.'), []); // 3↔three 互认
  const lost = lostSignals('They had seven dogs and 3 horses.', 'They had some dogs.');
  assert.deepEqual([...lost].sort(), ['3', '7']);
  assert.ok(lostSignals('In 1917 the farm had twelve cows.', 'Long ago the farm had many cows.').includes('1917'));
});

test('lostSignals：专名消失被检出；句首大写词不误报', () => {
  assert.deepEqual(lostSignals('Napoleon and Snowball argued all day.', 'Napoleon argued all day.'), ['Snowball']);
  assert.deepEqual(lostSignals('The pigs were happy. Jones was gone.', 'The pigs were happy. The man was gone.'), ['Jones']);
  assert.deepEqual(lostSignals('The dog barked at night.', 'The dog barked in the night.'), []); // 句首 The 不算专名
});

test('signalsOf：数字、数字词、句中专名都抽取', () => {
  const out = signalsOf('Boxer woke at 6 and met Muriel twice.');
  assert.ok(out.includes('6') && out.includes('2') && out.includes('Boxer') && out.includes('Muriel'));
});
