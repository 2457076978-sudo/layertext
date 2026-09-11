/**
 * 运行清单（manifest）+ 词表快照（LexiconSnapshot）回归测试
 *
 * 验收标准（《LayerText 项目审查报告（2026-09-11）》§三）：
 *   「只能重构一处，应先建『运行清单 + 事件日志』层，统一书籍/版本/层级/教师/运行 ID、
 *     输入哈希、词表版本、模型版本、产物状态。」
 *   「词表、专名表、词典在不同脚本各自读取，口径漂移会重演 Clover 事故；
 *     应生成一次带版本和哈希的 LexiconSnapshot，所有阶段只读它。」
 *   「第一个规模崩点会是文件命名约定与并发写入。」
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  artifactIdOf,
  artifactLabelOf,
  artifactsMissingId,
  buildLexiconSnapshot,
  contentHash,
  detectArtifactCollisions,
  detectCollision,
  makeResolver,
  newManifest,
  recordStep,
  refOf,
  resolvePath,
  summarizeManifest,
  upsertArtifact,
  verifyLexiconSnapshot,
  verifyManifest,
  withArtifactIds,
  type LexiconSnapshotSource,
  type RunArtifact,
  type RunManifest,
} from '../src/core/manifest.js';

const src = (name: string, text: string, count = 10): LexiconSnapshotSource => ({ ...refOf(name, `/p/${name}`, text), count });

const snapshot = () =>
  buildLexiconSnapshot({
    sources: [src('词库', 'a,b\ncat,单词\n'), src('专名表', 'napoleon\n', 1)],
    counts: { known: 3600, pending: 12, proper: 1, dict: 40, kb: 7 },
    known: ['cat', 'dog', 'napoleon', 'windmill', 'barn', 'boxer'],
    createdAt: '2026-09-11T00:00:00.000Z',
  });

const manifest = (over: Partial<Parameters<typeof newManifest>[0]> = {}): RunManifest =>
  newManifest({
    book: 'Animal Farm',
    version: 'v1',
    tiers: ['A', 'M'],
    chapters: [1, 2],
    teacher: 'wayne',
    model: { name: 'deepseek-chat', temperature: 0.3, promptVersion: 'session-v3-20260911' },
    lexicon: { version: snapshot().version, snapshotPath: '产物/_运行/LexiconSnapshot.json' },
    inputs: [refOf('原文', '/p/原文', 'chapter text'), refOf('词库', '/p/词库.csv', 'a,b\ncat,单词\n')],
    owner: { pid: 4242, host: 'mac' },
    createdAt: '2026-09-11T00:00:00.000Z',
    ...over,
  });

/* ────────────────── ① LexiconSnapshot ────────────────── */

test('词表快照：版本由全部来源的哈希与词数决定——换一个字节就换版本', () => {
  const a = snapshot();
  const b = buildLexiconSnapshot({
    sources: [src('词库', 'a,b\ncat,单词\ndog,单词\n'), src('专名表', 'napoleon\n', 1)],
    counts: { known: 3600, pending: 12, proper: 1, dict: 40, kb: 7 },
    known: ['cat'],
  });
  assert.notEqual(a.version, b.version, '词库内容变了，版本必须变');
  assert.equal(a.version.length, 16);
});

test('词表快照：来源顺序不影响版本（同一份词表怎么排都该同版本）', () => {
  const p = src('词库', 'x');
  const q = src('专名表', 'y', 1);
  const mk = (s: LexiconSnapshotSource[]) => buildLexiconSnapshot({ sources: s, counts: { known: 1, pending: 0, proper: 0, dict: 0, kb: 0 }, known: ['x'] }).version;
  assert.equal(mk([p, q]), mk([q, p]));
});

test('词表快照：抽样指纹可用来回答"是不是换了词表"', () => {
  const s = snapshot();
  assert.equal(s.sample.length > 0, true);
  assert.deepEqual([...s.sample].sort(), s.sample, '抽样应是排序后的，便于人眼比对');
  assert.equal(new Set(s.sample).size, s.sample.length);
});

