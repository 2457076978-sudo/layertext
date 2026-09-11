// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，本仓库已部署版权验证体系，细节不予公开（docs/版权与授权.md）。
/**
 * LayerText · 四格实验的**运行记录**：输入快照 / 原始事件 / 追溯 / 诚实降级
 *
 * 来源：《LayerText 工程优化总计划》阶段 4「质量科学与商业验证」。验收标准三句话：
 *   「**四格实验有可重复的输入快照和原始事件**；任一质量结论都能追溯到运行 ID」
 *   「教师实验能回答『第一次点击是否成功』和『10 次操作后是否疲劳』，而不是只报告模型输出指标」
 *   「对外定位固定为『受控的分层阅读适配』，明确区分降低阅读负荷与增加理解支架」
 *
 * ── 这一层补的是哪两个洞 ────────────────────────────────────────────────
 * `src/core/experiment.ts` 会把一段段日志算成四个格的对照表，但它**不知道这些数字是从哪来的**：
 * 输入是当场读的文件、模型名是当场拼的字符串、词表是当场加载的对象。于是三件事没人拦得住：
 *   ① 两人各跑一次"四格实验"，输入其实不同（词表更新过一版、提示词改过一句话），
 *      报告里却是同一张表——**没人能说清这两次跑的是不是同一件事**；
 *   ② 表里的数一旦被人引用进论文，问"这个 98% 是哪一次运行、哪几行日志推出来的"，
 *      答不上来，只能重跑；
 *   ③ 实验没跑时，报表照样"算"出 0%——**"还没跑"和"跑出来是 0"长得一模一样**。
 * 本模块把这三件事压成三条不变式：
 *   · **输入先冻成快照再跑**，快照带指纹；跑完再看一眼输入有没有变，变了就**拒绝把数字当结论**；
 *   · **指标一律从原始事件派生**（事件是唯一的原始账，不另算一份，免得两处漂移）；
 *   · **没数据就说没数据**：返回 `null` + 人话原因，绝不返回一个看起来像结果的 0。
 *
 * ── 与既有代码的分工 ────────────────────────────────────────────────────
 *   `src/core/experiment.ts`     —— 从"段"算指标（纯计算），本模块的派生层直接复用它
 *   `src/core/manifest.ts`       —— `contentHash`/`LexiconSnapshot` 的唯一口径，本模块只调用
 *   `src/core/positioning.ts`    —— 两条轴的定义（阅读负荷下降 / 理解支架覆盖率），本模块**不重算**
 *   `src/core/productmetrics.ts` —— "数据不足要老实说"的写法范式，本模块照此办理
 *   `tools/af_pipeline/LayerText_AF四格实验.mjs` —— 采快照、跑四格、写原始事件（本模块不碰文件）
 *
 * 本文件是纯逻辑：不读文件、不发请求、不看时间（时间由调用方传进来），因此可以离线确定性测试。
 */

import { contentHash } from './manifest.js';
import { estimateCost, experimentPlan, measureCell, type CellMetric, type CellSegment, type CellSpec } from './experiment.js';
import { positioningOf, type Axis } from './positioning.js';
import { wordCount } from './segmentgate.js';
import type { QcResult } from './qc.js';

/* ══════════════════════ ① 可重复的输入快照 ══════════════════════ */

export const EXPERIMENT_SNAPSHOT_SCHEMA = 1;

export interface SnapshotSegment {
  /** 段号（`P07`）——与门禁、风险队列同一套稳定 ID */
  id: string;
  hash: string;
  words: number;
}

export interface SnapshotChapter {
  name: string;
  /** 整章指纹：段序 + 每段内容都进哈希，段被换位也算变了 */
  hash: string;
  segments: SnapshotSegment[];
}

export interface SnapshotLexicon {
  /** 与 `manifest.ts` 的 `LexiconSnapshot.version` 同口径（换一个字节就换一个版本） */
  version: string;
  counts: Record<string, number>;
  sources: { name: string; hash: string; count: number }[];
}

export interface SnapshotModel {
  name: string;
  temperature: number;
  /** 单次响应上限。**截断率的分母口径靠它**，所以它是输入的一部分而不是实现细节 */
  maxTokens: number;
}

export interface SnapshotCode {
  /** 引擎版本（package.json） */
  version: string;
  /** git 提交（短） */
  commit: string;
  /** 工作区脏指纹：跑的时候代码是改过的，那"同一份代码"这句话就不成立 */
  dirty: string;
  dirtyCount?: number;
}

