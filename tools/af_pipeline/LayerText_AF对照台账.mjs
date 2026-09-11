#!/usr/bin/env node
/** AF 三档重制·原文对照台账：逐句对齐（原样保留/改写/删减）+ 改写句词级变更 + 汇总
 * 用法：node LayerText_AF对照台账.mjs
 * 产物：重制三版/台账_{A层85|M层75|B层60}_2026-09-10.md × 3 + 台账总览
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const P = (await import('./LayerText_AF词表与词典.mjs')).loadProject();
const REPO = P.引擎目录;
const SRC_BASE = P.原文目录;
const OUT_BASE = P.产物目录;
const DATE = P.日期;
const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

const { splitChapter, extractParas, sentsOf } = await import(`${REPO}/dist/src/core/textpipe.js`);
const { alignSentencePairs } = await import(`${REPO}/dist/src/core/align.js`);
const { runQc } = await import(`${REPO}/dist/src/core/qc.js`);
const { loadLexicon, loadDict } = await import('./LayerText_AF词表与词典.mjs');
const LEX = await loadLexicon(P);
const DICT = loadDict(P.词典路径);

const wc = (t) => (t.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).length;
const toRefs = (md) => {
  try {
    return extractParas(splitChapter(md).body).flatMap((p, pi) => sentsOf(p, false).map((text, si) => ({ pi, si, text })));
  } catch {
    return [];
  }
};
const words = (t) => new Set((t.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []));
const notesOf = (md) => (md.match(/[A-Za-z][A-Za-z'-]*（[^（）]{1,20}）/g) ?? []);

function chapterLedger(tier, tag, i) {
  const ch = `第${CN[i - 1]}章`;
  const src = readFileSync(join(SRC_BASE, ch, '原文_规范化.md'), 'utf-8');
  const out = readFileSync(RR(tag).any('正文', { chapter: ch }), 'utf-8');
  const rows = alignSentencePairs(toRefs(src), toRefs(out));
  const kept = rows.filter((r) => r.kind === 'match' && !r.lostSignals?.length);
  const sigLost = rows.filter((r) => r.kind === 'match' && r.lostSignals?.length);
  const rewritten = rows.filter((r) => r.kind === 'match' && !r.lostSignals?.length && r.base && r.cur && r.base.text.trim() !== r.cur.text.trim());
  const lost = rows.filter((r) => r.kind === 'lost');
  const added = rows.filter((r) => r.kind === 'added');
  // 改写句词级变更（最多列 6 组/句）
  const rewrites = rewritten.slice(0, 400).map((r) => {
    const b = words(r.base.text);
    const c = words(r.cur.text);
    const removed = [...b].filter((w) => !c.has(w));
    const addedW = [...c].filter((w) => !b.has(w));
    const pairs = [];
    for (let k = 0; k < Math.min(removed.length, addedW.length) && pairs.length < 6; k++) pairs.push(`${removed[k]}→${addedW[k]}`);
    return { pos: `P${r.base.pi + 1}S${r.base.si + 1}`, base: r.base.text, pairs, rest: Math.max(0, removed.length - pairs.length) };
  });
  /* 加注口径（审查报告 §三）：「只统计注了多少处」已**降级为兼容字段**，不再当质量门禁——
   * 它曾让 A 层第 7/8/9 章 2% 的缺口完全隐形。现在并排给出 ⑪加注覆盖率（已注词型 / 应注词型）。 */
  let cover = { annotationCoverage: 1, annotated: 0, annotatable: 0 };
  try {
    const q = runQc(out, LEX, { tier: tier, fileName: 'ledger.md', dict: DICT });
    cover = { annotationCoverage: q.annotationCoverage, annotated: q.annotated, annotatable: q.annotatable };
  } catch {
    /* 产物还没成型（缺 [P##] 等）——台账照出，覆盖率留空 */
  }
  return {
    ch, rows: rows.length, kept: kept.length, rewritten: rewritten.length, sigLost: sigLost.length,
    lost, added, rewrites, notes: notesOf(out).length,
    coverage: cover.annotationCoverage, annotated: cover.annotated, annotatable: cover.annotatable,
    srcWords: wc(src), outWords: wc(out),
  };
}

