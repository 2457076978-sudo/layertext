#!/usr/bin/env node
/** AF 三档重制·复核汇总（2026-09-10）
 *
 * 为什么单独一个：原 `三档汇总` 由 三档生成.mjs 在**精修前**写出，且"超时句"一列沿用引擎
 * 的硬编码 `over20`（>20 词）。而三档句长上限是 A20/M16/B14 —— 于是
 *   A 层口径正确，M 层漏报 33%（436 实际 vs 291 报告），B 层漏报 67%（328 vs 109）。
 * 本脚本按**各层自己的上限**重算，并顺带补出精修后的真实篇幅与加注数。
 *
 * 用法：node LayerText_AF三档复核.mjs
 * 产物：调适工作区/重制三版/三档汇总_2026-09-10.md（覆盖旧表）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadLexicon } from './LayerText_AF词表与词典.mjs';

const P = (await import('./LayerText_AF词表与词典.mjs')).loadProject();
const LTR = P.引擎目录;
const WS = P.调适工作区;
const SRC_BASE = P.原文目录;
const OUT_BASE = P.产物目录;
const VOCAB = P.词库;
const DATE = P.日期;
const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

const { splitChapter, extractParas, sentsOf } = await import(`${LTR}/dist/src/core/textpipe.js`);
const { runQc } = await import(`${LTR}/dist/src/core/qc.js`);
// 词表 + 本书专名（专名不计 OOV）——2026-09-10：原先只喂词库，专名被算成生词
const LEX = await loadLexicon(P);

/** 三档：ratio=目标篇幅占比；maxLen=该层句长上限（超标即违规） */
const TIERS = [
  { key: 'A', tag: 'A层85', label: 'A 层（原文 85%）', ratio: 0.85, maxLen: 20 },
  { key: 'M', tag: 'M层75', label: 'M 层（原文 75%）', ratio: 0.75, maxLen: 16 },
  { key: 'B', tag: 'B层60', label: 'B 层（原文 60%）', ratio: 0.6, maxLen: 14 },
];
const wc = (t) => (t.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).length;
const ANN_RE = /([A-Za-z][A-Za-z'-]*)（([^（）]{1,24})）/g;

/** 按本层句长上限统计超标句（引擎 qc 的 over20 是硬编码 20 词，不分层） */
function overLimit(md, maxLen) {
  let over = 0, total = 0;
  for (const p of extractParas(splitChapter(md).body)) {
    const isSong = p.includes('Beasts of England');
    for (const s of sentsOf(p, isSong)) {
      total++;
      if (wc(s) > maxLen) over++;
    }
  }
  return { over, total };
}

const rows = [];
for (const t of TIERS) {
  let tot = { sw: 0, ow: 0, notes: 0, over: 0, over20: 0, sents: 0, nw: 0, al: 0, pa: 0, rc: 0, pp: 0, ann: 0, annt: 0 };
  for (let i = 1; i <= 10; i++) {
    const ch = `第${CN[i - 1]}章`;
    const src = readFileSync(join(SRC_BASE, ch, '原文_规范化.md'), 'utf-8');
    const p = join(OUT_BASE, ch, `原文_${t.tag}_${DATE}.md`);
    const md = readFileSync(p, 'utf-8');
    const sw = wc(src.split('## 词句卡')[0]);
    const ow = wc(md.split('## 词句卡')[0]);
    const notes = (md.match(ANN_RE) ?? []).length;
    const qc = runQc(md, LEX, { tier: t.key, fileName: p.split('/').pop() });
    const ol = overLimit(md, t.maxLen);
    rows.push({ t, ch, sw, ow, ratio: ow / sw, notes, qc, over: ol.over, sents: ol.total, maxLen: t.maxLen });
    tot.sw += sw; tot.ow += ow; tot.notes += notes; tot.over += ol.over; tot.over20 += qc.over20;
    tot.sents += ol.total; tot.nw += qc.newWordRate; tot.al += qc.avgLenNarrRaw;
    tot.ann += qc.annotated; tot.annt += qc.annotatable;
    tot.pa += qc.passive; tot.rc += qc.relcl; tot.pp += qc.pastperf;
  }
  rows.push({ tierTotal: t, tot });
}

const L = [];
L.push('# AF 三档重制（85/75/60）· 汇总报告（复核版）', '');
L.push(`生成：${new Date().toLocaleString('zh-CN')}｜复核脚本：LayerText_AF三档复核.mjs`);
L.push('');
L.push('> **与旧表的差别**：旧表在精修前写出（篇幅偏小），且"超时句"沿用引擎硬编码的 `>20 词`，');
L.push('> 而三档句长上限是 A20/M16/B14 —— M 层漏报 145 句、B 层漏报 219 句。本表按**各层自己的上限**重算。');
L.push('');
L.push('| 层 | 章 | 原文词数 | 产物词数 | 占比 | 目标 | 生词率 | 均长 | 被动/定从/过去完成 | 超本层上限句 | (旧口径>20词) | 超限占比 | 加注 | **加注覆盖率** |');
L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  if (r.tierTotal) {
    const { tierTotal: t, tot } = r;
    L.push(`| **${t.key}** | **合计** | **${tot.sw}** | **${tot.ow}** | **${((tot.ow / tot.sw) * 100).toFixed(1)}%** | **${Math.round(t.ratio * 100)}%** | **${((tot.nw / 10) * 100).toFixed(1)}%** | **${(tot.al / 10).toFixed(1)}** | **${tot.pa}/${tot.rc}/${tot.pp}** | **${tot.over}** | **${tot.over20}** | **${((tot.over / tot.sents) * 100).toFixed(1)}%** | **${tot.notes}** | **${tot.ann}/${tot.annt} = ${((tot.ann / (tot.annt || 1)) * 100).toFixed(0)}%** |`);
    continue;
  }
  const off = Math.abs(r.ratio - r.t.ratio) > 0.12 ? ' ⚠偏' : '';
  L.push(`| ${r.t.key} | ${r.ch} | ${r.sw} | ${r.ow} | ${(r.ratio * 100).toFixed(0)}%${off} | ${Math.round(r.t.ratio * 100)}% | ${(r.qc.newWordRate * 100).toFixed(1)}% | ${r.qc.avgLenNarrRaw.toFixed(1)} | ${r.qc.passive}/${r.qc.relcl}/${r.qc.pastperf} | ${r.over}（≤${r.maxLen}词） | ${r.qc.over20} | ${((r.over / r.sents) * 100).toFixed(1)}% | ${r.notes} | ${r.qc.annotated}/${r.qc.annotatable} = ${(r.qc.annotationCoverage * 100).toFixed(0)}%${r.qc.annotationCoverage < 0.7 ? ' ❌' : ''} |`);
}
L.push('');
L.push('口径说明：');
L.push('- 生词率 = 词型口径，QC 词表 = 已知词汇库_v0.7.csv，专名（含 clover/squealer/mollie）不计生词；');
L.push('- 被动/定从/过去完成 = 叙事区计数（引擎 ⑤⑥⑦），直接引语内不计；');
L.push('- 超本层上限句 = 按该层 maxLen（A20/M16/B14）统计的超标句数，"旧口径>20词"是引擎硬编码 20 词的旧列，仅作对照；');
L.push('- 加注 = 英文词后紧跟中文释义 `word（释义）` 的出现次数；');
L.push('- **加注覆盖率 = 已注词型 / 应注词型（引擎指标⑪）**：应注 = QC 判定的 OOV 词型（去两字母词，专名不计）。');
L.push('  这是"检测 → 加注"闭环的闸门——2026-09-10 之前只统计"注了多少处"，没有"该注多少"，');
L.push('  于是 A 层第 7/8/9 章覆盖率只有 2% 却没人发现。硬线：任何章次 < 70% 即判不通过。');
L.push('');
L.push('修复记录（2026-09-10 第一轮）：清 21 处 `Chapter（章节）`、清 clover/squealer/mollie 专名误注 77 次、');
L.push('清"词表已收却仍加注"507 次、清源文与产物缺空格 147 处、统一 224 个词型的多义释义 → 0。');
L.push('');
L.push('修复记录（2026-09-10 第二轮 · 复核后）：');
L.push('1. **A 层第 7/8/9 章加注断层**：覆盖率 2%/3%/1% → 85%/86%/85%（补注 660 处），全书 A 层 47% → 89%；');
L.push('2. **加注不再是检测驱动的问题**：新增 `LayerText_AF补注.mjs`（QC 的 OOV → 查词典 → 缺的才问模型 → 回写词典），');
L.push('   加注覆盖率进本表并设闸门（单章 <70% 退出码 1）；');
L.push('3. **QC 词表口径错误**：原先四个脚本只喂项目词库、没喂内置课标1600 与数词补录，也没喂专名表');
L.push('   （`properNouns` 是 buildLexicon 的参数，传给 runQc 无效）——数词与专名被算成生词，生词率虚高。已统一为 `loadLexicon()`；');
L.push('4. 引擎新增指标⑪（加注覆盖率），并修正连字符复合词的"已注"识别（`blood-curdling（…）` 算 curdling 已注）。');

const out = join(OUT_BASE, `三档汇总_${DATE}.md`);
writeFileSync(out, L.join('\n') + '\n', 'utf-8');
console.log(L.join('\n'));
console.log(`\n✓ 已写出 ${out}`);

/* ══════════ 闸门：加注覆盖率低于硬线的章次直接判不通过 ══════════
 * 2026-09-10 新增。教训：A 层第 7/8/9 章的加注覆盖率只有 2%（其余章 62-78%），
 * 而当时的报表把"加注"当普通一列印出来，没有任何阈值——缺口就这样交付了出去。
 * 现在：单章 < 70% = 红线（退出码 1）；层合计 < 90% = 提示。 */
const HARD_FLOOR = 0.7;
const TIER_TARGET = { A: 0.85, M: 0.82, B: 0.8 };
const chapterRows = rows.filter((r) => !r.tierTotal);
const red = chapterRows.filter((r) => r.qc.annotationCoverage < HARD_FLOOR);
const belowTarget = chapterRows.filter(
  (r) => r.qc.annotationCoverage < TIER_TARGET[r.t.key] && r.qc.annotationCoverage >= HARD_FLOOR,
);
console.log('\n════ 加注覆盖率闸门 ════');
for (const r of chapterRows) {
  const cov = r.qc.annotationCoverage;
  const mark = cov < HARD_FLOOR ? '❌ 红线' : cov < TIER_TARGET[r.t.key] ? '⚠ 低于目标' : '✓';
  if (mark !== '✓') console.log(`  ${mark} ${r.t.key} ${r.ch}：${(cov * 100).toFixed(0)}%（${r.qc.annotated}/${r.qc.annotatable}）目标 ${(TIER_TARGET[r.t.key] * 100).toFixed(0)}%`);
}
if (red.length) {
  console.error(`\n✗ ${red.length} 个章次低于红线 ${HARD_FLOOR * 100}%：`);
  for (const r of red) console.error(`   ${r.t.key} ${r.ch}：${(r.qc.annotationCoverage * 100).toFixed(0)}%，缺注 ${r.qc.annotMissing.length} 个词型`);
  console.error('   先跑：node LayerText_AF补注.mjs  （或指定 --tier/--chapters）');
  process.exit(1);
}
console.log(`  ✓ 全部 ${chapterRows.length} 个章次通过红线（${HARD_FLOOR * 100}%）${belowTarget.length ? `；${belowTarget.length} 个低于目标但未破线` : ''}`);