test('词表快照：来源缺失/为空/词表空 → 告警而不是静默', () => {
  const s = buildLexiconSnapshot({
    sources: [src('词库', '', 0), { name: '词典', path: '', hash: '', bytes: 0, count: 0 }],
    counts: { known: 0, pending: 0, proper: 0, dict: 0, kb: 0 },
    known: [],
  });
  assert.equal(s.warnings.length >= 3, true, `应报出空文件/无路径/词集为空，实得 ${JSON.stringify(s.warnings)}`);
  assert.equal(s.sample.length, 0);
});

test('词表漂移：说清"哪个来源变了"，而不是笼统的哈希不一致', () => {
  const s = snapshot();
  assert.equal(verifyLexiconSnapshot(s, [src('词库', 'a,b\ncat,单词\n'), src('专名表', 'napoleon\n', 1)]).ok, true);
  const drift = verifyLexiconSnapshot(s, [src('词库', 'a,b\ncat,单词\ndog,单词\n'), src('专名表', 'napoleon\n', 1)]);
  assert.equal(drift.ok, false);
  assert.equal(drift.drift.length, 1);
  assert.match(drift.drift[0], /来源「词库」内容变了/);
});

/* ────────────────── ② RunManifest ────────────────── */

test('运行 ID：同样输入 = 同一个 ID（可复现）；换输入就换 ID', () => {
  const a = manifest();
  const b = manifest();
  assert.equal(a.runId, b.runId);
  const c = manifest({ inputs: [refOf('原文', '/p/原文', 'DIFFERENT'), refOf('词库', '/p/词库.csv', 'a,b\ncat,单词\n')] });
  assert.notEqual(a.runId, c.runId, '原文变了就是另一次运行');
  assert.match(a.runId, /^AnimalFarm-v1-AM-wayne-[0-9a-f]{16}$/);
});

test('运行 ID：不同教师/不同层/不同版本互不相同（一百名学生场景的前提）', () => {
  const ids = new Set([manifest().runId, manifest({ teacher: 'li' }).runId, manifest({ tiers: ['B'] }).runId, manifest({ version: 'v2' }).runId]);
  assert.equal(ids.size, 4);
});

test('清单身份信息齐备：报告点名的六项（书/版本/层/教师/运行 ID/词表版本）都在', () => {
  const m = manifest();
  assert.equal(m.book, 'Animal Farm');
  assert.equal(m.version, 'v1');
  assert.deepEqual(m.tiers, ['A', 'M']);
  assert.equal(m.teacher, 'wayne');
  assert.ok(m.runId);
  assert.equal(m.lexicon.version, snapshot().version);
  assert.equal(m.model.promptVersion, 'session-v3-20260911');
  assert.deepEqual(
    m.inputs.map((i) => i.name),
    ['原文', '词库'],
  );
});

test('产物登记：同路径覆盖而不是堆积', () => {
  let m = manifest();
  m = upsertArtifact(m, { path: '第一章/原文_A层85.md', kind: '正文', chapter: '第一章', status: 'ok', hash: 'aaa' });
  m = upsertArtifact(m, { path: '第一章/原文_A层85.md', kind: '正文', chapter: '第一章', status: 'needs-review', reason: 'SENT-01' });
  assert.equal(m.artifacts.length, 1);
  assert.equal(m.artifacts[0].status, 'needs-review');
  assert.equal(m.artifacts[0].reason, 'SENT-01');
});

test('校验：词表换了 → blocked（产物是旧词表跑出来的，不能当最新）', () => {
  const m = manifest();
  const r = verifyManifest(m, { exists: () => true, lexiconVersion: 'deadbeefdeadbeef' });
  assert.equal(r.ok, false);
  assert.equal(r.problems[0].kind, 'lexicon-drift');
  assert.equal(r.problems[0].severity, 'blocked');
  assert.match(r.problems[0].message, /本清单的产物是按旧词表跑出来的/);
});