const AI_TIERS = [
  { tag: 'A层85', label: 'A 层（原文 85%）' },
  { tag: 'M层75', label: 'M 层（原文 75%）' },
  { tag: 'B层60', label: 'B 层（原文 60%）' },
];
// ── 层级/章节过滤（2026-09-10 补）：原先无条件处理三档全章，
//    于是"只生成一层试跑"跑到后面几步必因找不到文件而崩。
const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const TAGS_ALL = { A: 'A层85', M: 'M层75', B: 'B层60' };
const TAGS = (argOf('--tier', 'A,M,B')).split(',').map((x) => x.trim().toUpperCase())
  .map((k) => TAGS_ALL[k]).filter(Boolean);
const CN_ALL = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
/** 章号（数字，1 起）：路径与台账都按它取中文章名 */
const CHAPTER_IDS = argOf('--chapters', '')
  ? argOf('--chapters').split(',').map((x) => Number(x.trim())).filter((n) => n >= 1 && n <= 10)
  : CN_ALL.slice(0, Number(P.章数 ?? 10)).map((_, i) => i + 1);
const { makeResolver } = await import(`${REPO}/dist/src/core/manifest.js`);
/* ── 路径一律经清单解析（总计划阶段 3「最关键的迁移」）─────────────────────
 * 「把路径解析集中到一个 `Resolver`，**禁止业务代码拼目录**」。
 * 本脚本原来用 `join(OUT_BASE, ch, `原文_${tag}_${DATE}.md`)` 这类手拼——
 * legacy 布局下逐字符正确，`--layout run` 下**写在一处、读又从另一处读**，
 * 而脚本照常报告成功（这类"不报错、结果错"正是这个规模崩点的样子）。
 * 命名规则的唯一来源是 `src/core/manifest.ts` 的 `resolvePath`。
 * 身份也走共享的那一个入口：两位教师并发时不再互相读到对方的 runId。 */
/* 身份从命令行取。**刻意不复用各脚本自己的参数助手**：它们的定义位置各不相同
 * （有的还是 `args.includes` 风格），在这一段引用会在定义之前求值。 */
