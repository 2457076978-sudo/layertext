// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，本仓库已部署版权验证体系，细节不予公开（docs/版权与授权.md）。
/**
 * LayerText · 教师任务实验：至少 3 位教师、同一章、相同任务
 *
 * 来源：《LayerText 工程优化总计划》阶段 4「质量科学与商业验证」——
 *   「然后做真实教师任务实验：**至少 3 位教师、同一章、相同任务**，记录**首次成功、撤销、回退和完成时间**。」
 *   验收标准：「教师实验能回答『**第一次点击是否成功**』和『**10 次操作后是否疲劳**』，
 *             而不是只报告模型输出指标」
 *
 * ── 为什么不能并入 `productmetrics.ts` ──────────────────────────────────
 * `productmetrics.ts` 量的是**一位教师自己用**的时候好不好用：首次点击到可采纳结果的耗时、
 * 撤销率、批量回退率、失败率、疲劳信号。它是一份**自助体检**：一份日志进，一张自检表出。
 * 计划要的是另一件事：**把一个人换成一队人**——同一章、同一份任务书、同一条成功判据，
 * 三位教师各跑一遍，再回答两个问题。两边的输入、分母、以及"能不能下结论"的判据都不一样：
 *   · 自助体检里"还没有批量采纳"只是暂时答不上一个次要问题；
 *   · 任务实验里**人数不够就不许有结论**——计划写的是"至少 3 位"。1 位教师跑出来的
 *     "第一次点击成功率 100%"不是发现，是**一个人的一次经历被包装成结论**。
 *
 * ── 三条不变式（照抄 `experimentrun.ts` 的纪律，不另发明一套） ────────────
 *   ① **任务书先冻成快照再发出去**，带指纹；两批实验的任务书指纹不同，两组数就不可比；
 *   ② **指标一律从原始事件派生**，每条结论都带 `eventIds` 指回原始日志的那一行；
 *   ③ **没数据就说没数据**：算不出来是 `null` + 人话原因，绝不给一个看起来像结论的 0
 *      （`productmetrics.ts` 的"算不出来 ≠ 0"，在这里是同一件事，只是分母换成了"几位教师"）。
 *
 * ── 它**不是**什么（写在最前面，免得被拿去回答它答不了的问题） ────────────
 *   · 它**不判断 AI 的建议对不对**：系统没有真值。这里"第一次点击成功"的定义是
 *     **那一下点下去事情就办成了**（落定、且事后没被自己撤销），
 *     **不是**"AI 给的那条建议是对的"——后者需要教师事后回看才知道，系统看不见；
 *   · 它**不把两个问题合成一个分数**：计划在别处已经明令禁止「综合分数替代」，
 *     这里同理——报告上只有 `firstClick` 与 `fatigue` 两个并列字段，没有"体验分"的位置
 *     （`assertSeparateQuestions` 会在报告发出之前把它拦住）；
 *   · 它**不读文件、不发请求、不看时钟**（冻结时刻与完成时刻都由调用方传进来），
 *     因此可以离线、确定性地测试。
 */

import { eventIdOf, type DecisionEvent, type DecisionKind } from './decision.js';
import { contentHash } from './manifest.js';
import { EARLY_OPS, SESSION_OPEN } from './productmetrics.js';
import { assertNoComposite, snapshotChapterOf, type SnapshotChapter } from './experimentrun.js';

/* ══════════════════════ ⓪ 门槛与名字：全部提到最前面 ══════════════════════ */

/** 计划写死的门槛：「至少 3 位教师」。少于这个数**不许有结论**，只许有"证据不足"。 */
export const MIN_TEACHERS = 3;
/** "10 次操作之后"这句话要有意义，后段至少得有这么多条决定（与 productmetrics 的 n≥3 同一条理由） */
export const MIN_LATE_OPS = 3;
/** 全体层面的追溯里，教师那一格用这个名字 */
export const ALL_TEACHERS = '全部';

export const QUESTION_FIRST_CLICK = '第一次点击是否成功';
export const QUESTION_FATIGUE = '10 次操作后是否疲劳';
/** 两个问题**并列**写在报告顶层，永不合并——测试会盯着这就两个字段 */
export const QUESTION_FIELDS = ['firstClick', 'fatigue'] as const;

/** 教师层面可追溯的指标名。**受控**：不在这个列表里的名字没有派生路径，也就不可能被追溯 */
export const TEACHER_METRICS = ['首次点击是否成功', '首次成功用时', '撤销率', '批量回退率', '执行失败率', '完成用时', '疲劳信号'] as const;
export type TeacherMetric = (typeof TEACHER_METRICS)[number];
export const isTeacherMetric = (m: string): m is TeacherMetric => (TEACHER_METRICS as readonly string[]).includes(m);

/** 完成标记的事件类型。**这是第二个标记事件**（`productmetrics.ts` 的 `session-open` 是第一个）。 */
export const TASK_DONE = 'task-done';

/* ══════════════════════ ① 任务书：先冻，再发 ══════════════════════ */

export const TEACHER_TASK_SCHEMA = 1;

/**
 * "同一章、相同任务"在操作上是什么意思——就是这一份东西。
 *
 * 不把任务书写死，两批实验之间唯一可比的就只剩"都叫第一章"这句话了：
 * 指令换了一句话、成功判据从"能发布"变成"能读顺"、章节偷偷换了一版，报告里却是同一张表。
 * 所以任务书必须**先冻结、带指纹**，冻结之后再改就是换了一个实验（见 `taskDriftOf`）。
 */
