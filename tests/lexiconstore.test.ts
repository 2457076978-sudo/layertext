/**
 * 词表数据正本（LexiconStore / LexiconData）回归测试
 *
 * 依据《LayerText工程优化总计划.md》阶段 3：
 *   「把词表和词典读取结果冻结为带哈希的 LexiconSnapshot，传入所有阶段。
 *     旧 CSV/JSON 只做一次导入，不再作为新的事实源。」
 *
 * 这份测试要证明的**不是**"新函数能跑"，而是四条会在旧代码上失败的性质：
 *   ① 正本里装着**数据**（已知词/待定词/专名/逐来源词表/词典/知识库），不是只有指纹；
 *   ② loader 读的是**正本里的数据**——把正本改成与 CSV 不同，读出来的就是正本那一份；
 *   ③ 正本与现场对不上时**拒绝开工**，不静默用旧正本，也不静默改读 CSV；
 *   ④ 没有正本的项目**一字不变**（legacy 路径 = 改造前的既有行为）。
 *
 * 而且刻意不留 happy path：手改过的正本、写了一半的正本、导入后又被改过的 CSV、
 * 路径被换掉的来源，逐条都要有断言。
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildLexiconStore,
  countsOfStore,
  decideLexiconSource,
  describeWordDiff,
  diffWordSets,
  lexiconStoreSelfCheck,
  parseLexiconStore,
  serializeLexiconStore,
  storeFileNameFor,
  storeVersionOf,
  verifyLexiconStore,
  REIMPORT_COMMAND,
  type LexiconStore,
  type LexiconStoreData,
} from '../src/core/lexiconstore.js';
import { buildLexiconSnapshot, refOf, type LexiconSnapshot, type LexiconSnapshotSource, type SourceRef } from '../src/core/manifest.js';

/* ────────────────────── 合成数据（纯逻辑部分用，不碰磁盘） ────────────────────── */

const DATA: LexiconStoreData = {
  known: ['barn', 'cat', 'dog', 'napoleon'],
  pending: ['cat'],
  proper: ['napoleon'],
  wordlists: { curriculum: ['cat', 'dog'], amendment: ['one'], textbook: [], vocab: ['cat', 'dog', 'a bit'], proper: ['napoleon'] },
  dict: [
    ['cat', '猫'],
    ['dog', '狗'],
  ],
  kb: [['napoleon', { zh: '拿破仑（猪）', n: 3 }]],
};

const src = (name: string, text: string, count = 10): LexiconSnapshotSource => ({ ...refOf(name, `/p/${name}`, text), count });
const SNAP_SOURCES = [src('词库', 'a,b\ncat,单词\n'), src('专名表', 'napoleon\n', 1)];
const SNAP_COUNTS: LexiconSnapshot['counts'] = { known: 3600, pending: 12, proper: 1, dict: 40, kb: 7 };
const INPUTS: SourceRef[] = [refOf('词库', '/p/词库.csv', 'a,b\ncat,单词\n'), refOf('专名表', '/p/专名表.txt', 'napoleon\n')];

const build = (over: Partial<LexiconStoreData> = {}, inputs: SourceRef[] = INPUTS): LexiconStore =>
  buildLexiconStore({
    data: { ...DATA, ...over },
    inputs,
    snapshotSources: SNAP_SOURCES,
    snapshotCounts: SNAP_COUNTS,
    createdAt: '2026-09-11T00:00:00.000Z',
  });

/* ────────────────── ① 材料化：正本里得真的有数据 ────────────────── */

test('正本是数据、不是指纹：已知词/待定词/专名/逐来源词表/词典/知识库都在里面', () => {
  const s = build();
  assert.equal(s.schemaVersion, 1);
  assert.equal(s.version.length, 16);
  assert.equal(s.createdAt, '2026-09-11T00:00:00.000Z');
  assert.deepEqual(s.data.known, DATA.known);
  assert.deepEqual(s.data.pending, DATA.pending);
  assert.deepEqual(s.data.proper, ['napoleon']);
  assert.deepEqual(s.data.dict, DATA.dict);
  assert.deepEqual(s.data.kb, DATA.kb);
  // 逐来源词表也在：没有它，loadKnownForms 的规则展开就得回去读 CSV
  assert.deepEqual(Object.keys(s.data.wordlists).sort(), ['amendment', 'curriculum', 'proper', 'textbook', 'vocab']);
  // 出来的 JSON 里必须能直接看到词——只有哈希与路径的那种东西**不是**正本
  const text = serializeLexiconStore(s);
  assert.match(text, /"cat"/);
  assert.match(text, /"猫"/);
  assert.match(text, /"a bit"/);
});

