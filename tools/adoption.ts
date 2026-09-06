#!/usr/bin/env node
/**
 * 采纳率分析 CLI（W2）
 *
 * 用法：
 *   node dist/tools/adoption.js <台账.csv>...          # 分析一份或多份《AI建议台账.csv》
 *   node dist/tools/adoption.js <目录>                  # 分析目录下全部 AI建议台账*.csv（含子目录一层）
 *   ... --out 报告.md                                   # 另存 Markdown 报告（默认只打印控制台）
 *
 * 回答的问题：哪类 AI 建议最不可靠？该改提示词还是改规则？
 * 数据来自应用内每次建议被 采纳/拒绝/直改 时自动追加的台账（与变更日志同目录）。
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { aggregate, diagnose, parseLedger, type Aggregation } from '../src/core/adoption.js';

const pct = (x: number | null): string => (x === null ? '—' : (x * 100).toFixed(0) + '%');

function table(rows: string[][], head: string[]): string {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) => cells.map((c, i) => (c ?? '').padEnd(w[i])).join('  ');
  return [line(head), ...rows.map(line)].join('\n');
}

function groupTable(a: Aggregation, key: 'byMark' | 'byRule' | 'byProvider' | 'byPromptVer'): string {
  return table(
    a[key].map((g) => [g.key, String(g.total), String(g.accepted), String(g.rejected), String(g.autoApplied), pct(g.explicitRate), pct(g.overallRate), pct(g.checkWarnRatio)]),
    ['类别', '建议数', '采纳', '拒绝', '直改', '明确采纳率', '总接受率', '复核⚠比'],
  );
}

function collectCsvs(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const e of readdirSync(p)) {
        if (e.startsWith('AI建议台账') && e.endsWith('.csv')) out.push(join(p, e));
        else {
          const sub = join(p, e);
          try {
            if (statSync(sub).isDirectory()) {
              for (const f of readdirSync(sub)) if (f.startsWith('AI建议台账') && f.endsWith('.csv')) out.push(join(sub, f));
            }
          } catch { /* 忽略不可读项 */ }
        }
      }
    } else out.push(p);
  }
  return [...new Set(out)];
}

function main(): void {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf('--out');
  const outPath = outIdx >= 0 ? argv[outIdx + 1] : null;
  const inputs = argv.filter((_, i) => outIdx < 0 || (i !== outIdx && i !== outIdx + 1));
  if (inputs.length === 0) {
    console.error('用法: node dist/tools/adoption.js <台账.csv|目录>... [--out 报告.md]');
    process.exit(2);
  }
  const csvs = collectCsvs(inputs);
  if (csvs.length === 0) { console.error('未找到台账文件（AI建议台账*.csv）'); process.exit(2); }

  const rows = csvs.flatMap((p) => parseLedger(readFileSync(p, 'utf-8')));
  if (rows.length === 0) { console.error('台账为空（只有表头或无数据行）'); process.exit(2); }
  const a = aggregate(rows);

  const sections: string[] = [];
  sections.push(`# 采纳率分析（${csvs.length} 份台账 · ${rows.length} 条建议）\n`);
  sections.push(`**总量** ${a.overall.total} 条：采纳 ${a.overall.accepted} · 拒绝 ${a.overall.rejected} · 直改 ${a.overall.autoApplied}` +
    `｜明确采纳率 ${pct(a.overall.explicitRate)}（教师过目部分）｜总接受率 ${pct(a.overall.overallRate)}（含直改）\n`);

  sections.push('## 按标记类型\n```\n' + groupTable(a, 'byMark') + '\n```\n');
  if (a.byRule.length > 1) sections.push('## 按规则号\n```\n' + groupTable(a, 'byRule') + '\n```\n');
  if (a.byProvider.length > 1) sections.push('## 按供应商/模型\n```\n' + groupTable(a, 'byProvider') + '\n```\n');
  if (a.byPromptVer.length > 1) sections.push('## 按提示词版本\n```\n' + groupTable(a, 'byPromptVer') + '\n```\n');

  if (a.byDate.length > 0) {
    sections.push('## 按日期趋势\n```\n' + table(
      a.byDate.map((d) => [d.date, String(d.total), String(d.accepted + d.autoApplied), String(d.rejected), pct(d.rate)]),
      ['日期', '建议数', '接受', '拒绝', '明确采纳率'],
    ) + '\n```\n');
  }
  if (a.topRejected.length > 0) {
    sections.push('## 最常被拒 Top5\n```\n' + table(
      a.topRejected.map((g) => [g.key, `${g.rejected} 次被拒`, `采纳 ${g.accepted}`, `复核⚠比 ${pct(g.checkWarnRatio)}`]),
      ['标记类型', '被拒次数', '采纳', '复核⚠比'],
    ) + '\n```\n');
  }
  const cc = a.crossCheck;
  sections.push('## 引擎复核 × 结果交叉\n');
  sections.push(`复核⚠ ${cc.warnTotal} 条中 ${cc.warnRejected} 条被拒（${pct(cc.warnTotal ? cc.warnRejected / cc.warnTotal : null)}）；复核通过 ${cc.okTotal} 条中 ${cc.okRejected} 条被拒（${pct(cc.okTotal ? cc.okRejected / cc.okTotal : null)}）\n`);

  sections.push('## 判读\n');
  for (const d of diagnose(a)) sections.push(`- ${d}`);

  const md = sections.join('\n');
  console.log(md);
  if (outPath) {
    writeFileSync(outPath, md, 'utf-8');
    console.error(`报告已落盘: ${outPath}`);
  }
}

main();
