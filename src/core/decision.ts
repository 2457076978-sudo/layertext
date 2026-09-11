// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，本仓库已部署版权验证体系，细节不予公开（docs/版权与授权.md）。
/**
 * LayerText · 教师决定事件（append-only）+ 入库提议
 *
 * 审查报告 §一 的两条要求：
 *   ① 「教师修改不应只写 mark JSON。保留原始标记，同时追加不可变事件：
 *      decision, before, after, reason, ruleIds, teacherId, timestamp, sourceVersion」
 *   ② 「离线汇总器再把『采纳过的释义』提议进词典、『误报』提议进词表例外、
 *      『同类改写』提议进改写模板；**任何入库都要人工确认**」
 *
 * 与既有《AI建议台账.csv》（src/core/adoption.ts）的分工：
 *   台账 = 可编辑的**分析数据源**（列固定、便于 pandas/Excel 统计）；
 *   事件日志 = **不可变事实**（append-only JSONL，一行一条、只增不改）。
 *   台账可以重建，事件不能。所以事件是正本，台账由事件导出——而不是两份并行维护
 *   （并行维护正是"词表/专名表/词典口径漂移"那类事故的成因）。
 *
 * 本模块只做纯逻辑：造事件、解析事件、由事件生成**提议**。
 * 它**从不写词库、从不改词典**——入库的那一步永远留给教师。
 */

import type { GateCategory } from './segmentgate.js';

export const DECISION_SCHEMA_VERSION = 1;

/** 教师在风险队列上能按的三个键 + 直改 */
export type DecisionKind = 'accept' | 'reject' | 'false-positive' | 'edit' | 'rejected' | 'undo';
export const DECISION_LABEL: Record<DecisionKind, string> = {
  accept: '采纳',
  reject: '退回重写',
  'false-positive': '标记误报',
  edit: '直改',
  /** **动作没能执行**（稿件改过 / 找不到位置 / 写入失败）。
   *  与教师的 `reject`（"我不同意这条"）完全是两回事：
   *  这条是"系统没做成"，必须留痕、且**卡片不许消失**——
   *  否则就成了"卡片没了、正文也没变"的两头空。 */
  rejected: '执行失败（未改稿）',
  /** **撤销**：把被指向的那条决定作废。
   *  它是**新事件**，不是删历史——历史一条不删，`undoOf` 指回被撤销的那条。
   *  作废之后的项**回到待办**（教师改主意是常态，界面得让他回得来）。 */
  undo: '撤销',
};

/** 这条决策针对的东西——离线汇总器靠它决定"该提议进哪里" */
export interface DecisionSubject {
  kind: 'word' | 'number' | 'proper' | 'sentence' | 'other';
  value: string;
}

/** 一条不可变事件。字段名与报告 §一 一一对应（英文键，便于跨工具消费） */
export interface DecisionEvent {
  schemaVersion: number;
  /** 正本 ID：风险队列 item.id（`第一章#2:FACT-01:1911`）或人工标记 ID */
  itemId: string;
  decision: DecisionKind;
  /** 教师看到的内容（原句 / 原释义） */
  before: string;
  /** 采纳或直改后的内容；标记误报时为原样 */
  after: string;
  reason: string;
  ruleIds: string[];
  teacherId: string;
  timestamp: string;
  /** 产物版本标识（源文件哈希），用来回答"这条决定是对着哪一版做的" */
  sourceVersion: string;
  book?: string;
  chapter?: string;
  tier?: string;
  segIndex?: number;
  subject?: DecisionSubject;
  /** 规则类别冗余一份：汇总器不必回查规则表也能分组（规则表改了也不影响历史事件的解读） */
  category?: GateCategory;
  /** 撤销指针：这条 `undo` 事件作废的是哪一条（按 `itemId + timestamp` 定位）。
   *  **撤销不删历史**——被撤销的那条仍然在日志里，只是不再算数。 */
  undoOf?: string;
}

export interface MakeDecisionInput extends Omit<DecisionEvent, 'schemaVersion' | 'timestamp'> {
  timestamp?: string;
}

