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
  buildLexiconSnapshot,
  contentHash,
  detectCollision,
  newManifest,
  recordStep,
  refOf,
  summarizeManifest,
  upsertArtifact,
  verifyLexiconSnapshot,
  verifyManifest,
  type LexiconSnapshotSource,
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
  const mk = (s: LexiconSnapshotSource[]) =>
    buildLexiconSnapshot({ sources: s, counts: { known: 1, pending: 0, proper: 0, dict: 0, kb: 0 }, known: ['x'] }).version;
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
  const ids = new Set([
    manifest().runId,
    manifest({ teacher: 'li' }).runId,
    manifest({ tiers: ['B'] }).runId,
    manifest({ version: 'v2' }).runId,
  ]);
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
  assert.deepEqual(m.inputs.map((i) => i.name), ['原文', '词库']);
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
  const kinds = r.problems.filter((p) => p.severity === 'blocked').map((p) => p.kind).sort();
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
  assert.equal(detectCollision(a, b, () => false), null);
  assert.match(detectCollision(a, manifest({ owner: { pid: 1, host: 'other' } }), () => false) ?? '', /多机并行/);
  assert.equal(detectCollision(a, manifest({ teacher: 'li', owner: { pid: 1, host: 'other' } }), () => false), null, '不同运行不该互相报警');
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
