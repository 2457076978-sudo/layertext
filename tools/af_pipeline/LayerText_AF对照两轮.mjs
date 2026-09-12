#!/usr/bin/env node
/** 两轮调适 · 前后对照报告（方向文档第七部分：三类样本 × 三层，回答五问）
 *
 * 对照对象：旧版产物（_2026-09-10，"保留难词靠注释"策略）vs 两轮制终稿（_2026-09-12）。
 * 自动算：生词率（QC 口径）、注释处数、最长句、引入超纲词、否定数、专名保留。
 * 不判断"学生一定读得懂"——计数与定位供教师校准，文本抽查供人工判断。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SHARED = await import('./LayerText_AF词表与词典.mjs');
const { distOf } = SHARED;
const P = SHARED.loadProject();
const REPO = P.引擎目录;
const OUT = P.产物目录;
const CH = '第七章';
const { runQc } = await import(`${distOf(REPO)}/src/core/qc.js`);
const { burdenProfileOf, fidelityCountsOf, introducedHardWords } = await import(`${distOf(REPO)}/src/core/adaptcheck.js`);
const isKnown = await SHARED.makeKnownChecker(P);
const PROPER_NAMES = ['Napoleon', 'Snowball', 'Boxer', 'Clover', 'Squealer', 'Benjamin', 'Muriel', 'Jones'];

const wc = (t) => (t.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).length;

const lex = await SHARED.loadLexicon(P);
const one = (md, src) => {
  const q = runQc(md, lex, { tier: 'M', fileName: 'adapt.md' });
  const b = burdenProfileOf(md);
  const f = fidelityCountsOf(md);
  const proper = PROPER_NAMES.filter((n) => md.includes(n));
  return {
    words: wc(md),
    oov: q.newWordRate * 100,
    annos: b.annos,
    density: b.densityPer100,
    longest: b.longestSentence?.words ?? 0,
    negs: f.negations,
    proper,
    introduced: introducedHardWords(src, md, (w) => !isKnown(w)).length,
  };
};

const srcMd = readFileSync(join(P.原文目录, CH, '原文_规范化.md'), 'utf-8');
const L = [
  '# 两轮调适 · 前后对照（第七章 × 三层）',
  '',
  '> 对照：旧版 2026-09-10（"保留难词靠注释"）vs 两轮制终稿 2026-09-12（词汇优先换写 + 教师反馈第二轮）。',
  '> 计数供校准，不声称"学生一定读得懂"；阈值为工程试运行值。',
  '',
  '| 层 | 版本 | 词数 | 生词率 | 注释处 | 每百词注释 | 最长句 | 否定 | 引入超纲 | 专名保留 |',
  '|---|---|---|---|---|---|---|---|---|---|',
];
const notes = [];
for (const [tag, name] of [['A层85', 'A'], ['M层75', 'M'], ['B层60', 'B']]) {
  const oldP = join(OUT, CH, `原文_${tag}_2026-09-10.md`);
  const newP = join(OUT, CH, `原文_${tag}_2026-09-12.md`);
  if (!existsSync(oldP) || !existsSync(newP)) { notes.push(`- ${tag}：缺旧版或新版，跳过`); continue; }
  const o = one(readFileSync(oldP, 'utf-8'), srcMd);
  const n = one(readFileSync(newP, 'utf-8'), srcMd);
  L.push(`| ${name} | 旧 | ${o.words} | ${o.oov.toFixed(1)}% | ${o.annos} | ${o.density} | ${o.longest} | ${o.negs} | ${o.introduced} | ${o.proper.length}/${PROPER_NAMES.length} |`);
  L.push(`| ${name} | **新** | ${n.words} | **${n.oov.toFixed(1)}%** | ${n.annos} | ${n.density} | ${n.longest} | ${n.negs} | ${n.introduced} | ${n.proper.length}/${PROPER_NAMES.length} |`);
  if (o.proper.length !== n.proper.length) notes.push(`- ⚠ ${name} 层专名有变化：旧 ${o.proper.join('/')} → 新 ${n.proper.join('/')}（请人工确认是译写差异还是丢失）`);
}
L.push('', '## 五问（自动可答部分 + 人工抽查区）');
L.push(
  '1. **非必要难词是否被换掉？** 生词率列前后对比即为答案；"引入超纲"列应接近 0（第二轮不得换进新难词）。',
  '2. **注释是否减少、英文是否更易懂？** 注释列与每百词注释列对比；英文易懂度请读下方抽查段。',
  '3. **人物、动作、否定、因果是否保留？** 否定列与专名列是自动口径；方向性（"不得→可以"）已由检查引擎覆盖，最终请人工抽读。',
  '4. **是否"为了短而省掉解释"？** 两轮制篇幅为参考项、允许补解释——词数列新版偏长即属正常；请抽读确认解释没有丢因果。',
  '5. **第二轮后还剩哪些问题？** 见各层《调适报告_*_第七章_2026-09-12.md》的"难度"分级清单（剩余问题如实列出，交教师修改或说明保留）。',
);
if (notes.length) L.push('', '## 人工确认项', ...notes);
const out = join(OUT, `两轮调适_对照报告_${CH}_2026-09-12.md`);
writeFileSync(out, L.join('\n') + '\n', 'utf-8');
console.log(`✓ ${out}`);
