// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，本仓库已部署版权验证体系，细节不予公开（docs/版权与授权.md）。
/**
 * LayerText · 正文版本节点 + 「改正文」的唯一事务（applyChange）
 *
 * 来源：《LayerText 工程优化总计划》
 *   · 目标架构：「所有正文写入都产生版本节点，**不允许直接覆盖『当前文件』而没有父版本**。」
 *   · 阶段 1：「风险组、单句建议和确定性补注全部走同一个 `applyChange` 事务；
 *     事务写入 draft version、decision event、audit row，失败显示可行动原因并保持原卡片。」
 *     关键接口：
 *       applyChange({ runId, baseVersion, target, action }):
 *         Promise<{ version; eventId; undoOf? } | { status: 'rejected'; reason }>
 *   · 代码纪律 1：「任何写正文的函数必须同时接收 `baseVersion` 并返回新版本 ID；
 *     禁止隐式修改当前文件。」
 *
 * ── 为什么需要这一层 ────────────────────────────────────────────────────
 * 在此之前，"改正文"有三个入口（风险面板的单条动作、批量应用、将来要接进来的单句改写采纳），
 * 它们各自 read → write，谁也没留下"这一版是谁基于哪一版改的"。于是三个问题答不上来：
 *   ① 两位教师先后改同一章——第二次改的是不是同一份底稿？
 *   ② 某一段现在这个样子，是哪一次运行、哪一条决定产生的？
 *   ③ 撤销之后，"当前版本"到底是什么？
 * 本模块把这三问压成一条不变式：**正文的每一次变化都有一个带父版本的版本节点**。
 *
 * ── 与既有代码的分工 ────────────────────────────────────────────────────
 *   `src/core/riskaction.ts` —— 规则 → 动作、动作 → 新文档（纯计算，不知道文件）
 *   `src/core/decision.ts`   —— 不可变决定事件（谁在何时决定了什么）
 *   本文件                    —— **写盘的唯一入口**：校验 → 改 → 版本节点 + 决定事件，一个事务
 *   `src/core/manifest.ts`   —— 路径只从 `makeResolver` 来，本文件不拼目录
 *
 * 纯逻辑 + 注入 IO（与 `app/src/risk.ts` 同一套路）：Node 下可直接测，不必启动 App。
 */

import { contentHash } from './manifest.js';
import { makeDecisionEvent, type DecisionEvent, type DecisionKind } from './decision.js';
import { parseDoc } from './docast.js';
import { applyAction, failureText, type ActionKind, type RuleAction, type ApplyFailure } from './riskaction.js';

export const VERSION_SCHEMA_VERSION = 1;

/* ────────────────────── 版本节点 ────────────────────── */

/** 版本节点的来源类别 */
export type VersionKind =
  /** 本次运行的起点（登记"我看到的底稿是这个哈希"） */
  | 'base'
  /** 一次确定性动作 */
  | 'apply'
  /** 一次批量应用：**一条节点代表这一章的一批改动**（不是 N 条，否则链上全是同一秒的碎片） */
  | 'batch'
  /** 撤销 */
  | 'undo'
  /** 事务失败后的回滚记录。**只有真的把正文改回去了才写**——写了它却没有对应的事实，就是假账 */
  | 'rollback';

/** 这次改动落在哪儿（发布段可由此定位到段与产物） */
export interface VersionTarget {
  /** 段号（`P07`） */
  segId: string;
  /** 章节（`第一章`） */
  chapter: string;
  /** 涉及的词（注释类动作才有） */
  word?: string;
  /** 触发规则（`GATE_RULES` 的 ruleId） */
  ruleId?: string;
  /** 风险队列项 ID（`第一章#2:SENT-01:1911`）＝ 决定事件的 `itemId`。两本账靠它对得上 */
  itemId: string;
  /** 这次改写的追踪 ID（`RewriteRequest.traceId`）。
   *  有它才能回答"这一段是怎么来的、能不能重放"（阶段 1 验收：发布段可由 sourceVersion + traceId 重放） */
  traceId?: string;
  /** 产物文件绝对路径（由 `Resolver` 解析后传入，不在此处拼） */
  path?: string;
}

export interface VersionNode {
  schemaVersion: number;
  /** 稳定版本 ID：`v0003-1a2b3c4d`（序号 + 内容哈希前 8 位）。
   *  序号让"第几次写入"一眼可见，哈希让"内容有没有被动过"当场可验。 */
  version: string;
  /** 父版本 ID；`null` = 本次运行的起点。**没有父版本就不许写正文** */
  parent: string | null;
  kind: VersionKind;
  runId: string;
  /** 改前 / 改后**整份正文**的内容哈希。乐观并发（两人同时改）与账本自校验都用它 */
  parentHash: string;
  contentHash: string;
  target: VersionTarget;
  /** 动作类别（`ActionKind`）或 `undo` */
  action: string;
  /** 改动的那一小段文本（`before → after`，进事件 reason，人读） */
  before: string;
  after: string;
  /** **整段正文**的改前 / 改后。`before` 片段只够给人看，重放要靠整段 */
  segBefore: string;
  segAfter: string;
  /** 该段第一次被本次运行碰到时的样子 —— 重放的起点 */
  segBase: string;
  teacherId: string;
  /** 产物版本标识（源文件哈希），回答"这条改动是对着哪一版底稿做的" */
  sourceVersion: string;
  timestamp: string;
  /** 同一个事务里写的决定事件 ID。两本账（版本日志 / 决定日志）互为外键 */
  eventId: string;
  /** `kind='undo'` 时：被撤销的那个**版本**。注意与事件的 `undoOf` 不是同一个命名空间——
   *  节点指版本，事件指事件（`itemId@timestamp`）。两边都要有，才既查得到"回到哪一版"、
   *  也查得到"作废的是哪一条决定"。 */
  undoOf?: string;
  /** `kind='undo'` 时：被作废的那条**事件**的引用（`itemId@timestamp`） */
  undoesEvent?: string;
  /** `kind='rollback'` 时：这一条作废的是哪个版本（缺省 = 紧邻的上一条）。
   *  有了它，"改了一半又回滚"之后的**有效链**末端才真的回到改之前，
   *  而不是停在一条已被撤销的改动上。 */
  rollsBack?: string;
}