export interface TeacherTaskSpec {
  schemaVersion: number;
  /** 实验编号（这一批 3 位教师共用同一个）——它是运行身份，**不进指纹** */
  taskId: string;
  /** 章节名（与事件里的 `chapter` 逐字比对，不做模糊匹配：模糊匹配会把"第一章"配到"第十一章"） */
  chapter: string;
  /** 章节内容快照（复刻 `experimentrun.ts` 的逐段哈希：报告要说得出"第 3 段变了"） */
  chapterSnapshot: SnapshotChapter;
  /** 层级 A/M/B */
  tier: string;
  /** 逐字发给教师的指令——它是**输入**，不是文案 */
  instruction: string;
  /** 成功判据（人话、可判定）：教师做到哪一步算"完成任务" */
  successCriterion: string;
  /** 冻结时刻。**由调用方给**：本模块不读时钟（`new Date()` 兜底等于把"什么时候冻的"交给运气） */
  frozenAt: string;
  /** 任务指纹。**不含** taskId 与 frozenAt——那是身份，不是输入（同 `experimentrun` 排除 runId/createdAt） */
  hash: string;
}

export interface FreezeTeacherTaskInput {
  taskId: string;
  chapter: string;
  /** 章节分段原文（`{id, text}`，同门禁与风险队列的稳定段号口径） */
  segments: { id: string; text: string }[];
  tier: string;
  instruction: string;
  successCriterion: string;
  frozenAt: string;
}

const taskFingerprint = (s: Omit<TeacherTaskSpec, 'hash'>): string => JSON.stringify({ chapter: s.chapterSnapshot, tier: s.tier, instruction: s.instruction, successCriterion: s.successCriterion });

export function freezeTeacherTask(input: FreezeTeacherTaskInput): TeacherTaskSpec {
  const body: Omit<TeacherTaskSpec, 'hash'> = {
    schemaVersion: TEACHER_TASK_SCHEMA,
    taskId: input.taskId,
    chapter: input.chapter,
    chapterSnapshot: snapshotChapterOf(input.chapter, input.segments),
    tier: input.tier,
    instruction: input.instruction,
    successCriterion: input.successCriterion,
    frozenAt: input.frozenAt,
  };
  return { ...body, hash: contentHash(taskFingerprint(body)) };
}

export interface TaskDrift {
  ok: boolean;
  /** 会**动摇结论**的漂移（任务书内容改过） */
  drift: string[];
  /** 只提醒、不动摇结论（例如只是换了个编号） */
  warnings: string[];
  /** 有内容漂移就**不能把两组数放在一起比**——静默容忍漂移，等于让两个实验共用一个名字 */
  blocksConclusion: boolean;
}

/** 比对冻结的任务书与"现在手上这份"。**检测到就报出来，不静默容忍**。 */
export function taskDriftOf(spec: TeacherTaskSpec, current: TeacherTaskSpec): TaskDrift {
  const drift: string[] = [];
  const warnings: string[] = [];
  if (current.chapterSnapshot.hash !== spec.chapterSnapshot.hash) {
    const changed = current.chapterSnapshot.segments.filter((s) => spec.chapterSnapshot.segments.find((o) => o.id === s.id)?.hash !== s.hash).map((s) => s.id);
    const gone = spec.chapterSnapshot.segments.filter((s) => !current.chapterSnapshot.segments.some((o) => o.id === s.id)).map((s) => s.id);
    drift.push(`${spec.chapter} 的原文变了${changed.length ? `（改动段 ${changed.join('、')}）` : ''}${gone.length ? `（快照里有、现在没有的段 ${gone.join('、')}）` : '（段序或段内容变动）'}`);
  }
  if (current.chapter !== spec.chapter) drift.push(`章节换了（${spec.chapter} → ${current.chapter}）：计划要的是同一章`);
  if (current.tier !== spec.tier) drift.push(`层级换了（${spec.tier} → ${current.tier}）：不同层级的稿件难度不同，任务难度也就不同`);
  if (current.instruction !== spec.instruction) drift.push('发给教师的指令变了：换了指令就是换了任务，两组数不可比');
  if (current.successCriterion !== spec.successCriterion) drift.push('成功判据变了：判据一换，"成功率"这个词指的就是另一件事');
  if (current.taskId !== spec.taskId) warnings.push(`任务编号变了（${spec.taskId} → ${current.taskId}）：编号不进指纹，但报告得说清这批数挂在哪个编号下`);
  return { ok: drift.length === 0, drift, warnings, blocksConclusion: drift.length > 0 };
}

/* ══════════════════════ ② 原始事件：与 productmetrics 同一份日志 ══════════════════════ */

/** 打开队列那条事件里记的待办条数。它是"完成"的唯一分母来源，所以只认这一种写法。 */
export const PENDING_RE = /待办\s*(\d+)\s*条/;

const isUndo = (e: DecisionEvent): boolean => e.decision === 'undo';
const isFailure = (e: DecisionEvent): boolean => e.decision === 'rejected';
const isMarker = (e: DecisionEvent): boolean => e.itemId === SESSION_OPEN || e.itemId === TASK_DONE;
/** 除标记以外的一切按下都算"一次操作"（含撤销与执行失败）——教师那边的体感就是按了几次 */
const isAction = (e: DecisionEvent): boolean => !isMarker(e);
/** 终态决定：落定在稿件上的四种。`rejected`（系统没做成）不算——卡片还在，事情没办成。 */
const TERMINAL: ReadonlySet<string> = new Set(['accept', 'edit', 'reject', 'false-positive']);
const isTerminal = (e: DecisionEvent): boolean => !isUndo(e) && TERMINAL.has(e.decision);
const isBatch = (e: DecisionEvent): boolean => /^批量/.test(e.reason ?? '');

const timeOf = (e: DecisionEvent): number => Date.parse(e.timestamp);
const refOf = (e: DecisionEvent): string => `${e.itemId}@${e.timestamp}`;

/** 原始事件行 ID：事件自己带了就用它，没带就按 `decision.ts` 的同一条规则现算（不许丢追溯） */
const rawIdOf = (e: DecisionEvent): string => e.eventId ?? eventIdOf({ itemId: e.itemId, decision: e.decision, teacherId: e.teacherId, timestamp: e.timestamp });

