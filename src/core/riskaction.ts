// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，本仓库已部署版权验证体系，细节不予公开（docs/版权与授权.md）。
/**
 * LayerText · 风险决定的「动作」层
 *
 * 来源：《LayerText 审查报告 v4_方向》第 2 条 ——
 *   「当前风险页三个按钮只追加事件，明确写着不改稿。**事件不是理由，正文变更才是结果**；
 *     两者必须同一事务完成，并保留 before/after、规则号、版本和撤销指针。」
 *   并给出按钮的正确形状：「『采纳』必须拆成规则动作：事实类『保留/确认删减』（不改正文）、
 *     漏注『补上注释』、重复注『删除多余注释』、释义冲突『改为词典释义』、格式类『修复并应用』。」
 *
 * 为什么三个统一按钮是错的：十条规则里五条该改正文、五条只是表态。
 * 老师说"采纳改写"，卡片消失了，他会去正文里找那句改好的话——找不到。
 * **同一个按钮在不同规则下承诺不同的事，是产品级缺陷**，不是文案问题。
 *
 * 本模块是纯逻辑：规则 → 动作、动作 → 新文档。写盘与事件由调用方在同一事务里完成。
 */

import { parseDoc, removeDuplicateAnnotations, serializeDoc, setSense, insertAnnotation, occurrenceOf, type DocAst } from './docast.js';
import { parseAnnotations } from './annot.js';

/** 一个风险项能做的动作类型 */
export type ActionKind =
  /** 认可现状，**不改正文**（事实类删减、超长句、篇幅偏离） */
  | 'confirm'
  /** 补上注释（漏注） */
  | 'insert-annotation'
  /** 删除多余注释（重复注） */
  | 'remove-annotation'
  /** 改为统一词典的释义（释义冲突、同词多义） */
  | 'set-sense'
  /** 需要人自己到正文里处理，这里只记录决定（结构类、格式类里没法确定性修的） */
  | 'manual';

export interface RuleAction {
  kind: ActionKind;
  /** 按钮文案：**跟着规则走**，不是三个统一键 */
  label: string;
  /** 是否会改正文 */
  mutates: boolean;
  /** 点完之后人应该看到什么（进界面提示与事件 reason） */
  effect: string;
}

/**
 * 规则 → 动作。**唯一口径**，界面与离线汇总器都从这儿取。
 * 没有列到的规则一律按 `manual`（只记录），不猜。
 */
const TABLE: Record<string, RuleAction> = {
  'FACT-01': { kind: 'confirm', label: '✓ 认可这个删减', mutates: false, effect: '记录决定，正文不变（数字删减由教师判断是否可接受）' },
  'FACT-02': { kind: 'confirm', label: '✓ 认可这个删减', mutates: false, effect: '记录决定，正文不变（专名删减由教师判断是否可接受）' },
  'SENT-01': { kind: 'confirm', label: '✓ 认可这个长句', mutates: false, effect: '记录决定，正文不变（超长句由教师判断是否可接受）' },
  'LEN-01': { kind: 'confirm', label: '✓ 认可这个篇幅', mutates: false, effect: '记录决定，正文不变（篇幅偏离由教师判断是否可接受）' },
  'ANNO-01': { kind: 'insert-annotation', label: '＋ 补上注释', mutates: true, effect: '在首次出现处插入 word（释义）' },
  'ANNO-02': { kind: 'remove-annotation', label: '－ 删掉多余注释', mutates: true, effect: '把重复的注释还原为裸词（保留首次）' },
  'ANNO-03': { kind: 'set-sense', label: '＝ 改为词典释义', mutates: true, effect: '把该词的注释改成本书统一词典的释义' },
  'AST-02': { kind: 'set-sense', label: '＝ 统一为首次释义', mutates: true, effect: '同词多义归一（以首次出现的释义为准）' },
};

export const actionOf = (ruleId: string): RuleAction =>
  TABLE[ruleId] ?? {
    kind: 'manual',
    label: '✓ 记录决定（正文请手动处理）',
    mutates: false,
    effect: '这类问题没有确定性的自动修法，只记录决定，正文由教师手动修改',
  };

/* ────────────────────── 事务：先校验，再改，改不动就写 rejected ────────────────────── */

export type ApplyFailure = 'stale' | 'not-found' | 'no-op' | 'unsupported' | 'missing-arg';

export interface ApplyOk {
  ok: true;
  /** 改完之后的整份文档 */
  next: string;
  /** 事件里记的片段（before → after） */
  before: string;
  after: string;
  /** 实际改动的段 */
  segId: string;
}
export interface ApplyFail {
  ok: false;
  reason: ApplyFailure;
  message: string;
}
export type ApplyResult = ApplyOk | ApplyFail;

