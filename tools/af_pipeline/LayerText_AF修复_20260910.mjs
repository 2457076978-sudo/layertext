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
import { loadProject, makeKnownChecker, loadKbGloss } from './LayerText_AF词表与词典.mjs';

const P = loadProject();
const PROPER = P.PROPER;

const SRC_BASE = P.原文目录;
const OUT_BASE = P.产物目录;
const DATE = P.日期;
const DRY = process.argv.includes('--dry');
// ── 层级/章节过滤（2026-09-10 补）：原先这三个脚本无条件处理 A/M/B 三档全章，
//    于是"只生成一层试跑"（如 --tier B --chapters 1）跑到「修复」必因找不到文件而崩，
//    换一本书/换一个层级试跑直接卡死。现在三个脚本都接受 --tier / --chapters。
const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const TAGS_ALL = { A: 'A层85', M: 'M层75', B: 'B层60' };
const TAGS = (argOf('--tier', 'A,M,B')).split(',').map((x) => x.trim().toUpperCase())
  .map((k) => TAGS_ALL[k]).filter(Boolean);
const { makeResolver } = await import(`${P.引擎目录}/dist/src/core/manifest.js`);
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
const CN_ALL = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
/** 章号（数字，1 起）：路径与台账都按它取中文章名 */
const CHAPTER_IDS = argOf('--chapters', '')
  ? argOf('--chapters').split(',').map((x) => Number(x.trim())).filter((n) => n >= 1 && n <= 10)
  : CN_ALL.slice(0, Number(P.章数 ?? 10)).map((_, i) => i + 1);
const CH_NAME = (ci) => `第${CN_ALL[ci - 1]}章`;


// 与 QC 同一套已知判定（否则出现「我删了、引擎却还判它生词」，覆盖率两边打架）
const isKnown = await makeKnownChecker(P);
const KB = loadKbGloss(P.知识库路径);
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
const pOf = (ch, tag) => RR(tag).any('正文', { chapter: ch });

/* ── ① 全局统计：同词多义 ── */
/** 畸形嵌套注释：模型把释义又注了一遍，产生 `Mollie（莫丽（名字））`、
 *  `hoof（复数 hoofs（蹄子）/hooves（蹄））`。ANN_RE 的 `[^（）]` 会整段跳过它们，
 *  所以必须先摊平成单层再走正常流程。 */
/** 嵌套注释的**判定与摊平**统一走引擎的 AST（src/core/docast.ts）。
 *  原先这里自己写了一条 NESTED_RE：它只能处理一层嵌套，而且和引擎其它地方的
 *  "什么算一条注释"口径不完全一致——又是一次口径漂移。
 *  现在按括号深度扫描（能处理任意深度），并保留 `word（第一个中文串）` 的既有语义。 */
const { flattenNestedAnnotations } = await import(`${P.引擎目录}/dist/src/core/docast.js`);

function flattenNested(md) {
  return flattenNestedAnnotations(md).md;
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
for (const tag of TAGS) for (const ci of CHAPTER_IDS) {
  const ch = CH_NAME(ci);
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
  if (isKnown(w)) { removeSet.add(w); why.set(w, ['词表已知', total]); continue; }
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

/** 重复释义：模型自己吐出 `word (中文)`（半角括号），补注又按冻结格式加了 `word（中文）`，
 *  于是留下 `arrow（箭头） (箭)`、`hoofs（蹄） (蹄子)` 这种双份。
 *  规则：只删**半角括号且内含中文**的那份，英文括注（如 `(no bits or reins)`）原样保留。 */
const DUP_GLOSS_RE = /([A-Za-z][A-Za-z'-]*（[^）]{1,24}）)\s*[（(]\s*[\u4e00-\u9fff][^)）]{0,20}[)）]/g;
function dropDuplicateGloss(md) {
  return md.replace(DUP_GLOSS_RE, '$1');
}

function repairProduct(md) {
  md = dropDuplicateGloss(md);
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
for (const tag of TAGS) for (const ci of CHAPTER_IDS) {
  const ch = CH_NAME(ci);
  const p = pOf(ch, tag);
  const before = read(p);
  const after = repairProduct(before);
  if (before !== after) { changes.push({ p: `${ch}/原文_${tag}`, before, after }); if (!DRY) writeFileSync(p, after, 'utf-8'); }
}
for (const ci of CHAPTER_IDS) {
  const ch = CH_NAME(ci);
  const sp = join(SRC_BASE, ch, '原文_规范化.md');
  if (!existsSync(sp)) continue;
  const before = read(sp);
  const after = fixSpacing(stripP01(fixMarkers(flattenNested(before)).text));
  if (before !== after) { changes.push({ p: `${ch}/原文_规范化`, before, after }); if (!DRY) writeFileSync(sp, after, 'utf-8'); }
}

/* ── 写出注释词典 ── */
if (!DRY) {
  const rows = [['词', '释义', '来源']];
  for (const [w, zh] of [...canonical].sort((a, b) => a[0].localeCompare(b[0]))) {
    rows.push([w, zh, KB_WORDS.has(w) ? '教师知识库' : '归一（多数票）']);
  }
  writeFileSync(P.词典路径, '\uFEFF' + rows.map((r) => r.join(',')).join('\n') + '\n', 'utf-8');
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
console.log(`\n词典 → ${P.词典路径}${DRY ? '（DRY 未写）' : ''}`);
console.log('\n=== 删除清单（按次数）===');
console.log(removed.map((r) => `${r.w}×${r.n}(${r.why})`).join(', '));
