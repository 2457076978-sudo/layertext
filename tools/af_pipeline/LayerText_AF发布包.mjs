#!/usr/bin/env node
/**
 * LayerText · 发布包（导出 / 核对 / 溯源）
 *
 * 来源：《LayerText 工程优化总计划》阶段 3 ——
 *   「导入导出通过 manifest」·「学生数据仍只在本机工作区，**发布包默认不含画像、成绩和个人信息**」
 *   验收：「任意发布文件可查询『**由哪次运行、哪个模型、哪版词库生成，谁在何时做了哪条决定**』」
 *
 * 三个动作：
 *   `--export`（默认）  按清单把该出包的产物复制成一个目录 + 一份 `发布包_<runId>.json` 描述
 *   `--check <包目录>`  逐件核对收到的包（缺件 / 哈希不符 / 夹带学生数据）
 *   `--where <相对路径>` 查一份发布文件的出处与它之后的决定
 *
 * 判定逻辑全在 `src/core/bundle.ts`（有单测）；本脚本只负责读写盘与打印。
 * 路径一律经 `Resolver`，身份走共享的 `readRunIdentity` —— 与其它脚本同一条规则。
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const SHARED = await import('./LayerText_AF词表与词典.mjs');
const { distOf } = SHARED;
const P = SHARED.loadProject();
const REPO = P.引擎目录;
const OUT_BASE = P.产物目录;
const DATE = P.日期;

const { buildBundle, provenanceOf, publishReadiness, renderProvenance, verifyBundle, BUNDLE_SCHEMA_VERSION } = await import(`${distOf(REPO)}/src/core/bundle.js`);
const { artifactIdOf, fileSafe, makeResolver } = await import(`${distOf(REPO)}/src/core/manifest.js`);
const { teacherIdOf } = await import(`${distOf(REPO)}/src/core/teachers.js`);
const { parseDecisionLog } = await import(`${distOf(REPO)}/src/core/decision.js`);
const { parseCalibrationLog } = await import(`${distOf(REPO)}/src/core/calibration.js`);

/* 身份从命令行取（**不复用各脚本自己的参数助手**：定义位置各不相同） */
const argRun = (n, d) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : d;
};
const TEACHER = argRun('--teacher', process.env.LAYERTEXT_TEACHER ?? process.env.USER ?? 'unknown');
const RUN = await SHARED.readRunIdentity({ out: OUT_BASE, work: P.调适工作区 }, { teacher: TEACHER }, { runId: argRun('--run', undefined) });
if (RUN.warning) console.warn(`\n⚠ ${RUN.warning}`);

const R = makeResolver(RUN.layout, { out: OUT_BASE, work: P.调适工作区 }, { runId: RUN.runId, date: DATE });
const BUNDLE_ROOT = R.dir('汇总报告');

const readIf = (p) => (p && existsSync(p) ? readFileSync(p, 'utf-8') : null);

/** 这位教师在 `_运行/` 里有几份运行分片指针（`清单_<教师ID>_<层级>.json`）。
 *  "最近一次"来源放行前要数它：≥2 说明这位教师手上有多份运行，
 *  "最近一次"只是最后一次跑的，回答不了"这次要发布的是哪一次"。 */
function teacherRunShards(teacherId) {
  const dir = join(OUT_BASE, '_运行');
  if (!existsSync(dir)) return 0;
  const prefix = `清单_${fileSafe(teacherId)}_`;
  return readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.json')).length;
}

/** 读清单（没有清单就没法回答"哪次运行/哪个模型/哪版词库"，这是硬前提）。
 *
 * 事实源是**本次运行自己的那份** `清单_<runId>.json`——runId 已由 `readRunIdentity`
 * 按可信度解析（显式 `--run` > 教师+层级分片 > 教师对得上的"最近一次"）。
 * 全局 `清单_最新.json` 在这里**一份都不读**：它只是给人看的索引，并发时指向谁
 * 取决于谁后跑——拿它当发布事实源，会把 A 老师的清单打进 B 老师的发布包（第七轮 P0-②）。 */
