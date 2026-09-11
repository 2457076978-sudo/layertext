/**
 * 发布包与溯源 · 测试
 *
 * 验收（《LayerText 工程优化总计划》阶段 3）：
 *   「导入导出通过 manifest」
 *   「学生数据仍只在本机工作区，**发布包默认不含画像、成绩和个人信息**」
 *   「任意发布文件可查询『**由哪次运行、哪个模型、哪版词库生成，谁在何时做了哪条决定**』」
 *
 * 这一组用例盯的是两件容易被写成"一句承诺"的事：
 *   ① "默认不含学生数据"——它只有在**排除项被列出来**的时候才是可验证的；
 *   ② "可查询出处"——查不到时必须**如实说查不到**，而不是给一个看起来像答案的东西。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildBundle,
  BUNDLE_SCHEMA_VERSION,
  decisionRow,
  provenanceOf,
  PUBLISHABLE_KINDS,
  publishReadiness,
  renderProvenance,
  studentDataReason,
  verifyBundle,
  type PublishBundle,
} from '../src/core/bundle.js';
import { makeDecisionEvent, type DecisionEvent } from '../src/core/decision.js';
import { contentHash, newManifest, refOf, type RunManifest } from '../src/core/manifest.js';

/* ────────────────────── 夹具 ────────────────────── */

const manifest = (over: Partial<RunManifest> = {}): RunManifest =>
  ({
    ...newManifest({
      book: 'Animal Farm',
      version: 'v1',
      tiers: ['A层85'],
      chapters: [1],
      teacher: 'wayne',
      model: { name: 'deepseek-chat', temperature: 0.3, promptVersion: 'session-v3-20260911' },
      lexicon: { version: '7f02a62f353e5085', snapshotPath: '/out/_运行/LexiconSnapshot_7f02a62f.json', warnings: [] },
      /* 一份**像样**的清单：发布那一关要求输入哈希与产物清单都在
       * （纪律第 4 条："没有这些字段的产物不可发布"）。
       * 夹具跟着真实清单走，否则测出来的只是一份现实中不存在的清单。 */
      inputs: [refOf('词库', '/x/词库.csv', '词,类型\nthe,单词\n')],
      owner: { pid: 1, host: 'test' },
      layout: 'run',
    }),
    ...over,
    artifacts: over.artifacts ?? [{ path: FILES[0]!.path, kind: '正文' as const, status: 'ok' as const }],
  }) as RunManifest;

const CH1 = '## Chapter One\n\n[P01] The boy ran to the red barn（谷仓）.\n';
const CH1_OLD = '## Chapter One\n\n[P01] The boy ran to the red barn and saw a small dog.\n';

const FILES = [
  { path: '_运行/r1/正文/第一章/原文_A层85_2026-09-11.md', kind: '正文' as const, tier: 'A层85', chapter: '第一章', text: CH1 },
  { path: '_运行/r1/台账_A层85_2026-09-11.md', kind: '台账' as const, tier: 'A层85', text: '# 台账\n' },
  { path: '_运行/r1/风险队列.json', kind: '风险队列' as const, text: '{"队列":[]}' },
];

const ev = (over: Partial<Parameters<typeof makeDecisionEvent>[0]> = {}): DecisionEvent =>
  makeDecisionEvent({
    itemId: '第一章#1:ANNO-01:barn',
    decision: 'accept',
    before: 'barn',
    after: 'barn（谷仓）',
    reason: '＋ 补上注释：barn → barn（谷仓）',
    ruleIds: ['ANNO-01'],
    teacherId: 'wayne',
    timestamp: '2026-09-11T10:00:00.000Z',
    sourceVersion: 'sha-1',
    chapter: '第一章',
    version: 'v0001-1a2b3c4d',
    ...over,
  });

/* ────────────────────── ① 学生数据红线 ────────────────────── */

test('★ 学生数据迹象：画像 / 成绩 / 分层 / 名单 / 电子表格都要认得出来', () => {
  for (const [p, keyword] of [
    ['分层_九3九4.json', '分层'],
    ['产物/班级画像_九3.json', '画像'],
    ['成绩分析_期中.xlsx', '成绩'],
    ['八下区统练_质量分析表.pdf', '统练'],
    ['学生名册.csv', '名册'],
    ['学习档案/个体画像.md', '个体画像'],
    ['某表.xls', '电子表格'],
  ]) {
    const why = studentDataReason(p);
    assert.ok(why, `「${p}」必须被认出来（关键词 ${keyword}）`);
  }
  assert.equal(studentDataReason('正文/第一章/原文_A层85.md'), null, '正常正文不该被误伤');
  assert.equal(studentDataReason('台账_A层85_2026-09-11.md'), null);
});

