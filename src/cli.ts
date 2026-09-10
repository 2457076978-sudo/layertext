#!/usr/bin/env node
/**
 * LayerText CLI（M1）
 *
 * 用法：
 *   node dist/src/cli.js qc <候选md> [选项]
 *
 * 选项：
 *   --tier A|B|M        层级（默认 M）
 *   --vocab <csv>       自定义词库 CSV，可多次（教材已学词等）
 *   --reinforce <file>  已学词集/复现队列（txt 一行一词或 CSV 首列），可多次：
 *                       ①队列词不再计 OOV ②报告新增⑩复现命中指标（队列/命中/词次）
 *   --wordlist <txt>    纯文本词表，可多次（省略则用内置课标 1600 词表）
 *   --terms <txt>       术语表（一行一词，# 注释）
 *   --proper <txt>      专名表（一行一词）
 *   --anchor "短语"     锚点豁免短语，可多次
 *   --tag <t>           报告文件后缀（默认按文件名推导：A层→A / v0.2→v02 / v01）
 *   --out <file>        指定报告 JSON 落盘路径（默认写到输入文件同目录）
 *
 * 报告自动落盘（无需 --out）：输入文件所在目录 / 质检报告_<tag>.json
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { findAssetPath, readWordFile } from './core/files.js';
import { buildLexicon, parseReinforceText } from './core/lexicon.js';
import { runQc, toLegacyReport, type Tier } from './core/qc.js';
import { chnoFromPath, tagFromPath } from './core/textpipe.js';
import { parseZipfTable, triageOov, TRIAGE_RANK, type ZipfTable } from './core/wordfreq.js';
import { planFsrs, summarizeFsrs, type FsrsWordInput } from './core/fsrs.js';

/** fsrs 子命令：复现队列（"词,hits" CSV 或纯词列表=hits 0）→ FSRS 建议间隔 vs 现行固定策略并排。
 *  画像侧回写脚本可调本命令拿对照表（数据只存本地，不进仓）。 */
