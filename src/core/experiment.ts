// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，本仓库已部署版权验证体系，细节不予公开（docs/版权与授权.md）。
/**
 * LayerText · 四格实验（可归因的对照）
 *
 * 审查报告 §二 的原话：「2%→98% 的实验不能归因：一次同时改变了词表注入、会话记忆、
 * 查词和复检，且只有 31 段。至少做四格实验：独立调用/会话 × 有无全词表，固定温度和同一章；
 * 报告生成覆盖率、最终覆盖率、重复注释率、人工修订率和 token 成本。」
 *
 * 问题出在哪：把四个自变量一起改，然后拿"2% → 98%"当结论。读者无法判断增益来自哪一项，
 * 换一个人换一套条件就复现不出来。四格实验把变量拆开——**一次只动一个因子**，
 * 而且同一章、同一温度、同一模型。
 *
 * 五个指标各自回答一个问题：
 *   生成覆盖率 —— 模型**第一次**写出来的正文里，该注的词注了没有（提示词与词表注入的直接效果）
 *   最终覆盖率 —— 经过复检回流 + 本地去重 + 补注之后，落盘产物是多少（流水线的总效果）
 *   重复注释率 —— 一个词被注了不止一次的比例（"全篇只注一次"这条规则守住了没有）
 *   人工修订率 —— 没过门禁、要人管的段占比（人工成本的直接度量）
 *   token 成本   —— 调用次数、输入/输出/缓存命中与估算花费（经济性）
 *
 * 本模块是纯计算（读日志、算比例、出对照表），跑实验由 tools/af_pipeline/LayerText_AF四格实验.mjs 负责。
 */

import { parseAnnotations, duplicateRate } from './annot.js';
import { makeCovers } from './annot.js';
import { wordCount } from './segmentgate.js';

/** 会话维度 */
export type SessionFactor = 'session' | 'independent';
/** 词表注入维度 */
export type VocabFactor = 'full' | 'lite';

export interface CellSpec {
  /** 人话标签，直接进报告表头 */
  label: string;
  session: SessionFactor;
  vocab: VocabFactor;
  /** 传给会话脚本的 --scope */
  scope: 'tier' | 'segment';
  /** 传给会话脚本的 --vocab */
  vocabArg: 'full' | 'lite';
}

/** 四格：独立调用/会话 × 有无全词表。固定温度与同一章由调用方保证。 */
export function experimentPlan(): CellSpec[] {
  return [
    { label: '会话 + 全词表', session: 'session', vocab: 'full', scope: 'tier', vocabArg: 'full' },
    { label: '会话 + 无全词表', session: 'session', vocab: 'lite', scope: 'tier', vocabArg: 'lite' },
    { label: '独立调用 + 全词表', session: 'independent', vocab: 'full', scope: 'segment', vocabArg: 'full' },
    { label: '独立调用 + 无全词表', session: 'independent', vocab: 'lite', scope: 'segment', vocabArg: 'lite' },
  ];
}

/** 人民币估算（与生成脚本同一口径：空闲时段价，未命中 1 元/百万、命中 0.02、输出 4） */
export function estimateCost(u: { in: number; out: number; cached: number }): number {
  return (u.in - u.cached) / 1e6 + (u.cached / 1e6) * 0.02 + (u.out / 1e6) * 4;
}

export interface CellSegment {
  /** 段号（P07） */
  id: string;
  chapter: string;
  source: string;
  /** 落盘产物里的最终正文（未通过门禁的段没有） */
  final?: string;
  /** 模型第一次给这一段的正文（来自会话日志；缺了就用最终正文代替并标 fallback） */
  first?: string;
}

export interface CellInput {
  spec: CellSpec;
  tier: string;
  segments: CellSegment[];
  /** 引擎判定应注的超纲词（调用方注入 runQc，保持与管线同一口径） */
  oovOf: (text: string) => string[];
  /** 统一释义词典（给重复注释/释义冲突判定用） */
  dict?: Map<string, string>;
  usage: { calls: number; in: number; out: number; cached: number };
  /** 没过门禁、进人工队列的段数 */
  needsReview: number;
  /** 教师决定数（没有决定时为 0） */
  decisions?: { accept: number; edit: number; reject: number; falsePositive: number };
}

