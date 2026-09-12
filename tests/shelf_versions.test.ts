/** 书架书封与版本选择（两级导航）纯逻辑测试：书名封面字号自适应 / 版本卡片数据 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toggleParaBookmark } from '../app/src/pure.js';
import { buildVersionCards, coverTitlePx, coverVisualWidth, filterShelfBooks, progressPct, shelfGroupsOf, tocItemName } from '../app/src/bookpure.js';

test('tocItemName：十个同名章节文件 → 条目显示章名；一章多份 → 章名·差异段（2026-09-12 目录十条同名反馈）', () => {
  const ch = (n: number, tier = 'A层85'): string => `/书/第${'一二三四五六七八九十'[n - 1]}章/原文_${tier}_2026-09-10.md`;
  const ten = Array.from({ length: 10 }, (_, i) => ch(i + 1));
  assert.equal(tocItemName(ten, ch(1)), '第一章', '十条同名文件：只显示章名（差异段为空）');
  assert.equal(tocItemName(ten, ch(10)), '第十章');
  // 一章里两份产物：公共前后缀剥掉后剩下"原文/学生版"
  const mixed = ['/书/第一章/原文_A层85_2026-09-10.md', '/书/第一章/学生版_A层85_2026-09-10.md'];
  assert.equal(tocItemName(mixed, mixed[0]!), '第一章 · 原文');
  assert.equal(tocItemName(mixed, mixed[1]!), '第一章 · 学生版');
  // 非章节目录：维持文件名（不误把普通目录名当章名）
  assert.equal(tocItemName(['/tmp/a/笔记.md'], '/tmp/a/笔记.md'), '笔记');
});

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

test('filterShelfBooks：多词 AND + 分组过滤（未分组/精确分组/null=全部）', () => {
  const books = [
    { 名: '动物农场', 副标题: '3 个版本 · 30 章', 分组: 'AF课题' },
    { 名: 'Animal Farm 原版', 目录: '/x/af' },
    { 名: '红楼梦', 分组: '本学期' },
  ];
  assert.equal(filterShelfBooks(books, { q: '', group: null }).length, 3);
  assert.equal(filterShelfBooks(books, { q: 'farm', group: null }).length, 1); // 大小写不敏感
  assert.equal(filterShelfBooks(books, { q: '动物 农场', group: null }).length, 1); // 多词 AND
  assert.equal(filterShelfBooks(books, { q: '动物 原版', group: null }).length, 0);
  assert.deepEqual(
    filterShelfBooks(books, { q: '', group: 'AF课题' }).map((b) => b.名),
    ['动物农场'],
  );
  assert.deepEqual(
    filterShelfBooks(books, { q: '', group: '' }).map((b) => b.名),
    ['Animal Farm 原版'],
  ); // ''=未分组
  assert.equal(filterShelfBooks(books, { q: '红楼梦', group: 'AF课题' }).length, 0); // 搜索+分组叠加
});

test('shelfGroupsOf：去重，空分组不入列', () => {
  const out = shelfGroupsOf([{ 分组: '本学期' }, { 分组: 'AF课题' }, {}, { 分组: '本学期 ' }]);
  assert.equal(out.length, 2); // 重复（含首尾空格差异）与空分组都不入列
  assert.ok(out.includes('本学期') && out.includes('AF课题'));
});

test('progressPct：总数缺失为 0，封顶 100', () => {
  assert.equal(progressPct(3, undefined), 0);
  assert.equal(progressPct(0, 30), 0);
  assert.equal(progressPct(3, 30), 10);
  assert.equal(progressPct(15, 30), 50);
  assert.equal(progressPct(45, 30), 100);
});

test('toggleParaBookmark：按段去重切换，追加后按段号排序', () => {
  const t1 = toggleParaBookmark([], 2, 'The horses worked hard.', 100);
  assert.equal(t1.added, true);
  const t2 = toggleParaBookmark(t1.list, 0, 'Mr. Jones owned the farm.', 101);
  assert.deepEqual(
    t2.list.map((b) => b.pi),
    [0, 2],
  ); // 排序
  const t3 = toggleParaBookmark(t2.list, 2, 'x', 102);
  assert.equal(t3.added, false); // 再点同段=移除
  assert.deepEqual(
    t3.list.map((b) => b.pi),
    [0],
  );
  assert.ok(t1.list[0].text.length <= 60); // 长文本截断预览
});
