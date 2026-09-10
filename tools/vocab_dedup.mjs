#!/usr/bin/env node
/** 词库去重合并（规范 v1 待办项）
 *
 * 背景：已知词汇库 v0.6 有 293 条重复 —— 教材词表与课标1600 合并时未去重，
 * 同一词来自不同来源册，且 261 个词型释义粒度不一致（政府 / 统治；支配；政府）。
 * 后果：释义查询结果随行序漂移。
 *
 * ⚠️ 硬约束：合并**不得改变"已知集合"**（known / pending）。
 *   引擎判据（src/core/lexicon.ts）：类型 ∈ {单词, 课标词, 待定词} → known；其中 待定词 另入 pending。
 *   所以合并时 类型 的取值优先级必须是 待定词 > 课标词 > 单词 > 其他，
 *   否则原本 pending 的词会被"洗白"，覆盖率数字随之变化。
 *
 * 用法：node tools/vocab_dedup.mjs <词库.csv> [--out 输出.csv] [--dry]
 *   默认输出到 <词库>_dedup.csv，不覆盖原文件。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { buildLexicon } from '../dist/src/core/lexicon.js';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const oi = args.indexOf('--out');
const src = args.filter((a) => !a.startsWith('--') && a !== (oi >= 0 ? args[oi + 1] : null))[0];
if (!src || !existsSync(src)) {
  console.error('用法: node tools/vocab_dedup.mjs <词库.csv> [--out 输出.csv] [--dry]');
  process.exit(2);
}
const out = oi >= 0 ? args[oi + 1] : src.replace(/\.csv$/i, '') + '_dedup.csv';

/* 宽容 CSV 解析（BOM / 引号 / CRLF） */
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
const csvCell = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

const text = readFileSync(src, 'utf-8');
const rows = parseCsv(text);
const header = rows[0].map((h) => h.trim());
const idx = (n) => header.indexOf(n);
const [iW, iT, iPos, iZ, iB, iU, iPh, iNote] = ['词', '类型', '词性', '释义', '来源册', '来源单元', '音标', '备注'].map(idx);

/** 类型优先级：待定词 > 课标词 > 单词 > 其他（保住 pending 归属） */
const TYPE_RANK = { 待定词: 0, 课标词: 1, 单词: 2 };
const rank = (t) => (TYPE_RANK[t] ?? 9);

const groups = new Map();
for (const r of rows.slice(1)) {
  const w = (r[iW] ?? '').trim();
  if (!w) continue;
  const key = w.toLowerCase();
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}

const merged = [];
let dupGroups = 0, dropped = 0;
const joinUniq = (arr, sep = '；') => [...new Set(arr.map((x) => (x ?? '').trim()).filter(Boolean))].join(sep);
const longest = (arr) => arr.map((x) => (x ?? '').trim()).filter(Boolean).sort((a, b) => b.length - a.length)[0] ?? '';

for (const rs of groups.values()) {
  if (rs.length > 1) dupGroups++;
  dropped += rs.length - 1;
  const types = rs.map((r) => (r[iT] ?? '').trim());
  const type = types.slice().sort((a, b) => rank(a) - rank(b))[0];
  // 词形取原样中最短的小写形式（保证与引擎 lower() 后的键一致）
  const word = rs.map((r) => (r[iW] ?? '').trim()).sort((a, b) => a.length - b.length)[0];
  const row = [];
  row[iW] = word;
  row[iT] = type;
  if (iPos >= 0) row[iPos] = joinUniq(rs.map((r) => r[iPos]), '；');
  if (iZ >= 0) row[iZ] = longest(rs.map((r) => r[iZ]));
  if (iB >= 0) row[iB] = joinUniq(rs.map((r) => r[iB]));
  if (iU >= 0) row[iU] = joinUniq(rs.map((r) => r[iU]));
  if (iPh >= 0) row[iPh] = rs.map((r) => (r[iPh] ?? '').trim()).find(Boolean) ?? '';
  if (iNote >= 0) row[iNote] = joinUniq(rs.map((r) => r[iNote]));
  merged.push(row);
}
merged.sort((a, b) => a[iW].toLowerCase().localeCompare(b[iW].toLowerCase()));

/* ── 硬校验：已知集合必须完全一致 ── */
const before = buildLexicon({ vocabCsvTexts: [text] });
const afterText = '\uFEFF' + [header, ...merged].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
const after = buildLexicon({ vocabCsvTexts: [afterText] });
const diff = (a, b) => [...a].filter((w) => !b.has(w));
const lostKnown = diff(before.known, after.known);
const addKnown = diff(after.known, before.known);
const lostPending = diff(before.pending, after.pending);
const addPending = diff(after.pending, before.pending);

console.log(`原文件：${rows.length - 1} 条 / ${groups.size} 词型｜重复词型 ${dupGroups}｜可去重 ${dropped} 条`);
console.log(`合并后：${merged.length} 条`);
console.log(`已知集合：${before.known.size} → ${after.known.size}（丢 ${lostKnown.length}，增 ${addKnown.length}）`);
console.log(`待定集合：${before.pending.size} → ${after.pending.size}（丢 ${lostPending.length}，增 ${addPending.length}）`);

const ok = !lostKnown.length && !addKnown.length && !lostPending.length && !addPending.length;
if (!ok) {
  console.error('\n✗ 已知/待定集合发生变化，拒绝写出。差异样例：');
  if (lostKnown.length) console.error(`  丢失 known: ${lostKnown.slice(0, 10).join(', ')}`);
  if (addKnown.length) console.error(`  新增 known: ${addKnown.slice(0, 10).join(', ')}`);
  if (lostPending.length) console.error(`  丢失 pending: ${lostPending.slice(0, 10).join(', ')}`);
  if (addPending.length) console.error(`  新增 pending: ${addPending.slice(0, 10).join(', ')}`);
  process.exit(1);
}
console.log('✓ 已知/待定集合完全一致');

if (DRY) { console.log('（--dry，未写出）'); process.exit(0); }
writeFileSync(out, afterText, 'utf-8');
console.log(`\n已写出 → ${out}`);
