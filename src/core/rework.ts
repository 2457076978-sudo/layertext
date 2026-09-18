// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，本仓库已部署版权验证体系，细节不予公开（docs/版权与授权.md）。
/**
 * LayerText · 段级回炉的公共原语（2026-09-18 第一梯队项 3）
 *
 * 存在的理由：回炉的四闸与挂起原因分类原先只活在 `tools/af_pipeline/LayerText_AF段级回炉.mjs`
 * 的函数体里——App（项 1）与 MCP（项 2）要复用同一把尺，按仓库口径「同一条判定只许有一份实现」，
 * 它们必须进 `src/core`。脚本、MCP、App 三处都从本模块取，不许各写一套。
 *
 * 引语豁免的口径沿用 segmentgate 的定案（2026-09-12）：句法工序被禁止拆直接引语，
 * 为改不了的句子否决整段在数学上无解；豁免是**过程责任**口径，不是测量口径——
 * 报表/风险队列照常计数，只有"要不要为这句打回修订"用它。
 */

import { stripDirectQuotes } from './segmentgate.js';

/** 挂起原因的机器分类（回炉台账汇总/下一轮排序用）。
 *  与脚本写入台账的 `class` 字段、旧台账纯文本 `reason` 双向兼容：新行直接带分类，
 *  旧行（2026-09-17 的格式）由 classifyHangReason 从 reason 文本里识别。 */
export type HangClass = '锁失败' | '未注超标' | '段长越界' | '句长超线' | '注释丢失' | '调用失败' | '未知';

/** 识别顺序即优先级：一条挂起可能同时报多类失败，按"最先卡住的闸"归类——
 *  锁闸在最前（回炉闸序：锁 → 红词 → 段长/注释/句长）。
 *
 *  两种台账格式都认：
 *  - v2（2026-09-18 起）：`未过闸（锁✗ 未注3>2 句长19>19）`——每闸一个词；
 *  - v1（2026-09-17 遗留）：`未过闸（红2→2 长115→102 注0→0 句max58）`——无条件罗列四个测量值，
 *    哪个真失败要靠数字判断：红 N→N(>0)=未减；句 max 超线（需调用方给该层上限）；
 *    段长比出 [0.75,1.25]（v1 阈值带，v2 的 [0.7,1.4] 失败全落在它外面之外的小带
 *    由 v2 自带的 class 字段兜底，不靠本文本分类）。判不出的如实归"未知"。 */
export function classifyHangReason(reason: string, ctx?: { sentLimit?: number }): HangClass {
  const r = String(reason ?? '');
  if (r.includes('调用失败')) return '调用失败';
  if (r.includes('未过锁闸') || r.includes('锁✗') || /缺\S*\s*数字/.test(r)) return '锁失败';
  /* v2 旧格式把四个测量值**全列出来**（不区分过没过），所以必须比数值：
   * `未注1>1`（1≤目标=过）不是未注超标，`句长19>19`（19≤线=过）不是句长超线。
   * 首版只做模式匹配，151 段里混进了"其实达标"的段——真台账实跑抓出。 */
  /* 正则容空格：管线格式无空格（未注3>2），App 闸消息带空格（红词 1→0、段长 6→4）——两边都要认 */
  const unnoted = r.match(/未注\s*(\d+)\s*>\s*(\d+)/);
  const red = r.match(/红(?:词)?\s*(\d+)\s*→\s*(\d+)/);
  if ((unnoted && Number(unnoted[1]) > Number(unnoted[2])) || (red && Number(red[1]) > 0 && Number(red[2]) >= Number(red[1])) || r.includes('红词')) return '未注超标';
  const sentOver = r.match(/句长\s*(\d+)\s*>\s*(\d+)/);
  const sentMax = r.match(/句max\s*(\d+)/);
  if ((sentOver && Number(sentOver[1]) > Number(sentOver[2])) || r.includes('句长超线') || (sentMax && ctx?.sentLimit !== undefined && Number(sentMax[1]) > ctx.sentLimit)) return '句长超线';
  const len = r.match(/长\s*(\d+)\s*→\s*(\d+)/);
  if (len && Number(len[1]) > 0) {
    const ratio = Number(len[2]) / Number(len[1]);
    if (ratio < 0.75 || ratio > 1.25) return '段长越界';
  }
  if (r.includes('段长')) return '段长越界';
  const ann = r.match(/注(?:释)?\s*(\d+)\s*→\s*(\d+)/);
  if ((ann && Number(ann[2]) < Number(ann[1])) || r.includes('注释')) return '注释丢失';
  return '未知';
}

/** 句长计数的口径说明（改之前先读）：
 *  - 中文注释 `word（中文）` 整体剔除后再数（注释不是正文负荷）；
 *  - 计数正则 `[A-Za-z]+`：don't 数 2 词。这与 `segmentgate.wordCount`（连字符/撇号连写）
 *    是**两种口径**，不是漂移——回炉的 `lim+2` 阈值是在本口径上标定的（2026-09-17 三层实跑），
 *    换口径等于悄悄挪闸门。两处口径都各自有测试锁着。 */