/** 按时间排好的事件（同刻按原顺序）。日志是 append-only，读出来可能乱序，所以不许信传入顺序。 */
const ordered = (events: DecisionEvent[]): DecisionEvent[] =>
  events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => timeOf(a.e) - timeOf(b.e) || a.i - b.i)
    .map((x) => x.e);

/** 打开队列那条事件里记的待办条数；没记就是 null（**不是 0**——0 条待办和"没记"是两件事） */
export function pendingFromOpen(e: DecisionEvent): number | null {
  const m = PENDING_RE.exec(e.reason ?? '');
  return m ? Number(m[1]) : null;
}

export interface TaskDoneEventInput {
  taskHash: string;
  teacherId: string;
  sourceVersion: string;
  tier: string;
  /** 教师自认为处理完了多少条 */
  settled: number;
  /** 完成时刻。**由调用方给**（理由同任务书的 `frozenAt`）。 */
  timestamp: string;
}

/** 教师点"我做完了"时写的标记。没有它，"完成没完成"只能靠待办条数去推断，报告里会标 `basis`。 */
export function taskDoneEvent(input: TaskDoneEventInput): DecisionEvent {
  return {
    schemaVersion: 1,
    itemId: TASK_DONE,
    decision: 'edit',
    before: '',
    after: '',
    reason: `任务完成（${input.taskHash}，已处理 ${input.settled} 条）`,
    ruleIds: [],
    teacherId: input.teacherId,
    timestamp: input.timestamp,
    sourceVersion: input.sourceVersion,
    tier: input.tier,
    subject: { kind: 'other', value: 'task-done' },
  };
}

/* ══════════════════════ ③ 一位教师的一次会话 ══════════════════════ */

export interface FirstClickRecord {
  itemId: string | null;
  at: string | null;
  decision: DecisionKind | null;
  /** 从打开队列到第一下的毫秒数；没有 session-open 时是 null——**不是 0** */
  responseMs: number | null;
  /**
   * true = 那一下点下去事情就办成了（落定，且事后没被自己撤销）；
   * false = 他撤销了，或系统没做成（`rejected`）；
   * **null = 判不了**（他一次都没点）——"没点到"不是"点失败了"。
   */
  succeeded: boolean | null;
  why: string;
  eventIds: string[];
}

export interface FirstSuccessRecord {
  itemId: string | null;
  /** 从打开队列到第一次成功落定的毫秒数；没有 session-open 时是 null（不是 0） */
  latencyMs: number | null;
  /** 从第一下点到第一次成功一共按了几下（含撤销）；第一下就成了是 1 */
  attempts: number | null;
  eventIds: string[];
  why: string;
}

export interface UndoRecord {
  count: number;
  decisions: number;
  /** 撤销率 = 撤销次数 / 决定数（口径与 `productmetrics.ts` 完全一致） */
  rate: number;
  eventIds: string[];
}

export interface BatchRecord {
  accepts: number;
  batchAccepts: number;
  rollback: number;
  /** 批量采纳后被撤销的比例（"批量动作后的人工回退率"） */
  rollbackRate: number;
  eventIds: string[];
}

export interface FailRecord {
  count: number;
  /** 执行失败率 = rejected / (决定数 + rejected)，与 `productmetrics.ts` 同口径 */
  rate: number;
  eventIds: string[];
  /** 失败原因前几条——"不是教师的问题"这句话得拿得出证据 */
  reasons: string[];
}

export type CompletionState = '完成' | '未完成' | '不确定';
/** 完成判定的**依据**：有依据的结论和推断出来的结论必须长得不一样 */
export type CompletionBasis = '完成标记' | '待办条数（推断）' | '无依据';

export interface CompletionRecord {
  state: CompletionState;
  basis: CompletionBasis;
  /** 完成用时；没有依据时 null（不是 0） */
  durationMs: number | null;
  /** 打开队列时记的待办条数；没记就是 null */
  pending: number | null;
  /** 有终态决定的条数（被撤销的回到待办，不算） */
  settled: number;
  doneEventId: string | null;
  eventIds: string[];
  why: string;
}

export interface TeacherFatigue {
  /** 一共按了几下（含撤销与执行失败，不含 open/done 标记） */
  ops: number;
  /** 切点：前 `EARLY_OPS` 次算"开头"，之后算"之后"（与 `productmetrics.ts` 同一个 10） */
  earlyOps: number;
  lateOps: number;
  earlyUndone: number;
  lateUndone: number;
  /** 分母为 0 时是 null——**不是 0**（"分母都没有"和"撤销率为 0"不是一回事） */
  earlyUndoRate: number | null;
  lateUndoRate: number | null;
  /** true = 后段明显更随手；false = 后段没升高；**null = 算不出来**（第 11 次起决定数不足） */
  signal: boolean | null;
  eventIds: string[];
  why: string;
}

export interface TeacherSessionRecord {
  teacherId: string;
  /** 这个教师名下的**全部**原始事件行（含离题的）——追溯的第一跳 */
  eventIds: string[];
  /** 计入指标的事件行（离题的不在里面） */
  usedEventIds: string[];
  /** 任务口径核对：事件里到底记没记章节/层级——**没记就是"同一章"这件事本轮无从核对**，不是"不是同一章" */
  onTask: {
    chapterRecorded: boolean;
    tierRecorded: boolean;
    offTask: { count: number; samples: string[] };
  };
  /** 能不能把这个人算进汇总：一次操作都没有、或全部事件都离题 → 不能 */
  usable: boolean;
  /** 按下的次数（含撤销与执行失败） */
  operations: number;
  firstClick: FirstClickRecord;
  firstSuccess: FirstSuccessRecord;
  undo: UndoRecord;
  batch: BatchRecord;
  failures: FailRecord;
  completion: CompletionRecord;
  fatigue: TeacherFatigue;
  /** 指标 → 推出这个数的原始事件行（追溯表） */
  sources: Record<string, string[]>;
  /** 指标 → 为什么派生不出来（追溯时直接说给提问的人听） */
  sourcesWhy: Record<string, string>;
  notes: string[];
}