export interface ExperimentSnapshot {
  schemaVersion: number;
  runId: string;
  tier: string;
  createdAt: string;
  chapter: SnapshotChapter;
  lexicon: SnapshotLexicon;
  model: SnapshotModel;
  promptVersion: string;
  code: SnapshotCode;
  /** 四格定义（独立/会话 × 全词表/无全词表）。**格定义也是输入**：改了它就该换快照 */
  cells: CellSpec[];
  /** 输入指纹。**不含** runId 与 createdAt——那是运行身份，不是输入 */
  hash: string;
}

export interface BuildExperimentSnapshotInput {
  runId: string;
  tier: string;
  chapter: SnapshotChapter;
  lexicon: SnapshotLexicon;
  model: SnapshotModel;
  promptVersion: string;
  code: SnapshotCode;
  cells?: CellSpec[];
  createdAt?: string;
}

/**
 * 由分段原文造章节快照。**逐段哈希**而不是只哈希整章：
 * 只记整章哈希时，报告只能说"原文变了"，说不出"第 3 段变了"，
 * 而四格实验的结论恰恰是逐段的（覆盖率按段算），定位不到段就没法复核。
 */
export function snapshotChapterOf(name: string, segments: { id: string; text: string }[]): SnapshotChapter {
  return {
    name,
    // 用 \u0000 分隔：段号与正文之间不会有这个字符，`P01` + `ab` 与 `P01a` + `b` 才不会被拼成同一个指纹
    hash: contentHash(segments.map((s) => `${s.id}\u0000${s.text}`).join('\n')),
    segments: segments.map((s) => ({ id: s.id, hash: contentHash(s.text), words: wordCount(s.text) })),
  };
}

/** 指纹只看输入事实（章节 / 词表 / 模型+温度 / 提示词 / 代码 / 格定义） */
const snapshotFingerprint = (s: Omit<ExperimentSnapshot, 'hash'>): string =>
  JSON.stringify({ chapter: s.chapter, lexicon: s.lexicon, model: s.model, promptVersion: s.promptVersion, code: s.code, cells: s.cells });

export function buildExperimentSnapshot(input: BuildExperimentSnapshotInput): ExperimentSnapshot {
  const body: Omit<ExperimentSnapshot, 'hash'> = {
    schemaVersion: EXPERIMENT_SNAPSHOT_SCHEMA,
    runId: input.runId,
    tier: input.tier,
    createdAt: input.createdAt ?? new Date().toISOString(),
    chapter: input.chapter,
    lexicon: input.lexicon,
    model: input.model,
    promptVersion: input.promptVersion,
    code: input.code,
    cells: input.cells ?? experimentPlan(),
  };
  return { ...body, hash: contentHash(snapshotFingerprint(body)) };
}

/** 跑的时候的输入（与快照同一组字段，由调用方现读） */
export interface SnapshotCurrentInput {
  chapter: SnapshotChapter;
  lexiconVersion: string;
  model: SnapshotModel;
  promptVersion: string;
  code: SnapshotCode;
  cells?: CellSpec[];
}

export interface SnapshotDrift {
  ok: boolean;
  /** 人话的漂移清单：点名"哪个输入变了、从什么变成什么" */
  drift: string[];
  /**
   * 有漂移就**不能把数字当结论**。这一条是硬的：
   * 静默容忍漂移，等于让"这次跑的"和"快照记的"两件事共用一个名字。
   */
  blocksConclusion: boolean;
}

/**
 * 比对快照与当前输入。**检测到就报出来，不静默容忍**（阶段 4 验收：可重复的输入快照）。
 */
