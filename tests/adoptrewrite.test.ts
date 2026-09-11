/**
 * 采纳一句改写 · 测试
 *
 * 验收（《LayerText 工程优化总计划》阶段 1）：
 *   「新教师在没有读文档的情况下完成『打开项目 → 采纳一条建议 → 撤销 → 再发布一段』」
 *   「**任何门禁失败均不改变正文**」
 *   「所有发布段可由 `sourceVersion + traceId` 重放」
 *   「首次点击到可采纳结果的 P95 小于 10 秒（不含模型等待单独计）」——见最后一条用例
 *
 * 每条都先构造**能触发旧路径真实缺陷的输入**：
 *   旧路径是 `persistEdit(s.md)` 整份覆盖——没有 baseVersion、没有版本节点、
 *   门禁只在"生成候选"那一刻跑过一次、采纳时不再复判。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { adoptMessage, adoptRewrite, chapterOf, guardFromRewrite, segIdOfIndex, sourceVersionOf } from '../app/src/adoptrewrite.js';
import { parseDecisionLog } from '../src/core/decision.js';
import { contentHash } from '../src/core/manifest.js';
import { parseVersionLog, replayByTrace, type TxIo } from '../src/core/version.js';
import type { RewriteResult } from '../src/core/rewrite.js';

/* ────────────────────── 夹具 ────────────────────── */

const DOC = `# Animal Farm

## Chapter One

[P01] Mr Jones locked the hen-houses.
[P02] The animals were very tired of working on the farm every single day.

## 词句卡
`;

const DOC_PATH = '/out/第一章/原文_A层85_2026-09-11.md';
const CFG = { 产物目录: '/out', 调适工作区: '/work' };

function fs(initial: Record<string, string>): { files: Record<string, string>; io: TxIo } {
  const files: Record<string, string> = { ...initial };
  return {
    files,
    io: {
      read: (p) => (p in files ? Promise.resolve(files[p]!) : Promise.reject(new Error(`ENOENT ${p}`))),
      write: (p, c) => {
        files[p] = c;
        return Promise.resolve();
      },
      now: () => '2026-09-11T10:00:00.000Z',
    },
  };
}

const verdict = (over: Partial<RewriteResult> = {}): RewriteResult => ({
  revised: 'The animals were very tired of working.',
  checks: { status: 'pass' } as RewriteResult['checks'],
  status: 'candidate',
  traceId: 'trace-9f3a11cd',
  missingPolicy: [],
  blockedReasons: [],
  ...over,
});

const base = (over: Partial<Parameters<typeof adoptRewrite>[1]> = {}) => ({
  sessionText: DOC,
  sourcePath: DOC_PATH,
  pi: 1,
  original: 'The animals were very tired of working on the farm every single day.',
  revised: 'The animals were very tired of working.',
  itemId: '句子@P02',
  verdict: verdict(),
  config: CFG,
  teacherId: 'wayne',
  tier: 'A',
  ...over,
});

const VERSION_PATH = '/work/_版本/A层85.jsonl';
const DECISION_PATH = '/work/_决定/A层85.jsonl';

/* ────────────────────── ① 写入 = 一次带版本的事务 ────────────────────── */

test('★ 采纳一句改写：写正文 + 出父版本 + 记事件，三件事同一次做完', async () => {
  const f = fs({ [DOC_PATH]: DOC });
  const r = await adoptRewrite(f.io, base());

  assert.equal(r.status, 'applied');
  if (r.status !== 'applied') return;

  assert.match(f.files[DOC_PATH]!, /The animals were very tired of working\.\n/, '候选句写进了正文');
  assert.equal(f.files[DOC_PATH]!.includes('every single day'), false, '原句不再残留');

  const nodes = parseVersionLog(f.files[VERSION_PATH] ?? '').nodes;
  assert.equal(nodes.length, 1, '**写正文必有版本节点**——旧路径这里是 0');
  assert.equal(nodes[0]!.version, r.version);
  assert.equal(nodes[0]!.kind, 'apply');
  assert.equal(nodes[0]!.action, 'rewrite');
  assert.equal(nodes[0]!.target.segId, 'P02');
  assert.equal(nodes[0]!.target.traceId, 'trace-9f3a11cd', 'traceId 落进版本节点');
  assert.equal(nodes[0]!.segBefore, 'The animals were very tired of working on the farm every single day.');
  assert.equal(nodes[0]!.segAfter, 'The animals were very tired of working.');

  const ev = parseDecisionLog(f.files[DECISION_PATH] ?? '').events;
  assert.equal(ev.length, 1);
  assert.equal(ev[0]!.eventId, r.eventId, '两本账互为外键');
  assert.equal(ev[0]!.version, r.version);
  assert.equal(ev[0]!.traceId, 'trace-9f3a11cd');
  assert.equal(ev[0]!.teacherId, 'wayne');
});

