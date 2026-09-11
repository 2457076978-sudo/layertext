#!/usr/bin/env node
/**
 * LayerText · 发布学生版
 *
 * 来源：《LayerText 工程优化总计划》「商业化产品边界」——
 *   「第一版应卖一个清晰的闭环：导入文本、选择层级、生成候选、教师快速审校、
 *     **发布学生版**、查看质量与变更记录。」
 *
 * 这一环此前**完全没有**：管线产出的那份 Markdown 是**教师的工作稿**
 * （带 `[P##]` 段标记、带内部制作说明、门禁未通过的段还留着占位注释），
 * 直接发给学生，学生看到的是"一段读得通的文字里夹着 [P07] 和一串来源说明"。
 *
 * 判定逻辑全在 `src/core/studentversion.ts`（有单测）；本脚本只负责读写盘与打印。
 * 路径一律经 `Resolver`——包括新增的 `学生版` 这一种产物。
 *
 * ── 最重要的一条 ────────────────────────────────────────────────────────
 * **发现占位段就拒绝发布**（退出码 1），并点明是第几段。
 * 占位段是"这一段没通过门禁、被隔离了"的记录；把它默默删掉，
 * 学生版会变成一个**读得通的段落序列**——而中间少了一整段这件事，
 * 在成品里长得跟"这一段本来就没有"一模一样。
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';

const SHARED = await import('./LayerText_AF词表与词典.mjs');
const { distOf, chapterNames } = SHARED;
const P = SHARED.loadProject();
const REPO = P.引擎目录;
const OUT_BASE = P.产物目录;
const DATE = P.日期;

const { studentVersionOf } = await import(`${distOf(REPO)}/src/core/studentversion.js`);
const { makeResolver } = await import(`${distOf(REPO)}/src/core/manifest.js`);
const { atomicWriteFileSync: writeAtomic } = await import(`${distOf(REPO)}/src/core/files.js`);

const CN = chapterNames(P);
const TAGS = { A: 'A层85', M: 'M层75', B: 'B层60' };
const TIER_INFO = { A: { label: 'A 层（挑战）' }, M: { label: 'M 层（中层）' }, B: { label: 'B 层（基础）' } };

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const has = (n) => argv.includes(n);

/* 身份与范围：与其它脚本同一套（命令行 > 清单 > 默认） */
const TEACHER = arg('--teacher', process.env.LAYERTEXT_TEACHER ?? process.env.USER ?? 'unknown');
const RUN = await SHARED.readRunIdentity({ out: OUT_BASE, work: P.调适工作区 }, { teacher: TEACHER, tier: arg('--tier', undefined) || undefined }, { runId: arg('--run', undefined) });
if (RUN.warning) console.warn(`\n⚠ ${RUN.warning}`);
const SCOPE = SHARED.scopeOf(P, { tier: arg('--tier', undefined), chapters: arg('--chapters', undefined), runId: RUN.runId });

const TIERS = SCOPE.tiers.map((t) => t.replace(/^([AMB])层.*$/, '$1')).filter((t) => TIER_INFO[t]);
const CH_IDS = SCOPE.chapters.length ? SCOPE.chapters : CN.map((_, i) => i + 1);
const SUFFIX = arg('--out', '') ? '_' + arg('--out') : '';
/** 学生版最上面那句标题。**不给就不放**——按产物第一行猜出来的十有八九是内部版本号。 */
const TITLE = arg('--title', undefined);
const DRY = has('--dry');

if (!TIERS.length) {
  console.error('✗ --tier 只能是 A / M / B 的组合');
  process.exit(2);
}

const R = (tag) => makeResolver(RUN.layout, { out: OUT_BASE, work: P.调适工作区 }, { runId: RUN.runId, tier: tag, date: DATE, suffix: SUFFIX });

console.log('════ AF 发布学生版 ════');
console.log(` 项目：${P._meta?.名称 ?? '（未命名）'}｜书：${P.书名}｜层：${TIERS.join('/')}｜章：${CH_IDS.join(',')}`);
console.log(` 路径布局：${RUN.layout}`);

let made = 0;
const refused = [];

for (const tier of TIERS) {
  const tag = TAGS[tier];
  for (const ci of CH_IDS) {
    const ch = CN[ci - 1];
    if (!ch) continue;
    const src = R(tag).any('正文', { chapter: ch });
    if (!existsSync(src)) {
      refused.push({ ch, tag, why: `没有这一层的正文产物（${src}）——学生版是**从教师工作稿减出来的**，没有工作稿就无从减起` });
      console.error(`\n✗ ${ch} ${tag}：没有正文产物（先去生成）`);
      continue;
    }
    const r = studentVersionOf(readFileSync(src, 'utf-8'), TITLE ? { title: `${TITLE}` } : {});
    const dst = R(tag).any('学生版', { chapter: ch });

    console.log(`\n ${ch} ${tag}：${r.summary}`);
    if (r.blockers.length) {
      /* **不许发**。把原因原样打出来，并且**不写文件**——
       * 写了就等于给出了一份"看起来能用的学生版"，而它中间缺了几段。 */
      for (const b of r.blockers) console.error(`   ✗ ${b}`);
      refused.push({ ch, tag, why: r.blockers.join('；') });
      continue;
    }
    if (DRY) {
      console.log(`   （--dry，未写文件）会写到 ${dst}`);
      continue;
    }
    mkdirSync(dst.replace(/\/[^/]*$/, ''), { recursive: true });
    writeAtomic(dst, r.text);
    made++;
    console.log(`   ✓ ${dst}`);
  }
}

console.log(`\n 生成 ${made} 份学生版${DRY ? '（--dry，未写盘）' : ''}｜拒绝 ${refused.length} 份`);
if (refused.length) {
  console.error('\n✗ 以下没有生成（原因逐条在上面）：');
  for (const r of refused) console.error(`   · ${r.ch} ${r.tag}：${r.why}`);
  process.exit(1);
}
if (made === 0 && !DRY) {
  console.error('✗ 一份都没生成——检查 --tier / --chapters 是否指到了没有产物的范围');
  process.exit(2);
}
