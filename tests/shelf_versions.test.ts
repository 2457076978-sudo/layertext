/** 书架书封与版本选择（两级导航）纯逻辑测试：书名封面字号自适应 / 版本卡片数据 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildVersionCards, coverTitlePx, coverVisualWidth } from '../app/src/pure.js';

test('coverVisualWidth：中文全角=1、ASCII≈0.55', () => {
  assert.equal(coverVisualWidth('动物农场'), 4);
  assert.ok(Math.abs(coverVisualWidth('Animal Farm') - 'Animal Farm'.length * 0.55) < 1e-9);
});

test('coverTitlePx：书名越长字号越小，极端长名仍有保底可读字号', () => {
  assert.ok(coverTitlePx('红楼梦') > coverTitlePx('动物农场（英文简化版）'), '短名字号应更大');
  assert.ok(coverTitlePx('动物农场') >= coverTitlePx('傲慢与偏见'), '同等长度不减字号');
  assert.ok(coverTitlePx('A Very Long English Book Title That Goes On') < coverTitlePx('动物农场'), '长英文名要缩字号');
  assert.ok(coverTitlePx('一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五') >= 12, '极端长名保底 12px');
});

test('buildVersionCards：B/M/A 三版本卡片（章数 + 绑定口径 + 第一章 chip 名）', () => {
  const ws = [
    { 名: 'B层工作区', 定制目标: '组:B', 文件: ['/书/第一章/候选版.md', '/书/第二章/候选版.md'] },
    { 名: 'M层工作区', 文件: ['/书/第一章/M版.md'] },
    { 名: 'A层工作区', 定制目标: '组:A', 文件: ['/书/第一章/A版.md'] },
  ];
  const cards = buildVersionCards(ws);
  assert.equal(cards.length, 3);
  assert.deepEqual(
    cards.map((c) => c.idx),
    [0, 1, 2],
  );
  assert.equal(cards[0].名, 'B层工作区');
  assert.equal(cards[0].desc, '2 章 · 绑定口径 组:B');
  assert.equal(cards[1].desc, '1 章');
  assert.equal(cards[0].first, '第一章'); // 候选版文件 chip 名取章节目录名
  assert.equal(cards[2].target, '组:A');
  assert.deepEqual(buildVersionCards([]), []);
});
