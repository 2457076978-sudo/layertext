// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，本仓库已部署版权验证体系，细节不予公开（docs/版权与授权.md）。
/**
 * 修改资产的复用与晋级 · 候选资产层（四方向方案 v2 方向三/批次 4）
 *
 * 存在的理由：决定事件（decision.ts）与三通道提议（buildProposals）已经把
 * 「教师改过什么」记全了，但回流是**一次性**的——提议确认即全书全局生效，
 * 没有"先在小范围用、证据够了再晋级"的路径。一次局部判断就这样污染整本书。
 *
 * 本模块在事件之上加一层**候选资产**：
 *   candidatesFromEvents 把同类决定聚成 LearningCandidate（evidenceCount、
 *   proposedScope 由证据分布推导）；范围只升不降靠教师显式 promote；
 *   撤销决定降低证据（applyUndo）。落库与注入都只消费 approved 资产（reusable）。
 *
 * 范围纪律（方案 §6.2）：
 *   · 最小有效范围：一次局部替换=当前句；同章同类≥2=本章；同书同层=本书同层；
 *     同书跨层=本书；跨书=本班（且只用已批准资产）。
 *   · 涉及具体人物/地点/情节的资产（plot-protection、proper-name-rule）
 *     自动范围封顶**本书**——永不自动跨书。
 *   · 晋级必须教师确认：promote 只是记录决定，不自动扩大。
 *
 * 纯逻辑：不读文件、不写库。
 */

import type { DecisionEvent } from './decision.js';

/* ────────────────────── 范围 ────────────────────── */

export type CandidateScope = 'sentence' | 'segment' | 'chapter' | 'book-tier' | 'book' | 'class' | 'global';

export const SCOPE_ORDER: readonly CandidateScope[] = ['sentence', 'segment', 'chapter', 'book-tier', 'book', 'class', 'global'] as const;

export const SCOPE_LABEL: Record<CandidateScope, string> = {
  sentence: '当前句',
  segment: '当前段',
  chapter: '本章',
  'book-tier': '本书同层',
  book: '本书',
  class: '本班',
  global: '全局',
};

export function scopeRank(scope: CandidateScope): number {
  return SCOPE_ORDER.indexOf(scope);
}

/** 消费侧取资产：只拿已批准且范围**不低于**当前使用范围的（教师批到"本书"的，
 *  别的书不许用；批到"本班"的，本书可用） */
export function reusable<T extends { status: string; proposedScope: CandidateScope }>(candidates: readonly T[], scope: CandidateScope): T[] {
  return candidates.filter((c) => c.status === 'approved' && scopeRank(c.proposedScope) >= scopeRank(scope));
}

/* ────────────────────── 候选资产 ────────────────────── */

export type AssetKind =
  | 'gloss-entry'       // 释义事实：tyrannise 统一释义
  | 'lexicon-entry'     // 词汇事实：误报/学生会 → 词表口径
  | 'rewrite-rule'      // 改写偏好：同类 before→after 反复出现
  | 'plot-protection'   // 情节保护：这句不能删（承载事件）
  | 'proper-name-rule'  // 专名写法
  | 'prompt-example';   // 提示词案例（远期：好改写回灌 few-shot）

/** 这些类别的事实属于这本书的世界——自动范围封顶"本书"，永不自动跨书 */
const BOOK_CAPPED: ReadonlySet<AssetKind> = new Set(['plot-protection', 'proper-name-rule']);

export interface LearningCandidate {
  id: string;
  /** 指回决定事件（事件是正本，候选只是视图——所有资产能指回决定事件） */
  sourceDecisionIds: string[];
  kind: AssetKind;
  /** 聚类键：词 / 规则组合 / 专名 */
  key: string;
  before?: string;
  after?: string;
  proposedScope: CandidateScope;
  /** 采纳证据条数（撤销会减——applyUndo） */
  evidenceCount: number;
  /** 采纳/(采纳+撤销)：撤销多的候选该降级而不是晋级 */
  confidence: number;
  status: 'candidate' | 'approved' | 'rejected' | 'superseded';
  /** 证据分布（晋级判断要看"是不是真的跨章/跨书了"） */
  evidenceChapters: string[];
  evidenceBooks: string[];
  evidenceTiers: string[];
  /** 各层最新的采纳内容（策略族的原料：跨层各自出过什么动作） */
  tierActions?: Partial<Record<'A' | 'M' | 'B', { after: string }>>;
  createdAt?: string;
  note?: string;
}