test('校验：输入漂移 / 产物缺失 / 未过门禁 / 步骤失败 —— 全部 blocked', () => {
  let m = manifest();
  m.pendingReview = 3;
  m = upsertArtifact(m, { path: '第一章/原文_A层85.md', kind: '正文', status: 'needs-review', reason: 'LEN-01' });
  m = recordStep(m, { id: '生成', ok: false, sec: 12 });
  const r = verifyManifest(m, {
    exists: () => false,
    inputs: [refOf('原文', '/p/原文', 'CHANGED'), refOf('词库', '/p/词库.csv', 'a,b\ncat,单词\n')],
  });
  const kinds = r.problems
    .filter((p) => p.severity === 'blocked')
    .map((p) => p.kind)
    .sort();
  assert.deepEqual([...new Set(kinds)].sort(), ['artifact-missing', 'input-drift', 'needs-review', 'step-failed']);
  assert.equal(r.ok, false);
});

test('校验：产物在登记之后被改过 → blocked（清单说它是什么，它就得是什么）', () => {
  let m = manifest();
  m = upsertArtifact(m, { path: '第一章/原文_A层85.md', kind: '正文', status: 'ok', hash: 'aaaa' });
  const r = verifyManifest(m, { exists: () => true, hashOf: () => 'bbbb' });
  assert.equal(r.ok, false);
  assert.equal(r.problems[0].kind, 'artifact-stale');
});

test('校验：一致时 ok，且没有 blocked（门禁不能只会拦）', () => {
  let m = manifest();
  m = upsertArtifact(m, { path: '第一章/原文_A层85.md', kind: '正文', status: 'ok', hash: 'aaaa' });
  const r = verifyManifest(m, { exists: () => true, hashOf: () => 'aaaa', inputs: m.inputs, lexiconVersion: m.lexicon.version });
  assert.equal(r.ok, true);
  assert.deepEqual(r.problems, []);
});

test('并发写入探测：同一运行 ID 还有活进程 → 报警（报告 §三 第一个崩点）', () => {
  const a = manifest();
  const b = manifest();
  assert.match(detectCollision(a, b, () => true) ?? '', /还在跑/);
  assert.equal(
    detectCollision(a, b, () => false),
    null,
  );
  assert.match(detectCollision(a, manifest({ owner: { pid: 1, host: 'other' } }), () => false) ?? '', /多机并行/);
  assert.equal(
    detectCollision(a, manifest({ teacher: 'li', owner: { pid: 1, host: 'other' } }), () => false),
    null,
    '不同运行不该互相报警',
  );
});

test('空清单不许报绿：一件产物都没登记 = 这份校验证明不了任何事', () => {
  const m = manifest(); // 没登记任何 artifact
  const r = verifyManifest(m, { exists: () => true, lexiconVersion: m.lexicon.version });
  assert.equal(r.ok, false, '0 件产物却报"可以当作完成品"是最坏的一种假绿');
  assert.equal(
    r.problems.some((p) => p.kind === 'artifact-missing' && p.severity === 'blocked'),
    true,
  );
  assert.match(r.problems[0]!.message, /证明不了任何事/);
});

test('清单摘要：deliverable 是"能不能交付"的唯一答复', () => {
  let m = manifest();
  m = upsertArtifact(m, { path: 'a.md', kind: '正文', status: 'ok' });
  m = upsertArtifact(m, { path: 'b.md', kind: '台账', status: 'ok' });
  assert.equal(summarizeManifest(m).deliverable, true);
  m.pendingReview = 1;
  const s = summarizeManifest(m);
  assert.equal(s.deliverable, false);
  assert.equal(s.pendingReview, 1);
  assert.equal(s.artifactCount, 2);
  assert.deepEqual(s.byStatus, { ok: 2, 'needs-review': 0, missing: 0, stale: 0 });
});

test('contentHash：稳定、区分大小写与内容、长度固定（App 与 Node 共用同一口径）', () => {
  assert.equal(contentHash('abc'), contentHash('abc'));
  assert.notEqual(contentHash('abc'), contentHash('abd'));
  assert.notEqual(contentHash('abc'), contentHash('ABC'));
  assert.equal(contentHash(''), contentHash('').length === 16 ? contentHash('') : 'x');
  assert.equal(contentHash('任意中文内容').length, 16);
});

