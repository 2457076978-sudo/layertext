/**
 * CHANGELOG 段落提取（W4 Release 工具）测试：真实 CHANGELOG 上验证命中与缺版本失败
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/* 从 dist/tests/ 往上两级才是仓库根——只往上**一级**会指到 dist/，
   而 tools/*.mjs 不被 tsc 编译，dist/tools 里根本没有它（2026-09-13 实测：主仓是对的，本分支被改坏）。 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const run = (ver: string) => execFileSync('node', [join(ROOT, 'tools', 'extract_changelog.mjs'), ver], { encoding: 'utf-8' });

test('提取已发布版本段落（1.0.0）：有正文、不含标题行、不含相邻段', () => {
  const out = run('1.0.0');
  assert.match(out, /商业化冲刺/);
  assert.doesNotMatch(out, /^## /); // 标题行不输出
  assert.doesNotMatch(out, /审校工作台内嵌/); // 0.2.0 段不混入
});

test('缺版本：退出码非零（Release 工作流据此拦截忘写 CHANGELOG）', () => {
  assert.throws(
    () => run('99.99.99'),
    (err: { status?: number }) => err.status === 1,
  );
  assert.throws(
    () => run(''),
    (err: { status?: number }) => err.status === 2 || err.status === 1,
  );
});