export interface CellMetric {
  label: string;
  session: SessionFactor;
  vocab: VocabFactor;
  segments: number;
  /**
   * **真正落盘的段数**（没过门禁的段不在内）。
   *
   * 为什么要单独留这个数：覆盖率的分母是"落盘产物"，一段都没落盘时分母为零——
   * 那时 `finalCoverage` 会算成 100%（"没有该注的词"与"没有一个字"在比例上长得一样），
   * 报告里就会出现"最终覆盖率 100%"，而事实是这一段交付都没有。
   * 有了它，`experimentrun.metricValue` 才能在"没有分母"时拒绝出数。
   */
  finalSegments: number;
  /** 模型首轮就注出的比例（0-1） */
  genCoverage: number;
  /** 落盘产物的加注覆盖率（0-1） */
  finalCoverage: number;
  /** 首轮 → 最终的提升（百分点），回答"复检回流值不值" */
  coverageGain: number;
  /** 重复注释率（多余处数 / 注释总处数） */
  duplicateRate: number;
  /** 人工修订率 = 未过门禁段数 / 段数 */
  manualRate: number;
  words: number;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  cacheHit: number;
  cost: number;
  /** first 缺失、用 final 顶替的段数（≥1 时生成覆盖率不可信，报告必须标出来） */
  firstFallback: number;
}

/** 某段正文对"应注词型"的加注覆盖率：注了的 / 该注的（该注 = 原文 OOV ∪ 正文 OOV） */
export function annotationCoverageOf(
  text: string,
  source: string,
  oovOf: (t: string) => string[],
  alreadyAnnotatedElsewhere: Iterable<string> = [],
): { coverage: number; annotatable: number; annotated: number } {
  const coversElsewhere = makeCovers(alreadyAnnotatedElsewhere);
  const idx = parseAnnotations(text);
  const must = [...new Set([...oovOf(source), ...oovOf(text)])].filter((w) => !coversElsewhere(w));
  const missing = must.filter((w) => !idx.covers(w));
  return {
    coverage: must.length ? (must.length - missing.length) / must.length : 1,
    annotatable: must.length,
    annotated: must.length - missing.length,
  };
}

