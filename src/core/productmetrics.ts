// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，本仓库已部署版权验证体系，细节不予公开（docs/版权与授权.md）。
/**
 * LayerText · 可观测产品指标
 *
 * 来源：《LayerText 审查报告 v4_方向》的「系统性偏差」一节 ——
 *   「你确实有『不断加工程保险、回避产品承诺』的倾向：manifest、AST、事件账本都必要，
 *     但它们**不能替代一次成功的编辑闭环**。下一轮评估应加入可观测产品指标：
 *     首次点击到可采纳结果的时间、撤销率、批量动作后的人工回退率、
 *     以及教师在 10 次操作后的错误采纳率。」
 *
 * 这一条我要老实认账：前两批我做的门禁、事务、聚合仍然全是"让机器别出错"，
 * 只有这一节是**量教师那边的结果**。所以它必须能算出来、能看见、能被拿去对比，
 * 否则"下轮评估加入产品指标"就只是一句表态。
 *
 * 四个指标全部从**已有的事件日志**算出来（不新增埋点、不新增存储）：
 *   · `session-open` 事件由界面在打开队列时写一条（只多这一个事件类型）；
 *   · 其余全部来自 `accept/reject/false-positive/edit/rejected/undo`。
 *
 * ── 关于"错误采纳率"的一个诚实说明 ──────────────────────────────
 * 「错误采纳」需要真值，而系统没有真值——它不知道教师那次采纳事后看对不对。
 * 所以这里给的是**代理指标**：把操作序列切成前 N 次与之后，比两段的撤销率。
 * 撤销率在后段显著上升 = 越点越随手（疲劳与盲点）。
 * 这是可观测的、且与"错误采纳"同向；**但它不是错误率本身**，报告里必须这么写，
 * 不能拿一个代理指标冒充真值。
 */

import type { DecisionEvent } from './decision.js';

export const SESSION_OPEN = 'session-open';
/** 前多少次算"开头"（报告点名的 10 次） */
export const EARLY_OPS = 10;

export interface ProductMetrics {
  /** 一共有多少条决定（不含 open / undo） */
  decisions: number;
  /** 首次操作 → 第一次"可采纳结果"的毫秒数（没有 open 事件或没有 accept 时为 null） */
  timeToFirstAdoptMs: number | null;
  /** 撤销率 = 撤销次数 / 终态决定数 */
  undoRate: number;
  /** 批量采纳的条数 / 总采纳条数 */
  batchShare: number;
  /** 批量采纳后被撤销的比例（"批量动作后的人工回退率"） */
  batchRollbackRate: number;
  /** 执行失败率 = rejected / (decisions + rejected)——失败率高说明环境或稿件状态有问题 */
  applyFailureRate: number;
  /** 前 10 次操作的撤销率 */
  earlyUndoRate: number;
  /** 第 11 次起的撤销率 */
  lateUndoRate: number;
  /** 后段撤销率是否显著高于前段（**代理指标，不是错误率本身**） */
  fatigueSignal: boolean;
  /** 一句话结论（直接进报告） */
  notes: string[];
}

const isUndo = (e: DecisionEvent): boolean => e.decision === 'undo';
const isFailure = (e: DecisionEvent): boolean => e.decision === 'rejected';
const isBatch = (e: DecisionEvent): boolean => /^批量/.test(e.reason ?? '');

const timeOf = (e: DecisionEvent): number => Date.parse(e.timestamp);

/** 按时间排好的事件（同刻按原顺序，保证稳定） */
const ordered = (events: DecisionEvent[]): DecisionEvent[] =>
  events.map((e, i) => ({ e, i })).sort((a, b) => timeOf(a.e) - timeOf(b.e) || a.i - b.i).map((x) => x.e);

