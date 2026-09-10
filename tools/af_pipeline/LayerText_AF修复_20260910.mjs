#!/usr/bin/env node
/** AF 三档重制·修复（2026-09-10，Wayne 指令"把报告里的问题都解决"）
 *
 * 解决清单：
 *  ① 源文 原文_规范化.md：缺空格修补（48 处 OCR 遗留）+ 段首 OCR "Chapter N" 残留清除
 *  ② 产物 30 个 md：
 *     a. 清 "Chapter（章节）" 残留（21 处，README 声称已修的 bug 的正文残留）
 *     b. 清专名误注（clover/squealer/mollie —— PROPER 白名单漏项，Squealer 曾注出 4 种意思）
 *     c. 清"词表已收却仍加注"的误注（根因：词库 v0.6 的课标1600 子集只落了 1371/1677，
 *        pig/man/sheep/nine/foot/picture/die 等课标词漏收 → QC 判 OOV → 被加注）
 *     d. 统一同词多义释义（修复前 224 个词型有多种中文注释 → 归一，落 AF注释词典_v1.csv）
 *     e. 缺空格修补 + 注释右括号后空格修补
 *  ③ 生成/更新 知识文件/AF注释词典_v1.csv（统一释义正本，精修脚本复用）
 *
 * 判定口径见 LayerText_AF词表与词典.mjs（单一来源，三个脚本共用，杜绝再次漂移）。
 * 用法：node LayerText_AF修复_20260910.mjs [--dry]
 * 红线：只改 原文_规范化.md（派生物，非原稿）与 重制三版/ 产物；原稿 原文基线_* 不动。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PROPER, DICT_CSV, loadKnownForms, isKnownForm, loadKbGloss } from './LayerText_AF词表与词典.mjs';

const P = (await import('./LayerText_AF词表与词典.mjs')).loadProject();
const SRC_BASE = P.原文目录;
const OUT_BASE = P.产物目录;
const DATE = P.日期;
const DRY = process.argv.includes('--dry');
const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const TAGS = ['A层85', 'M层75', 'B层60'];

const KNOWN_FORMS = loadKnownForms();
const KB = loadKbGloss();
const KB_WORDS = new Set(KB.keys());

/** 教师确认过的 KB 释义修正（KB 值在原语境里明显不对的少数例外） */
const GLOSS_OVERRIDE = new Map([
  ['stone', '石头'],   // KB: 二十四石=重量单位 —— 本篇为 "a stone in her hoof" 字面义
  ['hoof', '蹄子'],    // KB: 复数 hoofs/hooves —— 形态说明非释义
  ['pure', '纯净的'],  // KB: 比较级 purer —— 形态说明非释义
  ['empty', '空的'],   // KB: 空的，声音 —— 释义串扰
]);