export interface TeacherSessionInput {
  /** 日志可以是全量（本函数自己按 teacherId 取他那部分） */
  events: DecisionEvent[];
  teacherId: string;
  task: TeacherTaskSpec;
}

/** 事件与任务书对不上就返回人话原因（对得上返回 null）。章节/层级**没记**不算对不上。 */
const offTaskOf = (e: DecisionEvent, task: TeacherTaskSpec): string | null => {
  if (e.chapter !== undefined && e.chapter !== task.chapter) return `章节「${e.chapter}」≠ 任务书「${task.chapter}」`;
  if (e.tier !== undefined && e.tier !== task.tier) return `层级「${e.tier}」≠ 任务书「${task.tier}」`;
  return null;
};

export function sessionRecordOf(input: TeacherSessionInput): TeacherSessionRecord {
  const task = input.task;
  const mine = ordered(input.events.filter((e) => e.teacherId === input.teacherId));
  const offs = mine.map((e) => ({ e, off: offTaskOf(e, task) })).filter((x) => x.off !== null);
  const used = mine.filter((e) => offTaskOf(e, task) === null);

  const eventIds = mine.map(rawIdOf);
  const usedEventIds = used.map(rawIdOf);
  const idsOf = (list: DecisionEvent[]): string[] => list.map(rawIdOf);

  const open = used.find((e) => e.itemId === SESSION_OPEN) ?? null;
  const opens = used.filter((e) => e.itemId === SESSION_OPEN);
  const done = [...used].reverse().find((e) => e.itemId === TASK_DONE) ?? null;
  const clicks = used.filter(isAction);
  const undos = used.filter(isUndo);
  const failures = used.filter(isFailure);
  // 决定 = 非撤销、非标记、非执行失败（口径与 `productmetrics.ts` 逐字一致，免得两处漂移）
  const decisions = used.filter((e) => isAction(e) && !isUndo(e) && !isFailure(e));
  const undoneRefs = new Set(undos.map((e) => e.undoOf).filter((x): x is string => Boolean(x)));
  const isUndone = (e: DecisionEvent): boolean => undoneRefs.has(refOf(e));

  /* ── 第一下点的是什么，成了没有 ── */
  const first = clicks[0] ?? null;
  const firstOpenMs = open ? timeOf(open) : null;
  let succeeded: boolean | null = null;
  let firstWhy: string;
  if (!first) {
    firstWhy = mine.length ? '这个教师名下有事件，但一次操作都没有（只打开了队列）——"点了没有"这件事无从谈起' : '日志里没有这位教师的任何事件：他不是没参加，就是日志没落盘';
  } else if (isFailure(first)) {
    succeeded = false;
    firstWhy = `第一下点下去，系统没做成（执行失败：${first.reason || '未记原因'}）——这是系统的问题，不是他点错了`;
  } else if (isUndone(first)) {
    succeeded = false;
    firstWhy = '第一下点完他自己撤销了：那一下不算成（撤销是教师改主意，不是系统出错）';
  } else {
    succeeded = true;
    firstWhy = `第一下点了「${first.decision}」并落定，事后没有被撤销`;
  }
  const firstClick: FirstClickRecord = {
    itemId: first?.itemId ?? null,
    at: first?.timestamp ?? null,
    decision: first?.decision ?? null,
    responseMs: first && firstOpenMs !== null ? Math.max(0, timeOf(first) - firstOpenMs) : null,
    succeeded,
    why: firstWhy,
    eventIds: first ? idsOf([first, ...undos.filter((u) => u.undoOf === refOf(first))]) : [],
  };

  /* ── 第一次成功：第一下就成了的话，它就是第一下 ── */
  const successIdx = clicks.findIndex((e) => isTerminal(e) && !isUndone(e));
  const success = successIdx >= 0 ? clicks[successIdx] : null;
  const firstSuccess: FirstSuccessRecord = {
    itemId: success?.itemId ?? null,
    latencyMs: success && firstOpenMs !== null ? Math.max(0, timeOf(success) - firstOpenMs) : null,
    attempts: success ? successIdx + 1 : null,
    eventIds: success ? idsOf(clicks.slice(0, successIdx + 1)) : [],
    why: success
      ? `按到第 ${successIdx + 1} 下时第一次落定（${success.decision}），之后没被撤销`
      : clicks.length
        ? `${clicks.length} 次操作里没有一次是"落定且没被撤销"的：一次成功都没记录到`
        : '一次操作都没有——"首次成功"无从谈起（**不是"0 秒成功"，也不是"失败"**）',
  };

  const undo: UndoRecord = { count: undos.length, decisions: decisions.length, rate: decisions.length ? undos.length / decisions.length : 0, eventIds: idsOf([...decisions, ...undos]) };

  const batchAccepts = decisions.filter((e) => e.decision === 'accept' && isBatch(e));
  const accepts = decisions.filter((e) => e.decision === 'accept');
  const rollback = batchAccepts.filter(isUndone).length;
  const batch: BatchRecord = {
    accepts: accepts.length,
    batchAccepts: batchAccepts.length,
    rollback,
    rollbackRate: batchAccepts.length ? rollback / batchAccepts.length : 0,
    eventIds: idsOf([...batchAccepts, ...undos]),
  };

  const failRate = decisions.length + failures.length ? failures.length / (decisions.length + failures.length) : 0;
  const failuresRec: FailRecord = {
    count: failures.length,
    rate: failRate,
    eventIds: idsOf([...decisions, ...failures]),
    reasons: [...new Set(failures.map((e) => e.reason).filter(Boolean))].slice(0, 3),
  };

  /* ── 疲劳：按"按下的次数"切前后段（撤销本身也是一次操作） ── */
  const earlyClicks = clicks.slice(0, EARLY_OPS);
  const lateClicks = clicks.slice(EARLY_OPS);
  const earlyDec = earlyClicks.filter((e) => !isUndo(e));
  const lateDec = lateClicks.filter((e) => !isUndo(e));
  const earlyUndone = earlyDec.filter(isUndone).length;
  const lateUndone = lateDec.filter(isUndone).length;
  const earlyUndoRate = earlyDec.length ? earlyUndone / earlyDec.length : null;
  const lateUndoRate = lateDec.length ? lateUndone / lateDec.length : null;
  const enoughLate = lateDec.length >= MIN_LATE_OPS;
  const fatigue: TeacherFatigue = {
    ops: clicks.length,
    earlyOps: earlyDec.length,
    lateOps: lateDec.length,
    earlyUndone,
    lateUndone,
    earlyUndoRate,
    lateUndoRate,
    signal: enoughLate && earlyUndoRate !== null && lateUndoRate !== null ? lateUndoRate > earlyUndoRate * 1.5 && lateUndoRate > 0.1 : null,
    eventIds: idsOf(clicks),
    why: !clicks.length
      ? '一次操作都没有：谈不上疲劳'
      : enoughLate
        ? `前 ${EARLY_OPS} 次决定 ${earlyDec.length} 条（撤 ${earlyUndone}），第 ${EARLY_OPS + 1} 次起 ${lateDec.length} 条（撤 ${lateUndone}）`
        : `第 ${EARLY_OPS + 1} 次起只有 ${lateDec.length} 次决定（要 ≥${MIN_LATE_OPS} 次才谈得上"之后"）：**算不出来，不是"不疲劳"**`,
  };

  /* ── 完成：有标记才算事实，没标记只能说"推断"或"不知道" ── */
  const pending = open ? pendingFromOpen(open) : null;
  const settledRefs = new Set(
    decisions
      .filter(isTerminal)
      .filter((e) => !isUndone(e))
      .map((e) => e.itemId),
  );
  const settled = settledRefs.size;
  const settledTimes = decisions.filter(isTerminal).filter((e) => !isUndone(e));
  const lastSettledMs = settledTimes.length ? Math.max(...settledTimes.map(timeOf)) : null;
  let completion: CompletionRecord;
  if (done) {
    completion = {
      state: '完成',
      basis: '完成标记',
      durationMs: firstOpenMs !== null ? Math.max(0, timeOf(done) - firstOpenMs) : null,
      pending,
      settled,
      doneEventId: rawIdOf(done),
      eventIds: idsOf([...used.filter((e) => e.itemId === SESSION_OPEN), done]),
      why: firstOpenMs !== null ? '有完成标记：这是他自己说的"做完了"' : '有完成标记，但没有 session-open：完成用时算不出来（不是 0），"做完了"这件事本身是有的',
    };
  } else if (pending !== null) {
    const finished = settled >= pending;
    completion = {
      state: finished ? '完成' : '未完成',
      basis: '待办条数（推断）',
      durationMs: finished && firstOpenMs !== null && lastSettledMs !== null ? Math.max(0, lastSettledMs - firstOpenMs) : null,
      pending,
      settled,
      doneEventId: null,
      eventIds: idsOf([...used.filter((e) => e.itemId === SESSION_OPEN), ...settledTimes]),
      why: `没有完成标记，只有待办条数：打开时 ${pending} 条，落定 ${settled} 条——完成与否是**推断**出来的，报告里必须标着`,
    };
  } else {
    completion = {
      state: '不确定',
      basis: '无依据',
      durationMs: null,
      pending,
      settled,
      doneEventId: null,
      eventIds: [...used.filter((e) => e.itemId === SESSION_OPEN), ...settledTimes].map(rawIdOf),
      why: '既没有完成标记、也读不到待办条数：他做完了没有，日志里**没有这件事实**——这不是"没做完"',
    };
  }

  const notes: string[] = [];
  if (opens.length > 1) notes.push(`⚠ 这位教师打开了 ${opens.length} 次队列：本记录只按第一次会话计时，多次会话的用时需要人工核对`);
  if (done && pending !== null && settled < pending) notes.push(`⚠ 有完成标记，但只看到 ${settled}/${pending} 条落定：标记与落定对不上，值得人工看一眼`);
  if (offs.length) notes.push(`⚠ 有 ${offs.length} 条事件不在任务书口径内（${offs[0]!.off}）：已排除出指标，**不是静默丢弃**`);
  if (!used.some((e) => e.chapter !== undefined) && used.length) notes.push('事件里没有章节字段：本轮**无从核对**"大家做的是同一章"（不是"不是同一章"）');
  if (failures.length) notes.push(`执行失败 ${failures.length} 次（${failuresRec.reasons.join('；')}）：偏高说明稿件状态或路径有问题，不是教师的问题`);

  const sources: Record<string, string[]> = {
    首次点击是否成功: firstClick.eventIds,
    首次成功用时: firstSuccess.eventIds,
    撤销率: undo.eventIds,
    批量回退率: batch.eventIds,
    执行失败率: failuresRec.eventIds,
    完成用时: completion.durationMs === null ? [] : completion.eventIds,
    疲劳信号: fatigue.signal === null ? [] : fatigue.eventIds,
  };
  const sourcesWhy: Record<string, string> = {
    首次点击是否成功: firstClick.why,
    首次成功用时: firstSuccess.why,
    撤销率: decisions.length ? '撤销率的分母是决定数（口径同 productmetrics）' : '一次决定都没有：比率没有分母',
    批量回退率: batchAccepts.length ? '分母是批量采纳条数' : '没有任何批量采纳：批量回退率没有分母，也就没有可追的原始事件',
    执行失败率: '分母是决定数 + 执行失败数',
    完成用时: completion.why,
    疲劳信号: fatigue.why,
  };

  const usable = clicks.length > 0 && used.length > 0;
  return {
    teacherId: input.teacherId,
    eventIds,
    usedEventIds,
    onTask: {
      chapterRecorded: used.some((e) => e.chapter !== undefined),
      tierRecorded: used.some((e) => e.tier !== undefined),
      offTask: { count: offs.length, samples: [...new Set(offs.map((x) => x.off!))].slice(0, 3) },
    },
    usable,
    operations: clicks.length,
    firstClick,
    firstSuccess,
    undo,
    batch,
    failures: failuresRec,
    completion,
    fatigue,
    sources,
    sourcesWhy,
    notes,
  };
}