export function snapshotDrift(snap: ExperimentSnapshot, current: SnapshotCurrentInput): SnapshotDrift {
  const drift: string[] = [];
  if (current.chapter.hash !== snap.chapter.hash) {
    const changed = current.chapter.segments.filter((s) => snap.chapter.segments.find((o) => o.id === s.id)?.hash !== s.hash).map((s) => s.id);
    const gone = snap.chapter.segments.filter((s) => !current.chapter.segments.some((o) => o.id === s.id)).map((s) => s.id);
    drift.push(
      `原文变了（${snap.chapter.name}）：${changed.length ? `内容改动的段 ${changed.join('、')}` : ''}${changed.length && gone.length ? '；' : ''}${gone.length ? `快照里有、现在没有的段 ${gone.join('、')}` : ''}`.replace(
        '：；',
        '：',
      ),
    );
  }
  if (current.lexiconVersion !== snap.lexicon.version) {
    drift.push(`词表快照换了版本（${snap.lexicon.version} → ${current.lexiconVersion}）：这一批数字与快照不是同一套词表口径`);
  }
  const m = snap.model;
  const c = current.model;
  // 温度写死到小数点后 6 位比较：0.3 与 0.30000000000000004 是同一个温度，不该报漂移
  if (c.name !== m.name) drift.push(`模型换了（${m.name} → ${c.name}）：换模型就是换了被测量的对象`);
  else if (Math.abs(c.temperature - m.temperature) > 1e-6) drift.push(`温度变了（${m.temperature} → ${c.temperature}）：四格实验的前提之一就是温度固定`);
  else if (c.maxTokens !== m.maxTokens) drift.push(`单次响应上限变了（${m.maxTokens} → ${c.maxTokens}）：截断率的分母口径随之改变`);
  if (current.promptVersion !== snap.promptVersion) {
    drift.push(`提示词版本变了（${snap.promptVersion} → ${current.promptVersion}）：生成覆盖率考的就是提示词，换版本不可比`);
  }
  const code = current.code;
  if (code.commit !== snap.code.commit || code.version !== snap.code.version) {
    drift.push(`代码换了（${snap.code.version}@${snap.code.commit} → ${code.version}@${code.commit}）：判定与派生代码变过，两组数字不可直接比`);
  } else if (code.dirty !== snap.code.dirty) {
    drift.push(`工作区在运行期间被改过（脏指纹 ${snap.code.dirty} → ${code.dirty}）：过程中改了代码，跑的不是同一版引擎`);
  }
  if (current.cells) {
    const a = contentHash(JSON.stringify(snap.cells));
    const b = contentHash(JSON.stringify(current.cells));
    if (a !== b) drift.push('四格定义变了（格定义也是输入）：改了格就得换快照，不能拿旧快照的结论说新格');
  }
  return { ok: drift.length === 0, drift, blocksConclusion: drift.length > 0 };
}

/* ══════════════════════ ② 原始事件：一次调用一行 ══════════════════════ */

export const RAW_EVENT_SCHEMA = 1;

/**
 * 截断事实**三态**。
 *
 * 为什么必须三态：`false` 的意思只能是"确认没截断"。日志里没有 `finish_reason` 时，
 * 我们**不知道**它有没有被截断——把它写成 `false`，截断率就会算成一个漂亮的小数，
 * 而那个小数是编出来的。`unknown` 参与分母时必须把比率报成"算不出来"。
 */
export type TruncationFact = 'yes' | 'no' | 'unknown';

/** `segment` = 某格某段；`cell` = 某一格的合计（调用次数与 token 的权威来源） */
export type RawEventKind = 'segment' | 'cell';

export interface RawUsage {
  calls: number;
  in: number;
  out: number;
  cached: number;
  cost: number;
}

export interface RawEvent {
  schemaVersion: number;
  /** 稳定事件 ID —— 追溯就是拿它去指原始日志那一行 */
  eventId: string;
  kind: RawEventKind;
  runId: string;
  /** 稳定格键（`session+full`），人话标签另存 label */
  cell: string;
  label: string;
  tier: string;
  /** 段号（`P07`）；格级事件为 null */
  segment: string | null;
  model: string;
  temperature: number;
  promptVersion: string;
  usage: RawUsage;
  /**
   * 段级用量是不是"按统计增量推定"的（会话日志每段写一条累计 stats，做差得到本段用量）。
   * 推定就可能错位（例如某段抛异常没写 stats），所以**推定出来的要标出来**，不能装成直接测得的。
   */
  usageApprox?: boolean;
  truncated: TruncationFact;
  /** 这条截断判断的依据（原始事实 vs 没有事实），人复核时看它 */
  truncatedWhy: string;
  /** 代理信号：响应看起来像被切断（**是代理，不是事实**） */
  suspectedTruncation: boolean;
  outcome: 'pass' | 'needs-review';
  source: string;
  first?: string;
  final?: string;
  inputHash?: string;
  at?: string;
}

export interface RawEventInput {
  runId: string;
  spec: CellSpec;
  tier: string;
  segment: string | null;
  model: string;
  temperature: number;
  promptVersion: string;
  usage: { calls: number; in: number; out: number; cached: number };
  finishReason?: string | null;
  outcome?: 'pass' | 'needs-review';
  source?: string;
  first?: string;
  final?: string;
  inputHash?: string;
  usageApprox?: boolean;
  at?: string;
}

/** 稳定格键：两个因子各两个水平，四个键不重不漏（与 `experimentPlan()` 一一对应） */
export const cellKeyOf = (spec: CellSpec): string => `${spec.session}+${spec.vocab}`;

