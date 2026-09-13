#!/usr/bin/env node
/** AF 待确认队列：把三路结论合成**教师只需要点的一张表**
 *
 * ## 为什么要有它
 *
 * 到 2026-09-13，机器能算出来的"该看的地方"散在两份 JSON 里，格式各异：
 *
 *   · `补注候选_<层>.json`     —— 未支持难词（引擎自己报的缺口），带模型填的中文候选与出处句
 *   · `正本核对_<日期>.json`   —— 教师词典/知识库登记过的词在产物里消失了（**判据最硬**）
 *
 * 教师要在 App 里看的是**一张表**：词 · 出处句 · 候选 · 两个键。本脚本把两路合并成
 * `待确认队列_<层>.json`，App 的「检 → 待确认」面板读它。
 *
 * ## 纪律
 *
 * · **重算不抹决定**：队列可以随时重跑，教师点过的 `status` 按稳定 ID 带回来（见 `mergePending`）
 * · **层的写法归一**：补注队列写 `A层85`、正本核对写 `A`——不归一就会出现"同一个词算两件事"
 * · **同处双来源合并成一条**，按更强的判据呈现（正本 > 补注），两个理由都留着
 *
 * ## 用法
 *
 *   node LayerText_AF待确认队列.mjs                    # 三层都生成
 *   node LayerText_AF待确认队列.mjs --tier A            # 只生成 A 层
 *   node LayerText_AF待确认队列.mjs --no-canon          # 不带正本核对那一批（只要补注）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SHARED = await import('./LayerText_AF词表与词典.mjs');
const P = SHARED.loadProject();
const OUT_BASE = P.产物目录;
const RUN_DIR = join(OUT_BASE, '_运行');
const DATE = P.日期;

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const has = (n) => argv.includes(n);
const TAGS = ['A层85', 'M层75', 'B层60'];
const TIERS = String(arg('--tier', 'A,M,B'))
  .split(',')
  .map((t) => t.trim())
  .map((t) => (t.length === 1 ? ({ A: 'A层85', M: 'M层75', B: 'B层60' }[t] ?? t) : t))
  .filter((t) => TAGS.includes(t));
const WITH_CANON = !has('--no-canon');

const { fromAnnotateItem, fromCanonRow, mergePending, pendingCountOf, normalizeTier } = await import(`${SHARED.distOf(P.引擎目录)}/src/core/pendingqueue.js`);

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    /* 有意兜底：文件不存在＝这一步还没跑过，是常态；坏 JSON 也要让下面按"没有"处理而不是崩。 */
    return null;
  }
};

/** 该词在该段产物里的出处句（带句是这套东西能用的前提）。 */
function sentenceOf(md, word, para) {
  if (!md) return '';
  const seg = md.match(new RegExp(`\\[${para}\\]([\\s\\S]*?)(?=\\[P\\d+\\]|$)`))?.[1] ?? md;
  const clean = seg.replace(/（[^）]*）/g, '');
  const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  for (const s of clean.split(/(?<=[.!?])\s+/)) if (re.test(s)) return s.replace(/\s+/g, ' ').trim().slice(0, 220);
  return clean.replace(/\s+/g, ' ').trim().slice(0, 220);
}

mkdirSync(RUN_DIR, { recursive: true });
const canonFile = join(RUN_DIR, `正本核对_${DATE}.json`);
const canon = WITH_CANON ? readJson(canonFile) : null;
if (WITH_CANON && !canon) console.log(`（没有 ${canonFile}——先跑 LayerText_AF正本核对.mjs 才能带上那一批）`);

let total = 0;
for (const tier of TIERS) {
  const annotateQ = readJson(join(RUN_DIR, `补注候选_${tier}.json`));
  const queuePath = join(RUN_DIR, `待确认队列_${tier}.json`);
  const previous = readJson(queuePath);

  const annotate = (annotateQ?.items ?? []).map(fromAnnotateItem);
  /* 正本核对是全书的（rows 里带 tier），按本层过滤——注意它的 tier 写法是 `A`，走 normalizeTier 归一 */
  const rows = (canon?.rows ?? []).filter((r) => normalizeTier(r.tier) === tier);
  const products = new Map();
  const canonItems = rows.map((r) =>
    fromCanonRow(r, (w, para) => {
      const key = r.chapter;
      if (!products.has(key)) {
        const f = join(OUT_BASE, r.chapter, `原文_${tier}_${DATE}_工序化.md`);
        products.set(key, existsSync(f) ? readFileSync(f, 'utf-8') : '');
      }
      return sentenceOf(products.get(key), w, para);
    }),
  );

  const items = mergePending(annotate, canonItems, previous?.items ?? []);
  writeFileSync(queuePath, `${JSON.stringify({ tier, items, fragments: annotateQ?.fragments ?? [], updatedAt: new Date().toISOString() }, null, 1)}\n`, 'utf-8');

  const todo = pendingCountOf(items);
  const star = items.filter((i) => !i.status && i.star).length;
  const rest = items.filter((i) => !i.status && i.kind === 'restore' && !i.star).length;
  const ann = items.filter((i) => !i.status && i.kind === 'annotate').length;
  console.log(`${tier}：待确认 ${todo} 条（★加注词 ${star}｜正本 ${rest}｜补注 ${ann}）｜已处理 ${items.length - todo} 条`);
  console.log(`  → ${queuePath}`);
  total += todo;

  /* 人看的表（App 打不开时也能在终端/编辑器里过） */
  const L = [
    `# 待确认 · ${tier} · ${DATE}`,
    '',
    '> 合并两路：**正本核对**（教师词典登记过的词在产物里消失了，判据最硬）＋ **补注候选**（未支持难词，模型填的中文）。',
    '> 每条给"词 · 出处句 · 中文候选"——教师在 App 的「检 → 待确认」里点确认，决定进校准台账（source: human）。',
    '',
    '| # | 判据 | 章 | 段 | 词 | 中文 | 出处句 |',
    '|---|---|---|---|---|---|---|',
  ];
  items
    .filter((i) => !i.status)
    .slice(0, 400)
    .forEach((i, n) => {
      const tag = i.star ? '★加注词' : i.kind === 'restore' ? '正本' : '补注';
      L.push(`| ${n + 1} | ${tag} | ${i.chapter} | ${i.para} | **${i.word}** | ${i.gloss} | ${i.sentence.slice(0, 60)} |`);
    });
  if (items.filter((i) => !i.status).length > 400) L.push(`| … | 其余见 JSON | | | | | |`);
  const done = items.filter((i) => i.status);
  if (done.length) {
    L.push('', `## 已处理 ${done.length} 条（重算队列不会让它们再冒出来）`, '');
    for (const d of done.slice(0, 60)) L.push(`- ${d.chapter} ${d.para} ${d.word} → ${d.status}`);
  }
  writeFileSync(join(OUT_BASE, `待确认_${tier}_${DATE}.md`), `${L.join('\n')}\n`, 'utf-8');
}
console.log(`\n三层合计待确认 ${total} 条。App：检 → 待确认`);
