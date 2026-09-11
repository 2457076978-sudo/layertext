/**
 * 风险队列面板（纯逻辑 + 可注入 IO）
 *
 * 审查报告 §一 指出的流程缺陷：「`report.ts` 已有候选数据，但当前阅读器仍按段顺序呈现，
 * 这是流程缺陷。」人工校正不该是"从第一段读到第 245 段"，而该是"只看机器点名的地方"。
 *
 * 分工：
 *   `src/core/riskqueue.ts`   —— 排序与展开（引擎侧，管线跑完就把队列写成 JSON）
 *   `src/core/decision.ts`    —— 教师决定的不可变事件
 *   本文件                    —— 把队列 + 决定渲染成一屏能直接做的事，并把决定写回事件日志
 *
 * IO 注入与 datapanel 同一套路：纯逻辑（解析/排序/决定行）在 node 下可直接测，不必启动 App。
 */

import { buildProposals, makeDecisionEvent, parseDecisionLog, summarizeDecisions, toDecisionLine, type DecisionEvent, type DecisionKind } from '../../src/core/decision.js';
import { makeResolver, type Layout } from '../../src/core/manifest.js';
import { parseDictCsv } from '../../src/core/dictmerge.js';
import { parseDoc } from '../../src/core/docast.js';
import { plotLine } from '../../src/core/plotweight.js';
import { POSITIONING_LINE } from '../../src/core/positioning.js';
import { DECISION_LABEL } from '../../src/core/decision.js';
import { productMetrics, sessionOpenEvent } from '../../src/core/productmetrics.js';
import { actionOf, applyAction, failureText, type RuleAction } from '../../src/core/riskaction.js';
/** 有确定性动作的规则（批量应用只在这几类上给） */
const MUTATING_RULES = ['ANNO-01', 'ANNO-02', 'ANNO-03', 'AST-02'];
import {
  batchImpact,
  groupQueue,
  sessionState,
  subjectOf,
  type RiskItem,
  type RiskQueue,
  type TaskGroup,
} from '../../src/core/riskqueue.js';
import { oneHourPlan } from '../../src/core/riskqueue.js';
import { GATE_RULES, type GateCategory } from '../../src/core/segmentgate.js';

export interface RiskIo {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  listDir(dir: string): Promise<string[]>;
  exists?(path: string): Promise<boolean>;
  /** 改稿前备份（可选）。给了就先备份再写——**不可逆的操作不该没有退路**。 */
  backup?(path: string, content: string): Promise<void>;
}

let io: RiskIo | null = null;
/** 测试/替换用（与 datapanel.setIo 同一约定） */
export function setRiskIo(next: RiskIo | null): void {
  io = next;
}

export const TAGS: Record<string, string> = { A: 'A层85', M: 'M层75', B: 'B层60' };

/* ────────────────────── 纯逻辑 ────────────────────── */

/** 队列 JSON 的最小结构（管线写的那份） */
export interface RiskQueueFile {
  schemaVersion: number;
  书名?: string;
  层级: string[];
  章节: number[];
  摘要: RiskQueue['summary'];
  一小时路径?: { 预算: number; 超预算: boolean; 建议: string; 阶段: { id: string; title: string; budget: number; count: number; note: string }[] };
  未完成段落?: { tier: string; chapter: string; segId: string; segIndex: number; source: string }[];
  /** 章 → 产物绝对路径（风险队列脚本写的）。面板按它改稿，**不猜命名** */
  章节产物?: Record<string, string>;
  队列: RiskItem[];
}

export function parseQueueFile(text: string): RiskQueueFile | null {
  try {
    const o = JSON.parse(text) as RiskQueueFile;
    if (!o || !Array.isArray(o.队列)) return null;
    return o;
  } catch {
    return null;
  }
}

/**
 * 哪些决定算"这条已经处理完了"。
 *
 * ⚠ `rejected`（**动作没执行成**）**不算**——它是"系统没做成"，不是"教师判过了"。
 * 把它也算成已决，就会出现最坏的那种两头空：**卡片消失了、正文也没变**，
 * 而教师以为这件事已经办完（v4 方向明确要求"失败时不得让卡片消失"）。
 */
export const TERMINAL_DECISIONS: DecisionKind[] = ['accept', 'reject', 'false-positive', 'edit'];

/** 撤销指针：`itemId + '@' + timestamp`（同一个项可以被改主意多次，要指得准） */
export const refOf = (e: DecisionEvent): string => `${e.itemId}@${e.timestamp}`;

/** 已被撤销的引用集合（`undoOf` 指过的）。
 *  被撤销的项**回到待办**——这是"撤销不是删历史"在判定上的落点。 */
export function undoneRefs(events: DecisionEvent[]): Set<string> {
  const out = new Set<string>();
  for (const e of events) if (e.decision === 'undo' && e.undoOf) out.add(e.undoOf);
  return out;
}

/**
 * 一个项当前算不算"处理完了"。语义定死在这儿，界面与统计都从这儿取：
 *
 *   · 取**最新一条**决定（`undo` 本身不算决定，它只是把某条作废）；
 *   · 它属于终态四类、**且没有被撤销** → 算处理完；
 *   · **被撤销 = 整条作废，项回到待办**。
 *
 * 为什么不做"回退到更早的那条"：那要教师理解一个多级撤销栈，
 * 而他心里只有"我刚才点错了，撤销一下"。界面上的撤销键也长在最新那条上——
 * 单级撤销与界面一致，多级回退只会让"现在到底算什么状态"变得说不清。
 */