/** 事件 ID：同一次运行、同一格、同一段永远同一个 —— 追溯给的就是它 */
export const eventIdOf = (input: { runId: string; cell: string; segment: string | null; kind?: RawEventKind }): string =>
  `${input.runId}|${input.cell}|${input.segment ?? '(格)'}${input.kind === 'cell' ? '|合计' : ''}`;

/** 用量 → 事件里的用量（花费走 `estimateCost`，与生成脚本同一口径，不另立一套价目） */
export function usageOf(u: { calls: number; in: number; out: number; cached: number }): RawUsage {
  return { calls: u.calls, in: u.in, out: u.out, cached: u.cached, cost: Number(estimateCost(u).toFixed(6)) };
}

/**
 * 截断事实。**只看事实，不猜**：有 `finish_reason` 就照它说，没有就 `unknown`。
 * 会话脚本目前没有把 `finish_reason` 写进日志——所以现在跑出来的截断率必然是"算不出来"，
 * 这是**真实的状态**，不该被一个 0% 盖住（见 `truncationReport`）。
 */
export function truncationFactOf(raw: { finishReason?: string | null }): { fact: TruncationFact; why: string } {
  const fr = raw.finishReason;
  if (fr === undefined || fr === null || fr === '') return { fact: 'unknown', why: '会话日志没记 finish_reason——截断事实不可得（**不是"没截断"**）' };
  if (fr === 'length') return { fact: 'yes', why: '模型返回 finish_reason=length（撞到 max_tokens，响应被截断）' };
  return { fact: 'no', why: `模型返回 finish_reason=${fr}（自然结束）` };
}

/**
 * **代理指标**：响应看起来像被切断。
 * 为什么还要这个：截断的原始事实现在没记，但"被切一半的响应"有痕迹——末尾没有句终标点（或干脆是空的）。
 * 它和"错误采纳率"在 `productmetrics.ts` 里的处境一样：**同向、可观测，但不是真值**，
 * 所以它单独一个字段、单独一个名字，绝不冒充 `truncated`。
 */
