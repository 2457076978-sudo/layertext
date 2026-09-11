#!/usr/bin/env node
/** AF 运行清单（manifest）+ 词表快照 —— 静默错配的探测网
 *
 * 审查报告 §三：「只能重构一处，应先建『运行清单 + 事件日志』层，统一书籍/版本/层级/教师/
 * 运行 ID、输入哈希、词表版本、模型版本、产物状态……这样优先解决静默错配和复现问题。」
 *
 * 它防的是什么（都是"照常报告成功"的错）：
 *   · 词表/专名表/词典被换过，产物还是旧的 → 判定口径已经不同，但没人知道；
 *   · 第二本书、第二位教师、同一书多层并行 → 输出路径互相覆盖；
 *   · 上一轮的完成标记还在，这一轮其实没跑完；
 *   · 论文里的数字说不清"哪版词表、哪版提示词、哪版模型跑出来的"。
 *
 * 用法：
 *   node LayerText_AF清单.mjs --new --tier A --teacher wayne     # 建清单（含词表快照）
 *   node LayerText_AF清单.mjs --stamp --tier A --step 生成 --sec 12.3 --ok 1
 *   node LayerText_AF清单.mjs --verify --tier A                  # 校验；有硬问题非零退出
 *   node LayerText_AF清单.mjs                                   # 只打印当前清单摘要
 *
 * 产物（都在 产物目录/_运行/ 下）：
 *   LexiconSnapshot_<版本>.json   词表快照（带版本与哈希，**所有阶段只读它**）
 *   LexiconSnapshot.json          指向当前版本的指针
 *   清单_<runId>.json             运行清单
 *   清单_最新.json                指向当前清单的指针
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

const SHARED = await import('./LayerText_AF词表与词典.mjs');
const P = SHARED.loadProject();
const REPO = P.引擎目录;
const OUT_BASE = P.产物目录;
const SRC_BASE = P.原文目录;
const DATE = P.日期;
const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
/* 层级标签与指针命名都从引擎取——**不在脚本里再抄一份**（抄一份就会有一天改漏） */

const M = await import(`${REPO}/dist/src/core/manifest.js`);
const { buildLexiconSnapshot, refOf, newManifest, upsertArtifact, recordStep, verifyManifest, summarizeManifest, detectCollision, contentHash, verifyLexiconSnapshot, makeResolver, detectArtifactCollisions, pointerNameOf, TIER_TAG: TAGS } = M;

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);
const TIERS = (arg('--tier', 'A')).split(',').map((s) => s.trim().toUpperCase()).filter((t) => TAGS[t]);
const CH_IDS = arg('--chapters', '')
  ? arg('--chapters').split(',').map((x) => Number(x.trim())).filter((n) => n >= 1 && n <= 10)
  : CN.slice(0, Number(P.章数 ?? 10)).map((_, i) => i + 1);
const TEACHER = arg('--teacher', process.env.LAYERTEXT_TEACHER ?? process.env.USER ?? 'unknown');
const RUN_DIR = join(OUT_BASE, '_运行');
const SNAP_POINTER = join(RUN_DIR, 'LexiconSnapshot.json');
/* 指针**按 (教师, 层级) 分片**，另加一份"最近一次"作索引。
 *
 * 原来只有一份全局的 `清单_最新.json`。两位教师同时跑同一本书的不同层级时，
 * 后跑者把先跑者的身份覆盖掉，先跑者的进程接着去读到**对方的 runId**，
 * 于是产物写进对方的运行私有目录、或去对方目录里找产物找不到——而两边都报成功。
 * `--layout run` 挡不住这个：它挡的是"路径撞名"，不是"身份被换掉"。
 * 分片之后每个 (教师, 层级) 有自己的指针，谁也覆盖不了谁；
 * `清单_最新.json` 退化为"给人看的最近一次"，不再是任何程序的事实源。 */
const pointerOf = (teacher, tier) => join(RUN_DIR, pointerNameOf({ teacher, tier }));
/** "最近一次"的索引。**它只是索引**：给人看的"最近跑过哪一次"，不是任何程序的事实源 */
const MANIFEST_POINTER = join(RUN_DIR, '清单_最新.json');

/** 路径布局：legacy（默认，沿用既有命名）｜run（产物收进 _运行/<runId>/，跨运行不会撞名）。
 *  报告 §三 说"只能重构一处，应先建清单层……都只能通过 manifest 解析路径"——
 *  这个开关就是那句"解析路径"的落点：改成 run 之后所有脚本自动跟着走。 */
