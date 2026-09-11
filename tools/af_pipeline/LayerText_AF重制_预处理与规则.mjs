#!/usr/bin/env node
/** AF 原文重制·第一步：原文规范化（重建稿→分段 md）+ 审校成果提取（变更日志→校正规则）
 * 产物：
 *   调适工作区/原文重制_M50/第X章/原文_规范化.md   （[S###] 句标聚合为 [P##] 段，60-150 词/段）
 *   调适工作区/原文重制_M50/校正规则_v1.md          （换词替换表 + 难点词 + 注释策略，供生成管线注入）
 * 用法：node af_remake_prep.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/* 2026-09-10 修复：原先这里写死了 Animal Farm 的绝对路径、也不读项目配置，
 * 于是"换一本书"在第一步（原文规范化）就断。现在全部从 调适项目_*.json 读，
 * 输入文件名可配（默认沿用本项目的历史命名，不影响已有工作区）。 */
const P = (await import('./LayerText_AF词表与词典.mjs')).loadProject();
const WS = P.调适工作区;
const OUT = P.原文目录;
/* ── 为什么本脚本**不**走 `Resolver` ──────────────────────────────────────
 * `Resolver` 建模的是**产物目录**（`产物目录` + `调适工作区`）：正文/台账/报告/队列/日志。
 * 本脚本读写的是**原文目录**（`原文重制_M50/第X章/…`）——那是源树，不是产物树：
 * 它产出的是"供其它脚本当输入用"的规范化原文，从不参与运行私有目录那套隔离。
 * 把它硬塞进 `Resolver` 只会给源树编一套并不存在的 ArtifactKind。
 * 真正需要经 `Resolver` 的是**产物**那几类，那几类别的脚本已经全部改过去了。 */
const SRC_CLEAN = P.原文基线清理版名 ?? '原文基线_清理对齐版.md';
const SRC_RAW = P.原文基线重建稿名 ?? '原文基线_重建稿.txt';
const CH_COUNT = Number(P.章数 ?? 10);
const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const wc = (t) => (t.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).length;

mkdirSync(OUT, { recursive: true });
const report = [];

for (let i = 1; i <= CH_COUNT; i++) {
  const ch = `第${CN[i - 1]}章`;
  const dir = join(WS, ch);
  const outDir = join(OUT, ch);
  mkdirSync(outDir, { recursive: true });
  const cleaned = join(dir, SRC_CLEAN);
  let md;
  if (existsSync(cleaned)) {
    // 第一章：人工清理版内容原样，补齐 Chapter 标记（锚定行首 [P01]，引擎 splitChapter 需要）
    const raw2 = readFileSync(cleaned, 'utf-8');
    md = /^## Chapter /m.test(raw2) ? raw2 : raw2.replace(/^(\[P01\])/m, `## Chapter One\n\n$1`);
  } else {
    const raw = readFileSync(join(dir, SRC_RAW), 'utf-8');
    // 句标记 [S###] 提取 + 轻清理（Chapter N 粘连、句内重复 OCR 残留交由 AI 语感修复，指令中说明）
    const sents = [...raw.matchAll(/\[S\d+\]\s*([\s\S]*?)(?=\[S\d+\]|$)/g)].map((m) =>
      m[1].replace(/\s+/g, ' ').replace(/(Chapter \d+)(?=[A-Z])/g, '$1 ').trim(),
    );
    // 聚合成段：60-150 词/段（句边界不拆）
    const paras = [];
    let cur = [];
    for (const s of sents) {
      cur.push(s);
      const n = wc(cur.join(' '));
      if (n >= 60 && (n >= 110 || sents.indexOf(s) === sents.length - 1)) { paras.push(cur.join(' ')); cur = []; }
      else if (n > 150) { paras.push(cur.join(' ')); cur = []; }
    }
    if (cur.length) paras.push(cur.join(' '));
    md = `# AF ${ch} 原文（重制基线）\n\n## Chapter ${i}\n\n${paras.map((p, k) => `[P${String(k + 1).padStart(2, '0')}] ${p}`).join('\n\n')}\n`;
  }
  // 规范化收尾（2026-09-10 补）：OCR 重建稿里 48 处 "句子.下句" 丢了空格、9 章段首把
  // 章节标题当正文（[P01] Chapter 3 How they toiled…）——预处理不管，就会一路带进三档产物。
  md = md
    .replace(/(?<=[a-z])([.!?])(?=[A-Z])/g, '$1 ')          // 缺空格修补（排除 Mr./J.Smith 类）
    .replace(/^(\[P\d+\] )(?:Chapter\s+\d+\s*:?\s*)/gm, '$1') // 段首 OCR 章节名残留（## 标题行不动）
    .replace(/ {2,}/g, ' ');
  const outPath = join(outDir, '原文_规范化.md');
  writeFileSync(outPath, md, 'utf-8');
  const words = wc(md.split('## 词句卡')[0]);
  report.push({ ch, words, paras: (md.match(/\[P\d+\]/g) ?? []).length, outPath });
}

