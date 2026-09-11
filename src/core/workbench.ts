// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，本仓库已部署版权验证体系，细节不予公开（docs/版权与授权.md）。
/**
 * LayerText · 任务工作台（《LayerText工程优化总计划》阶段 2）
 *
 * 计划原文：「把风险组扩展为『任务工作台』：按同一词、同一段规则、同章类型聚合；
 *   显示影响范围、三条代表样本、批量动作预览；保留逐条入口。
 *   **增加今日任务、暂停并恢复、已判记录和变更历史**。」
 *
 * 分工：聚合、代表样本与批量预览在 `riskqueue.ts`（阶段 2 的前半已经做完，本模块**不重做**）；
 * 本模块补的是**教师这一侧的状态**——教师不是一次坐到底的，他会：
 *   · 停下手里的活（暂停），过一会儿再回来（恢复）——回来必须是**同一批任务**；
 *   · 想知道"今天到哪儿了"，而系统手里只有队列和决定时间戳（今日任务）；
 *   · 想回看"这一条我改过几次、每次改成什么"（变更历史，不只是最新一条）；
 *   · 连着点了三次撤销之后，还得说得清现在算什么（可解释性）。
 *
 * 纯逻辑：**无 fs、无 DOM、无时间副作用**。「现在几点」一律由调用方传进来——
 * 这一条不是洁癖：验收要的是"10 分钟后回来还是同一状态"，如果模块自己取系统时间，
 * 那个断言就只能靠 sleep 来写，测起来是假绿。
 */

import { DECISION_LABEL, type DecisionEvent, type DecisionKind } from './decision.js';
import { SESSION_OPEN } from './productmetrics.js';
import { groupQueue, sessionState, type GroupOptions, type RiskItem } from './riskqueue.js';

/* 小工具：时间一律由调用方传进来（`opts.now`），这里只做"把时间说成人话"，不产生时间。 */
const toIso = (at: string | Date): string => (at instanceof Date ? at.toISOString() : at);

/** 事件时间戳属于哪一天。**用本机本地日**（教师说的"今天"是他墙上的日历，不是 UTC 日）。
 *  取不到（时间戳是坏的）就返回空串——空串与任何一天都不相等，**不会**被算成"今天"。 */