/* ────────────────────── 从事件聚合 ────────────────────── */

interface Group {
  kind: AssetKind;
  key: string;
  events: DecisionEvent[];
  undos: number;
  tierActions: Partial<Record<'A' | 'M' | 'B', { after: string }>>;
}

/** 一条事件是否已被后续 undo 作废（undoOf 指回 itemId+timestamp） */
const undoneIds = (events: readonly DecisionEvent[]): Set<string> =>
  new Set(
    events
      .filter((e) => e.decision === 'undo' && e.undoOf)
      .map((e) => e.undoOf!),
  );

/** 证据分布 → 默认最小有效范围（方案证据表的代码化） */
export function defaultScopeFor(dist: { chapters: string[]; books: string[]; tiers: string[]; count: number }, kind: AssetKind): CandidateScope {
  let scope: CandidateScope;
  if (dist.books.length > 1) scope = 'class';               // 跨书=班级级（且只消费已批准）
  else if (dist.chapters.length > 1) scope = dist.tiers.length > 1 ? 'book' : 'book-tier';
  else if (dist.count >= 2) scope = 'chapter';              // 同章同类≥2
  else scope = 'sentence';                                  // 一次局部替换停在当前句
  if (BOOK_CAPPED.has(kind) && scopeRank(scope) > scopeRank('book')) scope = 'book';
  return scope;
}

/** 聚合决定事件 → 候选资产。撤销不算正证据（confidence 里扣）。
 *  与 buildProposals 的分工：提议管"入库那一步"（教师确认即写），
 *  候选管"复用那一程"（范围晋级、跨层变换、下一章注入什么）。 */
export function candidatesFromEvents(events: readonly DecisionEvent[]): LearningCandidate[] {
  const undone = undoneIds(events);
  const groups = new Map<string, Group>();

  const add = (kind: AssetKind, key: string, e: DecisionEvent): void => {
    const id = `${kind}:${key}`;
    if (!groups.has(id)) groups.set(id, { kind, key, events: [], undos: 0, tierActions: {} });
    const g = groups.get(id)!;
    if (e.tier === 'A' || e.tier === 'M' || e.tier === 'B') {
      g.tierActions[e.tier] = { after: e.after }; // 同层多证据取最新
    }
    if (undone.has(`${e.itemId}\u0001${e.timestamp}`)) {
      g.undos++;
      return;
    }
    g.events.push(e);
  };

  for (const e of events) {
    if (e.decision === 'undo') continue; // undo 的计数效应在 add() 里按指针处理
    const word = e.subject?.kind === 'word' ? e.subject.value.toLowerCase() : '';
    if (word && (e.decision === 'accept' || e.decision === 'edit') && e.after.trim()) add('gloss-entry', word, e);
    if (word && e.decision === 'false-positive') add('lexicon-entry', word, e);
    if (e.decision === 'edit' && e.ruleIds.length) add('rewrite-rule', [...e.ruleIds].sort().join('+'), e);
    if (e.subject?.kind === 'proper') add('proper-name-rule', e.subject.value, e);
    /* 教师退回事实类改动 = 这句承载情节不许再动 → 保护候选（键=itemId 定位到句） */
    if (e.category === '事实' && e.decision === 'reject') add('plot-protection', e.itemId, e);
  }

  const out: LearningCandidate[] = [];
  for (const g of groups.values()) {
    if (!g.events.length) continue; // 只剩撤销、没有正证据：不成为候选
    const chapters = [...new Set(g.events.map((e) => e.chapter ?? '').filter(Boolean))];
    const books = [...new Set(g.events.map((e) => e.book ?? '').filter(Boolean))];
    const tiers = [...new Set(g.events.map((e) => e.tier ?? '').filter(Boolean))];
    const total = g.events.length + g.undos;
    const latest = g.events[g.events.length - 1]!;
    out.push({
      id: `cand-${g.kind}-${g.key}`.replace(/\s+/g, '_').slice(0, 80),
      sourceDecisionIds: g.events.map((e) => e.eventId ?? `${e.itemId}@${e.timestamp}`),
      kind: g.kind,
      key: g.key,
      before: g.events[0]!.before,
      after: latest.after || undefined,
      proposedScope: defaultScopeFor({ chapters, books, tiers, count: g.events.length }, g.kind),
      evidenceCount: g.events.length,
      confidence: Number((g.events.length / Math.max(1, total)).toFixed(2)),
      status: 'candidate',
      evidenceChapters: chapters,
      evidenceBooks: books,
      evidenceTiers: tiers,
      tierActions: Object.keys(g.tierActions).length ? g.tierActions : undefined,
    });
  }
  return out.sort((a, b) => b.evidenceCount - a.evidenceCount || a.id.localeCompare(b.id));
}