/* ══════════════════════ ④ 跨教师汇总：两个问题，各自回答 ══════════════════════ */

export type TeacherExperimentState = '未跑' | '教师数不足' | '有缺口' | '可出结论';

export interface QuestionAnswer {
  /** 问题的原话（直接进报告，免得下游把它改写成别的意思） */
  question: string;
  available: boolean;
  /** 能回答时是一句人话；**不能回答时是 null**（不是空字符串，更不是"未见异常"） */
  conclusion: string | null;
  /** 从原始事件直接数出来的事实。**光看这里的数不许下结论**——先看 `available` */
  numbers: Record<string, number | null>;
  teacherIds: string[];
  eventIds: string[];
  why: string;
}

export interface CompletionSummary {
  teachers: number;
  finished: number;
  unfinished: number;
  unknown: number;
  /** 拿得到完成用时的人数 */
  timed: number;
  /** 完成用时的中位数；一个人都没有时为 null（不是 0） */
  medianDurationMs: number | null;
  /** 完成时间是"推断"出来的教师——用时一旦带上这个标签就不该被当准数引用 */
  inferred: string[];
  /** 缺完成时间的是谁 */
  unknownWho: string[];
  eventIds: string[];
}

export interface TeacherExperimentReport {
  state: TeacherExperimentState;
  why: string;
  taskHash: string;
  task: TeacherTaskSpec;
  /** 名单里点名了却一条事件都没有的教师——不静默 */
  missingTeachers: string[];
  /** 打开了队列但一次都没操作的教师：不计入 3 人次，但这是上手门槛的证据，别删 */
  idleTeachers: string[];
  teachers: TeacherSessionRecord[];
  /** 验收问题一 */
  firstClick: QuestionAnswer;
  /** 验收问题二 */
  fatigue: QuestionAnswer;
  /** 完成情况的汇总（记录"完成时间"是计划明文要求，但它不是第三个验收问题） */
  completion: CompletionSummary;
  /** 全体层面的结论 → 原始事件行（追溯表） */
  sources: Record<string, string[]>;
  verdict: string[];
}

