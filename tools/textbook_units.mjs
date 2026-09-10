#!/usr/bin/env node
/** 人教版教材单元知识库 · 抽取与进度换算
 *
 * 两个能力：
 *   build    词库 CSV + 语法表 → 「册 × 单元 → {词, 语法}」教材单元知识库
 *   progress 给定「学到哪」→ 输出「已学词表 + 已学语法清单」（供生成提示词注入 / QC 口径）
 *
 * 为什么需要：教师说"我教人教版，上到八下 Unit 5"时，系统要能自动算出"哪些词、哪些语法学生学过"，
 * 而不是靠人工维护一份词表。
 *
 * 用法：
 *   node tools/textbook_units.mjs build    <词库.csv> [--grammar 教材语法_人教版.json] [--out 教材单元_人教版.json]
 *   node tools/textbook_units.mjs progress <教材单元.json> --at "八下:U5" [--half] [--out 已学词.txt]
 *
 * 进度写法：
 *   --at "八下:U5"    八下 U5 已学完（含之前所有册与单元）
 *   --half            --at 那个单元只学到一半（取该单元前半数词）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BOOK_ORDER = ['七上', '七下', '八上', '八下', '九上', '九下'];
const BASE_BOOKS = ['课标1600', '课标补丁'];
const ALL_BOOKS = ['七上', '七下', '八上', '八下', '九上', '九下'];

function parseCsv(text) {
  const rows = []; let row = [], cell = '', inQ = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else inQ = false; } else cell += c; }
    else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}
const splitMulti = (v) => (v ?? '').split('；').map((x) => x.trim()).filter(Boolean);
const unitNum = (u) => Number((u.match(/U(\d+)/i) ?? [])[1] ?? 999);
const normUnit = (u) => { const m = u.match(/U(\d+)/i); return m ? `U${m[1]}` : u; };

/* ══════════ build ══════════ */
function build(vocabPath, grammarPath, outPath) {
  const rows = parseCsv(readFileSync(vocabPath, 'utf-8'));
  const hdr = rows[0].map((h) => h.trim());
  const iW = hdr.indexOf('词'), iB = hdr.indexOf('来源册'), iU = hdr.indexOf('来源单元');

  const books = {};   // 册 → 单元 → {词:Set, 语法:[]}
  const base = new Set();
  const ensure = (b, u) => {
    books[b] ??= {};
    books[b][u] ??= { 词: new Set(), 语法: [] };
    return books[b][u];
  };

  for (const r of rows.slice(1)) {
    const w = (r[iW] ?? '').trim().toLowerCase();
    if (!w) continue;
    const bs = splitMulti(r[iB]);
    if (!bs.length) { base.add(w); continue; }
    let placed = false;
    for (const b of bs) {
      if (BASE_BOOKS.includes(b)) { base.add(w); placed = true; continue; }
      if (!BOOK_ORDER.includes(b)) continue;
      const us = splitMulti(r[iU]).map(normUnit);
      if (!us.length) { ensure(b, '（未标单元）').词.add(w); placed = true; continue; }
      for (const u of us) { ensure(b, u).词.add(w); placed = true; }
    }
    if (!placed) base.add(w);
  }

  // 合并语法
  let grammar = { books: {}, 缺册: ALL_BOOKS.slice() };
  if (grammarPath && existsSync(grammarPath)) grammar = JSON.parse(readFileSync(grammarPath, 'utf-8'));
  for (const [b, us] of Object.entries(grammar.books ?? {})) {
    for (const [u, v] of Object.entries(us)) {
      const un = normUnit(u);
      const cell = ensure(b, un);
      cell.语法 = [...new Set([...cell.语法, ...(v.语法 ?? [])])];
    }
  }

  // 缺口：整册没有任何词的册
  const 缺口 = ALL_BOOKS.filter((b) => !books[b]);
  const out = {
    _meta: {
      schema版本: '2', 数据版本: 'v1',
      名称: '人教版（新教材）教材单元知识库',
      生成: new Date().toLocaleString('zh-CN'),
      词汇来源: vocabPath,
      语法来源: grammarPath && existsSync(grammarPath) ? grammarPath : '（未提供）',
      说明: '单元形如 U1；「（未标单元）」是词库中只有册、无单元的条目。缺册见 缺口 字段，需另行补录。',
      基础层: BASE_BOOKS,
      覆盖: Object.keys(books).filter((b) => BOOK_ORDER.includes(b)),
      缺口: 缺口.length ? 缺口 : grammar.缺册?.filter((b) => !books[b]) ?? [],
    },
    base: [...base].sort(),
    books: Object.fromEntries(
      BOOK_ORDER.filter((b) => books[b]).map((b) => [
        b,
        Object.fromEntries(
          Object.entries(books[b])
            .sort((x, y) => unitNum(x[0]) - unitNum(y[0]))
            .map(([u, c]) => [u, { 词: [...c.词].sort(), 语法: c.语法 }]),
        ),
      ]),
    ),
  };
  writeFileSync(outPath, JSON.stringify(out, null, 1), 'utf-8');

  console.log(`基础层（${BASE_BOOKS.join(' + ')}）：${out.base.length} 词`);
  for (const [b, us] of Object.entries(out.books)) {
    const nw = Object.values(us).reduce((a, c) => a + c.词.length, 0);
    const ng = Object.values(us).reduce((a, c) => a + c.语法.length, 0);
    console.log(`  ${b}：${Object.keys(us).length} 单元 / ${nw} 词次 / ${ng} 个语法点`);
  }
  console.log(`缺口册：${out._meta.缺口.length ? out._meta.缺口.join(' ') : '无'}`);
  console.log(`\n✓ → ${outPath}`);
}

