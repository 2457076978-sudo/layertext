/**
 * 风险队列面板 回归测试（纯逻辑层，happy-dom 之外）
 *
 * 验收标准（《LayerText 项目审查报告（2026-09-11）》§一）：
 *   「界面应先显示 风险 = 概率 × 后果 队列……每项显示原句、改写句、触发规则、
 *     上下文两句和『一键采纳/退回/标记误报』」
 *   「教师修改不应只写 mark JSON。追加不可变事件：decision, before, after, reason,
 *     ruleIds, teacherId, timestamp, sourceVersion」
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appendDecision,
  decisionLineFor,
  loadRunIdentity,
  loadRiskQueue,
  decidedRows,
  panelStat,
  parseQueueFile,
  pendingItems,
  latestDecisions,
  proposalPreview,
  refOf,
  ruleLabel,
  setRiskIo,
  subjectOf,
  type RiskIo,
  type RiskQueueFile,
} from '../app/src/risk.js';
import { makeDecisionEvent, parseDecisionLog } from '../src/core/decision.js';
import type { RiskItem } from '../src/core/riskqueue.js';

const item = (over: Partial<RiskItem> = {}): RiskItem => ({
  id: '第一章#2:FACT-01:1911',
  ruleId: 'FACT-01',
  category: '事实',
  severity: 'warn',
  consequence: 22,
  probability: 0.6,
  risk: 13.2,
  chapter: '第一章',
  segIndex: 2,
  segLabel: '第一章 第3段',
  title: '原文的「1911」在改写里找不到',
  sourceSentence: 'In 1911 Napoleon gave a speech.',
  rewrittenSentence: 'The pig gave a speech.',
  context: { prev: 'The animals met.', next: 'Everyone listened.' },
  detail: { signal: '1911' },
  ...over,
});

const file = (items: RiskItem[] = [item()], unfinished = 0): RiskQueueFile => ({
  schemaVersion: 1,
  书名: 'Animal Farm',
  层级: ['A'],
  章节: [1],
  摘要: { total: items.length, blockers: items.filter((i) => i.severity === 'blocker').length, byRule: {}, byCategory: {}, estimatedMinutes: items.length * 2 },
  未完成段落: Array.from({ length: unfinished }, (_, i) => ({ tier: 'A', chapter: '第一章', segId: `P0${i + 1}`, segIndex: i, source: 'x' })),
  队列: items,
});

/* ────────────────── 解析与待办 ────────────────── */

test('队列文件解析：坏 JSON / 缺字段 → null（面板该显示"还没跑过"，而不是崩）', () => {
  assert.equal(parseQueueFile('not json'), null);
  assert.equal(parseQueueFile('{"层级":["A"]}'), null, '缺 队列 数组');
  assert.equal(parseQueueFile(JSON.stringify(file()))?.队列.length, 1);
});

test('决定过的从待办里消失，但事件一条不删', () => {
  const f = file([item(), item({ id: 'b', ruleId: 'ANNO-01' })]);
  const ev = decisionLineFor(f.队列[0], 'accept', { teacherId: 'wayne', sourceVersion: 'sha1', timestamp: '2026-09-11T10:00:00.000Z' });
  const left = pendingItems(f, [ev]);
  assert.deepEqual(left.map((i) => i.id), ['b']);
});

test('决定事件的字段与报告逐项对应（decision/before/after/ruleIds/teacherId/timestamp/sourceVersion）', () => {
  const e = decisionLineFor(item(), 'false-positive', {
    teacherId: 'wayne',
    sourceVersion: 'sha-abc',
    reason: '年份是教学锚点',
    timestamp: '2026-09-11T10:05:00.000Z',
  });
  assert.equal(e.decision, 'false-positive');
  assert.equal(e.before, 'In 1911 Napoleon gave a speech.');
  assert.equal(e.after, 'The pig gave a speech.', '没给 after 时回落到改写句，教师改了什么有据可查');
  assert.deepEqual(e.ruleIds, ['FACT-01']);
  assert.equal(e.teacherId, 'wayne');
  assert.equal(e.timestamp, '2026-09-11T10:05:00.000Z');
  assert.equal(e.sourceVersion, 'sha-abc');
  assert.equal(e.itemId, '第一章#2:FACT-01:1911');
});

test('subjectOf：决定针对什么，决定它以后进哪个库', () => {
  assert.deepEqual(subjectOf(item()), { kind: 'number', value: '1911' });
  assert.deepEqual(subjectOf(item({ detail: { signal: 'Napoleon' } })), { kind: 'proper', value: 'Napoleon' });
  assert.deepEqual(subjectOf(item({ ruleId: 'ANNO-01', category: '加注', detail: { word: 'windmill' } })), { kind: 'word', value: 'windmill' });
  assert.equal(subjectOf(item({ ruleId: 'SENT-01', detail: {} })).kind, 'sentence');
  assert.equal(subjectOf(item({ ruleId: 'LEN-01', detail: {} })).kind, 'sentence');
});

