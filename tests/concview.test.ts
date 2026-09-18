/**
 * 词画卷项 3 验收——入口行（3a）、行分组/三层对照（3b/3c）、词表外徽标（3d）。
 * 纯逻辑（pure.ts）逐项锁；DOM 弹层做一次渲染级冒烟（happy-dom）。
 */
import './_dom_env.js'; // 必须第一个：uikit 等在顶层挂 window 事件
import test from 'node:test';
import assert from 'node:assert/strict';
import { concordanceEntryLine, concordanceRows } from '../app/src/pure.js';

test('3a：入口行——跨章/多层才渲染，本章单层不摆空行', () => {
  assert.equal(concordanceEntryLine(0, 0, {}), null);
  assert.equal(concordanceEntryLine(1, 1, { '': 1 }), null, '本章单层：无信息量不渲染');
  assert.equal(concordanceEntryLine(3, 2, { A: 2, M: 1 }), '全书 3 处 · 2 章（A 2 · M 1）');
  assert.equal(concordanceEntryLine(2, 1, { '': 2 }), null, '单层单章（平铺单层书本章内）：不渲染');
  assert.equal(concordanceEntryLine(5, 1, { '': 5 }), null);
  assert.equal(concordanceEntryLine(5, 3, { '': 5 }), '全书 5 处 · 3 章（原稿 5）', '跨章单层也要（复现统计场景）');
});

test('3b/3c：行分组按章+段聚、同段多层 compare=true 并按层序排', () => {
  const occs = [
    { chapter: '一', tier: 'A层85', segId: 'P01', sentence: 'The dog ran.', annotated: false, wordForm: 'dog' },
    { chapter: '一', tier: 'M层75', segId: 'P01', sentence: 'The dogs（狗） ran.', annotated: true, wordForm: 'dogs' },
    { chapter: '一', tier: 'B层60', segId: 'P01', sentence: 'The dog ran fast.', annotated: false, wordForm: 'dog' },
    { chapter: '二', tier: 'A层85', segId: 'P03', sentence: 'A dog slept.', annotated: false, wordForm: 'dog' },
  ];
  const rows = concordanceRows(occs, ['A层85', 'M层75', 'B层60']);
  assert.equal(rows.length, 2, '章+段两组');
  assert.deepEqual(
    rows[0].rows.map((r) => r.tier),
    ['A层85', 'M层75', 'B层60'],
    '三层对照行按层序排',
  );
  assert.equal(rows[0].compare, true);
  assert.equal(rows[1].compare, false, '单层段不是对照行');
  assert.equal(rows[0].rows[1].annotated, true, '已注状态随行（3d 数据源）');
  // 无 tiersOrder：按首次出现序
  const rows2 = concordanceRows(occs);
  assert.deepEqual(
    rows2[0].rows.map((r) => r.tier),
    ['A层85', 'M层75', 'B层60'],
  );
});

test('3d：unmerged → 行数据带词表外标记（渲染成 warn 徽标的数据源）', () => {
  const rows = concordanceRows([{ chapter: '一', tier: '', segId: 'P01', sentence: 'The farmz grew.', annotated: false, wordForm: 'farmz', unmerged: true }]);
  assert.equal(rows[0].rows[0].unmerged, true);
});

test('2e：concordanceRows 透传 origin（有则带、无则省略——不伪造溯源）', () => {
  const rows = concordanceRows([
    { chapter: '一', tier: 'A层85', segId: 'P01', sentence: 'The dog ran.', annotated: false, wordForm: 'dog' },
    { chapter: '一', tier: 'M层75', segId: 'P01', sentence: 'The dog（狗） ran.', annotated: true, wordForm: 'dog', origin: 'A层85' },
  ]);
  assert.equal(rows[0].rows.find((r) => r.tier === 'M层75')?.origin, 'A层85');
  assert.equal(rows[0].rows.find((r) => r.tier === 'A层85')?.origin, undefined);
});