test('正本的条目数是"真有的条目数"，不是 CSV 行数', () => {
  const s = build();
  assert.deepEqual(s.counts, { known: 4, pending: 1, proper: 1, dict: 2, kb: 1 });
  assert.deepEqual(s.counts, countsOfStore(s.data));
});

test('正本版本只由**数据**决定：数据一样就一样，加一个词就变', () => {
  const a = build();
  const b = build();
  assert.equal(a.version, b.version, '同一份数据必须同版本（否则重导入会凭空造出一个新版本）');
  assert.equal(a.version, storeVersionOf(a.data));
  const c = build({ known: [...DATA.known, 'windmill'] });
  assert.notEqual(a.version, c.version, '数据变了版本必须变');
  // 出处不同但数据相同 → 仍是同一个数据版本（出处回答的是"从哪来"，不是"是什么"）
  const d = build({}, [refOf('词库', '/另一个/词库.csv', 'x')]);
  assert.equal(a.version, d.version);
  assert.notEqual(a.inputs[0]!.path, d.inputs[0]!.path);
});

test('正本记的快照版本与 LexiconSnapshot 同算法同结果（否则清单会天天报假漂移）', () => {
  const s = build();
  const expected = buildLexiconSnapshot({ sources: SNAP_SOURCES, counts: SNAP_COUNTS, known: [] }).version;
  assert.equal(s.snapshotVersion, expected);
  // 抽样指纹（known 参数）只影响快照自己的 sample，不该影响版本——两处算版本必须对得上
  const withKnown = buildLexiconSnapshot({ sources: SNAP_SOURCES, counts: SNAP_COUNTS, known: ['cat', 'dog', 'napoleon'] }).version;
  assert.equal(s.snapshotVersion, withKnown);
});

test('正本自检：手改过的正本 / 自相矛盾的正本都要被指出来', () => {
  assert.deepEqual(lexiconStoreSelfCheck(build()), []);
  // 手改：把已知词改掉但没动版本号
  const tampered: LexiconStore = JSON.parse(serializeLexiconStore(build()));
  tampered.data.known = [...tampered.data.known, '偷加的'];
  const problems = lexiconStoreSelfCheck(tampered);
  assert.equal(
    problems.some((p) => /版本号对不上/.test(p)),
    true,
    `实得 ${JSON.stringify(problems)}`,
  );
  // 待定词不在已知集里：按定义它必须计入已知
  const inconsistent = build({ known: ['cat'], pending: ['squealer'] });
  assert.equal(
    inconsistent.warnings.some((w) => /待定词不在已知词集里/.test(w)),
    true,
  );
  assert.equal(
    inconsistent.warnings.some((w) => /squealer/.test(w)),
    true,
  );
  // 出处里有同名来源：漂移检查会把两个文件当成一个
  const dupName = build({}, [refOf('词库', '/a', 'x'), refOf('词库', '/b', 'y')]);
  assert.equal(
    dupName.warnings.some((w) => /同名来源/.test(w)),
    true,
  );
});

/* ────────────────── 序列化：坏正本绝不许变成"空正本" ────────────────── */

test('读正本：坏文件返回错误，**绝不返回一个空词表**（空词表会让每个词都变生词）', () => {
  const good = serializeLexiconStore(build());
  const ok = parseLexiconStore(good);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual(ok.store.data, build().data);

  const truncated = good.slice(0, Math.floor(good.length / 2)); // 写了一半
  const r1 = parseLexiconStore(truncated);
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.match(r1.error, /不是合法 JSON|写了一半/);

  const noData = JSON.parse(good) as Record<string, unknown>;
  delete noData.data;
  const r2 = parseLexiconStore(JSON.stringify(noData));
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.match(r2.error, /没有 data 段/);

  const oldSchema = JSON.parse(good) as Record<string, unknown>;
  oldSchema.schemaVersion = 99;
  const r3 = parseLexiconStore(JSON.stringify(oldSchema));
  assert.equal(r3.ok, false);
  if (!r3.ok) assert.match(r3.error, /不是同一代/);
});

/* ────────────────── 漂移：说清是哪个来源、差哪些词 ────────────────── */