export function maxSentenceLen(text: string, opts?: { exemptQuotes?: boolean }): number {
  let t = String(text ?? '').replace(/（[^）]*）/g, ' ');
  if (opts?.exemptQuotes) t = stripDirectQuotes(t);
  const sents = t.split(/(?<=[.!?])\s+/);
  let max = 0;
  for (const s of sents) {
    const n = (s.toLowerCase().match(/[a-z]+/g) ?? []).length;
    if (n > max) max = n;
  }
  return max;
}

/* ───────────────────────────── 四闸（项 1 App / 项 2 MCP 共用） ─────────────────────────────
 * 回炉的验收闸。红词数由调用方算（App 用它的词库、管线用分档允许表——"什么是红词"
 * 是调用方的口径），闸只负责比较；其余三闸（段长比/注释不丢/句长）自含。 */

export type ReworkGateName = '红词必减' | '段长比' | '注释不丢' | '句长上限';

export interface ReworkGateInput {
  before: string;
  after: string;
  /** 句长上限（词/句）；闸内部按引语豁免口径量 */
  maxLen: number;
  /** 改前红词数（未注生词出现次数，调用方口径） */
  redBefore: number;
  /** 改后红词数 */
  redAfter: number;
  /** 段长比带 [下限, 上限]，默认 [0.7, 1.4]（回炉 v2 标定值） */
  lenBand?: [number, number];
  /** 段长比只对 ≥ 此词数的段生效，默认 20——短段词数波动大（删一个生词就出带），
   *  与整章模式的篇幅守恒重试同一条先例（srcW >= 20 才卡） */
  lenMinWords?: number;
  /** 句长容差（上限 + 容差才拦），默认 0；管线侧用 +2 */
  lenTolerance?: number;
}

export interface ReworkGateResult {
  pass: boolean;
  failures: Array<{ gate: ReworkGateName; message: string }>;
  measured: { redBefore: number; redAfter: number; wordsBefore: number; wordsAfter: number; ratio: number; annoBefore: number; annoAfter: number; maxSent: number };
}

/** 段词数：剥注释/括号/方括号后数英文词（与回炉管线 words() 同值——撇号形 don't 数 2 词） */
export function reworkWordCount(text: string): number {
  return (
    String(text ?? '')
      .replace(/[（(][^）)]*[）)]/g, ' ')
      .replace(/\[[^\]]*\]/g, ' ')
      .match(/[A-Za-z]+/g) ?? []
  ).length;
}

export function reworkGates(input: ReworkGateInput): ReworkGateResult {
  const stripSegMarkers = (t: string): string => String(t ?? '').replace(/\[P\d+\]/g, ' ');
  const wordsBefore = reworkWordCount(input.before);
  const wordsAfter = reworkWordCount(input.after);
  const ratio = wordsBefore > 0 ? wordsAfter / wordsBefore : 1;
  const annoBefore = (String(input.before ?? '').match(/（[^）]*）/g) ?? []).length;
  const annoAfter = (String(input.after ?? '').match(/（[^）]*）/g) ?? []).length;
  const maxSent = maxSentenceLen(stripSegMarkers(input.after), { exemptQuotes: true }); // [P##] 是结构不是内容，不进句长计量
  const [lo, hi] = input.lenBand ?? [0.7, 1.4];
  const failures: Array<{ gate: ReworkGateName; message: string }> = [];
  if (input.redAfter > input.redBefore || (input.redBefore > 0 && input.redAfter === input.redBefore)) {
    failures.push({ gate: '红词必减', message: `红词 ${input.redBefore}→${input.redAfter}：改前有红词时必须严格减少，且任何时候不得增加` });
  }
  if (wordsBefore >= (input.lenMinWords ?? 20) && (ratio < lo || ratio > hi)) {
    failures.push({ gate: '段长比', message: `段长 ${wordsBefore}→${wordsAfter}（比 ${ratio.toFixed(2)}），出带 [${lo}, ${hi}]` });
  }
  if (annoAfter < annoBefore) {
    failures.push({ gate: '注释不丢', message: `注释 ${annoBefore}→${annoAfter}：已有中文注释一处都不能丢` });
  }
  const limit = input.maxLen + (input.lenTolerance ?? 0);
  if (maxSent > limit) {
    failures.push({ gate: '句长上限', message: `句长超线：最长句 ${maxSent} 词 > ${limit}（引语豁免后计量）` });
  }
  return {
    pass: failures.length === 0,
    failures,
    measured: { redBefore: input.redBefore, redAfter: input.redAfter, wordsBefore, wordsAfter, ratio: Number(ratio.toFixed(3)), annoBefore, annoAfter, maxSent },
  };
}

/* ───────────────── 段级回炉的选段与装配（项 1 App / 测试共用；纯函数） ───────────────── */

export interface ReworkPick {
  id: string;
  text: string;
  oov: string[];
  maxSent: number;
  reasons: string[];
}