const ANN_RE = /([A-Za-z][A-Za-z'-]*)（([^（）]{1,24})）/g;
const read = (p) => readFileSync(p, 'utf-8');
const pOf = (ch, tag) => join(OUT_BASE, `第${ch}章`, `原文_${tag}_${DATE}.md`);

/* ── ① 全局统计：同词多义 ── */
/** 畸形嵌套注释：模型把释义又注了一遍，产生 `Mollie（莫丽（名字））`、
 *  `hoof（复数 hoofs（蹄子）/hooves（蹄））`。ANN_RE 的 `[^（）]` 会整段跳过它们，
 *  所以必须先摊平成单层再走正常流程。 */
const NESTED_RE = /([A-Za-z][A-Za-z'-]*)（((?:[^（）]|（[^（）]*）)+)）/g;
function flattenNested(md) {
  return md.replace(NESTED_RE, (full, word, gloss) => {
    if (!gloss.includes('（')) return full;              // 单层正常注释，不动
    const zh = gloss.match(/[\u4e00-\u9fff]{1,6}/g);     // 取第一个中文串作释义
    return zh?.length ? `${word}（${zh[0]}）` : word;
  });
}

/** 字面 `[P##]` 占位符残留：模型把提示词模板原样吐了出来，真标记丢了。
 *  按位置序号补回真标记；若该行已带真标记（`[P##] [P12] …`）则只删占位符。 */
function fixMarkers(md) {
  const lines = md.split('\n');
  let idx = 0, inCard = false, fixed = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s*词句卡/.test(lines[i])) inCard = true;
    if (inCard) continue;
    if (/^\[P\d+\]\s/.test(lines[i])) { idx++; continue; }
    const bad = lines[i].match(/^\[P#+\]\s*(.*)$/);
    if (!bad) continue;
    idx++;
    const num = String(idx).padStart(2, '0');
    const real = bad[1].match(/^\[P(\d+)\]\s*(.*)$/);
    lines[i] = real ? `[P${num}] ${real[2]}` : `[P${num}] ${bad[1]}`;
    fixed++;
  }
  return { text: lines.join('\n'), fixed };
}

/* ── ① 全局统计：同词多义（先在摊平后的文本上统计，否则畸形注释会被漏算） ── */
const stat = new Map();
let nestedFixed = 0, markerFixed = 0;
for (const tag of TAGS) for (const ch of CN) {
  const p = pOf(ch, tag);
  const before = read(p);
  const flat = flattenNested(before);
  const mk = fixMarkers(flat);
  if (flat !== before) nestedFixed++;
  markerFixed += mk.fixed;
  for (const m of flat.matchAll(ANN_RE)) {
    const w = m[1].toLowerCase();
    if (!stat.has(w)) stat.set(w, new Map());
    const g = stat.get(w);
    g.set(m[2], (g.get(m[2]) ?? 0) + 1);
  }
}

/* ── 决策：每个词型 → 删除 or 归一 ── */
const removeSet = new Set();
const canonical = new Map();
const why = new Map();
for (const [w, glosses] of stat) {
  const total = [...glosses.values()].reduce((a, b) => a + b, 0);
  if (PROPER.includes(w)) { removeSet.add(w); why.set(w, ['专名', total]); continue; }
  if (KB_WORDS.has(w)) { canonical.set(w, GLOSS_OVERRIDE.get(w) ?? KB.get(w).zh); continue; }
  if (w === 'chapter') { removeSet.add(w); why.set(w, ['标题残留', total]); continue; }
  if (isKnownForm(w, KNOWN_FORMS)) { removeSet.add(w); why.set(w, ['词表已知', total]); continue; }
  const best = [...glosses.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0][0];
  canonical.set(w, best);
}

/* ── 文本修复 ── */
/** 缺空格修补：小写字母后紧跟 .!? 再接大写（排除 J.Smith 类首字母缩写）。
 *  替换串只能引用真实存在的捕获组——首版误写 '$1 $2'（只有 1 组），
 *  JS 把不存在的 $2 当字面量插入，污染 154 处，已回滚重来。 */
const fixSpacing = (t) => t
  .replace(/(?<=[a-z])([.!?])(?=[A-Z])/g, '$1 ')
  .replace(/([）)])(?=[A-Za-z])/g, '$1 ')
  .replace(/([A-Za-z])\s+（/g, '$1（')
  .replace(/ {2,}/g, ' ');

/** 段首 OCR 章节名残留：覆盖 "Chapter 2 " 与 "Chapter 2: " 两种形态 */
const stripP01 = (t) => t.replace(/^(\[P\d+\] )(?:Chapter\s+\d+\s*:?\s*)/gm, '$1');

function repairProduct(md) {
  const flat = flattenNested(md);                       // ① 畸形嵌套注释先摊平
  const { text: marked } = fixMarkers(flat);            // ② 字面 [P##] 补回真标记
  const out = marked.replace(ANN_RE, (full, word, gloss) => {
    const w = word.toLowerCase();
    if (removeSet.has(w)) return word;
    const c = canonical.get(w);
    return c && c !== gloss ? `${word}（${c}）` : full;
  });
  return fixSpacing(stripP01(out));
}

/* ── 执行 ── */
const changes = [];
for (const tag of TAGS) for (const ch of CN) {
  const p = pOf(ch, tag);
  const before = read(p);
  const after = repairProduct(before);
  if (before !== after) { changes.push({ p: `第${ch}章/原文_${tag}`, before, after }); if (!DRY) writeFileSync(p, after, 'utf-8'); }
}
for (const ch of CN) {
  const sp = join(SRC_BASE, `第${ch}章`, '原文_规范化.md');
  if (!existsSync(sp)) continue;
  const before = read(sp);
  const after = fixSpacing(stripP01(fixMarkers(flattenNested(before)).text));
  if (before !== after) { changes.push({ p: `原文重制_M50/第${ch}章/原文_规范化`, before, after }); if (!DRY) writeFileSync(sp, after, 'utf-8'); }
}

/* ── 写出注释词典 ── */
if (!DRY) {
  const rows = [['词', '释义', '来源']];
  for (const [w, zh] of [...canonical].sort((a, b) => a[0].localeCompare(b[0]))) {
    rows.push([w, zh, KB_WORDS.has(w) ? '教师知识库' : '归一（多数票）']);
  }
  writeFileSync(DICT_CSV, '\uFEFF' + rows.map((r) => r.join(',')).join('\n') + '\n', 'utf-8');
}

/* ── 报告 ── */
const totalAnn = [...stat.values()].reduce((a, g) => a + [...g.values()].reduce((x, y) => x + y, 0), 0);
const removed = [...removeSet].map((w) => ({ w, n: why.get(w)[1], why: why.get(w)[0] })).sort((a, b) => b.n - a.n);
const byWhy = {};
for (const r of removed) byWhy[r.why] = (byWhy[r.why] ?? 0) + r.n;
const multi = [...stat.entries()].filter(([, g]) => g.size > 1).length;
console.log(`${DRY ? '[DRY] ' : ''}改动文件：${changes.length} 个（产物 ${changes.filter((c) => c.p.startsWith('第')).length} + 源文 ${changes.filter((c) => c.p.startsWith('原文重制')).length}）`);
console.log(`畸形嵌套注释摊平：${nestedFixed} 个文件｜字面 [P##] 占位符补回真标记：${markerFixed} 处`);
console.log(`加注总数：${totalAnn} → ${totalAnn - removed.reduce((a, b) => a + b.n, 0)}（删 ${removed.reduce((a, b) => a + b.n, 0)} 次 / ${removed.length} 个词型）`);
console.log(`删除构成：${Object.entries(byWhy).map(([k, v]) => `${k} ${v} 次`).join(' / ')}`);
console.log(`归一释义词型：${[...canonical.keys()].filter((w) => !KB_WORDS.has(w)).length} 个（另 ${[...canonical.keys()].filter((w) => KB_WORDS.has(w)).length} 个来自教师知识库）`);
console.log(`修复前同词多义词型：${multi} 个`);
console.log(`\n词典 → ${DICT_CSV}${DRY ? '（DRY 未写）' : ''}`);
console.log('\n=== 删除清单（按次数）===');
console.log(removed.map((r) => `${r.w}×${r.n}(${r.why})`).join(', '));