/* ────────────────── ③ 路径解析：所有脚本唯一的产物路径来源 ────────────────── */

const ROOTS = { out: '/proj/产物', work: '/proj/调适' };
const RID = 'AnimalFarm-v1-AM-wayne-8224fe855c4deff0';

test('legacy 布局逐字符复现既有命名（教师已有的书与下游脚本一个字都不用改）', () => {
  const r = makeResolver('legacy', ROOTS, { runId: RID, tier: 'A层85', date: '2026-09-10' });
  assert.equal(r.any('正文', { chapter: '第一章' }), '/proj/产物/第一章/原文_A层85_2026-09-10.md');
  assert.equal(r.session(), '/proj/调适/_会话/A层85.jsonl');
  assert.equal(r.session({ scope: 'segment', vocab: 'lite', suffix: '_exp1' }), '/proj/调适/_会话/A层85_segment_lite_exp1.jsonl');
  assert.equal(r.decision(), '/proj/调适/_决定/A层85.jsonl');
  assert.equal(r.any('完成标记'), '/proj/产物/_运行/A层85.完成.json');
  assert.equal(r.any('失败清单'), '/proj/产物/_运行/A层85.待复核.json');
  assert.equal(r.any('风险队列'), '/proj/产物/_运行/风险队列_A层85.json');
  assert.equal(r.any('待复核', { chapter: '第一章', segId: 'P07' }), '/proj/产物/_待复核/A层85/第一章_P07.md');
  assert.equal(r.any('台账'), '/proj/产物/台账_A层85_2026-09-10.md');
});

test('run 布局：每类产物收进运行私有目录，跨运行不可能撞名', () => {
  const r = makeResolver('run', ROOTS, { runId: RID, tier: 'A层85', date: '2026-09-10' });
  assert.equal(r.any('正文', { chapter: '第一章' }), `/proj/产物/_运行/${RID}/正文/第一章/原文_A层85_2026-09-10.md`);
  assert.equal(r.session(), `/proj/产物/_运行/${RID}/会话/A层85.jsonl`);
  assert.equal(r.decision(), `/proj/产物/_运行/${RID}/决定/A层85.jsonl`);
  assert.equal(r.any('词典增量'), `/proj/产物/_运行/${RID}/词典增量.json`);
  // 同一次运行的清单仍留在 _运行 根下（它是索引，不该藏在运行目录里）
  assert.equal(r.any('清单'), `/proj/产物/_运行/清单_${RID}.json`);
});

test('两种布局都不许出现"路径里带 undefined/…"这类半成品', () => {
  for (const layout of ['legacy', 'run'] as const) {
    const r = makeResolver(layout, ROOTS, { runId: RID, tier: 'A层85', date: '2026-09-10' });
    const kinds = ['正文', '会话日志', '待复核', '完成标记', '失败清单', '风险队列', '台账', '复核报告', '词典增量', '决定日志', '清单'] as const;
    for (const k of kinds) {
      const p = r.any(k, { chapter: '第一章', segId: 'P01' });
      assert.equal(p.includes('undefined'), false, `${layout}/${k} 出现 undefined：${p}`);
      assert.equal(p.includes('…'), false, `${layout}/${k} 出现占位省略号：${p}`);
      assert.equal(p.startsWith('/'), true, `${layout}/${k} 不是绝对路径：${p}`);
    }
  }
});