test('3 DOM 冒烟：词画卷弹层渲染出章分组、层徽标、词表外徽标与跳转 data 属性', async () => {
  const { mockIPC, clearMocks } = await import('@tauri-apps/api/mocks');
  /* 章目录布局（AF 形态）：项目配置给层命名，文件名带层标签 */
  const files: Record<string, string> = {
    '/book/调适项目_X.json': JSON.stringify({ 产物命名: { A: 'A层85', M: 'M层75', B: 'B层60' } }),
    '/book/第一章/原文_A层85_x.md': '[P01] The dog ran home.\n',
    '/book/第一章/原文_M层75_x.md': '[P01] The dog（狗） ran home fast.\n',
    '/book/第二章/原文_A层85_x.md': '[P02] The farmz grew big in the dog days.\n',
    /* 2e：M 层有带 origin 的词级标记（dog ← A层85 传播）；二章 A 层有不带 origin 的标记（不该出徽标） */
    '/book/第一章/原文_M层75_x_审校标记.json': JSON.stringify([{ id: 'm1', level: 'word', pi: 0, si: 0, wi: 1, word: 'dog', type: 'zh', origin: 'A层85', ts: 1 }]),
    '/book/第二章/原文_A层85_x_审校标记.json': JSON.stringify([{ id: 'm2', level: 'word', pi: 0, si: 0, wi: 6, word: 'dog', type: 'anchor', ts: 2 }]),
  };
  mockIPC((cmd: string, args: Record<string, unknown>) => {
    const path = String(args.path ?? '');
    if (cmd === 'list_dir') {
      const exts = (args.exts as string[] | undefined) ?? undefined;
      const hit = Object.keys(files).filter((p) => p.startsWith(String(args.dir ?? '') + '/') && (exts ? exts.some((e) => p.endsWith(e)) : /\.(md|txt)$/i.test(p)));
      return hit;
    }
    if (cmd === 'read_text_file') {
      if (files[path] === undefined) throw new Error('missing');
      return files[path];
    }
    if (cmd === 'describe_path') {
      /* 目录也算 exists（其下有文件）——bookscan 的章目录探针靠它 */
      if (files[path] !== undefined) return 'exists';
      return Object.keys(files).some((p) => p.startsWith(path + '/')) ? 'exists' : 'missing';
    }
    return null;
  });
  try {
    const { openConcordanceView } = await import('../app/src/concview.js');
    const session = { fileName: '原文_A层85_x.md', sourcePath: '/book/第一章/原文_A层85_x.md', markPath: '', review: {}, report: null, reportSavedPath: null, dirty: false, md: '' } as never;
    await openConcordanceView(session, 'dog');
    const pop = document.getElementById('conc-pop');
    assert.ok(pop?.classList.contains('open'), '弹层打开');
    const html = pop?.innerHTML ?? '';
    assert.ok(html.includes('dog') && html.includes('已注'), '已注徽标');
    assert.ok(html.includes('词画卷'), '标题');
    assert.ok((pop?.querySelectorAll('[data-conc-path]')?.length ?? 0) >= 2, '跳转行带文件路径 data 属性');
    assert.ok(html.includes('重扫'), '显式刷新入口（画卷是视图）');
    // 2e：亲判溯源徽标——M 层 dog 行带「亲判·A层85」；A 层行与二章（无 origin 标记）不带
    const html2 = pop?.innerHTML ?? '';
    assert.ok(html2.includes('亲判·A层85'), '溯源徽标渲染');
    assert.equal(pop?.querySelectorAll('.conc-origin')?.length ?? 0, 1, '恰一处（无 origin 的标记不伪造徽标）');
    // farmz 词表外徽标走另一个词
    await openConcordanceView(session, 'farmz');
    assert.ok((document.getElementById('conc-pop')?.innerHTML ?? '').includes('词表外'), '词表外徽标渲染');
  } finally {
    clearMocks();
  }
});