test('★ 白名单：没被明确允许的产物种类，一律不出包', () => {
  const b = buildBundle({
    manifest: manifest(),
    files: [...FILES, { path: '_运行/r1/会话/A层85.jsonl', kind: '会话日志' as never, text: '{"t":"msg"}' }, { path: '_运行/r1/待复核/第一章_P01.md', kind: '待复核' as never, text: '[P01] 没通过' }],
    now: '2026-09-11T12:00:00.000Z',
  });
  assert.equal(b.entries.length, FILES.length, '只收白名单里的三件');
  const reasons = b.excluded.map((e) => e.reason).join(' ');
  assert.match(reasons, /不在发布白名单里/);
});

/* ────────────────────── ② 排除项必须被列出来 ────────────────────── */

test('★ 发布包默认不含学生数据：被排除的每一件都写清原因（**不许静默丢弃**）', () => {
  const b = buildBundle({
    manifest: manifest(),
    files: [...FILES, { path: '分层_九3九4.json', kind: '其他' as const, text: '{"九3":["A","B"]}' }, { path: '成绩/期中_英语_九3.xlsx', kind: '其他' as const, text: '(二进制)' }],
    now: '2026-09-11T12:00:00.000Z',
  });
  assert.equal(b.entries.length, FILES.length);
  assert.equal(b.excluded.length, 2, '两件学生数据都要被列出来');
  assert.match(b.excluded[0]!.reason, /分层名单|学生数据只留在本机工作区/);
  assert.match(b.excluded[1]!.reason, /成绩数据/);
  // ★ 空数组也要在：**"什么都没排除"和"没做排除"是两件事**
  const clean = buildBundle({ manifest: manifest(), files: FILES });
  assert.deepEqual(clean.excluded, []);
});

test('包描述里带齐了「哪次运行 / 哪个模型 / 哪版词库 / 谁」', () => {
  const b = buildBundle({ manifest: manifest(), files: FILES, events: [ev()], versionNodes: 3, now: '2026-09-11T12:00:00.000Z' });
  assert.equal(b.schemaVersion, BUNDLE_SCHEMA_VERSION);
  assert.equal(b.run.runId, manifest().runId);
  assert.equal(b.run.book, 'Animal Farm');
  assert.equal(b.model.name, 'deepseek-chat');
  assert.equal(b.model.promptVersion, 'session-v3-20260911');
  assert.equal(b.lexicon.version, '7f02a62f353e5085');
  assert.equal(b.teacher, 'wayne');
  // 决定与版本只记**条数**：内容含教师 ID 与逐条操作，属审计材料，不随发布包出去
  assert.equal(b.decisionCount, 1);
  assert.equal(b.versionCount, 3);
});

/* ────────────────────── ③ 导入核对 ────────────────────── */

test('★ 导入核对：该有的都在、内容哈希对得上', () => {
  const b = buildBundle({ manifest: manifest(), files: FILES });
  const ok = verifyBundle(
    b,
    FILES.map((f) => ({ path: f.path, text: f.text })),
  );
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));
  assert.equal(ok.checked, 3);
});

test('★ 收到的包缺件 / 内容被动过 → 逐件报出来，不是"大概没问题"', () => {
  const b = buildBundle({ manifest: manifest(), files: FILES });
  const r = verifyBundle(b, [
    { path: FILES[0]!.path, text: '被人改过的正文' },
    { path: FILES[1]!.path, text: FILES[1]!.text },
  ]);
  assert.equal(r.ok, false);
  const kinds = r.problems.map((p) => p.kind).sort();
  assert.deepEqual(kinds, ['hash-mismatch', 'missing']);
  assert.match(r.problems.find((p) => p.kind === 'hash-mismatch')!.message, /内容与清单不符/);
});

test('★ 收到的包里**夹带了学生数据**（哪怕改了名字）也要认出来', () => {
  const b = buildBundle({ manifest: manifest(), files: FILES });
  const r = verifyBundle(b, [...FILES.map((f) => ({ path: f.path, text: f.text })), { path: '顺手带的_分层.json', text: '{"A":1}' }]);
  assert.equal(r.ok, false);
  const sd = r.problems.find((p) => p.kind === 'student-data');
  assert.ok(sd, `必须报出学生数据：${JSON.stringify(r.problems)}`);
  assert.match(sd.message, /不该出包/);
});

