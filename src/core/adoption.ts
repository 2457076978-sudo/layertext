/**
 * 采纳率分析（W2 数据闭环）· 纯逻辑，无 DOM/Tauri 依赖
 *
 * 数据源：应用内每次 AI 建议被 采纳/拒绝/直改 时追加的《AI建议台账.csv》
 * （与变更日志同目录；变更日志是审计留痕，台账是分析数据源，职责分开）。
 * CLI（tools/adoption.ts）与应用内「复盘」页共用本模块。
 */

/** 台账 CSV 表头（列序即写入序；变更须同步 main.ts 写入点并在此 bump 注释版本 v1） */
export const LEDGER_HEADER = [
  '时间', '书', '章', '层级', '场景', '标记类型', '规则号', '结果',
  '引擎复核', '供应商', '模型', '提示词版本', '原句', '建议句', '依据', '拒绝原因',
] as const;

export type LedgerRow = {
  ts: string; book: string; chapter: string; tier: string; scene: string;
  markType: string; rule: string; outcome: '采纳' | '拒绝' | '直改' | string;
  check: string; provider: string; model: string; promptVer: string;
  original: string; revised: string; basis: string; rejectReason: string;
};

/** 宽容解析一行 CSV（双引号包裹/转义；行内换行不支持——台账写入时已截断） */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** 解析台账文本（表头行可有可无；空行/坏行跳过） */
export function parseLedger(text: string): LedgerRow[] {
  const lines = text.split('\n').filter((l) => l.trim());
  const rows: LedgerRow[] = [];
  for (const line of lines) {
    const cells = parseCsvLine(line);
    if (cells[0] === LEDGER_HEADER[0]) continue; // 表头
    if (cells.length < 16) continue;
    rows.push({
      ts: cells[0], book: cells[1], chapter: cells[2], tier: cells[3], scene: cells[4],
      markType: cells[5], rule: cells[6], outcome: cells[7], check: cells[8],
      provider: cells[9], model: cells[10], promptVer: cells[11],
      original: cells[12], revised: cells[13], basis: cells[14], rejectReason: cells[15],
    });
  }
  return rows;
}

export interface GroupStat {
  key: string; total: number; accepted: number; rejected: number; autoApplied: number;
  /** 明确采纳率 = 采纳/(采纳+拒绝)（教师过目的部分）；无过目数据时为 null */
  explicitRate: number | null;
  /** 总接受率 = (采纳+直改)/全部 */
  overallRate: number;
  checkWarnRatio: number;
}

export interface Aggregation {
  overall: { total: number; accepted: number; rejected: number; autoApplied: number; explicitRate: number | null; overallRate: number };
  byMark: GroupStat[];
  byRule: GroupStat[];
  byProvider: GroupStat[];
  byPromptVer: GroupStat[];
  /** 按日期聚合（YYYY-MM-DD），升序，供趋势表 */
  byDate: { date: string; total: number; accepted: number; rejected: number; autoApplied: number; rate: number | null }[];
  /** 最常被拒 Top N（按 标记类型 聚合，降序） */
  topRejected: GroupStat[];
  /** 引擎复核 × 结果 交叉：复核⚠的建议里被拒占比 vs 复核通过里被拒占比 */
  crossCheck: { warnTotal: number; warnRejected: number; okTotal: number; okRejected: number };
}

function groupBy(rows: LedgerRow[], keyOf: (r: LedgerRow) => string): GroupStat[] {
  const map = new Map<string, GroupStat & { warn: number }>();
  for (const r of rows) {
    const k = keyOf(r) || '（未记录）';
    const g = map.get(k) ?? { key: k, total: 0, accepted: 0, rejected: 0, autoApplied: 0, explicitRate: null, overallRate: 0, checkWarnRatio: 0, warn: 0 };
    g.total++;
    if (r.outcome === '采纳') g.accepted++;
    else if (r.outcome === '拒绝') g.rejected++;
    else if (r.outcome === '直改') g.autoApplied++;
    if (r.check.includes('⚠')) g.warn++;
    map.set(k, g);
  }
  for (const g of map.values()) {
    const judged = g.accepted + g.rejected;
    g.explicitRate = judged ? g.accepted / judged : null;
    g.overallRate = g.total ? (g.accepted + g.autoApplied) / g.total : 0;
    g.checkWarnRatio = g.total ? g.warn / g.total : 0;
  }
  return [...map.values()];
}