export function measureCell(input: CellInput): CellMetric {
  const { spec, segments } = input;
  let genAnnotatable = 0;
  let genAnnotated = 0;
  let finAnnotatable = 0;
  let finAnnotated = 0;
  let firstFallback = 0;
  let words = 0;
  const finals: string[] = [];
  // 「全篇只注一次」：逐段推进账本，后面的段不重复注前面注过的词（与门禁同口径）
  const ledger = new Set<string>();
  for (const s of segments) {
    words += wordCount(s.final ?? s.first ?? s.source);
    if (s.final === undefined) continue; // 未过门禁的段不进最终覆盖率的分子分母
    const first = s.first ?? s.final;
    if (s.first === undefined) firstFallback++;
    const g = annotationCoverageOf(first, s.source, input.oovOf, ledger);
    const f = annotationCoverageOf(s.final, s.source, input.oovOf, ledger);
    genAnnotatable += g.annotatable;
    genAnnotated += g.annotated;
    finAnnotatable += f.annotatable;
    finAnnotated += f.annotated;
    finals.push(s.final);
    for (const a of parseAnnotations(s.final).list) ledger.add(a.key);
  }
  const genCoverage = genAnnotatable ? genAnnotated / genAnnotatable : 1;
  const finalCoverage = finAnnotatable ? finAnnotated / finAnnotatable : 1;
  // 重复注释率：逐段算，再按注释处数加权（短段的比率不该和长段等权）
  let dupTotal = 0;
  let dupExtra = 0;
  for (const t of finals) {
    const d = duplicateRate(t);
    dupTotal += d.total;
    dupExtra += d.extra;
  }
  return {
    label: spec.label,
    session: spec.session,
    vocab: spec.vocab,
    segments: segments.length,
    finalSegments: finals.length,
    genCoverage,
    finalCoverage,
    coverageGain: Number(((finalCoverage - genCoverage) * 100).toFixed(1)),
    duplicateRate: dupTotal ? dupExtra / dupTotal : 0,
    manualRate: segments.length ? input.needsReview / segments.length : 0,
    words,
    calls: input.usage.calls,
    tokensIn: input.usage.in,
    tokensOut: input.usage.out,
    cacheHit: input.usage.in ? input.usage.cached / input.usage.in : 0,
    cost: Number(estimateCost(input.usage).toFixed(4)),
    firstFallback,
  };
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

/** 对照表：四格并排 + 每一格相对基准（第一格）的差 */
export function compareCells(cells: CellMetric[]): string {
  if (!cells.length) return '（没有实验结果）';
  const base = cells[0];
  const rows = cells.map((c) => {
    const d = (k: keyof CellMetric, fmt: (v: number) => string): string => (c === base ? '—' : `${c[k] > base[k] ? '+' : ''}${fmt(Number(c[k]) - Number(base[k]))}`);
    // 一段都没落盘：覆盖率没有分母，表里印"—"而不是那个退化成 100% 的比例。
    // "没交付"和"注全了"在表格里长得一样的话，读表的人一定会读错。
    const noFinal = c.segments > 0 && c.finalSegments === 0;
    const cov = (v: number): string => (noFinal ? '—（0 段落盘）' : pct(v));
    const dCov = (k: keyof CellMetric): string => (noFinal || (base.segments > 0 && base.finalSegments === 0) ? '—' : d(k, (v) => `${(v * 100).toFixed(1)}pp`));
    return [
      c.label,
      c.segments,
      cov(c.genCoverage),
      cov(c.finalCoverage),
      noFinal ? '—' : c.coverageGain > 0 ? `+${c.coverageGain}pp` : `${c.coverageGain}pp`,
      // 重复注释率的分母是"注释总处数"：没有落盘正文时它同样是零分母
      noFinal ? '—' : pct(c.duplicateRate),
      pct(c.manualRate),
      String(c.calls),
      c.tokensIn.toLocaleString(),
      pct(c.cacheHit),
      `¥${c.cost.toFixed(3)}`,
      dCov('genCoverage'),
      d('cost', (v) => `¥${v.toFixed(3)}`),
    ].join(' | ');
  });
  const head = ['实验格', '段数', '生成覆盖率', '最终覆盖率', '提升', '重复注释率', '人工修订率', '调用', '输入 tokens', '缓存命中', '花费', 'vs 基准(生成)', 'vs 基准(花费)'].join(' | ');
  const sep = ['---', '---:', '---:', '---:', '---:', '---:', '---:', '---:', '---:', '---:', '---:', '---:', '---:'].join('|');
  return [`| ${head} |`, `|${sep}|`, ...rows.map((r) => `| ${r} |`)].join('\n');
}

/** 结论提示：把"哪一格更划算"直接说出来，同时**警告不可归因的情形** */
export function experimentVerdict(cells: CellMetric[]): string[] {
  if (cells.length < 2) return ['实验结果不足两格，无法比较。'];
  const out: string[] = [];
  const fallback = cells.filter((c) => c.firstFallback > 0);
  if (fallback.length) {
    out.push(`⚠ ${fallback.map((c) => c.label).join('、')} 有段缺"首轮响应"（用最终正文顶替），` + '生成覆盖率会被高估——结论里不要用这几格的生成覆盖率下判断。');
  }
  // 一段都没落盘时不报覆盖率：分母为零的那个 100% 不是成绩，是"没交付"
  const empty = cells.filter((c) => c.segments > 0 && c.finalSegments === 0);
  if (empty.length) {
    out.push(`⚠ ${empty.map((c) => c.label).join('、')} **一段都没落盘**（全部进人工队列）：` + '这几格的覆盖率没有分母，"最终覆盖率 100%"是假的——先看人工修订率，别引用覆盖率。');
  }
  const sessionGain = comparePair(cells, 'session');
  const vocabGain = comparePair(cells, 'vocab');
  for (const g of [sessionGain, vocabGain]) if (g) out.push(g);
  const best = [...cells].sort((a, b) => b.finalCoverage - a.finalCoverage || a.cost - b.cost)[0];
  if (best.segments > 0 && best.finalSegments === 0) {
    // 全都没落盘时**不做排名**：拿一个没有分母的比例排出来的第一名，只是噪声的排列
    out.push('四格都没有落盘正文（全部进人工队列）：这里比不出"哪一格更好"——先看人工修订率与门禁规则，别拿覆盖率排名。');
  } else {
    out.push(`最终覆盖率最高且花费更省的是「${best.label}」（最终覆盖率 ${pct(best.finalCoverage)}，¥${best.cost.toFixed(3)}）。`);
  }
  const worstManual = [...cells].sort((a, b) => b.manualRate - a.manualRate)[0];
  if (worstManual.manualRate > 0.2) {
    out.push(`⚠ 「${worstManual.label}」人工修订率 ${pct(worstManual.manualRate)} 偏高——先修规则或词库，别急着扩量。`);
  }
  return out;
}

/** 拆出单因子的增益：同一因子两个水平配对比较，避免"四个变量一起改"的老毛病 */
function comparePair(cells: CellMetric[], factor: 'session' | 'vocab'): string | null {
  const key = factor === 'session' ? 'session' : 'vocab';
  const groups = new Map<string, CellMetric[]>();
  for (const c of cells) {
    const k = String(c[key]);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(c);
  }
  if (groups.size !== 2) return null;
  const [a, b] = [...groups.entries()];
  if (a[1].length !== b[1].length) return null;
  const avg = (m: CellMetric[], f: (c: CellMetric) => number): number => m.reduce((n, c) => n + f(c), 0) / m.length;
  const name = factor === 'session' ? '会话记忆' : '全词表注入';
  const df = avg(b[1], (c) => c.finalCoverage) - avg(a[1], (c) => c.finalCoverage);
  const dc = avg(b[1], (c) => c.cost) - avg(a[1], (c) => c.cost);
  return `${name}：${b[0]} vs ${a[0]} → 最终覆盖率 ${df >= 0 ? '+' : ''}${(df * 100).toFixed(1)}pp，花费 ${dc >= 0 ? '+' : ''}¥${dc.toFixed(3)}（单因子结论，另一因子在两种水平上各测了一次）`;
}

/* ────────────────────── 从会话日志里取"首轮响应" ────────────────────── */

export interface FirstResponse {
  key: string;
  text: string;
}

/**
 * 从 append-only 会话日志里取出每一段的**第一次**助手响应。
 * 为什么要它：报告要的"生成覆盖率"指的是模型第一次写出来的样子；
 * 只看最终产物的话，"复检回流"的贡献就和"提示词与词表注入"的贡献混在一起了——
 * 那正是 2%→98% 无法归因的原因。
 */
export function segmentFirstResponses(logText: string): Map<string, string> {
  const out = new Map<string, string>();
  let cur: string | null = null;
  for (const line of logText.split('\n')) {
    if (!line.trim()) continue;
    let o: { t?: string; role?: string; content?: string };
    try {
      o = JSON.parse(line) as typeof o;
    } catch {
      continue;
    }
    if (o.t !== 'msg') continue;
    if (o.role === 'user' && typeof o.content === 'string') {
      // 段请求：`第一章 · 第 3/12 段`（前面可能拼着结转块，所以按标题行匹配）
      const m = o.content.match(/(第[一二三四五六七八九十]+章)\s*·\s*第\s*(\d+)\s*\/\s*(\d+)\s*段/);
      cur = m ? `${m[1]}#${Number(m[2]) - 1}` : null;
      continue;
    }
    if (o.role === 'assistant' && cur && typeof o.content === 'string' && o.content.trim()) {
      if (!out.has(cur)) out.set(cur, o.content);
    }
  }
  return out;
}