function loadManifest() {
  if (RUN.source === '无清单（legacy）') {
    console.error('✗ 运行身份定不下来（无清单，或并发时全局指针指向了另一位教师）——发布必须指向确定的一次运行。');
    console.error('  补法：--run <runId> 显式指定；或先 `清单.mjs --new` 建立本次运行的清单。');
    process.exit(2);
  }
  if (RUN.source === '最近一次' && teacherRunShards(RUN.teacher) > 1) {
    console.error(`✗ 教师 ${RUN.teacher} 名下有多份运行，"最近一次"说不清这次要发的是哪一次——拒绝猜测。`);
    console.error('  补法：--run <runId> 显式指定。');
    process.exit(2);
  }
  const p = join(OUT_BASE, '_运行', `清单_${RUN.runId}.json`);
  const readJson = (t) => {
    if (!t) return null;
    try {
      return JSON.parse(t);
    } catch {
      return null; // 坏清单当没有——错误信息在下面统一说
    }
  };
  const m = readJson(readIf(p));
  if (!m || m.runId !== RUN.runId || teacherIdOf(String(m.teacher ?? '')) !== teacherIdOf(String(RUN.teacher))) {
    console.error(`✗ 本次运行的清单读不出来或对不上身份（${p}）：`);
    console.error(`   身份是 ${RUN.runId}（教师 ${RUN.teacher}），清单里是 ${m?.runId ?? '（无）'}（教师 ${m?.teacher ?? '（无）'}）——发布的事实源就是这份清单，对不上不发。`);
    console.error('  补法：--run <runId> 指到正确的运行，或 `清单.mjs --new` 重建清单。');
    process.exit(2);
  }
  return m;
}

/* ────────────────────── 导出 ────────────────────── */

/**
 * 把清单登记过的产物读进来（只读白名单里的那几类，**遍历本身也不碰学生数据目录**）。
 * 清单记的是相对产物目录的路径；`layout` 两种都成立。
 *
 * 顺带把**产物身份**带上：阶段 3 要 Artifact 有稳定 ID，而发布包正是身份最该出现的地方——
 * 收件人拿到的是一棵树，光看路径说不清"这一件是不是我以为的那一件"。
 * 清单里的 `id` 优先（`--stamp` 之后就有），没有就按 `种类/层级/章节` 算——同一个值。
 */
function collectFiles(manifest) {
  const out = [];
  const skipped = [];
  for (const a of manifest.artifacts ?? []) {
    const abs = join(OUT_BASE, a.path);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      skipped.push({ id: a.id || artifactIdOf(a), path: a.path, reason: '清单登记了但它不在盘上（可能已被清理）' });
      continue;
    }
    out.push({ path: a.path, id: a.id || artifactIdOf(a), kind: a.kind, tier: a.tier, chapter: a.chapter, derivedFrom: a.derivedFrom, text: readFileSync(abs, 'utf-8') });
  }
  return { files: out, skipped };
}