/* ---------- 审校成果提取：变更日志 70 行修订 → 词级替换表 ---------- */
const csvRows = [];
for (const d of readdirSync(WS)) {
  if (!/^第.章$/.test(d)) continue;
  const f = join(WS, d, '变更日志_AI审核.csv');
  if (!existsSync(f)) continue;
  const lines = readFileSync(f, 'utf-8').split('\n').slice(1);
  for (const line of lines) {
    if (!line.trim()) continue;
    // CSV 简解析：R1,日期,版本,章,位置,修改前,修改后,...（引号内含逗号，取第 6/7 字段成对解析）
    const cells = [];
    let inQ = false, c = '';
    for (const ch2 of line) {
      if (ch2 === '"') inQ = !inQ;
      else if (ch2 === ',' && !inQ) { cells.push(c); c = ''; }
      else c += ch2;
    }
    cells.push(c);
    if (cells.length >= 7 && cells[5] && cells[6]) csvRows.push({ before: cells[5], after: cells[6] });
  }
}
// 词 diff：修改前独有实词 → 修改后独有实词（最长公共子序列式配对简化为频次对齐）
const pairs = new Map();
for (const { before, after } of csvRows) {
  const bw = new Set((before.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []));
  const aw = new Set((after.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []));
  for (const w of bw) if (!aw.has(w)) pairs.set(w, (pairs.get(w) ?? 0) + 1); // 被换掉的词
}
const hardWords = [...pairs.entries()].filter(([, n]) => n >= 1).map(([w]) => w).sort();

const rules = `# AF 重制·校正规则 v1（从三版审校成果提取）

> 来源：调适工作区各章变更日志 ${csvRows.length} 行教师定稿修订 + 词级标记。生成管线作为方向指令注入。

## 替换倾向（教师在三版中实际换掉过的词，改写时优先用更简单说法处理）
${hardWords.slice(0, 60).join(', ')}

## 注释策略（沿三版惯例）
- 确需保留的超纲词，用 word（中文）格式在词后加注；换成简单词则注释一并去掉。
- 人名、地名、Beasts of England 歌词原样保留。

## 篇幅规则（本次重制核心）
- 全章总词数不得少于本章原文的 50%；段落改写遵循同义转换守恒（±15%）。
- 原文来自 OCR 重建，偶有词间粘连或重复——按英语语感自然修复，不改变情节。
`;
writeFileSync(join(OUT, '校正规则_v1.md'), rules, 'utf-8');

console.log('| 章 | 原文词数 | 段数 |');
for (const r of report) console.log(`| ${r.ch} | ${r.words} | ${r.paras} |`);
console.log(`\n合计原文 ${report.reduce((n, r) => n + r.words, 0)} 词；修订 ${csvRows.length} 行 → 替换倾向 ${hardWords.length} 词`);
console.log(`产物目录：${OUT}`);