export const toVersionLine = (n: VersionNode): string => JSON.stringify(n) + '\n';

/** 解析版本日志（append-only JSONL）。坏行计数而不抛——一条坏行不该让整本账不可读。
 *  与 `parseDecisionLog` 同一约定：**不静默丢弃，计数交上层报警**。 */
export function parseVersionLog(text: string): { nodes: VersionNode[]; badLines: number } {
  const nodes: VersionNode[] = [];
  let badLines = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as VersionNode;
      if (!o || typeof o.version !== 'string' || typeof o.kind !== 'string' || typeof o.contentHash !== 'string') {
        badLines++;
        continue;
      }
      nodes.push(o);
    } catch {
      badLines++;
    }
  }
  return { nodes, badLines };
}

/** 基版本 ID：正文的**内容寻址**身份。同一份正文永远同一个 ID——
 *  于是"没有人写过版本日志"这件事本身也能被表达成一个版本（而不是"没有版本"）。 */
export const baseVersionOf = (doc: string): string => `base-${contentHash(doc).slice(0, 12)}`;

/** 版本 ID：序号 + 内容哈希前 8 位 */
export const versionIdOf = (seq: number, doc: string): string => `v${String(seq).padStart(4, '0')}-${contentHash(doc).slice(0, 8)}`;

/** 节点里的序号（解析不出来当 0） */
const seqOfVersion = (v: string): number => {
  const m = /^v(\d+)-/.exec(v);
  return m ? Number(m[1]) : 0;
};

/** 下一条版本节点的序号。**单调递增，回滚记录也占号**——
 *  占号是为了让每条落账的节点都有独一无二的 ID（复用被作废节点的号会让两行同名，说不清）。 */
export function nextSeq(nodes: VersionNode[]): number {
  let max = 0;
  for (const n of nodes) max = Math.max(max, seqOfVersion(n.version));
  return max + 1;
}

/**
 * 账本的**有效链**：`rollback` 节点把它撤销的那一条一并作废。
 *
 * 为什么需要它：事务是"先写正文、后写账"，账写失败就回滚正文。
 * 那时候账上已经躺了一条描述"这次改了"的节点，而事实上没改成——
 * 如果 `latestVersion` 照直取最后一条，它就会停在一条**已被撤销的改动**上，
 * 于是"当前版本"指向一份并不存在的内容。这正是不允许出现的那种账实不符。
 */
export function effectiveNodes(nodes: VersionNode[]): VersionNode[] {
  const out: VersionNode[] = [];
  const at = new Map<string, number>();
  for (const n of nodes) {
    if (n.kind === 'rollback') {
      const victim = n.rollsBack ?? out[out.length - 1]?.version;
      const i = victim === undefined ? undefined : at.get(victim);
      if (i !== undefined) for (const dropped of out.splice(i)) at.delete(dropped.version);
      continue;
    }
    at.set(n.version, out.length);
    out.push(n);
  }
  return out;
}

/** 最后一条**有效**版本节点（被回滚作废的与回滚记录本身都不算） */
export function latestVersion(nodes: VersionNode[]): VersionNode | null {
  return effectiveNodes(nodes).at(-1) ?? null;
}

/**
 * 当前版本 ID。
 *
 * 有版本节点、**且盘上正文与最后一版的内容哈希对得上** → 最后一条的 `version`；
 * 否则 → 这份正文**自己的内容哈希**（`base-…`）。
 *
 * 后一种情形正是"有人在事务之外改过稿"（手工编辑、重新生成、外部脚本直接覆盖）。
 * 内容寻址让这种改动**自动可见**：版本号当场变成一个新底稿，
 * 而不是被账本上的旧版本号盖住——那是"不允许直接覆盖当前文件而没有父版本"的落点。
 *
 * 这条规则也是"先校验当前版本仍等于 before"的实现：调用方拿着上一次看到的版本 ID 回来，
 * 中间只要有人改过正文，这里算出来的就不一样，事务当场拒绝、**一个字符都不写**。
 */
export function currentVersionOf(nodes: VersionNode[], doc: string): string {
  const last = latestVersion(nodes);
  if (last && last.contentHash === contentHash(doc)) return last.version;
  return baseVersionOf(doc);
}