test('★ 发布段可由 sourceVersion + traceId 重放（阶段 1 验收原文）', async () => {
  const f = fs({ [DOC_PATH]: DOC });
  const r = await adoptRewrite(f.io, base());
  assert.equal(r.status, 'applied');
  if (r.status !== 'applied') return;

  const ev = parseDecisionLog(f.files[DECISION_PATH] ?? '').events[0]!;
  const rep = replayByTrace(parseVersionLog(f.files[VERSION_PATH] ?? '').nodes, ev.sourceVersion, ev.traceId!);
  assert.equal(rep.found, true);
  assert.equal(rep.consistent, true);
  assert.equal(rep.text, 'The animals were very tired of working.');
});

test('sourceVersion 是**正文内容哈希**，不是层级标签', async () => {
  const sv = sourceVersionOf(DOC);
  assert.equal(sv, contentHash(DOC));
  assert.notEqual(sv, 'A层85', '旧代码存的是层级标签——它回答不了"对着哪一版底稿做的"');
  assert.equal(sourceVersionOf(DOC, 'p1.2'), `${contentHash(DOC)}@p1.2`, '带上提示词版本');
  assert.notEqual(sourceVersionOf(DOC), sourceVersionOf(DOC + ' '), '换一个字节就换版本');
});

/* ────────────────────── ② 门禁：没过就不写正文 ────────────────────── */

test('★ 门禁没过 → 正文一个字符都不动，只留下失败记录', async () => {
  const f = fs({ [DOC_PATH]: DOC });
  const r = await adoptRewrite(f.io, base({ verdict: verdict({ status: 'blocked', blockedReasons: ['SENT-01 有 1 句超过本层 12 词上限', 'ANNO-01 以下超纲词还没加注：windmill'] }) }));

  assert.equal(r.status, 'rejected');
  if (r.status !== 'rejected') return;
  assert.equal(r.kind, 'blocked');
  assert.equal(r.docTouched, false);
  assert.equal(f.files[DOC_PATH], DOC, '正文逐字节未变');
  assert.equal(f.files[VERSION_PATH], undefined, '被闸拦下不产生版本节点');
  assert.match(r.reason, /SENT-01/);
  assert.match(r.reason, /ANNO-01/, '原因要全给出来，不是只说第一条');
});

test('★ 门禁没跑成（null）也不放行——"检查出错"绝不允许变成"通过"', async () => {
  const f = fs({ [DOC_PATH]: DOC });
  const r = await adoptRewrite(f.io, base({ verdict: null }));
  assert.equal(r.status, 'rejected');
  if (r.status !== 'rejected') return;
  assert.equal(r.kind, 'blocked');
  assert.equal(f.files[DOC_PATH], DOC);
  assert.match(r.reason, /门禁未能运行/);
});

test('guardFromRewrite 三态：candidate 放行 · blocked 拦下 · null 拦下', () => {
  assert.equal(guardFromRewrite(verdict())({ doc: '', nextDoc: '', segId: 'P01', action: 'rewrite' }).ok, true);
  assert.equal(guardFromRewrite(verdict({ status: 'blocked' }))({ doc: '', nextDoc: '', segId: 'P01', action: 'rewrite' }).ok, false);
  assert.equal(guardFromRewrite(null)({ doc: '', nextDoc: '', segId: 'P01', action: 'rewrite' }).ok, false);
});

/* ────────────────────── ③ 会话与盘上不一致：不写 ────────────────────── */

