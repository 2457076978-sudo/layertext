/**
 * 资产类别化 + 读者层级树传播 · 纯函数测试
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { propagationKindOf, descendantsOf, normalizeTree, applyWordActionToText, tierTagOfFilename, tierKeyOfTag, DEFAULT_READER_TREE } from '../src/core/propagate.js';

test('propagationKindOf：标注类自动传播、换词记待办、句级不传播', () => {
  assert.equal(propagationKindOf('zh'), 'annotate');
  assert.equal(propagationKindOf('en'), 'annotate');
  assert.equal(propagationKindOf('unanno'), 'annotate');
  assert.equal(propagationKindOf('simpl'), 'rewrite');
  assert.equal(propagationKindOf('anything-else'), 'review');
});

test('descendantsOf：传递闭包+环防护', () => {
  assert.deepEqual(descendantsOf(DEFAULT_READER_TREE, 'A').sort(), ['B', 'M']);
  assert.deepEqual(descendantsOf(DEFAULT_READER_TREE, 'M'), []);
  const deep = { A: ['M', 'B'], B: ['C'] };
  assert.deepEqual(descendantsOf(deep, 'A').sort(), ['B', 'C', 'M']);
  assert.deepEqual(descendantsOf(deep, 'B'), ['C']);
  const cyclic = { A: ['B'], B: ['A'] }; // 配置坏了不许死循环
  assert.deepEqual(descendantsOf(cyclic, 'A'), ['B']);
  assert.deepEqual(descendantsOf({}, 'A'), []);
});

test('normalizeTree：非法形态回退默认树，自引用剔除', () => {
  assert.deepEqual(normalizeTree(null), DEFAULT_READER_TREE);
  assert.deepEqual(normalizeTree('x'), DEFAULT_READER_TREE);
  assert.deepEqual(normalizeTree({ A: 'not-array' }), DEFAULT_READER_TREE);
  assert.deepEqual(normalizeTree({ A: [123, 'M'] }), { A: ['M'] });
  assert.deepEqual(normalizeTree({ A: ['A', 'M'] }), { A: ['M'] }, '自引用剔除');
});

test('applyWordActionToText annotate：首现插注、跳标题行、幂等、带注词不重注', () => {
  const md = '## Chapter One\n\n[P01] The barn was red. Another barn here.\n';
  const r = applyWordActionToText(md, 'barn', 'annotate', '谷仓');
  assert.equal(r.changed, true);
  assert.equal(r.text, '## Chapter One\n\n[P01] The barn（谷仓） was red. Another barn here.\n', '只在首现插一次');
  const again = applyWordActionToText(r.text, 'barn', 'annotate', '谷仓');
  assert.equal(again.changed, false, '已带注=幂等跳过');
  assert.equal(again.text, r.text);
});

test('applyWordActionToText unanno：全剥、保留原词大小写、半角括号不误伤', () => {
  const md = 'The greater（更大的） numbers came. Greater（更大的） still. row (连续) stays.';
  const r = applyWordActionToText(md, 'greater', 'unanno');
  assert.equal(r.changed, true);
  assert.ok(r.text.includes('The greater numbers'));
  assert.ok(r.text.includes('Greater still'));
  assert.ok(r.text.includes('row (连续)'), '半角括号不误伤');
});

test('tierTagOfFilename / tierKeyOfTag：文件名认层', () => {
  const naming = { A: 'A层85', M: 'M层75', B: 'B层60' };
  assert.equal(tierTagOfFilename('原文_A层85_2026-09-12_工序化.md', naming), 'A层85');
  assert.equal(tierTagOfFilename('原文_M层75_2026-09-12.md', naming), 'M层75');
  assert.equal(tierTagOfFilename('随便.md', naming), null);
  assert.equal(tierKeyOfTag('B层60', naming), 'B');
});