const LAYOUT = arg('--layout', 'legacy');
if (!['legacy', 'run'].includes(LAYOUT)) { console.error(`✗ --layout 只能是 legacy / run`); process.exit(2); }
/** 本脚本自己的产物路径也走同一套解析（否则它就成了唯一的例外） */
const selfPaths = (runId) => makeResolver(LAYOUT, { out: OUT_BASE, work: P.调适工作区 }, { runId, tier: TAGS[TIERS[0]] ?? TIERS[0], date: DATE });


const readIf = (p) => (p && existsSync(p) ? readFileSync(p, 'utf-8') : null);

/** 本次运行的全部输入哈希：词表/专名/知识库/词典/底线/教材单元库 + 每一章原文。
 *  `--new` 与 `--verify` **必须用同一个函数**造这份清单，否则校验时会把
 *  "这次没传原文"误报成漂移（第一版就踩了这个坑）。 */
function buildInputs(sources) {
  return [
    ...sources,
    ...CH_IDS.map((ci) => {
      const ch = `第${CN[ci - 1]}章`;
      const p = join(SRC_BASE, ch, '原文_规范化.md');
      const text = readIf(p);
      return text === null ? null : refOf(`原文/${ch}`, p, text);
    }).filter(Boolean),
  ];
}

/* ────────────────────── 词表快照（唯一口径的来源） ────────────────────── */
function buildSnapshot() {
  const files = [
    ['词库', P.词库],
    ['专名表', P.专名表路径],
    ['知识库', P.知识库路径],
    ['词典', P.词典路径],
    ['情节底线', P.工作区 ? join(P.工作区, P.情节底线 ?? '调适工作区/规则与底线/全书情节底线_v0.1.md') : null],
    ['教材单元库', P.教材单元库],
  ];
  const sources = [];
  const counts = { known: 0, pending: 0, proper: 0, dict: 0, kb: 0 };
  const knownAll = [];
  for (const [name, path] of files) {
    const text = readIf(path);
    if (text === null) continue;
    const count = text.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).length;
    sources.push({ ...refOf(name, path, text), count });
    if (name === '词库') {
      counts.known = count;
      for (const l of text.split('\n').slice(1)) { const w = l.split(',')[0]?.trim(); if (w) knownAll.push(w); }
    }
    if (name === '专名表') counts.proper = count;
    if (name === '词典') counts.dict = count;
    if (name === '知识库') counts.kb = count;
  }
  return { snapshot: buildLexiconSnapshot({ sources, counts, known: knownAll }), sources };
}

function writeSnapshot(snap) {
  mkdirSync(RUN_DIR, { recursive: true });
  const p = join(RUN_DIR, `LexiconSnapshot_${snap.version}.json`);
  if (!existsSync(p)) writeFileSync(p, JSON.stringify(snap, null, 2), 'utf-8');
  writeFileSync(SNAP_POINTER, JSON.stringify(snap, null, 2), 'utf-8');
  return p;
}

/** 当前产物状态的扫描：产物的"能不能当完成品"只由完成标记决定，不看文件在不在 */
function scanArtifacts() {
  const out = [];
  for (const t of TIERS) {
    const tag = TAGS[t];
    const rrx = selfPaths(cur?.manifest?.runId ?? '');
    const donePath = rrx.any('完成标记', { tier: tag });
    const reviewPath = rrx.any('失败清单', { tier: tag });
    const done = readIf(donePath);
    const review = readIf(reviewPath);
    const status = done ? 'ok' : review ? 'needs-review' : 'stale';
    const reason = review ? (JSON.parse(review).待复核明细 ?? []).map((d) => (d.规则 ?? []).join('/')).slice(0, 3).join('；') : undefined;
    const rr = selfPaths(cur?.manifest?.runId ?? '');
    for (const ci of CH_IDS) {
      const ch = `第${CN[ci - 1]}章`;
      const abs = rr.any('正文', { chapter: ch, tier: tag, date: DATE });
      const rel = abs.replace(`${OUT_BASE}/`, '');
      if (!existsSync(abs)) continue;
      const text = readFileSync(abs, 'utf-8');
      out.push({ path: rel, kind: '正文', tier: t, chapter: ch, status, reason, hash: contentHash(text), bytes: text.length, updatedAt: new Date().toISOString() });
    }
    for (const [kind, name] of [['台账', `台账_${tag}_${DATE}.md`], ['风险队列', `风险队列_${tag}_${DATE}.md`]]) {
      const abs = join(OUT_BASE, name);
      if (!existsSync(abs)) continue;
      const text = readFileSync(abs, 'utf-8');
      out.push({ path: name, kind, tier: t, status: 'ok', hash: contentHash(text), bytes: text.length, updatedAt: new Date().toISOString() });
    }
    // 待复核的段落数：清单的"能不能交付"由它决定
    if (review) {
      const list = JSON.parse(review).待复核明细 ?? [];
      for (const d of list) {
        out.push({ path: join('_待复核', `${tag}`, `${d.位置.split(' ')[0]}_第${Number(d.位置.match(/第(\d+)段/)?.[1] ?? 0)}段.md`), kind: '其他', tier: t, status: 'needs-review', reason: (d.规则 ?? []).join('/'), updatedAt: new Date().toISOString() });
      }
    }
  }
  return out;
}