test('漂移：内容变了 / 路径被换 / 来源没了 / 多出来的来源，逐条指名道姓', () => {
  const s = build();
  assert.equal(verifyLexiconStore(s, INPUTS).ok, true);

  const changedText = verifyLexiconStore(s, [refOf('词库', '/p/词库.csv', 'a,b\ncat,单词\ndog,单词\n'), INPUTS[1]!]);
  assert.equal(changedText.ok, false);
  assert.deepEqual(changedText.changed, ['词库']);
  assert.match(changedText.drift[0]!, /来源「词库」内容变了/);

  const movedPath = verifyLexiconStore(s, [refOf('词库', '/别处/词库.csv', 'a,b\ncat,单词\n'), INPUTS[1]!]);
  assert.deepEqual(movedPath.changed, ['词库']);
  assert.match(movedPath.drift[0]!, /换成了另一个文件/);

  const gone = verifyLexiconStore(s, [INPUTS[0]!]);
  assert.deepEqual(gone.removed, ['专名表']);
  assert.match(gone.drift[0]!, /已经不在项目里了/);

  const extra = verifyLexiconStore(s, [...INPUTS, refOf('教材单元库', '/p/教材.json', '{}')]);
  assert.deepEqual(extra.added, ['教材单元库']);
  assert.match(extra.drift.join('；'), /新增来源「教材单元库」/);
});

test('逐词代价：说清"这些词会不会被加注"，而不是只报哈希不一致', () => {
  const d = diffWordSets(['cat', 'dog', 'napoleon'], ['cat', 'dog', 'windmill', 'squealer']);
  assert.equal(d.same, false);
  assert.deepEqual(d.onlyInStore, ['napoleon']);
  assert.deepEqual(d.onlyInLive, ['squealer', 'windmill']);
  assert.equal(d.storeSize, 3);
  assert.equal(d.liveSize, 4);
  const text = describeWordDiff(d);
  assert.match(text, /正本 3 个、现场 4 个/);
  assert.match(text, /不会被加注/);
  assert.match(text, /会被加注/);
  assert.match(text, /squealer/);

  const same = diffWordSets(['cat'], ['cat']);
  assert.equal(same.same, true);
  assert.deepEqual(same.onlyInStore, []);
  assert.match(describeWordDiff(same), /口径未变/);
});

/* ────────────────── 决策：读正本 / legacy / 拒绝 ────────────────── */

const decide = (over: Partial<Parameters<typeof decideLexiconSource>[0]>) => decideLexiconSource({ store: build(), live: INPUTS, storePath: '/proj/产物/_运行/LexiconData.json', ...over });

test('没有正本 → legacy（**这是向后兼容那一半**：从没导入过的项目行为一字不变）', () => {
  const d = decide({ store: null, live: null });
  assert.equal(d.mode, 'legacy');
  assert.equal(d.refusal, '', '没有正本不该拦任何人——教师已有的书就是这么用的');
  assert.match(d.notices.join(''), /没有词表正本/);
  assert.match(d.notices.join(''), /首次导入之前/);
});

test('有正本且与现场一致 → 读正本，并把"读到的是哪一版"说出来', () => {
  const d = decide({});
  assert.equal(d.mode, 'store');
  assert.equal(d.refusal, '');
  assert.equal(d.store?.version, build().version);
  assert.match(d.notices[0]!, /现场 CSV 与正本一致/);
  assert.match(d.notices[0]!, /已知 4 词/);
});

test('有正本但对不上 → 拒绝，并给出修法与后果（不许静默用旧正本、不许静默改读 CSV）', () => {
  const live = [refOf('词库', '/p/词库.csv', 'a,b\ncat,单词\ndog,单词\n'), INPUTS[1]!];
  const d = decide({ live });
  assert.equal(d.mode, 'drift');
  assert.match(d.refusal, /不采用/);
  assert.match(d.refusal, /来源「词库」内容变了/);
  assert.match(d.refusal, /--reimport/);
  assert.match(d.refusal, /LAYERTEXT_LEXICON=live/);
  assert.equal(d.refusal.includes(REIMPORT_COMMAND), true);
  assert.equal(d.drift?.ok, false);
});

test('有正本但没法比对现场 → 同样拒绝（"证明不了它还是当天那份"= 不能拿它开工）', () => {
  const d = decide({ live: null });
  assert.equal(d.mode, 'drift');
  assert.match(d.refusal, /无法把它与现场 CSV 比一遍/);
});