/** 账本还对得上这份正文吗（决定"能不能接着用上一版做父版本"） */
export const ledgerIsLive = (nodes: VersionNode[], doc: string): boolean => {
  const last = latestVersion(nodes);
  return !!last && last.contentHash === contentHash(doc);
};

/* ────────────────────── 统一三态 ────────────────────── */

/**
 * 一次编辑在整条链路上的位置。**这是三个位置，不是三个模块各自的说法**——
 * 门禁、单句建议、风险动作、批量应用对外都只说这三个词之一。
 *
 *   · `blocked`   —— 门禁没过，**正文一个字符都没动**，只显示候选与原因
 *   · `candidate` —— 有了候选，等人按键（还没动正文）
 *   · `applied`   —— 已写正文、已出父版本、已记事件（三件事同一次做完，缺一不算）
 */
export type ChangeState = 'blocked' | 'candidate' | 'applied';

/** 改写判定结果 → 三态（`RewriteResult.status` 只有前两态：判定那一刻还没人按键） */
export const stateOfRewrite = (status: 'candidate' | 'blocked'): ChangeState => status;

/** 事务结果 → 三态。被拒 ≠ 被门禁拦：前者是"这次没做成"，后者是"候选本来就不合格" */
export const stateOfChange = (r: ChangeResult): ChangeState => (r.status === 'applied' ? 'applied' : r.kind === 'blocked' ? 'blocked' : 'candidate');

/* ────────────────────── 事务 ────────────────────── */

/** 事务用的最小 IO 端口（App 注入 Tauri 的读写；Node 下注入 fs 包装） */
export interface TxIo {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  /** 追加一行。不实现就退回 read+write 拼接（账本很小，行为一致） */
  append?(path: string, line: string): Promise<void>;
  /** 改稿前备份（可选）。给了就先备份再写——**不可逆的操作不该没有退路** */
  backup?(path: string, content: string): Promise<void>;
  /** 当前时间（便于测试确定性）。缺省 `new Date().toISOString()` */
  now?(): string;
}

/** 失败类别：机器可判，界面按它决定给不给"重新出队"这类行动按钮 */
export type ChangeRejectKind =
  /** `baseVersion` 对不上（稿件被别人改过）——**正文一个字符都没动** */
  | 'stale'
  /** 门禁没过——**正文一个字符都没动** */
  | 'blocked'
  | 'not-found'
  | 'no-op'
  | 'missing-arg'
  | 'unsupported'
  | 'write-failed'
  /** 回滚本身也失败了：正文可能已变。**这种必须炸出来，不能混在普通失败里** */
  | 'rollback-failed';

export interface ChangeApplied {
  status: 'applied';
  /** 新版本 ID（`v0004-1a2b3c4d`）。**写正文的函数必须返回它**（代码纪律 1） */
  version: string;
  /** 同一事务里写的决定事件 ID */
  eventId: string;
  /** 撤销时：被撤销的版本 */
  undoOf?: string;
  before: string;
  after: string;
  segId: string;
  /** 人话：改了哪一段的什么 */
  message: string;
  /** 批量：几条成功、几条被拒（单条时 1/0） */
  applied: number;
  rejected: number;
  /** 批量里被拒的条目（**留在待办**，绝不静默跳过） */
  rejectedItems: { itemId: string; reason: string }[];
}

export interface ChangeRejected {
  status: 'rejected';
  reason: string;
  kind: ChangeRejectKind;
  /** **正文有没有被这次调用改动过**。正常永远是 `false`；
   *  为 `true` 只有一种情形：写正文之后事件/版本节点写失败、且回滚也失败——必须炸出来给人看 */
  docTouched: boolean;
  applied: number;
  rejected: number;
  rejectedItems: { itemId: string; reason: string }[];
}

export type ChangeResult = ChangeApplied | ChangeRejected;

/**
 * 写入前的最后一道闸：**只有它说行，正文才会被改**。
 *
 * 门禁（`gateSegment`）由调用方注入——`version.ts` 不认识词表、词典和规则，
 * 它只保证一件事：**闸没过就一定没写正文**（阶段 1 验收：「任何门禁失败均不改变正文」）。
 */
export type ChangeGuard = (input: {
  /** 改动前 / 改动后的整份文档 */
  doc: string;
  nextDoc: string;
  segId: string;
  action: ActionKind;
  word?: string;
}) => { ok: true } | { ok: false; reason: string };

export const noGuard: ChangeGuard = () => ({ ok: true });

/** 事务里的一个步骤：一个目标 + 一个动作 */
export interface ChangeStep {
  target: VersionTarget;
  action: RuleAction;
  /** 注释类动作必填：改哪个词 */
  word?: string;
  /** 要写进去的释义（补注 / 统一释义） */
  zh?: string;
  /** `ANNO-02`：该词在**别的段**注过 → 本段整段去掉 */
  removeAll?: boolean;
  /** `revert` 动作：当初写进去的 / 要换回的文本 */
  from?: string;
  to?: string;
}