const pendingReviewOf = () => {
  let n = 0;
  for (const t of TIERS) {
    const r = readIf(selfPaths(cur?.manifest?.runId ?? '').any('失败清单', { tier: TAGS[t] }));
    if (r) n += (JSON.parse(r).待复核 ?? 0);
  }
  return n;
};

/* ────────────────────── 建清单 ────────────────────── */
if (has('--new')) {
  const { snapshot, sources } = buildSnapshot();
  const snapPath = writeSnapshot(snapshot);
  const inputs = buildInputs(sources);
  const m = newManifest({
    book: P.书名,
    version: arg('--version', P.版本 ?? 'v1'),
    tiers: TIERS,
    chapters: CH_IDS,
    teacher: TEACHER,
    model: { name: P.模型 ?? 'deepseek-chat', temperature: 0.3, promptVersion: arg('--prompt', 'session-v3-20260911') },
    lexicon: { version: snapshot.version, snapshotPath: snapPath, warnings: snapshot.warnings },
    inputs,
    owner: { pid: process.pid, host: hostname() },
    layout: LAYOUT,
  });
  const existingPath = join(RUN_DIR, `清单_${m.runId}.json`);
  const existing = readIf(existingPath);
  if (existing) {
    const warn = detectCollision(JSON.parse(existing), m, (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
    if (warn) console.warn(`\n⚠ ${warn}`);
  }
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(existingPath, JSON.stringify(m, null, 2), 'utf-8');
  /* 分片指针：**这次运行自己的**，并发跑谁也覆盖不了谁。
   * 层级取清单里记的那一层（同一次运行可以带多层，指针挂在第一层上——与命令行的 --tier 同序）。 */
  /* 指针的层级名用**标签**（`A层85`）而不是层键（`A`）——读的那一侧手里是标签。
   * 两边不统一，分片指针会写了却读不到，然后静默退回"最近一次"。 */
  const tierTags = m.tiers.map((t) => TAGS[t] ?? t);
  const pointer = JSON.stringify({ runId: m.runId, path: existingPath, teacher: m.teacher, tier: tierTags[0], layout: LAYOUT, updatedAt: new Date().toISOString() }, null, 2);
  // 每层各写一份，免得"跑 A 层的人"和"跑 M 层的人"抢同一份指针
  for (const t of tierTags) writeFileSync(pointerOf(m.teacher, t), pointer, 'utf-8');
  writeFileSync(MANIFEST_POINTER, pointer, 'utf-8');
  console.log('════ AF 运行清单 · 新建 ════');
  console.log(` 运行 ID：${m.runId}`);
  console.log(` 书名：${m.book}｜版本：${m.version}｜层：${m.tiers.join('/')}｜教师：${m.teacher}`);
  console.log(` 路径布局：${LAYOUT}${LAYOUT === 'legacy' ? '（沿用既有命名，教师已有工作流不受影响）' : '（产物收进 _运行/<运行 ID>/，跨运行不会互相覆盖）'}`);
  console.log(` 词表快照：${snapshot.version}（${snapshot.sources.length} 个来源）→ ${snapPath}`);
  if (snapshot.warnings.length) for (const w of snapshot.warnings) console.warn(` ⚠ ${w}`);
  console.log(` 输入哈希：${inputs.length} 项已锁定（词表/专名/知识库/词典/底线/原文）`);
  console.log(` ✓ ${existingPath}`);
  process.exit(0);
}

/* ────────────────────── 读当前清单 ────────────────────── */
function loadManifest() {
  const ptr = readIf(MANIFEST_POINTER);
  if (!ptr) return null;
  const { path } = JSON.parse(ptr);
  const t = readIf(path);
  return t ? { manifest: JSON.parse(t), path } : null;
}
function saveManifest(m, path) {
  writeFileSync(path, JSON.stringify(m, null, 2), 'utf-8');
}

const cur = loadManifest();
if (!cur) {
  console.error('✗ 还没有运行清单。先建：node LayerText_AF清单.mjs --new --tier A --teacher <你>');
  process.exit(2);
}

/* ────────────────────── 刷状态（每一步跑完调一次） ────────────────────── */
if (has('--stamp')) {
  const m = cur.manifest;
  for (const a of scanArtifacts()) upsertArtifact(m, a);
  m.pendingReview = pendingReviewOf();
  recordStep(m, { id: arg('--step', '（未命名）'), ok: arg('--ok', '1') !== '0', sec: Number(arg('--sec', '0')) || 0, note: arg('--note', undefined) });
  if (arg('--warning')) m.warnings.push({ kind: arg('--warning-kind', 'step'), message: arg('--warning'), at: new Date().toISOString() });
  saveManifest(m, cur.path);
  const s = summarizeManifest(m);
  console.log(`清单已更新：${m.runId}｜产物 ${s.artifactCount} 件｜待复核 ${s.pendingReview}｜步骤 ${m.steps.length}`);
  process.exit(0);
}

/* ────────────────────── 校验 ────────────────────── */
if (has('--verify')) {
  const m = cur.manifest;
  const { snapshot, sources } = buildSnapshot();
  const drift = verifyLexiconSnapshot(snapshot, sources);
  const r = verifyManifest(m, {
    inputs: buildInputs(sources),
    lexiconVersion: snapshot.version,
    exists: (rel) => existsSync(join(OUT_BASE, rel)),
    hashOf: (rel) => {
      const t = readIf(join(OUT_BASE, rel));
      return t === null ? '' : contentHash(t);
    },
  });
  // 快照本身也留档，便于事后比对
  writeSnapshot(snapshot);

  // 跨运行撞名探测（报告 §三："第二本书/第二位教师/同书多层并行会互相覆盖"）
  const siblings = [];
  if (existsSync(RUN_DIR)) {
    for (const f of readdirSync(RUN_DIR)) {
      if (!/^清单_.*\.json$/.test(f)) continue;
      const t = readIf(join(RUN_DIR, f));
      if (!t) continue;
      try { siblings.push(JSON.parse(t)); } catch { /* 坏清单跳过 */ }
    }
  }
  const collide = detectArtifactCollisions(siblings.map((x) => ({ runId: x.runId, artifacts: x.artifacts ?? [] })));

  console.log('════ AF 运行清单 · 校验 ════');
  console.log(` 运行 ID：${m.runId}｜书：${m.book} ${m.version}｜层：${m.tiers.join('/')}｜教师：${m.teacher}`);
  console.log(` 词表快照：清单 ${m.lexicon.version}｜当前 ${snapshot.version}${drift.ok ? '（一致）' : '（**已变**）'}`);
  console.log(` 路径布局：${m.layout ?? 'legacy'}｜已登记运行 ${siblings.length} 个${collide.ok ? '（无跨运行撞名）' : `（**${collide.collisions.length} 处撞名**）`}`);
  const blocked = r.problems.filter((p) => p.severity === 'blocked');
  const warns = r.problems.filter((p) => p.severity === 'warn');
  if (!blocked.length && !warns.length) {
    console.log(`\n✓ 清单一致：${m.artifacts.length} 件产物、输入哈希全部未变、无未完成段落。`);
    console.log('  这次运行可以当作完成品引用（论文里的数字可以标注本运行 ID）。');
    process.exit(0);
  }
  for (const c of collide.collisions.slice(0, 5)) {
    warns.push({ kind: 'artifact-collision', message: `产物被多次运行写过：${c.path}（${c.runs.join(' / ')}）——换 --layout run 可根治` });
  }
  for (const p of blocked) console.error(` ✗ [${p.kind}] ${p.message}`);
  for (const p of warns) console.warn(` ⚠ [${p.kind}] ${p.message}`);
  if (blocked.length) {
    console.error(`\n✗ ${blocked.length} 个硬问题：这份产物**不能当作完成品**。`);
    console.error('  最常见的解法：按原命令重跑（词表变过就必须重跑，否则新旧口径混在一本书里）。');
    process.exit(1);
  }
  console.log('\n⚠ 只有告警，没有硬问题。');
  process.exit(0);
}

/* ────────────────────── 摘要（默认） ────────────────────── */
const m = cur.manifest;
const s = summarizeManifest(m);
console.log('════ AF 运行清单 ════');
console.log(` 运行 ID：${m.runId}`);
console.log(` ${m.book}｜版本 ${m.version}｜层 ${m.tiers.join('/')}｜章 ${m.chapters.join(',')}｜教师 ${m.teacher}`);
console.log(` 模型 ${m.model.name}（温度 ${m.model.temperature}）｜提示词 ${m.model.promptVersion}`);
console.log(` 词表快照 ${m.lexicon.version}｜输入 ${m.inputs.length} 项｜产物 ${s.artifactCount} 件｜待复核 ${s.pendingReview} 段`);
console.log(` 步骤：${m.steps.map((x) => `${x.ok ? '✓' : '✗'}${x.id}`).join(' ') || '（还没跑）'}`);
console.log(s.deliverable ? ' ✓ 可交付' : ' ✗ 不可交付（有未完成段落或失败步骤）');
console.log(` 清单：${cur.path}`);