/* ────────────────── 统计 ────────────────── */

test('面板统计：先看统计——总数/待办/已决/不可完成/估时/误报率/未完成段落', () => {
  const f = file([item(), item({ id: 'b', ruleId: 'ANNO-01', severity: 'blocker', category: '加注' })], 3);
  const s0 = panelStat(f, []);
  assert.equal(s0.total, 2);
  assert.equal(s0.pending, 2);
  assert.equal(s0.decided, 0);
  assert.equal(s0.blocked, 1);
  assert.equal(s0.unfinished, 3);
  assert.equal(s0.estimatedMinutes, 2.5, '事实类 2 分钟 + 漏注 0.5 分钟');

  const ev = decisionLineFor(f.队列[0], 'accept', { teacherId: 'wayne', sourceVersion: 's', timestamp: '2026-09-11T10:00:00.000Z' });
  const s1 = panelStat(f, [ev]);
  assert.equal(s1.decided, 1);
  assert.equal(s1.pending, 1);
  assert.equal(s1.estimatedMinutes, 0.5, '已采纳的不该继续占用人工预算');
});

test('误报率进统计：它是规则噪音水平的直接度量', () => {
  const f = file();
  const e1 = decisionLineFor(f.队列[0], 'false-positive', { teacherId: 'wayne', sourceVersion: 's', timestamp: '2026-09-11T10:00:00.000Z' });
  const e2 = decisionLineFor(f.队列[0], 'accept', { teacherId: 'wayne', sourceVersion: 's', timestamp: '2026-09-11T10:01:00.000Z' });
  assert.equal(panelStat(f, [e1, e2]).falsePositiveRate, 0.5);
});

test('超预算给的是"先修规则或词库"，不是加班', () => {
  const many = Array.from({ length: 10 }, (_, i) => item({ id: `x${i}` }));
  const s = panelStat(file(many, 0), [], 10);
  assert.equal(s.overBudget, true);
  assert.match(s.advice, /停止扩展审校，先修生成规则或词库/);
});

test('规则人话标签与引擎规则表同源（面板不再各写一份）', () => {
  assert.equal(ruleLabel('FACT-01'), '数字变化/丢失');
  assert.equal(ruleLabel('ANNO-01'), '超纲词漏注');
  assert.equal(ruleLabel('未知-99'), '未知-99');
});

test('提议预览：面板直接告诉教师"这些决定汇总器会提议什么"', () => {
  const f = file([item({ id: 'a', ruleId: 'ANNO-01', detail: { word: 'windmill' } }), item({ id: 'b', ruleId: 'ANNO-01', detail: { word: 'windmill' } })]);
  const evs = f.队列.map((it, i) =>
    decisionLineFor(it, 'accept', { teacherId: 'wayne', sourceVersion: 's', after: '风车', timestamp: `2026-09-11T10:0${i}:00.000Z` }),
  );
  const p = proposalPreview(evs);
  assert.equal(p.length, 1);
  assert.equal(p[0].kind, 'dict-entry');
  assert.equal(p[0].key, 'windmill');
  assert.equal(p[0].count, 2);
});

/* ────────────────── IO：读队列、写决定（事件只增不改） ────────────────── */

function memIo(files: Record<string, string>): { io: RiskIo; files: Record<string, string> } {
  return {
    files,
    io: {
      async read(p) {
        if (!(p in files)) throw new Error(`no such file: ${p}`);
        return files[p];
      },
      async write(p, c) {
        files[p] = c;
      },
      async listDir() {
        return [];
      },
    },
  };
}

test('读队列：队列文件缺了给的是人话提示，而不是异常', async () => {
  const { io } = memIo({});
  setRiskIo(io);
  const r = await loadRiskQueue({ outDir: '/out', workDir: '/work', sourceVersion: 's' }, 'A');
  assert.equal(r.file, null);
  assert.match(r.error ?? '', /还没生成过风险队列/);
  assert.deepEqual(r.events, []);
});

test('读队列：没有决定日志是正常的，不是错误', async () => {
  const { io } = memIo({ '/out/_运行/风险队列_A层85.json': JSON.stringify(file()) });
  setRiskIo(io);
  const r = await loadRiskQueue({ outDir: '/out', workDir: '/work', sourceVersion: 's' }, 'A');
  assert.equal(r.file?.队列.length, 1);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.events, []);
});