export function aggregate(rows: LedgerRow[]): Aggregation {
  const byMark = groupBy(rows, (r) => r.markType);
  const byRule = groupBy(rows, (r) => r.rule);
  const byProvider = groupBy(rows, (r) => (r.provider ? `${r.provider}${r.model ? '/' + r.model : ''}` : ''));
  const byPromptVer = groupBy(rows, (r) => r.promptVer);
  const overallG = groupBy(rows, () => '全部')[0] ?? { key: '全部', total: 0, accepted: 0, rejected: 0, autoApplied: 0, explicitRate: null, overallRate: 0, checkWarnRatio: 0, warn: 0 };

  const dateMap = new Map<string, { total: number; accepted: number; rejected: number; autoApplied: number }>();
  for (const r of rows) {
    const d = (r.ts || '').slice(0, 10);
    if (!d) continue;
    const g = dateMap.get(d) ?? { total: 0, accepted: 0, rejected: 0, autoApplied: 0 };
    g.total++;
    if (r.outcome === '采纳') g.accepted++;
    else if (r.outcome === '拒绝') g.rejected++;
    else if (r.outcome === '直改') g.autoApplied++;
    dateMap.set(d, g);
  }

  const warnRows = rows.filter((r) => r.check.includes('⚠'));
  const okRows = rows.filter((r) => !r.check.includes('⚠'));

  return {
    overall: {
      total: overallG.total, accepted: overallG.accepted, rejected: overallG.rejected,
      autoApplied: overallG.autoApplied, explicitRate: overallG.explicitRate, overallRate: overallG.overallRate,
    },
    byMark: byMark.sort((a, b) => b.total - a.total),
    byRule: byRule.sort((a, b) => b.total - a.total),
    byProvider: byProvider.sort((a, b) => b.total - a.total),
    byPromptVer: byPromptVer.sort((a, b) => b.total - a.total),
    byDate: [...dateMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, g]) => ({
      date, ...g,
      rate: g.accepted + g.rejected ? g.accepted / (g.accepted + g.rejected) : null,
    })),
    topRejected: byMark.filter((g) => g.rejected > 0).sort((a, b) => b.rejected - a.rejected).slice(0, 5),
    crossCheck: {
      warnTotal: warnRows.length,
      warnRejected: warnRows.filter((r) => r.outcome === '拒绝').length,
      okTotal: okRows.length,
      okRejected: okRows.filter((r) => r.outcome === '拒绝').length,
    },
  };
}

/** 一句话判读：回答"哪类建议最不可靠、该改提示词还是改规则" */
export function diagnose(a: Aggregation): string[] {
  const out: string[] = [];
  const worst = [...a.byMark].filter((g) => g.explicitRate !== null && g.accepted + g.rejected >= 3).sort((x, y) => (x.explicitRate ?? 1) - (y.explicitRate ?? 1))[0];
  if (worst) out.push(`「${worst.key}」类建议明确采纳率最低（${((worst.explicitRate ?? 0) * 100).toFixed(0)}%，${worst.accepted}/${worst.accepted + worst.rejected}）——最不可靠的类别。`);
  const cc = a.crossCheck;
  if (cc.okTotal >= 3 && cc.warnTotal + cc.okTotal >= 3) {
    const warnR = cc.warnTotal ? cc.warnRejected / cc.warnTotal : 0;
    const okR = cc.okRejected / cc.okTotal;
    if (cc.warnTotal >= 3 && warnR > okR + 0.15) out.push(`引擎复核⚠的建议被拒率 ${(warnR * 100).toFixed(0)}%，明显高于复核通过的 ${(okR * 100).toFixed(0)}%——AI 常违反黑名单/超长约束，优先改提示词（加强规则表述）或换更稳的模型。`);
    else if (okR > 0.4) out.push(`复核通过的建议也有 ${(okR * 100).toFixed(0)}% 被拒——问题不在合规而在教学偏好，把你的否决理由写进「长期审校约定」比改提示词更有效。`);
    else if (cc.warnTotal >= 3) out.push(`复核⚠被拒率与复核通过接近（${(warnR * 100).toFixed(0)}% vs ${(okR * 100).toFixed(0)}%）——AI 合规性与口味表现一致。`);
  }
  if (a.byPromptVer.length > 1) {
    const vs = a.byPromptVer.filter((g) => g.explicitRate !== null).sort((x, y) => (x.explicitRate ?? 0) - (y.explicitRate ?? 0));
    if (vs.length > 1) out.push(`提示词版本对比：${vs.map((g) => `${g.key} ${((g.explicitRate ?? 0) * 100).toFixed(0)}%`).join(' ← ')}——新版本若更低应回滚。`);
  }
  if (a.byProvider.length > 1) {
    const vs = a.byProvider.filter((g) => g.explicitRate !== null).sort((x, y) => (x.explicitRate ?? 0) - (y.explicitRate ?? 0));
    if (vs.length > 1) out.push(`供应商/模型对比：${vs.map((g) => `${g.key} ${((g.explicitRate ?? 0) * 100).toFixed(0)}%`).join(' ← ')}。`);
  }
  if (out.length === 0) out.push('数据还太少（每类至少 3 条明确采纳/拒绝后才会出判读）——继续用，台账会自动积累。');
  return out;
}

export function toCsvCell(v: string): string {
  const s = (v ?? '').replace(/[\r\n]+/g, ' ').slice(0, 120); // 台账单行：去换行截断
  return /[",]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toLedgerLine(row: LedgerRow): string {
  return [row.ts, row.book, row.chapter, row.tier, row.scene, row.markType, row.rule, row.outcome,
    row.check, row.provider, row.model, row.promptVer, row.original, row.revised, row.basis, row.rejectReason]
    .map(toCsvCell).join(',') + '\n';
}
