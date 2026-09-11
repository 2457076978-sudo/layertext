/**
 * 运行身份：指针分片与选取 · 测试
 *
 * 验收（《LayerText 工程优化总计划》阶段 3）：
 *   「两位教师同时对同一本书不同层级运行**不会覆盖词典、日志或产物**」
 *   「第二本书只需新建 manifest，不复制脚本」
 *   「任意发布文件可查询『由哪次运行、哪个模型、哪版词库生成』」
 *
 * 这一组用例盯的是一个**已实测到的真实缺陷**：
 * 原本只有一份全局 `清单_最新.json`，两位教师并发跑会互相覆盖，
 * 后跑者覆盖先跑者的身份，先跑者的进程再去读到**对方的 runId**——
 * 结果是把产物写进对方的运行目录，而两边都报告成功。
 * `--layout run` 挡不住这个：它挡的是"路径撞名"，不是"身份被换掉"。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  chooseIdentity,
  fileSafe,
  LATEST_POINTER_NAME,
  latestOf,
  pointerNameOf,
  type ManifestPointer,
} from '../src/core/manifest.js';

const ptr = (over: Partial<ManifestPointer> = {}): ManifestPointer => ({
  path: '/out/_运行/清单_A-x.json',
  runId: 'Animal Farm-v1-A层85-wayne-2b602dad',
  layout: 'run',
  teacher: 'wayne',
  tier: 'A层85',
  updatedAt: '2026-09-11T10:00:00.000Z',
  ...over,
});

/* ────────────────────── 分片：两个人的指针不是同一个文件 ────────────────────── */

test('★ 指针按 教师+层级 分片：两位教师、两个层级各写各的，谁也覆盖不了谁', () => {
  const a = pointerNameOf({ teacher: 'wayne', tier: 'A层85' });
  const b = pointerNameOf({ teacher: 'liu', tier: 'A层85' });
  const c = pointerNameOf({ teacher: 'wayne', tier: 'M层75' });
  assert.notEqual(a, b, '同一层级、不同教师 → 不同指针文件');
  assert.notEqual(a, c, '同一教师、不同层级 → 不同指针文件');
  assert.equal(a, '清单_wayne_A层85.json');
  assert.equal(b, '清单_liu_A层85.json');
  assert.equal(pointerNameOf({ teacher: 'wayne' }), '清单_wayne.json');
});

test('教师名里的路径分隔与空格不会跑出目录（中文名保留）', () => {
  const n = pointerNameOf({ teacher: '../../etc/passwd', tier: 'A层85' });
  assert.equal(n.includes('/'), false, '不能含路径分隔符');
  assert.equal(n.includes('..'), false, '不能含 ..');
  assert.equal(pointerNameOf({ teacher: '张 老师', tier: 'A层85' }), '清单_张-老师_A层85.json');
  assert.equal(pointerNameOf({ teacher: '   ', tier: 'A' }), '清单_unknown_A.json');
});

test('"最近一次"是索引不是事实源：它有自己固定的文件名，与分片指针并列', () => {
  assert.equal(LATEST_POINTER_NAME, '清单_最新.json');
  assert.notEqual(pointerNameOf({ teacher: 'wayne', tier: 'A层85' }), LATEST_POINTER_NAME);
});

/* ────────────────────── 选取：按可信度从高到低 ────────────────────── */

test('★ 分片指针优先于全局"最近一次"——这才是并发场景下的正确答案', () => {
  const r = chooseIdentity({
    want: { teacher: 'wayne', tier: 'A层85' },
    scoped: ptr({ runId: 'runA' }),
    latest: ptr({ runId: 'runB', teacher: 'liu', updatedAt: '2026-09-11T11:00:00.000Z' }),
    fallbackRunId: 'fallback',
  });
  assert.equal(r.source, '按教师分片');
  assert.equal(r.identity.runId, 'runA', '**不能**跟着"最近一次"跑去别人的运行里');
  assert.equal(r.warning, undefined);
});

test('显式指定 --run 最可信：清单里有就用清单里的 layout/teacher', () => {
  const r = chooseIdentity({
    want: { teacher: 'wayne', tier: 'A层85' },
    explicitRunId: 'runB',
    scoped: ptr({ runId: 'runA' }),
    latest: ptr({ runId: 'runB', teacher: 'liu' }),
    fallbackRunId: 'fallback',
  });
  assert.equal(r.source, '显式指定');
  assert.equal(r.identity.runId, 'runB');
  assert.equal(r.identity.teacher, 'liu', '清单怎么记的就怎么用——不按命令行猜');
});

test('显式指定了一个清单里没有的运行：照用，但**如实说明**产物会落到孤立的目录里', () => {
  const r = chooseIdentity({ want: { teacher: 'wayne' }, explicitRunId: 'runZ', fallbackRunId: 'fb' });
  assert.equal(r.identity.runId, 'runZ');
  assert.equal(r.identity.layout, 'run');
  assert.match(r.warning ?? '', /清单里没有这次运行/);
});