function fsrsMain(argv: string[]): void {
  const path = argv[0];
  if (!path) {
    console.error('用法: node dist/src/cli.js fsrs <复现队列.csv|txt> [--days-per-piece 3] [--current-pieces 2]');
    process.exit(2);
  }
  const flags: Record<string, string> = {};
  for (let i = 1; i < argv.length; i += 2) {
    const k = argv[i];
    if (!k?.startsWith('--')) {
      console.error(`无法识别的参数: ${k}`);
      process.exit(2);
    }
    flags[k.slice(2)] = argv[i + 1] ?? '';
  }
  // 输入宽容：CSV/TSV 首列=词、次列=已复现次数（无次列=0）；# 注释跳过
  const items: FsrsWordInput[] = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const cells = t.split(/[,;\t]/);
    const word = cells[0]?.trim().toLowerCase();
    if (!word || /[^a-z' -]/.test(word) || /^(词|word)$/i.test(word)) continue; // 剥表头
    const hits = Number(cells[1]?.trim() ?? '0');
    items.push({ word, hits: Number.isFinite(hits) && hits > 0 ? Math.floor(hits) : 0 });
  }
  if (!items.length) {
    console.error('队列里没有有效词条（首列=词，可选次列=已复现次数）');
    process.exit(2);
  }
  const rows = planFsrs(items, {
    ...(flags['days-per-piece'] ? { daysPerPiece: Number(flags['days-per-piece']) } : {}),
    ...(flags['current-pieces'] ? { currentPieces: Number(flags['current-pieces']) } : {}),
  });
  console.log('词            已复现  FSRS建议(篇)  现行(篇)');
  for (const r of rows) console.log(`${r.word.padEnd(14)}${String(r.hits).padEnd(8)}${String(r.nextPieces).padEnd(15)}${r.currentPieces}${r.nextPieces !== r.currentPieces ? '   ←' : ''}`);
  const s = summarizeFsrs(rows);
  console.error(`\n汇总：${s.total} 词，FSRS 平均建议隔 ${s.avgPieces} 篇 vs 现行固定 ${s.currentPieces} 篇；${s.differCount} 词建议不同——并行试点口径，学期末对比后再定切换。`);
}

const BUNDLED_WORDLIST = 'assets/wordlists/curriculum_2022_level3_1600.txt';
const AMENDMENT_WORDLIST = 'assets/wordlists/curriculum_2022_amendment.txt'; // 数词/星期/月份等存档缺失块（见文件头注释）
const BUNDLED_ZIPF = 'assets/wordfreq/en_zipf.tsv'; // wordfreq 导出（tools/export_zipf.py），OOV 疑似漏收分诊先验

/** zipf 词频先验表：找到才启用 OOV 分诊列，缺失时报告保持旧 schema */
function bundledZipfTable(): ZipfTable | undefined {
  const p = findAssetPath(BUNDLED_ZIPF);
  return p ? parseZipfTable(readFileSync(p, 'utf-8')) : undefined;
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv[0] === 'fsrs') return fsrsMain(argv.slice(1));
  if (argv[0] !== 'qc' || !argv[1] || argv[1].startsWith('--')) {
    console.error(
      '用法: node dist/src/cli.js qc <候选md> [--tier A|B|M] [--vocab x.csv]... [--reinforce 已学词.txt]... [--wordlist x.txt]... [--terms x.txt] [--proper x.txt] [--anchor "短语"]... [--tag t] [--out file]\n' +
        '     node dist/src/cli.js fsrs <复现队列.csv|txt> [--days-per-piece 3] [--current-pieces 2]   # FSRS vs 现行固定策略并排（并行试点）',
    );
    process.exit(2);
  }
  const path = argv[1];
  const opts: Record<string, string[]> = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      console.error(`无法识别的参数: ${a}`);
      process.exit(2);
    }
    const key = a.slice(2);
    const val = argv[i + 1];
    if (!val || val.startsWith('--')) {
      console.error(`参数 ${a} 需要值`);
      process.exit(2);
    }
    i++;
    (opts[key] ??= []).push(val);
  }

  const tier = (opts.tier?.[0] as Tier) ?? 'M';
  const vocabPaths = opts.vocab ?? [];
  let wordlistPaths = opts.wordlist ?? [];
  if (wordlistPaths.length === 0) {
    const bundled = findAssetPath(BUNDLED_WORDLIST);
    const amendment = findAssetPath(AMENDMENT_WORDLIST);
    wordlistPaths = [bundled, amendment].filter((x): x is string => x !== null);
    if (wordlistPaths.length === 0) console.error('提示：未找到内置课标词表（assets/wordlists/），请先用 tools/convert_wordlist.py 生成或用 --wordlist 指定');
  }
  const terms = opts.terms ? opts.terms.flatMap(readWordFile) : [];
  const proper = opts.proper ? opts.proper.flatMap(readWordFile) : [];
  const reinforce = (opts.reinforce ?? []).flatMap((p) => parseReinforceText(readFileSync(p, 'utf-8')));

  const md = readFileSync(path, 'utf-8');
  const lex = buildLexicon({
    vocabCsvTexts: vocabPaths.map((p) => readFileSync(p, 'utf-8')),
    plainWordlistTexts: wordlistPaths.map((p) => readFileSync(p, 'utf-8')),
    terms,
    properNouns: proper,
  });

  const result = runQc(md, lex, {
    tier,
    chno: chnoFromPath(path),
    anchors: opts.anchor ?? [],
    propCheckList: proper, // 引擎只读（filter），直接传引用
    fileName: basename(path),
    ...(reinforce.length ? { reinforceWords: reinforce } : {}),
  });
  const report = toLegacyReport(result);

  // zipf 分诊（调研〇-3 第一级）：只加报告字段，不动引擎 schema 与判定
  const zipf = bundledZipfTable();
  const triaged = zipf
    ? (report['OOV词(去重)'] as string[])
        .map((w) => triageOov(w, zipf))
        .sort((a, b) => TRIAGE_RANK[a.triage] - TRIAGE_RANK[b.triage] || (b.zipf ?? 0) - (a.zipf ?? 0))
    : undefined;
  const outReport = { ...report, ...(triaged ? { OOV分诊: triaged } : {}) };

  const { 'OOV词(去重)': oov, ...rest } = outReport as Record<string, unknown>;
  console.log(JSON.stringify(rest, null, 1));
  console.log('OOV:', (oov as string[]).slice(0, 40));
  if (triaged) {
    const suspects = triaged.filter((t) => t.triage === 'suspect');
    console.log(`疑似漏收（zipf≥4 高频未收，教师核对后入库）${suspects.length} 词:`, suspects.map((t) => `${t.word}(${t.zipf?.toFixed(1)})`).join(' ') || '无');
  }

  const tag = opts.tag?.[0] ?? tagFromPath(path);
  const outPath = opts.out?.[0] ?? join(dirname(resolve(path)), `质检报告_${tag}.json`);
  writeFileSync(outPath, JSON.stringify(outReport, null, 1), 'utf-8');
  console.error(`报告已落盘: ${outPath}`);
}

main();