export interface ApplyChangeArgs {
  runId: string;
  /** 调用方**以为**的当前版本。写之前核对，对不上就拒 —— 这就是"先校验仍等于 before" */
  baseVersion: string;
  target: VersionTarget;
  /** 规则特定动作（`actionOf(ruleId)` 的结果）。不改正文的动作走 `recordOnly` */
  action: RuleAction;
  word?: string;
  zh?: string;
  removeAll?: boolean;
  /** `revert` 动作（撤销）用：当初写进去的 / 要换回的文本 */
  from?: string;
  to?: string;
  /** 章节产物路径（`Resolver` 解析后传入） */
  docPath: string;
  /** 版本日志 / 决定日志路径（`Resolver` 解析后传入） */
  versionPath: string;
  decisionPath: string;
  teacherId: string;
  sourceVersion: string;
  /** 这次改写的追踪 ID（`RewriteRequest.traceId`） */
  traceId?: string;
  /** 决定事件的类别，缺省 `accept`。撤销事务传 `undo` */
  decision?: DecisionKind;
  /** `decision='undo'` 时：被作废的那条事件的引用（`itemId@timestamp`）。
   *  它进**事件**的 `undoOf`——撤销是新事件，历史一条不删，作废靠指针。 */
  undoesEvent?: string;
  /** 事件 reason 的前缀。批量统一传「批量」——
   *  **事后得能分清"这是我一条条点的"还是"我按了全部应用"**，
   *  否则复盘时无法判断某次回退是规则不好还是批量太激进。 */
  reasonPrefix?: string;
}

/** 批量：**同一个事务**里对同一份底稿连着做 N 个动作。
 *  它不是"第二个写正文的入口"——只是把动作列表从 1 个变成 N 个，
 *  校验、闸、写盘、版本节点、事件、回滚全部共用同一条路径，**没有第二套口径**。 */
export interface ApplyChangeBatchArgs extends Omit<ApplyChangeArgs, 'target' | 'action'> {
  steps: ChangeStep[];
}

/* ── 内部工具 ── */

/**
 * 读一个**可能还不存在**的文件。
 *
 * 有意兜底：这里返回 fallback 而不是把错误抛出去，理由是"文件不存在"在这个位置
 * **就是正常状态**——账本是 append-only 的，第一次运行时它当然还没有。
 * 区分"还没有账本"和"账本读不出来"要靠调用方对结果的解读，而不是靠这里抛不抛。
 * （真正的读失败（权限、坏盘）会在后续写入时暴露，不会静默变成"这次没有改动"。）
 */
const readOr = async (io: TxIo, path: string, fallback: string): Promise<string> => {
  try {
    return await io.read(path);
  } catch {
    // 有意兜底：账本第一次运行时本来就还不存在——"没有账本"是正常状态，不是错误。
    // （真正的读失败（权限、坏盘）会在随后写入时暴露，不会静默变成"这次没有改动"。）
    return fallback;
  }
};

const appendLine = async (io: TxIo, path: string, line: string): Promise<void> => {
  if (io.append) return await io.append(path, line);
  const prev = await readOr(io, path, '');
  await io.write(path, prev + line);
};

/** 段正文（去掉段标记，也去掉段与段之间的空行——那是结构不是内容）。
 *  找不到段时返回 `null`：段是版本节点的定位单位，**不能猜**。 */
const segRawOf = (doc: string, segId: string): string | null => {
  const seg = parseDoc(doc).segments.find((s) => s.id === segId);
  return seg ? seg.raw.replace(/\s+$/, '') : null;
};

/**
 * 某段在本账本里的**起点**（重放的锚）。
 *
 * 只有在账本仍然锚在这份正文上时才沿用上一轮记的锚；否则这一轮就是这条链的新起点——
 * 不用旧锚，是因为旧的 `segBase` 描述的是**另一份底稿**里的那一段，
 * 拿它当锚会让重放从第一步就对不上，然后报"版本链断了"——一句真话，但指错了方向。
 */
function segBaseOf(nodes: VersionNode[], segId: string, doc: string, live: boolean): string {
  if (live) {
    for (const n of effectiveNodes(nodes)) {
      if (n.target.segId === segId) return n.segBase;
    }
  }
  return segRawOf(doc, segId) ?? '';
}

/** `ApplyFailure` → `ChangeRejectKind`（两个枚举同名同义，只是分工不同：一个在纯计算层，一个在事务层）。
 *  映射写在明面上而不是直接强转：将来任一边加一个成员，这里会编译不过，而不是悄悄错配。 */
const rejectKindOf = (r: ApplyFailure): ChangeRejectKind => (r === 'stale' || r === 'not-found' || r === 'no-op' || r === 'unsupported' || r === 'missing-arg' ? r : 'unsupported');

/** 门禁闸没过 / 稿件改过 这类"没做成就写一条 rejected 事件"的失败：
 *  **卡片不许消失**（`rejected` 不在 `TERMINAL_DECISIONS` 里），所以这里必须先落账。 */
async function recordRejected(
  io: TxIo,
  args: { decisionPath: string; teacherId: string; sourceVersion: string; itemId: string; ruleId?: string; target: VersionTarget; reason: string; traceId?: string; version?: string },
): Promise<string> {
  try {
    const e = makeDecisionEvent({
      itemId: args.itemId,
      decision: 'rejected',
      before: '',
      after: '',
      reason: args.reason,
      ruleIds: args.ruleId ? [args.ruleId] : [],
      teacherId: args.teacherId,
      sourceVersion: args.sourceVersion,
      chapter: args.target.chapter,
      traceId: args.traceId,
      version: args.version,
      timestamp: io.now?.() ?? undefined,
    });
    await appendLine(io, args.decisionPath, JSON.stringify(e) + '\n');
    return args.reason;
  } catch {
    // 连失败都记不上：如实告诉人（不要静默）。卡片仍然留着——这是 `rejected` 的语义决定的。
    return `${args.reason}（且失败记录未能写入日志）`;
  }
}

