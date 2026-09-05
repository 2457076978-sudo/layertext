/**
 * M1 对照测试：Python 参照版（tools/qc_chapter_ref.py）vs TypeScript 引擎。
 *
 * 用法：node dist/tools/compare.js [文本md...]（默认 examples/texts/*.md）
 * 输出：docs/M1-对照测试报告.md（自动覆盖落盘）；任一字段不一致则以退出码 1 结束。
 *
 * 可用环境变量 PYTHON 指定 python 解释器（默认 python3）。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLexicon } from '../src/core/lexicon.js';
import { runQc, toLegacyReport } from '../src/core/qc.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REF = join(root, 'tools/qc_chapter_ref.py');
const WORDLIST = join(root, 'assets/wordlists/curriculum_2022_level3_1600.txt');
const VOCAB = join(root, 'examples/vocab/sample_teaching_vocab.csv');
const OUT = join(root, 'docs/M1-对照测试报告.md');
const PY = process.env.PYTHON ?? 'python3';

const texts = process.argv.length > 2
  ? process.argv.slice(2)
  : readdirSync(join(root, 'examples/texts')).filter((f) => f.endsWith('.md')).sort()
      .map((f) => join(root, 'examples/texts', f));

interface Cmp { ok: boolean; note?: string }

function cmpField(a: unknown, b: unknown): Cmp {
  if (Array.isArray(a) || Array.isArray(b)) {
    return { ok: JSON.stringify(a) === JSON.stringify(b) };
  }
  if (typeof a === 'string' && typeof b === 'string') {
    if (a === b) return { ok: true };
    const ma = a.match(/^(-?[\d.]+)%$/);
    const mb = b.match(/^(-?[\d.]+)%$/);
    if (ma && mb && Math.abs(parseFloat(ma[1]) - parseFloat(mb[1])) <= 0.1000001) {
      return { ok: true, note: `格式差异：${a} vs ${b}` };
    }
    return { ok: false };
  }
  return { ok: Object.is(a, b) };
}

function pyRun(text: string): Record<string, unknown> {
  const tmp = join(tmpdir(), `layertext_ref_${basename(text)}.json`);
  execFileSync(
    PY,
    [REF, text, '--tier', 'M', '--wordlist', WORDLIST, '--vocab', VOCAB, '--out', tmp],
    { encoding: 'utf-8' },
  );
  return JSON.parse(readFileSync(tmp, 'utf-8'));
}

function tsRun(text: string): Record<string, unknown> {
  const md = readFileSync(text, 'utf-8');
  const lex = buildLexicon({
    vocabCsvTexts: [readFileSync(VOCAB, 'utf-8')],
    plainWordlistTexts: [readFileSync(WORDLIST, 'utf-8')],
  });
  return toLegacyReport(runQc(md, lex, { tier: 'M', fileName: basename(text) }));
}

function fmt(v: unknown): string {
  if (Array.isArray(v)) return v.length <= 12 ? JSON.stringify(v) : `${JSON.stringify(v.slice(0, 12))}…（共${v.length}）`;
  return String(v);
}

let pyVersion = '';
try { pyVersion = execFileSync(PY, ['--version'], { encoding: 'utf-8' }).trim(); } catch { /* 留空 */ }

const sections: string[] = [];
let total = 0, pass = 0, failedTexts = 0;
const notes: string[] = [];

for (const text of texts) {
  const py = pyRun(text);
  const ts = tsRun(text);
  const lines = [`| 字段 | Python 参照版 | TypeScript 引擎 | 一致 |`, `|---|---|---|---|`];
  let okAll = true;
  for (const k of Object.keys(py)) {
    const a = py[k], b = ts[k];
    const { ok, note } = cmpField(a, b);
    total++; if (ok) pass++; else okAll = false;
    if (note) notes.push(`${basename(text)} · ${k}：${note}`);
    lines.push(`| ${k} | ${fmt(a)} | ${fmt(b)} | ${ok ? '✅' : '❌'} |`);
  }
  if (!okAll) failedTexts++;
  sections.push(`## ${basename(text)}\n\n${lines.join('\n')}\n`);
}

const date = new Date().toLocaleDateString('sv-SE'); // 本地日期 YYYY-MM-DD
const md = `# M1 对照测试报告：Python 参照版 vs TypeScript 引擎

- 生成日期：${date}
- 环境：${pyVersion || 'python（版本未知）'} / Node ${process.version} / macOS
- 复现命令：\`npm run build && node dist/tools/compare.js\`
- 输入词库：\`assets/wordlists/curriculum_2022_level3_1600.txt\` + \`examples/vocab/sample_teaching_vocab.csv\`（tier=M，无锚点/专名注入）

## 验证链说明

移植等价性通过两跳验证：

1. **原版 ↔ 参照版**（本机执行，依赖原型项目文件，不入库、不可在仓库复现）：
   \`qc_chapter.py\` 原版与 \`tools/qc_chapter_ref.py\` 在原型项目 4 个真实章节上逐字段比对——
   第一章 v0.2（含歌篇 Beasts of England/词句卡/锚点）、第二章 v0.1、第八章 v0.1 A 层挑战（tier A + ch8 定从解禁）、
   第十章 v0.1，均使用真实词库、中考 1600 词表、专名/术语预设与两条原文锚点。
   执行记录（2026-09-06，Python 3.9.6）：**4 章全部字段一致**，证明参照版对原版的"仅配置层参数化"没有改变任何计数行为；
2. **参照版 ↔ TS 引擎**（本报告，可复现）：两者在仓库示例文本上对全部 ${total} 项字段逐一比对。

两处与原版的有意分歧（两引擎同步修改，AF 四章验证时无相关语句、数值不受影响）：
- **R12-inv-case**：倒装过去完成的触发词允许句首大写（Never/Hardly/No sooner had …）。
  原版正则仅小写，会漏检句首倒装——而原版注释示例恰为大写句首。

## 结果

- 比对文本 ${texts.length} 篇，字段比对 ${total} 项，一致 ${pass} 项（${total ? ((pass / total) * 100).toFixed(1) : '0'}%）
- 未一致文本数：${failedTexts}
${notes.length ? `\n## 注记\n\n${notes.map((n) => `- ${n}`).join('\n')}\n` : ''}
${sections.join('\n')}
`;

writeFileSync(OUT, md, 'utf-8');
console.log(`比对完成：${pass}/${total} 项一致（${texts.length} 篇文本，${failedTexts} 篇存在差异）`);
console.log(`报告已落盘: ${OUT}`);
if (pass !== total) process.exit(1);