test('夹带了清单之外的普通文件 → 报 extra（清单过期或真的多带了）', () => {
  const b = buildBundle({ manifest: manifest(), files: FILES });
  const r = verifyBundle(b, [...FILES.map((f) => ({ path: f.path, text: f.text })), { path: '临时笔记.md', text: 'x' }]);
  assert.equal(r.ok, false);
  assert.equal(r.problems[0]!.kind, 'extra');
  assert.match(r.problems[0]!.message, /夹带或清单过期/);
});

/* ────────────────────── ④ 溯源 ────────────────────── */

test('★ 任意发布文件可查询「哪次运行、哪个模型、哪版词库、谁在何时做了哪条决定」', () => {
  const m = manifest();
  const b = buildBundle({ manifest: m, files: FILES, events: [ev()] });
  const p = provenanceOf({
    path: FILES[0]!.path,
    currentText: CH1,
    bundle: b,
    manifest: m,
    events: [ev(), ev({ timestamp: '2026-09-11T10:05:00.000Z', decision: 'undo', before: 'barn（谷仓）', after: 'barn', reason: '撤销 采纳' })],
    chapter: '第一章',
  });

  assert.equal(p.found, true);
  assert.equal(p.runId, m.runId);
  assert.equal(p.model, 'deepseek-chat');
  assert.equal(p.promptVersion, 'session-v3-20260911');
  assert.equal(p.lexiconVersion, '7f02a62f353e5085');
  assert.equal(p.teacher, 'wayne');
  assert.equal(p.hashMatches, true, '内容与清单登记的一致');
  assert.equal(p.decisions.length, 2);
  assert.deepEqual(
    p.decisions.map((d) => d.decision),
    ['采纳', '撤销'],
    '时间序',
  );
  assert.equal(p.decisions[1]!.undoOf === undefined, true);

  const line = p.line;
  for (const bit of [m.runId, 'deepseek-chat', 'session-v3-20260911', '7f02a62f353e5085', 'wayne', '2 条决定']) {
    assert.equal(line.includes(bit), true, `溯源行缺「${bit}」：${line}`);
  }
});

test('★ 内容已被改过 → 溯源如实标出来（不是默默说"一致"）', () => {
  const m = manifest();
  const b = buildBundle({ manifest: m, files: FILES });
  const p = provenanceOf({ path: FILES[0]!.path, currentText: CH1 + '多出来的一句。', bundle: b, manifest: m });
  assert.equal(p.hashMatches, false);
  assert.match(p.line, /内容已与清单不符/);
});

test('拿不到当前内容 → 说"未核对哈希"，**不说"对得上"**（后者是编的）', () => {
  const m = manifest();
  const b = buildBundle({ manifest: m, files: FILES });
  const p = provenanceOf({ path: FILES[0]!.path, bundle: b, manifest: m });
  assert.equal(p.hashMatches, false);
  assert.match(p.line, /未提供，未核对哈希/);
});

test('★ 查不到就**如实说查不到**，不编一个出处', () => {
  const p = provenanceOf({ path: '根本不存在的文件.md', manifest: manifest(), events: [], bundle: null });
  assert.equal(p.found, false);
  assert.match(p.line, /都查不到它/);
  assert.match(p.line, /不编一个出处/);
});

test('溯源只算与这份文件相关的决定（按章过滤），不是把全书决定都倒出来', () => {
  const m = manifest();
  const events = [ev(), ev({ itemId: '第二章#0:SENT-01:x', chapter: '第二章', decision: 'accept' })];
  const p = provenanceOf({ path: FILES[0]!.path, manifest: m, events, chapter: '第一章' });
  assert.equal(p.decisions.length, 1);
  assert.equal(p.decisions[0]!.ruleIds.includes('ANNO-01'), true);
});

test('★ "系统没做成"的留痕要标出来——它不是教师的判断', () => {
  const row = decisionRow(ev({ decision: 'rejected', reason: '稿件已经改过' }));
  assert.equal(row.decision, '执行失败（未改稿）');
  assert.equal(row.failed, true, 'failed 用来在报告里把它跟教师的决定分开');
  assert.equal(decisionRow(ev()).failed, false);

  const md = renderProvenance(provenanceOf({ path: FILES[0]!.path, manifest: manifest(), events: [ev({ decision: 'rejected' })], chapter: '第一章' })).join('\n');
  assert.match(md, /⚠ 执行失败（未改稿）/, '报告里要一眼看出这不是教师判的');
});

test('renderProvenance：无可查决定时只给一行结论，不给空表', () => {
  const m = manifest();
  const b = buildBundle({ manifest: m, files: FILES });
  const md = renderProvenance(provenanceOf({ path: FILES[0]!.path, bundle: b, manifest: m, events: [] }));
  assert.equal(md.length, 2);
  assert.match(md[0]!, /之后没有任何决定/);
});