/* ── 主事务 ── */

interface TxPlan {
  args: Omit<ApplyChangeArgs, 'target' | 'action'>;
  steps: ChangeStep[];
}

/**
 * **写正文的唯一事务**。单条与批量都走这里。
 *
 * 次序（与既有实现同一条纪律，只是把它收进一个出入口）：
 *   ① 读最新正文 → 核对 `baseVersion`；**对不上就拒，一个字符都不写**
 *   ② 在内存里把动作全跑完 → 闸检查（门禁没过也**一个字符都不写**）
 *   ③ 备份 → 写正文
 *   ④ 追加版本节点（带父版本、带段的前后文）
 *   ⑤ 追加决定事件（带 `version` 与 `eventId`）
 * ④⑤ 任一步失败 → **把正文改回原样**并写回滚节点；正文改不回去则返回 `rollback-failed`
 * （这条绝不能混进普通失败：那意味着稿子变了、账上没有）。
 *
 * 为什么是"先写正文、后写账"而不是反过来：反过来的失败态是"账上有、稿子没变"，
 * 教师会以为已经改好了；正过来的失败态是"稿子变了、账没记上"，而我们**当场回滚**。
 * 两种都不可接受，但后者可以被检测并修复，前者不能。
 */
async function runTransaction(io: TxIo, plan: TxPlan, guard: ChangeGuard): Promise<ChangeResult> {
  const { args, steps } = plan;
  const empty = { applied: 0, rejected: 0, rejectedItems: [] as { itemId: string; reason: string }[] };
  const first = steps[0]!;

  const versionText = await readOr(io, args.versionPath, '');
  const { nodes } = parseVersionLog(versionText);

  let doc: string;
  try {
    doc = await io.read(args.docPath);
  } catch {
    const reason = await recordRejected(io, {
      decisionPath: args.decisionPath,
      teacherId: args.teacherId,
      sourceVersion: args.sourceVersion,
      itemId: first.target.itemId,
      ruleId: first.target.ruleId,
      target: first.target,
      reason: `读不到正文（${args.docPath}）——产物可能被移动或删除了`,
      traceId: args.traceId ?? first.target.traceId,
    });
    return { status: 'rejected', reason, kind: 'not-found', docTouched: false, ...empty };
  }

  /* ① 乐观并发：调用方以为的那一版，是不是就是现在盘上这一版？
   *  不是 → 直接拒。**这条是"先校验当前版本仍等于 before"的落点**，
   *  也是"两位教师同时改同一章"不会互相覆盖的唯一保证。 */
  const base = currentVersionOf(nodes, doc);
  if (args.baseVersion !== base) {
    const reason = await recordRejected(io, {
      decisionPath: args.decisionPath,
      teacherId: args.teacherId,
      sourceVersion: args.sourceVersion,
      itemId: first.target.itemId,
      ruleId: first.target.ruleId,
      target: first.target,
      reason: `稿件已经改过（当前 ${base}，这一条基于 ${args.baseVersion}），请重新出队`,
      traceId: args.traceId ?? first.target.traceId,
      version: base,
    });
    return { status: 'rejected', reason, kind: 'stale', docTouched: false, ...empty };
  }

  /* ② 在内存里跑完所有步骤。**一次都没碰盘**——所以任何一步不合格都不留痕迹。 */
  let cur = doc;
  const live = ledgerIsLive(nodes, doc);
  const okSteps: { step: ChangeStep; before: string; after: string; segBase: string; segBefore: string; segAfter: string }[] = [];
  const rejectedItems: { itemId: string; reason: string; kind: ChangeRejectKind }[] = [];
  for (const step of steps) {
    const res = applyAction(step.action, {
      doc: cur,
      segId: step.target.segId,
      word: step.word,
      zh: step.zh,
      removeAll: step.removeAll,
      from: step.from,
      to: step.to,
    });
    if (!res.ok) {
      rejectedItems.push({ itemId: step.target.itemId, reason: failureText(res), kind: rejectKindOf(res.reason) });
      continue;
    }
    /* `segBefore` = 这一步动手**之前**那一段的样子（重放时逐步核对的就是它）；
     * `segBase` = 这一整条链的起点。两者在第一环上相同，之后 `segBefore` 跟着链走。 */
    const segBefore = segRawOf(cur, step.target.segId);
    const segAfter = segRawOf(res.next, step.target.segId);
    if (segAfter === null || segBefore === null) {
      // 段号在改写里丢了——这是结构事故，不能当成"改好了"
      rejectedItems.push({ itemId: step.target.itemId, reason: `改完之后找不到段落 ${step.target.segId}（段标记丢了）`, kind: 'not-found' });
      continue;
    }
    okSteps.push({ step, before: res.before, after: res.after, segBase: segBaseOf(nodes, step.target.segId, doc, live), segBefore, segAfter });
    cur = res.next;
  }

  // 一条都没改成 → 逐条写 rejected（**卡片留在队列里**），正文不动
  if (!okSteps.length) {
    const reasons: string[] = [];
    for (const r of rejectedItems) {
      const st = steps.find((s) => s.target.itemId === r.itemId) ?? first;
      reasons.push(
        await recordRejected(io, {
          decisionPath: args.decisionPath,
          teacherId: args.teacherId,
          sourceVersion: args.sourceVersion,
          itemId: r.itemId,
          ruleId: st.target.ruleId,
          target: st.target,
          reason: r.reason,
          traceId: args.traceId,
          version: base,
        }),
      );
    }
    const head = rejectedItems[0];
    return {
      status: 'rejected',
      reason: reasons[0] ?? `没有可执行的动作（${first.target.segId}）`,
      kind: head?.kind ?? 'no-op',
      docTouched: false,
      applied: 0,
      rejected: rejectedItems.length,
      rejectedItems: rejectedItems.map(({ itemId, reason }) => ({ itemId, reason })),
    };
  }

  /* 闸：门禁没过就**一个字符都不写**。批量时，被闸拦下的组整体不写（宁可少做，也不做半对的事）。 */
  const g = guard({ doc, nextDoc: cur, segId: first.target.segId, action: first.action.kind, word: first.word });
  if (!g.ok) {
    for (const s of okSteps) {
      await recordRejected(io, {
        decisionPath: args.decisionPath,
        teacherId: args.teacherId,
        sourceVersion: args.sourceVersion,
        itemId: s.step.target.itemId,
        ruleId: s.step.target.ruleId,
        target: s.step.target,
        reason: g.reason,
        traceId: args.traceId ?? s.step.target.traceId,
        version: base,
      });
    }
    return {
      status: 'rejected',
      reason: g.reason,
      kind: 'blocked',
      docTouched: false,
      applied: 0,
      rejected: okSteps.length + rejectedItems.length,
      rejectedItems: [...rejectedItems, ...okSteps.map((s) => ({ itemId: s.step.target.itemId, reason: g.reason }))],
    };
  }

  /* ③ 写正文 */
  try {
    if (io.backup) await io.backup(args.docPath, doc);
    await io.write(args.docPath, cur);
  } catch (e) {
    const why = `写入正文失败：${e instanceof Error ? e.message : String(e)}`;
    for (const s of okSteps) {
      await recordRejected(io, {
        decisionPath: args.decisionPath,
        teacherId: args.teacherId,
        sourceVersion: args.sourceVersion,
        itemId: s.step.target.itemId,
        ruleId: s.step.target.ruleId,
        target: s.step.target,
        reason: why,
        traceId: args.traceId ?? s.step.target.traceId,
        version: base,
      });
    }
    return {
      status: 'rejected',
      reason: why,
      kind: 'write-failed',
      docTouched: false,
      applied: 0,
      rejected: okSteps.length + rejectedItems.length,
      rejectedItems: [...rejectedItems, ...okSteps.map((s) => ({ itemId: s.step.target.itemId, reason: why }))],
    };
  }

  /* ④⑤ 账：版本节点 + 决定事件。任一步失败 → 把正文改回去。 */
  const seq = nextSeq(nodes);
  const version = versionIdOf(seq, cur);
  const timestamp = io.now?.() ?? new Date().toISOString();
  const headStep = okSteps[0]!;
  const node: VersionNode = {
    schemaVersion: VERSION_SCHEMA_VERSION,
    version,
    parent: latestVersion(nodes)?.version ?? baseVersionOf(doc),
    kind: okSteps.length > 1 ? 'batch' : args.decision === 'undo' ? 'undo' : 'apply',
    runId: args.runId,
    parentHash: contentHash(doc),
    contentHash: contentHash(cur),
    target: { ...headStep.step.target, path: args.docPath, traceId: args.traceId ?? headStep.step.target.traceId },
    action: args.decision === 'undo' ? 'undo' : String(headStep.step.action.kind),
    before: headStep.before,
    after: headStep.after,
    segBefore: headStep.segBefore,
    segAfter: headStep.segAfter,
    segBase: headStep.segBase,
    teacherId: args.teacherId,
    sourceVersion: args.sourceVersion,
    timestamp,
    eventId: '', // 下面事件造好后回填——两者必须指向同一个 ID
    undoOf: args.decision === 'undo' ? base : undefined,
    undoesEvent: args.decision === 'undo' ? args.undoesEvent : undefined,
  };

  const events: DecisionEvent[] = okSteps.map((s) =>
    makeDecisionEvent({
      itemId: s.step.target.itemId,
      decision: args.decision ?? 'accept',
      before: s.before,
      after: s.after,
      reason: args.decision === 'undo' ? `撤销：${s.after} → ${s.before}` : `${args.reasonPrefix ?? ''}${s.step.action.label}：${s.before} → ${s.after}`,
      ruleIds: s.step.target.ruleId ? [s.step.target.ruleId] : [],
      teacherId: args.teacherId,
      sourceVersion: args.sourceVersion,
      chapter: s.step.target.chapter,
      version,
      traceId: args.traceId ?? s.step.target.traceId,
      // 撤销事件指向被它作废的那条——**历史一条不删**，只标"这条不算数了"
      undoOf: args.decision === 'undo' ? args.undoesEvent : undefined,
      timestamp,
    }),
  );
  node.eventId = events[0]!.eventId ?? '';

  try {
    await appendLine(io, args.versionPath, toVersionLine(node));
    for (const e of events) await appendLine(io, args.decisionPath, JSON.stringify(e) + '\n');
  } catch (e) {
    /* 账写不进去 → 把正文改回原样。**"稿子变了、账上没有"是必须避免的那一种**：
     * 那时候谁也说不清是谁改的、撤销也无从下手。 */
    let rolledBack = false;
    try {
      await io.write(args.docPath, doc);
      rolledBack = true;
    } catch {
      /* 回滚也失败——下面按 rollback-failed 如实报 */
    }
    if (rolledBack) {
      // 只有真的改回去了才写回滚节点。写了却没有对应的事实，就是假账。
      try {
        await appendLine(
          io,
          args.versionPath,
          toVersionLine({
            ...node,
            kind: 'rollback',
            // 回滚节点占自己的号：与它作废的那条同名会让两行指同一个 ID，事后说不清
            version: versionIdOf(nextSeq([...nodes, node]), doc),
            rollsBack: node.version,
            contentHash: node.parentHash,
            before: node.after,
            after: node.before,
            segBefore: node.segAfter,
            segAfter: node.segBefore,
            timestamp: io.now?.() ?? new Date().toISOString(),
            eventId: '',
          }),
        );
      } catch {
        /* 回滚记录也写不上：上面的 reason 已经如实说明 */
      }
    }
    const why = `版本/事件写入失败${rolledBack ? '，已把正文改回原样' : '，且回滚失败'}：${e instanceof Error ? e.message : String(e)}`;
    return {
      status: 'rejected',
      reason: why,
      kind: rolledBack ? 'write-failed' : 'rollback-failed',
      docTouched: !rolledBack,
      applied: 0,
      rejected: okSteps.length + rejectedItems.length,
      rejectedItems: [...rejectedItems, ...okSteps.map((s) => ({ itemId: s.step.target.itemId, reason: why }))],
    };
  }

  /* 批量里被拒的那几条：逐条写 rejected，**留在待办**（其余照做，最后如实报告几成几败） */
  for (const r of rejectedItems) {
    const st = steps.find((s) => s.target.itemId === r.itemId);
    await recordRejected(io, {
      decisionPath: args.decisionPath,
      teacherId: args.teacherId,
      sourceVersion: args.sourceVersion,
      itemId: r.itemId,
      ruleId: st?.target.ruleId,
      target: st?.target ?? first.target,
      reason: r.reason,
      traceId: args.traceId,
      version,
    });
  }

  return {
    status: 'applied',
    version,
    eventId: node.eventId,
    undoOf: node.undoOf,
    before: headStep.before,
    after: headStep.after,
    segId: first.target.segId,
    message: args.decision === 'undo' ? `已撤销：${headStep.after} → ${headStep.before}` : `${args.reasonPrefix ?? ''}${headStep.step.action.label}：${headStep.before} → ${headStep.after}`,
    applied: okSteps.length,
    rejected: rejectedItems.length,
    rejectedItems,
  };
}

