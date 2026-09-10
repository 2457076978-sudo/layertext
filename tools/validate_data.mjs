#!/usr/bin/env node
/** LayerText 数据格式校验（规范 v1 第五节的落地件）
 *
 * 为什么必须有：数据由**云端 API 填**，一定会出现"看起来对但解析不了"的情况。
 * 这就是把本项目在文本上的"三层把关"搬到数据上——AI 生成 → 确定性校验 → 不通过则重填。
 *
 * 用法：
 *   node tools/validate_data.mjs <文件> [--type 词库|分层|画像|知识库|词典|专名]
 *   node tools/validate_data.mjs <目录> --all        # 批量校验目录下可识别的数据文件
 *   加 --json 输出机器可读结果（供 AI 读后自行修正）
 *
 * 退出码：0 = 全部通过；1 = 有问题；2 = 用法错误
 * 规范见 docs/数据格式规范_v1.md
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { basename, join, extname } from 'node:path';

const SCHEMA_VERSION = '1';

/* ────────────────────────── 类型识别 ────────────────────────── */
/** 判类型：**内容优先，文件名只作兜底**。
 *  2026-09-10 修复：原先"分层"靠文件名 `/^分层/` 命中，于是派生的 `分层名单_v0.2.csv`
 *  （逐生名单，CSV）被当成"分层"（JSON）去解析，`--all` 在真实目录上必然报一条假失败。
 *  真实世界里"名字像"和"内容是"经常不是一回事，所以先看内容。 */
