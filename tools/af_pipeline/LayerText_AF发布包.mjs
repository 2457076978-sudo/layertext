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

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SHARED = await import('./LayerText_AF词表与词典.mjs');
const P = SHARED.loadProject();
const REPO = P.引擎目录;
const OUT_BASE = P.产物目录;
const DATE = P.日期;

const { buildBundle, provenanceOf, publishReadiness, renderProvenance, verifyBundle, BUNDLE_SCHEMA_VERSION } = await import(`${REPO}/dist/src/core/bundle.js`);
const { makeResolver } = await import(`${REPO}/dist/src/core/manifest.js`);
const { parseDecisionLog } = await import(`${REPO}/dist/src/core/decision.js`);

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

/** 读清单（没有清单就没法回答"哪次运行/哪个模型/哪版词库"，这是硬前提） */
function loadManifest() {
  const ptrText = readIf(join(OUT_BASE, '_运行', '清单_最新.json')) ?? readIf(join(OUT_BASE, '_运行', `清单_${RUN.runId}.json`));
  if (!ptrText) return null;
  try {
    const ptr = JSON.parse(ptrText);
    const p = ptr.path ?? join(OUT_BASE, '_运行', `清单_${RUN.runId}.json`);
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) : null;
  } catch {
    return null;
  }
}

/* ────────────────────── 导出 ────────────────────── */

/**
 * 把清单登记过的产物读进来（只读白名单里的那几类，**遍历本身也不碰学生数据目录**）。
 * 清单记的是相对产物目录的路径；`layout` 两种都成立。
 */
function collectFiles(manifest) {
  const out = [];
  const skipped = [];
  for (const a of manifest.artifacts ?? []) {
    const abs = join(OUT_BASE, a.path);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      skipped.push({ path: a.path, reason: '清单登记了但它不在盘上（可能已被清理）' });
      continue;
    }
    out.push({ path: a.path, kind: a.kind, tier: a.tier, chapter: a.chapter, text: readFileSync(abs, 'utf-8') });
  }
  return { files: out, skipped };
}

function doExport() {
  const m = loadManifest();
  if (!m) {
    console.error('✗ 还没有运行清单。发布包靠清单回答「哪次运行/哪个模型/哪版词库」，没有清单就不该发。');
    console.error('  先建清单：node tools/af_pipeline/LayerText_AF清单.mjs --new --tier A');
    process.exit(2);
  }
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
  const events = parseDecisionLog(readIf(R.decision({ tier: m.tiers?.[0] ?? '' })) ?? '').events;
  const bundle = buildBundle({ manifest: m, files, events });

  mkdirSync(BUNDLE_ROOT, { recursive: true });
  const dir = join(BUNDLE_ROOT, `发布包_${m.runId}`);
  if (existsSync(dir)) console.warn(`⚠ ${dir} 已存在，本次会覆盖同名文件（旧的多余文件不会被删）`);
  mkdirSync(dir, { recursive: true });
  for (const e of bundle.entries) cpSync(join(OUT_BASE, e.path), join(dir, e.path), { recursive: false });

  const descPath = join(dir, '发布包.json');
  writeFileSync(descPath, JSON.stringify(bundle, null, 2), 'utf-8');

  console.log('════ AF 发布包 ════');
  console.log(` 运行：${bundle.run.runId}`);
  console.log(` 书：${bundle.run.book} ${bundle.run.version}｜层：${bundle.run.tiers.join('/')}｜章：${bundle.run.chapters.join(',')}`);
  console.log(` 模型：${bundle.model.name}（提示词 ${bundle.model.promptVersion}）｜词库：${bundle.lexicon.version}`);
  console.log(` 教师：${bundle.teacher}｜决定记录 ${bundle.decisionCount} 条（**只记条数，内容不随包出去**）`);
  console.log(` 入包 ${bundle.entries.length} 件：`);
  for (const e of bundle.entries) console.log(`   · ${e.kind}｜${e.path}`);
  if (bundle.excluded.length) {
    console.log(` 排除 ${bundle.excluded.length} 件（**列出来，不静默丢弃**）：`);
    for (const x of bundle.excluded) console.log(`   ✗ ${x.path}｜${x.reason}`);
  } else {
    console.log(' 排除 0 件（本次产物里没有学生数据迹象）');
  }
  for (const s of skipped) console.log(`   ⚠ ${s.path}｜${s.reason}`);
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
    for (const p of r.problems) console.log(` ✗ [${p.kind}] ${p.path}｜${p.message}`);
  }
  if (bundle.excluded?.length) {
    console.log(` 发件方声明排除 ${bundle.excluded.length} 件：`);
    for (const x of bundle.excluded) console.log(`   · ${x.path}｜${x.reason}`);
  }
  process.exit(r.ok ? 0 : 1);
}

/* ────────────────────── 溯源 ────────────────────── */

function doWhere(target) {
  const m = loadManifest();
  const events = [];
  // 每一层的决定日志都看（决定是记在层上的）
  for (const tier of m?.tiers ?? []) {
    const text = readIf(makeResolver(RUN.layout, { out: OUT_BASE, work: P.调适工作区 }, { runId: RUN.runId, tier }).decision());
    if (text) events.push(...parseDecisionLog(text).events);
  }
  const abs = join(OUT_BASE, target);
  const p = provenanceOf({
    path: target,
    currentText: existsSync(abs) ? readFileSync(abs, 'utf-8') : undefined,
    manifest: m,
    events,
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
