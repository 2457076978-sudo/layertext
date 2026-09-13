#!/usr/bin/env node
/**
 * 叙事保真度报告（优化方向①：段落热力 + SW 叙事覆盖率，零 LLM）
 *
 * 用法：
 *   node tools/narrative_fidelity.mjs <原文.md> <简化.md> [--tau 0.5] [--gap 0.3]
 *        [--risk 段落风险线] [--report 输出.md]
 * 定标纪律：tau/gap/风险线必须显式给出或由 --calibrate 数据支撑；不给 risk 则只报
 * 分布（P10/P50）不判风险——阈值等数据，不拍脑袋。
 *
 * 输出：段落级 cos 逐对表（风险线给了才标 risky）+ Smith-Waterman 句级对齐
 * 覆盖率 + 未对齐原文句清单（简化版里找不到语义对应=丢事件候选，交教师核对）。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { sentsOf, splitChapter } from '../dist/src/core/textpipe.js';
import { smithWatermanAlign, paragraphSimilarities } from '../dist/src/core/narrative.js';

const { values: args, positionals } = parseArgs({
  options: {
    tau: { type: 'string', default: '0.5' },
    gap: { type: 'string', default: '0.3' },
    risk: { type: 'string' },
    report: { type: 'string' },
    seg: { type: 'string' }, // 只分析指定段（调试用），默认全书
  },
  allowPositionals: true,
});
if (positionals.length !== 2) {
  console.error('用法：node tools/narrative_fidelity.mjs <原文.md> <简化.md> [--tau .5] [--gap .3] [--risk .6] [--report out.md]');
  process.exit(1);
}

const segFilter = args.seg ? new Set(args.seg.split(',')) : null;
const segsOf = (md) => {
  const body = splitChapter(md).body;
  const map = new Map();
  for (const m of body.matchAll(/\[P(\d+)\]([\s\S]*?)(?=\[P\d+\]|$)/g)) {
    const id = `P${m[1]}`;
    if (segFilter && !segFilter.has(id)) continue;
    const text = m[2].trim();
    if (text) map.set(id, text);
  }
  return map;
};
const sentsOfSeg = (text, segId) =>
  sentsOf(`[${segId}] ${text}`, false)
    .map((t, si) => ({
      text: t
        .replace(/\[P\d+\]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
      key: `${segId}:${si}`,
    }))
    .filter((s) => s.text.length > 12); // 段标记是结构不是内容——不进句向量

const baseMd = readFileSync(positionals[0], 'utf-8');
const simpMd = readFileSync(positionals[1], 'utf-8');
const baseSegs = segsOf(baseMd);
const simpSegs = segsOf(simpMd);
if (!baseSegs.size || !simpSegs.size) {
  console.error('两个文件都要能解析出 [P##] 段落');
  process.exit(1);
}

console.log('句向量模型加载中（本地缓存，离线可跑）…');
const { pipeline, env } = await import('@huggingface/transformers');
let extractor;
try {
  extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' });
} catch {
  env.remoteHost = 'https://hf-mirror.com';
  extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' });
}
const embed = async (texts) => {
  const out = await extractor(texts, { pooling: 'mean', normalize: true });
  return texts.map((_, i) => Array.from(out[i].data));
};

/* ── 段落级 ── */
const baseParaTexts = [...baseSegs.entries()];
const simpParaTexts = [...simpSegs.entries()];
const baseParaVecs = await embed(baseParaTexts.map(([, t]) => t));
const simpParaVecsRaw = await embed(simpParaTexts.map(([, t]) => t));
const simpParaVecs = new Map(simpParaTexts.map(([id], i) => [id, simpParaVecsRaw[i]]));
const paraPairs = paragraphSimilarities(new Map(baseParaTexts.map(([id], i) => [id, baseParaVecs[i]])), simpParaVecs, args.risk ? Number(args.risk) : Infinity);
const paraScores = paraPairs
  .filter((p) => !Number.isNaN(p.score))
  .map((p) => p.score)
  .sort((a, b) => a - b);
const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : Number.NaN);

/* ── 句级 SW ── */
const baseSents = [...baseSegs].flatMap(([id, t]) => sentsOfSeg(t, id));
const simpSents = [...simpSegs].flatMap(([id, t]) => sentsOfSeg(t, id));
const baseVecs = await embed(baseSents.map((s) => s.text));
const simpVecs = await embed(simpSents.map((s) => s.text));
const align = smithWatermanAlign(baseVecs, simpVecs, { tau: Number(args.tau), gap: Number(args.gap) });
const coverage = baseSents.length ? align.coveredBase.size / baseSents.length : 0;

/* ── 输出 ── */
const lines = [];
lines.push('# 叙事保真度报告', '');
lines.push(`- 原文：${positionals[0]}`);
lines.push(`- 简化：${positionals[1]}`);
lines.push(`- 参数：tau=${args.tau} gap=${args.gap}${args.risk ? ` 段落风险线=${args.risk}` : '（未给风险线，只报分布）'}`, '');
lines.push(`## 段落级相似度（cos 分布：P10=${pct(paraScores, 0.1).toFixed(3)} / P50=${pct(paraScores, 0.5).toFixed(3)} / 最小=${paraScores[0]?.toFixed(3) ?? '—'}）`, '');
lines.push('| 段 | cos | 风险 |', '|---|---|---|');
for (const p of paraPairs) lines.push(`| ${p.segId} | ${Number.isNaN(p.score) ? '（简化版缺段）' : p.score.toFixed(3)} | ${p.risky ? '⚠' : ''} |`);
lines.push('', `## 叙事覆盖率（Smith-Waterman 句对齐）`, '');
lines.push(`- 原文叙事单元 ${baseSents.length} 句，对齐覆盖 **${align.coveredBase.size}** 句（覆盖率 **${(coverage * 100).toFixed(1)}%**）`);
lines.push(`- 未对齐原文句 ${align.uncoveredBase.length} 句（简化版里找不到语义对应——丢句/丢事件候选，逐句核对）：`, '');
for (const k of align.uncoveredBase) {
  const s = baseSents[k];
  lines.push(`- [${s.key}] ${s.text.slice(0, 120)}${s.text.length > 120 ? '…' : ''}`);
}
lines.push('', `### 对齐明细（原文 → 简化，cos）`, '');
for (const pr of align.pairs) {
  const b = baseSents[pr.baseIdx];
  const s = simpSents[pr.simpIdx];
  lines.push(`- ${pr.score.toFixed(3)} [${b.key}] ${b.text.slice(0, 60)}… → [${s.key}] ${s.text.slice(0, 60)}…`);
}
const report = lines.join('\n') + '\n';
if (args.report) {
  writeFileSync(args.report, report, 'utf-8');
  console.log(`✓ 报告：${args.report}`);
} else {
  console.log(report);
}
console.log(`覆盖率 ${(coverage * 100).toFixed(1)}%｜段落 P10=${pct(paraScores, 0.1).toFixed(3)}`);