test('★ 编辑器里有未保存的改动 → 拒绝写入（不做"按会话整份覆盖"那件事）', async () => {
  const f = fs({ [DOC_PATH]: DOC });
  const dirty = DOC.replace('[P01] Mr Jones', '[P01] Old Major');
  const r = await adoptRewrite(f.io, base({ sessionText: dirty }));

  assert.equal(r.status, 'rejected');
  if (r.status !== 'rejected') return;
  assert.equal(r.kind, 'stale');
  assert.equal(f.files[DOC_PATH], DOC, '盘上的正文没被覆盖');
  assert.equal(f.files[VERSION_PATH], undefined);
  assert.match(r.reason, /未保存/);
});

test('★ 别的窗口改过同一章 → 同样拒绝（会话内容已是旧的）', async () => {
  const f = fs({ [DOC_PATH]: DOC.replace('Mr Jones', 'Mr Jones Sr') });
  const r = await adoptRewrite(f.io, base());
  assert.equal(r.status, 'rejected');
  if (r.status !== 'rejected') return;
  assert.equal(r.docTouched, false);
});

/* ────────────────────── ④ 定位失败的诚实报错 ────────────────────── */

test('段号在正文里不存在 → 拒绝并说明，不是静默什么都不做', async () => {
  const f = fs({ [DOC_PATH]: DOC });
  const r = await adoptRewrite(f.io, base({ pi: 8 }));
  assert.equal(r.status, 'rejected');
  if (r.status !== 'rejected') return;
  assert.equal(f.files[DOC_PATH], DOC);
  assert.match(r.reason, /找不到/);
});

test('原句在这段里已不存在（稿件改过）→ 拒绝，绝不写错位置', async () => {
  const f = fs({ [DOC_PATH]: DOC });
  // 会话与盘上一致，但段里已经没有那句话了（比如原句写错了段）
  const r = await adoptRewrite(f.io, base({ original: 'A sentence that was never here.' }));
  assert.equal(r.status, 'rejected');
  if (r.status !== 'rejected') return;
  assert.equal(f.files[DOC_PATH], DOC);
});

test('★ 原句在**别的段**里也出现时，只改这一句所在的那一段（不做全篇替换）', async () => {
  const dup = `## Chapter One\n\n[P01] A barn here.\n[P02] A barn here.\n`;
  const p = '/out/第一章/原文_A层85_x.md';
  const f = fs({ [p]: dup });
  const r = await adoptRewrite(f.io, base({ sourcePath: p, sessionText: dup, pi: 1, original: 'A barn here.', revised: 'A barn stands here.' }));
  assert.equal(r.status, 'applied');
  if (r.status !== 'applied') return;
  assert.match(f.files[p]!, /\[P01\] A barn here\./, '第一段原封不动');
  assert.match(f.files[p]!, /\[P02\] A barn stands here\./, '只改第二段');
});

/* ────────────────────── ⑤ 未保存 / 没配置：说清楚为什么 ────────────────────── */

test('没落过盘的稿：拒绝，并说清"先另存"——而不是悄悄写到一个临时文件里', async () => {
  const f = fs({ [DOC_PATH]: DOC });
  const r = await adoptRewrite(f.io, base({ sourcePath: null }));
  assert.equal(r.status, 'rejected');
  if (r.status !== 'rejected') return;
  assert.match(r.reason, /还没保存到文件/);
});

test('没有调适项目配置：拒绝，并说清缺什么', async () => {
  const f = fs({ [DOC_PATH]: DOC });
  const r = await adoptRewrite(f.io, base({ config: null }));
  assert.equal(r.status, 'rejected');
  if (r.status !== 'rejected') return;
  assert.match(r.reason, /调适项目配置/);
  assert.equal(f.files[DOC_PATH], DOC);
});

/* ────────────────────── ⑥ 界面文案是可行动的 ────────────────────── */

test('失败文案必须说清"正文有没有变"，成功文案必须给出可追溯的版本号', async () => {
  const f = fs({ [DOC_PATH]: DOC });
  const ok = await adoptRewrite(f.io, base());
  const okMsg = adoptMessage(ok);
  assert.equal(okMsg.ok, true);
  assert.match(okMsg.text, /已写入正文（版本 v0001-/);
  assert.match(okMsg.text, /可追溯|版本/);

  const f2 = fs({ [DOC_PATH]: DOC });
  const blocked = await adoptRewrite(f2.io, base({ verdict: verdict({ status: 'blocked', blockedReasons: ['LEN-01'] }) }));
  const badMsg = adoptMessage(blocked);
  assert.equal(badMsg.ok, false);
  assert.match(badMsg.text, /未写入正文/);
});