/** 单条改动。**这是阶段 1 规定的那一个接口**（`applyChange({runId, baseVersion, target, action})`）。 */
export async function applyChange(io: TxIo, args: ApplyChangeArgs, guard: ChangeGuard = noGuard): Promise<ChangeResult> {
  return runTransaction(
    io,
    {
      args,
      steps: [
        {
          target: { ...args.target, traceId: args.traceId ?? args.target.traceId },
          action: args.action,
          word: args.word,
          zh: args.zh,
          removeAll: args.removeAll,
          from: args.from,
          to: args.to,
        },
      ],
    },
    guard,
  );
}

/** 批量改动。同一个事务、同一条路径，只是步骤从 1 个变成 N 个。 */
export async function applyChangeBatch(io: TxIo, args: ApplyChangeBatchArgs, guard: ChangeGuard = noGuard): Promise<ChangeResult> {
  if (!args.steps.length) {
    return { status: 'rejected', reason: '这一组没有可执行的动作', kind: 'no-op', docTouched: false, applied: 0, rejected: 0, rejectedItems: [] };
  }
  return runTransaction(io, { args, steps: args.steps }, guard);
}

/**
 * 不改正文的决定（事实类"认可"、结构类"手动处理"、退回重写、标误报）。
 *
 * **不产生版本节点**——正文没变，就不该在正文的账上多一笔。
 * 但它仍然是一条不可变事件，并且回答"当时的当前版本是哪个"，所以同样返回 `version`
 * （= 未变的当前版本，不是新版本）。代码纪律 1 说的是"写正文的函数必须接收 baseVersion
 * 并返回新版本 ID"；这个函数不写正文，于是它**照样核对 baseVersion**（对不上照样拒），
 * 只是返回的 `version` 与传入的相同。这样"当前到底算哪一版"在任何路径上都没有第二种说法。
 */
