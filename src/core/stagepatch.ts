// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，本仓库已部署版权验证体系，细节不予公开（docs/版权与授权.md）。
/**
 * 工序化调适 · 差量 patch 协议（四方向方案 v2 §3.1，唯一定义）
 *
 * 存在的理由：三条既有 AI 路径（三档生成/两轮调适/会话改写）都是**整段全文返回、
 * 整段替换**——每道工序都为没变的段落付输出 token，且"模型顺手改了不该改的段"
 * 无法在协议层发现。本模块把"AI 只返回变化段"定成协议：请求侧声明只处理哪些段，
 * 响应侧只接受段级 patch；其余段落一律原样。
 *
 * 纪律（对应方案 §3.1 与 §九 防错清单）：
 *   · 返回整章文本 = 实现不合格：一个 changed patch 里出现**多个**段标记即拒绝该 patch；
 *   · 未返回的段保持原样：mergePatch 不清空、不重排、不重写未提及的段；
 *   · changed 段先过门禁（gateSegment）再合并；blocked 段不合并、交调用方隔离；
 *   · protectedFacts（专名/数字/否定/因果口径）patch 前后对照不过则整段拒绝。
 *
 * 纯逻辑：不读文件、不调 AI、不 throw 业务外的意外——解析失败返回 ok:false 的
 * 诊断（调用方决定重试或隔离），不把半截 patch 静默吞下去。
 */

import type { SegmentVerdict } from './segmentgate.js';
import { gateSegment, stripMarkers } from './segmentgate.js';

/* ────────────────────── 工序枚举（与 stagescan/stagepipe 共用） ────────────────────── */

export type Stage = 'vocab-primary' | 'syntax' | 'vocab-secondary' | 'coherence' | 'annotation';

/** 工序顺序固定：加注永远最后（词汇句法定了再注，不为补救反复改注释） */
export const STAGE_ORDER: readonly Stage[] = ['vocab-primary', 'syntax', 'vocab-secondary', 'coherence', 'annotation'] as const;

export const STAGE_LABEL: Record<Stage, string> = {
  'vocab-primary': '词汇粗筛',
  syntax: '句法调适',
  'vocab-secondary': '词汇复筛',
  coherence: '连贯性',
  annotation: '最终加注',
};

/* ────────────────────── 各工序生效的门禁规则 ──────────────────────
 * 同一段在不同工序点该守的规矩不同：词汇粗筛之后句子可能还长（句法工序没跑），
 * 此时 SENT-01 不该拦；注释之前 ANNO-01 必然全红。
 * 篇幅（LEN-01）不在任何工序点拦截（2026-09-12 移除）：两轮调适制已拍板"篇幅比例
 *  退役为参考"（保留篇幅与阅读难度没有稳定对应关系，不为压篇幅删内容）——工序化若
 *  继续按 原文×ratio±12% 硬拦，等于两套尺。目标词数仍作为 issue 软提示给模型，
 *  篇幅数据进章 recap 供教师参考，LEN-01 本体保留在 GATE_RULES 供报表与单句改写路径。
 * 规则号全部来自 segmentgate 的
 * GATE_RULES（唯一口径），这里只声明"这道工序点上，哪些规则命中即拒绝合并"——
 * 不新造规则、不改权重。FACT-01/02 在门禁里是 warn（机器只能提示），但连贯性
 * 工序的职责就是保事实，所以在它那道上升为拒绝条件（方案表 2：结果须过事实对照）。 */
export const STAGE_BLOCK_RULES: Record<Stage, readonly string[]> = {
  'vocab-primary': ['ZH-01'],
  syntax: ['ZH-01', 'SENT-01'],
  'vocab-secondary': ['ZH-01'],
  coherence: ['ZH-01', 'FACT-01', 'FACT-02'],
  annotation: ['ZH-01', 'SENT-01', 'ANNO-01'],
};

/* ────────────────────── 协议结构 ────────────────────── */

export interface StagePatchRequest {
  stage: Stage;
  /** 本次 patch 基于的稿本版本（调用方的版本节点；协议只透传） */
  baseVersion: string;
  /** 只处理这些段（本地扫描命中的）；未列出的段不在请求里 */
  segments: Array<{ id: string; source: string; draft: string; issues: string[] }>;
  /** 本地保真检查生成的事实口径（数字/专名/否定/因果），进入 prompt 与 patch 校验 */
  protectedFacts: string[];
  instruction: string;
}