export function productMetrics(events: DecisionEvent[]): ProductMetrics {
  const evs = ordered(events);
  const opened = evs.find((e) => e.itemId === SESSION_OPEN);
  // 只数"决定"：session-open 与 undo 都不是决定（undo 是作废指令）
  const decisions = evs.filter((e) => !isUndo(e) && e.itemId !== SESSION_OPEN && !isFailure(e));
  const undoCount = evs.filter(isUndo).length;
  const failures = evs.filter(isFailure).length;

  const firstAccept = evs.find((e) => e.decision === 'accept');
  const timeToFirstAdoptMs =
    opened && firstAccept ? Math.max(0, timeOf(firstAccept) - timeOf(opened)) : null;

  // 撤销率的分母用"终态决定数"：被撤销的也是决定（只是作废了）
  const undoRate = decisions.length ? undoCount / decisions.length : 0;

  const batchAccepts = decisions.filter((e) => e.decision === 'accept' && isBatch(e));
  const accepts = decisions.filter((e) => e.decision === 'accept');
  const undoneRefs = new Set(evs.filter(isUndo).map((e) => e.undoOf).filter(Boolean) as string[]);
  const refOf = (e: DecisionEvent): string => `${e.itemId}@${e.timestamp}`;
  const rolledBack = batchAccepts.filter((e) => undoneRefs.has(refOf(e))).length;

  // 疲劳信号：把决定按时间切成前 N 次与之后，比撤销率
  const cut = EARLY_OPS;
  const early = decisions.slice(0, cut);
  const late = decisions.slice(cut);
  const undoneEarly = early.filter((e) => undoneRefs.has(refOf(e))).length;
  const undoneLate = late.filter((e) => undoneRefs.has(refOf(e))).length;
  const earlyUndoRate = early.length ? undoneEarly / early.length : 0;
  const lateUndoRate = late.length ? undoneLate / late.length : 0;

  const notes: string[] = [];
  if (timeToFirstAdoptMs !== null) {
    notes.push(`首次操作到拿到第一个可采纳结果：${(timeToFirstAdoptMs / 1000).toFixed(1)} 秒`);
  } else {
    notes.push('首次上手时间：缺 session-open 或还没有任何采纳，算不出来（不是 0）');
  }
  notes.push(`撤销率 ${(undoRate * 100).toFixed(1)}%（${undoCount}/${decisions.length}）`);
  if (batchAccepts.length) {
    notes.push(`批量采纳占 ${(batchShareOf(accepts, batchAccepts) * 100).toFixed(0)}%，其中被回退 ${(rolledBack / batchAccepts.length * 100).toFixed(0)}%`);
  } else {
    notes.push('还没有批量采纳——批量入口是否真的省了人工，目前无法回答');
  }
  if (failures) notes.push(`⚠ 执行失败 ${failures} 次（失败率 ${(applyFailureRateOf(decisions, failures) * 100).toFixed(0)}%）：偏高说明稿件状态或路径有问题，不是教师的问题`);
  if (late.length >= 3) {
    notes.push(
      `疲劳信号：前 ${cut} 次撤销率 ${(earlyUndoRate * 100).toFixed(0)}%，之后 ${(lateUndoRate * 100).toFixed(0)}%` +
        (lateUndoRate > earlyUndoRate * 1.5 && lateUndoRate > 0.1 ? '（**后段明显升高**：越点越随手）' : ''),
    );
  }
  notes.push('⚠「错误采纳率」是**代理指标**：系统没有真值，这里报的是后段撤销率上升——同向，但不是错误率本身');

  return {
    decisions: decisions.length,
    timeToFirstAdoptMs,
    undoRate,
    batchShare: batchShareOf(accepts, batchAccepts),
    batchRollbackRate: batchAccepts.length ? rolledBack / batchAccepts.length : 0,
    applyFailureRate: applyFailureRateOf(decisions, failures),
    earlyUndoRate,
    lateUndoRate,
    fatigueSignal: late.length >= 3 && lateUndoRate > earlyUndoRate * 1.5 && lateUndoRate > 0.1,
    notes,
  };
}

const batchShareOf = (accepts: DecisionEvent[], batch: DecisionEvent[]): number =>
  accepts.length ? batch.length / accepts.length : 0;
const applyFailureRateOf = (decisions: DecisionEvent[], failures: number): number =>
  decisions.length + failures ? failures / (decisions.length + failures) : 0;

/** 界面写"我打开了队列"的那一条事件（只多这一个事件类型）。 */
export function sessionOpenEvent(input: {
  tier: string;
  teacherId: string;
  sourceVersion: string;
  /** 队列当时有多少条待办——没有它就算不出"这次要处理多少" */
  pending: number;
  timestamp?: string;
}): DecisionEvent {
  return {
    schemaVersion: 1,
    itemId: SESSION_OPEN,
    decision: 'edit',
    before: '',
    after: '',
    reason: `打开风险队列（待办 ${input.pending} 条）`,
    ruleIds: [],
    teacherId: input.teacherId,
    timestamp: input.timestamp ?? new Date().toISOString(),
    sourceVersion: input.sourceVersion,
    tier: input.tier,
    subject: { kind: 'other', value: 'session-open' },
  };
}
