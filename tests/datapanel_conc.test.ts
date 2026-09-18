/**
 * 词画卷项 4b 验收——专名候选 / 词表缺口 报告：纯生成器（内容形状与零误报）+
 * generateConcReports 行为（mockIPC 读文件表 + setIo 捕获写：路径约定与内容）。
 */
import './_dom_env.js'; // 必须第一个：uikit/state 等在顶层挂 window 事件
import test from 'node:test';
import assert from 'node:assert/strict';
import { properSuspectsReportMd, vocabGapReportMd } from '../app/src/pure.js';

test('4b：专名候选报告 md——命中候选入列、口径写明、零候选如实说', () => {
  const md = properSuspectsReportMd([{ word: 'pinchfield', chapters: ['二', '三'], occurrences: 4 }], { date: '2026-09-18', coverage: '扫到 3 章、6 份层文本' });
  assert.ok(md.includes('# 专名候选 · 2026-09-18'));
  assert.ok(md.includes('- **pinchfield**：2 章 4 处（二、三）'));
  assert.ok(md.includes('句首大写不算'), '判定口径写进报告');
  const empty = properSuspectsReportMd([], { date: '2026-09-18', coverage: '扫到 3 章' });
  assert.ok(empty.includes('当前没有候选'), '零候选如实说，不编空表');
});

test('4b：词表缺口报告 md——按频降序、口径与上限写明', () => {
  const md = vocabGapReportMd(
    [
      { word: 'farmz', total: 9, chapters: 3 },
      { word: 'toiledx', total: 2, chapters: 1 },
    ],
    { date: '2026-09-18', coverage: '扫到 3 章' },
  );
  assert.ok(md.includes('- **farmz**：9 次 · 3 章'));
  assert.ok(md.indexOf('farmz') < md.indexOf('toiledx'), '降序');
  assert.ok(md.includes('高频未收优先核对'));
});

test('4b：generateConcReports 行为——mockIPC 书 + setIo 捕获写：两份报告落书目录、内容含 pinchfield、句首大写不进候选', async () => {
  const { mockIPC, clearMocks } = await import('@tauri-apps/api/mocks');
  const files: Record<string, string> = {
    '/book/调适项目_X.json': JSON.stringify({ 产物命名: { A: 'A层85', M: 'M层75' } }),
    '/book/第一章/原文_A层85_x.md': '[P01] The dog ran home.\n',
    '/book/第二章/原文_A层85_x.md': '[P02] A dog slept. Pinchfield was far away.\n',
    '/book/第三章/原文_A层85_x.md': '[P03] Pinchfield appeared again. The dogs barked at Pinchfield.\n',
  };
  mockIPC((cmd: string, args: Record<string, unknown>) => {
    const path = String(args.path ?? '');
    if (cmd === 'list_dir') {
      const exts = (args.exts as string[] | undefined) ?? undefined;
      return Object.keys(files).filter((p) => p.startsWith(String(args.dir ?? '') + '/') && (exts ? exts.some((e) => p.endsWith(e)) : /\.(md|txt)$/i.test(p)));
    }
    if (cmd === 'read_text_file') {
      if (files[path] === undefined) throw new Error('missing');
      return files[path];
    }
    if (cmd === 'describe_path') {
      if (files[path] !== undefined) return 'exists';
      return Object.keys(files).some((p) => p.startsWith(path + '/')) ? 'exists' : 'missing';
    }
    return null;
  });
  const writes: Array<{ path: string; content: string }> = [];
  try {
    const dp = await import('../app/src/datapanel.js');
    dp.setIo({
      async read() {
        throw new Error('not used');
      },
      async write(path, content) {
        writes.push({ path, content });
      },
      async appendLog() {
        /* 不用于本路径 */
      },
      async listDir(dir, exts) {
        /* 假 io 也要给真答案：findProjectConfig 靠它找 调适项目_*.json */
        return Object.keys(files).filter((p) => p.startsWith(`${dir}/`) && (exts ? exts.some((e) => p.endsWith(e)) : /\.(md|txt)$/i.test(p)));
      },
      async reveal() {
        /* 不用于本路径 */
      },
    });
    const r = await dp.generateConcReports('/book', [], new Set(['the', 'a', 'dog', 'and', 'of', 'to', 'in', 'was', 'far', 'away', 'slept', 'ran', 'home', 'again', 'at', 'barked']));
    assert.equal(r.properCount, 1, JSON.stringify(r));
    const proper = writes.find((w) => w.path.includes('专名候选_'));
    const gap = writes.find((w) => w.path.includes('词表缺口_'));
    assert.ok(proper && proper.path.startsWith('/book/'), '报告落书目录（路径约定）');
    assert.ok(gap, '词表缺口报告也落盘');
    assert.ok(proper.content.includes('**pinchfield**'));
    assert.ok(!proper.content.includes('**the**') && !proper.content.includes('**dogs**'), '句首大写/词表内不进候选');
    assert.ok(gap.content.includes('farmz') === false, '本夹具无 farmz');
    assert.ok(gap.content.includes('pinchfield'), '词表外的 pinchfield 也进缺口清单（核对用）');
  } finally {
    clearMocks();
  }
});

test('5a：复现队列 CSV——hits 语义不变（0），第三列章分布=词画卷出现处；FSRS CLI 前两列可解析', async () => {
  const { reinforceQueueCsv } = await import('../app/src/pure.js');
  const rows = [{ word: 'dog', cefr: '', zh: '狗', sample: '', from: '' }] as never;
  const csv = reinforceQueueCsv(rows, new Map([['dog', { 一: 2, 三: 1 }]]));
  assert.ok(csv.includes('dog,0,一:2|三:1'), csv);
  const noMap = reinforceQueueCsv(rows);
  assert.ok(noMap.includes('dog,0\n'), '无画卷时照旧两列（向后兼容）');
  // CLI 口径：split(/[,;\t]/) 取前两列
  const line = csv.split('\n').find((l) => l.startsWith('dog,')) ?? '';
  const cells = line.split(/[,;\t]/);
  assert.equal(cells[0], 'dog');
  assert.equal(Number(cells[1]), 0);
  const { planFsrs } = await import('../src/core/fsrs.js');
  const plan = planFsrs([{ word: 'dog', hits: 0 }]);
  assert.ok(plan.length >= 1, 'FSRS 输入形状不变');
});