export interface StagePatchItem {
  id: string;
  status: 'changed' | 'unchanged' | 'blocked';
  text?: string;
  reason?: string;
}

export interface StagePatchResult {
  baseVersion: string;
  patches: StagePatchItem[];
}

/* ────────────────────── 解析（防御模型输出的各种形态） ────────────────────── */

export interface ParsedPatch {
  ok: boolean;
  result: StagePatchResult | null;
  /** ok:false 时的人话诊断（直接进隔离记录与重试 prompt） */
  problems: string[];
}

const PATCH_STATUS = new Set(['changed', 'unchanged', 'blocked']);

/** 从模型原始输出解析 patch。宽容剥围栏/前后废话，严格校验结构——
 *  解析得出来但结构不对（未知段、多段混写）按条降级为 problems，不让半截结果混进合并。 */
export function parseStagePatch(raw: string, expectedIds: readonly string[]): ParsedPatch {
  const problems: string[] = [];
  const text = String(raw ?? '')
    .trim()
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* 模型爱在 JSON 前后说两句客套话：截到第一个 [ 或 { 再试一次 */
    const s = text.search(/[[{]/);
    const e = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
    if (s >= 0 && e > s) {
      try {
        data = JSON.parse(text.slice(s, e + 1));
      } catch {
        data = null;
      }
    }
  }
  if (data === null) return { ok: false, result: null, problems: [`模型输出不是合法 JSON（前 120 字）：${text.slice(0, 120)}`] };

  const arr: unknown = Array.isArray(data) ? data : (data as { patches?: unknown })?.patches;
  if (!Array.isArray(arr)) {
    return { ok: false, result: null, problems: ['模型输出里没有 patches 数组（既不是数组，也不是 {patches:[…]}）'] };
  }
  const expected = new Set(expectedIds);
  const patches: StagePatchItem[] = [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') {
      problems.push('patches 里混入了非对象条目，已丢弃');
      continue;
    }
    const o = it as Record<string, unknown>;
    const id = String(o.id ?? '').trim();
    if (!id || !expected.has(id)) {
      problems.push(`未知或缺失段 id「${id || '（空）'}」——请求里没有这个段，条目已丢弃`);
      continue;
    }
    if (expectedIds.includes(id) && patches.some((p) => p.id === id)) {
      problems.push(`段 ${id} 出现了重复 patch，取第一条，其余丢弃`);
      continue;
    }
    let status = String(o.status ?? 'changed');
    if (!PATCH_STATUS.has(status)) status = o.text ? 'changed' : 'unchanged';
    patches.push({
      id,
      status: status as StagePatchItem['status'],
      text: typeof o.text === 'string' ? o.text : undefined,
      reason: typeof o.reason === 'string' ? o.reason : undefined,
    });
  }
  if (!patches.length) return { ok: false, result: null, problems: problems.length ? problems : ['patches 为空'] };
  return { ok: true, result: { baseVersion: '', patches }, problems };
}

/** 段标记计数：一个 changed patch 里只能有它自己这一个段标记。
 *  出现两个以上 = 模型把多段当一段改了（变相返回整章），按协议拒绝该 patch。 */
export function markerCount(text: string): number {
  return (text.match(/\[P\d+\]/g) ?? []).length;
}

/* ────────────────────── 事实守卫 ────────────────────── */

/** 显式受保护事实（调用方从本地保真检查得到的字符串，如数字、专名、否定关键词）
 *  在新文本里必须仍然出现（大小写不敏感）。丢一条就拒绝合并——方案 §3.1 第 4 条。 */
export function factGuard(text: string, protectedFacts: readonly string[]): string[] {
  const low = stripMarkers(text).toLowerCase();
  return protectedFacts.filter((f) => f.trim() && !low.includes(f.trim().toLowerCase()));
}

/* ────────────────────── 门禁接入 ────────────────────── */

export interface GateSegCtx {
  id: string;
  /** 对应原文段（事实信号对照用） */
  source: string;
  /** 本层目标词数（= 原文词数 × 层比例；不到判 LEN-01 的工序传 0 即可跳过） */
  target: number;
  /** 本层句长上限 */
  maxLen: number;
  /** 该段应注词型（QC OOV 口径，已过 annotatableOf） */
  oov: string[];
  dict?: Map<string, string>;
}

export interface GatedPatches {
  items: StagePatchItem[];
  /** 每个经门禁的段的判定（未 changed 的段没有） */
  verdicts: Record<string, SegmentVerdict>;
  /** 本道工序被拒绝合并的段（含拒绝原因，交调用方隔离/重试） */
  blocked: Array<{ id: string; ruleIds: string[]; lostFacts: string[]; reason: string }>;
}

/** changed 段先过门禁再合并：按 STAGE_BLOCK_RULES[stage] 过滤命中规则，
 *  外加显式 protectedFacts 守卫。blocked 的段在这里把 status 翻成 'blocked'
 *  （mergePatch 只合并 changed）——门禁是唯一翻状态的地方，别处不许再判一遍。 */
export function gatePatches(result: StagePatchResult, segs: readonly GateSegCtx[], opts: { stage: Stage; protectedFacts?: Record<string, string[]> }): GatedPatches {
  const byId = new Map(segs.map((s) => [s.id, s]));
  const rules = new Set(STAGE_BLOCK_RULES[opts.stage]);
  const items: StagePatchItem[] = [];
  const verdicts: Record<string, SegmentVerdict> = {};
  const blocked: GatedPatches['blocked'] = [];

  for (const item of result.patches) {
    if (item.status !== 'changed' || !item.text) {
      items.push(item);
      continue;
    }
    const seg = byId.get(item.id);
    if (!seg) {
      items.push(item);
      continue;
    }
    /* 整章形态拒绝：一个 patch 里混了多个段标记 */
    const markers = markerCount(item.text);
    if (markers > 1) {
      blocked.push({ id: item.id, ruleIds: ['WHOLE-CHAPTER'], lostFacts: [], reason: `该 patch 含 ${markers} 个段标记——协议只允许单段 patch（拒绝按整章返回）` });
      items.push({ ...item, status: 'blocked', reason: '多段混写' });
      continue;
    }
    const verdict = gateSegment({
      text: item.text,
      source: seg.source,
      target: seg.target,
      maxLen: seg.maxLen,
      oov: seg.oov,
      dict: seg.dict,
      markerId: seg.id,
      /* 工序门禁 = 生成闸门作用域：句法指令禁止拆直接引语，引语长句不该在此否决
       * 整段（报表与风险队列不传此标志，照常计数——两套口径各有职责，见 segmentgate） */
      exemptQuoteLen: true,
    });
    verdicts[item.id] = verdict;
    const hitRuleIds = verdict.problems.filter((p) => rules.has(p.ruleId)).map((p) => p.ruleId);
    const lostFacts = factGuard(item.text, opts.protectedFacts?.[item.id] ?? []);
    if (hitRuleIds.length || lostFacts.length) {
      const reason = [hitRuleIds.length ? `命中门禁 ${[...new Set(hitRuleIds)].join('、')}` : '', lostFacts.length ? `受保护事实丢失：${lostFacts.join('、')}` : ''].filter(Boolean).join('；');
      blocked.push({ id: item.id, ruleIds: [...new Set(hitRuleIds)], lostFacts, reason });
      items.push({ ...item, status: 'blocked', reason });
    } else {
      items.push(item);
    }
  }
  return { items, verdicts, blocked };
}

/* ────────────────────── 合并（未提及 = 原样） ────────────────────── */

export interface MergedPatch {
  text: Record<string, string>;
  changedIds: string[];
  blockedIds: string[];
}

/** 把 patch 合并进稿本。只写 changed 且有文本的段；blocked 不合并（保持上一版，
 *  隔离与占位由调用方管）；unchanged 与**未返回**的段一律原样——这三者在合并层
 *  不可区分也不需要区分：协议的承诺就是"没说改的都不动"。 */
export function mergePatch(draft: Record<string, string>, result: StagePatchResult): MergedPatch {
  const text: Record<string, string> = { ...draft };
  const changedIds: string[] = [];
  const blockedIds: string[] = [];
  for (const p of result.patches) {
    if (p.status === 'changed' && p.text) {
      text[p.id] = p.text;
      changedIds.push(p.id);
    } else if (p.status === 'blocked') {
      blockedIds.push(p.id);
    }
  }
  return { text, changedIds, blockedIds };
}