const fail = (reason: ApplyFailure, message: string): ApplyFail => ({ ok: false, reason, message });

export interface ApplyArgs {
  /** 当前章节正文（**读过盘的最新版本**，不是界面上缓存的那份） */
  doc: string;
  /** 问题所在段号（P07） */
  segId: string;
  /** 涉及的那个词（注释类动作必填） */
  word?: string;
  /** 要写进去的释义（补注 / 统一释义用） */
  zh?: string;
  /** ANNO-02 用：这个词在**别的段**已注过 → 本段整段去掉（而不是"保留首次"） */
  removeAll?: boolean;
}

/**
 * 执行一个动作，返回**新文档**。纯函数——写盘由调用方在同一个事务里做。
 *
 * 事务语义（v4 方向："先校验当前版本仍等于 before，再原子写正文和事件"）：
 *   · 找不到段 / 找不到词 / 已有该注释 → `not-found` / `no-op`，**调用方写 rejected 事件**，
 *     卡片**不许消失**；
 *   · 动作类型与规则不匹配 → `unsupported`（宁可报错，也不做半截事）；
 *   · 成功 → 返回新文档 + before/after 片段，调用方一次写完正文与事件。
 */
export function applyAction(action: RuleAction, args: ApplyArgs): ApplyResult {
  if (action.kind === 'confirm' || action.kind === 'manual') {
    // 不改正文的动作不经过这里（调用方直接记事件）——真走到这儿说明用错了
    return fail('unsupported', `${action.kind} 类动作不改正文，不该走 applyAction`);
  }
  const ast: DocAst = parseDoc(args.doc);
  const seg = ast.segments.find((s) => s.id === args.segId);
  if (!seg) return fail('not-found', `正文里找不到段落 ${args.segId}（稿件可能已经改过）`);
  const word = args.word ?? '';
  if (!word) return fail('missing-arg', '这个动作需要"哪个词"才能执行');

  if (action.kind === 'insert-annotation') {
    const zh = (args.zh ?? '').trim();
    if (!zh) return fail('missing-arg', `没有可用的释义——「${word}」还没在统一词典里，先给它定一个释义`);
    const before = occurrenceOf(seg, word);
    if (!before) return fail('not-found', `这一段里找不到「${word}」（稿件可能已经改过）`);
    if (!insertAnnotation(ast, args.segId, word, zh)) {
      return fail('no-op', `「${word}」在这段里已经有注释了（全篇一词一注，不重复插）`);
    }
    return { ok: true, next: serializeDoc(ast), before: before.text, after: `${before.text}（${zh}）`, segId: args.segId };
  }

  if (action.kind === 'remove-annotation') {
    const hits = parseAnnotations(seg.raw).list.filter((a) => a.word.toLowerCase() === word.toLowerCase());
    if (!hits.length) return fail('no-op', `这一段里「${word}」没有注释可删`);
    const removed = removeDuplicateAnnotations(ast, args.segId, word, args.removeAll === true);
    if (!removed) return fail('no-op', `「${word}」在这段里只有一处注释（那是首次，按"一词一注"该留着）`);
    const gone = args.removeAll ? hits[hits.length - 1]! : hits[0]!;
    return { ok: true, next: serializeDoc(ast), before: `${gone.word}（${gone.zh}）`, after: gone.word, segId: args.segId };
  }

  if (action.kind === 'set-sense') {
    const zh = (args.zh ?? '').trim();
    if (!zh) return fail('missing-arg', `没有目标释义——「${word}」在统一词典里查不到`);
    const hit = parseAnnotations(seg.raw).list.find((a) => a.word.toLowerCase() === word.toLowerCase());
    if (!hit) return fail('not-found', `这一段里找不到「${word}」的注释（稿件可能已经改过）`);
    if (hit.zh === zh) return fail('no-op', `「${word}」已经是「${zh}」了`);
    setSense(ast, args.segId, word, zh);
    return { ok: true, next: serializeDoc(ast), before: `${hit.word}（${hit.zh}）`, after: `${hit.word}（${zh}）`, segId: args.segId };
  }

  return fail('unsupported', `未知动作 ${action.kind}`);
}

/** 失败原因的人话（进界面 toast 与 rejected 事件的 reason） */
export const failureText = (r: ApplyFail): string =>
  ({
    stale: '稿件已经改过，这条基于旧版本，请重新出队',
    'not-found': r.message,
    'no-op': r.message,
    unsupported: r.message,
    'missing-arg': r.message,
  })[r.reason];