test('正本读不出来 → 拒绝，并且**明确说不会退回直读 CSV**', () => {
  const d = decide({ store: null, broken: '不是合法 JSON', live: INPUTS });
  assert.equal(d.mode, 'broken');
  assert.notEqual(d.mode, 'legacy');
  assert.match(d.refusal, /不会退回直读 CSV/);
  assert.match(d.refusal, /--reimport/);
  assert.match(d.notices.join(''), /读不出来/);
});

test('显式逃生门 LAYERTEXT_LEXICON=live：绕过正本，但把这件事喊出来', () => {
  const live = [refOf('词库', '/p/词库.csv', 'a,b\ncat,单词\ndog,单词\n'), INPUTS[1]!];
  const d = decide({ live, override: 'live' });
  assert.equal(d.mode, 'legacy');
  assert.equal(d.refusal, '', '人已经明说他要在漂移下按现场跑了，就不该再拦');
  assert.match(d.notices.join(''), /绕过词表正本/);
  assert.match(d.notices.join(''), /本次\*\*没有读它\*\*/);
  assert.equal(d.drift, null, '绕过时不计算漂移（也不许因此悄悄改正本）');
});

test('导入模式 reimport：允许漂移存在，但必须把差异原样说出来', () => {
  const live = [refOf('词库', '/p/词库.csv', 'a,b\ncat,单词\ndog,单词\n'), INPUTS[1]!];
  const d = decide({ live, override: 'reimport' });
  assert.equal(d.mode, 'reimport');
  assert.equal(d.refusal, '');
  assert.match(d.notices.join(''), /导入步骤/);
  assert.match(d.notices.join(''), /来源「词库」内容变了/);
  const clean = decide({ override: 'reimport' });
  assert.equal(clean.mode, 'reimport');
  assert.match(clean.notices[0]!, /现场与正本一致/);
});

test('文件名与命令是契约的一部分：归档名带版本，修法只有一条', () => {
  assert.equal(storeFileNameFor('abcdef0123456789'), 'LexiconData_abcdef0123456789.json');
  assert.match(REIMPORT_COMMAND, /LayerText_AF清单\.mjs --reimport$/);
});

/* ══════════════════ 真跑：把共享模块放到一个临时项目上 ══════════════════ */

/**
 * 上面全是纯逻辑。真正接线在 `tools/af_pipeline/LayerText_AF词表与词典.mjs`——
 * 15 个脚本调的就是它。这里用**临时项目 + 真的 CSV** 把那条线跑通：
 * 旧代码下这些断言会失败（它只会直读 CSV），所以它们不是 happy path。
 */
const REPO = fileURLToPath(new URL('../..', import.meta.url));
/** 我自己编译到哪个 outDir，就从这个 outDir 取引擎模块（**绝不碰共享的 dist/**） */
const OUT_DIR = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
process.env.LAYERTEXT_DIST = OUT_DIR;