export function dayOf(at: string | Date): string {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ─────────────── §一 判定语义：什么算"这条已经办完了" ─────────────── */

/**
 * 终态四类。⚠ `rejected`（**动作没执行成**）**不在其中**：它是"系统没做成"，
 * 不是"教师判过了"。把它算成已决，就会出现最坏的那种两头空——
 * **卡片消失了、正文也没变**，而教师以为这件事已经办完。
 *
 * 这张表和下面这四行判定原来是 `app/src/risk.ts` 里私有的。工作台（引擎侧）也要回答
 * "还剩什么、本次完成没有"，于是**下沉到这里一份**，App 那份改为转出。
 * 理由与 `subjectOf` 当初下沉同源：**面板与引擎对"待办"的口径必须是同一份**，
 * 两份就会有一天分成两半——而"暂停 10 分钟后还是同一状态"这句话，
 * 靠的正是"待办"只有一个定义。
 */
export const TERMINAL_KINDS: DecisionKind[] = ['accept', 'reject', 'false-positive', 'edit'];

/** 撤销指针：`itemId + '@' + timestamp`（同一个项可以被改主意多次，要指得准） */
export const eventRef = (e: DecisionEvent): string => `${e.itemId}@${e.timestamp}`;

/** 被撤销事件指向过的那些事件（`undoOf` 指过的）。撤销**不删历史**，只是让它不算数。 */
export function undoneEventRefs(events: DecisionEvent[]): Set<string> {
  const out = new Set<string>();
  for (const e of events) if (e.decision === 'undo' && e.undoOf) out.add(e.undoOf);
  return out;
}

/** 每个项的最新一条**决定**（忽略 `undo`——它不是决定，是作废指令）。
 *  `<=` 而不是 `<`：同一时间戳的后写者胜，与 `decision.ts` 的 `decisionIndex` 同一口径。 */
export function latestDecisionMap(events: DecisionEvent[]): Map<string, DecisionEvent> {
  const m = new Map<string, DecisionEvent>();
  for (const e of events) {
    if (e.decision === 'undo') continue;
    const prev = m.get(e.itemId);
    if (!prev || prev.timestamp <= e.timestamp) m.set(e.itemId, e);
  }
  return m;
}

/**
 * 这个项当前算不算"处理完了"：
 *   · 取**最新一条决定**；
 *   · 它属于终态四类、**且没有被撤销** → 算处理完；
 *   · **被撤销 = 整条作废，项回到待办**（教师改主意是常态，界面得让他回得来）。
 *
 * 为什么不做"回退到更早的那条"：那要教师理解一个多级撤销栈，而他心里只有
 * "我刚才点错了，撤销一下"。界面上的撤销键也长在最新那条上——单级撤销与界面一致。
 * 计划里那句「撤销连续发生三次时状态仍可解释（**若实测需要多级，再升级为版本树**）」
 * 就是拿这条规则去实测：三条撤销连着来，状态还说得清，就不必上版本树。见 §五。
 */
export const isSettled = (d: DecisionEvent | undefined, undone?: Set<string>): boolean => d !== undefined && TERMINAL_KINDS.includes(d.decision) && !(undone?.has(eventRef(d)) ?? false);

/** 队列里还有哪些没被处理完（处理完的从待办里消失，但历史事件一条不删） */
export function pendingOf(items: RiskItem[], events: DecisionEvent[]): RiskItem[] {
  const decided = latestDecisionMap(events);
  const undone = undoneEventRefs(events);
  return items.filter((it) => !isSettled(decided.get(it.id), undone));
}

/** 「打开队列」这类**伪事件**：它们记的是会话，不是"教师就某条队列项做的决定"。
 *  任何按项聚合的统计都要把它们挡在外面，否则会凭空多出一个叫 `session-open` 的项。 */
export const isPseudoEvent = (e: DecisionEvent): boolean => e.itemId === SESSION_OPEN;

/* ─────────────── §一之二 任务状态：一句话说清"现在要办什么" ─────────────── */

export interface PendingRef {
  id: string;
  /** 人话标签（`第一章 第3段 · 原文的「1911」在改写里找不到`），界面与差异说明直接用 */
  label: string;
}

export interface GroupRef {
  id: string;
  title: string;
  count: number;
}

/**
 * **任务状态**——"暂停/恢复回到同一任务状态"里的那个"状态"，就是它。
 * 它是 (队列 + 决定日志) 的**纯函数**，不含任何时间项、不含任何缓存。
 *
 * 它由三件事定义（验收里的"同一任务状态"就是这三件事全等）：
 *   ① 待办集合（哪些条目还没办）——含顺序；
 *   ② 任务组与组顺序（由待办 + 聚合规则唯一决定）；
 *   ③ 「本次完成」的判据（`done`，只看"还有没有未处理的条目"，不看估时）。
 */
export interface TaskState {
  pending: PendingRef[];
  pendingIds: string[];
  groups: GroupRef[];
  groupIds: string[];
  done: boolean;
  /** 「本次完成」那句话（界面直接显示；判据只有 `done` 一个） */
  sessionText: string;
  /** 队列总条数（分母，用来显示"70 条里还剩几条"） */
  total: number;
}

export function taskStateOf(items: RiskItem[], events: DecisionEvent[], opts: GroupOptions = {}): TaskState {
  const left = pendingOf(items, events);
  const groups = groupQueue(left, opts);
  const session = sessionState(left, groups);
  return {
    pending: left.map((it) => ({ id: it.id, label: `${it.segLabel} · ${it.title}` })),
    pendingIds: left.map((it) => it.id),
    groups: groups.map((g) => ({ id: g.id, title: g.title, count: g.count })),
    groupIds: groups.map((g) => g.id),
    done: session.done,
    sessionText: session.text,
    total: items.length,
  };
}

/** 差异说明里最多列几条（列多了没人看，列少了又不知道变了什么——3 条 + 一个总数） */
const sample = (xs: string[], max = 3): string => xs.slice(0, max).join('；') + (xs.length > max ? ` …等 ${xs.length} 条` : '');

/**
 * 两份任务状态差在哪儿。**空数组 = 一模一样**（这才是"回到同一任务状态"的定义）。
 * 逐个说清差在哪一类，而不是笼统地报一句"变了"——教师要据此决定要不要重看一遍。
 */
export function diffTaskState(before: TaskState, after: TaskState): string[] {
  const out: string[] = [];
  const b = new Set(before.pendingIds);
  const a = new Set(after.pendingIds);
  const added = after.pending.filter((p) => !b.has(p.id));
  const gone = before.pending.filter((p) => !a.has(p.id));
  if (added.length) out.push(`待办多出 ${added.length} 条：${sample(added.map((p) => p.label))}`);
  if (gone.length) out.push(`待办少了 ${gone.length} 条：${sample(gone.map((p) => p.label))}`);
  if (!added.length && !gone.length && before.pendingIds.join('\u0001') !== after.pendingIds.join('\u0001')) out.push('待办条数没变但顺序变了（队列换了一版？）');
  if (before.groupIds.join('\u0001') !== after.groupIds.join('\u0001')) out.push(`任务组从 ${before.groupIds.length} 组变成 ${after.groupIds.length} 组（聚合结果变了）`);
  if (before.done !== after.done) out.push(`「本次完成」从「${before.done ? '已完成' : '还没完'}」变成「${after.done ? '已完成' : '还没完'}」`);
  return out;
}

/* ─────────────── §二 暂停 / 恢复 ─────────────── */

export const WORKBENCH_SCHEMA_VERSION = 1;

/**
 * 暂停点记在**与决定日志并列的另一本 append-only 账**里，**不进决定日志**。
 *
 * 为什么不塞进决定日志（那里明明已经有 `rejected` / `undo` 这类"不是决定"的事件了）：
 * 决定日志是**共享账本**。`tools/af_pipeline/LayerText_AF决定汇总.mjs` 会把整份日志
 * 交给 `summarizeDecisions` / `productMetrics` / `contestedItems`。而「暂停」不是
 * "教师就某条队列项做的决定"，一旦混进去：
 *   · 误报率、撤销率、执行失败率的分母全被暂停事件挤占，"前 10 次操作"的切分也跟着偏——
 *     而那正是阶段 2 验收里「产品指标应直接来自 productmetrics.ts」指着的那几个数；
 *   · `contestedItems` 会把 `session-pause` 当成一个"反复改主意"的队列项报出来。
 * 这些消费方**不在本次改动的文件范围内**，改不动也验证不了。所以宁可多一本小账，
 * 也不让共享账本上多一个"所有消费方都必须记得过滤"的事件类型——
 * 那正是这个仓库反复吃过的亏：口径漂移从来不是因为谁写错了，而是因为**两处各写一份**。
 *
 * 判据很简单：**谁要读它，就放进谁读的那本账**。暂停只有工作台自己读。
 */
export interface WorkbenchMarker {
  schemaVersion: number;
  kind: 'pause' | 'resume';
  teacherId: string;
  timestamp: string;
  /** 停在哪一版队列（队列产物的内容哈希）。换了队列就不再是同一批任务 */
  sourceVersion: string;
  tier?: string;
  /**
   * 停下的那一刻还欠的活（有序 itemId）。
   * ⚠ **这是指纹，不是状态的定义**。规矩只有一条，写在这里免得日后有人图省事：
   *   · 恢复时**先现算**（队列 + 决定日志），再拿这份指纹**比对**；
   *   · **任何地方都不许**把 `marker.pending` 当成"现在还要办什么"直接渲染。
   * 为什么不做成"快照文件 + 读快照"：那等于把同一个事实存两份（日志一份、快照一份），
   * 两份就会分叉，而分叉时**没有任何东西会报错**——教师会看到一份早已过期的待办，
   * 还以为是新的。存成指纹就没有这个问题：它对不上时唯一的后果是"我们**知道**它对不上"，
   * 于是可以如实告诉教师"你暂停之后有人动过"。
   */
  pending: string[];
  /** 指纹摘要（12 位十六进制）。给人一眼看"变没变"，给日志一眼对得上 */
  pendingDigest: string;
  /** 暂停那一刻的**组顺序**（组 ID）。同样是指纹：它是用来发现"聚合规则换了"的，
   *  不参与状态计算。待办一样而组不一样，说明分组的代码变了——那也不叫"同一任务状态"。 */
  groups: string[];
  /** 暂停时屏幕上那一条（回来先看他；它已经不在待办里就退回第一条，并说明） */
  cursor?: string;
  /** 教师自己写的一句"我为什么停在这儿"（可选） */
  note?: string;
}

/** 稳定短摘要。做法与 `decision.ts` 的 `eventIdOf` 同一套（不引依赖、稳定、短），
 *  但**不复用它的实现**：那个是对 (itemId, decision, teacherId, timestamp) 定 ID 的，
 *  语义不同，共用一个函数只会让以后改其中一边时误伤另一边。 */
export function digestOf(parts: string[]): string {
  const s = parts.join('\u0001');
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
  }
  h2 = Math.imul(h2 ^ (h1 >>> 13), 0xc2b2ae35) >>> 0;
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 12);
}