export async function recordOnly(io: TxIo, args: Omit<ApplyChangeArgs, 'action'> & { action: RuleAction; decision: DecisionKind; reason: string }): Promise<ChangeResult> {
  const empty = { applied: 0, rejected: 0, rejectedItems: [] as { itemId: string; reason: string }[] };
  const versionText = await readOr(io, args.versionPath, '');
  const { nodes } = parseVersionLog(versionText);
  let doc: string;
  try {
    doc = await io.read(args.docPath);
  } catch {
    doc = '';
  }
  const base = doc ? currentVersionOf(nodes, doc) : args.baseVersion;
  if (doc && args.baseVersion !== base) {
    const reason = await recordRejected(io, {
      decisionPath: args.decisionPath,
      teacherId: args.teacherId,
      sourceVersion: args.sourceVersion,
      itemId: args.target.itemId,
      ruleId: args.target.ruleId,
      target: args.target,
      reason: `稿件已经改过（当前 ${base}，这一条基于 ${args.baseVersion}），请重新出队`,
      traceId: args.traceId,
      version: base,
    });
    return { status: 'rejected', reason, kind: 'stale', docTouched: false, ...empty };
  }
  try {
    const e = makeDecisionEvent({
      itemId: args.target.itemId,
      decision: args.decision,
      before: '',
      after: '',
      reason: args.reason,
      ruleIds: args.target.ruleId ? [args.target.ruleId] : [],
      teacherId: args.teacherId,
      sourceVersion: args.sourceVersion,
      chapter: args.target.chapter,
      version: base,
      traceId: args.traceId ?? args.target.traceId,
      timestamp: io.now?.() ?? undefined,
    });
    await appendLine(io, args.decisionPath, JSON.stringify(e) + '\n');
    return {
      status: 'applied',
      version: base,
      eventId: e.eventId ?? '',
      before: '',
      after: '',
      segId: args.target.segId,
      message: args.reason,
      applied: 1,
      rejected: 0,
      rejectedItems: [],
    };
  } catch (e) {
    return {
      status: 'rejected',
      reason: `决定写入失败：${e instanceof Error ? e.message : String(e)}`,
      kind: 'write-failed',
      docTouched: false,
      ...empty,
    };
  }
}