/** 红项段判定：有未注生词，或引语豁免后仍有超长句。红项段才发 AI，其余一字不动。
 *  oovTokensOf 由调用方注入（App 用 S.currentKnown 词库口径；测试用可控词典）。 */
export function pickReworkSegments(md: string, oovTokensOf: (segText: string) => string[], maxLen: number): { reds: ReworkPick[]; segs: string[]; redSet: Set<string> } {
  const segs = String(md ?? '').match(/\[P\d+\][\s\S]*?(?=\[P\d+\]|$)/g) ?? [];
  const reds: ReworkPick[] = [];
  const redSet = new Set<string>();
  for (const seg of segs) {
    const id = seg.match(/\[(P\d+)\]/)?.[1] ?? 'P??';
    const oov = oovTokensOf(seg);
    const maxSent = maxSentenceLen(seg.replace(/\[P\d+\]/g, ' '), { exemptQuotes: true }); // 标记不算句长
    const reasons: string[] = [];
    if (oov.length) reasons.push(`未注生词 ${oov.length} 个（${[...new Set(oov)].slice(0, 8).join('、')}）`);
    if (maxSent > maxLen) reasons.push(`最长句 ${maxSent} 词超上限 ${maxLen}（引语已豁免）`);
    if (reasons.length) {
      reds.push({ id, text: seg, oov, maxSent, reasons });
      redSet.add(seg);
    }
  }
  return { reds, segs, redSet };
}

/** 装配：只把「过闸采纳」的段在原文里原位替换；挂起/未选段不进表 → 原文一字不动。
 *  find 用整段原文锚定（段带 [P##] 编号天然唯一）；替换失败如实点名，不静默。 */
export function applyReworkPicks(md: string, accepted: Array<{ find: string; replace: string }>): { md: string; replaced: number; failed: string[] } {
  let out = String(md ?? '');
  let replaced = 0;
  const failed: string[] = [];
  for (const a of accepted) {
    if (!out.includes(a.find)) {
      failed.push(a.find.slice(0, 24));
      continue;
    }
    out = out.replace(a.find, a.replace);
    replaced++;
  }
  return { md: out, replaced, failed };
}

/* ───────────────────────────── 回炉台账汇总（脚本 --report 与 MCP layer_rework_ledger 共用） ── */

export interface LedgerRow {
  tier?: string;
  chapter?: string;
  seg?: string;
  verdict?: string;
  reason?: string;
  class?: string;
  [k: string]: unknown;
}

export interface LedgerSummary {
  total: number;
  badLines: number;
  byVerdict: Record<string, number>;
  hung: number;
  hungByTier: Record<string, number>;
  groups: Array<{ cls: HangClass | string; count: number; items: Array<{ tier: string; chapter: string; seg: string; reason: string }> }>;
  /** 下一轮建议顺序（组内数量降序） */
  nextOrder: Array<HangClass | string>;
}

/** 解析并汇总回炉台账 JSONL。空文本/全坏行返回 null（调用方说出口，不静默当 0）。 */
export function summarizeLedger(text: string, ctx?: { sentLimitOf?: (tier: string) => number | undefined }): LedgerSummary | null {
  const lines = String(text ?? '')
    .split('\n')
    .filter((l) => l.trim());
  if (!lines.length) return null;
  const rows: LedgerRow[] = [];
  let badLines = 0;
  for (const l of lines) {
    try {
      rows.push(JSON.parse(l) as LedgerRow);
    } catch {
      badLines++;
    }
  }
  if (!rows.length) return { total: 0, badLines, byVerdict: {}, hung: 0, hungByTier: {}, groups: [], nextOrder: [] };
  const byVerdict: Record<string, number> = {};
  const hungRows: LedgerRow[] = [];
  for (const r of rows) {
    const v = String(r.verdict ?? '');
    byVerdict[v] = (byVerdict[v] ?? 0) + 1;
    if (v === '挂起') hungRows.push(r);
  }
  const hungByTier: Record<string, number> = {};
  for (const h of hungRows) hungByTier[String(h.tier ?? '?')] = (hungByTier[String(h.tier ?? '?')] ?? 0) + 1;
  const grouped = new Map<string, LedgerRow[]>();
  for (const h of hungRows) {
    const cls = String(h.class || classifyHangReason(String(h.reason ?? ''), { sentLimit: ctx?.sentLimitOf?.(String(h.tier ?? '')) }));
    if (!grouped.has(cls)) grouped.set(cls, []);
    grouped.get(cls)!.push(h);
  }
  const groups = [...grouped.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([cls, list]) => ({
      cls,
      count: list.length,
      items: list.map((h) => ({ tier: String(h.tier ?? ''), chapter: String(h.chapter ?? ''), seg: String(h.seg ?? ''), reason: String(h.reason ?? '') })),
    }));
  return { total: rows.length, badLines, byVerdict, hung: hungRows.length, hungByTier, groups, nextOrder: groups.map((g) => `${g.cls}(${g.count})`) };
}
