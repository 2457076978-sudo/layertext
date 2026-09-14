/**
 * `app/src/fsx.ts` 的三态判定（2026-09-14）。
 *
 * 守的是一条不变式：**只有确认"这个路径不存在"才允许落到"没有"这一支**。
 * 其余一切（文件确实在却读不出来、连"在不在"都问不出来）都必须是 `unreadable`——
 * 因为调用方对这两件事的处理**相反**：
 *   · 不存在 → 静默按"没有"处理（`_审校标记.json` / `AI会话.json` / `本书配置` 的第一次用）；
 *   · 读不了 → 说出口，并且**绝不能拿内存里的空数据写回去**（那是覆盖教师的数据）。
 *
 * 在这条之前，全仓靠的是"有意兜底：后端没给错误码分不出来"的注释 + 风险自认。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyRead, type PathProbe } from '../app/src/fsx.js';

test('classifyRead：确认不存在 → missing（调用方按"没有这一项"处理）', () => {
  assert.deepEqual(classifyRead('No such file or directory', 'missing'), { kind: 'missing' });
});

test('classifyRead：文件在、但读不出来 → unreadable，且带上原因', () => {
  const r = classifyRead('Permission denied (os error 13)', 'exists');
  assert.equal(r.kind, 'unreadable');
  assert.match((r as { error: string }).error, /Permission denied/);
});

test('classifyRead：连"在不在"都问不出来 → 也算 unreadable（不赌它不存在）', () => {
  const r = classifyRead('io error', 'unreadable');
  assert.equal(r.kind, 'unreadable');
});

test('classifyRead：三种 probe 的取值穷举一遍，只有 missing 会变成"没有"', () => {
  const probes: PathProbe[] = ['exists', 'missing', 'unreadable'];
  const kinds = probes.map((p) => classifyRead('boom', p).kind);
  assert.deepEqual(kinds, ['unreadable', 'missing', 'unreadable']);
});