export interface WorkbenchMarkerInput {
  teacherId: string;
  sourceVersion: string;
  tier?: string;
  /** 暂停那一刻现算出来的任务状态（指纹从它上面取） */
  state: TaskState;
  timestamp?: string;
  cursor?: string;
  note?: string;
}

/** 造一条暂停点。时间戳只在缺省时生成（测试要确定性，与 `makeDecisionEvent` 同一约定）。 */
export function pauseMarker(input: WorkbenchMarkerInput): WorkbenchMarker {
  if (!input.teacherId) throw new Error('暂停点必须有 teacherId——否则多教师并行时无法审计');
  return {
    schemaVersion: WORKBENCH_SCHEMA_VERSION,
    kind: 'pause',
    teacherId: input.teacherId,
    timestamp: input.timestamp ?? new Date().toISOString(),
    sourceVersion: input.sourceVersion,
    tier: input.tier,
    pending: [...input.state.pendingIds],
    pendingDigest: digestOf(input.state.pendingIds),
    groups: [...input.state.groupIds],
    cursor: input.cursor,
    note: input.note,
  };
}

/** 造一条恢复点。**恢复也留痕**，而且同样带上当时的指纹——这样这本账自己就能回答
 *  "那次暂停重新打开时到底一样不一样"，不必回头再算一遍（算得出来，但账上直接有更好查）。 */
export function resumeMarker(input: WorkbenchMarkerInput): WorkbenchMarker {
  return { ...pauseMarker(input), kind: 'resume' };
}

export interface ParsedWorkbench {
  markers: WorkbenchMarker[];
  /** 坏行数——**不静默丢**：一条坏行不该让整份账不可读，但必须报出来 */
  badLines: number;
}

export function parseWorkbenchLog(text: string): ParsedWorkbench {
  const markers: WorkbenchMarker[] = [];
  let badLines = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as WorkbenchMarker;
      if (!o || (o.kind !== 'pause' && o.kind !== 'resume') || typeof o.timestamp !== 'string') {
        badLines++;
        continue;
      }
      markers.push({ ...o, pending: Array.isArray(o.pending) ? o.pending : [], groups: Array.isArray(o.groups) ? o.groups : [] });
    } catch {
      badLines++;
    }
  }
  return { markers, badLines };
}

export const toWorkbenchLine = (m: WorkbenchMarker): string => JSON.stringify(m) + '\n';