export function suspectedTruncation(text: string | undefined): boolean {
  const t = (text ?? '').trim();
  if (!t) return true; // 空响应：无论是不是截断，它都不是一次正常的"写完了"
  return !/[.!?"”’）)」』…]\s*$/.test(t);
}

export function makeRawEvent(input: RawEventInput): RawEvent {
  const cell = cellKeyOf(input.spec);
  const kind: RawEventKind = input.segment === null ? 'cell' : 'segment';
  const { fact, why } = truncationFactOf({ finishReason: input.finishReason });
  return {
    schemaVersion: RAW_EVENT_SCHEMA,
    eventId: eventIdOf({ runId: input.runId, cell, segment: input.segment, kind }),
    kind,
    runId: input.runId,
    cell,
    label: input.spec.label,
    tier: input.tier,
    segment: input.segment,
    model: input.model,
    temperature: input.temperature,
    promptVersion: input.promptVersion,
    usage: usageOf(input.usage),
    ...(input.usageApprox ? { usageApprox: true } : {}),
    truncated: fact,
    truncatedWhy: why,
    suspectedTruncation: kind === 'segment' && suspectedTruncation(input.first),
    outcome: input.outcome ?? 'pass',
    source: input.source ?? '',
    ...(input.first !== undefined ? { first: input.first } : {}),
    ...(input.final !== undefined ? { final: input.final } : {}),
    ...(input.inputHash ? { inputHash: input.inputHash } : {}),
    ...(input.at ? { at: input.at } : {}),
  };
}

export interface TruncationReport {
  /** **算不出来就是 null**（事实不全），不是 0 */
  rate: number | null;
  yes: number;
  no: number;
  unknown: number;
  total: number;
  /** 代理信号命中数（**代理**，与 rate 分开报，不许合成） */
  suspected: number;
  why: string;
}

export function truncationReport(events: RawEvent[]): TruncationReport {
  const seg = events.filter((e) => e.kind === 'segment');
  const yes = seg.filter((e) => e.truncated === 'yes').length;
  const no = seg.filter((e) => e.truncated === 'no').length;
  const unknown = seg.filter((e) => e.truncated === 'unknown').length;
  const suspected = seg.filter((e) => e.suspectedTruncation).length;
  const known = yes + no;
  const why = known ? `截断率按有据可查的 ${known} 段算（另有 ${unknown} 段没有 finish_reason，未计入）` : `截断率算不出来：${unknown} 段都没记 finish_reason——原始事实不存在时，0% 会是一句假话`;
  return { rate: known ? yes / known : null, yes, no, unknown, total: seg.length, suspected, why };
}

/* ══════════════════════ ③ 指标一律从原始事件派生 ══════════════════════ */

export interface DeriveOptions {
  /** 引擎判定应注的词（调用方注入 `runQc`，与管线同一口径） */
  oovOf: (t: string) => string[];
  dict?: Map<string, string>;
  plan?: CellSpec[];
  /** 章节名（进 `CellSegment.chapter`，报告里用） */
  chapter?: string;
}

export interface CellRunRecord {
  spec: CellSpec;
  cell: string;
  tier: string;
  /** 与 `measureCell` 完全同一条派生路径：事件 → 段 → `CellInput` → 指标 */
  metric: CellMetric;
  runIds: string[];
  eventIds: string[];
  /** 花费与调用次数是从哪条原始事实来的 */
  usageSource: '格级事件' | '段级汇总';
  truncation: TruncationReport;
  /** 进了人工队列（没落盘正文）的段数 */
  needsReview: number;
}

/**
 * 格键 → 格定义。优先用 `experimentPlan()`（格定义的唯一来源）；
 * 事件里的键不在计划里时**按键本身还原**，而不是丢掉这一格——丢格的后果是
 * "少报了一格"却被读成"这一格没有差异"。
 */
const specOf = (plan: CellSpec[], cell: string, label: string): CellSpec => {
  const hit = plan.find((p) => cellKeyOf(p) === cell);
  if (hit) return hit;
  const [session, vocab] = cell.split('+');
  const s = session === 'independent' ? 'independent' : 'session';
  const v = vocab === 'lite' ? 'lite' : 'full';
  return { label: label || cell, session: s, vocab: v, scope: s === 'independent' ? 'segment' : 'tier', vocabArg: v };
};

/**
 * 把原始事件派生成四格指标。
 *
 * 为什么要这一层而不是让脚本各自 `measureCell`：脚本各算一份的时候，
 * 报告里那张表和 JSON 里那份数**会慢慢变成两个东西**（改了一处忘另一处）。
 * 现在只有一条路：报告与 JSON 都来自这里，输入是同一批事件。
 */
export function cellRecords(events: RawEvent[], opt: DeriveOptions): CellRunRecord[] {
  const plan = opt.plan ?? experimentPlan();
  const order = new Map(plan.map((p, i) => [cellKeyOf(p), i]));
  const byCell = new Map<string, RawEvent[]>();
  for (const e of events) {
    if (!byCell.has(e.cell)) byCell.set(e.cell, []);
    byCell.get(e.cell)!.push(e);
  }
  const cells = [...byCell.keys()].sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99));
  const out: CellRunRecord[] = [];
  for (const cell of cells) {
    const evs = byCell.get(cell)!;
    const spec = specOf(plan, cell, evs[0]?.label ?? cell);
    const segs = evs.filter((e) => e.kind === 'segment');
    const cellEv = evs.find((e) => e.kind === 'cell');
    // 段级用量只在**不是推定**的时候才当权威：推定值可能整段错位到隔壁段上
    const approx = segs.some((e) => e.usageApprox);
    const sum = (f: (e: RawEvent) => number): number => segs.reduce((n, e) => n + f(e), 0);
    const segmentUsage = { calls: sum((e) => e.usage.calls), in: sum((e) => e.usage.in), out: sum((e) => e.usage.out), cached: sum((e) => e.usage.cached) };
    const useSegment = !cellEv || approx;
    const usage = useSegment ? segmentUsage : { calls: cellEv.usage.calls, in: cellEv.usage.in, out: cellEv.usage.out, cached: cellEv.usage.cached };
    const segments: CellSegment[] = segs.map((e) => ({
      id: e.segment ?? '',
      chapter: opt.chapter ?? '',
      source: e.source,
      ...(e.final !== undefined ? { final: e.final } : {}),
      ...(e.first !== undefined ? { first: e.first } : {}),
    }));
    const metric = measureCell({
      spec,
      tier: evs[0]?.tier ?? '',
      segments,
      oovOf: opt.oovOf,
      ...(opt.dict ? { dict: opt.dict } : {}),
      usage,
      needsReview: segs.filter((e) => e.outcome === 'needs-review').length,
    });
    out.push({
      spec,
      cell,
      tier: evs[0]?.tier ?? '',
      metric,
      runIds: [...new Set(evs.map((e) => e.runId))],
      eventIds: evs.map((e) => e.eventId),
      usageSource: cellEv && !useSegment ? '格级事件' : '段级汇总',
      truncation: truncationReport(evs),
      needsReview: segs.filter((e) => e.outcome === 'needs-review').length,
    });
  }
  return out;
}

/* ══════════════════════ ④ 任一结论都能追溯到运行 ID ══════════════════════ */