test('撞名探测：legacy 下两次运行必撞，run 下必不撞（报告 §三 第一个规模崩点）', () => {
  /* 这两条用例里的登记项**没有 kind/层级/章节**（只有路径），而那正是它们的身份来源：
   * 说不出自己是什么的登记项，身份就是它的路径——所以这两条测的是"路径撞不撞"。
   * 写全了字段的登记项按**逻辑身份**比，两次运行各写一份同一件产物**仍然会被报出来**
   * （那是"分叉"，不是"路径撞名"）——见下一节的「撞名探测按身份报」。 */
  const legacyA = [
    { path: '第一章/原文_A层85_2026-09-10.md', kind: '正文' as const, status: 'ok' as const },
    { path: '台账_A层85_2026-09-10.md', kind: '台账' as const, status: 'ok' as const },
  ];
  const legacy = detectArtifactCollisions([
    { runId: 'run-wayne', artifacts: legacyA },
    { runId: 'run-li', artifacts: legacyA },
  ]);
  assert.equal(legacy.ok, false);
  assert.equal(legacy.collisions.length, 2);
  assert.deepEqual(legacy.collisions[0]!.runs, ['run-li', 'run-wayne']);

  const r1 = makeResolver('run', ROOTS, { runId: 'run-wayne', tier: 'A层85', date: '2026-09-10' });
  const r2 = makeResolver('run', ROOTS, { runId: 'run-li', tier: 'A层85', date: '2026-09-10' });
  const run = detectArtifactCollisions([
    { runId: 'run-wayne', artifacts: [{ path: r1.any('正文', { chapter: '第一章' }) }, { path: r1.any('台账') }] },
    { runId: 'run-li', artifacts: [{ path: r2.any('正文', { chapter: '第一章' }) }, { path: r2.any('台账') }] },
  ]);
  assert.equal(run.ok, true, `run 布局不该撞名，实得 ${JSON.stringify(run.collisions)}`);
});

test('清单默认 legacy 布局（保守），可显式选 run', () => {
  assert.equal(manifest().layout, 'legacy');
  assert.equal(manifest({ layout: 'run' }).layout, 'run');
});

/* ────────────────── ④ 产物身份：一件产物"是什么"，与它放在哪儿无关 ────────────────── */
/*
 * 验收（《LayerText 工程优化总计划》阶段 3）：
 *   「Run/Artifact/Decision/Teacher 四类实体**有稳定 ID**」——Round 之前 Artifact 一直没有，
 *   它的身份就是它的路径（`path` 当主键）。
 *   「两位教师同时对同一本书不同层级运行不会覆盖词典、日志或产物」——按路径比，
 *   "两位教师各写一份同一件产物、路径还不一样"这件事永远比不出来。
 */

const art = (over: Partial<RunArtifact> & { path: string }): RunArtifact => ({ kind: '正文', status: 'ok', ...over });

test('★ 产物身份与路径无关：文件搬家、换布局之后仍是同一件产物', () => {
  const legacy = artifactIdOf(art({ path: '第一章/原文_A层85_2026-09-10.md', tier: 'A层85', chapter: '第一章' }));
  const moved = artifactIdOf(art({ path: `_运行/${RID}/正文/第一章/原文_A层85_2026-09-11.md`, tier: 'A层85', chapter: '第一章' }));
  assert.equal(legacy, moved, '同一件产物落到另一个路径，身份必须不变（这是"稳定 ID"的全部含义）');
  assert.match(legacy, /^art-[0-9a-f]{12}$/);
  // 种类/层级/章节三样，任何一样变了就是**另一件**产物
  assert.notEqual(legacy, artifactIdOf(art({ path: 'x.md', kind: '台账', tier: 'A层85', chapter: '第一章' })));
  assert.notEqual(legacy, artifactIdOf(art({ path: 'x.md', tier: 'M层75', chapter: '第一章' })));
  assert.notEqual(legacy, artifactIdOf(art({ path: 'x.md', tier: 'A层85', chapter: '第二章' })));
  assert.equal(artifactLabelOf(art({ path: 'x.md', tier: 'A层85', chapter: '第一章' })), '正文｜A层85｜第一章');
});

