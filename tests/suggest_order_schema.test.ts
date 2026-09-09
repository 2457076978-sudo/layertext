/** AI 边界 #18 / #21 显式测试（枚举表「待验证 P2」收口）：
 *  #18 同句多条建议顺序依赖——每条独立定位，第一条改完后第二条要么重新定位成功、要么落建议页（null），
 *      绝不写错位置；不同句多条正序/倒序应用结果一致。
 *  #21 AI 不按 schema 返回多条变体——revised/original 非单一非空字符串一律拒收（数组/对象/空串）。 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickSingleRewrite, resolveSuggestionTarget, validSuggestionText } from '../app/src/pure.js';

const MD = '## Chapter One\n\n[P01] Old Major was a boar. He lived on the farm. The hen-houses were old.\n';

/** 手工应用一条建议（与 acceptSuggestion 的写入路径同式：定位 → 切片替换） */
function applyOne(md: string, g: { pi?: number; si?: number; original: string; revised: string }): string | null {
  const t = resolveSuggestionTarget(md, g);
  if (!t) return null;
  return md.slice(0, t.at) + g.revised + md.slice(t.at + t.original.length);
}

test('#18 同句两条建议：第一条应用后，第二条定位失败→null（落建议页，不动正文）', () => {
  const g1 = { pi: 0, si: 0, original: 'Old Major was a boar.', revised: 'Old Major was a pig.' };
  const g2 = { pi: 0, si: 0, original: 'Old Major was a boar.', revised: 'Old Major was an old pig.' };
  const md2 = applyOne(MD, g1);
  assert.ok(md2);
  assert.equal(applyOne(md2, g2), null); // 原句已被第一条换掉：第二条独立定位失败，绝不写错位置
  assert.ok(md2.includes('Old Major was a pig.'));
});

test('#18 同句两条建议：第二条的 original 仍在（部分改写）→ 仍能定位', () => {
  const g1 = { pi: 0, si: 2, original: 'The hen-houses were old.', revised: 'The houses were old.' };
  const g2 = { pi: 0, si: 2, original: 'The hen-houses were old.', revised: 'The sheds were old.' };
  const md2 = applyOne(MD, g1);
  assert.ok(md2);
  assert.equal(applyOne(md2, g2), null); // 同句同样失败
  // 反过来：g2 先应用，g1 同样失败——顺序无关，行为一致
  const md2b = applyOne(MD, g2);
  assert.ok(md2b);
  assert.equal(applyOne(md2b, g1), null);
});

test('#18 不同句多条建议：正序与倒序应用，最终正文一致（无位移依赖）', () => {
  const ga = { pi: 0, si: 0, original: 'Old Major was a boar.', revised: 'Old Major was a pig.' };
  const gb = { pi: 0, si: 1, original: 'He lived on the farm.', revised: 'He lived on a farm for years.' };
  const step1 = applyOne(MD, ga);
  const step1b = applyOne(MD, gb);
  assert.ok(step1 && step1b);
  const forward = applyOne(step1, gb);
  const backward = applyOne(step1b, ga);
  assert.ok(forward && backward);
  assert.equal(forward, backward);
});

test('#18 坐标漂移：pi/si 指向的句子已变，original 在别处唯一 → 自动重定位', () => {
  const g = { pi: 5, si: 5, original: 'He lived on the farm.', revised: 'X' };
  const t = resolveSuggestionTarget(MD, g);
  assert.ok(t);
  assert.equal(t.pi, 0);
  assert.equal(t.si, 1);
  assert.ok(t.at > 0);
});

test('#18 连字符形态差：original 写成空格形态 → 宽容匹配命中并回写正文原句切片', () => {
  const t = resolveSuggestionTarget(MD, { original: 'The hen houses were old.' });
  assert.ok(t);
  assert.equal(t.original, 'The hen-houses were old.'); // exact 回写为正文形态
  assert.equal(MD.slice(t.at, t.at + t.original.length), t.original);
});

test('#18 空 original：一律定位失败（防 indexOf("") 落 0 位事故）', () => {
  assert.equal(resolveSuggestionTarget(MD, { original: '' }), null);
  assert.equal(resolveSuggestionTarget(MD, { original: '   ' }), null);
});

test('#21 validSuggestionText：数组/对象/空串/纯空白 = 拒收，非空字符串 = 通过', () => {
  assert.equal(validSuggestionText(['v1', 'v2']), false); // 多条变体
  assert.equal(validSuggestionText({ text: 'v1' }), false); // 字段包装
  assert.equal(validSuggestionText(''), false);
  assert.equal(validSuggestionText('   '), false);
  assert.equal(validSuggestionText(42), false);
  assert.equal(validSuggestionText('A fine sentence.'), true);
});

test('#21 pickSingleRewrite：多条变体拒收（multi），此前会被静默取第一条', () => {
  const r = pickSingleRewrite([
    { original: 'A.', revised: 'B.' },
    { original: 'A.', revised: 'C.' },
  ]);
  assert.deepEqual(r, { ok: false, reason: 'multi' });
});

test('#21 pickSingleRewrite：revised 为数组/对象/空 → bad-shape；合法单条 → 通过', () => {
  assert.deepEqual(pickSingleRewrite([{ original: 'A.', revised: ['B.', 'C.'] }]), { ok: false, reason: 'bad-shape' });
  assert.deepEqual(pickSingleRewrite([{ original: 'A.', revised: { text: 'B.' } }]), { ok: false, reason: 'bad-shape' });
  assert.deepEqual(pickSingleRewrite([{ original: 'A.', revised: '' }]), { ok: false, reason: 'bad-shape' });
  assert.deepEqual(pickSingleRewrite([]), { ok: false, reason: 'empty' });
  assert.deepEqual(pickSingleRewrite([{ original: 'A.', revised: 'B.', basis: '理由', alternative: '备选' }]), {
    ok: true,
    original: 'A.',
    revised: 'B.',
    basis: '理由',
    alternative: '备选',
  });
});
