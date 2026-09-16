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
import { appendCsvLineWith, backupPathFor, classifyRead, csvAppendPlan, planBackup, type CsvAppendIo, type PathProbe, type ReadOutcome } from '../app/src/fsx.js';

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

/* ══════════ 首改备份：三态策略（2026-09-16 验收） ══════════ */

test('planBackup：还没有备份 → write（首改前留一份）', () => {
  assert.deepEqual(planBackup('/d/x_原始备份.md', { kind: 'missing' }), { kind: 'write' });
});

test('planBackup：已经有备份 → skip（第二次改稿不把真原始版冲掉）', () => {
  assert.deepEqual(planBackup('/d/x_原始备份.md', { kind: 'ok', text: '旧原始版' }), { kind: 'skip' });
});

test('planBackup：备份在但读不出来 → abort，理由必须说清"不覆盖、本次没执行"', () => {
  const p = planBackup('/d/x_原始备份.md', { kind: 'unreadable', error: '权限被拒' });
  assert.equal(p.kind, 'abort');
  assert.match((p as { reason: string }).reason, /\/d\/x_原始备份\.md/);
  assert.match((p as { reason: string }).reason, /权限被拒/);
  assert.match((p as { reason: string }).reason, /没有执行/);
});

test('backupPathFor：同目录、去扩展名、加 _原始备份.md（三处调用点共用的约定）', () => {
  assert.equal(backupPathFor('/out/第一章/原文_A层85_2026-09-10.md'), '/out/第一章/原文_A层85_2026-09-10_原始备份.md');
  assert.equal(backupPathFor('/a/b.txt'), '/a/b_原始备份.md');
  assert.equal(backupPathFor('/a/b.MARKDOWN'), '/a/b_原始备份.md');
  assert.equal(backupPathFor('/a/无扩展名'), '/a/无扩展名_原始备份.md');
});

/* ══════════ append-only CSV 台账（2026-09-16 验收） ══════════ */

const HDR = ['时间', '句子', '结果'] as const;

test('csvAppendPlan：台账还没有 → init（连表头一起建）', () => {
  const p = csvAppendPlan('/t/a.csv', { kind: 'missing' }, HDR, 'r1\n');
  assert.deepEqual(p, { kind: 'init', content: '时间,句子,结果\nr1\n' });
});

test('csvAppendPlan：台账在但是空的 → 也 init（空文件等于还没开账）', () => {
  const p = csvAppendPlan('/t/a.csv', { kind: 'ok', text: '\n \n' }, HDR, 'r1\n');
  assert.equal(p.kind, 'init');
});

test('csvAppendPlan：已有内容 → append（只追加这一行，绝不重写整份）', () => {
  const p = csvAppendPlan('/t/a.csv', { kind: 'ok', text: '时间,句子,结果\nr1\n' }, HDR, 'r2\n');
  assert.deepEqual(p, { kind: 'append', content: 'r2\n' });
});

test('csvAppendPlan：在但读不出来 → abort（原先两态会拿新表头把旧账覆盖掉）', () => {
  const p = csvAppendPlan('/t/a.csv', { kind: 'unreadable', error: 'io error' }, HDR, 'r2\n');
  assert.equal(p.kind, 'abort');
  assert.match((p as { reason: string }).reason, /\/t\/a\.csv/);
});

/** 内存版 CsvAppendIo：readChecked 用真值表，write/append 记调用 */
function memCsv(files: Record<string, string>): CsvAppendIo & { writes: string[]; appends: string[] } {
  const writes: string[] = [];
  const appends: string[] = [];
  return {
    writes,
    appends,
    readChecked: (p): Promise<ReadOutcome> => Promise.resolve(p in files ? { kind: 'ok', text: files[p]! } : { kind: 'missing' }),
    write: (p, c) => {
      writes.push(p);
      files[p] = c;
      return Promise.resolve();
    },
    append: (p, l) => {
      appends.push(l);
      files[p] = (files[p] ?? '') + l;
      return Promise.resolve();
    },
  };
}

test('appendCsvLineWith：第一次建表头，之后只追加——write 恰好一次', async () => {
  const files: Record<string, string> = {};
  const io = memCsv(files);
  const append = appendCsvLineWith(io);
  await append('/t/a.csv', HDR, 'r1\n');
  await append('/t/a.csv', HDR, 'r2\n');
  await append('/t/a.csv', HDR, 'r3\n');
  assert.equal(io.writes.length, 1, '表头只在第一次出现（原子写）');
  assert.equal(io.appends.length, 2, '后续一律原子追加');
  assert.equal(files['/t/a.csv'], '时间,句子,结果\nr1\nr2\nr3\n');
});

test('appendCsvLineWith：并发两次记台账（不 await 第一次）——表头恰一份、两行都在', async () => {
  const files: Record<string, string> = {};
  const io = memCsv(files);
  const append = appendCsvLineWith(io);
  const p1 = append('/t/a.csv', HDR, 'r1\n');
  const p2 = append('/t/a.csv', HDR, 'r2\n');
  await Promise.all([p1, p2]);
  const text = files['/t/a.csv']!;
  assert.equal(text.match(/时间,句子,结果/g)?.length, 1, '表头只能出现一次——两次都看到"没台账"再各建一份，就是原来的丢行现场');
  assert.ok(text.includes('r1\n') && text.includes('r2\n'), '两行都在');
  assert.equal(io.writes.length, 1);
});

test('appendCsvLineWith：台账读不出来 → 抛错，且 write/append 一次都不调用', async () => {
  const io = memCsv({});
  io.readChecked = () => Promise.resolve({ kind: 'unreadable', error: '权限被拒' });
  const append = appendCsvLineWith(io);
  await assert.rejects(append('/t/a.csv', HDR, 'r1\n'), /读不出来/);
  assert.equal(io.writes.length + io.appends.length, 0, '读不出来时一个字节都不写——旧账不容覆盖');
});