/** 造一条事件：补齐 schemaVersion 与时间戳。时间戳只在缺省时生成，便于测试确定性。 */
export function makeDecisionEvent(input: MakeDecisionInput): DecisionEvent {
  if (!input.itemId) throw new Error('决定事件必须有 itemId（风险队列项 ID）——否则事后无法回答"这条决定是关于什么的"');
  if (!input.teacherId) throw new Error('决定事件必须有 teacherId——否则多教师并行时无法审计');
  return {
    schemaVersion: DECISION_SCHEMA_VERSION,
    ...input,
    ruleIds: [...new Set(input.ruleIds ?? [])],
    timestamp: input.timestamp ?? new Date().toISOString(),
  };
}

export const toDecisionLine = (e: DecisionEvent): string => JSON.stringify(e) + '\n';

export interface ParseDecisionResult {
  events: DecisionEvent[];
  /** 坏行（JSON 解析失败或字段不全）——**不静默丢弃**，计数交给上层报警 */
  badLines: number;
}

/** 解析事件日志（append-only JSONL）。坏行计数而不抛，保证一条坏行不会让整份日志不可读。 */
export function parseDecisionLog(text: string): ParseDecisionResult {
  const events: DecisionEvent[] = [];
  let badLines = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as DecisionEvent;
      if (!o || typeof o.itemId !== 'string' || typeof o.decision !== 'string' || typeof o.timestamp !== 'string') {
        badLines++;
        continue;
      }
      events.push({ ...o, ruleIds: Array.isArray(o.ruleIds) ? o.ruleIds : [] });
    } catch {
      badLines++;
    }
  }
  return { events, badLines };
}

/** itemId → 最新一条决定（后写的覆盖先写的：教师改主意是常态，但历史事件一条都不删） */
export function decisionIndex(events: DecisionEvent[]): Map<string, DecisionEvent> {
  const m = new Map<string, DecisionEvent>();
  for (const e of events) {
    const prev = m.get(e.itemId);
    if (!prev || prev.timestamp <= e.timestamp) m.set(e.itemId, e);
  }
  return m;
}

/** 同一 itemId 被反复改变主意 → 说明这条规则/这个词的判定本身有问题，值得单独看 */
export function contestedItems(events: DecisionEvent[], minFlips = 2): { itemId: string; flips: number }[] {
  const byId = new Map<string, Set<string>>();
  for (const e of events) {
    if (!byId.has(e.itemId)) byId.set(e.itemId, new Set());
    byId.get(e.itemId)!.add(e.decision);
  }
  return [...byId]
    .filter(([, kinds]) => kinds.size >= minFlips)
    .map(([itemId, kinds]) => ({ itemId, flips: kinds.size }))
    .sort((a, b) => b.flips - a.flips || (a.itemId < b.itemId ? -1 : 1));
}

/* ────────────────────── 离线汇总：从事件生成"入库提议" ────────────────────── */

export type ProposalKind = 'dict-entry' | 'kb-exception' | 'rewrite-template';
export const PROPOSAL_LABEL: Record<ProposalKind, string> = {
  'dict-entry': '统一词典新增/修改释义',
  'kb-exception': '词表例外（确认学生学过，不必再加注）',
  'rewrite-template': '改写模板（同类改写反复出现）',
};

export interface Proposal {
  kind: ProposalKind;
  /** 提议的键：词条 / 词 / 规则号 */
  key: string;
  /** 提议的值：释义 / 空 / 模板说明 */
  value: string;
  reason: string;
  /** 支持这条提议的事件条数 */
  count: number;
  /** 证据（人要看得到"为什么"） */
  evidence: { itemId: string; before: string; after: string; teacherId: string; timestamp: string }[];
  /** 受影响/受益的规则号 */
  ruleIds: string[];
  /** ★ 恒为 true：本模块只提议，入库一律由教师确认（报告 §一 明文要求） */
  requiresConfirmation: true;
}

export interface ProposalOptions {
  /** 至少多少条同类事件才提议（默认 2：一条可能是偶然，两条开始像模式） */
  minSupport?: number;
  /** 每条提议最多留几条证据 */
  maxEvidence?: number;
}

