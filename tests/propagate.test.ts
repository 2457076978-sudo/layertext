/**
 * 资产类别化 + 读者层级树传播 · 纯函数测试
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { propagationKindOf, descendantsOf, normalizeTree, applyWordActionToText, tierTagOfFilename, tierKeyOfTag, descendantTierFiles, DEFAULT_READER_TREE } from '../src/core/propagate.js';

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

/* ---------- 跨层传播的**目标挑选**（2026-09-14 接线时补） ----------
 *
 * 这条为什么要守：`descendantTierFiles` 决定"哪些文件会被改写"。
 * 挑宽了会动到不该动的文件（`_原始备份.md`、`_工作稿.md`），
 * 挑窄了"下级自动跟上"就是空话——两种错都不会报错，只会静静地少改/多改。
 * 决策依据：Wayne 2026-09-14 拍板"可以改正文，但每次都要教师确认"。
 */

const NAMING = { A: 'A层85', M: 'M层75', B: 'B层60' };

test('descendantTierFiles：只挑下级层的正文产物，不吃备份/工作稿/上层', () => {
  const files = [
    '/书/重制三版/第01章/原文_A层85_第01章.md',
    '/书/重制三版/第01章/原文_M层75_第01章.md',
    '/书/重制三版/第01章/原文_B层60_第01章.md',
    '/书/重制三版/第01章/原文_M层75_第01章_工作稿.md',
    '/书/重制三版/第01章/原文_M层75_第01章_原始备份.md',
    '/书/重制三版/第01章/_审校标记.json',
    '/书/重制三版/第01章/原文_A层85_第01章.txt',
  ];
  const got = descendantTierFiles(DEFAULT_READER_TREE, NAMING, 'A层85', files);
  assert.deepEqual(
    got.map((t) => t.tier),
    ['M', 'B'],
    'A 的下级是 M、B（顺序按层级树）',
  );
  assert.deepEqual(
    got.map((t) => t.path.split('/').pop()),
    ['原文_M层75_第01章.md', '原文_B层60_第01章.md'],
    '工作稿 / 原始备份 / 标记文件 / 自己这一层都不在里面',
  );
});

test('descendantTierFiles：叶子层没有下级；不是分层产物时也返回空', () => {
  const files = ['/书/第01章/原文_M层75_第01章.md', '/书/第01章/原文_B层60_第01章.md'];
  assert.deepEqual(descendantTierFiles(DEFAULT_READER_TREE, NAMING, 'B层60', files), [], 'B 是叶子');
  assert.deepEqual(descendantTierFiles(DEFAULT_READER_TREE, NAMING, '认不出的名字.md', files), []);
});

test('descendantTierFiles：树可以嵌套（A→M→B），传递闭包一起拿', () => {
  const nested = { A: ['M'], M: ['B'] };
  const files = ['/c/原文_M层75_x.md', '/c/原文_B层60_x.md'];
  const got = descendantTierFiles(nested, NAMING, 'A层85', files);
  assert.deepEqual(
    got.map((t) => t.tier),
    ['M', 'B'],
    '两层都要，不只是直接下级',
  );
});

test('descendantTierFiles：同层多版本只取字典序最新那个（旧版本不该被插注解）', () => {
  const files = ['/c/原文_M层75_2026-09-10_x.md', '/c/原文_M层75_2026-09-12_x.md', '/c/原文_M层75_2026-09-11_x.md', '/c/原文_B层60_2026-09-12_x.md'];
  const got = descendantTierFiles(DEFAULT_READER_TREE, NAMING, 'A层85', files);
  assert.deepEqual(
    got.map((t) => t.path.split('/').pop()),
    ['原文_M层75_2026-09-12_x.md', '原文_B层60_2026-09-12_x.md'],
    '每层各取一个，且是日期最新的那个',
  );
});