test('★ 身份**不是内容哈希**：改过内容的还是同一件产物（"被改过"由 hash 字段回答）', () => {
  const before = art({ path: '第一章/原文_A层85.md', tier: 'A层85', chapter: '第一章', hash: 'aaaa', bytes: 10 });
  const edited = art({ path: '第一章/原文_A层85.md', tier: 'A层85', chapter: '第一章', hash: 'bbbb', bytes: 12 });
  assert.equal(artifactIdOf(before), artifactIdOf(edited), '内容进了身份，教师改一次稿就等于换了一件产物——历史决定会全部变成孤儿');
});

test('★ 身份**不是随机 UUID**：它是算出来的，不需要任何注册表或持久状态', () => {
  // 两个互不相干的进程/清单（不同路径、不同时间）算同一件产物 → 同一个 ID
  const one = artifactIdOf(art({ path: '/A/第一章/原文_A层85.md', tier: 'A层85', chapter: '第一章' }));
  const two = artifactIdOf(art({ path: '/B/run/正文/第一章/原文_A层85_2026-09-11.md', tier: 'A层85', chapter: '第一章' }));
  assert.equal(one, two, '随机 UUID 只在"登记那一刻"唯一，两次运行各写一份会得到两个 ID，于是永远查不出它们是同一件');
});

test('说不出自己是什么的登记项：身份退化为路径；连路径都没有就**没有身份**（不凭空造一个）', () => {
  assert.equal(artifactIdOf({ path: 'a.md' }), 'art@a.md');
  assert.equal(artifactIdOf({ path: 'a.md', kind: '' }), 'art@a.md');
  assert.equal(artifactIdOf({ kind: '   ' }), '', '空种类不能当逻辑身份');
  assert.equal(artifactIdOf({}), '', '两条空登记项若都算成"空内容的哈希"，就会凭空撞名——报假警比不报更坏');
  assert.equal(artifactLabelOf({}), '（无身份）');
});

/* ── 撞名探测：按身份报 ── */

test('★ 撞名探测按身份报：两次运行把同一件产物写到两个不同路径，也必须报出来（旧口径只比路径，会漏）', () => {
  const one = art({ path: '第一章/原文_A层85_2026-09-10.md', tier: 'A层85', chapter: '第一章' });
  const two = art({ path: `_运行/run-li/正文/第一章/原文_A层85_2026-09-11.md`, tier: 'A层85', chapter: '第一章' });
  const r = detectArtifactCollisions([
    { runId: 'run-wayne', artifacts: [one] },
    { runId: 'run-li', artifacts: [two] },
  ]);
  assert.equal(r.ok, false, '两位教师各写一份"同一件产物"——这正是计划要拦的那件事，旧口径因为路径不同而一个字都不报');
  assert.equal(r.collisions.length, 1);
  const c = r.collisions[0]!;
  assert.equal(c.label, '正文｜A层85｜第一章');
  assert.equal(c.kind, '分叉');
  assert.deepEqual(c.runs, ['run-li', 'run-wayne']);
  assert.deepEqual(c.paths, [one.path, two.path].sort());
  assert.deepEqual(c.overwritten, [], '没有互相覆盖——是两份副本，不是谁盖掉了谁');
});

test('撞名分两种：同一路径 = 覆盖（真被盖掉），不同路径 = 分叉（两份副本，谁作数要人定）', () => {
  const ledger = art({ path: '台账_A层85.md', kind: '台账', tier: 'A层85' });
  const over = detectArtifactCollisions([
    { runId: 'run-a', artifacts: [ledger] },
    { runId: 'run-b', artifacts: [ledger] },
  ]);
  assert.equal(over.collisions.length, 1, `同一路径只报一次，不重复计数：${JSON.stringify(over.collisions)}`);
  assert.equal(over.collisions[0]!.kind, '覆盖');
  assert.deepEqual(over.collisions[0]!.overwritten, ['台账_A层85.md']);
  assert.equal(over.collisions[0]!.label, '台账｜A层85｜—', '没有章节的产物，标签里如实留空（不编一个章节名）');
});