test('写决定：追加而不是覆盖（append-only），两次决定都在日志里', async () => {
  const { io, files } = memIo({ '/out/_运行/风险队列_A层85.json': JSON.stringify(file()) });
  setRiskIo(io);
  const paths = { outDir: '/out', workDir: '/work', sourceVersion: 'sha-1' };
  const f = file();
  await appendDecision(paths, 'A', decisionLineFor(f.队列[0], 'reject', { teacherId: 'wayne', sourceVersion: paths.sourceVersion, timestamp: '2026-09-11T10:00:00.000Z' }));
  await appendDecision(paths, 'A', decisionLineFor(f.队列[0], 'accept', { teacherId: 'wayne', sourceVersion: paths.sourceVersion, timestamp: '2026-09-11T10:01:00.000Z' }));
  const log = files['/work/_决定/A层85.jsonl'];
  assert.equal(parseDecisionLog(log).events.length, 2, '教师改主意，历史一条都不能删');
  const r = await loadRiskQueue(paths, 'A');
  assert.deepEqual(r.events.map((e) => e.decision), ['reject', 'accept']);
});

/* ────────────────── 路径也由清单解析（App 与命令行同一套口径） ────────────────── */

test('读清单拿运行身份：run 布局下按运行私有目录找队列与决定日志', async () => {
  const RID = 'AnimalFarm-v1-A-wayne-abc';
  const files: Record<string, string> = {
    '/out/_运行/清单_最新.json': JSON.stringify({ runId: RID, path: `/out/_运行/清单_${RID}.json` }),
    [`/out/_运行/清单_${RID}.json`]: JSON.stringify({ runId: RID, layout: 'run', teacher: 'wayne' }),
    [`/out/_运行/${RID}/风险队列.json`]: JSON.stringify(file()),
    [`/out/_运行/${RID}/决定/A层85.jsonl`]: '',
  };
  setRiskIo(memIo(files).io);

  const id = await loadRunIdentity({ outDir: '/out', workDir: '/work', sourceVersion: 's' });
  // 身份多了一个 `source`：**"我读的是哪一次运行"必须可见**，否则"读到别人的运行"这件事无法察觉
  assert.deepEqual(id, { layout: 'run', runId: RID, teacher: 'wayne', source: '最近一次' });

  const r = await loadRiskQueue({ outDir: '/out', workDir: '/work', sourceVersion: 's' }, 'A');
  assert.equal(r.file?.队列.length, 1, 'run 布局下队列要从 _运行/<runId>/ 里找');
  assert.equal(r.identity.layout, 'run');

  await appendDecision({ outDir: '/out', workDir: '/work', sourceVersion: 's' }, 'A', decisionLineFor(r.file!.队列[0]!, 'accept', { teacherId: 'wayne', sourceVersion: 's', timestamp: '2026-09-11T10:00:00.000Z' }));
  assert.equal(parseDecisionLog(files[`/out/_运行/${RID}/决定/A层85.jsonl`]!).events.length, 1, '决定也要写进运行私有目录');
});

test('没有清单时退回 legacy：老项目一个字都不用改', async () => {
  const files: Record<string, string> = { '/out/_运行/风险队列_A层85.json': JSON.stringify(file()) };
  setRiskIo(memIo(files).io);
  const r = await loadRiskQueue({ outDir: '/out', workDir: '/work', sourceVersion: 's' }, 'A');
  assert.equal(r.identity.layout, 'legacy');
  assert.equal(r.file?.队列.length, 1);
  assert.equal(r.error, undefined);
});

test('清单指针指向的文件读不到 → 退回 legacy 而不是崩（坏清单不该让面板全黑）', async () => {
  const files: Record<string, string> = {
    '/out/_运行/清单_最新.json': JSON.stringify({ runId: 'x', path: '/out/_运行/清单_x.json' }),
    '/out/_运行/风险队列_A层85.json': JSON.stringify(file()),
  };
  setRiskIo(memIo(files).io);
  const id = await loadRunIdentity({ outDir: '/out', workDir: '/work', sourceVersion: 's' });
  assert.equal(id.layout, 'legacy');
});

/* ────────────────── 执行失败 ≠ 处理完毕（v4 方向第 2 条） ────────────────── */

test('★ rejected（动作没执行成）不算已处理：卡片必须留在待办里', () => {
  const f = file([item(), item({ id: 'b', ruleId: 'ANNO-01', severity: 'blocker', category: '加注' })]);
  const failed = decisionLineFor(f.队列[0]!, 'rejected', {
    teacherId: 'wayne', sourceVersion: 's', reason: '找不到段落 P10', timestamp: '2026-09-11T10:00:00.000Z',
  });
  const left = pendingItems(f, [failed]);
  assert.deepEqual(left.map((i) => i.id), ['第一章#2:FACT-01:1911', 'b'], '失败了就还得办，不能从待办消失');

  const stat = panelStat(f, [failed]);
  assert.equal(stat.pending, 2, '统计口径也要一致：失败的不算已决');
  assert.equal(stat.decided, 0);

  // 教师后来真的处理了，才算完
  const done = decisionLineFor(f.队列[0]!, 'accept', {
    teacherId: 'wayne', sourceVersion: 's', timestamp: '2026-09-11T10:05:00.000Z',
  });
  assert.deepEqual(pendingItems(f, [failed, done]).map((i) => i.id), ['b']);
  assert.equal(panelStat(f, [failed, done]).decided, 1);
});