export interface TeacherExperimentInput {
  task: TeacherTaskSpec;
  /** 全部教师混在一起的追加日志（与 App 里那份同形） */
  events: DecisionEvent[];
  /** 设计里点名要参加的教师。有它才分得清"没人来"和"来了没做" */
  roster?: string[];
  /** 跑完之后再核一眼任务书；给了就自动比对，有漂移即 `blocksConclusion` */
  currentTask?: TeacherTaskSpec | null;
}

const answerLine = (q: QuestionAnswer): string => (q.available && q.conclusion ? `✅ **${q.question}**：${q.conclusion}` : `⚠ **${q.question}**：不给结论——${q.why}`);

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
};

export function teacherExperiment(input: TeacherExperimentInput): TeacherExperimentReport {
  const withTeacher = input.events.filter((e) => !!e.teacherId);
  const byTeacher = new Map<string, DecisionEvent[]>();
  for (const e of ordered(withTeacher)) {
    if (!byTeacher.has(e.teacherId)) byTeacher.set(e.teacherId, []);
    byTeacher.get(e.teacherId)!.push(e);
  }
  const teacherIds = [...byTeacher.keys()].sort((a, b) => timeOf(byTeacher.get(a)![0]!) - timeOf(byTeacher.get(b)![0]!) || (a < b ? -1 : 1));
  const records = teacherIds.map((t) => sessionRecordOf({ events: byTeacher.get(t)!, teacherId: t, task: input.task }));
  const usable = records.filter((r) => r.usable);
  const idleTeachers = records.filter((r) => !r.usable).map((r) => r.teacherId);
  const missingTeachers = (input.roster ?? []).filter((t) => !byTeacher.has(t)).sort();

  /* ── 问题一：第一次点击是否成功 ── */
  const determinate = usable.filter((r) => r.firstClick.succeeded !== null);
  const okFirst = determinate.filter((r) => r.firstClick.succeeded === true);
  const badFirst = determinate.filter((r) => r.firstClick.succeeded === false);
  const firstAvail = determinate.length >= MIN_TEACHERS;
  const firstClick: QuestionAnswer = {
    question: QUESTION_FIRST_CLICK,
    available: firstAvail,
    conclusion: firstAvail
      ? `${determinate.length} 位教师里 ${okFirst.length} 位第一次点击就成功（${((okFirst.length / determinate.length) * 100).toFixed(0)}%），${badFirst.length} 位第一次没成（撤销或系统没做成）`
      : null,
    numbers: { 可判定教师数: determinate.length, 第一次就成功: okFirst.length, 第一次没成: badFirst.length, 成功率: determinate.length ? okFirst.length / determinate.length : null },
    teacherIds: determinate.map((r) => r.teacherId),
    eventIds: [...new Set(determinate.flatMap((r) => r.firstClick.eventIds))],
    why: determinate.length
      ? `只有 ${determinate.length} 位教师的"第一次点击"可判定，计划要求**至少 ${MIN_TEACHERS} 位**：这个数只能当过程记录，不能当发现报出去`
      : `没有一位教师的"第一次点击"可判定（要有操作才谈得上点没点成）：这个问题目前答不了，计划要求至少 ${MIN_TEACHERS} 位教师`,
  };

  /* ── 问题二：10 次操作后是否疲劳 ── */
  const withSignal = usable.filter((r) => r.fatigue.signal !== null);
  const hot = withSignal.filter((r) => r.fatigue.signal === true);
  const earlyOps = withSignal.reduce((n, r) => n + r.fatigue.earlyOps, 0);
  const lateOps = withSignal.reduce((n, r) => n + r.fatigue.lateOps, 0);
  const earlyUndone = withSignal.reduce((n, r) => n + r.fatigue.earlyUndone, 0);
  const lateUndone = withSignal.reduce((n, r) => n + r.fatigue.lateUndone, 0);
  const pooledEarly = earlyOps ? earlyUndone / earlyOps : null;
  const pooledLate = lateOps ? lateUndone / lateOps : null;
  const fatigueAvail = withSignal.length >= MIN_TEACHERS;
  const pctText = (x: number | null): string => (x === null ? '算不出来' : `${(x * 100).toFixed(0)}%`);
  const fatigue: QuestionAnswer = {
    question: QUESTION_FATIGUE,
    available: fatigueAvail,
    conclusion: fatigueAvail
      ? hot.length
        ? `${withSignal.length} 位教师里 ${hot.length} 位在第 ${EARLY_OPS + 1} 次之后撤销率明显升高（合计：前 ${EARLY_OPS} 次 ${pctText(pooledEarly)} → 之后 ${pctText(pooledLate)}）：**10 次操作之后确实更随手**`
        : `${withSignal.length} 位教师的第 ${EARLY_OPS + 1} 次之后撤销率都没有明显升高（合计：前 ${EARLY_OPS} 次 ${pctText(pooledEarly)} → 之后 ${pctText(pooledLate)}）：**没有看到"越点越随手"的证据**`
      : null,
    numbers: { 可判定教师数: withSignal.length, 后段升高人数: hot.length, 前段决定数: earlyOps, 后段决定数: lateOps, 前段撤销率: pooledEarly, 后段撤销率: pooledLate },
    teacherIds: withSignal.map((r) => r.teacherId),
    eventIds: [...new Set(withSignal.flatMap((r) => r.fatigue.eventIds))],
    why: withSignal.length
      ? `只有 ${withSignal.length} 位教师做到了"第 ${EARLY_OPS + 1} 次之后还有 ≥${MIN_LATE_OPS} 次决定"，计划要求**至少 ${MIN_TEACHERS} 位**：说'10 次操作后疲劳'证据不足`
      : `没有一位教师的操作数够到"${EARLY_OPS} 次之后"：这个问题**算不出来**（不是"不疲劳"）——计划要求**至少 ${MIN_TEACHERS} 位**教师，且每位至少按 ${EARLY_OPS + MIN_LATE_OPS} 下，本轮一条都没够着`,
  };

  /* ── 完成情况的汇总（计划要求记录完成时间） ── */
  const finished = usable.filter((r) => r.completion.state === '完成');
  const timed = finished.filter((r) => r.completion.durationMs !== null);
  const completion: CompletionSummary = {
    teachers: usable.length,
    finished: finished.length,
    unfinished: usable.filter((r) => r.completion.state === '未完成').length,
    unknown: usable.filter((r) => r.completion.state === '不确定').length,
    timed: timed.length,
    medianDurationMs: median(timed.map((r) => r.completion.durationMs!)),
    inferred: finished.filter((r) => r.completion.basis !== '完成标记').map((r) => r.teacherId),
    unknownWho: usable.filter((r) => r.completion.state === '不确定').map((r) => r.teacherId),
    eventIds: [...new Set(usable.flatMap((r) => r.completion.eventIds))],
  };

  /* ── 状态：人数不够是一种状态，不是一个可以忽略的细节 ── */
  const drift = input.currentTask ? taskDriftOf(input.task, input.currentTask) : null;
  const gaps: string[] = [];
  if (usable.length >= MIN_TEACHERS && !firstAvail) gaps.push(`第一次点击是否成功：可判定的教师只有 ${determinate.length} 位（要 ≥${MIN_TEACHERS}）`);
  if (usable.length >= MIN_TEACHERS && !fatigueAvail) gaps.push(`10 次操作后是否疲劳：够到"${EARLY_OPS} 次之后"的教师只有 ${withSignal.length} 位（要 ≥${MIN_TEACHERS}）`);
  if (drift?.blocksConclusion) gaps.push(`任务书在实验之后变了：${drift.drift.join('；')}`);
  const offTaskTotal = records.reduce((n, r) => n + r.onTask.offTask.count, 0);
  if (offTaskTotal) gaps.push(`有 ${offTaskTotal} 条事件不在任务书口径内（章节/层级对不上）——已排除出指标，两组数不是同一件事`);

  let state: TeacherExperimentState;
  let why: string;
  if (!teacherIds.length) {
    state = '未跑';
    why = '日志里没有任何教师的事件：教师任务实验一次都没跑过——这里没有数字可报，**不是"跑出来是 0"**';
  } else if (usable.length < MIN_TEACHERS) {
    state = '教师数不足';
    why = `能算进汇总的教师只有 ${usable.length} 位（计划要求**至少 ${MIN_TEACHERS} 位**）${
      idleTeachers.length ? `；另有 ${idleTeachers.length} 位打开了队列但一次都没操作（${idleTeachers.join('、')}）` : ''
    }${missingTeachers.length ? `；名单里还缺 ${missingTeachers.join('、')}` : ''}`;
  } else if (gaps.length) {
    state = '有缺口';
    why = gaps.join('；');
  } else {
    state = '可出结论';
    why = `${usable.length} 位教师、同一章（${input.task.chapter}）、任务书指纹 ${input.task.hash}：两个问题都有据可答`;
  }

  const verdict: string[] = [];
  if (!teacherIds.length) verdict.push(`⚠ ${why}`);
  verdict.push(answerLine(firstClick), answerLine(fatigue));
  if (teacherIds.length) {
    verdict.push(
      completion.medianDurationMs !== null
        ? `完成情况：${completion.teachers} 位里 ${completion.finished} 位完成，完成用时中位数 ${(completion.medianDurationMs / 1000 / 60).toFixed(1)} 分钟（${completion.inferred.length ? `其中 ${completion.inferred.join('、')} 是按待办条数推断的，不是完成标记` : '都是完成标记'}）`
        : `完成情况：${completion.teachers} 位里 ${completion.finished} 位完成，但**没有一个人的完成用时算得出来**${completion.unknownWho.length ? `（${completion.unknownWho.join('、')} 的完成与否都无从判断）` : ''}——用时这一栏不许填 0`,
    );
    if (idleTeachers.length) verdict.push(`⚠ ${idleTeachers.join('、')} 打开了队列但一次都没操作：不计入 ${MIN_TEACHERS} 人次，但这是**上手门槛**的证据，别当噪音删掉`);
    if (missingTeachers.length) verdict.push(`⚠ 名单里的 ${missingTeachers.join('、')} 一条事件都没有：是没来，还是日志没落盘，这里分不出来`);
    if (offTaskTotal) verdict.push(`⚠ 有 ${offTaskTotal} 条事件与任务书口径不符（${[...new Set(records.flatMap((r) => r.onTask.offTask.samples))].slice(0, 3).join('；')}）`);
    if (!records.some((r) => r.usable && r.onTask.chapterRecorded)) verdict.push('⚠ 事件里没有章节字段："同一章"这件事本轮**无从核对**——计划的前提之一没有被证据覆盖');
    if (drift?.warnings.length) verdict.push(`⚠ ${drift.warnings.join('；')}`);
    verdict.push('⚠ 这里量的是**教师那边的过程**（点得成不成、撤没撤、多久做完），**不是**AI 建议对不对：系统没有"这条建议正确"的真值');
  }

  const report: TeacherExperimentReport = {
    state,
    why,
    taskHash: input.task.hash,
    task: input.task,
    missingTeachers,
    idleTeachers,
    teachers: records,
    firstClick,
    fatigue,
    completion,
    sources: { [QUESTION_FIRST_CLICK]: firstClick.eventIds, [QUESTION_FATIGUE]: fatigue.eventIds },
    verdict,
  };
  assertSeparateQuestions(report);
  return report;
}