const isResolved = (d: DecisionEvent | undefined, undone?: Set<string>): boolean =>
  d !== undefined && TERMINAL_DECISIONS.includes(d.decision) && !(undone?.has(refOf(d)) ?? false);

/** 队列里还有哪些没被处理完（处理完的从待办里消失，但历史事件一条不删） */
/** 每个项的最新一条**决定**（忽略 `undo`——它不是决定，是作废指令） */
export function latestDecisions(events: DecisionEvent[]): Map<string, DecisionEvent> {
  const m = new Map<string, DecisionEvent>();
  for (const e of events) {
    if (e.decision === 'undo') continue;
    const prev = m.get(e.itemId);
    if (!prev || prev.timestamp <= e.timestamp) m.set(e.itemId, e);
  }
  return m;
}

export function pendingItems(file: RiskQueueFile, events: DecisionEvent[]): RiskItem[] {
  const decided = latestDecisions(events);
  const undone = undoneRefs(events);
  return file.队列.filter((it) => !isResolved(decided.get(it.id), undone));
}

/** 「看我判过的」：按时间倒序的已处理项（含被撤销的），供教师回头改主意 */
export interface DecidedRow {
  item: RiskItem;
  event: DecisionEvent;
  label: string;
  /** 已被撤销（回到待办） */
  undone: boolean;
  /** 撤销按钮要指的那条的引用 */
  ref: string;
}

export function decidedRows(file: RiskQueueFile, events: DecisionEvent[]): DecidedRow[] {
  // 「最新一条决定」要忽略 undo（撤销不是"又做了一个决定"，它只是把某条作废）
  const decided = latestDecisions(events);
  const undone = undoneRefs(events);
  return file.队列
    .map((item) => {
      const event = decided.get(item.id);
      if (!event || event.decision === 'undo') return null;
      return {
        item,
        event,
        label: DECISION_LABEL[event.decision] ?? event.decision,
        undone: undone.has(refOf(event)),
        ref: refOf(event),
      };
    })
    .filter((x): x is DecidedRow => x !== null)
    .sort((a, b) => (a.event.timestamp < b.event.timestamp ? 1 : -1));
}

/** 决定行：直接喂给 decision.ts 的事件工厂（字段与报告逐项对应） */
export function decisionLineFor(
  item: RiskItem,
  kind: DecisionKind,
  opts: { teacherId: string; sourceVersion: string; reason?: string; after?: string; timestamp?: string },
): DecisionEvent {
  const after = opts.after ?? (kind === 'edit' ? '' : item.rewrittenSentence || item.title);
  return makeDecisionEvent({
    itemId: item.id,
    decision: kind,
    before: item.sourceSentence || item.title,
    after,
    reason: opts.reason ?? '',
    ruleIds: [item.ruleId],
    teacherId: opts.teacherId,
    sourceVersion: opts.sourceVersion,
    timestamp: opts.timestamp,
    book: item.book,
    chapter: item.chapter,
    tier: item.tier,
    segIndex: item.segIndex,
    category: item.category,
    subject: subjectOf(item),
  });
}

/** 这条决定针对什么：**实现在引擎**（`src/core/riskqueue.ts` 的 `subjectOf`），
 *  聚合与汇总器都要用它，放在 App 层会让引擎反向依赖界面。这里只做转出。 */
export { subjectOf } from '../../src/core/riskqueue.js';

/** 面板顶部的一行统计：报告要的"先看统计"就在这一行里 */
export interface PanelStat {
  total: number;
  pending: number;
  decided: number;
  blocked: number;
  estimatedMinutes: number;
  overBudget: boolean;
  advice: string;
  falsePositiveRate: number;
  byCategory: Partial<Record<GateCategory, number>>;
  unfinished: number;
}

export function panelStat(file: RiskQueueFile, events: DecisionEvent[], budget = 60): PanelStat {
  const decided = latestDecisions(events);
  const items = file.队列;
  const pending = items.filter((it) => !isResolved(decided.get(it.id)));
  // 计时按"还没处理掉的"算：已经采纳的不该继续占用人工预算
  const remainingMinutes = pending
    .filter((it) => !isResolved(decided.get(it.id)))
    .reduce((n, it) => n + (itemMinutes(it.ruleId) ?? 0.5), 0);
  const stat = summarizeDecisions(events);
  const plan = oneHourPlan({ items, summary: file.摘要 ?? { total: items.length, blockers: 0, byRule: {}, byCategory: {}, estimatedMinutes: remainingMinutes } }, budget);
  void plan;
  return {
    total: items.length,
    pending: pending.length,
    decided: items.length - pending.length,
    blocked: items.filter((it) => it.severity === 'blocker').length,
    estimatedMinutes: Number(remainingMinutes.toFixed(1)),
    overBudget: remainingMinutes > budget,
    advice:
      remainingMinutes > budget
        ? `剩余 ${Number(remainingMinutes.toFixed(1))} 分钟超出 ${budget} 分钟预算 → 停止扩展审校，先修生成规则或词库`
        : `剩余 ${Number(remainingMinutes.toFixed(1))} 分钟，在 ${budget} 分钟预算内`,
    falsePositiveRate: stat.falsePositiveRate,
    byCategory: countByCategory(items),
    unfinished: file.未完成段落?.length ?? 0,
  };
}

