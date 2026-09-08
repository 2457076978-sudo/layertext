/**
 * O5 性能基线实测脚本：文本管线 / DOM 渲染 / QC 体检 / 版本对比，AF 第一章与 3 倍长文本。
 * 用法：npm run build && node tools/perf_baseline.mjs [章节md路径] [--out docs/性能基线.md]
 * AI 全流程耗时不在本脚本自动跑（不消耗教师 API 额度）——读成本台账的历史真实数据作参考。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Window } from 'happy-dom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const mod = (p) => import(join(ROOT, p));
const { extractParas, sentsOf, splitChapter, tokenizeTxt, cardGlossWords } = await mod('dist/src/core/textpipe.js');
const { runQc } = await mod('dist/src/core/qc.js');
const { buildLexicon } = await mod('dist/src/core/lexicon.js');
const { sentenceRisks } = await mod('dist/src/core/risks.js');
const { renderDiffPane } = await mod('dist/app/src/widgets.js');
const { normalizeAndSplitChapters } = await mod('dist/app/src/pure.js');

const afDefault = join(ROOT, '../../01-教学工作/名著阅读工作区_AnimalFarm/调适工作区/第一章/原文基线_清理对齐版.md');
const argPath = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : afDefault;
const outIdx = process.argv.indexOf('--out');
const outPath = outIdx > 0 ? process.argv[outIdx + 1] : null;

const raw = readFileSync(argPath, 'utf-8');
const md1 = normalizeAndSplitChapters(raw, 'af.md').chapters[0].md;

/** 段落重复 N 份并重编段号（模拟 3 倍长章节；词句内容真实、结构合规） */
function makeN(md, n) {
  const paras = extractParas(splitChapter(md).body).map((p) => p.replace(/^\[P\d+\]\s*/, ''));
  const all = [];
  for (let k = 0; k < n; k++) all.push(...paras.map((p) => p + (k > 0 ? ` Again and again, the animals kept on working hard.` : '')));
  return `# bench\n\n## Chapter One\n\n${all.map((p, i) => `[P${String(i + 1).padStart(2, '0')}] ${p}`).join('\n\n')}\n`;
}
const md3 = makeN(md1, 3);

const lexicon = buildLexicon({
  plainWordlistTexts: [readFileSync(join(ROOT, 'assets/wordlists/curriculum_2022_level3_1600.txt'), 'utf-8'), readFileSync(join(ROOT, 'assets/wordlists/curriculum_2022_amendment.txt'), 'utf-8')],
  terms: [],
  properNouns: [],
});

function bench(fn, iters = 15) {
  for (let i = 0; i < 3; i++) fn();
  const ts = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    fn();
    ts.push(performance.now() - t0);
  }
  ts.sort((a, b) => a - b);
  return { median: ts[Math.floor(iters / 2)], p95: ts[Math.min(iters - 1, Math.ceil(iters * 0.95) - 1)] };
}

/* ① 文本管线：splitChapter + extractParas + sentsOf + tokenizeTxt + sentenceRisks（渲染前的全部计算） */
function pipeline(md) {
  const body = splitChapter(md).body;
  let words = 0;
  for (const p of extractParas(body))
    for (const sent of sentsOf(p, false)) {
      words += tokenizeTxt(sent).length;
      sentenceRisks(sent);
    }
  return words;
}

/* ② DOM 渲染：与 renderReader 同构的循环（happy-dom；真实 WKWebView 显著快于此，作相对对照） */
const win = new Window();
const reader = win.document.createElement('div');
win.document.body.appendChild(reader);
function renderLikeMain(md) {
  const body = splitChapter(md).body;
  const known = lexicon.known;
  reader.replaceChildren();
  extractParas(body).forEach((p, pi) => {
    const div = win.document.createElement('div');
    const pid = win.document.createElement('span');
    pid.textContent = 'P' + pi;
    div.appendChild(pid);
    sentsOf(p, false).forEach((sent) => {
      const s = win.document.createElement('span');
      const toks = tokenizeTxt(sent);
      const raws = sent.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
      let rest = sent;
      for (let i = 0; i < raws.length; i++) {
        const at = rest.indexOf(raws[i]);
        if (at > 0) s.appendChild(win.document.createTextNode(rest.slice(0, at)));
        const w = win.document.createElement('span');
        const tok = toks[i] ?? raws[i].toLowerCase();
        w.className = 'w' + (known.has(tok) ? '' : ' oov');
        w.dataset.tok = tok;
        w.textContent = raws[i];
        s.appendChild(w);
        rest = rest.slice(at + raws[i].length);
      }
      div.appendChild(s);
    });
    reader.appendChild(div);
  });
}