/* ────────────────────── 晋级与撤销 ────────────────────── */

/** 教师显式晋级/批准（范围可以维持或升档；升档必须来自这个调用，别处不许改 scope） */
export function promote(candidates: LearningCandidate[], id: string, scope?: CandidateScope, note?: string): LearningCandidate[] {
  return candidates.map((c) =>
    c.id === id && c.status === 'candidate'
      ? { ...c, status: 'approved' as const, proposedScope: scope ?? c.proposedScope, note: note ?? c.note }
      : c,
  );
}

/** 拒绝候选——**或撤回批准**（教师改主意是常态：批过的资产也要能收回）。 */
export function rejectCandidate(candidates: LearningCandidate[], id: string, note?: string): LearningCandidate[] {
  return candidates.map((c) => (c.id === id && c.status !== 'rejected' && c.status !== 'superseded' ? { ...c, status: 'rejected' as const, note: note ?? c.note } : c));
}

/** 新证据到了：同键候选证据 +1；撤销事件落到哪个键就扣哪个键（evidenceCount 减、confidence 降） */
export function applyUndo(candidates: LearningCandidate[], undoneDecisionId: string): LearningCandidate[] {
  return candidates.map((c) => {
    if (!c.sourceDecisionIds.includes(undoneDecisionId)) return c;
    const evidenceCount = Math.max(0, c.evidenceCount - 1);
    return {
      ...c,
      evidenceCount,
      confidence: Number(Math.max(0, c.confidence - 0.2).toFixed(2)),
      status: evidenceCount === 0 ? 'rejected' : c.status === 'approved' ? 'candidate' : c.status,
      note: `${c.note ?? ''}｜撤销一条证据`.replace(/^\|/, ''),
    };
  });
}

/* ────────────────────── 跨层策略族 ────────────────────── */

export interface RewriteAction {
  action: 'keep' | 'gloss' | 'rewrite';
  gloss?: string;
  rewrite?: string;
}

export interface RewriteFamily {
  concept: string;
  sourceTerm: string;
  /** 每层只放**该层自己证据支持**的动作——A 层的修改自动列为其他层的"待定"，
   *  绝不直接复制（方案 §6.2 第 4 条：跨层复用必须变换，不是复制） */
  byTier: Partial<Record<'A' | 'M' | 'B', RewriteAction>>;
}

/** 同一个词/概念的决定按层聚类 → 策略族。只有出现过的层有动作，其余层留白
 *  （留白=候选待定，教师确认后补；不是"A 层怎么写 M/B 就怎么写"）。 */
export function familiesFromCandidates(candidates: readonly LearningCandidate[]): RewriteFamily[] {
  const byTerm = new Map<string, Partial<Record<'A' | 'M' | 'B', RewriteAction>>>();
  for (const c of candidates) {
    if ((c.kind !== 'gloss-entry' && c.kind !== 'rewrite-rule') || !c.tierActions) continue;
    if (!byTerm.has(c.key)) byTerm.set(c.key, {});
    const family = byTerm.get(c.key)!;
    for (const [tier, act] of Object.entries(c.tierActions) as Array<[('A' | 'M' | 'B'), { after: string }]>) {
      if (family[tier]) continue;
      /* 层内动作由内容形态决定：中文释义=保留加注（gloss）；英文改写=换成简单说法（rewrite）。
       * 只放该层自己证据支持的动作，其余层留白——绝不跨层复制。 */
      family[tier] = /[\u4e00-\u9fff]/.test(act.after)
        ? { action: 'gloss', gloss: act.after }
        : { action: 'rewrite', rewrite: act.after };
    }
  }
  return [...byTerm.entries()]
    .filter(([, byTier]) => Object.keys(byTier).length > 0)
    .map(([sourceTerm, byTier]) => ({ concept: sourceTerm, sourceTerm, byTier }));
}