export const METRIC_NAMES = ['生成覆盖率', '最终覆盖率', '重复注释率', '人工修订率', '成本', '截断率'] as const;
export type MetricName = (typeof METRIC_NAMES)[number];

/** 结论要报的指标**受控**：不在这个列表里的名字没有派生路径，也就不可能被追溯 */
export const isMetricName = (m: string): m is MetricName => (METRIC_NAMES as readonly string[]).includes(m);

export interface TraceRequest {
  metric: string;
  /** 稳定格键（`session+full`）；人话标签会被拒——**追溯只认键**，标签是会改的 */
  cell: string;
}

export interface Trace {
  metric: string;
  cell: string;
  ok: boolean;
  /** 结论由哪几次运行产生 */
  runIds: string[];
  /** 由哪几行原始事件推出（拿它去指原始日志） */
  eventIds: string[];
  segments: number;
  /** 不论成败都有一句人话：**不能追溯的结论必须说清为什么**，而不是给个空数组 */
  why: string;
}

/** 逐段指标事件的来源；花费/调用次数按格级事件优先 */
const sourceEventsOf = (metric: string, evs: RawEvent[]): RawEvent[] => {
  if (metric === '成本') {
    const cellEv = evs.filter((e) => e.kind === 'cell');
    return cellEv.length ? cellEv : evs.filter((e) => e.kind === 'segment');
  }
  return evs.filter((e) => e.kind === 'segment');
};

/**
 * 追溯：给定「哪个指标 + 哪一格」，返回运行 ID 与事件行。
 * **追溯不到就明说追溯不到**——一条追不到的结论被当成发现写进报告，
 * 就是阶段 4 验收里"任一质量结论都能追溯到运行 ID"失效的样子。
 */
export function traceConclusion(req: TraceRequest, events: RawEvent[]): Trace {
  const evs = events.filter((e) => e.cell === req.cell);
  const base: Trace = { metric: req.metric, cell: req.cell, ok: false, runIds: [], eventIds: [], segments: 0, why: '' };
  if (!isMetricName(req.metric)) {
    return { ...base, why: `「${req.metric}」不是本实验定义的指标（只有 ${METRIC_NAMES.join(' / ')}）：没有派生路径的结论无从追溯` };
  }
  if (!evs.length) {
    return { ...base, why: `格「${req.cell}」没有任何原始事件：这一格没跑过（或事件没落盘），结论无从追溯` };
  }
  if (req.metric === '截断率') {
    const known = evs.filter((e) => e.kind === 'segment' && e.truncated !== 'unknown').length;
    if (!known) {
      return { ...base, runIds: [...new Set(evs.map((e) => e.runId))], why: '截断事实不可得（会话日志没记 finish_reason）：截断率不能作为结论报出去' };
    }
  }
  const src = sourceEventsOf(req.metric, evs);
  return {
    metric: req.metric,
    cell: req.cell,
    ok: true,
    runIds: [...new Set(src.map((e) => e.runId))],
    eventIds: src.map((e) => e.eventId),
    segments: src.filter((e) => e.kind === 'segment').length,
    why: `${src.length} 条原始事件｜${[...new Set(src.map((e) => e.runId))].join('、')}`,
  };
}

/** 一批结论分拣：能追溯的与**不能追溯的**都要交出来（后者只能报"不可追溯"，不能当发现） */
export function traceAll(reqs: TraceRequest[], events: RawEvent[]): { traceable: Trace[]; untraceable: Trace[] } {
  const all = reqs.map((r) => traceConclusion(r, events));
  return { traceable: all.filter((t) => t.ok), untraceable: all.filter((t) => !t.ok) };
}

/* ══════════════════════ ⑤ 两条轴，永不合成一个数 ══════════════════════ */

/**
 * 合成分字段的**名字**特征。
 * 阶段 4 验收：「A/M 两条轴分别报告阅读负荷下降与理解支架覆盖率，**禁止综合分数替代**」。
 * 这条不是审美：把"阅读负荷"和"理解支架"加权成一个数之后，那个数没有任何买家能用它做判断——
 * 学生读起来轻不轻松、拐杖够不够，是两件独立的事，一个数说不清。（与 `positioning.ts` 同源）
 */
export const COMPOSITE_FIELD_PATTERN = /综合|总分|总评|得分|评分|评级|score|composite|overall|weighted/i;

/** 递归找出可疑的合成分字段（返回 `路径` 列表，便于报告直接点名） */
export function compositeFields(obj: unknown, prefix = '', seen = new WeakSet<object>()): string[] {
  if (obj === null || typeof obj !== 'object') return [];
  if (seen.has(obj as object)) return [];
  seen.add(obj as object);
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (COMPOSITE_FIELD_PATTERN.test(k)) out.push(path);
    if (v && typeof v === 'object') out.push(...compositeFields(v, path, seen));
  }
  return out;
}

