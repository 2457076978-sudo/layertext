/**
 * session.ts persistEdit 最小冒烟（2026-09-16，A 线收尾——不展开，主战场在核心链）。
 *
 * 走官方 `@tauri-apps/api/mocks` 的 `mockIPC`（Q1 结论：不自造缝），配 happy-dom 提供
 * `window` 全局（mockIPC 的挂载点）。内存文件表模拟后端三命令：
 * read_text_file / describe_path / write_text_file。
 */

import './_dom_env.js'; // 必须第一个：uikit 顶层挂 window 事件
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import { persistEdit } from '../app/src/session.js';
import { S } from '../app/src/state.js';
import type { FileSession } from '../app/src/types.js';

/** 内存后端：files 表 + 写入日志 */
function memBackend(files: Record<string, string>): { writes: { path: string; content: string }[] } {
  const writes: { path: string; content: string }[] = [];
  mockIPC((cmd: string, args: { path?: string; content?: string }) => {
    const p = args.path as string;
    switch (cmd) {
      case 'read_text_file':
        if (p in files) return files[p]!;
        throw new Error(`no such file: ${p}`);
      case 'describe_path':
        return p in files ? 'exists' : 'missing';
      case 'write_text_file':
        writes.push({ path: p, content: args.content as string });
        files[p] = args.content as string;
        return null;
      default:
        throw new Error(`test backend 不认识命令 ${cmd}`);
    }
  });
  return { writes };
}

const sess = (md = '原始正文'): FileSession => ({ md, fileName: 'ch.md', sourcePath: '/b/ch.md' }) as unknown as FileSession;

test('persistEdit 首改：先留原始备份（存改前正文），再写原稿', async () => {
  const io = memBackend({});
  S.appConfig.inPlaceEdit = true;
  const s = sess('原始正文');
  const out = await persistEdit(s, '新正文');
  assert.equal(out, '/b/ch.md');
  assert.deepEqual(
    io.writes.map((w) => w.path),
    ['/b/ch_原始备份.md', '/b/ch.md'],
    '第一笔必须是备份，第二笔才是原稿',
  );
  assert.equal(io.writes[0]!.content, '原始正文', '备份存的是改前正文——教师最后的退路');
  assert.equal(io.writes[1]!.content, '新正文');
  assert.deepEqual(s.undoStack, ['原始正文'], '改稿进撤销栈');
});

test('persistEdit 备份在但读不出来：中止本次改动，一个字节都不写原稿', async () => {
  const files: Record<string, string> = { '/b/ch_原始备份.md': '真·原始版' };
  const io = memBackend({});
  mockIPC((cmd: string, args: { path?: string; content?: string }) => {
    const p = args.path as string;
    if (cmd === 'read_text_file' && p === '/b/ch_原始备份.md') throw new Error('权限被拒');
    if (cmd === 'describe_path') return 'exists';
    if (cmd === 'write_text_file') {
      io.writes.push({ path: p, content: args.content as string });
      files[p] = args.content as string;
      return null;
    }
    throw new Error(`unexpected ${cmd}`);
  });
  S.appConfig.inPlaceEdit = true;
  const s = sess('当前正文');
  await assert.rejects(persistEdit(s, '新正文'), /读不出来/);
  assert.equal(io.writes.length, 0, '原稿没被写——宁可这次不改，不拿唯一原始版去赌');
  assert.equal(files['/b/ch_原始备份.md'], '真·原始版', '备份原封未动');
});

test('persistEdit 关掉直接改原稿：写工作稿，原稿不碰', async () => {
  const io = memBackend({});
  S.appConfig.inPlaceEdit = false;
  const s = sess('当前正文');
  const out = await persistEdit(s, '新正文');
  assert.equal(out, '/b/ch_工作稿.md');
  assert.deepEqual(io.writes, [{ path: '/b/ch_工作稿.md', content: '新正文' }], '只写工作稿一份');
});

test.afterEach(() => clearMocks());