/** 当前有没有生效的暂停点：最后一次标记是 `pause` 才算（`resume` 之后就不算了）。 */
export function currentPause(markers: WorkbenchMarker[]): WorkbenchMarker | null {
  const last = markers.length ? markers[markers.length - 1] : null;
  return last && last.kind === 'pause' ? last : null;
}

/**
 * 暂停点与"现在现算出来的状态"比对：**空数组 = 一模一样**。
 *
 * 比的是 §一之二 定义的三件事。第三件（组）必须**分开报**，不能被"待办没变"盖过去：
 * 待办一样而组不一样，意味着聚合规则在两次打开之间改过——教师看到的分组变了，
 * 那就不该说"回到同一任务状态"。
 * `items` 可选：给了才能把"已经不在待办里的那几条"也写成**人话标签**（而不是只甩一个 ID）——
 * 教师看不懂 ID，而"变了哪几条"正是他要判断"要不要重看一遍"的依据。
 */
export function pausedDrift(marker: WorkbenchMarker, state: TaskState, items: RiskItem[] = []): string[] {
  const out: string[] = [];
  const b = new Set(marker.pending);
  const a = new Set(state.pendingIds);
  const added = state.pendingIds.filter((id) => !b.has(id));
  const gone = marker.pending.filter((id) => !a.has(id));
  const labelOf = (id: string): string => {
    const it = items.find((x) => x.id === id);
    return it ? `${it.segLabel} · ${it.title}` : id;
  };
  if (added.length) out.push(`暂停之后多出 ${added.length} 条待办：${sample(added.map(labelOf))}`);
  if (gone.length) out.push(`暂停之后少了 ${gone.length} 条待办：${sample(gone.map(labelOf))}`);
  if (!added.length && !gone.length && marker.pending.join('\u0001') !== state.pendingIds.join('\u0001')) out.push('待办条数没变但顺序变了（队列换了一版？）');
  if (marker.groups.join('\u0001') !== state.groupIds.join('\u0001')) out.push(`任务组从 ${marker.groups.length} 组变成 ${state.groupIds.length} 组（聚合结果变了）`);
  const wasDone = marker.pending.length === 0;
  if (wasDone !== state.done) out.push(`「本次完成」从「${wasDone ? '已完成' : '还没完'}」变成「${state.done ? '已完成' : '还没完'}」`);
  return out;
}

/** 间隔说人话。**它只用来"说"，从来不参与"判"**——见 `resumeCheck` 的注释。 */
export function formatGap(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '刚停下';
  const min = ms / 60000;
  if (min < 1) return '不到 1 分钟';
  if (min < 90) return `${min.toFixed(1)} 分钟`;
  const hour = min / 60;
  if (hour < 36) return `${hour.toFixed(1)} 小时`;
  return `${(hour / 24).toFixed(1)} 天`;
}

export interface ResumeCheck {
  /** 现在有没有生效的暂停点 */
  paused: boolean;
  marker: WorkbenchMarker | null;
  /** 重新打开时**现算**出来的状态（永远现算，永不读快照） */
  state: TaskState;
  /** 与暂停那一刻比，三件事是否全等。
   *  ⚠ **没有暂停点时恒为 true**（空真：没有比对的对象，就谈不上"不一样"）。
   *  判断"现在是不是停着"请看 `paused`，别只看这一个布尔。 */
  sameAsPaused: boolean;
  /** 变了什么（空 = 一模一样） */
  drift: string[];
  /** 停了多久（毫秒；没有暂停点为 null）。**只用于说明** */
  gapMs: number | null;
  /** 一句话，直接进界面 */
  text: string;
  /** 回来先看哪一条：暂停时的 `cursor` 若还在待办里就给它，否则退回第一条并说明 */
  cursor?: RiskItem;
  /** `cursor` 找不到时的说明（空串 = 不用说明） */
  cursorNote: string;
}

/**
 * 重新打开：**先把状态现算出来，再跟暂停点比**。
 *
 * ── 计划里那句「教师可在 10 分钟后暂停，重新打开仍回到同一任务状态」 ──
 * 落到代码上只有一条性质：**任务状态不随时间变**。所以：
 *   · `gapMs` 只用来**说**（"你停了 10.0 分钟"），从来不参与**判**；
 *   · 停 10 分钟、10 小时、10 天回来看，`state` 一模一样——因为 `state` 是
 *     (队列 + 决定日志) 的纯函数，里面没有任何一项与"现在几点"有关。
 *     测试里两种量级的间隔都断言（10 分钟与 26 小时），专门钉住这一点。
 *
 * ── 故意**不钉**的东西（钉了反而会假报"状态变了"）──
 *   · 估时分钟数（`MINUTES_PER_ITEM` 那套）：它是**后台估算，不是任务模型**
 *     （第三十批已把"一小时路径"降级为折叠区），拿它当任务状态就是把估算当任务；
 *   · "今天 / 昨天"：跨零点不该让同一个状态变成两个状态；
 *   · 未完成段落数、运行身份、路径布局：它们描述的是**稿子与运行**，不是"我还要办哪些条"；
 *   · 界面上滚到哪儿、展开了哪一组：那是浏览器状态。`cursor` 只是"回来先给你看哪一条"的
 *     便利，**不参与**状态判定——它丢了或指向已经办完的条目，都不会让状态变成"不一样"。
 */