/** 与 riskqueue.MINUTES_PER_ITEM 同一口径（面板不该另写一份计时表） */
const itemMinutes = (ruleId: string): number =>
  ({ 'FACT-01': 2, 'FACT-02': 2, 'ANNO-01': 0.5, 'ANNO-03': 0.7, 'ANNO-02': 0.3, 'SENT-01': 0.5, 'LEN-01': 0.5, 'ZH-01': 1 })[ruleId] ?? 0.5;

function countByCategory(items: RiskItem[]): Partial<Record<GateCategory, number>> {
  const m: Partial<Record<GateCategory, number>> = {};
  for (const it of items) m[it.category] = (m[it.category] ?? 0) + 1;
  return m;
}

/** 规则人话标签（面板与文档共用同一张表） */
export const ruleLabel = (ruleId: string): string => GATE_RULES[ruleId]?.label ?? ruleId;

/** 提议预览：面板上直接告诉教师"你现在这些决定，汇总器会提议什么" */
export function proposalPreview(events: DecisionEvent[]): { kind: string; key: string; value: string; count: number }[] {
  return buildProposals(events).map((p) => ({ kind: p.kind, key: p.key, value: p.value, count: p.count }));
}

/* ────────────────────── IO：读队列、写决定 ────────────────────── */

export interface ProjectPaths {
  /** 产物目录（队列 JSON 在它的 _运行 下） */
  outDir: string;
  /** 调适工作区（决定日志在它的 _决定 下） */
  workDir: string;
  /** 源版本标识：产物哈希或日期，用来回答"这条决定是对着哪一版做的" */
  sourceVersion: string;
  /** 调适项目的 书级.词典 绝对路径（改稿动作要用它取释义）。没有 = 补注动作会被拒，并说明原因 */
  dictPath?: string;
}

/** 清单指针里的运行身份（App 也要按清单解析路径，否则 `--layout run` 一开面板就找不到文件） */
export interface RunIdentity {
  layout: Layout;
  runId: string;
  teacher: string;
}

/**
 * 读清单指针拿到运行身份。读不到就退回 legacy + 一个占位 runId——
 * 与命令行脚本 `runIdentity()` 同一套规则，**两处口径必须一致**，
 * 否则"命令行写到了 A、面板去 B 找"会表现成"面板说没有队列"。
 */
export async function loadRunIdentity(paths: ProjectPaths): Promise<RunIdentity> {
  const fallback: RunIdentity = { layout: 'legacy', runId: '', teacher: 'unknown' };
  if (!io) return fallback;
  try {
    const ptr = JSON.parse(await io.read(`${paths.outDir}/_运行/清单_最新.json`)) as { path?: string };
    if (!ptr.path) return fallback;
    const m = JSON.parse(await io.read(ptr.path)) as { layout?: Layout; runId?: string; teacher?: string };
    return { layout: m.layout ?? 'legacy', runId: m.runId ?? '', teacher: m.teacher ?? 'unknown' };
  } catch {
    return fallback;
  }
}

/** 面板用的一整套路径：与命令行脚本共用引擎的 `makeResolver`（不自己拼字符串） */
export function pathsFor(paths: ProjectPaths, id: RunIdentity, tier: string, date = ''): ReturnType<typeof makeResolver> {
  return makeResolver(id.layout, { out: paths.outDir, work: paths.workDir }, { runId: id.runId, tier: TAGS[tier] ?? tier, date });
}

export async function loadRiskQueue(
  paths: ProjectPaths,
  tier: string,
  id?: RunIdentity,
): Promise<{ file: RiskQueueFile | null; events: DecisionEvent[]; error?: string; identity: RunIdentity }> {
  const identity = id ?? (await loadRunIdentity(paths));
  if (!io) return { file: null, events: [], error: '面板 IO 未注入', identity };
  const R = pathsFor(paths, identity, tier);
  const queuePath = R.any('风险队列', { ext: '.json' });
  let file: RiskQueueFile | null = null;
  let error: string | undefined;
  try {
    file = parseQueueFile(await io.read(queuePath));
    if (!file) error = `队列文件格式不对：${queuePath}`;
  } catch {
    error = `还没生成过风险队列（${TAGS[tier] ?? tier}，${identity.layout} 布局）。先在管线里跑「风险队列」那一步。`;
  }
  let events: DecisionEvent[] = [];
  try {
    events = parseDecisionLog(await io.read(R.decision())).events;
  } catch {
    /* 还没有任何决定——这是正常的，不是错误 */
  }
  return { file, events, error, identity };
}

/** 追加一条不可变事件（读→拼接→写；事件日志只增不改）。路径按清单布局解析。 */
export async function appendDecision(
  paths: ProjectPaths,
  tier: string,
  event: DecisionEvent,
  id?: RunIdentity,
): Promise<void> {
  if (!io) throw new Error('面板 IO 未注入');
  const identity = id ?? (await loadRunIdentity(paths));
  const path = pathsFor(paths, identity, tier).decision();
  let prev: string;
  try {
    prev = await io.read(path);
  } catch {
    prev = ''; // 还没有决定日志 = 第一条决定
  }
  await io.write(path, prev + toDecisionLine(event));
}

/* ────────────────────── DOM 渲染 ────────────────────── */

const esc = (s: string): string =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const SEV_LABEL: Record<string, string> = { blocker: '不可完成', warn: '待判断' };