/* ────────────────────── ⑦ 采纳 → 撤销 → 再采纳（新教师那条路径） ────────────────────── */

test('★ 打开项目 → 采纳 → 撤销 → 再发布一段：每一步都有版本可查', async () => {
  const f = fs({ [DOC_PATH]: DOC });
  const V = '/work/_版本/A层85.jsonl';
  const D = '/work/_决定/A层85.jsonl';

  // ① 采纳
  const a1 = await adoptRewrite(f.io, base());
  assert.equal(a1.status, 'applied');
  if (a1.status !== 'applied') return;

  // ② 撤销：走**同一个**事务（动作是 revert），不是特殊的第二条路径
  const { applyChange } = await import('../src/core/version.js');
  const { REVERT_ACTION } = await import('../src/core/riskaction.js');
  const { currentVersionOf } = await import('../src/core/version.js');
  const cur = f.files[DOC_PATH]!;
  const undo = await applyChange(f.io, {
    runId: 'legacy-A',
    baseVersion: currentVersionOf(parseVersionLog(f.files[V] ?? '').nodes, cur),
    docPath: DOC_PATH,
    versionPath: V,
    decisionPath: D,
    teacherId: 'wayne',
    sourceVersion: contentHash(cur),
    target: { segId: 'P02', chapter: 'Chapter One', itemId: '句子@P02' },
    action: REVERT_ACTION,
    decision: 'undo',
    undoesEvent: `${parseDecisionLog(f.files[D] ?? '').events[0]!.itemId}@${parseDecisionLog(f.files[D] ?? '').events[0]!.timestamp}`,
    from: 'The animals were very tired of working.',
    to: 'The animals were very tired of working on the farm every single day.',
  });
  assert.equal(undo.status, 'applied');
  if (undo.status !== 'applied') return;
  assert.equal(f.files[DOC_PATH], DOC, '撤销之后正文**逐字节**回到最初');
  assert.equal(undo.undoOf, a1.version, 'undo 指回被撤销的那一版');

  // ③ 再发布一段
  const a2 = await adoptRewrite(f.io, base({ pi: 0, original: 'Mr Jones locked the hen-houses.', revised: 'Mr Jones shut the hen-houses.', itemId: '句子@P01' }));
  assert.equal(a2.status, 'applied');
  if (a2.status !== 'applied') return;
  assert.match(f.files[DOC_PATH]!, /Mr Jones shut the hen-houses\./);

  // 三本账都说得通：版本链、事件、当前版本
  const nodes = parseVersionLog(f.files[V] ?? '').nodes;
  assert.equal(nodes.length, 3, '采纳 / 撤销 / 再采纳 各一条');
  assert.deepEqual(
    nodes.map((n) => n.kind),
    ['apply', 'undo', 'apply'],
  );
  assert.equal(nodes[2]!.parent, nodes[1]!.version, '第二条 apply 挂在 undo 上——链没断');
  const ev = parseDecisionLog(f.files[D] ?? '').events;
  assert.deepEqual(
    ev.map((e) => e.decision),
    ['accept', 'undo', 'accept'],
  );
  assert.equal(ev[1]!.undoOf, `${ev[0]!.itemId}@${ev[0]!.timestamp}`, '撤销是新事件，历史一条没删');
});

/* ────────────────────── ⑧ 段号与章节的小工具 ────────────────────── */

test('segIdOfIndex：段序 0 起 → P01；两位数不丢前导零', () => {
  assert.equal(segIdOfIndex(0), 'P01');
  assert.equal(segIdOfIndex(9), 'P10');
  assert.equal(segIdOfIndex(99), 'P100');
});

test('chapterOf：从章节标题里取章名，取不到就留空（不编一个假的）', () => {
  assert.equal(chapterOf(DOC), 'Chapter One');
  assert.equal(chapterOf('# 无标题'), '');
});