export function resumeCheck(items: RiskItem[], events: DecisionEvent[], markers: WorkbenchMarker[], opts: { now?: string | Date; groups?: GroupOptions } = {}): ResumeCheck {
  const state = taskStateOf(items, events, opts.groups);
  const marker = currentPause(markers);
  const nowIso = toIso(opts.now ?? new Date());
  const cursor = marker?.cursor ? items.find((it) => it.id === marker.cursor) : undefined;
  if (!marker) {
    return {
      paused: false,
      marker: null,
      state,
      sameAsPaused: true,
      drift: [],
      gapMs: null,
      text: `没有暂停点（这次没按过暂停）——任务状态是现算的：${state.sessionText}`,
      cursor: state.pending.length ? items.find((it) => it.id === state.pending[0]!.id) : undefined,
      cursorNote: '',
    };
  }
  const drift = pausedDrift(marker, state, items);
  const gapMs = Date.parse(nowIso) - Date.parse(marker.timestamp);
  const same = drift.length === 0;
  const gap = formatGap(gapMs);
  const cursorNote = !marker.cursor
    ? ''
    : cursor
      ? state.pending.some((p) => p.id === cursor.id)
        ? ''
        : `暂停时你停在「${cursor.segLabel}」，但它已经办完了——下面从第一条还没办的开始`
      : `暂停时你停在「${marker.cursor}」，这一条已经不在本轮队列里了（队列换过版？）`;
  return {
    paused: true,
    marker,
    state,
    sameAsPaused: same,
    drift,
    gapMs,
    text: same ? `你停在 ${marker.timestamp}（${gap}前），任务状态一模一样：${state.sessionText}` : `你停在 ${marker.timestamp}（${gap}前），但任务状态变了：${drift.join('；')}`,
    cursor: cursor ?? (state.pending.length ? items.find((it) => it.id === state.pending[0]!.id) : undefined),
    cursorNote,
  };
}

/* ─────────────── §三 今日任务 ─────────────── */

/** 「今日任务」它**不是**什么——界面与报告共用这同一句，免得两边各写各的。 */
export const TODAY_DISCLAIMER =
  '「今日任务」是从队列 + 决定时间戳现算的：今天开工时欠着多少、今天办成多少、现在还剩多少。它不是日历、不是截止时间，也不知道你今天有多少课时——所以它不说"今天该做 N 条"。';

export interface TodayRow {
  itemId: string;
  label: string;
  event: DecisionEvent;
  at: string;
}

export interface TodayTasks {
  /** 本地日（`2026-09-11`） */
  day: string;
  /** 今天第一次打开队列时欠着多少条。取自当天的 `session-open`；**取不到就是 null**（不猜、不拿当前待办冒充） */
  openedWithPending: number | null;
  /** 今天办成、且**现在仍然成立**的（判过又被撤销的不算） */
  done: TodayRow[];
  /** 今天动了却没办成的（动作执行失败）；它们仍在待办里 */
  failed: TodayRow[];
  /** 今天被撤销、回到待办的 */
  undoneBack: TodayRow[];
  /** 现在还剩多少条（= 当前待办，与任务状态同源） */
  remaining: RiskItem[];
  remainingGroups: number;
  text: string;
  disclaimer: string;
}

const todayLabelOf = (items: RiskItem[], id: string): string => {
  const it = items.find((x) => x.id === id);
  return it ? `${it.segLabel} · ${it.title}` : `${id}（不在本轮队列里）`;
};

/** `session-open` 的 reason 是唯一记着"打开时欠多少条"的地方（`productmetrics.ts` 里那一个字段，
 *  本次改动不碰它）。所以这里老实解析它；**解析不出来就给 null**，绝不拿"当前待办数"顶上——
 *  那会把一个回推值伪装成当时的记录。回推本身也不可靠："
 *  昨天判过、今天撤销又重判"这类序列会让回推算错。 */
const openedPendingOf = (e: DecisionEvent): number | null => {
  const m = /待办\s*(\d+)\s*条/.exec(e.reason ?? '');
  return m ? Number(m[1]) : null;
};

/**
 * 「今日任务」= 从队列 + 决定时间戳**现算**出来的三件事：
 *   ① 今天开工时欠着多少（当天的 `session-open` 记下的那个数）；
 *   ② 今天真正办成多少（**现在仍然成立**的终态决定）+ 今天没办成的（执行失败、被撤销回待办）；
 *   ③ 现在还剩多少。
 *
 * 它**不是**什么（这条与 `TODAY_DISCLAIMER` 是同一句话，写在这里免得日后有人把它升级成排期系统）：
 *   · 不是日历、不是截止时间——系统里根本没有"截止日期"这个字段；
 *   · 不是配额——它不知道教师今天有几节课、还剩多少精力；
 *   · 不是"今天新增的待办"——队列什么时候生成的，事件里没记（只能从 `session-open` 反推一次）。
 * 所以它只回答"今天动了多少、还剩多少"，**不回答"今天该做多少"**。
 *
 * 没有数据时**如实退化**：今天一条事件都没有 → `done` 为空、`openedWithPending` 为 null，
 * 文字直接说"今天还没有打开过队列的记录（这一项算不出来，不猜）"；队列本身也没有 →
 * 说"无从谈起（不是 0 条，是不知道）"，而不是给一个"今日 0 条"的假结论。
 */