/* ══════════ progress ══════════ */
function progress(unitsPath, at, half, outPath) {
  const d = JSON.parse(readFileSync(unitsPath, 'utf-8'));
  const [bookRaw, unitRaw] = at.split(/[:：]/);
  const book = bookRaw.trim(), unit = normUnit(unitRaw ?? 'U1');
  if (!d.books[book]) throw new Error(`教材库中没有「${book}」，现有：${Object.keys(d.books).join('/')}`);

  const learned = new Set(d.base);
  const grammars = [];
  const detail = [];
  const bIdx = BOOK_ORDER.indexOf(book);

  // 基础层（课标1600 + 补录）先入账 —— 2026-09-10 修复：原先明细里不列这一行，
  // 于是"分项加起来 197 词、合计却报 1800"看着像算错了（差的 1614 就是它）。
  detail.push(`课标基础层（含数词/星期/月份补录）${d.base.length} 词`);

  for (const [b, us] of Object.entries(d.books)) {
    const bi = BOOK_ORDER.indexOf(b);
    if (bi < bIdx) {                     // 进度之前的所有册：全算已学（含"（未标单元）"）
      let n = 0, g = 0;
      for (const c of Object.values(us)) { c.词.forEach((w) => learned.add(w)); n += c.词.length; g += c.语法.length; grammars.push(...c.语法); }
      detail.push(`${b}（全册，含未标单元）${n} 词 / ${g} 语法`);
      continue;
    }
    if (b !== book) continue;
    let untagged = 0;
    for (const [u, c] of Object.entries(us).sort((x, y) => unitNum(x[0]) - unitNum(y[0]))) {
      const un = unitNum(u);
      if (un === 999) {                  // "（未标单元）"：只知册、不知单元
        // 口径：当前这册还没学完 → **不计入已学**（这些词可能来自后面的单元）。
        // 已学完的册走上面那条分支，全册计入。这样两个分支的规则是一致的。
        untagged += c.词.length;
        continue;
      }
      if (un < unitNum(unit)) {
        c.词.forEach((w) => learned.add(w));
        grammars.push(...c.语法);
        detail.push(`${b} ${u} ${c.词.length} 词 / ${c.语法.length} 语法`);
      } else if (un === unitNum(unit)) {
        const take = half ? c.词.slice(0, Math.ceil(c.词.length / 2)) : c.词;
        take.forEach((w) => learned.add(w));
        if (!half) grammars.push(...c.语法);
        else grammars.push(...c.语法.map((g) => `${g}（本单元学到一半，语法可能未讲完）`));
        detail.push(`${b} ${u}${half ? '（半）' : ''} ${take.length}/${c.词.length} 词 / ${c.语法.length} 语法`);
      }
    }
    if (untagged) detail.push(`${b}（未标单元）${untagged} 词 —— 未计入（本册未学完，无法判断来自哪个单元）`);
  }

  const list = [...learned].sort();
  writeFileSync(outPath, list.join('\n') + '\n', 'utf-8');
  const gpath = outPath.replace(/\.txt$/, '') + '_语法.md';
  writeFileSync(gpath,
    `# 已学语法清单（进度：${at}${half ? '（单元学到一半）' : ''}）\n\n` +
    `> 由 \`tools/textbook_units.mjs progress\` 生成｜${new Date().toLocaleString('zh-CN')}\n\n` +
    (grammars.length ? [...new Set(grammars)].map((g) => `- ${g}`).join('\n') : '_（无）_') + '\n', 'utf-8');

  console.log(`进度：${book} ${unit}${half ? '（半单元）' : ''}`);
  detail.forEach((s) => console.log('  + ' + s));
  console.log(`\n已学词合计：${list.length} 词 → ${outPath}`);
  console.log(`已学语法：${[...new Set(grammars)].length} 条 → ${gpath}`);
  [...new Set(grammars)].forEach((g) => console.log('  · ' + g));
}

/* ── CLI ── */
const [cmd, ...rest] = process.argv.slice(2);
const arg = (n, dflt) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : dflt; };
const flag = (n) => rest.includes(n);
const pos = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')));

try {
  if (cmd === 'build') {
    const src = pos[0];
    if (!src || !existsSync(src)) throw new Error('用法: build <词库.csv> [--grammar 教材语法_人教版.json] [--out 教材单元_人教版.json]');
    build(src, arg('--grammar', join(dirname(src), '教材语法_人教版.json')), arg('--out', join(dirname(src), '教材单元_人教版.json')));
  } else if (cmd === 'progress') {
    const src = pos[0];
    const at = arg('--at');
    if (!src || !at) throw new Error('用法: progress <教材单元.json> --at "八下:U5" [--half] [--out 已学词.txt]');
    progress(src, at, flag('--half'), arg('--out', '已学词.txt'));
  } else {
    console.error('用法:\n  node tools/textbook_units.mjs build    <词库.csv> [--grammar 教材语法_人教版.json] [--out 教材单元_人教版.json]\n' +
                  '  node tools/textbook_units.mjs progress <教材单元.json> --at "八下:U5" [--half] [--out 已学词.txt]');
    process.exit(2);
  }
} catch (e) { console.error('✗ ' + e.message); process.exit(1); }
