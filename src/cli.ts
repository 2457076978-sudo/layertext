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

const BUNDLED_WORDLIST = 'assets/wordlists/curriculum_2022_level3_1600.txt';
const AMENDMENT_WORDLIST = 'assets/wordlists/curriculum_2022_amendment.txt'; // 数词/星期/月份等存档缺失块（见文件头注释）

function main(): void {
  const argv = process.argv.slice(2);
  if (argv[0] !== 'qc' || !argv[1] || argv[1].startsWith('--')) {
    console.error(
      '用法: node dist/src/cli.js qc <候选md> [--tier A|B|M] [--vocab x.csv]... [--reinforce 已学词.txt]... [--wordlist x.txt]... [--terms x.txt] [--proper x.txt] [--anchor "短语"]... [--tag t] [--out file]',
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

  const { 'OOV词(去重)': oov, ...rest } = report as Record<string, unknown>;
  console.log(JSON.stringify(rest, null, 1));
  console.log('OOV:', (oov as string[]).slice(0, 40));

  const tag = opts.tag?.[0] ?? tagFromPath(path);
  const outPath = opts.out?.[0] ?? join(dirname(resolve(path)), `质检报告_${tag}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 1), 'utf-8');
  console.error(`报告已落盘: ${outPath}`);
}

main();