const argRun = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const TEACHER = argRun('--teacher', process.env.LAYERTEXT_TEACHER ?? process.env.USER ?? 'unknown');
const RUN = await (await import('./LayerText_AF词表与词典.mjs')).readRunIdentity(
  { out: OUT_BASE, work: P.调适工作区 },
  { teacher: TEACHER, tier: TAGS[0] },
  { runId: argRun('--run', undefined) },
);
if (RUN.warning) console.warn(`\n⚠ ${RUN.warning}`);
/** 按层级标签取解析器（多层脚本与单层脚本共用同一种写法） */
const RR = (tag) => makeResolver(RUN.layout, { out: OUT_BASE, work: P.调适工作区 }, { runId: RUN.runId, tier: tag, date: DATE });
const R = RR(TAGS[0]);
const TIERS = AI_TIERS.filter((t) => TAGS.includes(t.tag));
const overview = ['# AF 三档重制 · 原文对照台账总览', '', `生成：${new Date().toLocaleString('zh-CN')}｜对齐口径：完全相同句 LCS 锚点 + 改写句 Jaccard≥0.45 配对（LayerText 引擎 alignSentencePairs）`, ''];
for (const t of TIERS) {
  const lines = [`# ${t.label} · 原文对照台账`, '', `产物：重制三版/第X章/原文_${t.tag}_${DATE}.md｜对齐基准：原文规范化版（245 段）`, '',
    '| 章 | 对齐句 | 原样保留 | 改写 | 数字/专名缺失 | 删句 | **加注覆盖率（已注/应注）** | 加注处数（旧口径·仅参考） | 篇幅 |', '|---|---|---|---|---|---|---|---|---|'];
  const totals = { rows: 0, kept: 0, rewritten: 0, sigLost: 0, lost: 0, notes: 0, sw: 0, ow: 0, annotated: 0, annotatable: 0 };
  for (const ci of CHAPTER_IDS) {
    const L = chapterLedger(tier_tag(t), t.tag, ci);
    totals.rows += L.rows; totals.kept += L.kept; totals.rewritten += L.rewritten; totals.sigLost += L.sigLost;
    totals.lost += L.lost.length; totals.notes += L.notes; totals.sw += L.srcWords; totals.ow += L.outWords;
    totals.annotated += L.annotated; totals.annotatable += L.annotatable;
    const cov = L.annotatable ? `${(L.coverage * 100).toFixed(0)}%（${L.annotated}/${L.annotatable}）` : '—';
    lines.push(`| ${L.ch} | ${L.rows} | ${L.kept} | ${L.rewritten} | ${L.sigLost} | ${L.lost.length} | **${cov}** | ${L.notes} | ${L.srcWords}→${L.outWords}（${((L.outWords / L.srcWords) * 100).toFixed(0)}%） |`);
    // 章内明细：删句与改写样例
    lines.push('', `<details><summary>${L.ch} 明细（改写 ${L.rewritten} 句的词级变更 · 删句 ${L.lost.length}）</summary>`, '');
    if (L.sigLost.length) {
      lines.push('**数字/专名缺失（改写句里找不到原文的数字或专名——需人工核对）**：');
      for (const r of L.sigLost.slice(0, 10)) lines.push(`- P${r.base.pi + 1}S${r.base.si + 1}：${r.base.text.slice(0, 70)}… ⚠缺 ${(r.lostSignals ?? []).join('、')}`);
      lines.push('');
    }
    lines.push('**改写句词级变更（前若干句）**：');
    for (const r of L.rewrites.slice(0, 12)) {
      lines.push(`- ${r.pos}：${r.pairs.join('、')}${r.rest ? `（另 ${r.rest} 处）` : ''}`);
    }
    if (L.lost.length) {
      lines.push('', '**删句（原文有、本版无——B 档删减细节属预期；A/M 档出现需留意）**：');
      for (const r of L.lost.slice(0, 10)) lines.push(`- P${r.base.pi + 1}S${r.base.si + 1}：${r.base.text.slice(0, 80)}…`);
    }
    lines.push('', '</details>', '');
  }
  lines.push('', `**${t.label} 合计**：对齐 ${totals.rows} 句｜原样保留 ${totals.kept}（${((totals.kept / totals.rows) * 100).toFixed(0)}%）｜改写 ${totals.rewritten}（${((totals.rewritten / totals.rows) * 100).toFixed(0)}%）｜数字专名缺失 ${totals.sigLost}｜删句 ${totals.lost}｜**加注覆盖率 ${totals.annotatable ? ((totals.annotated / totals.annotatable) * 100).toFixed(0) : '—'}%（${totals.annotated}/${totals.annotatable} 词型）**｜加注处数 ${totals.notes}（旧口径，仅参考）｜篇幅 ${totals.sw}→${totals.ow}（${((totals.ow / totals.sw) * 100).toFixed(0)}%）`, '');
  const p = RR(t.tag).any('台账');
  writeFileSync(p, lines.join('\n'), 'utf-8');
  overview.push(`- [${t.label}](台账_${t.tag}_${DATE}.md)：保留句 ${totals.kept}/${totals.rows}，改写 ${totals.rewritten}，删句 ${totals.lost}，加注覆盖率 ${totals.annotatable ? ((totals.annotated / totals.annotatable) * 100).toFixed(0) : '—'}%`);
  console.log(`✓ ${p}`);
}
writeFileSync(R.any('汇总报告', { name: '台账总览' }), overview.join('\n'), 'utf-8');
console.log('✓ 台账总览');

function tier_tag(t) {
  return t;
}
