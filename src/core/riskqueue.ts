// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，本仓库已部署版权验证体系，细节不予公开（docs/版权与授权.md）。
/**
 * LayerText · 段级风险队列
 *
 * 为什么要有它（2026-09-11 审查报告 §一）：
 *   人工校正不该是"从第一段读到第 245 段"，而该是"只看机器点名的地方"。
 *   报告给的判断是：数字/日期/专名/角色关系里只有 5–10% 需要人看，OOV 漏注 10–20%，
 *   句法 10–15%，而情节事实/因果/语气必须抽查。**按段顺序呈现 = 把 7 小时花在低风险段上**。
 *
 * 本模块把段级门禁（segmentgate）产出的问题展开成**一条问题一项**的队列：
 *   · 每项：原句 / 改写句 / 上下文各一句 / 触发规则 / 风险分
 *   · 排序：risk = 概率 × 后果（见 GATE_RULES），事实差异置顶，低风险润色垫底
 *   · 附"一小时最短路径"的时间预算：队列超过 60 分钟就说明该修规则或词库，而不是硬看
 *
 * 与门禁的分工：门禁回答"这段能不能算完成"（blocker 阻塞落盘），
 * 风险队列回答"人先看哪一条"（warn 也在队列里，只是排在后面）。
 */

import { alignSentencePairs, type AlignSentRef } from './align.js';
import { GATE_RULES, stripMarkers, type GateCategory, type GateProblem, type GateSeverity } from './segmentgate.js';
import { sentsOf } from './textpipe.js';

/** 一段的门禁产出（脚本扫描产物时逐段收集） */
export interface SegmentRiskInput {
  book?: string;
  tier?: string;
  chapter: string;
  /** 0 起的段序号 */
  segIndex: number;
  /** 原文段（含 [P##]） */
  source: string;
  /** 改写段（含 [P##]） */
  rewritten: string;
  problems: GateProblem[];
}

export interface RiskItem {
  /** 稳定 ID：同一段同一条规则同一个词永远同一个 ID（教师决策事件靠它关联） */
  id: string;
  ruleId: string;
  category: GateCategory;
  severity: GateSeverity;
  /** 后果 */
  consequence: number;
  /** 概率 */
  probability: number;
  /** risk = 概率 × 后果 */
  risk: number;
  book?: string;
  tier?: string;
  chapter: string;
  segIndex: number;
  segLabel: string;
  title: string;
  /** 触发这条规则的原句 */
  sourceSentence: string;
  /** 对应的改写句（找不到时为空串——对事实类来说"找不到"本身就是证据） */
  rewrittenSentence: string;
  /** 上下文各一句（改写侧；改写侧没有则退原文侧） */
  context: { prev: string; next: string };
  detail?: Record<string, unknown>;
}

export interface RiskQueue {
  items: RiskItem[];
  summary: {
    total: number;
    blockers: number;
    byRule: Record<string, number>;
    byCategory: Record<string, number>;
    /** 按"每条问题看 X 分钟"估的人工时长（分钟，一位小数） */
    estimatedMinutes: number;
  };
}

/** 逐类问题的预估人工耗时（分钟/项）：事实类要回原文核对，加注只看词典，语言类扫一眼 */
export const MINUTES_PER_ITEM: Record<string, number> = {
  'FACT-01': 2,
  'FACT-02': 2,
  'ANNO-01': 0.5,
  'ANNO-03': 0.7,
  'ANNO-02': 0.3,
  'SENT-01': 0.5,
  'LEN-01': 0.5,
  'ZH-01': 1,
};

/** 分句前先去掉 [P##] 段标记：段号不属于任何一句话，
 *  留在句子里会让"原句"显示成「[P03] The animals…」，也会被当成数字信号。 */
const refsOf = (text: string): AlignSentRef[] =>
  sentsOf(stripMarkers(text), false).map((t, si) => ({ pi: 0, si, text: t }));