/* ══════════════════════ ⑤ 两个问题各自报，永不合成一个分 ══════════════════════ */

/**
 * 报告出门前的最后一道闸。
 * 阶段 4 已经就"A/M 两条轴禁止综合分数替代"立过一次规矩，这里同理：
 * "第一次点击成不成"与"10 次之后疲劳不疲劳"是两件独立的事——合成一个"体验分"之后，
 * 那个分谁也拿不去做判断（是点不动，还是后段太累？一个数说不清）。
 */
export function assertSeparateQuestions(report: TeacherExperimentReport): void {
  assertNoComposite(report, '教师任务实验报告');
  const missing = QUESTION_FIELDS.filter((f) => !report[f]);
  if (missing.length) throw new Error(`教师任务实验报告缺少验收问题字段（${missing.join('、')}）：两个问题必须各自成字段，不许被合并`);
}

/* ══════════════════════ ⑥ 任一结论都能追溯回原始事件 ══════════════════════ */

export interface TeacherTraceRequest {
  metric: string;
  /** 教师 ID；跨教师结论写 `ALL_TEACHERS`（`全部`） */
  teacherId: string;
}

export interface TeacherTrace {
  metric: string;
  teacherId: string;
  ok: boolean;
  /** 推出这个数的原始事件行（拿它去指原始日志） */
  eventIds: string[];
  /** 不论成败都有一句人话：**追不到的结论必须说清为什么**，而不是给个空数组 */
  why: string;
}