export function todayTasks(items: RiskItem[], events: DecisionEvent[], opts: { now?: string | Date; groups?: GroupOptions } = {}): TodayTasks {
  const day = dayOf(opts.now ?? new Date());
  const decided = latestDecisionMap(events);
  const undone = undoneEventRefs(events);
  const todays = events.filter((e) => dayOf(e.timestamp) === day && day !== '');
  const opened = todays.find((e) => isPseudoEvent(e));
  const row = (itemId: string, event: DecisionEvent): TodayRow => ({ itemId, label: todayLabelOf(items, itemId), event, at: event.timestamp });

  const done: TodayRow[] = [];
  const failed: TodayRow[] = [];
  const undoneBack: TodayRow[] = [];
  for (const e of todays) {
    if (isPseudoEvent(e)) continue;
    if (e.decision === 'undo') {
      const target = events.find((x) => eventRef(x) === e.undoOf);
      const id = target?.itemId ?? e.itemId;
      if (!isSettled(decided.get(id), undone)) undoneBack.push(row(id, e));
      continue;
    }
    if (e.decision === 'rejected') {
      failed.push(row(e.itemId, e));
      continue;
    }
    /* "今天办成"= 这一条的**当前**定论就是今天这条事件定的。
     * 判过又被撤销、或者今天撤销完又重判到别的种类，都不该被算两次。 */
    const cur = decided.get(e.itemId);
    if (cur && cur.timestamp === e.timestamp && isSettled(cur, undone)) done.push(row(e.itemId, e));
  }

  const remaining = pendingOf(items, events);
  const remainingGroups = groupQueue(remaining, opts.groups ?? {}).length;
  const openedWithPending = opened ? openedPendingOf(opened) : null;

  const parts: string[] = [];
  if (!items.length && !todays.length) {
    return {
      day,
      openedWithPending: null,
      done: [],
      failed: [],
      undoneBack: [],
      remaining,
      remainingGroups,
      text: '今日任务：队列是空的、今天也没有任何动作——无从谈起（不是 0 条，是「不知道」）',
      disclaimer: TODAY_DISCLAIMER,
    };
  }
  parts.push(openedWithPending !== null ? `今天开工时欠 ${openedWithPending} 条` : '今天还没有打开过队列的记录（这一项算不出来，不猜）');
  parts.push(`今天办成 ${done.length} 条`);
  if (failed.length) parts.push(`没执行成 ${failed.length} 条`);
  if (undoneBack.length) parts.push(`撤销回待办 ${undoneBack.length} 条`);
  parts.push(`现在还剩 ${remaining.length} 条（${remainingGroups} 组）`);
  return {
    day,
    openedWithPending,
    done,
    failed,
    undoneBack,
    remaining,
    remainingGroups,
    text: `今日任务：${parts.join('｜')}`,
    disclaimer: TODAY_DISCLAIMER,
  };
}

/* ─────────────── §四 变更历史（历轮，而不是最新一条） ─────────────── */

/**
 * `decidedRows`（「看我判过的」）只给**最新一条**——那是"已判记录"要的。
 * 而"变更历史"问的是另一个问题：**这一条我一共动过几次、每次改成什么**。
 * 数据一直都在事件里（`before`/`after`/`undoOf`/`version`/`timestamp`），
 * 只是没人把它们按项串起来。这里串起来，**一round 一条**，撤销也占一轮——
 * 撤销是**新事件**，不是"那一轮从没发生过"。
 */
export interface HistoryRound {
  /** 第几轮（同一项内，1 起，按时间正序） */
  round: number;
  event: DecisionEvent;
  kind: 'decision' | 'undo';
  label: string;
  before: string;
  after: string;
  /** 这一轮产生（或回退到）的正文版本；纯表态的决定没有版本节点，为空 */
  version?: string;
  /** 这一轮是否已被撤销（撤销轮本身恒 false） */
  undone: boolean;
  /** 撤销这一轮的是第几轮 */
  undoneByRound?: number;
  /** 这一轮（撤销轮）作废的是第几轮 */
  undoesRound?: number;
  /** 这一轮的 before ≠ after（真的换了内容，而不是"标记误报"这种原样留痕） */
  changed: boolean;
}

export interface ItemHistory {
  itemId: string;
  /** 本轮队列里找不到它（队列换代了）时为 undefined——**不假装它还在** */
  item?: RiskItem;
  /** 按时间正序的**全部**轮次 */
  rounds: HistoryRound[];
  /** 现在算不算办完（含"被撤销 = 回到待办"） */
  settled: boolean;
  undoCount: number;
  /** 一句话（界面与报告用同一句） */
  text: string;
}

/** 按时间排好的事件（同刻按原顺序，与 `productmetrics` 的 `ordered` 同一口径：稳定、可复现）。 */
const orderedByTime = (events: DecisionEvent[]): DecisionEvent[] =>
  events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => Date.parse(a.e.timestamp) - Date.parse(b.e.timestamp) || a.i - b.i)
    .map((x) => x.e);

