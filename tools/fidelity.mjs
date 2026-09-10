#!/usr/bin/env node
/**
 * 简化保真度测量（论文"简化质量"第三件套，2026-09-10 落地）：
 *   无参考方案——原文句 ↔ 简化句 的句向量余弦相似度（本地 MiniLM，首次运行自动下载模型，之后离线可跑）。
 *   对齐复用 App「逐句对照」同款 alignSentencePairs（LCS 锚点+Jaccard 贪心配对），丢句/新增沿用同口径。
 *
 * 用法：
 *   node tools/fidelity.mjs <原文.md> <简化.md> [--bottom 5] [--csv out.csv]
 * 输出：对齐句数/丢句/新增、cos 均值/中位/最小、最低 N 句明细（P 位置+原句→简化句+相似度）。
 * 判读提示：MiniLM 余弦 <0.70 大概率语义有偏移，建议人工核对（经验线，非硬阈值）。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { alignSentencePairs } from '../dist/src/core/align.js';
import { extractParas, sentsOf, splitChapter } from '../dist/src/core/textpipe.js';

const { values: args, positionals } = parseArgs({
  options: {
    bottom: { type: 'string', default: '5' },
    csv: { type: 'string' },
  },
  allowPositionals: true,
});

if (positionals.length !== 2) {
  console.error('用法：node tools/fidelity.mjs <原文.md> <简化.md> [--bottom 5] [--csv out.csv]');
  process.exit(1);
}
const bottom = Number(args.bottom) || 5;

/** 章节 md → 句序列（与 App 逐句对照同坐标系） */
function chapterSents(md) {
  try {
    return extractParas(splitChapter(md).body).flatMap((p, pi) => sentsOf(p, false).map((text, si) => ({ pi, si, text })));
  } catch {
    return [];
  }
}

const baseMd = readFileSync(positionals[0], 'utf-8');
const simpMd = readFileSync(positionals[1], 'utf-8');
const baseSents = chapterSents(baseMd);
const simpSents = chapterSents(simpMd);
if (!baseSents.length || !simpSents.length) {
  console.error('两个文件都要能解析出句子（需要 "## Chapter" + [P##] 段落标记格式）');
  process.exit(1);
}
const rows = alignSentencePairs(baseSents, simpSents);
const matched = rows.filter((r) => r.kind === 'match');
const lost = rows.filter((r) => r.kind === 'lost').length;
const added = rows.filter((r) => r.kind === 'added').length;
const sigN = rows.reduce((n, r) => n + (r.lostSignals?.length ?? 0), 0);

console.log(`句向量模型加载中（首次运行会下载 ~25MB，之后走本地缓存；huggingface.co 不通时自动切 hf-mirror.com 镜像）…`);
const { pipeline, env } = await import('@huggingface/transformers');
let extractor;
try {
  extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' });
} catch (e) {
  console.error(`官方源不通（${String(e.cause?.code ?? e).slice(0, 60)}）——切换镜像 hf-mirror.com 重试…`);
  env.remoteHost = 'https://hf-mirror.com';
  extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' });
}

const embed = async (texts) => {
  const out = await extractor(texts, { pooling: 'mean', normalize: true });
  return out.tolist();
};
const baseTexts = matched.map((r) => r.base.text);
const simpTexts = matched.map((r) => r.cur.text);
console.log(` embedding ${matched.length}×2 句…`);
const eb = await embed(baseTexts);
const es = await embed(simpTexts);
const cos = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const scores = matched.map((r, i) => ({ row: r, cos: cos(eb[i], es[i]) })).sort((a, b) => a.cos - b.cos);
const sorted = scores.map((s) => s.cos);
const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
const mid = sorted[Math.floor(sorted.length / 2)];

console.log('\n===== 简化保真度（无参考·句向量语义距离） =====');
console.log(`原文：${positionals[0].split('/').pop()}`);
console.log(`简化：${positionals[1].split('/').pop()}`);
console.log(`对齐 ${matched.length} 句 ｜ 丢句 ${lost}（疑似丢情节） ｜ 新增 ${added} ｜ 信号缺失 ${sigN} 处`);
console.log(`语义保真度 cos：均值 ${mean.toFixed(3)} ｜ 中位 ${mid.toFixed(3)} ｜ 最低 ${sorted[0].toFixed(3)}`);
console.log(`判读：MiniLM 余弦 <0.70 大概率语义有偏移建议人工核对；丢句以「逐句对照」页明细为准\n`);
for (const s of scores.slice(0, bottom)) {
  const p = `P${String((s.row.base?.pi ?? 0) + 1).padStart(2, '0')}-S${(s.row.base?.si ?? 0) + 1}`;
  console.log(`· [${s.cos.toFixed(3)}] ${p} ${s.row.base.text.slice(0, 70)}`);
  console.log(`         → ${(s.row.cur?.text ?? '').slice(0, 70)}`);
}
if (args.csv) {
  const header = '原文,简化,对齐句,丢句,新增,信号缺失,cos均值,cos中位,cos最低';
  const line = [positionals[0], positionals[1], matched.length, lost, added, sigN, mean.toFixed(3), mid.toFixed(3), sorted[0].toFixed(3)]
    .map((v) => `"${String(v).replace(/"/g, '""')}"`)
    .join(',');
  const out = (existsSync(args.csv) ? '' : '\ufeff' + header + '\n') + line + '\n';
  writeFileSync(args.csv, (existsSync(args.csv) ? readFileSync(args.csv, 'utf-8') : '') + out);
  console.log(`\n已追加 CSV：${args.csv}`);
}
