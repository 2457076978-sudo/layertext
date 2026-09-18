/**
 * 词画卷项 2 验收——传播咬合（2b 行为测试 + 2d 纪律扫描）。
 * 2b：mockIPC 内存文件表构造三本章产物，跑 propagateToLowerTiers：
 *     · ②换词后**所有章产物零字节变化**（写调用只允许落在本章目录的待办/变更日志）
 *     · 待办清单包含**跨章出现处**（词画卷给的影响面）
 * 2d：静态纪律扫描——bookscan 零写调用；propagateui 的写调用路径只准用三章目录局部变量。
 */
import './_dom_env.js'; // 必须第一个：uikit 等在顶层挂 window 事件
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import type { FileSession } from '../app/src/types.js';

const BOOK = '/book/名著阅读工作区/调适工作区';
const NAMING = { A: 'A层85', M: 'M层75', B: 'B层60' };
const PROJECT = `${BOOK}/../调适项目_X.json`;

/** 三章 × A/M 两层（wolf 词跨章出现） */
function makeFiles(): Record<string, string> {
  const f: Record<string, string> = {};
  f[`${PROJECT}`] = JSON.stringify({ 产物命名: NAMING, 读者层级: { A: ['M', 'B'] } });
  for (const ch of ['第一章', '第二章', '第三章']) {
    f[`${BOOK}/${ch}/原文_A层85_2026-09-12_工序化.md`] = `[P01] The dog（狗） ran. A wolf appeared in ${ch}.\n`;
    f[`${BOOK}/${ch}/原文_M层75_2026-09-12_工序化.md`] = `[P01] The dog ran. A wolf appeared in ${ch}.\n`;
  }
  return f;
}

function session(): FileSession {
  return {
    fileName: '原文_A层85_2026-09-12_工序化.md',
    sourcePath: `${BOOK}/第一章/原文_A层85_2026-09-12_工序化.md`,
    markPath: '',
    review: {},
    report: null,
    reportSavedPath: null,
    dirty: false,
    md: '',
  } as unknown as FileSession;
}

test('2b：②换词——三本章产物零字节变化 + 待办含跨章出现处（mockIPC 行为测试）', async () => {
  const files = makeFiles();
  const writes: Array<{ path: string; content: string }> = [];
  mockIPC((cmd: string, args: Record<string, unknown>) => {
    const dir = String(args.dir ?? '');
    const path = String(args.path ?? '');
    if (cmd === 'list_dir') {
      const exts = (args.exts as string[] | undefined) ?? undefined;
      if (exts?.includes('json')) return Object.keys(files).filter((p) => p.startsWith(`${dir}/`) && p.endsWith('.json'));
      return Object.keys(files).filter((p) => p.startsWith(`${dir}/`) && /\.(md|txt|markdown)$/i.test(p));
    }
    if (cmd === 'read_text_file') {
      if (files[path] === undefined) throw new Error(`读不到：${path}`);
      return files[path];
    }
    if (cmd === 'describe_path') {
      /* 目录也算 exists（其下有文件）——bookscan 的章目录探针靠它 */
      if (files[path] !== undefined) return 'exists';
      return Object.keys(files).some((p) => p.startsWith(path + '/')) ? 'exists' : 'missing';
    }
    if (cmd === 'write_text_file') {
      writes.push({ path, content: String(args.content ?? '') });
      files[path] = String(args.content ?? '');
      return null;
    }
    return null;
  });
  const before = Object.fromEntries(
    Object.entries(files)
      .filter(([p]) => /第[一二三]章\/原文_.*\.md$/.test(p))
      .map(([p, c]) => [p, c]),
  );
  try {
    const { propagateToLowerTiers } = await import('../app/src/propagateui.js');
    await propagateToLowerTiers(session(), [{ word: 'wolf', op: 'rewrite', zh: 'wild dog' }]);
    const after = Object.fromEntries(
      Object.entries(files)
        .filter(([p]) => /第[一二三]章\/原文_.*\.md$/.test(p))
        .map(([p, c]) => [p, c]),
    );
    assert.deepEqual(after, before, '所有章产物零字节变化（②只列不改——跨章机器改写语境依赖强）');
    const todo = writes.find((w) => w.path.includes('_待复核/层级传播_待办.md'));
    assert.ok(todo, '待办已写');
    assert.ok(todo.content.includes('wolf') && todo.content.includes('wild dog'), '待办含换词条目');
    assert.ok(/第二章/.test(todo.content) && /第三章/.test(todo.content), `待办含跨章出现处（二、三章）：\n${todo.content}`);
    assert.ok(/未改文/.test(todo.content), '跨章段明确标注"未改文"');
  } finally {
    clearMocks();
  }
});

test('2b：①补注——本章下级被同步（行为），完成数字来自画卷（不伪造）', async () => {
  const files = makeFiles();
  const writes: Array<{ path: string; content: string }> = [];
  mockIPC((cmd: string, args: Record<string, unknown>) => {
    const dir = String(args.dir ?? '');
    const path = String(args.path ?? '');
    if (cmd === 'list_dir') {
      const exts = (args.exts as string[] | undefined) ?? undefined;
      if (exts?.includes('json')) return Object.keys(files).filter((p) => p.startsWith(`${dir}/`) && p.endsWith('.json'));
      return Object.keys(files).filter((p) => p.startsWith(`${dir}/`) && /\.(md|txt|markdown)$/i.test(p));
    }
    if (cmd === 'read_text_file') {
      if (files[path] === undefined) throw new Error(`读不到：${path}`);
      return files[path];
    }
    if (cmd === 'describe_path') {
      /* 目录也算 exists（其下有文件）——bookscan 的章目录探针靠它 */
      if (files[path] !== undefined) return 'exists';
      return Object.keys(files).some((p) => p.startsWith(path + '/')) ? 'exists' : 'missing';
    }
    if (cmd === 'write_text_file') {
      writes.push({ path, content: String(args.content ?? '') });
      files[path] = String(args.content ?? '');
      return null;
    }
    return null;
  });
  try {
    const { propagateToLowerTiers } = await import('../app/src/propagateui.js');
    await propagateToLowerTiers(session(), [{ word: 'dog', op: 'annotate', zh: '狗' }]);
    const mWrite = writes.find((w) => w.path.includes('第一章/原文_M层75'));
    assert.ok(mWrite, '本章 M 层被同步写入');
    assert.ok(mWrite.content.includes('dog（狗）'), '①补注落到下级正文');
    const ch2M = files[`${BOOK}/第二章/原文_M层75_2026-09-12_工序化.md`];
    assert.ok(!ch2M.includes('（狗）'), '他章正文不被跨章写入（纪律：①也只动同章下级）');
  } finally {
    clearMocks();
  }
});

test('2d：纪律扫描——bookscan 零写调用；propagateui 写路径只准用本章目录局部变量', () => {
  const scan = readFileSync(join(process.cwd(), 'app/src/bookscan.ts'), 'utf8');
  assert.ok(!scan.includes('write_text_file') && !scan.includes('writeFileSync'), '书册扫描只读（画卷是视图）');
  const ui = readFileSync(join(process.cwd(), 'app/src/propagateui.ts'), 'utf8');
  const writeSites = [...ui.matchAll(/invoke\('write_text_file',\s*\{ path: ([A-Za-z0-9_.]+),/g)].map((m) => m[1]);
  assert.ok(writeSites.length >= 3, '写点数量异常（少于既有点）');
  for (const site of writeSites) {
    assert.ok(['todoPath', 'p.target.path', 'logPath'].includes(site), `出现非本章目录的写路径 ${site}——跨章改正文是红线`);
  }
});
