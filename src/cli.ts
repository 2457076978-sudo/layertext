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
import { fileURLToPath } from 'node:url';
import { buildLexicon } from './core/lexicon.js';
import { runQc, toLegacyReport, type Tier } from './core/qc.js';

const BUNDLED_WORDLIST = 'assets/wordlists/curriculum_2022_level3_1600.txt';

function repoRoot(): string {
  // dist/src/cli.js → 仓库根
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function defaultWordlistPath(): string | null {
  const candidates = [join(process.cwd(), BUNDLED_WORDLIST), join(repoRoot(), BUNDLED_WORDLIST)];
  for (const c of candidates) {
    try {
      readFileSync(c, 'utf-8');
      return c;
    } catch {
      /* 尝试下一个 */
    }
  }
  return null;
}

/** 从路径推导章号（第X章），与 Python 版一致 */
const CH_MAP: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function chnoFromPath(p: string): number | null {
  for (const [k, v] of Object.entries(CH_MAP)) if (p.includes(`第${k}章`)) return v;
  return null;
}

function tagFromPath(p: string): string {
  if (p.includes('A层')) return 'A';
  if (p.includes('v0.2')) return 'v02';
  return 'v01';
}

function readWordFile(p: string): string[] {
  return readFileSync(p, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv[0] !== 'qc' || !argv[1] || argv[1].startsWith('--')) {
    console.error('用法: node dist/src/cli.js qc <候选md> [--tier A|B|M] [--vocab x.csv]... [--wordlist x.txt]... [--terms x.txt] [--proper x.txt] [--anchor "短语"]... [--tag t] [--out file]');
    process.exit(2);
  }
  const path = argv[1];
  const opts: Record<string, string[]> = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { console.error(`无法识别的参数: ${a}`); process.exit(2); }
    const key = a.slice(2);
    const val = argv[i + 1];
    if (!val || val.startsWith('--')) { console.error(`参数 ${a} 需要值`); process.exit(2); }
    i++;
    (opts[key] ??= []).push(val);
  }

  const tier = ((opts.tier?.[0] as Tier) ?? 'M');
  const vocabPaths = opts.vocab ?? [];
  let wordlistPaths = opts.wordlist ?? [];
  if (wordlistPaths.length === 0) {
    const d = defaultWordlistPath();
    if (d) wordlistPaths = [d];
    else console.error('提示：未找到内置课标词表（assets/wordlists/），请先用 tools/convert_wordlist.py 生成或用 --wordlist 指定');
  }
  const terms = opts.terms ? opts.terms.flatMap(readWordFile) : [];
  const proper = opts.proper ? opts.proper.flatMap(readWordFile) : [];

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
    propCheckList: proper.length ? proper.concat([]) : [],
    fileName: basename(path),
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