test('★ 只剩"最近一次"且教师对不上 → **拒绝采用**，退回 legacy 并响亮说明', () => {
  const r = chooseIdentity({
    want: { teacher: 'wayne', tier: 'A层85' },
    latest: ptr({ teacher: 'liu', tier: 'A层85' }),
    fallbackRunId: 'fb',
  });
  assert.equal(r.source, '无清单（legacy）');
  assert.equal(r.identity.runId, 'fb', '**没有**去用别人的 runId');
  assert.match(r.warning ?? '', /教师对不上/);
  assert.match(r.warning ?? '', /liu/);
  assert.match(r.warning ?? '', /wayne/);
  assert.match(r.warning ?? '', /LAYERTEXT_RUN|--run/, '要告诉人怎么正确并发跑');
});

test('★ 只剩"最近一次"且层级对不上 → 同样拒绝（同书不同层并发是最常见的并行场景）', () => {
  const r = chooseIdentity({
    want: { teacher: 'wayne', tier: 'M层75' },
    latest: ptr({ teacher: 'wayne', tier: 'A层85' }),
    fallbackRunId: 'fb',
  });
  assert.equal(r.source, '无清单（legacy）');
  assert.match(r.warning ?? '', /层级对不上/);
});

test('教师与层级都对得上 → 采用"最近一次"（单教师的日常路径，行为不变）', () => {
  const r = chooseIdentity({
    want: { teacher: 'wayne', tier: 'A层85' },
    latest: ptr({ teacher: 'wayne', tier: 'A层85', runId: 'runA' }),
    fallbackRunId: 'fb',
  });
  assert.equal(r.source, '最近一次');
  assert.equal(r.identity.runId, 'runA');
  assert.equal(r.identity.layout, 'run');
  assert.equal(r.warning, undefined);
});

test('教师名是 unknown（App 常常拿不到）→ 不当作"别人的运行"，照用', () => {
  const r = chooseIdentity({ want: { tier: 'A层85' }, latest: ptr({ teacher: 'wayne' }), fallbackRunId: 'fb' });
  assert.equal(r.source, '最近一次');
  assert.equal(r.identity.runId, ptr().runId);
});

test('我要的教师是 unknown 而清单里是真人名 → 也照用（App 不知道自己的名字，不等于认错了人）', () => {
  const r = chooseIdentity({ want: { teacher: 'unknown' }, latest: ptr({ teacher: 'wayne' }), fallbackRunId: 'fb' });
  assert.equal(r.source, '最近一次');
  assert.equal(r.warning, undefined);
});

test('什么都没读到 → legacy + 兜底 runId（单独跑某个脚本时的正常路径，不是错误）', () => {
  const r = chooseIdentity({ want: { teacher: 'wayne', tier: 'A层85' }, fallbackRunId: 'A层85-wayne' });
  assert.equal(r.source, '无清单（legacy）');
  assert.deepEqual(r.identity, { layout: 'legacy', runId: 'A层85-wayne', teacher: 'wayne', tier: 'A层85' });
  assert.equal(r.warning, undefined);
});

/* ────────────────────── 索引 ────────────────────── */

test('latestOf：取时间最新的那份；时间缺失的沉底而不是抛；同刻按 runId 定序保证可复现', () => {
  const a = ptr({ runId: 'a', updatedAt: '2026-09-11T09:00:00.000Z' });
  const b = ptr({ runId: 'b', updatedAt: '2026-09-11T11:00:00.000Z' });
  const c = ptr({ runId: 'c', updatedAt: undefined });
  assert.equal(latestOf([a, b, c])!.runId, 'b');
  assert.equal(latestOf([b, a])!.runId, 'b');
  assert.equal(latestOf([c, a])!.runId, 'a', '缺时间的沉底');
  assert.equal(latestOf([]), null);
  const tie = [ptr({ runId: 'x', updatedAt: '2026-09-11T10:00:00.000Z' }), ptr({ runId: 'y', updatedAt: '2026-09-11T10:00:00.000Z' })];
  assert.equal(latestOf(tie)!.runId, 'y');
  assert.equal(latestOf([...tie].reverse())!.runId, 'y', '顺序无关');
});

test('fileSafe：正常名字不动，危险字符换掉，空串给 unknown', () => {
  assert.equal(fileSafe('A层85'), 'A层85');
  assert.equal(fileSafe('wayne'), 'wayne');
  assert.equal(fileSafe('a/b\\c'), 'a-b-c');
  assert.equal(fileSafe(''), 'unknown');
  assert.equal(fileSafe('   '), 'unknown');
});