function detectType(file, text) {
  const n = basename(file);
  const head = text.slice(0, 2000);
  const firstLine = head.split('\n')[0].replace(/^\uFEFF/, '').trim();
  // ① 内容嗅探（不依赖文件名）
  if (head.trimStart().startsWith('{')) {
    if (head.includes('"groups"') || head.includes('"targets"')) return '分层';
    if (head.includes('"students"')) return '画像';
    return null;
  }
  if (firstLine.startsWith('词,类型,词性')) return '词库';
  if (firstLine.startsWith('类型,词,值')) return '知识库';
  if (firstLine.startsWith('词,释义')) return '词典';
  // ② 文件名兜底（只对"没有表头可嗅探"的类型：分层/画像/专名）
  if (/^分层.*\.json$/.test(n)) return '分层';
  if (/^画像.*\.json$/.test(n)) return '画像';
  if (extname(file) === '.txt') {
    if (/专名/.test(n)) return '专名';
    // 一行一名、且规模像"专名表"（课标1600 那种整册词表不算，它是词表不是专名表）
    const lines = head.split('\n').map((x) => x.trim()).filter((x) => x && !x.startsWith('#'));
    if (lines.length && lines.length <= 400 && lines.every((l) => /^[a-z][a-z '-]*$/.test(l))) return '专名';
  }
  return null;
}

/** 目录扫描时该不该跳过：历史版本、备份、派生名单都不该报错——
 *  它们不是"当前正本"，报出来只会淹没有效信息（2026-09-10 修：真目录 --all 一片红）。 */
function shouldSkip(name) {
  if (name.startsWith('.')) return true;
  if (/\.bak[_0-9]*/.test(name)) return true;
  if (/历史版本|_历史|_归档|备份/.test(name)) return true;
  // 派生件（由正本生成，不是正本）：分层名单、已学词表、台账
  if (/^分层名单|^已学词|^台账|^三档汇总/.test(name)) return true;
  return false;
}

/* ────────────────────────── 通用工具 ────────────────────────── */
const ERR = (kind, where, msg) => ({ kind, where, msg });

/** 宽容 CSV 解析（处理 BOM、引号内逗号、CRLF） */
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', inQ = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

const isPosInt = (v) => Number.isInteger(Number(v)) && Number(v) > 0;
const REQUIRED_META = ['schema版本'];

function checkMeta(meta, errs, where) {
  if (!meta || typeof meta !== 'object') { errs.push(ERR('缺失', where, '_meta 不存在（规范要求每个 JSON 数据文件带 _meta）')); return; }
  for (const k of REQUIRED_META) if (meta[k] === undefined) errs.push(ERR('必填缺失', `${where}._meta.${k}`, '缺少字段'));
  if (meta.schema版本 !== undefined && String(meta.schema版本) !== SCHEMA_VERSION) {
    errs.push(ERR('版本不匹配', `${where}._meta.schema版本`, `实际 ${meta.schema版本}，本校验器支持 ${SCHEMA_VERSION}`));
  }
}

/* ────────────────────────── 各类型校验 ────────────────────────── */
function validateVocab(text) {
  const errs = [], warns = [];
  const rows = parseCsv(text);
  if (!rows.length) return { errs: [ERR('空文件', '词库', '无内容')], warns, summary: {} };
  const hdr = rows[0].map((h) => h.trim());
  const need = ['词', '类型', '来源册'];
  for (const k of need) if (!hdr.includes(k)) errs.push(ERR('表头缺失', `词库.表头`, `缺少必填列「${k}」，实际列：${hdr.join(',')}`));
  const iWord = hdr.indexOf('词'), iType = hdr.indexOf('类型'), iBook = hdr.indexOf('来源册'), iGloss = hdr.indexOf('释义');
  const seen = new Map();   // 词 → Set(释义)
  rows.slice(1).forEach((r, k) => {
    const line = k + 2;
    const w = (r[iWord] ?? '').trim();
    if (!w) { errs.push(ERR('必填缺失', `词库 第${line}行.词`, '为空')); return; }
    const key = w.toLowerCase();
    if (seen.has(key)) warns.push(ERR('重复条目', `词库 第${line}行.词`, `「${w}」重复出现（同一词来自多个来源册时常见；但会让释义查询结果不确定，建议合并）`));
    else seen.set(key, new Set());
    if (iGloss >= 0) seen.get(key).add((r[iGloss] ?? '').trim());
    const t = (r[iType] ?? '').trim();
    if (t && !['单词', '课标词', '短语', '句型', '待定词'].includes(t)) warns.push(ERR('取值可疑', `词库 第${line}行.类型`, `「${t}」不在 单词/短语 内`));
    if (iBook >= 0 && !(r[iBook] ?? '').trim()) errs.push(ERR('必填缺失', `词库 第${line}行.来源册`, '为空（判定锚必须可溯源）'));
  });
  // 同词多释义：多为"粒度不一致"（政府 vs 统治；支配；政府），但会让释义查询随行序漂移
  let conflict = 0;
  for (const zs of seen.values()) if (zs.size > 1) conflict++;
  if (conflict) warns.push(ERR('同词多释义', '词库', `${conflict} 个词型有多种释义（如不同来源册粒度不一致），建议合并保留最完整的一条`));
  return { errs, warns, summary: { 词条数: rows.length - 1, 词型数: seen.size, 重复: rows.length - 1 - seen.size } };
}

function validateGroups(text) {
  const errs = [], warns = [];
  let d;
  try { d = JSON.parse(text); } catch (e) { return { errs: [ERR('解析失败', '分层', `JSON 无法解析：${e.message}`)], warns, summary: {} }; }
  checkMeta(d._meta, errs, '分层');
  const groups = d.groups;
  if (!Array.isArray(groups)) { errs.push(ERR('结构错误', '分层.groups', '必须是数组（规范 v1：不再用 targets）')); return { errs, warns, summary: {} }; }
  const ids = new Set();
  groups.forEach((g, i) => {
    const p = `分层.groups[${i}]`;
    // 成员数 仅对「组」必填（个人条目无此字段——2026-09-10 依实测修正）
    const need = ['id', '名称', '类型', '句长上限', '覆盖目标'];
    if (g.类型 === '组') need.push('成员数');
    for (const k of need) {
      if (g[k] === undefined || g[k] === '') errs.push(ERR('必填缺失', `${p}.${k}`, '缺少字段'));
    }
    if (g.id) { if (ids.has(g.id)) errs.push(ERR('重复', `${p}.id`, `「${g.id}」重复`)); ids.add(g.id); }
    if (g.类型 && !['组', '人'].includes(g.类型)) errs.push(ERR('取值非法', `${p}.类型`, `「${g.类型}」，允许：组 / 人`));
    if (g.句长上限 !== undefined && !isPosInt(g.句长上限)) errs.push(ERR('类型错误', `${p}.句长上限`, `须为正整数，实际「${g.句长上限}」`));
    if (g.成员数 !== undefined && !isPosInt(g.成员数)) errs.push(ERR('类型错误', `${p}.成员数`, `须为正整数，实际「${g.成员数}」`));
    if (g.覆盖目标 !== undefined && (isNaN(Number(g.覆盖目标)) || Number(g.覆盖目标) < 0 || Number(g.覆盖目标) > 100)) {
      errs.push(ERR('取值非法', `${p}.覆盖目标`, `须为 0–100，实际「${g.覆盖目标}」`));
    }
    for (const arr of ['已学词', '到期词']) {
      if (g[arr] !== undefined && !Array.isArray(g[arr])) errs.push(ERR('类型错误', `${p}.${arr}`, '必须是数组'));
    }
  });
  return { errs, warns, summary: { 组数: groups.length, 合计人数: groups.filter((g) => g.类型 === '组').reduce((a, g) => a + (Number(g.成员数) || 0), 0) } };
}

function validateProfile(text) {
  const errs = [], warns = [];
  let d;
  try { d = JSON.parse(text); } catch (e) { return { errs: [ERR('解析失败', '画像', `JSON 无法解析：${e.message}`)], warns, summary: {} }; }
  checkMeta(d._meta, errs, '画像');
  if (!Array.isArray(d.students)) { errs.push(ERR('结构错误', '画像.students', '必须是数组（规范 v1）')); return { errs, warns, summary: {} }; }
  const layers = { A: 0, M: 0, B: 0 };
  d.students.forEach((s, i) => {
    const p = `画像.students[${i}]`;
    if (!s.姓名) errs.push(ERR('必填缺失', `${p}.姓名`, '缺少姓名'));
    if (!s.层) errs.push(ERR('必填缺失', `${p}.层`, '缺少分层'));
    else if (!['A', 'M', 'B'].includes(s.层)) errs.push(ERR('取值非法', `${p}.层`, `「${s.层}」，允许：A / M / B`));
    else layers[s.层]++;
    if (s.已学词集 !== undefined && (typeof s.已学词集 !== 'object' || Array.isArray(s.已学词集))) {
      errs.push(ERR('类型错误', `${p}.已学词集`, '应为对象 {词: {source,since,hits}}'));
    }
  });
  return { errs, warns, summary: { 学生数: d.students.length, 分层: `A${layers.A}/M${layers.M}/B${layers.B}` } };
}

function validateBookCsv(text, kind) {
  const errs = [], warns = [];
  const rows = parseCsv(text);
  if (!rows.length) return { errs: [ERR('空文件', kind, '无内容（新书可从空表头开始，但需有表头）')], warns, summary: {} };
  const hdr = rows[0].map((h) => h.trim());
  if (kind === '知识库') {
    for (const k of ['类型', '词', '值']) if (!hdr.includes(k)) errs.push(ERR('表头缺失', `${kind}.表头`, `缺少「${k}」，实际：${hdr.join(',')}`));
    const iT = hdr.indexOf('类型'), iW = hdr.indexOf('词');
    const seen = new Set();
    rows.slice(1).forEach((r, k) => {
      const line = k + 2, t = (r[iT] ?? '').trim(), w = (r[iW] ?? '').trim().toLowerCase();
      if (!['加注词', '换词倾向'].includes(t)) errs.push(ERR('取值非法', `${kind} 第${line}行.类型`, `「${t}」，允许：加注词 / 换词倾向`));
      if (!w) errs.push(ERR('必填缺失', `${kind} 第${line}行.词`, '为空'));
      if (w && w !== w.toLowerCase()) warns.push(ERR('建议小写', `${kind} 第${line}行.词`, `「${w}」应小写`));
      // 2026-09-10 统一口径：同型同词重复 = 错误（面板也是这么判的，2026-09-10 之前这里只给警告，
      // 于是"知识库里 harness 有两条不同释义"在命令行看着没事、在 App 里却直接冻结整个标签页）
      if (w) { const key = `${t}:${w}`; if (seen.has(key)) errs.push(ERR('重复', `${kind} 第${line}行`, `「${t}:${w}」已出现（同型同词只能有一行）`)); seen.add(key); }
    });
    return { errs, warns, summary: { 条目数: rows.length - 1 } };
  }
  // 词典
  for (const k of ['词', '释义', '来源']) if (!hdr.includes(k)) errs.push(ERR('表头缺失', `${kind}.表头`, `缺少「${k}」，实际：${hdr.join(',')}`));
  const iW = hdr.indexOf('词'), iZ = hdr.indexOf('释义');
  const byWord = new Map();
  rows.slice(1).forEach((r, k) => {
    const line = k + 2, w = (r[iW] ?? '').trim().toLowerCase(), z = (r[iZ] ?? '').trim();
    if (!w) errs.push(ERR('必填缺失', `${kind} 第${line}行.词`, '为空'));
    if (!z) errs.push(ERR('必填缺失', `${kind} 第${line}行.释义`, '为空'));
    if (!byWord.has(w)) byWord.set(w, new Set());
    byWord.get(w).add(z);
  });
  for (const [w, zs] of byWord) {
    if (zs.size > 1) errs.push(ERR('同词多义', `${kind}.${w}`, `出现 ${zs.size} 种释义：${[...zs].join(' / ')}（规范冻结：一词只允许一个释义）`));
  }
  return { errs, warns, summary: { 词型数: byWord.size } };
}

function validateProper(text) {
  const errs = [], warns = [];
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) errs.push(ERR('空文件', '专名', '无内容'));
  const seen = new Set();
  lines.forEach((l, i) => {
    if (/^#/.test(l)) return;
    if (l !== l.toLowerCase()) warns.push(ERR('建议小写', `专名 第${i + 1}行`, `「${l}」应小写`));
    if (!/^[a-z][a-z '-]*$/.test(l)) errs.push(ERR('格式错误', `专名 第${i + 1}行`, `「${l}」含非法字符`));
    if (seen.has(l)) warns.push(ERR('重复', `专名 第${i + 1}行`, `「${l}」重复`));
    seen.add(l);
  });
  return { errs, warns, summary: { 专名数: seen.size } };
}

/* ────────────────────────── 主流程 ────────────────────────── */
const VALIDATORS = { 词库: validateVocab, 分层: validateGroups, 画像: validateProfile, 专名: validateProper };

function runOne(file, type) {
  if (!existsSync(file)) return { file, type: type ?? '?', errs: [ERR('文件不存在', file, '')], warns: [], summary: {} };
  const text = readFileSync(file, 'utf-8');
  const t = type ?? detectType(file, text);
  if (!t) return { file, type: '?', errs: [ERR('类型未知', file, '无法识别，请用 --type 指定')], warns: [], summary: {} };
  const fn = VALIDATORS[t] ?? ((x) => validateBookCsv(x, t));
  const r = fn(text);
  return { file, type: t, ...r };
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const ti = args.indexOf('--type');
const forcedType = ti >= 0 ? args[ti + 1] : null;
const targets = args.filter((a) => !a.startsWith('--') && a !== forcedType);

if (!targets.length) {
  console.error('用法: node tools/validate_data.mjs <文件或目录> [--type 词库|分层|画像|知识库|词典|专名] [--all] [--json]');
  process.exit(2);
}

const files = [];
const skipped = [];
for (const t of targets) {
  if (statSync(t).isDirectory()) {
    for (const f of readdirSync(t)) {
      if (!/\.(csv|json|txt)$/i.test(f)) continue;
      if (shouldSkip(f)) { skipped.push(f); continue; }
      const full = join(t, f);
      let ty;
      try {
        ty = forcedType ?? detectType(full, readFileSync(full, 'utf-8'));
      } catch { continue; }
      if (ty) files.push({ full, ty });
      else skipped.push(f);
    }
  } else files.push({ full: t, ty: forcedType });
}

const results = files.map(({ full, ty }) => runOne(full, ty));
const bad = results.filter((r) => r.errs.length);

if (asJson) {
  console.log(JSON.stringify({ 通过: results.length - bad.length, 失败: bad.length, 结果: results, 跳过: skipped }, null, 1));
} else {
  for (const r of results) {
    const mark = r.errs.length ? '✗' : '✓';
    const sum = Object.entries(r.summary ?? {}).map(([k, v]) => `${k} ${v}`).join('｜');
    console.log(`${mark} [${r.type}] ${basename(r.file)}${sum ? '  —— ' + sum : ''}`);
    r.errs.forEach((e, i) => console.log(`    ${i + 1}. [${e.kind}] ${e.where}：${e.msg}`));
    r.warns.forEach((e) => console.log(`    ⚠ [${e.kind}] ${e.where}：${e.msg}`));
  }
  // 历史版本/备份/派生件不算"失败"，但也别让人以为它们被漏检了
  if (skipped.length) {
    console.log(`\n（跳过 ${skipped.length} 个：历史版本 / 备份 / 派生件 / 非数据文件——它们不是当前正本）`);
  }
  console.log(`\n合计 ${results.length} 个文件：通过 ${results.length - bad.length}，失败 ${bad.length}`);
}
process.exit(bad.length ? 1 : 0);
