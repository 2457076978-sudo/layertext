/**
 * 统一词典的增量合并 回归测试
 *
 * 验收标准（《LayerText 项目审查报告（2026-09-11）》§三）：
 *   「第一个规模崩点会是文件命名约定与并发写入：第二本书、第二位教师或同一书多层并行时，
 *     输出路径、会话日志、**统一词典**和标记文件可能互相覆盖」
 * 统一词典是这些文件里唯一一个被所有运行共享且会被写的——`appendDict` 原先
 * 「读整份 → 合并 → 写回整份」，两个进程同时跑就是 lost update，而且不报任何错。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  describeMerge,
  lockState,
  mergeDict,
  parseDictCsv,
  toDictCsv,
  type DictEntry,
} from '../src/core/dictmerge.js';

const e = (word: string, zh: string, source = '基线'): DictEntry => ({ word, zh, source });

test('CSV 往返：解析→渲染→解析 内容一致（同内容同字节，便于版本化比对）', () => {
  const base = [e('barn', '谷仓'), e('windmill', '风车')];
  const csv = toDictCsv(base);
  assert.equal(csv.startsWith('\uFEFF词,释义,来源'), true);
  assert.deepEqual(parseDictCsv(csv), base);
  assert.equal(toDictCsv(parseDictCsv(csv)), csv, '渲染应稳定（排序后同内容同字节）');
});

test('解析容错：BOM、表头、空行、坏行都不炸', () => {
  const csv = '\uFEFF词,释义,来源\nbarn,谷仓,教师知识库\n\n,,\nbroken\n\nwindmill,风车,归一\n';
  assert.deepEqual(parseDictCsv(csv), [e('barn', '谷仓', '教师知识库'), e('windmill', '风车', '归一')]);
});

test('合并：增量里的新词进词典，重复的算无变化', () => {
  const r = mergeDict([e('barn', '谷仓')], [
    { origin: 'run-A', entries: [e('barn', '谷仓', 'run-A'), e('windmill', '风车', 'run-A')] },
  ]);
  assert.equal(r.added, 1);
  assert.equal(r.unchanged, 1);
  assert.deepEqual(r.conflicts, []);
  assert.equal(r.entries.find((x) => x.word === 'windmill')?.zh, '风车');
});

test('冲突不静默择一：基线释义优先（教师定过的不被自动新配覆盖），且冲突要报出来', () => {
  const r = mergeDict([e('boxer', '拳师', '教师知识库')], [
    { origin: 'run-A', entries: [e('boxer', '拳击手', 'run-A')] },
  ]);
  assert.equal(r.added, 0);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0]!.kept, '拳师');
  assert.equal(r.conflicts[0]!.dropped, '拳击手');
  assert.equal(r.entries.find((x) => x.word === 'boxer')?.zh, '拳师', '基线必须原样保留');
  assert.match(describeMerge(r).join('\n'), /保留基线释义/);
});

test('两个运行同时配同一个新词、释义不同 → 互冲突要报出来（这是并发才会出现的情形）', () => {
  const r = mergeDict([], [
    { origin: 'run-A', entries: [e('curdling', '凝结', 'run-A')] },
    { origin: 'run-B', entries: [e('curdling', '令人毛骨悚然', 'run-B')] },
  ]);
  assert.equal(r.added, 1);
  assert.equal(r.interConflicts.length, 1);
  assert.deepEqual(r.interConflicts[0]!.origins, ['run-A', 'run-B']);
  assert.equal(r.entries.length, 1, '只留一条，等人工定');
});

test('确定性：增量顺序不影响结果（并发下谁先写不改变最终词典）', () => {
  const a = { origin: 'run-A', entries: [e('x', '甲', 'A')] };
  const b = { origin: 'run-B', entries: [e('y', '乙', 'B')] };
  const m1 = mergeDict([], [a, b]);
  const m2 = mergeDict([], [b, a]);
  assert.deepEqual(m1.entries, m2.entries);
  assert.equal(toDictCsv(m1.entries), toDictCsv(m2.entries), '结果应逐字节一致');
});

test('合并是幂等的：同一批增量合并两次，第二次什么都不变', () => {
  const base = [e('barn', '谷仓')];
  const d = [{ origin: 'run-A', entries: [e('windmill', '风车', 'A')] }];
  const once = mergeDict(base, d);
  const twice = mergeDict(once.entries, d);
  assert.equal(twice.added, 0);
  assert.equal(twice.unchanged, 1);
  assert.equal(toDictCsv(twice.entries), toDictCsv(once.entries));
});

test('锁：空闲/占用/陈旧三态（进程崩了不能把词典永久锁死）', () => {
  const now = Date.parse('2026-09-11T10:00:00.000Z');
  assert.equal(lockState(null, now, () => true), 'free');
  const held = { pid: 42, host: 'mac', at: '2026-09-11T09:59:00.000Z' };
  assert.equal(lockState(held, now, () => true), 'held');
  assert.equal(lockState(held, now, () => false), 'stale', '进程不在了 → 陈旧可夺');
  const old = { pid: 42, host: 'mac', at: '2026-09-11T09:00:00.000Z' };
  assert.equal(lockState(old, now, () => true), 'stale', '超过 10 分钟视为陈旧');
});