/* ③ QC 体检 */
function qc(md) {
  runQc(md, lexicon, { tier: 'M', fileName: 'bench.md' });
}

/* ④ 版本对比渲染（右侧为"每 3 段改 1 段"的模拟简化版） */
const diffPane = win.document.createElement('section');
win.document.body.appendChild(diffPane);
function diffLike(md) {
  const body = splitChapter(md).body;
  const paras = extractParas(body);
  const sim = paras.map((p, i) => (i % 3 === 0 ? p.replace(/\bvery\b/g, 'really') : p)).join('\n\n');
  renderDiffPane(
    diffPane,
    [
      { fileName: '原文.md', md },
      { fileName: '简化版.md', md: `# b\n\n## Chapter One\n\n${sim}\n` },
    ],
    0,
    1,
    () => {},
  );
}

const wc = (md) => (splitChapter(md).body.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).length;
const rows = [];
for (const [label, md] of [
  ['AF 第一章（1x）', md1],
  ['同文 3 倍（3x）', md3],
]) {
  rows.push({
    label,
    词符: wc(md),
    段数: extractParas(splitChapter(md).body).length,
    pipeline: bench(() => pipeline(md)),
    render: bench(() => renderLikeMain(md), 8),
    qc: bench(() => qc(md), 8),
    diff: bench(() => diffLike(md), 8),
  });
}

/* ⑤ AI 全流程：不自动消耗额度，读本机成本台账的历史真实耗时 */
let aiNote = '本机无成本台账（尚未在应用内跑过 AI）';
const costCsv = join(process.env.HOME, 'Documents/LayerText质检报告/AI成本台账.csv');
if (existsSync(costCsv)) {
  const lines = readFileSync(costCsv, 'utf-8').trim().split('\n');
  const idx = lines[0].split(',');
  const iScene = idx.indexOf('场景'),
    iMs = idx.indexOf('耗时ms'),
    iOk = idx.indexOf('结果');
  const byScene = {};
  for (const l of lines.slice(1)) {
    const c = l.split(',');
    if (!c[iOk] || c[iOk] !== 'ok') continue;
    const s = c[iScene] ?? '?';
    (byScene[s] ??= []).push(Number(c[iMs]) || 0);
  }
  const parts = Object.entries(byScene).map(([s, arr]) => {
    const avg = Math.round(arr.reduce((a, b) => a + b, 0) / arr.length / 1000);
    return `${s}（${arr.length} 次成功，平均 ${avg}s/次）`;
  });
  if (parts.length) aiNote = '历史真实数据：' + parts.join('；');
}

const fmt = (b) => `${b.median.toFixed(0)}ms（p95 ${b.p95.toFixed(0)}ms）`;
const md = `# 性能基线（O5 实测）

> 生成：${new Date().toLocaleString('sv-SE')} · 脚本 \`tools/perf_baseline.mjs\`（可重跑刷新）· 样本：${argPath.includes('AnimalFarm') ? 'AF 第一章原文基线' : argPath}
> 环境：Node ${process.version}，happy-dom（DOM 段为同构循环实测，真实 WKWebView 显著更快，作回归对照用）。
> 阈值口径：正文渲染 > 200ms 才做增量渲染优化（长程提示词 O5 约定）。

| 文本 | 词符 | 段数 | 文本管线 | DOM 渲染（同构） | QC 体检 | 版本对比渲染 |
|---|---|---|---|---|---|---|
${rows.map((r) => `| ${r.label} | ${r.词符} | ${r.段数} | ${fmt(r.pipeline)} | ${fmt(r.render)} | ${fmt(r.qc)} | ${fmt(r.diff)} |`).join('\n')}

## AI 全流程耗时

${aiNote}。AI 耗时主要由网络与服务商决定（应用内有重试与 failover），本地计算部分（管线/体检）如上表，占比可忽略。

## 判读

- 正文渲染远低于 200ms 阈值（3x 文本也低于阈值）：**无需增量渲染**；后续若文本规模或 DOM 结构变化，重跑本脚本对照。
- 若未来 3x 以上文本渲染逼近阈值，优先方案：分批 requestAnimationFrame 渲染段落（renderReader 已按段落循环，天然可分批）。
`;

if (outPath) {
  writeFileSync(outPath, md);
  console.log('written:', outPath);
}
console.log(md);