/* ────────────────────── ⑤ 包描述与清单对得上 ────────────────────── */

test('包描述里的条数、版本与清单逐字段一致（两处口径不许漂移）', () => {
  const m = manifest();
  const b = buildBundle({ manifest: m, files: FILES, events: [ev(), ev({ itemId: 'x' })] });
  assert.deepEqual(b.run.tiers, m.tiers);
  assert.deepEqual(b.run.chapters, m.chapters);
  assert.deepEqual(b.model, m.model);
  assert.equal(b.lexicon.version, m.lexicon.version);
  assert.equal(b.run.createdAt, m.createdAt);
  assert.equal(b.decisionCount, 2);
});

test('条目哈希用的是内容哈希（与 manifest 的 contentHash 同一算法）', () => {
  const b = buildBundle({ manifest: manifest(), files: FILES });
  assert.equal(b.entries[0]!.hash, contentHash(CH1));
  assert.notEqual(b.entries[0]!.hash, contentHash(CH1_OLD));
  assert.equal(PUBLISHABLE_KINDS.includes('正文'), true);
});

/* ────────────────────── ⑥ 序列化往返 ────────────────────── */

test('包描述可 JSON 往返（它要能存盘、能随包走）', () => {
  const b = buildBundle({ manifest: manifest(), files: FILES, events: [ev()], now: '2026-09-11T12:00:00.000Z' });
  const round = JSON.parse(JSON.stringify(b)) as PublishBundle;
  assert.deepEqual(round, b);
  assert.equal(
    verifyBundle(
      round,
      FILES.map((f) => ({ path: f.path, text: f.text })),
    ).ok,
    true,
  );
});

/* ────────────────────── ⑦ 发布前的最后一关（纪律第 4 条） ────────────────────── */

test('★ 缺字段就**不可发布**：不是"发出去但留个空"，是直接不发', () => {
  const bad = manifest({ model: { name: '', temperature: 0.3, promptVersion: '' } });
  const ready = publishReadiness(bad);
  assert.equal(ready.ok, false);
  assert.equal(
    ready.problems.some((p) => /模型名/.test(p)),
    true,
    `要点名缺的是哪一样：${ready.problems.join('；')}`,
  );
  assert.equal(
    ready.problems.some((p) => /提示词版本/.test(p)),
    true,
  );
  assert.throws(() => buildBundle({ manifest: bad, files: FILES }), /不可发布/, '**抛**而不是打个标记继续——纪律说的是"不可发布"，不是"可以发布但标注一下"');
});

test('★ 词库版本缺失同样拦下（policy snapshot 是四样里最容易漏的那一样）', () => {
  const bad = manifest({ lexicon: { version: '', snapshotPath: '', warnings: [] } });
  const ready = publishReadiness(bad);
  assert.equal(ready.ok, false);
  assert.equal(
    ready.problems.some((p) => /词库版本/.test(p)),
    true,
  );
  assert.equal(
    ready.problems.some((p) => /policy snapshot/.test(p)),
    true,
    '要把"它就是 policy snapshot"写出来，免得读者以为只是个小字段',
  );
});

test('四样齐备的清单照常发布（这一关不该误伤正常流程）', () => {
  const ready = publishReadiness(manifest());
  assert.equal(ready.ok, true, ready.problems.join('；'));
  assert.doesNotThrow(() => buildBundle({ manifest: manifest(), files: FILES }));
});

test('★ 输入哈希为空也拦下：没有它，"同样的输入"这句话无法验证', () => {
  const bad = manifest({ inputs: [] });
  const ready = publishReadiness(bad);
  assert.equal(ready.ok, false);
  assert.equal(
    ready.problems.some((p) => /输入哈希/.test(p)),
    true,
  );
});

test('没有产物也拦下：不发布一个空包', () => {
  const bad = manifest({ artifacts: [] });
  assert.equal(
    publishReadiness(bad).problems.some((p) => /产物清单/.test(p)),
    true,
  );
});

test('★ 拒绝理由逐条可读（不是一句"缺少必需字段"就完了）', () => {
  const bare = manifest({ runId: '', teacher: '', model: { name: '', temperature: 0, promptVersion: '' }, lexicon: { version: '', snapshotPath: '', warnings: [] }, inputs: [], artifacts: [] });
  const ready = publishReadiness(bare);
  assert.equal(ready.problems.length >= 7, true, `七样都缺就该报七条，实得 ${ready.problems.length} 条`);
  for (const p of ready.problems) {
    assert.equal(p.length > 6, true, `每条都要说清缺什么、为什么重要：${p}`);
  }
});