/* ────────────────────── 重放 ────────────────────── */

export interface SegmentReplay {
  found: boolean;
  /** 该段落重放到最后的正文（不含段标记） */
  text?: string;
  /** 该段落的版本链（时间序）。最后一条的 `segAfter` 就是 `text` */
  chain: VersionNode[];
  /** 链条是否自洽：每一步的 `segBefore` 都等于上一步的 `segAfter` */
  consistent: boolean;
  /** 不自洽时，断在哪一条版本上 */
  brokenAt?: string;
  /** "这一段现在这样"的版本节点——可回答"由哪次运行、哪版词库、谁在何时改的" */
  node?: VersionNode;
}

/**
 * 重放一个段落：从该段第一次被碰到时的样子（`segBase`）开始，沿版本链一步步施加。
 *
 * **这是验收里"所有发布段可由 sourceVersion + traceId 重放"的落点。**
 * 它不只回答"现在是什么"，还回答"这条链自不自洽"——
 * 断链（父版本的 `segAfter` 不等于子版本的 `segBefore`）意味着账本被人动过或丢过行，
 * 那时候"当前版本"这个说法本身就不成立，必须报出来而不是照常给出一个字符串。
 */
export function replaySegment(nodes: VersionNode[], segId: string): SegmentReplay {
  // 只走**有效链**：被回滚作废的那些改动不该出现在重放里（它们事实上没发生）
  const chain = effectiveNodes(nodes).filter((n) => n.target.segId === segId);
  if (!chain.length) return { found: false, chain: [], consistent: true };
  let cur = chain[0]!.segBase;
  for (const n of chain) {
    if (n.segBefore !== cur) return { found: true, text: cur, chain, consistent: false, brokenAt: n.version, node: chain[chain.length - 1] };
    cur = n.segAfter;
  }
  return { found: true, text: cur, chain, consistent: true, node: chain[chain.length - 1] };
}

/**
 * 按「`sourceVersion` + `traceId`」重放一个发布段。
 * `traceId` 来自 `RewriteRequest`（`src/core/rewrite.ts`），此时段落的来源可追、可重放。
 */
export function replayByTrace(nodes: VersionNode[], sourceVersion: string, traceId: string): SegmentReplay {
  const hit = effectiveNodes(nodes).find((n) => n.sourceVersion === sourceVersion && n.target.traceId === traceId);
  if (!hit) return { found: false, chain: [], consistent: true };
  return replaySegment(nodes, hit.target.segId);
}

/** 一段现在这一版是哪来的（进复核报告与界面"变更历史"） */
export function provenanceOf(nodes: VersionNode[], segId: string): string {
  const r = replaySegment(nodes, segId);
  if (!r.found || !r.node) return `${segId}：本运行没有改动过这一段`;
  const n = r.node;
  return (
    `${segId} 现版本 ${n.version}（父 ${n.parent ?? '—'}）｜第 ${r.chain.length} 次改动｜` +
    `${n.target.ruleId ?? '—'}｜${n.teacherId}｜${n.timestamp}｜源版本 ${n.sourceVersion}` +
    `${n.target.traceId ? `｜trace ${n.target.traceId}` : ''}${r.consistent ? '' : '｜⚠ 版本链断了，当前文本不可信'}`
  );
}

/** 版本节点里的规则号（`target.ruleId` 的短别名，给报告用） */
export const ruleOfNode = (n: VersionNode): string => n.target.ruleId ?? '';