/** 在句子数组里找含某个针的句子（词用词边界，信号用子串） */
function findSentence(sents: string[], needle: string): number {
  const n = needle.toLowerCase();
  const isWord = /^[A-Za-z]/.test(needle);
  for (let i = 0; i < sents.length; i++) {
    const s = sents[i].toLowerCase();
    if (isWord ? new RegExp(String.raw`\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(s) : s.includes(n)) return i;
  }
  return -1;
}

/** 该针在原文里处于第几句（用于把改写侧的对位句子找出来） */
function alignedRewrite(sents: string[], srcIdx: number, pairs: ReturnType<typeof alignSentencePairs>): string {
  if (srcIdx < 0) return '';
  const row = pairs.find((r) => r.base?.si === srcIdx);
  return row?.cur?.text ?? '';
}

function context(index: number, sents: string[]): { prev: string; next: string } {
  return {
    prev: index > 0 ? sents[index - 1] : '',
    next: index >= 0 && index + 1 < sents.length ? sents[index + 1] : '',
  };
}

/** 把一条 GateProblem 展开成一条或多条 RiskItem */
function expand(input: SegmentRiskInput, p: GateProblem): RiskItem[] {
  const rule = GATE_RULES[p.ruleId];
  const srcSents = sentsOf(stripMarkers(input.source), false);
  const curSents = sentsOf(stripMarkers(input.rewritten), false);
  const pairs = alignSentencePairs(refsOf(input.source), refsOf(input.rewritten));
  const base = {
    ruleId: p.ruleId,
    category: p.category,
    severity: p.severity,
    consequence: rule.weight,
    probability: rule.probability,
    risk: Number((rule.weight * rule.probability).toFixed(2)),
    book: input.book,
    tier: input.tier,
    chapter: input.chapter,
    segIndex: input.segIndex,
    segLabel: `${input.chapter} 第${input.segIndex + 1}段`,
    detail: p.detail,
  };
  /** 造一条：针用于定位原句/改写句；pivot 是这条问题自己的靶子（某个数字/某个词/某句话） */
  const make = (key: string, title: string, needle: string, pivot: Record<string, unknown>, curOverride?: string): RiskItem => {
    const si = needle ? findSentence(srcSents, needle) : -1;
    const ci = needle ? findSentence(curSents, needle) : -1;
    const rewrittenSentence = curOverride ?? (ci >= 0 ? curSents[ci] : alignedRewrite(curSents, si, pairs));
    // 上下文优先给改写侧的邻居；改写里根本找不到这条（事实类丢信号）时退回原文侧，
    // 否则卡片上只有「—」，教师没有上下文可判断"到底是删了还是换了说法"。
    const ctx = ci >= 0 ? context(ci, curSents) : context(si, srcSents);
    return {
      ...base,
      detail: { ...p.detail, ...pivot },
      id: `${input.chapter}#${input.segIndex}:${p.ruleId}:${key}`,
      title,
      sourceSentence: si >= 0 ? srcSents[si] : '',
      rewrittenSentence,
      context: ctx,
    };
  };

  const list = (k: unknown): string[] => (Array.isArray(k) ? (k as string[]) : []);
  switch (p.ruleId) {
    case 'FACT-01':
    case 'FACT-02':
      // 每个数字/专名单独一条：教师是逐个核对"1911 有没有变成 1912"，不是整段看
      return list(p.detail?.signals).map((s) => make(s, `原文的「${s}」在改写里找不到`, s, { signal: s }));
    case 'ANNO-01':
      return list(p.detail?.missing).map((w) => make(w, `超纲词 ${w} 没有加注`, w, { word: w }));
    case 'ANNO-02':
      return list(p.detail?.words).map((w) => make(w, `同一个词 ${w} 注了不止一次`, w, { word: w }));
    case 'ANNO-03': {
      const cs = (p.detail?.conflicts ?? []) as { word: string; zh: string; expected: string }[];
      return cs.map((c) => make(c.word, `${c.word} 注成「${c.zh}」，统一词典是「${c.expected}」`, c.word, { conflict: c }));
    }
    case 'SENT-01':
      // 每个超长句单独一条，并把原文对位句一并给出（人要看懂这句原本是什么）
      return list(p.detail?.sentences).map((s, i) =>
        make(String(i), `改写句 ${s.trim().split(/\s+/).length} 词，超过本层上限 ${p.detail?.maxLen ?? ''} 词`, '', { sentence: s, index: i }, s),
      );
    default:
      return [make('0', p.message, '', {})];
  }
}

/** 队列全部项的排序：risk 降序 → 事实类优先 → 章序/段序稳定 */
function compare(a: RiskItem, b: RiskItem): number {
  if (b.risk !== a.risk) return b.risk - a.risk;
  if (b.consequence !== a.consequence) return b.consequence - a.consequence;
  if (a.chapter !== b.chapter) return a.chapter < b.chapter ? -1 : 1;
  if (a.segIndex !== b.segIndex) return a.segIndex - b.segIndex;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 逐段输入 → 风险队列（已排序、已汇总、已估算人工时长） */
export function buildRiskQueue(segments: SegmentRiskInput[]): RiskQueue {
  const items: RiskItem[] = [];
  for (const seg of segments) for (const p of seg.problems) items.push(...expand(seg, p));
  items.sort(compare);
  const byRule: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  let minutes = 0;
  for (const it of items) {
    byRule[it.ruleId] = (byRule[it.ruleId] ?? 0) + 1;
    byCategory[it.category] = (byCategory[it.category] ?? 0) + 1;
    minutes += MINUTES_PER_ITEM[it.ruleId] ?? 0.5;
  }
  return {
    items,
    summary: {
      total: items.length,
      blockers: items.filter((i) => i.severity === 'blocker').length,
      byRule,
      byCategory,
      estimatedMinutes: Number(minutes.toFixed(1)),
    },
  };
}

/* ────────────────────── 一小时最短路径（审查报告 §一 的落地） ────────────────────── */

export interface PlanPhase {
  id: string;
  title: string;
  /** 该阶段要处理的队列项（已按风险排序，直接照单子看） */
  items: RiskItem[];
  /** 该阶段的时间预算（分钟） */
  budget: number;
  note: string;
}

export interface OneHourPlan {
  phases: PlanPhase[];
  /** 队列估时是否超过预算 → 该停下来修规则/词库，而不是硬着头皮看 */
  overBudget: boolean;
  estimatedMinutes: number;
  advice: string;
}

/**
 * 一小时最短路径：10 分钟看统计和最危险的队列项 → 25 分钟处理事实/专名/数字差异
 * → 15 分钟处理所有漏注与超纲释义 → 10 分钟抽查每章首尾与高风险段。
 * 超过预算时给的是"先修生成规则或词库"，不是"加班"。
 */
export function oneHourPlan(queue: RiskQueue, budget = 60): OneHourPlan {
  const facts = queue.items.filter((i) => i.category === '事实');
  const anno = queue.items.filter((i) => i.ruleId === 'ANNO-01' || i.ruleId === 'ANNO-03');
  const rest = queue.items.filter((i) => !facts.includes(i) && !anno.includes(i));
  const phases: PlanPhase[] = [
    { id: 'overview', title: '看统计与最危险队列项', items: queue.items.slice(0, 5), budget: 10, note: '先看 summary 与排在最前面的几条，判断这一层整体是否可信' },
    { id: 'facts', title: '处理事实/专名/数字差异', items: facts, budget: 25, note: '逐条回原文核对；这是唯一机器判不准、后果又最重的一类' },
    { id: 'anno', title: '处理全部漏注与超纲释义', items: anno, budget: 15, note: '对照统一词典，一键采纳或改释义（改完进词典，后面章节自动一致）' },
    { id: 'spot', title: '抽查每章首尾及高风险段', items: rest, budget: 10, note: '剩下的语言类问题按风险顺序扫，低风险润色可以不看' },
  ];
  const estimatedMinutes = queue.summary.estimatedMinutes;
  const overBudget = estimatedMinutes > budget;
  return {
    phases,
    overBudget,
    estimatedMinutes,
    advice: overBudget
      ? `队列估时 ${estimatedMinutes} 分钟，超过 ${budget} 分钟预算 → 停止扩展审校，先修生成规则或词库（否则每本书都要花这么多人工）。`
      : `队列估时 ${estimatedMinutes} 分钟，在 ${budget} 分钟预算内，按阶段顺序走即可。`,
  };
}