function doExport() {
  const m = loadManifest();
  /* 纪律第 4 条：「没有这些字段的产物**不可发布**」。
   * 先单独报一次，好让失败原因是"缺字段"而不是一句从 `buildBundle` 里抛出来的长话。 */
  const ready = publishReadiness(m);
  if (!ready.ok) {
    console.error('✗ 这次运行的清单缺发布必需的字段，**不可发布**：');
    for (const p of ready.problems) console.error(`   · ${p}`);
    console.error('  补法：用 `清单.mjs --new` 重建清单（它会锁定模型、提示词版本与词库快照）。');
    process.exit(2);
  }
  const { files, skipped } = collectFiles(m);
  /* 发布是不可逆的交付动作：缺一件就整个不发。一份"结构完整但缺件"的部分包，
   * 收件人只会核对包描述里有的那些件——少的件在他那边根本不出现，
   * 于是"缺件"看起来就像"完整"。要在写任何文件之前拦下（第七轮 P0-③）。 */
  if (skipped.length) {
    console.error(`✗ 清单登记的产物有 ${skipped.length} 件不在盘上——拒绝导出部分包：`);
    for (const s of skipped) console.error(`   ✗ ${s.path}｜产物 ${s.id}｜${s.reason}`);
    console.error('  补法：重跑产出该件的步骤，或 `清单.mjs --stamp` 刷新清单后再导出。');
    process.exit(1);
  }
  /* 决定记在**层**上：每一层的决定日志都读进来（只数条数），不是只有第一层。
   * 层键（`A`）由 `resolvePath` 归一成产物命名里的层级标签（`A层85`）——与写日志那侧同一口径。 */
  const events = [];
  for (const t of m.tiers ?? []) {
    const text = readIf(R.decision({ tier: t }));
    if (text) events.push(...parseDecisionLog(text).events);
  }
  /* 校准台账（`_运行/校准台账.jsonl`）是**另一本账**：风险队列上的决定在上面，这里记的是
     审校工作台上的词/句级人工校准。论文里"人工校准 N 条"数的是这一本——不读进来，
     发布包描述就答不了那个数，收件人只能自己去翻文件。台账缺失/坏行都不拦发布（如实说）。 */
  const calibrations = readCalibrations();
  /* partial 章（清单显式声明"还没写完"）的学生版**默认不发**：学生版是要交到学生手上的读物，
   * 半成品读物的危害不是"少一章"，而是学生读到一半没了、还以为书写完了。
   * 显式 --allow-partial 放行时，partial 章写进包描述——收件人必须看得见（第七轮 P2）。 */
  const partialSet = new Set(m.partialChapters ?? []);
  const chNumOf = (name) => SHARED.chapterNames(P).indexOf(String(name)) + 1;
  const partialStudents = partialSet.size ? files.filter((f) => f.kind === '学生版' && f.chapter && partialSet.has(chNumOf(f.chapter))) : [];
  if (partialStudents.length && !process.argv.includes('--allow-partial')) {
    console.error(`✗ 清单声明了 partial 章（未写完），其中 ${partialStudents.length} 份学生版默认拒绝发布：`);
    for (const f of partialStudents) console.error(`   ✗ ${f.path}｜${f.chapter} 还没写完`);
    console.error('  确认要发半成品：加 --allow-partial（partial 章会写进包描述，收件人可见）。');
    process.exit(2);
  }
  const bundle = buildBundle({ manifest: m, files, events, calibrations, ...(partialStudents.length ? { partialChapters: m.partialChapters } : {}) });

  /* 写包走 staging + 自检 + 原子替换：自检不过，最终目录一个字都不动；
   * 替换时旧目录整个让位——重复导出后目录内容严格等于本次清单，
   * 旧的多余文件不再混进 `--check` 的视野（第七轮 P1-④）。 */
  mkdirSync(BUNDLE_ROOT, { recursive: true });
  const dir = join(BUNDLE_ROOT, `发布包_${m.runId}`);
  const staging = join(BUNDLE_ROOT, `发布包_${m.runId}.staging-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    for (const e of bundle.entries) {
      const dst = join(staging, e.path);
      mkdirSync(dirname(dst), { recursive: true });
      cpSync(join(OUT_BASE, e.path), dst);
    }
    writeFileSync(join(staging, '发布包.json'), JSON.stringify(bundle, null, 2), 'utf-8');
    /* 自检：刚写进去的每一件读回来核对——连这关都过不了说明写盘环节出了问题，
     * 这种包绝不让它出现在最终目录里。 */
    const received = walk(staging).map((rel) => ({ path: rel, text: readFileSync(join(staging, rel), 'utf-8') }));
    const self = verifyBundle(bundle, received);
    if (!self.ok) {
      console.error('✗ 包在写盘自检中不过关（不该发生；请连同清单一起反馈）：');
      for (const p of self.problems) console.error(`   ✗ [${p.kind}] ${p.path}｜${p.message}`);
      rmSync(staging, { recursive: true, force: true });
      process.exit(1);
    }
    rmSync(dir, { recursive: true, force: true });
    renameSync(staging, dir);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  const descPath = join(dir, '发布包.json');

  console.log('════ AF 发布包 ════');
  console.log(` 运行：${bundle.run.runId}`);
  console.log(` 书：${bundle.run.book} ${bundle.run.version}｜层：${bundle.run.tiers.join('/')}｜章：${bundle.run.chapters.join(',')}`);
  console.log(` 模型：${bundle.model.name}（提示词 ${bundle.model.promptVersion}）｜词库：${bundle.lexicon.version}`);
  console.log(` 教师：${bundle.teacher}｜决定记录 ${bundle.decisionCount} 条（**只记条数，内容不随包出去**）`);
  console.log(` 入包 ${bundle.entries.length} 件（每件都带**产物身份**：路径只是它在包里的位置）：`);
  for (const e of bundle.entries) console.log(`   · ${e.kind}｜${e.path}｜${e.id ?? '（无身份）'}`);
  if (bundle.excluded.length) {
    console.log(` 排除 ${bundle.excluded.length} 件（**列出来，不静默丢弃**）：`);
    for (const x of bundle.excluded) console.log(`   ✗ ${x.path}｜${x.reason}`);
  } else {
    console.log(' 排除 0 件（本次产物里没有学生数据迹象）');
  }
  console.log(`\n✓ ${descPath}`);
  console.log('  收件人核对：node tools/af_pipeline/LayerText_AF发布包.mjs --check <解开的包目录>');
}

/* ────────────────────── 核对（导入侧） ────────────────────── */

function walk(dir, base = dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, base, acc);
    else if (name !== '发布包.json') acc.push(relative(base, p));
  }
  return acc;
}

function doCheck(dir) {
  const desc = readIf(join(dir, '发布包.json'));
  if (!desc) {
    console.error(`✗ ${dir} 里没有 发布包.json —— 没有它就无法核对"该有哪些、哈希是多少"`);
    process.exit(2);
  }
  const bundle = JSON.parse(desc);
  if (bundle.schemaVersion !== BUNDLE_SCHEMA_VERSION) {
    console.warn(`⚠ 包描述版本 ${bundle.schemaVersion}，本程序认的是 ${BUNDLE_SCHEMA_VERSION}——可能对不齐，请先核对再使用`);
  }
  const received = walk(dir).map((rel) => ({ path: rel, text: readFileSync(join(dir, rel), 'utf-8') }));
  const r = verifyBundle(bundle, received);

  console.log('════ 核对发布包 ════');
  console.log(` 运行：${bundle.run.runId}｜模型 ${bundle.model.name}｜词库 ${bundle.lexicon.version}｜教师 ${bundle.teacher}`);
  console.log(` 清单 ${bundle.entries.length} 件，核对通过 ${r.checked} 件`);
  if (r.ok) {
    console.log(' ✓ 该有的都在、内容与清单一致、没有夹带学生数据');
  } else {
    /* 报错要说清**缺的是哪一件产物**：路径只说明它在哪儿，身份才回答得了"这是什么东西"。
     * `artifactId` 由判定逻辑给（`verifyBundle`），这里只负责印出来。 */
    for (const p of r.problems) console.log(` ✗ [${p.kind}] ${p.path}｜${p.artifact ? `${p.artifact}（${p.id ?? '无身份'}）｜` : ''}${p.message}`);
  }
  if (bundle.excluded?.length) {
    console.log(` 发件方声明排除 ${bundle.excluded.length} 件：`);
    for (const x of bundle.excluded) console.log(`   · ${x.path}｜${x.reason}`);
  }
  process.exit(r.ok ? 0 : 1);
}

/* ────────────────────── 校准台账 ────────────────────── */

/**
 * 读 `_运行/校准台账.jsonl`（append-only 正本）。
 *
 * 读不到就说读不到（返回空表），**不拦发布**：台账是审计材料，缺了它发布包本身仍然完整，
 * 但"人工校准 N 条"这个数会少——所以缺的时候要印一行出来，而不是静默按 0 处理。
 */
function readCalibrations() {
  const abs = join(OUT_BASE, '_运行', '校准台账.jsonl');
  if (!existsSync(abs)) return [];
  const { events, bad } = parseCalibrationLog(readFileSync(abs, 'utf-8'));
  if (bad.length) console.warn(`⚠ 校准台账有 ${bad.length} 行读不动（首条：${bad[0].reason}）——按 0 之外的条数照实计，但请看一眼`);
  return events;
}

/* ────────────────────── 溯源 ────────────────────── */

function doWhere(target) {
  const m = loadManifest();
  const events = [];
  // 每一层的决定日志都看（决定是记在层上的）
  for (const tier of m.tiers ?? []) {
    const text = readIf(makeResolver(RUN.layout, { out: OUT_BASE, work: P.调适工作区 }, { runId: RUN.runId, tier }).decision());
    if (text) events.push(...parseDecisionLog(text).events);
  }
  const abs = join(OUT_BASE, target);
  const p = provenanceOf({
    path: target,
    currentText: existsSync(abs) ? readFileSync(abs, 'utf-8') : undefined,
    manifest: m,
    events,
    calibrations: readCalibrations(),
  });
  console.log('════ 溯源 ════');
  for (const line of renderProvenance(p)) console.log(line);
  process.exit(p.found ? 0 : 1);
}

const checkArg = argRun('--check', undefined);
const whereArg = argRun('--where', undefined);
if (checkArg) doCheck(checkArg);
else if (whereArg) doWhere(whereArg);
else doExport();