test('四种终态决定才算处理完（accept/reject/false-positive/edit）', () => {
  const f = file();
  for (const k of ['accept', 'reject', 'false-positive', 'edit'] as const) {
    const e = decisionLineFor(f.队列[0]!, k, { teacherId: 'w', sourceVersion: 's', timestamp: '2026-09-11T10:00:00.000Z' });
    assert.equal(pendingItems(f, [e]).length, 0, `${k} 应当算处理完`);
  }
});

/* ────────────────── 撤销：新事件，不是删历史（v4 方向第 2 条） ────────────────── */

test('撤销是**新事件**：历史一条不删，被撤销的项回到待办', () => {
  const f = file();
  const accept = decisionLineFor(f.队列[0]!, 'accept', {
    teacherId: 'w', sourceVersion: 's', timestamp: '2026-09-11T10:00:00.000Z',
  });
  assert.equal(pendingItems(f, [accept]).length, 0, '先决了 → 不在待办');

  const undo = makeDecisionEvent({
    itemId: accept.itemId, decision: 'undo', before: accept.after, after: accept.before,
    reason: '改主意了', ruleIds: accept.ruleIds, teacherId: 'w', sourceVersion: 's',
    timestamp: '2026-09-11T10:05:00.000Z', undoOf: refOf(accept),
  });
  const events = [accept, undo];
  assert.equal(events.length, 2, '撤销不删历史');
  assert.deepEqual(pendingItems(f, events).map((i) => i.id), [accept.itemId], '撤销后回到待办');

  const rows = decidedRows(f, events);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.undone, true, '列表里标出来"已撤销"');
  assert.equal(rows[0]!.ref, refOf(accept));
});

test('「看我判过的」按时间倒序，最近的先看到', () => {
  const f = file([item(), item({ id: 'b', ruleId: 'ANNO-01', category: '加注', severity: 'blocker' })]);
  const e1 = decisionLineFor(f.队列[0]!, 'accept', { teacherId: 'w', sourceVersion: 's', timestamp: '2026-09-11T10:00:00.000Z' });
  const e2 = decisionLineFor(f.队列[1]!, 'false-positive', { teacherId: 'w', sourceVersion: 's', timestamp: '2026-09-11T11:00:00.000Z' });
  const rows = decidedRows(f, [e1, e2]);
  assert.deepEqual(rows.map((r) => r.item.id), ['b', '第一章#2:FACT-01:1911']);
  assert.deepEqual(rows.map((r) => r.label), ['标记误报', '采纳']);
});

test('撤销是**单级**：撤销最新那条 = 整条作废、回到待办（不做多级回退）', () => {
  const f = file();
  const a = decisionLineFor(f.队列[0]!, 'reject', { teacherId: 'w', sourceVersion: 's', timestamp: '2026-09-11T10:00:00.000Z' });
  const b = decisionLineFor(f.队列[0]!, 'accept', { teacherId: 'w', sourceVersion: 's', timestamp: '2026-09-11T11:00:00.000Z' });
  const undoB = makeDecisionEvent({
    itemId: b.itemId, decision: 'undo', before: b.after, after: b.before, reason: '', ruleIds: b.ruleIds,
    teacherId: 'w', sourceVersion: 's', timestamp: '2026-09-11T12:00:00.000Z', undoOf: refOf(b),
  });
  const rows = decidedRows(f, [a, b, undoB]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.event.decision, 'accept', '列表显示的是"最新那条 + 已撤销"');
  assert.equal(rows[0]!.undone, true);
  // 单级撤销的语义：整条作废 → 回到待办（教师心里只有"点错了，撤销一下"）
  assert.deepEqual(pendingItems(f, [a, b, undoB]).map((i) => i.id), [b.itemId]);
  // 再判一次就又是一条新决定——历史仍然一条不删
  const c = decisionLineFor(f.队列[0]!, 'false-positive', { teacherId: 'w', sourceVersion: 's', timestamp: '2026-09-11T13:00:00.000Z' });
  assert.equal(pendingItems(f, [a, b, undoB, c]).length, 0);
  assert.equal(latestDecisions([a, b, undoB, c]).get(b.itemId)!.decision, 'false-positive');
});