test('★ 身份只在"认得出唯一一件"时才当身份：同一份清单里两件产物共用一个身份 → 退回路径，不凭粗身份误报', () => {
  const seg = (n: number) => art({ path: `_待复核/A层85/第一章_P0${n}.md`, kind: '其他', tier: 'A层85' });
  assert.equal(artifactIdOf(seg(1)), artifactIdOf(seg(2)), '真实例：某层若干条待复核段落都是"其他 + 该层 + 无章节"，逻辑身份一样——它描述不了它们');
  const vague = detectArtifactCollisions([
    { runId: 'run-a', artifacts: [seg(1), seg(2)] },
    { runId: 'run-b', artifacts: [seg(3)] },
  ]);
  assert.equal(vague.ok, true, `粗身份不许拿来报撞名（一次假警就会让这条检查从此被忽略）：${JSON.stringify(vague.collisions)}`);
  // 对照：同一件产物在两次运行里各只登记一次时，身份就是身份，该报就得报
  const doc = (p: string) => art({ path: p, tier: 'A层85', chapter: '第一章' });
  const real = detectArtifactCollisions([
    { runId: 'run-a', artifacts: [doc('a/第一章/原文_A层85.md')] },
    { runId: 'run-b', artifacts: [doc('b/第一章/原文_A层85.md')] },
  ]);
  assert.equal(real.ok, false);
  assert.equal(real.collisions[0]!.kind, '分叉');
});

test('★ 同一个路径被两次运行写过，**即便身份认不出来也要报**（旧口径唯一能报的那件事，一件都不能丢）', () => {
  const seg = (n: number) => art({ path: `_待复核/A层85/第一章_P0${n}.md`, kind: '其他', tier: 'A层85' });
  const r = detectArtifactCollisions([
    { runId: 'run-a', artifacts: [seg(1), seg(2)] }, // 同一份清单里身份重复 → 这两条退回路径
    { runId: 'run-b', artifacts: [seg(1)] }, // 另一份清单里它却是唯一的 → 按身份
  ]);
  assert.equal(r.ok, false, '两边的身份口径不一致时，纯路径那一半口径必须兜住——真被盖掉的事不能漏');
  assert.equal(r.collisions.length, 1);
  assert.equal(r.collisions[0]!.kind, '覆盖');
  assert.deepEqual(r.collisions[0]!.runs, ['run-a', 'run-b']);
});

/* ── 兼容与自愈：旧清单不需要迁移 ── */

test('★ 旧清单（登记项没有 id）照常校验、摘要、比对——身份是**算出来的**，不需要迁移脚本', () => {
  const old = manifest();
  // 这正是盘上那份真实清单的形状：`artifacts: [{path, kind, tier, status, hash, ...}]`，没有 id
  old.artifacts = [
    { path: '第一章/原文_A层85.md', kind: '正文', tier: 'A层85', chapter: '第一章', status: 'ok', hash: 'aaaa' },
    { path: '台账_A层85.md', kind: '台账', tier: 'A层85', status: 'ok', hash: 'bbbb' },
  ];
  const r = verifyManifest(old, {
    exists: () => true,
    hashOf: (p) => (p.startsWith('第一章') ? 'aaaa' : 'bbbb'),
    inputs: old.inputs,
    lexiconVersion: old.lexicon.version,
  });
  assert.equal(r.ok, true, `旧清单照常校验：${JSON.stringify(r.problems)}`);
  assert.equal(summarizeManifest(old).artifactCount, 2);
  const collide = detectArtifactCollisions([
    { runId: 'run-a', artifacts: old.artifacts },
    { runId: 'run-b', artifacts: old.artifacts },
  ]);
  assert.equal(collide.ok, false, '旧形状的登记项也要能测出撞名');
  assert.equal(collide.collisions[0]!.id.startsWith('art-'), true, '两个运行写的是同一件逻辑产物（不是"两条路径恰好同名"）');
  // 盘上还没有身份，但读取时算得出来——这正是"不需要迁移"的证据
  assert.deepEqual(
    artifactsMissingId(old).map((a) => a.path),
    ['第一章/原文_A层85.md', '台账_A层85.md'],
  );
});