export function itemHistory(itemId: string, items: RiskItem[], events: DecisionEvent[]): ItemHistory {
  const mine = orderedByTime(events.filter((e) => e.itemId === itemId && !isPseudoEvent(e)));
  const refToRound = new Map<string, number>();
  const rounds: HistoryRound[] = mine.map((e, i) => {
    refToRound.set(eventRef(e), i + 1);
    return {
      round: i + 1,
      event: e,
      kind: e.decision === 'undo' ? 'undo' : 'decision',
      label: DECISION_LABEL[e.decision] ?? e.decision,
      before: e.before,
      after: e.after,
      version: e.version,
      undone: false,
      changed: e.before !== e.after,
    };
  });
  /* 连撤销指针要**等全部轮次建好**再连：撤销一定排在它作废的那一轮之后，
   * 但"之后"不代表"刚好挨着"（中间可以插别的轮），所以要靠 `undoOf` 指回去。 */
  for (const r of rounds) {
    if (r.kind !== 'undo' || !r.event.undoOf) continue;
    const t = refToRound.get(r.event.undoOf);
    if (!t) continue;
    r.undoesRound = t;
    rounds[t - 1]!.undone = true;
    rounds[t - 1]!.undoneByRound = r.round;
  }
  const decided = latestDecisionMap(events);
  const undone = undoneEventRefs(events);
  const settled = isSettled(decided.get(itemId), undone);
  const cur = decided.get(itemId);
  const chain = rounds.map((r) => (r.kind === 'undo' ? `撤销第${r.undoesRound ?? '?'}轮` : r.label)).join(' → ');
  return {
    itemId,
    item: items.find((x) => x.id === itemId),
    rounds,
    settled,
    undoCount: rounds.filter((r) => r.kind === 'undo').length,
    text: rounds.length ? `${itemId}：${rounds.length} 轮（${chain}），现在=${settled ? `已决·${DECISION_LABEL[cur!.decision] ?? cur!.decision}` : '待办'}` : `${itemId}：没有任何决定`,
  };
}

export function changeHistory(items: RiskItem[], events: DecisionEvent[]): Map<string, ItemHistory> {
  const ids = new Set<string>();
  for (const e of events) if (!isPseudoEvent(e)) ids.add(e.itemId);
  const m = new Map<string, ItemHistory>();
  for (const id of ids) {
    const h = itemHistory(id, items, events);
    if (h.rounds.length) m.set(id, h);
  }
  return m;
}

/**
 * 变更历史列表（按最近一条事件倒序）。
 * 它比「已判记录」**全**：已判记录只看最新一条，所以"已经不在本轮队列里"的项
 * （队列换代、被别的运行删掉）在那里根本不会出现；而历史必须显示它们——
 * 否则"我当时明明改过这一条"会变成查无此事。
 */
export function historyRows(items: RiskItem[], events: DecisionEvent[]): ItemHistory[] {
  return [...changeHistory(items, events).values()].sort((a, b) => {
    const la = a.rounds[a.rounds.length - 1]!.event.timestamp;
    const lb = b.rounds[b.rounds.length - 1]!.event.timestamp;
    return la < lb ? 1 : la > lb ? -1 : a.itemId < b.itemId ? -1 : 1;
  });
}

/* ─────────────── §五 撤销连着来三次，状态还得说得清 ─────────────── */

/**
 * **可解释**的定义（这是本模块对验收那句「撤销连续发生三次时状态仍可解释」的落点，
 * 定死在这里，别处不许各自解释一遍）：
 *
 *   对这个日志，能对**每一条队列项**给出：
 *     ① 现状——待办 / 已决·哪种 / 判过但被撤销（回到待办）；
 *     ② 这句话是**哪一条事件**定下来的；
 *     ③ 它经过几轮、被撤销过几次。
 *   并且日志里**每一条非伪事件都在解释里有归宿**：要么它自己是一轮，要么它是某一轮的撤销，
 *   要么被明确判为"空操作"（见 `noopUndos`）。做不到就不能说"可解释"——
 *   **宁可说"我解释不了"，也不给一个看起来像结论的猜测**。
 *
 * 为什么单级撤销够用（计划说"若实测需要多级，再升级为版本树"）：
 * 单级语义下"连续三次撤销"实际长成 `决定→撤销` 重复三轮——每轮撤销都指向它前面
 * 那条最新决定，三次撤销各作废一轮，指向互不重叠，所以现状仍然被**唯一一条**事件决定，
 * ① ② ③ 都答得出来。实测确实不需要版本树（见 `tests/workbench.test.ts`）。
 * 真正会说不清的不是"次数多"，而是**撤销指向撤销**（`undoOf` 指到一条 `undo` 上）：
 * 那在单级语义下是空操作，必须**说出来**，否则教师点了两下会以为生效了一次。
 */
export interface ItemExplanation {
  itemId: string;
  inQueue: boolean;
  /** 现状：`待办` / `已决·采纳` / `已决·采纳（已被撤销 → 回到待办）` */
  state: string;
  /** 现在这个状态由哪条事件定下（还没判过就为空） */
  decidedBy?: string;
  rounds: number;
  undos: number;
  line: string;
}

export interface StateExplanation {
  explainable: boolean;
  /** 一句话结论（直接进界面/报告） */
  line: string;
  items: ItemExplanation[];
  /** 既不是一轮、也不是撤销的事件（未知的 decision 取值）——非空即不可解释 */
  orphans: string[];
  /** 悬空指针：`undoOf` 指向日志里不存在的事件 */
  dangling: string[];
  /** 撤销指向撤销：按单级语义是空操作。它**不影响**可解释性，但必须被说出来 */
  noopUndos: string[];
  /** 逐条问题（人话） */
  problems: string[];
}