const ROOT = mkdtempSync(join(tmpdir(), 'lt-lexiconstore-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const FILES = {
  vocab: join(ROOT, '词库.csv'),
  proper: join(ROOT, '专名.txt'),
  kb: join(ROOT, '知识库.csv'),
  dict: join(ROOT, '词典.csv'),
  out: join(ROOT, '产物'),
};
const VOCAB_HEAD = '词,类型,词性,释义\n';
const VOCAB_BODY = 'cat,课标词,n.,猫\ndog,单词,n.,狗\na bit,短语,phr.,有点儿\n';
const PROJECT = join(ROOT, '调适项目_测试书.json');

mkdirSync(FILES.out, { recursive: true });
writeFileSync(FILES.vocab, VOCAB_HEAD + VOCAB_BODY, 'utf-8');
writeFileSync(FILES.proper, '# 专名表\nnapoleon\nsquealer\n', 'utf-8');
writeFileSync(FILES.kb, '类型,词,值,来源数\n加注词,majestic,威严的,4\n', 'utf-8');
writeFileSync(FILES.dict, '词,释义,来源\ncat,猫,归一（多数票）\n', 'utf-8');
writeFileSync(
  PROJECT,
  JSON.stringify({
    书名: '测试书',
    版本: 'v1',
    工作区: ROOT,
    调适工作区: join(ROOT, '调适工作区'),
    原文目录: join(ROOT, '原文'),
    产物目录: FILES.out,
    词库: FILES.vocab,
    书级: { 专名表: FILES.proper, 知识库: FILES.kb, 词典: FILES.dict },
    引擎目录: REPO,
    日期: '2026-09-11',
  }),
  'utf-8',
);

interface StoreLike {
  version: string;
  snapshotVersion: string;
  createdAt: string;
  inputs: SourceRef[];
  counts: { known: number; pending: number; proper: number; dict: number; kb: number };
  data: LexiconStoreData;
  warnings: string[];
}
interface StoreStateLike {
  mode: string;
  store: StoreLike | null;
  drift: { ok: boolean; drift: string[]; added: string[]; changed: string[]; removed: string[] } | null;
  notices: string[];
  refusal: string;
}
interface TestProject {
  词库: string;
  专名表路径: string;
  知识库路径: string;
  词典路径: string;
  产物目录: string;
  PROPER: string[];
}
interface ImportResult {
  store: StoreLike;
  storePath: string;
  versionPath: string;
  previous: StoreLike | null;
  wordDiff: { onlyInLive: string[]; onlyInStore: string[]; same: boolean } | null;
  wordDiffText: string | null;
}
interface SharedModule {
  loadProject(path?: string): TestProject;
  loadLexicon(P: TestProject): Promise<{ known: Set<string>; pending: Set<string> }>;
  liveLexicon(P: TestProject): Promise<{ known: Set<string>; pending: Set<string> }>;
  loadDict(path: string): Map<string, string>;
  loadKbGloss(path: string): Map<string, { zh: string; n: number }>;
  loadProper(path: string): string[];
  loadKnownForms(P: TestProject): Set<string>;
  lexiconStoreState(P?: TestProject): StoreStateLike;
  importLexiconStore(P: TestProject, opts?: { snapshotSources?: LexiconSnapshotSource[]; snapshotCounts?: LexiconSnapshot['counts'] }): Promise<ImportResult>;
  projectSources(P: TestProject): { sources: LexiconSnapshotSource[]; counts: LexiconSnapshot['counts']; knownAll: string[] };
  recordLexiconDrift(P: TestProject, opts?: { state?: StoreStateLike }): Promise<{ path: string; payload: { wordDiff: { onlyInLive: string[] } | null } } | null>;
}

const SHARED = (await import(pathToFileURL(join(REPO, 'tools/af_pipeline/LayerText_AF词表与词典.mjs')).href)) as unknown as SharedModule;
const P = SHARED.loadProject(PROJECT);

/** 导入**之前**（legacy 路径）算出来的口径。导入之后要拿它逐词比：
 *  "只做一次导入"不许顺手改掉任何一个词的判定——这里是改造最容易被悄悄破坏的地方。 */
let legacyKnown: Set<string> | null = null;
let legacyForms: Set<string> | null = null;

const importStore = () => SHARED.importLexiconStore(P);
/** 写一份**与 CSV 不一致但出处一致**的正本：用它证明"loader 读的是正本里的数据，不是 CSV" */
const writeDoctoredStore = (patch: Partial<LexiconStoreData>): StoreLike => {
  const ps = SHARED.projectSources(P);
  const store = buildLexiconStore({
    data: { ...DATA, ...patch },
    inputs: SHARED.lexiconStoreState(P).store?.inputs ?? [],
    snapshotSources: ps.sources,
    snapshotCounts: ps.counts,
  });
  writeFileSync(join(FILES.out, '_运行', 'LexiconData.json'), serializeLexiconStore(store), 'utf-8');
  return store;
};
const storeFilePath = () => join(FILES.out, '_运行', 'LexiconData.json');

test('向后兼容：没有正本的项目照旧直读 CSV（改造前就是这么跑的）', async () => {
  const st = SHARED.lexiconStoreState(P);
  assert.equal(st.mode, 'legacy');
  assert.equal(st.refusal, '');
  const lex = await SHARED.loadLexicon(P);
  assert.equal(lex.known.has('cat'), true); // 来自词库 CSV
  assert.equal(lex.known.has('the'), true); // 来自内置课标表（旧口径本来就含它）
  assert.equal(lex.known.has('napoleon'), true); // 来自专名表
  assert.equal(lex.known.has('a bit'), false); // 短语不计入 known（buildLexicon 只收前三类）
  assert.equal(lex.known.has('zzzstoreword'), false);
  assert.deepEqual(SHARED.loadProper(FILES.proper), ['napoleon', 'squealer']);
  assert.equal(SHARED.loadDict(FILES.dict).get('cat'), '猫');
  assert.equal(SHARED.loadKbGloss(FILES.kb).get('majestic')?.zh, '威严的');
  legacyKnown = lex.known;
  legacyForms = SHARED.loadKnownForms(P);
});

test('导入：正本落盘，装的是数据本身（逐来源词表 + 词典 + 知识库 + 专名）', async () => {
  const r = await importStore();
  assert.equal(existsSync(r.storePath), true);
  assert.equal(existsSync(r.versionPath), true);
  assert.equal(r.versionPath, join(FILES.out, '_运行', storeFileNameFor(r.store.version)));
  assert.equal(r.previous, null, '第一次导入没有"上一份"');
  assert.deepEqual(r.store.data.proper, ['napoleon', 'squealer']);
  assert.deepEqual(r.store.data.dict, [['cat', '猫']]);
  assert.deepEqual(r.store.data.kb, [['majestic', { zh: '威严的', n: 4 }]]);
  assert.equal(r.store.data.known.includes('cat'), true);
  // 逐来源词表：短语在 vocab 里、但不在 known 里——两侧口径本来就不同，**不许在这里统一**
  assert.equal(r.store.data.wordlists.vocab.includes('a bit'), true);
  assert.equal(r.store.data.known.includes('a bit'), false);
  assert.equal(r.store.data.wordlists.curriculum.length > 100, true, '内置课标词表也要材料化，否则它变了没人知道');
  // 出处含内置资产与项目 CSV：这才是漂移检查的基准
  const expectedNames = ['专名表', '内置课标词表', '内置补录', '知识库', '词库', '词典'].sort();
  assert.deepEqual(r.store.inputs.map((i) => i.name).sort(), expectedNames);
  assert.deepEqual(r.store.warnings, []);
  assert.equal(SHARED.lexiconStoreState(P).mode, 'store');
  const lex = await SHARED.loadLexicon(P);
  assert.equal(lex.known.has('cat'), true);
  // ★ 导入**不许改变任何一个词的判定**：正本模式的 known 必须与导入前 legacy 算出来的逐词相同。
  //   这条断言会抓住"导入口径与判定口径悄悄分家"——那正是这次改造最危险的失败方式。
  assert.deepEqual([...lex.known].sort(), [...legacyKnown!].sort(), '导入前后「已知」必须逐词相同');
  assert.deepEqual([...lex.pending].sort(), [...(await SHARED.liveLexicon(P)).pending].sort());
  assert.deepEqual([...SHARED.loadKnownForms(P)].sort(), [...legacyForms!].sort(), '规则展开的基数也必须一模一样');
  assert.equal(lex.known.has('a bit'), false, '短语仍然不计入已知（口径没被顺手改掉）');
});

test('★ loader 读的是正本里的数据，不是 CSV（这就是"只做一次导入"的全部意义）', async () => {
  const known = SHARED.lexiconStoreState(P).store!.data.known.filter((w) => w !== 'cat');
  writeDoctoredStore({ known: [...known, 'zzzstoreword'], pending: [], dict: [...DATA.dict, ['zzzdict', '正本里的词']] });
  const st = SHARED.lexiconStoreState(P);
  assert.equal(st.mode, 'store', `正本自报的出处没变，就不该判漂移：${JSON.stringify(st.drift?.drift)}`);
  const lex = await SHARED.loadLexicon(P);
  assert.equal(lex.known.has('zzzstoreword'), true, '正本里有的词就得在判定口径里——旧代码读 CSV，这里必然失败');
  assert.equal(lex.known.has('cat'), false, '正本里没有的词就不该冒出来——旧代码从 CSV 里读到 cat');
  assert.equal(SHARED.loadDict(FILES.dict).get('zzzdict'), '正本里的词', '词典也必须来自正本');
  // 专名表同理：正本里是 napoleon，CSV 里是 napoleon + squealer，读出来的必须是正本那一份
  assert.deepEqual(SHARED.loadProper(FILES.proper), ['napoleon']);
});

test('手改过的正本 → 拒绝开工，而且**不许**悄悄退回直读 CSV', async () => {
  const bad = JSON.parse(readFileSync(storeFilePath(), 'utf-8')) as StoreLike;
  bad.data.known = [...bad.data.known, '手加的'];
  writeFileSync(storeFilePath(), JSON.stringify(bad, null, 2), 'utf-8');
  const st = SHARED.lexiconStoreState(P);
  assert.equal(st.mode, 'broken');
  assert.notEqual(st.mode, 'legacy', '正本坏了 ≠ 没有正本：退回直读 = 静默换口径');
  assert.match(st.refusal, /版本号对不上/);
  await assert.rejects(() => SHARED.loadLexicon(P), /不会退回直读 CSV/);
  assert.throws(() => SHARED.loadDict(FILES.dict), /不会退回直读 CSV/, '同步 loader 同样要拦');
});

test('导入后 CSV 又被改 → 拒绝，并把"差哪些词、会不会被加注"说清楚', async () => {
  await importStore(); // 先修回一份干净正本
  writeFileSync(FILES.vocab, VOCAB_HEAD + VOCAB_BODY + 'zzznew,单词,n.,新词（改词表的人加的）\n', 'utf-8');
  const st = SHARED.lexiconStoreState(P);
  assert.equal(st.mode, 'drift');
  assert.deepEqual(st.drift?.changed, ['词库']);
  // 旧代码在这里会**照旧成功**，拿新词表跑出与前几天口径不同的产物
  assert.equal((await SHARED.liveLexicon(P)).known.has('zzznew'), true, '现场确实变了——所以要拦');
  await assert.rejects(
    async () => SHARED.loadLexicon(P),
    (e: Error) => {
      assert.match(e.message, /词表正本与现场对不上/);
      assert.match(e.message, /来源「词库」内容变了/);
      assert.match(e.message, /不会被加注/); // 逐词代价
      assert.match(e.message, /zzznew/);
      assert.match(e.message, /--reimport/);
      return true;
    },
  );
  assert.throws(() => SHARED.loadKbGloss(FILES.kb), /不采用/);
  // 漂移要留痕：报告里能查到"那一天差的是哪些词"
  const rec = await SHARED.recordLexiconDrift(P);
  assert.ok(rec);
  assert.deepEqual(rec.payload.wordDiff?.onlyInLive, ['zzznew']);
  const onDisk = JSON.parse(readFileSync(join(FILES.out, '_运行', 'LexiconDrift.json'), 'utf-8')) as { mode: string; wordDiffNote: string };
  assert.equal(onDisk.mode, 'drift');
  assert.match(onDisk.wordDiffNote, /zzznew/);
});

test('逃生门 LAYERTEXT_LEXICON=live：按现场跑，正本一个字节都不许动', async () => {
  const before = readFileSync(storeFilePath(), 'utf-8');
  process.env.LAYERTEXT_LEXICON = 'live';
  try {
    const st = SHARED.lexiconStoreState(P);
    assert.equal(st.mode, 'legacy');
    assert.match(st.notices.join(''), /绕过词表正本/);
    const lex = await SHARED.loadLexicon(P);
    assert.equal(lex.known.has('zzznew'), true, 'live 就是按现场 CSV 读');
  } finally {
    delete process.env.LAYERTEXT_LEXICON;
  }
  assert.equal(readFileSync(storeFilePath(), 'utf-8'), before, '绕过 ≠ 自动改正本：漂移必须继续看得见');
});

test('重新导入：把现场的改动收进新版本，逐词代价记在报告里，之后恢复读正本', async () => {
  const before = SHARED.lexiconStoreState(P).store!.version;
  process.env.LAYERTEXT_LEXICON = 'reimport';
  let r: ImportResult;
  try {
    r = await importStore();
  } finally {
    delete process.env.LAYERTEXT_LEXICON;
  }
  assert.notEqual(r.store.version, before, '数据变了，正本版本必须变');
  assert.equal(r.previous?.version, before);
  assert.deepEqual(r.wordDiff?.onlyInLive, ['zzznew']);
  assert.match(r.wordDiffText ?? '', /zzznew/);
  assert.equal(r.store.data.known.includes('zzznew'), true);
  assert.equal(SHARED.lexiconStoreState(P).mode, 'store');
  assert.equal((await SHARED.loadLexicon(P)).known.has('zzznew'), true);
});

test('已知词展开：正本里的逐来源词表撑起 loadKnownForms（不是回去读 CSV）', () => {
  const forms = SHARED.loadKnownForms(P);
  assert.equal(forms.has('cat'), true);
  assert.equal(forms.has('cats'), true, '规则展开仍然生效');
  assert.equal(forms.has('a bit'), true, '词组在 vocab 里，与改造前一致');
  assert.equal(forms.has('zzzstoreword'), false);
});