test('★ 自愈：--stamp 走一遍就把身份补进旧清单，且**只加 id 这一个字段**、可反复走', () => {
  const old = manifest();
  old.artifacts = [art({ path: '第一章/原文_A层85.md', tier: 'A层85', chapter: '第一章', hash: 'aaaa' })];
  const before = JSON.parse(JSON.stringify(old.artifacts[0])) as RunArtifact;

  withArtifactIds(old);
  assert.equal(old.artifacts[0]!.id, artifactIdOf(old.artifacts[0]!), '补上去的身份就是算出来的那个（不是新生成的另一个）');
  assert.deepEqual(artifactsMissingId(old), []);
  const keys = Object.keys(old.artifacts[0]!).sort();
  assert.deepEqual(keys, [...Object.keys(before).sort(), 'id'].sort(), `自愈只许加 id 一个字段，实得多出来的：${keys.join('/')}`);
  for (const k of Object.keys(before)) assert.deepEqual((old.artifacts[0] as unknown as Record<string, unknown>)[k], (before as unknown as Record<string, unknown>)[k]);

  const once = JSON.stringify(old);
  withArtifactIds(old);
  assert.equal(JSON.stringify(old), once, '幂等：再走一遍一个字都不变（身份是算出来的，不是每次新发一个）');

  // --stamp 的入口（upsertArtifact）自己也会补：新登记的产物一落地就带身份
  const fresh = manifest();
  upsertArtifact(fresh, art({ path: '第一章/原文_A层85.md', tier: 'A层85', chapter: '第一章' }));
  assert.match(fresh.artifacts[0]!.id ?? '', /^art-[0-9a-f]{12}$/);
});

/* ────────────────── run 布局：后缀必须参与落点 ────────────────── */

test('★ run 布局下 `待复核` 必须认后缀——否则"试跑"与"正式"会写进同一个文件', () => {
  /* 这是一个**实际存在过**的缺陷，由迁移工具的作者发现并报了回来：
   * legacy 用子目录把试跑与正式分开（`_待复核/A层85_试跑/` 与 `_待复核/A层85/`），
   * 而 run 布局的分支把 `suffix` 丢了。
   *
   * 为什么危险：runId 由"书+版本+层+教师+输入哈希"决定，所以
   * **输入相同 ⇒ runId 相同**——而"先 `--out 试跑` 跑一遍看看、再正式跑"正是最常见的用法，
   * 两次运行落在同一个运行私有目录里，待复核段落**必然撞同一个路径**，后一次覆盖前一次。
   * 待复核目录装的是"门禁没过、被隔离出来"的段落——**那是那次失败唯一的记录**。
   * 被覆盖之后，教师看到的是"这次没有段落被隔离"，而实际上有。 */
  const roots = { out: '/OUT', work: '/WORK' };
  const at = (layout: 'legacy' | 'run', suffix: string): string => resolvePath(layout, roots, 'rid', { kind: '待复核', tier: 'A层85', suffix, chapter: '第一章', segId: 'P07' });

  assert.notEqual(at('run', ''), at('run', '_试跑'), '**同一次运行的两个后缀不能落到同一个文件**');
  assert.equal(at('run', '_试跑').includes('待复核_试跑'), true, `后缀要出现在落点里，实得 ${at('run', '_试跑')}`);
  // 不带后缀时与从前逐字符相同（改这个不许动已有项目的落点）
  assert.equal(at('run', ''), '/OUT/_运行/rid/待复核/第一章_P07.md');
  // 两种布局的**语义**要一致：都按后缀分空间，只是目录不同
  assert.equal(at('legacy', '').includes('_待复核/A层85/'), true);
  assert.equal(at('legacy', '_试跑').includes('_待复核/A层85_试跑/'), true);

  // json 扩展名同样要认后缀（同一段的记录与副本是一对）
  const j = resolvePath('run', roots, 'rid', { kind: '待复核', tier: 'A层85', suffix: '_试跑', chapter: '第一章', segId: 'P07', ext: 'json' });
  assert.equal(j.endsWith('待复核_试跑/第一章_P07.json'), true, `实得 ${j}`);
});