/** 有合成分字段就抛——**在把它写进报告之前**拦住它 */
export function assertNoComposite(obj: unknown, where = '实验结果'): void {
  const bad = compositeFields(obj);
  if (bad.length) throw new Error(`${where}里出现了合成分字段（${bad.join('、')}）：两条轴必须分开报，禁止综合分数替代`);
}

/** 一条轴 + 它**不**代表什么（`Axis` 由 `positioning.ts` 定义，这里不重算它的含义） */
export interface AxisPair {
  tier: string;
  load: Axis;
  scaffolding: Axis;
}

/**
 * A/M 两层的两轴读数。**刻意不做加权合成**：
 * 返回对象上只有 `load` 与 `scaffolding` 两个数，任何"整体质量分"都无处安放。
 * 两轴的定义直接来自 `positioningOf`——本模块不重新算一遍生词率或加注覆盖率
 * （重算就是第二个口径，两个口径迟早会打架）。
 */
export function tierAxes(tier: string, source: Pick<QcResult, 'newWordRate'>, out: Pick<QcResult, 'newWordRate' | 'annotationCoverage' | 'annotated' | 'annotatable'>): AxisPair {
  const p = positioningOf(source, out);
  return { tier, load: p.load, scaffolding: p.scaffolding };
}

/**
 * 报告里的两行：先轴名，再含义，再"不是什么"。两行，不合并成一行。
 *
 * 负荷为负时**额外**加一句：`positioningOf` 给的是"生词率从 A 降到 B"这种句式，
 * 而生词率上升时它照样写"降到"——数值是对的，话是反的。多一句提醒，
 * 比让读者自己去比对两个百分数便宜得多（轴的定义与措辞仍归 `positioning.ts`，这里只加提醒）。
 */
export function axesLines(a: AxisPair): string[] {
  const lines = [`**${a.tier}｜${a.load.name}**：${a.load.what}`, `  （${a.load.notThis}）`, `**${a.tier}｜${a.scaffolding.name}**：${a.scaffolding.what}`, `  （${a.scaffolding.notThis}）`];
  if (a.load.value < 0) lines.splice(2, 0, `  ⚠ 生词率**反而上升**（负荷下降为负）：这里没有"更轻松"，别把它读成进步。`);
  return lines;
}

/* ══════════════════════ ⑥ 没跑就说没跑 ══════════════════════ */

export type ExperimentState = '未跑' | '有缺口' | '可出结论';

export interface ExperimentStatusInput {
  /** 没有快照 = 这次实验根本没开始 */
  snapshot: ExperimentSnapshot | null;
  events: RawEvent[];
  /** 跑完之后再核一次输入（有漂移就"有缺口"） */
  drift?: SnapshotDrift | null;
  opt: DeriveOptions;
}

export interface ExperimentStatus {
  state: ExperimentState;
  /** 人话：为什么是这个状态——直接进报告 */
  why: string;
  cells: CellRunRecord[];
  /**
   * 四格的指标。**没跑时是 null**——不是空数组，更不是四个 0：
   * "还没跑"和"跑出来是 0"必须长得不一样，否则报告会拿 0 冒充结果。
   */
  metrics: CellMetric[] | null;
  verdict: string[];
}

export function experimentStatus(input: ExperimentStatusInput): ExperimentStatus {
  const cells = input.events.length ? cellRecords(input.events, input.opt) : [];
  if (!input.snapshot) {
    return { state: '未跑', why: '还没有输入快照：四格实验一次都没跑过（先跑 `LayerText_AF四格实验.mjs`）', cells: [], metrics: null, verdict: ['四格实验还没跑——这里没有数字可报。'] };
  }
  if (!input.events.length) {
    return {
      state: '未跑',
      why: `快照在（${input.snapshot.hash}），但没有原始事件：实验还没跑，**不是"跑出来是 0"**`,
      cells: [],
      metrics: null,
      verdict: ['四格实验还没跑：只有输入快照，没有原始事件，任何"覆盖率 0%"的说法都是无中生有。'],
    };
  }
  const ran = new Set(cells.map((c) => c.cell));
  const missing = (input.snapshot.cells ?? experimentPlan()).filter((s) => !ran.has(cellKeyOf(s)));
  const gaps: string[] = [];
  if (missing.length) gaps.push(`四格还缺 ${missing.map((s) => s.label).join('、')}——只跑了一部分`);
  if (input.drift && input.drift.blocksConclusion) gaps.push(`输入在快照之后变了：${input.drift.drift.join('；')}`);
  const verdict: string[] = [];
  const status: ExperimentStatus = {
    state: gaps.length ? '有缺口' : '可出结论',
    why: gaps.length ? gaps.join('；') : `四格齐、输入未变（快照 ${input.snapshot.hash}）：这一批数字可以当结论用`,
    cells,
    metrics: cells.map((c) => c.metric),
    verdict,
  };
  const trunc = truncationReport(input.events);
  if (trunc.rate === null) verdict.push(`⚠ ${trunc.why}`);
  else if (trunc.unknown) verdict.push(`⚠ 有 ${trunc.unknown} 段没有截断事实（未计入截断率分子分母）`);
  if (trunc.suspected) verdict.push(`⚠ 代理信号：${trunc.suspected} 段的响应看起来被切断（**代理指标，不是截断率本身**）`);
  for (const g of gaps) verdict.push(`⚠ ${g}——结论先别下。`);
  verdict.push(...surplusVerdict(cells));
  return status;
}