/** 从事件生成入库提议。**只读、不写任何文件**——写库永远由人在确认后执行。 */
export function buildProposals(events: DecisionEvent[], opts: ProposalOptions = {}): Proposal[] {
  const minSupport = opts.minSupport ?? 2;
  const maxEvidence = opts.maxEvidence ?? 5;
  const ev = (e: DecisionEvent) => ({ itemId: e.itemId, before: e.before, after: e.after, teacherId: e.teacherId, timestamp: e.timestamp });
  const out: Proposal[] = [];

  /** ① 采纳过的释义 → 词典。取"accept/edit 且 after 非空、subject 是词"的事件 */
  const dict = new Map<string, DecisionEvent[]>();
  /** ② 误报 → 词表例外。取"false-positive 且 subject 是词"的事件 */
  const except = new Map<string, DecisionEvent[]>();
  /** ③ 同类改写 → 模板。按规则号聚合 edit */
  const templ = new Map<string, DecisionEvent[]>();

  for (const e of events) {
    const word = e.subject?.kind === 'word' ? e.subject.value.toLowerCase() : '';
    if (word && (e.decision === 'accept' || e.decision === 'edit') && e.after.trim()) {
      if (!dict.has(word)) dict.set(word, []);
      dict.get(word)!.push(e);
    }
    if (word && e.decision === 'false-positive') {
      if (!except.has(word)) except.set(word, []);
      except.get(word)!.push(e);
    }
    if (e.decision === 'edit' && e.ruleIds.length) {
      const k = [...e.ruleIds].sort().join('+');
      if (!templ.has(k)) templ.set(k, []);
      templ.get(k)!.push(e);
    }
  }

  for (const [word, list] of dict) {
    if (list.length < minSupport) continue;
    const value = list[list.length - 1].after.trim();
    out.push({
      kind: 'dict-entry',
      key: word,
      value,
      reason: `教师对「${word}」采纳了释义「${value}」，共 ${list.length} 次——建议写进统一词典，后续章节自动一致`,
      count: list.length,
      evidence: list.slice(0, maxEvidence).map(ev),
      ruleIds: [...new Set(list.flatMap((e) => e.ruleIds))],
      requiresConfirmation: true,
    });
  }

  for (const [word, list] of except) {
    if (list.length < minSupport) continue;
    out.push({
      kind: 'kb-exception',
      key: word,
      value: '',
      reason: `教师把「${word}」标为误报 ${list.length} 次——建议进词表例外，工具不再对它报警`,
      count: list.length,
      evidence: list.slice(0, maxEvidence).map(ev),
      ruleIds: [...new Set(list.flatMap((e) => e.ruleIds))],
      requiresConfirmation: true,
    });
  }

  for (const [rules, list] of templ) {
    if (list.length < minSupport) continue;
    out.push({
      kind: 'rewrite-template',
      key: rules,
      value: list
        .slice(0, maxEvidence)
        .map((e) => `${e.before.trim()} → ${e.after.trim()}`)
        .join(' ｜ '),
      reason: `规则 ${rules} 下教师直改 ${list.length} 次——同类改写反复出现，建议固化成改写模板并写进提示词`,
      count: list.length,
      evidence: list.slice(0, maxEvidence).map(ev),
      ruleIds: rules.split('+'),
      requiresConfirmation: true,
    });
  }

  // 提议排序：证据多的先看；同数量按类别（词典 > 例外 > 模板）
  const order: ProposalKind[] = ['dict-entry', 'kb-exception', 'rewrite-template'];
  return out.sort((a, b) => b.count - a.count || order.indexOf(a.kind) - order.indexOf(b.kind) || (a.key < b.key ? -1 : 1));
}

/** 决定统计：给运行清单与报告用（采纳率/误报率是"规则准不准"的直接度量） */
export interface DecisionStat {
  total: number;
  byDecision: Record<string, number>;
  byRule: Record<string, number>;
  /** 误报率 = 误报 / 全部决定（规则噪音水平的直接度量） */
  falsePositiveRate: number;
  teachers: string[];
}

export function summarizeDecisions(events: DecisionEvent[]): DecisionStat {
  const byDecision: Record<string, number> = {};
  const byRule: Record<string, number> = {};
  const teachers = new Set<string>();
  for (const e of events) {
    byDecision[e.decision] = (byDecision[e.decision] ?? 0) + 1;
    for (const r of e.ruleIds) byRule[r] = (byRule[r] ?? 0) + 1;
    teachers.add(e.teacherId);
  }
  const total = events.length;
  return {
    total,
    byDecision,
    byRule,
    falsePositiveRate: total ? (byDecision['false-positive'] ?? 0) / total : 0,
    teachers: [...teachers].sort(),
  };
}