export function explainState(items: RiskItem[], events: DecisionEvent[]): StateExplanation {
  const real = events.filter((e) => !isPseudoEvent(e));
  const known = new Map<string, DecisionEvent>();
  for (const e of real) known.set(eventRef(e), e);

  /* 归类：每一条非伪事件要么是一轮决定、要么是一次撤销、要么**无法归类**。
   * "无法归类"是留给"以后新加了决定类型、而这里没跟上"的口子——它必须炸出来，
   * 不能默默跳过：默默跳过正是"日志里有一条谁也不认识的事件"那种最难查的故障。 */
  const orphans: string[] = [];
  const dangling: string[] = [];
  const noopUndos: string[] = [];
  for (const e of real) {
    if (e.decision === 'undo') {
      const target = e.undoOf ? known.get(e.undoOf) : undefined;
      if (!e.undoOf || !target) dangling.push(eventRef(e));
      else if (target.decision === 'undo') noopUndos.push(eventRef(e));
      continue;
    }
    if (!(e.decision in DECISION_LABEL)) orphans.push(`${eventRef(e)}（未知决定类型 ${e.decision}）`);
  }

  const decided = latestDecisionMap(events);
  const undone = undoneEventRefs(events);
  const inQueue = new Set(items.map((i) => i.id));
  const ids = [...new Set([...items.map((i) => i.id), ...real.map((e) => e.itemId)])];

  const itemsOut: ItemExplanation[] = ids.map((itemId) => {
    const mine = real.filter((e) => e.itemId === itemId);
    const d = decided.get(itemId);
    const undos = mine.filter((e) => e.decision === 'undo').length;
    const rounds = mine.length;
    const state = !d ? '待办（还没判过）' : isSettled(d, undone) ? `已决·${DECISION_LABEL[d.decision] ?? d.decision}` : `已决·${DECISION_LABEL[d.decision] ?? d.decision}（已被撤销 → 回到待办）`;
    const decidedBy = d ? `${DECISION_LABEL[d.decision] ?? d.decision}@${d.timestamp}` : undefined;
    return {
      itemId,
      inQueue: inQueue.has(itemId),
      state: inQueue.has(itemId) ? state : `${state}（不在本轮队列里）`,
      decidedBy,
      rounds,
      undos,
      line: !d ? `${itemId}：${state}，${rounds} 条事件全是撤销（没有一条决定）` : `${itemId}：${state}，由 ${decidedBy} 定下；共 ${rounds} 轮、撤销 ${undos} 次，历史一条未删`,
    };
  });

  const problems: string[] = [];
  if (orphans.length) problems.push(`${orphans.length} 条事件无法归类（既不是决定也不是撤销）：${sample(orphans)}`);
  if (dangling.length) problems.push(`${dangling.length} 条撤销指向了不存在的事件（悬空指针，撤销没生效）：${sample(dangling)}`);
  if (noopUndos.length) problems.push(`${noopUndos.length} 条撤销指向的是「撤销事件」本身——按单级撤销语义这是空操作，状态没有任何变化：${sample(noopUndos)}`);
  const settledCount = itemsOut.filter((x) => x.state.startsWith('已决·') && !x.state.includes('已被撤销')).length;
  const backToPending = itemsOut.filter((x) => x.state.includes('已被撤销')).length;
  const explainable = !orphans.length && !dangling.length;
  return {
    explainable,
    line:
      `${explainable ? '✓ 状态可解释' : '⚠ 状态说不清'}：${itemsOut.length} 项（已决 ${settledCount}、撤销回待办 ${backToPending}、其余待办）；` +
      `日志 ${real.length} 条事件——${real.filter((e) => e.decision === 'undo').length} 次撤销、${real.filter((e) => e.decision === 'rejected').length} 次执行失败，` +
      `每一条都能说清"是哪一项的哪一轮、被谁作废"${problems.length ? `；${problems.join('；')}` : ''}`,
    items: itemsOut,
    orphans,
    dangling,
    noopUndos,
    problems,
  };
}

/**
 * 把日志截到"第 n 次撤销之后"，给出现在算什么，并**一句话**说清。
 * 这不是"模拟撤销"——是**按日志重放**：日志本身就是事实，
 * "撤销了三次之后的状态"就是"前三条撤销及其之前的事件"算出来的状态。
 */
export function stateAfterUndos(items: RiskItem[], events: DecisionEvent[], n: number, opts: GroupOptions = {}): { state: TaskState; explanation: StateExplanation; line: string } {
  const ordered = orderedByTime(events);
  let seen = 0;
  let cut = ordered.length;
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i]!.decision === 'undo') {
      seen++;
      if (seen === n) {
        cut = i + 1;
        break;
      }
    }
  }
  const prefix = ordered.slice(0, cut);
  const explanation = explainState(items, prefix);
  return { state: taskStateOf(items, prefix, opts), explanation, line: `第 ${n} 次撤销之后：${explanation.line}` };
}

/** 日志里一共撤销了多少次（含空操作） */
export const undoCountOf = (events: DecisionEvent[]): number => events.filter((e) => e.decision === 'undo').length;