const surplusVerdict = (cells: CellRunRecord[]): string[] =>
  cells.filter((c) => c.metric.firstFallback > 0).map((c) => `⚠「${c.metric.label}」有 ${c.metric.firstFallback} 段缺首轮响应：该格生成覆盖率会被高估。`);

export interface MetricValue {
  available: boolean;
  /** 不可用时是 null —— 调用方必须先看 `available`，否则会拿到一个像 0 的坑 */
  value: number | null;
  unit: '比例' | '百分点' | '元' | '次';
  why: string;
}

/**
 * 取某个结论的数。**没跑 → available:false + value:null**。
 * 这是"诚实降级"的落点：任何报表想印一个数，先得通过这里，
 * 于是它不可能把"没跑"印成 0。（范式照抄 `productmetrics.ts` 的"算不出来就说算不出来"。）
 */
export function metricValue(status: ExperimentStatus, cell: string, metric: MetricName): MetricValue {
  const unitOf = (m: MetricName): MetricValue['unit'] => (m === '成本' ? '元' : m === '生成覆盖率' || m === '最终覆盖率' || m === '重复注释率' || m === '人工修订率' || m === '截断率' ? '比例' : '次');
  const unit = unitOf(metric);
  const miss = (why: string): MetricValue => ({ available: false, value: null, unit, why });
  if (status.state === '未跑') return miss(status.why);
  if (status.state === '有缺口') return miss(status.why);
  const rec = status.cells.find((c) => c.cell === cell);
  if (!rec) return miss(`格「${cell}」这次没跑：没有它的原始事件`);
  // 一段都没落盘时，"覆盖率"没有分母：算出来的 100% 是"没交付"而不是"注全了"。
  // 人工修订率与成本不受影响（它们的口径不依赖落盘正文），照常给。
  if (rec.metric.segments > 0 && rec.metric.finalSegments === 0 && (metric === '生成覆盖率' || metric === '最终覆盖率' || metric === '重复注释率')) {
    return miss(`本格 ${rec.metric.segments} 段全部进人工队列、0 段落盘：${metric}没有分母，算不出来（**不是 100%，也不是 0**）`);
  }
  switch (metric) {
    case '生成覆盖率':
      return { available: true, value: rec.metric.genCoverage, unit, why: `${rec.metric.segments} 段首轮响应` };
    case '最终覆盖率':
      return { available: true, value: rec.metric.finalCoverage, unit, why: `${rec.metric.segments} 段落盘产物` };
    case '重复注释率':
      return { available: true, value: rec.metric.duplicateRate, unit, why: `${rec.metric.words} 词` };
    case '人工修订率':
      return { available: true, value: rec.metric.manualRate, unit, why: `${rec.needsReview}/${rec.metric.segments} 段未过门禁` };
    case '成本':
      return { available: true, value: rec.metric.cost, unit, why: `${rec.metric.calls} 次调用（用量来源：${rec.usageSource}）` };
    case '截断率':
      return rec.truncation.rate === null ? miss(rec.truncation.why) : { available: true, value: rec.truncation.rate, unit, why: rec.truncation.why };
    default:
      return miss(`「${String(metric)}」没有派生路径`);
  }
}

/** 报告抬头那几行：状态 + 原因 + 提示（谁都能一眼看出"这批数到底算不算数"） */
export function statusLines(status: ExperimentStatus): string[] {
  const head = status.state === '可出结论' ? `**状态**：${status.state}` : `**状态**：${status.state} ⚠`;
  return [head, `**为什么**：${status.why}`, ...status.verdict.map((v) => `- ${v}`)];
}