/**
 * 追溯：给定「哪个指标 + 哪位教师」，返回原始事件行。
 * 与 `experimentrun.ts` 的 `traceConclusion` 同一条纪律——
 * 一条追不到的结论被当成发现写进报告，就是阶段 4 验收里"任一结论都能追溯到原始事件"失效的样子。
 */
export function traceTeacherMetric(req: TeacherTraceRequest, report: TeacherExperimentReport): TeacherTrace {
  const base: TeacherTrace = { metric: req.metric, teacherId: req.teacherId, ok: false, eventIds: [], why: '' };
  const known = isTeacherMetric(req.metric) || QUESTION_FIELDS.some((f) => report[f].question === req.metric);
  if (!known) {
    return { ...base, why: `「${req.metric}」不是本实验定义的指标（教师层面只有 ${TEACHER_METRICS.join(' / ')}，全体层面只有两个验收问题）：没有派生路径的结论无从追溯` };
  }
  if (req.teacherId === ALL_TEACHERS) {
    const ids = report.sources[req.metric];
    if (!ids) return { ...base, why: `「${req.metric}」只在教师层面派生：全体层面只回答两个验收问题（第一次点击是否成功 / 10 次操作后是否疲劳）` };
    if (!ids.length) return { ...base, why: `「${req.metric}」这一批没有可追溯的原始事件：结论本身就没给（见 ${report.why}）` };
    return { ...base, ok: true, eventIds: ids, why: `${ids.length} 条原始事件（${report.teachers.length} 位教师的事件里挑出来的）` };
  }
  const rec = report.teachers.find((r) => r.teacherId === req.teacherId);
  if (!rec) return { ...base, why: `日志里没有教师「${req.teacherId}」的任何事件：他不是没参加，就是日志没落盘——两种都不是"0 次操作"` };
  const ids = rec.sources[req.metric];
  if (!ids || !ids.length) {
    const why = rec.sourcesWhy[req.metric] ?? '这位教师在原始事件里没有支撑这个数的事实';
    return { ...base, why: `「${req.metric}」对教师「${req.teacherId}」追不到：${why}` };
  }
  return { ...base, ok: true, eventIds: ids, why: `${ids.length} 条原始事件｜教师「${req.teacherId}」` };
}

/** 一批追溯请求分拣：能追的与**追不到的**都交出来（后者只能报"追不到"，不能当发现） */
export function traceTeacherAll(reqs: TeacherTraceRequest[], report: TeacherExperimentReport): { traceable: TeacherTrace[]; untraceable: TeacherTrace[] } {
  const all = reqs.map((r) => traceTeacherMetric(r, report));
  return { traceable: all.filter((t) => t.ok), untraceable: all.filter((t) => !t.ok) };
}