/** 面板要用的最小 DOM 接口（happy-dom 可直接给 document） */
export interface RiskDom {
  getElementById(id: string): { innerHTML: string } | null;
  querySelectorAll(sel: string): ArrayLike<Element>;
  addEventListener(type: string, fn: (e: Event) => void): void;
}

export interface RiskRenderInput {
  dom: RiskDom;
  tier: string;
  paths: ProjectPaths;
  teacherId: string;
  budget?: number;
  /** 内部用：重渲染时不再记 session-open（否则每渲染一次写一条） */
  skipSessionOpen?: boolean;
}

/**
 * 渲染「风险队列」页：一条问题一张卡，按 风险 = 概率 × 后果 排序。
 * 每张卡给：原句 / 改写句 / 上下文各一句 / 触发规则 / 位置，加三个决定按钮。
 * 按钮只写事件日志（不可变），不改书稿——改书稿仍走既有的标记/建议通道。
 */
export async function renderRiskPane(
  input: RiskRenderInput,
  /** 上一次动作失败留在页首的说明（`{itemId}` 用于把那张卡标红，让它看起来"还在待办里"） */
  flash?: { itemId: string; text: string },
): Promise<{ ok: boolean; message: string }> {
  const el = input.dom.getElementById('pane-risk');
  if (!el) return { ok: false, message: '缺 pane-risk 容器' };
  const { file, events, error, identity } = await loadRiskQueue(input.paths, input.tier);
  if (!file) {
    el.innerHTML = `<div class="empty"><b>还没有风险队列</b><br/>${esc(error ?? '')}<br/><span style="font-size:12px">在管线里跑「风险队列」那一步即可生成（<code>node tools/af_pipeline/LayerText_AF风险队列.mjs --tier A</code>）</span></div>`;
    return { ok: false, message: error ?? '没有队列' };
  }
  const budget = input.budget ?? 60;
  /* 打开队列记一条事件（算"首次点击到可采纳结果的时间"要用）。
   * 只在**这一轮还没记过**时写：面板每次重渲染都写一条的话，日志会被灌满，指标也就没意义了。 */
  if (!input.skipSessionOpen && !events.some((e) => e.itemId === 'session-open' && e.timestamp.slice(0, 10) === new Date().toISOString().slice(0, 10))) {
    try {
      await appendDecision(
        input.paths,
        input.tier,
        sessionOpenEvent({ tier: input.tier, teacherId: input.teacherId, sourceVersion: input.paths.sourceVersion, pending: pendingItems(file, events).length }),
        identity,
      );
    } catch {
      /* 记不上不影响用队列；指标里会显示"算不出来" */
    }
  }
  const stat = panelStat(file, events, budget);
  const left = pendingItems(file, events);
  const done = decidedRows(file, events);
  const groups = groupQueue(left, { mutatingRules: MUTATING_RULES });
  const session = sessionState(left, groups);
  // 可观测产品指标（v4 报告「系统性偏差」一节）：全部从已有事件日志算出来，不新增埋点
  const pm = productMetrics(events);
  const planned = oneHourPlan(
    { items: file.队列, summary: file.摘要 },
    budget,
  );

  const head = `
    <div class="rq-head">
      <div class="rq-title">风险队列 · ${esc(input.tier)} 层${file.书名 ? ` · ${esc(file.书名)}` : ''}</div>
      <div class="rq-stat">
        共 <b>${stat.total}</b> 条｜待办 <b>${stat.pending}</b>｜已决 <b>${stat.decided}</b>｜不可完成 <b>${stat.blocked}</b>
        ｜估时 <b>${stat.estimatedMinutes}</b> 分钟${stat.overBudget ? '（<b class="rq-over">超预算</b>）' : ''}
        ｜误报率 <b>${(stat.falsePositiveRate * 100).toFixed(0)}%</b>
        ${stat.unfinished ? `｜<b class="rq-over">未完成段落 ${stat.unfinished}</b>` : ''}
      </div>
      <div class="rq-advice">${esc(stat.advice)}｜路径布局 <b>${esc(identity.layout)}</b>${identity.runId ? `（${esc(identity.runId)}）` : ''}</div>
      <div class="rq-session ${session.done ? 'rq-session-done' : ''}">${esc(session.text)}</div>
      ${
        pm.decisions
          ? `<details class="rq-metrics"><summary>我这边用得怎么样（产品指标）</summary><ul>${pm.notes
              .map((n) => `<li>${esc(n)}</li>`)
              .join('')}</ul></details>`
          : ''
      }
      <details class="rq-budget">
        <summary>本次预算怎么排（后台估算，不是任务模型）</summary>
        <div class="rq-plan">${planned.phases.map((p) => `<span class="rq-phase">${esc(p.title)} ${p.budget}′ / ${p.items.length} 条</span>`).join('')}</div>
        <div class="rq-hint">${esc(planned.advice)}</div>
      </details>
      ${done.length ? `<details class="rq-done"><summary>看我判过的（${done.length} 条，可撤销）</summary><div class="rq-done-list">${done
        .map(
          (r) => `<div class="rq-done-row${r.undone ? ' rq-done-undone' : ''}">
            <span class="rq-done-label">${esc(r.label)}${r.undone ? '（已撤销）' : ''}</span>
            <span class="rq-done-pos">${esc(r.item.segLabel)}</span>
            <span class="rq-done-title">${esc(r.item.title)}</span>
            ${r.undone ? '' : `<button class="rq-btn rq-undo" data-undo="${esc(r.ref)}">↩︎ 撤销</button>`}
          </div>`,
        )
        .join('')}</div></details>` : ''}
    </div>`;

  if (!file.队列.length) {
    el.innerHTML = `${head}<div class="empty">队列为空——本层没有机器点得出来的风险，可直接抽样阅读。<br/><span style="font-size:12px">${esc(POSITIONING_LINE)}</span></div>`;
    return { ok: true, message: '队列为空' };
  }
  if (!left.length) {
    el.innerHTML = `${head}<div class="empty">队列已全部处理完（共 ${stat.total} 条）。历史决定一条没删，可随时回头改。</div>`;
    return { ok: true, message: '已全部处理' };
  }

  const flashBar = flash
    ? `<div class="rq-flash">⚠ ${esc(flash.text)} <span style="color:var(--muted)">（这一条仍在待办里，正文没有改动）</span></div>`
    : '';
  const card = (it: RiskItem): string => `
      <div class="rq-card${flash && flash.itemId === it.id ? ' rq-card-failed' : ''}" data-item="${esc(it.id)}">
        <div class="rq-card-head">
          <span class="rq-rule" title="${esc(ruleLabel(it.ruleId))}">${esc(it.ruleId)}</span>
          <span class="rq-sev rq-sev-${it.severity === 'blocker' ? 'block' : 'warn'}">${SEV_LABEL[it.severity] ?? it.severity}</span>
          <span class="rq-risk">风险 ${it.risk}</span>
          <span class="rq-pos">${esc(it.segLabel)}${it.tier ? `（${esc(it.tier)} 层）` : ''}</span>
        </div>
        <div class="rq-issue">${esc(it.title)}</div>
        ${it.plot ? `<div class="rq-plot">${esc(plotLine(it.plot))}</div>` : ''}
        <div class="rq-pair">
          <div><span class="rq-lab">原句</span>${esc(it.sourceSentence || '（未定位到原句）')}</div>
          <div><span class="rq-lab">改写</span>${esc(it.rewrittenSentence || '（改写里找不到）')}</div>
          <div class="rq-ctx"><span class="rq-lab">上下文</span>上「${esc(it.context.prev || '—')}」／下「${esc(it.context.next || '—')}」</div>
        </div>
        <div class="rq-actions">
          <button class="rq-btn rq-btn-main" data-act="${esc(actionOf(it.ruleId).kind)}" data-id="${esc(it.id)}"
            title="${esc(actionOf(it.ruleId).effect)}">${esc(actionOf(it.ruleId).label)}</button>
          <button class="rq-btn" data-decide="reject" data-id="${esc(it.id)}">↺ 退回重写</button>
          <button class="rq-btn" data-decide="false-positive" data-id="${esc(it.id)}">⚑ 标记误报</button>
          ${actionOf(it.ruleId).mutates ? '<span class="rq-hint">主键会改正文并同时记事件（可撤销）</span>' : '<span class="rq-hint">主键只记录决定，正文不变</span>'}
        </div>
      </div>`;

  // 按任务组呈现（v4 方向第 3 条）：一条一条翻 70 张卡，到第 25 条就开始盲点了
  const groupHtml = (g: TaskGroup, gi: number): string => `
    <section class="rq-group" data-group="${esc(g.id)}">
      <div class="rq-group-head">
        <span class="rq-rank">${gi + 1}</span>
        <span class="rq-group-title">${esc(g.title)}</span>
        <span class="rq-group-count">${g.count} 条</span>
        <span class="rq-group-rules">${esc(g.rules.join('、'))}</span>
        ${g.uniformAction ? `<button class="rq-btn rq-btn-batch" data-batch="${esc(g.id)}" title="${esc(batchImpact(g))}">⚡ 全部应用（${g.actionable} 处）</button>` : ''}
      </div>
      <div class="rq-group-impact">${esc(batchImpact(g))}</div>
      ${g.samples.map(card).join('')}
      ${
        g.count > g.samples.length
          ? `<details class="rq-more"><summary>展开这一组其余 ${g.count - g.samples.length} 条</summary>${g.items.slice(g.samples.length).map(card).join('')}</details>`
          : ''
      }
    </section>`;

  el.innerHTML = `${head}${flashBar}<div class="rq-list">${groups.map(groupHtml).join('')}</div>`;

  // 主键 = 规则特定动作（可能改正文）；其余键 = 只记决定。两者都写不可变事件。
  for (const btn of Array.from(input.dom.querySelectorAll('#pane-risk [data-decide]'))) {
    btn.addEventListener('click', (ev) => {
      const t = ev.currentTarget as HTMLElement;
      const kind = t.getAttribute('data-decide') as DecisionKind | null;
      const id = t.getAttribute('data-id');
      if (!kind || !id) return;
      const it = file.队列.find((x) => x.id === id);
      if (!it) return;
      t.setAttribute('disabled', 'true');
      void appendDecision(
        input.paths,
        input.tier,
        decisionLineFor(it, kind, { teacherId: input.teacherId, sourceVersion: input.paths.sourceVersion }),
        identity,
      ).then(() => renderRiskPane({ ...input, skipSessionOpen: true }));
    });
  }
  // 撤销 = 写一条新的 undo 事件（**不删历史**），并（如果是改稿动作）把正文改回去
  for (const btn of Array.from(input.dom.querySelectorAll('#pane-risk [data-undo]'))) {
    btn.addEventListener('click', (ev) => {
      const ref = (ev.currentTarget as HTMLElement).getAttribute('data-undo');
      if (!ref) return;
      (ev.currentTarget as HTMLElement).setAttribute('disabled', 'true');
      void undoDecision(input, file, identity, ref).then((r) => {
        if (r.ok) void renderRiskPane({ ...input, skipSessionOpen: true });
        else void renderRiskPane({ ...input, skipSessionOpen: true }, { itemId: '', text: r.message ?? '撤销未完成' });
      });
    });
  }
  // 批量应用：只对"动作统一、且有确定性修法"的组开放（其余组连按钮都不给）
  for (const btn of Array.from(input.dom.querySelectorAll('#pane-risk [data-batch]'))) {
    btn.addEventListener('click', (ev) => {
      const gid = (ev.currentTarget as HTMLElement).getAttribute('data-batch');
      const g = groups.find((x) => x.id === gid);
      if (!g) return;
      (ev.currentTarget as HTMLElement).setAttribute('disabled', 'true');
      void runBatchApply(input, file, identity, g).then((r) => {
        void renderRiskPane({ ...input, skipSessionOpen: true }, r.ok ? undefined : { itemId: '', text: r.message ?? '批量应用未完成' });
      });
    });
  }
  for (const btn of Array.from(input.dom.querySelectorAll('#pane-risk [data-act]'))) {
    btn.addEventListener('click', (ev) => {
      const t = ev.currentTarget as HTMLElement;
      const id = t.getAttribute('data-id');
      if (!id) return;
      const it = file.队列.find((x) => x.id === id);
      if (!it) return;
      t.setAttribute('disabled', 'true');
      void runRiskAction(input, file, identity, it).then((r) => {
        // 失败时**不**立刻重渲染队列：否则刚写上去的失败原因会被覆盖，
        // 教师只看到"点了没反应、卡片还在"。卡片留在列表里 + 顶部一条失败说明。
        if (r.ok) void renderRiskPane({ ...input, skipSessionOpen: true });
        else void renderRiskPane({ ...input, skipSessionOpen: true }, { itemId: it.id, text: r.message ?? '动作未执行' });
      });
    });
  }
  return { ok: true, message: `待办 ${left.length} 条` };
}

/* ────────────────────── 动作 → 事务（改正文 + 记事件，一次做完） ────────────────────── */

/** 该动作需要的"释义"从哪来：优先统一词典，退而取风险项 detail 里带的 */
function glossFor(it: RiskItem, dict: Map<string, string>): string {
  const d = it.detail ?? {};
  const word = typeof d.word === 'string' ? d.word : '';
  if (typeof d.expected === 'string' && d.expected) return d.expected;
  if (word && dict.get(word.toLowerCase())) return dict.get(word.toLowerCase())!;
  if (typeof d.zh === 'string' && d.zh) return d.zh;
  return '';
}

/**
 * 执行一个风险动作。
 *
 * 事务语义（v4 方向）：**先读最新正文 → 校验动作在当前位置仍然成立 → 改 → 一次写完正文与事件**。
 * 任何一步不成立就只写一条 `rejected` 事件，**卡片留在队列里**——
 * 绝不允许"卡片消失了、正文没变"这种两头空。
 */
async function runRiskAction(
  input: RiskRenderInput,
  file: RiskQueueFile,
  identity: RunIdentity,
  it: RiskItem,
): Promise<{ ok: boolean; message?: string }> {
  const action: RuleAction = actionOf(it.ruleId);
  const d = it.detail ?? {};
  const word = typeof d.word === 'string' ? d.word : typeof d.signal === 'string' ? d.signal : '';
  /* 记一条决定。**返回 Promise，不许 `void` 掉**：
   * 事件写失败原来是 unhandled rejection（测试当场抓到），在 App 里就是一条无人处理的红字。
   * 记账失败必须能被调用方看见并处理——这正是"改稿必有记录"那条约束的另一半。 */
  const mkDecision = (kind: DecisionKind, extra: Partial<Parameters<typeof decisionLineFor>[2]> = {}): Promise<void> =>
    appendDecision(
      input.paths,
      input.tier,
      decisionLineFor(it, kind, { teacherId: input.teacherId, sourceVersion: input.paths.sourceVersion, ...extra }),
      identity,
    );
  /** 失败了要留痕，而且**卡片不许消失**：写 rejected 事件（它不是"已处理完"），把原因交回调用方显示 */
  const reject = async (why: string): Promise<{ ok: false; message: string }> => {
    try {
      await mkDecision('rejected', { reason: why });
    } catch {
      // 连失败都记不上：如实告诉人（不要静默），卡片仍然留着
      return { ok: false, message: `${why}（且失败记录未能写入日志）` };
    }
    return { ok: false, message: why };
  };

  // 纯表态的动作：不改正文，直接记事件
  if (!action.mutates) {
    try {
      await mkDecision('accept', { reason: action.effect });
    } catch (e) {
      return { ok: false, message: `决定写入失败：${e instanceof Error ? e.message : String(e)}` };
    }
    return { ok: true };
  }

  const dict = await loadBookDict(input.paths);
  // 优先用队列里记的真实路径；没有才退回解析器（并说明这次是推出来的）
  const docPath = file.章节产物?.[it.chapter] ?? pathsFor(input.paths, identity, input.tier).any('正文', { chapter: it.chapter });
  let doc: string;
  try {
    doc = await io!.read(docPath);
  } catch {
    return await reject(`读不到正文（${docPath}）——产物可能被移动或删除了`);
  }
  const res = applyAction(action, {
    doc,
    segId: segIdOf(it),
    word,
    zh: glossFor(it, dict),
    removeAll: it.detail?.crossSegment === true,
  });
  if (!res.ok) {
    return await reject(failureText(res));
  }
  // 事务：备份 → 写正文 → 写事件；**事件写失败就把正文改回去**。
  // 跨两个文件的"真原子"做不到，但可以做到"不留下改了稿却没记录"的状态——
  // 否则就会出现最坏的一种：正文变了、日志里查不到是谁改的、撤销也无从下手。
  try {
    if (io!.backup) await io!.backup(docPath, doc);
    await io!.write(docPath, res.next);
  } catch (e) {
    return await reject(`写入失败：${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    await appendDecision(
      input.paths,
      input.tier,
      decisionLineFor(it, 'accept', { teacherId: input.teacherId, sourceVersion: input.paths.sourceVersion, after: res.after, reason: `${action.label}：${res.before} → ${res.after}` }),
      identity,
    );
  } catch (e) {
    // 回滚正文：宁可这次没改成，也不能让稿子带着一处"无名改动"
    try {
      await io!.write(docPath, doc);
    } catch { /* 回滚也失败：至少上面的 reject 会写进日志并告诉教师 */ }
    return await reject(`事件写入失败，已把正文改回原样：${e instanceof Error ? e.message : String(e)}`);
  }
  return { ok: true, message: `${action.label}：${res.before} → ${res.after}` };
}

/**
 * 撤销一条决定。
 *
 * 两件事，一个事务：
 *   ① 如果被撤销的是**改稿动作**，把正文按事件里记的 before/after 改回去
 *      （`after` 必须仍在原处，否则报"稿件已改过"并且**不写 undo 事件**——宁可撤销失败，也不留下假账）；
 *   ② 写一条 `undo` 事件（`undoOf` 指回被撤销的那条）——**历史一条都不删**。
 *
 * 两条写入的次序是"先改稿、后写事件"，**事件写不进去就把稿子改回来**：
 * 跨两个文件的真原子做不到，但"稿子被改了、日志里查不到、撤销也无从下手"是必须避免的。
 */
async function undoDecision(
  input: RiskRenderInput,
  file: RiskQueueFile,
  identity: RunIdentity,
  ref: string,
): Promise<{ ok: boolean; message?: string }> {
  const all = (await loadRiskQueue(input.paths, input.tier, identity)).events;
  const target = all.find((e) => refOf(e) === ref);
  if (!target) return { ok: false, message: '找不到要撤销的那条决定（可能已被撤销过）' };
  if (target.decision === 'undo') return { ok: false, message: '撤销事件本身不能再撤销' };

  const it = file.队列.find((x) => x.id === target.itemId);
  const action = it ? actionOf(it.ruleId) : null;
  const writeUndo = async (): Promise<void> => {
    await appendDecision(
      input.paths,
      input.tier,
      makeDecisionEvent({
        itemId: target.itemId,
        decision: 'undo',
        before: target.after,
        after: target.before,
        reason: `撤销 ${DECISION_LABEL[target.decision] ?? target.decision}（${target.timestamp}）`,
        ruleIds: target.ruleIds,
        teacherId: input.teacherId,
        sourceVersion: input.paths.sourceVersion,
        category: target.category,
        subject: target.subject,
        undoOf: ref,
      }),
      identity,
    );
  };

  // 纯表态的动作（没改过正文）：只写 undo 事件
  if (!it || !action?.mutates || !target.after || target.after === target.before) {
    try {
      await writeUndo();
    } catch (e) {
      return { ok: false, message: `撤销事件写入失败：${e instanceof Error ? e.message : String(e)}` };
    }
    return { ok: true };
  }

  const docPath = file.章节产物?.[it.chapter] ?? pathsFor(input.paths, identity, input.tier).any('正文', { chapter: it.chapter });
  let doc: string;
  try {
    doc = await io!.read(docPath);
  } catch {
    return { ok: false, message: `读不到正文（${docPath}），未撤销` };
  }
  const segId = segIdOf(it);
  const ast = parseDoc(doc);
  const seg = ast.segments.find((x) => x.id === segId);
  if (!seg || !seg.raw.includes(target.after)) {
    return { ok: false, message: `正文里已经找不到「${target.after}」了（稿件改过），未撤销` };
  }
  try {
    if (io!.backup) await io!.backup(docPath, doc);
    await io!.write(docPath, doc.replace(target.after, target.before));
  } catch (e) {
    return { ok: false, message: `撤销写入失败：${e instanceof Error ? e.message : String(e)}` };
  }
  try {
    await writeUndo();
  } catch (e) {
    // 撤销事件写不进去 → 把正文改回来（不然就是"稿子被改了、日志里没有"）
    try {
      await io!.write(docPath, doc);
    } catch { /* 回滚也失败：下面如实报 */ }
    return { ok: false, message: `撤销事件写入失败，已把正文改回原样：${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true };
}


/**
 * 批量应用一个组。
 *
 * 报告第 3 条要的"全部应用"在这里落地。语义上它**不是**"把 N 条一次记完"，
 * 而是"把同一类改动一次做完"——所以：
 *   · 逐条执行**同一个** `applyAction`（不另写一条批量路径，避免两套口径）；
 *   · **按章聚合写盘**：一章只读一次、写一次（否则 12 条就是 12 次读改写，慢且更容易出岔）；
 *   · 任一条失败**不静默跳过**：那一条写 `rejected`、留在待办，其余照做，最后如实报告几成几败。
 * 返回 `ok` 只在**全部成功**时为真——部分成功也算没做完。
 *
 * 写入次序：**先在内存里跑完整章 → 写正文 → 写事件**；事件写失败就把正文回滚。
 * 反过来（先写事件后写正文）会留下"日志里有、稿子没变"的假账，那比失败更糟。
 */
async function runBatchApply(
  input: RiskRenderInput,
  file: RiskQueueFile,
  identity: RunIdentity,
  group: TaskGroup,
): Promise<{ ok: boolean; message?: string }> {
  if (!group.uniformAction) return { ok: false, message: '这一组的动作不统一，只能逐条处理' };
  const byChapter = new Map<string, RiskItem[]>();
  for (const it of group.items) {
    if (!byChapter.has(it.chapter)) byChapter.set(it.chapter, []);
    byChapter.get(it.chapter)!.push(it);
  }
  let doneCount = 0;
  let failedCount = 0;
  const firstError: string[] = [];
  for (const [chapter, items] of byChapter) {
    const docPath = file.章节产物?.[chapter] ?? pathsFor(input.paths, identity, input.tier).any('正文', { chapter });
    let doc: string;
    try {
      doc = await io!.read(docPath);
    } catch {
      failedCount += items.length;
      if (!firstError.length) firstError.push(`读不到正文（${docPath}）`);
      for (const it of items) {
        await appendDecision(input.paths, input.tier, decisionLineFor(it, 'rejected', { teacherId: input.teacherId, sourceVersion: input.paths.sourceVersion, reason: `批量：读不到正文（${docPath}）` }), identity);
      }
      continue;
    }
    const dict = await loadBookDict(input.paths);
    let cur = doc;
    const applied: { it: RiskItem; before: string; after: string; label: string }[] = [];
    for (const it of items) {
      const action = actionOf(it.ruleId);
      const res = applyAction(action, {
        doc: cur,
        segId: segIdOf(it),
        word: typeof it.detail?.word === 'string' ? it.detail.word : '',
        zh: glossFor(it, dict),
        removeAll: it.detail?.crossSegment === true,
      });
      if (!res.ok) {
        failedCount++;
        if (!firstError.length) firstError.push(failureText(res));
        await appendDecision(input.paths, input.tier, decisionLineFor(it, 'rejected', { teacherId: input.teacherId, sourceVersion: input.paths.sourceVersion, reason: `批量：${failureText(res)}` }), identity);
        continue;
      }
      cur = res.next;
      applied.push({ it, before: res.before, after: res.after, label: action.label });
    }
    if (cur !== doc) {
      try {
        if (io!.backup) await io!.backup(docPath, doc);
        await io!.write(docPath, cur);
      } catch (e) {
        // 正文没落盘 → 这一章的条目全部 rejected（绝不能显示成已办）
        failedCount += applied.length;
        if (!firstError.length) firstError.push(`写入失败：${e instanceof Error ? e.message : String(e)}`);
        for (const a of applied) {
          await appendDecision(input.paths, input.tier, decisionLineFor(a.it, 'rejected', { teacherId: input.teacherId, sourceVersion: input.paths.sourceVersion, reason: `批量：写入失败（${e instanceof Error ? e.message : String(e)}）` }), identity);
        }
        continue;
      }
    }
    // 正文已落盘，再写事件；事件写失败 → 回滚正文，保持"改稿必有记录"
    try {
      for (const a of applied) {
        await appendDecision(input.paths, input.tier, decisionLineFor(a.it, 'accept', { teacherId: input.teacherId, sourceVersion: input.paths.sourceVersion, after: a.after, reason: `批量${a.label}：${a.before} → ${a.after}` }), identity);
        doneCount++;
      }
    } catch (e) {
      try {
        await io!.write(docPath, doc);
      } catch { /* 回滚也失败：下面如实报 */ }
      failedCount += applied.length;
      if (!firstError.length) firstError.push(`事件写入失败，已把正文改回原样：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const message = `全部应用：成功 ${doneCount} 处，失败 ${failedCount} 处${firstError.length ? `（${firstError[0]}）` : ''}`;
  return { ok: failedCount === 0, message };
}

/** 风险项 → 段号（P07）。队列项 id 形如 `第一章#2:FACT-01:1911`，段序从 0 起。 */
export function segIdOf(it: RiskItem): string {
  const m = it.id.match(/#(\d+):/);
  return m ? `P${String(Number(m[1]) + 1).padStart(2, '0')}` : 'P01';
}

/** 统一词典读取（面板用）：路径由调用方从 调适项目_*.json 解析好传进来（不在面板里再找一遍配置） */
async function loadBookDict(paths: ProjectPaths): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!io || !paths.dictPath) return out;
  try {
    for (const e of parseDictCsv(await io.read(paths.dictPath))) out.set(e.word, e.zh);
  } catch {
    /* 读不到 = 空词典；补注动作会因此被拒并说明原因，不静默 */
  }
  return out;
}
