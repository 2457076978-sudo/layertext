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
import { chooseIdentity, contentHash, dirOfPath, LATEST_POINTER_NAME, makeResolver, pointerNameOf, TIER_TAG, type Layout, type ManifestPointer } from '../../src/core/manifest.js';
import { parseDictCsv } from '../../src/core/dictmerge.js';
import { plotLine } from '../../src/core/plotweight.js';
import { POSITIONING_LINE } from '../../src/core/positioning.js';
import { DECISION_LABEL } from '../../src/core/decision.js';
import { productMetrics, sessionOpenEvent } from '../../src/core/productmetrics.js';
/* 「我做完了」标记：教师自己说"这一轮任务到此为止"。
 * 没有它，"完成没完成、花了多久"只能靠**待办条数去推断**——
 * 阶段 4 的教师任务实验要回答"完成时间"，而推断出来的时间不该冒充事实。 */
import { TASK_DONE, taskDoneEvent } from '../../src/core/teacherexperiment.js';
import { actionOf, REVERT_ACTION, type RuleAction } from '../../src/core/riskaction.js';
import { applyChange, applyChangeBatch, currentVersionOf, parseVersionLog, recordOnly, type ChangeResult, type TxIo, type VersionTarget } from '../../src/core/version.js';
/** 有确定性动作的规则（批量应用只在这几类上给） */
const MUTATING_RULES = ['ANNO-01', 'ANNO-02', 'ANNO-03', 'AST-02'];
/**
 * 任务工作台（《LayerText工程优化总计划》阶段 2）：暂停/恢复、今日任务、变更历史、可解释性。
 * **判定语义（什么算办完、还剩什么）全部来自引擎**，本文件不再自己定义一遍——
 * 见下面 `TERMINAL_DECISIONS` / `pendingItems` 一带的说明。
 */
import {
  currentPause,
  dayOf,
  eventRef,
  explainState,
  historyRows,
  isSettled,
  latestDecisionMap,
  parseWorkbenchLog,
  pauseMarker,
  pausedDrift,
  pendingOf,
  resumeCheck,
  resumeMarker,
  taskStateOf,
  TERMINAL_KINDS,
  toWorkbenchLine,
  todayTasks,
  undoneEventRefs,
  type ItemHistory,
  type WorkbenchMarker,
} from '../../src/core/workbench.js';
import { batchImpact, batchPreview, groupQueue, sessionState, subjectOf, type RiskItem, type RiskQueue, type TaskGroup } from '../../src/core/riskqueue.js';
import { oneHourPlan } from '../../src/core/riskqueue.js';
import type { GateCategory } from '../../src/core/segmentgate.js';
import { itemMinutes, countByCategory, ruleLabel } from './risklogic.js';

export interface RiskIo {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  listDir(dir: string): Promise<string[]>;
  exists?(path: string): Promise<boolean>;
  /** 改稿前备份（可选）。给了就先备份再写——**不可逆的操作不该没有退路**。 */
  backup?(path: string, content: string): Promise<void>;
  /** 追加一行（可选）。账本是 append-only，给了就不必 read+write 整份日志 */
  append?(path: string, line: string): Promise<void>;
}

let io: RiskIo | null = null;
/** 测试/替换用（与 datapanel.setIo 同一约定） */
export function setRiskIo(next: RiskIo | null): void {
  io = next;
}

/** 层级标签。**只有一份**，定义在 `src/core/manifest.ts`（它与 `resolvePath` 同属产物命名约定） */
export const TAGS: Record<string, string> = TIER_TAG;

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
    /* 有意兜底：解析不了＝这份队列不可用，返回 null 交给调用方——它会当场写成
     * "队列文件格式不对：<路径>"显示在面板上，不是静默当成空队列。 */
    return null;
  }
}

/**
 * 哪些决定算"这条已经处理完了"。
 *
 * ⚠ `rejected`（**动作没执行成**）**不算**——它是"系统没做成"，不是"教师判过了"。
 * 把它也算成已决，就会出现最坏的那种两头空：**卡片消失了、正文也没变**，
 * 而教师以为这件事已经办完（v4 方向明确要求"失败时不得让卡片消失"）。
 *
 * ★ 判定语义已**下沉到引擎**（`src/core/workbench.ts`：`TERMINAL_KINDS` / `isSettled` / `pendingOf`）。
 * 理由与 `subjectOf` 当初下沉同源：任务工作台（暂停恢复、今日任务、可解释性）也要回答
 * "还剩什么、办完没有"，而"待办"**只能有一个定义**——两份就会有一天分成两半，
 * 那时"暂停 10 分钟后还是同一批任务"这句话就不再成立。
 * 下面这些名字继续导出（面板、测试、命令行都在用），实现一律转出，**不再有第二份**。
 */
export const TERMINAL_DECISIONS: DecisionKind[] = TERMINAL_KINDS;

/** 撤销指针：`itemId + '@' + timestamp`（同一个项可以被改主意多次，要指得准） */
export const refOf = eventRef;

/** 已被撤销的引用集合（`undoOf` 指过的）。
 *  被撤销的项**回到待办**——这是"撤销不是删历史"在判定上的落点。 */
export const undoneRefs = undoneEventRefs;

/**
 * 一个项当前算不算"处理完了"：
 *   · 取**最新一条**决定（`undo` 本身不算决定，它只是把某条作废）；
 *   · 它属于终态四类、**且没有被撤销** → 算处理完；
 *   · **被撤销 = 整条作废，项回到待办**。
 *
 * 为什么不做"回退到更早的那条"：那要教师理解一个多级撤销栈，
 * 而他心里只有"我刚才点错了，撤销一下"。界面上的撤销键也长在最新那条上——
 * 单级撤销与界面一致，多级回退只会让"现在到底算什么状态"变得说不清。
 * 计划里那句「撤销连续发生三次时状态仍可解释（若实测需要多级，再升级为版本树）」
 * 就是拿这条规则实测的：实测不需要版本树，见 `tests/workbench.test.ts`。
 */
const isResolved = isSettled;

/** 每个项的最新一条**决定**（忽略 `undo`——它不是决定，是作废指令） */
export const latestDecisions = latestDecisionMap;

/** 队列里还有哪些没被处理完（处理完的从待办里消失，但历史事件一条不删） */
export function pendingItems(file: RiskQueueFile, events: DecisionEvent[]): RiskItem[] {
  return pendingOf(file.队列, events);
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
export function decisionLineFor(item: RiskItem, kind: DecisionKind, opts: { teacherId: string; sourceVersion: string; reason?: string; after?: string; timestamp?: string }): DecisionEvent {
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
  /* ★ 页首的"待办"必须与列表里的卡片同源：原来这里漏了 `undone`，
   * 于是**撤销过的条目在列表里回到待办、却在页首仍算已决**——
   * 同一屏上两个数对不上。这直接打到阶段 2 那句"重新打开仍回到同一任务状态"：
   * 状态要是自己都说不一致，就谈不上"同一"。 */
  const undone = undoneRefs(events);
  const items = file.队列;
  const pending = items.filter((it) => !isResolved(decided.get(it.id), undone));
  // 计时按"还没处理掉的"算：已经采纳的不该继续占用人工预算
  const remainingMinutes = pending.reduce((n, it) => n + (itemMinutes(it.ruleId) ?? 0.5), 0);
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
/** 规则人话标签（面板与文档共用同一张表） */

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
  /** 身份是从哪儿来的（`chooseIdentity` 的 `source`）——进页首，让"我读的是哪一次运行"可见 */
  source?: string;
}

/**
 * 读清单指针拿到运行身份。读不到就退回 legacy + 一个占位 runId——
 * 与命令行脚本 `runIdentity()` 同一套规则，**两处口径必须一致**，
 * 否则"命令行写到了 A、面板去 B 找"会表现成"面板说没有队列"。
 */
export async function loadRunIdentity(paths: ProjectPaths, want?: { teacher?: string; tier?: string }): Promise<RunIdentity> {
  const fallback: RunIdentity = { layout: 'legacy', runId: '', teacher: 'unknown' };
  if (!io) return fallback;
  const runDir = `${paths.outDir}/_运行`;
  /* 指针文件只记"指向谁"；`layout`/`teacher`/`tier` **以清单本身为准**（两处不一致时信清单）。
   * 指针指向的清单读不到 → 整份指针视为读不到：坏指针**不许半途生效**，
   * 半生效比彻底失效更危险——它会让人以为一切正常。 */
  const readPtr = async (name: string): Promise<ManifestPointer | null> => {
    try {
      const raw = JSON.parse(await io!.read(`${runDir}/${name}`)) as Partial<ManifestPointer>;
      if (!raw?.path) return null;
      const m = JSON.parse(await io!.read(raw.path)) as Partial<ManifestPointer>;
      return {
        path: raw.path,
        runId: m.runId ?? raw.runId ?? '',
        layout: m.layout ?? raw.layout ?? 'legacy',
        teacher: m.teacher ?? raw.teacher ?? 'unknown',
        tier: m.tier ?? raw.tier,
        updatedAt: raw.updatedAt,
      };
    } catch {
      /* 有意兜底：指针文件没有/坏了＝"没有最近一次运行"。返回 null 让 chooseIdentity 去判——
       * 教师/层级对不上时它会**拒绝采用并给出警告**，不把别人的运行当成自己的。 */
      return null;
    }
  };
  /* ★ 先读**按教师+层级分片**的那份指针，全局"最近一次"只作兜底。
   * 两份教师并发跑同一本书时，共用一份全局指针会让后跑者覆盖先跑者的身份，
   * 于是先跑者的面板去读对方的 runId、写进对方的运行目录——而且两边都显示成功。
   * `chooseIdentity` 会在"最近一次"的教师/层级对不上时**拒绝采用**并给出警告，
   * 而不是把别人的运行当成自己的。 */
  const scoped = want ? await readPtr(pointerNameOf({ teacher: want.teacher ?? 'unknown', tier: want.tier })) : null;
  const latest = await readPtr(LATEST_POINTER_NAME);
  const chosen = chooseIdentity({
    want: want ?? {},
    explicitRunId: (globalThis as { __LAYERTEXT_RUN__?: string }).__LAYERTEXT_RUN__,
    scoped,
    latest,
    fallbackRunId: '',
  });
  if (chosen.warning) lastIdentityWarning = chosen.warning;
  return { ...chosen.identity, source: chosen.source };
}

/** 最近一次身份选取留下的警告（面板页首要把它显示出来——**绝不静默**） */
export let lastIdentityWarning: string | undefined;

/** 面板用的一整套路径：与命令行脚本共用引擎的 `makeResolver`（不自己拼字符串） */
export function pathsFor(paths: ProjectPaths, id: RunIdentity, tier: string, date = ''): ReturnType<typeof makeResolver> {
  return makeResolver(id.layout, { out: paths.outDir, work: paths.workDir }, { runId: id.runId, tier: TAGS[tier] ?? tier, date });
}

export async function loadRiskQueue(
  paths: ProjectPaths,
  tier: string,
  id?: RunIdentity,
  teacher?: string,
): Promise<{ file: RiskQueueFile | null; events: DecisionEvent[]; error?: string; identity: RunIdentity; sourceVersion: string }> {
  const identity = id ?? (await loadRunIdentity(paths, { teacher, tier: TAGS[tier] ?? tier }));
  if (!io) return { file: null, events: [], error: '面板 IO 未注入', identity, sourceVersion: paths.sourceVersion };
  const R = pathsFor(paths, identity, tier);
  const queuePath = R.any('风险队列', { ext: '.json' });
  let file: RiskQueueFile | null = null;
  let error: string | undefined;
  let queueText = '';
  try {
    queueText = await io.read(queuePath);
    file = parseQueueFile(queueText);
    if (!file) error = `队列文件格式不对：${queuePath}`;
  } catch {
    error = `还没生成过风险队列（${TAGS[tier] ?? tier}，${identity.layout} 布局）。先在管线里跑「风险队列」那一步。`;
  }
  let events: DecisionEvent[] = [];
  try {
    events = parseDecisionLog(await io.read(R.decision())).events;
  } catch {
    /* 有意兜底：还没有任何决定记录＝这本还没开过工，是常态不是错误（与下面两本账同一约定）。 */
  }
  /* ★ `sourceVersion` = **这份队列产物的内容哈希**，不是层级标签。
   * 原来传的是 `A层85` 这类标签，于是决定日志回答不了"这条决定是对着哪一版做的"——
   * 一个季度后再看，`A层85` 指向的那份稿早被改过很多次了。
   * 队列是教师这一轮**实际在看的东西**，它的哈希就是"这一轮复核对着哪一版"，
   * 而且整个会话里稳定（不会每改一句就换一次，那样反而查不动）。
   * 更精确的"哪一章的哪一版"由版本节点的 `parentHash`/`contentHash` 回答。 */
  const sourceVersion = queueText ? contentHash(queueText) : paths.sourceVersion;
  return { file, events, error, identity, sourceVersion };
}

/** 追加一条不可变事件（读→拼接→写；事件日志只增不改）。路径按清单布局解析。 */
export async function appendDecision(paths: ProjectPaths, tier: string, event: DecisionEvent, id?: RunIdentity): Promise<void> {
  if (!io) throw new Error('面板 IO 未注入');
  const identity = id ?? (await loadRunIdentity(paths, { teacher: event.teacherId, tier: TAGS[tier] ?? tier }));
  const path = pathsFor(paths, identity, tier).decision();
  let prev: string;
  try {
    prev = await io.read(path);
  } catch {
    /* 有意兜底：还没有决定日志＝这就是第一条决定，从空串接着写。 */
    prev = '';
  }
  await io.write(path, prev + toDecisionLine(event));
}

/* ────────────────────── 工作台：暂停点那本账（IO） ────────────────────── */

/**
 * 暂停点写在**与决定日志并列的另一本 append-only 账**里（`_决定/工作台_<层>.jsonl`），
 * **不写进决定日志**。为什么：决定日志是共享账本，`tools/af_pipeline/LayerText_AF决定汇总.mjs`
 * 会整份读它去算误报率 / 撤销率 / 执行失败率 / 前 10 次操作的切分——
 * 「暂停」不是"教师就某条队列项做的决定"，混进去会把阶段 2 点名要的那几个指标的分母挤偏，
 * 还会让 `contestedItems` 把一个 `session-pause` 当成"反复改主意的队列项"报出来。
 * 那条工具链不在本次改动的文件范围内，改不动也验证不了——所以宁可多一本小账。
 * 完整理由见 `src/core/workbench.ts` 里 `WorkbenchMarker` 的注释。
 *
 * 路径：目录取自解析器（= 决定日志所在的那个目录），**不自己拼目录**，只多一个文件名；
 * 层级带进文件名，否则 A 层与 M 层的暂停点会互相覆盖。
 */
export function workbenchLogPath(paths: ProjectPaths, identity: RunIdentity, tier: string): string {
  return `${dirOfPath(pathsFor(paths, identity, tier).decision())}/工作台_${TAGS[tier] ?? tier}.jsonl`;
}

/** 读暂停点账本。读不到 = 从来没暂停过，是常态不是错误（与决定日志同一约定）。 */
export async function loadWorkbenchMarkers(paths: ProjectPaths, tier: string, id?: RunIdentity): Promise<WorkbenchMarker[]> {
  if (!io) return [];
  const identity = id ?? (await loadRunIdentity(paths, { tier: TAGS[tier] ?? tier }));
  try {
    return parseWorkbenchLog(await io.read(workbenchLogPath(paths, identity, tier))).markers;
  } catch {
    /* 有意兜底：读不到暂停点账本＝从来没暂停过，是常态不是错误（与决定日志同一约定）。 */
    return [];
  }
}

/** 追加一条暂停/恢复标记。有原子追加就用它——读全文再写回去会在两个人同时按暂停时丢一条。 */
export async function appendWorkbenchMarker(paths: ProjectPaths, tier: string, marker: WorkbenchMarker, id?: RunIdentity): Promise<void> {
  if (!io) throw new Error('面板 IO 未注入');
  const identity = id ?? (await loadRunIdentity(paths, { teacher: marker.teacherId, tier: TAGS[tier] ?? tier }));
  const path = workbenchLogPath(paths, identity, tier);
  const line = toWorkbenchLine(marker);
  if (io.append) {
    await io.append(path, line);
    return;
  }
  let prev = '';
  try {
    prev = await io.read(path);
  } catch {
    /* 有意兜底：还没有这本账＝第一次暂停，从空串接着写。 */
  }
  await io.write(path, prev + line);
}

/* ────────────────────── DOM 渲染 ────────────────────── */

const esc = (s: string): string => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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
  /**
   * 注入时钟（可选；不传就是真实时间）。**只用来给事件盖时间戳与显示"今天是哪天"**，
   * 不参与任何判定——任务状态是 (队列 + 决定日志) 的纯函数，与"现在几点"无关。
   * 存在的理由只有一个：验收要断言"暂停 10 分钟后重新打开还是同一批任务"，
   * 真睡 10 分钟的测试不叫测试。
   */
  now?: () => Date;
}

/**
 * 渲染「风险队列」页：一条问题一张卡，按 风险 = 概率 × 后果 排序。
 * 每张卡给：原句 / 改写句 / 上下文各一句 / 触发规则 / 位置，加三个决定按钮。
 * 按钮只写事件日志（不可变），不改书稿——改书稿仍走既有的标记/建议通道。
 */
export async function renderRiskPane(
  input: RiskRenderInput,
  /** 上一次动作失败留在页首的说明（`{itemId}` 用于把那张卡标红，让它看起来"还在待办里"）。
   *  `hint` 是括号里那句补充：动作失败与"暂停期间状态变了"要用不同的话，不能共用一句。 */
  flash?: { itemId: string; text: string; hint?: string },
): Promise<{ ok: boolean; message: string }> {
  const el = input.dom.getElementById('pane-risk');
  if (!el) return { ok: false, message: '缺 pane-risk 容器' };
  const { file, events, error, identity, sourceVersion } = await loadRiskQueue(input.paths, input.tier, undefined, input.teacherId);
  /* 本面板**所有**决定都带这一轮的产物版本（不是层级标签）——统一在入口换一次，
   * 下游不必各自记得换，也就不会出现"有的决定有版本、有的没有"。 */
  const paths: ProjectPaths = { ...input.paths, sourceVersion };
  // 下游（动作 / 撤销 / 批量）都用 `input.paths`——在这里换一次，免得每个调用点各自记得换
  input = { ...input, paths };
  if (!file) {
    el.innerHTML = `<div class="empty"><b>还没有风险队列</b><br/>${esc(error ?? '')}<br/><span style="font-size:12px">在管线里跑「风险队列」那一步即可生成（<code>node tools/af_pipeline/LayerText_AF风险队列.mjs --tier A</code>）</span></div>`;
    return { ok: false, message: error ?? '没有队列' };
  }
  const budget = input.budget ?? 60;
  /* "现在"从这里进：面板自己**不取**系统时间，全部走 `input.now`——
   * 一是测试要能造"10 分钟后重新打开"，二是显示用的日期与写进账本的时间戳必须同源。 */
  const now = input.now?.() ?? new Date();
  /* 打开队列记一条事件（算"首次点击到可采纳结果的时间"要用）。
   * 只在**这一天还没记过**时写：面板每次重渲染都写一条的话，日志会被灌满，指标也就没意义了。
   * 判据改成 `dayOf`（本地日）：原来用的是 UTC 日的字符串切片，
   * 于是"今天开工时欠多少条"在夜里会算到前一天去。 */
  if (!input.skipSessionOpen && !events.some((e) => e.itemId === 'session-open' && dayOf(e.timestamp) === dayOf(now))) {
    try {
      const opened = sessionOpenEvent({
        tier: input.tier,
        teacherId: input.teacherId,
        sourceVersion: input.paths.sourceVersion,
        pending: pendingItems(file, events).length,
        timestamp: now.toISOString(),
      });
      await appendDecision(input.paths, input.tier, opened, identity);
      /* 刚写的这一条要进本屏的 `events`：否则"今天开工时欠多少条"在**当天第一次打开**时
       * 永远显示"还没有记录"——那个数就在这条事件的 reason 里，而这一屏正是它刚写的时候。 */
      events.push(opened);
    } catch {
      /* 有意兜底：开工事件记不上不影响用队列——`productMetrics` 会明说
       * "首次上手时间：缺 session-open 或还没有任何采纳，算不出来（不是 0）"，
       * 也就是说这个失败在这块面板上是**看得见**的，不是靠这句注释自证。 */
    }
  }
  const stat = panelStat(file, events, budget);
  const left = pendingItems(file, events);
  const done = decidedRows(file, events);
  const groups = groupQueue(left, { mutatingRules: MUTATING_RULES });
  const session = sessionState(left, groups);
  // 可观测产品指标（v4 报告「系统性偏差」一节）：全部从已有事件日志算出来，不新增埋点
  const pm = productMetrics(events);
  const planned = oneHourPlan({ items: file.队列, summary: file.摘要 }, budget);
  /* ★ 任务工作台（阶段 2）：**任务状态现算**，绝不是"读暂停时存下来的那份快照"。
   * `markers` 只提供"教师上次停在哪、那时是什么样"，用来**比对**（同一状态吗）。 */
  const markers = await loadWorkbenchMarkers(input.paths, input.tier, identity);
  const wbOpts = { now, groups: { mutatingRules: MUTATING_RULES } };
  /* `resume.state` 就是"现在要办什么"（现算的）。下面不再另算一份——
   * 同一屏里出现两个"待办数"正是这一批要修的那类毛病。 */
  const resume = resumeCheck(file.队列, events, markers, wbOpts);
  const today = todayTasks(file.队列, events, wbOpts);
  const history = historyRows(file.队列, events);
  const explain = explainState(file.队列, events);

  /* 今日任务：它**不是**日历、**不是**截止时间（说明文字与 `workbench.ts` 里那句同源） */
  const todayBar = `<div class="rq-today">${esc(today.text)}</div><div class="rq-hint">${esc(today.disclaimer)}</div>`;
  /* 暂停 / 恢复入口。暂停只记一笔"我停在这儿"，**待办一条不动**——
   * 状态由队列 + 决定日志现算，所以 10 分钟后（或 10 天后）重新打开必然是同一批任务。 */
  const wbBar = `<div class="rq-wb">
      ${resume.paused ? `<button class="rq-btn rq-btn-resume" data-workbench="resume">▶ 继续（回到同一任务状态）</button>` : `<button class="rq-btn rq-btn-pause" data-workbench="pause">⏸ 暂停（记住我停在哪）</button>`}
      <span class="rq-hint">${resume.paused ? `⏸ 已暂停 · ${esc(resume.text)}${resume.cursorNote ? `｜${esc(resume.cursorNote)}` : ''}` : '暂停只记一笔"我停在这儿"，待办一条不动；过一会儿重新打开仍是同一批任务。'}</span>
    </div>`;
  /* 变更历史：**逐轮**，不是最新一条。「已判记录」看的是最新一条，那是另一个问题。 */
  const historyItem = (h: ItemHistory): string => `
      <div class="rq-history-item">
        <div class="rq-history-head">${esc(h.item ? `${h.item.segLabel} · ${h.item.title}` : h.itemId)} <span class="rq-history-now">现在：${h.settled ? '已决' : '待办'}</span></div>
        ${h.rounds
          .map(
            (r) =>
              `<div class="rq-history-round${r.undone ? ' rq-history-undone' : ''}">第 ${r.round} 轮 ${esc(r.label)}${r.undoesRound ? `（作废第 ${r.undoesRound} 轮）` : ''}${r.undoneByRound ? `（已被第 ${r.undoneByRound} 轮撤销）` : ''}：${esc(r.before || '（空）')} → ${esc(r.after || '（空）')}${r.version ? ` · 版本 ${esc(r.version)}` : ''}</div>`,
          )
          .join('')}
      </div>`;
  const historyBar = history.length
    ? `<details class="rq-history"><summary>变更历史（${history.length} 项 · ${history.reduce((n, h) => n + h.rounds.length, 0)} 条事件，逐轮列出）</summary>
        <div class="rq-explain">${esc(explain.line)}</div>
        <div class="rq-history-list">${history.slice(0, 20).map(historyItem).join('')}</div>
        ${history.length > 20 ? `<div class="rq-hint">还有 ${history.length - 20} 项没列出来（按最近一条决定倒序，只列前 20 项）</div>` : ''}
      </details>`
    : '';

  const head = `
    <div class="rq-head">
      <div class="rq-title">风险队列 · ${esc(input.tier)} 层${file.书名 ? ` · ${esc(file.书名)}` : ''}</div>
      <div class="rq-stat">
        共 <b>${stat.total}</b> 条｜待办 <b>${stat.pending}</b>｜已决 <b>${stat.decided}</b>｜不可完成 <b>${stat.blocked}</b>
        ｜估时 <b>${stat.estimatedMinutes}</b> 分钟${stat.overBudget ? '（<b class="rq-over">超预算</b>）' : ''}
        ｜误报率 <b>${(stat.falsePositiveRate * 100).toFixed(0)}%</b>
        ${stat.unfinished ? `｜<b class="rq-over">未完成段落 ${stat.unfinished}</b>` : ''}
      </div>
      <div class="rq-advice">${esc(stat.advice)}｜路径布局 <b>${esc(identity.layout)}</b>${identity.runId ? `（${esc(identity.runId)}）` : ''}${identity.source ? `｜身份来源 <b>${esc(identity.source)}</b>` : ''}</div>
      ${lastIdentityWarning ? `<div class="rq-flash">⚠ ${esc(lastIdentityWarning)}</div>` : ''}
      <div class="rq-session ${session.done ? 'rq-session-done' : ''}">${esc(session.text)}</div>
      <div class="rq-taskdone">
        ${taskDoneToday(events, now) ? `<span class="rq-hint">✓ 今天已标记「我做完了」（${esc(taskDoneToday(events, now)!.timestamp.slice(11, 16))}）——再点一次不会重复记</span>` : `<button class="rq-btn" data-taskdone="1" title="教师自己说'这一轮到此为止'。没有它，完成时间只能靠待办条数去推断，而推断出来的时间不该冒充事实">✓ 我做完了</button>`}
      </div>
      ${wbBar}
      ${todayBar}
      ${pm.decisions ? `<details class="rq-metrics"><summary>我这边用得怎么样（产品指标）</summary><ul>${pm.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></details>` : ''}
      <details class="rq-budget">
        <summary>本次预算怎么排（后台估算，不是任务模型）</summary>
        <div class="rq-plan">${planned.phases.map((p) => `<span class="rq-phase">${esc(p.title)} ${p.budget}′ / ${p.items.length} 条</span>`).join('')}</div>
        <div class="rq-hint">${esc(planned.advice)}</div>
      </details>
      ${
        done.length
          ? `<details class="rq-done"><summary>看我判过的（${done.length} 条，可撤销）</summary><div class="rq-done-list">${done
              .map(
                (r) => `<div class="rq-done-row${r.undone ? ' rq-done-undone' : ''}">
            <span class="rq-done-label">${esc(r.label)}${r.undone ? '（已撤销）' : ''}</span>
            <span class="rq-done-pos">${esc(r.item.segLabel)}</span>
            <span class="rq-done-title">${esc(r.item.title)}</span>
            ${r.undone ? '' : `<button class="rq-btn rq-undo" data-undo="${esc(r.ref)}">↩︎ 撤销</button>`}
          </div>`,
              )
              .join('')}</div></details>`
          : ''
      }
      ${historyBar}
    </div>`;

  if (!file.队列.length) {
    el.innerHTML = `${head}<div class="empty">队列为空——本层没有机器点得出来的风险，可直接抽样阅读。<br/><span style="font-size:12px">${esc(POSITIONING_LINE)}</span></div>`;
    return { ok: true, message: '队列为空' };
  }
  if (!left.length) {
    el.innerHTML = `${head}<div class="empty">队列已全部处理完（共 ${stat.total} 条）。历史决定一条没删，可随时回头改。</div>`;
    return { ok: true, message: '已全部处理' };
  }

  const flashBar = flash ? `<div class="rq-flash">⚠ ${esc(flash.text)} <span style="color:var(--muted)">（${esc(flash.hint ?? '这一条仍在待办里，正文没有改动')}）</span></div>` : '';
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
  const groupHtml = (g: TaskGroup, gi: number): string => {
    /* ★ 「批量动作前能列出将改变的词/段」（阶段 2 验收）。
     * 原来这里只有 `batchImpact` 一行计数——"改动 3 处、涉及 2 段、1 章"，
     * 教师按下去之前**看不到究竟要改哪几个词、哪几段**。
     * 预览默认折叠：它不该抢走卡片的注意力，但你按按钮之前一定能打开看。 */
    const pv = batchPreview(g);
    const preview =
      pv.batchable && pv.lines.length
        ? `<details class="rq-preview"><summary>⚡ 将改动 ${pv.lines.length} 处——点开看具体改哪些词、哪些段</summary><ul>${pv.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></details>`
        : '';
    return `
    <section class="rq-group" data-group="${esc(g.id)}">
      <div class="rq-group-head">
        <span class="rq-rank">${gi + 1}</span>
        <span class="rq-group-title">${esc(g.title)}</span>
        <span class="rq-group-count">${g.count} 条</span>
        <span class="rq-group-rules">${esc(g.rules.join('、'))}</span>
        ${g.uniformAction ? `<button class="rq-btn rq-btn-batch" data-batch="${esc(g.id)}" title="${esc(batchImpact(g))}">⚡ 全部应用（${g.actionable} 处）</button>` : ''}
      </div>
      <div class="rq-group-impact">${esc(batchImpact(g))}</div>
      ${preview}
      ${g.samples.map(card).join('')}
      ${g.count > g.samples.length ? `<details class="rq-more"><summary>展开这一组其余 ${g.count - g.samples.length} 条</summary>${g.items.slice(g.samples.length).map(card).join('')}</details>` : ''}
    </section>`;
  };

  el.innerHTML = `${head}${flashBar}<div class="rq-list">${groups.map(groupHtml).join('')}</div>`;

  /* 「我做完了」：**一天只记一条**（与 session-open 同一条纪律）——
   * 重复记会让"完成时间"变成"最后一次点它的时间"。 */
  for (const btn of Array.from(input.dom.querySelectorAll('#pane-risk [data-taskdone]'))) {
    btn.addEventListener('click', async (ev) => {
      (ev.currentTarget as HTMLElement).setAttribute('disabled', 'true');
      try {
        const settledCount = file.队列.filter((it) => !pendingItems(file, events).some((p) => p.id === it.id)).length;
        /* 任务指纹用**本轮范围**（层+章+队列条数）——它不是"模型实验"那种严格快照，
         * 而是"教师点下这一下时，他面对的是哪一批活"。 */
        const taskHash = contentHash(`${input.tier}|${file.章节.join(',')}|${file.队列.length}`);
        await appendDecision(
          input.paths,
          input.tier,
          taskDoneEvent({
            taskHash,
            teacherId: input.teacherId,
            sourceVersion: input.paths.sourceVersion,
            tier: input.tier,
            settled: settledCount,
            timestamp: (input.now?.() ?? new Date()).toISOString(),
          }),
          identity,
        );
        await renderRiskPane({ ...input, skipSessionOpen: true });
      } catch (e) {
        // 记不上就要说——但**不重渲染**：重渲染会盖住这条说明（历史缺陷 #4）
        await renderRiskPane({ ...input, skipSessionOpen: true }, { itemId: '', text: `「我做完了」没能记上：${e instanceof Error ? e.message : String(e)}` });
      }
    });
  }
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
      void appendDecision(input.paths, input.tier, decisionLineFor(it, kind, { teacherId: input.teacherId, sourceVersion: input.paths.sourceVersion }), identity).then(() =>
        renderRiskPane({ ...input, skipSessionOpen: true }),
      );
    });
  }
  // 暂停 / 恢复：往**工作台那本账**追加一条标记。待办一条不动——状态是现算的，不是存出来的。
  for (const btn of Array.from(input.dom.querySelectorAll('#pane-risk [data-workbench]'))) {
    btn.addEventListener('click', (ev) => {
      const kind = (ev.currentTarget as HTMLElement).getAttribute('data-workbench');
      if (kind !== 'pause' && kind !== 'resume') return;
      (ev.currentTarget as HTMLElement).setAttribute('disabled', 'true');
      void (async () => {
        /* ★ 点下去的这一刻**从盘上重读一遍**再算，而不是复用渲染时那份内存里的日志：
         * 教师完全可能在暂停期间被别的窗口/别的教师/命令行改过队列，
         * "现算"要是拿的是一份旧内存，那它算出来的就不是"现在"，比对也就白比了。 */
        const fresh = await loadRiskQueue(input.paths, input.tier, identity, input.teacherId);
        const rows = fresh.file?.队列 ?? file.队列;
        const cur = taskStateOf(rows, fresh.events, { mutatingRules: MUTATING_RULES });
        const before = currentPause(markers);
        const drift = kind === 'resume' && before ? pausedDrift(before, cur, rows) : [];
        const at = (input.now?.() ?? new Date()).toISOString();
        const common = { teacherId: input.teacherId, sourceVersion: input.paths.sourceVersion, tier: input.tier, state: cur, timestamp: at };
        const marked = kind === 'pause' ? pauseMarker(common) : resumeMarker(common);
        await appendWorkbenchMarker(input.paths, input.tier, marked, identity);
        /* 恢复到"不一样"的状态时**必须当场说**：那种情况下"回到同一任务状态"这句话不成立，
         * 而教师最需要知道的正是这件事（有人在他暂停期间动过队列）。 */
        const flash = drift.length ? { itemId: '', text: `你暂停之后任务状态变了：${drift.join('；')}`, hint: '待办列表已按最新的日志重算；历史一条没删' } : undefined;
        await renderRiskPane({ ...input, skipSessionOpen: true }, flash);
      })().catch(() => renderRiskPane({ ...input, skipSessionOpen: true }, { itemId: '', text: '暂停点没记上（写日志失败）——待办没有变，重试即可', hint: '账本写不进去，但队列与决定都没动' }));
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

/** 事务用的 IO 端口：就是面板那个 IO，只做类型适配——**不另开一套读写** */
const txIo = (): TxIo => {
  if (!io) throw new Error('面板 IO 未注入');
  const real = io;
  return {
    read: (p) => real.read(p),
    write: (p, c) => real.write(p, c),
    append: real.append ? (p, l) => real.append!(p, l) : undefined,
    backup: real.backup ? (p, c) => real.backup!(p, c) : undefined,
    now: () => new Date().toISOString(),
  };
};

/**
 * 面板改稿时的公共入参：路径**全部**由 `makeResolver` 解析（面板不拼目录）。
 *
 * `baseVersion` 是这么算出来的：读版本日志 + 读正文 → `currentVersionOf`。
 * 它不是"上一次我看到的那个版本号"的缓存——那正是两个人同时改一章时互相覆盖的成因。
 * 每次都从盘上现算，于是"我看到的东西"与"盘上的东西"对不上时事务会当场拒绝。
 */
async function txTargetFor(paths: ProjectPaths, identity: RunIdentity, tier: string, docPath: string): Promise<{ versionPath: string; decisionPath: string; baseVersion: string; doc: string } | null> {
  const R = pathsFor(paths, identity, tier);
  let doc: string;
  try {
    doc = await io!.read(docPath);
  } catch {
    /* 有意兜底：读不到正文＝这条动作没有"当前版本"可谈，交回 null 让上游把话说清楚——
     * 两处调用点已经写成了 rejected 事件 / "读不到正文，未撤销"，所以这里是交接，不是静默。 */
    return null;
  }
  /* 有意兜底：版本日志还没有＝这本书还没改过（缺失文件本来就是报错的），
   * baseVersion 于是按当前正文自身算；真与账本对不上时 applyChange 会当场拒绝并记 rejected。 */
  const log = await io!.read(R.version()).catch(() => '');
  return {
    versionPath: R.version(),
    decisionPath: R.decision(),
    baseVersion: currentVersionOf(parseVersionLog(log).nodes, doc),
    doc,
  };
}

/** 今天这条「我做完了」标记（没有就返回 null）。**只认今天**：完成时间说的是"今天这一轮"。 */
function taskDoneToday(events: DecisionEvent[], now: Date): DecisionEvent | null {
  return events.find((e) => e.itemId === TASK_DONE && dayOf(e.timestamp) === dayOf(now)) ?? null;
}

/** 风险项 → 版本节点要记的位置（段号、章、规则、项 ID） */
const versionTargetOf = (it: RiskItem, chapter: string): VersionTarget => ({
  segId: segIdOf(it),
  chapter,
  ruleId: it.ruleId,
  itemId: it.id,
  word: typeof it.detail?.word === 'string' ? it.detail.word : undefined,
});

/** 该动作需要的"释义"从哪来：优先统一词典，退而取风险项 detail 里带的 */
function glossFor(it: RiskItem, dict: Map<string, string>): string {
  const d = it.detail ?? {};
  const word = typeof d.word === 'string' ? d.word : '';
  if (typeof d.expected === 'string' && d.expected) return d.expected;
  if (word && dict.get(word.toLowerCase())) return dict.get(word.toLowerCase())!;
  if (typeof d.zh === 'string' && d.zh) return d.zh;
  return '';
}

/** 事务结果 → 面板要的 `{ok, message}`。**失败时正文一定没变**（`docTouched` 是唯一的例外，且必须炸出来） */
const toPanelResult = (r: ChangeResult): { ok: boolean; message?: string } =>
  r.status === 'applied'
    ? { ok: true, message: r.message }
    : r.docTouched
      ? /* 回滚也失败了：稿子可能已经变了。这**不能**混在普通失败里悄悄过去 */
        { ok: false, message: `⚠ ${r.reason}——请立刻核对正文（这一条不计入已处理）` }
      : { ok: false, message: r.reason };

/**
 * 执行一个风险动作。
 *
 * 走的是**引擎里唯一那个写正文的事务**（`src/core/version.ts` 的 `applyChange`），
 * 面板不再自己 read→write。那条事务里做齐了四件事：
 *   ① 核对 `baseVersion`（别人先改过就拒，**一个字符都不写**）
 *   ② 跑动作、过闸（门禁没过也不写）
 *   ③ 写正文
 *   ④ 写版本节点（带父版本）+ 决定事件（带 version / eventId，两本账互为外键）
 * 任一步不成立就只写一条 `rejected` 事件，**卡片留在队列里**——
 * 绝不允许"卡片消失了、正文没变"这种两头空。
 */
async function runRiskAction(input: RiskRenderInput, file: RiskQueueFile, identity: RunIdentity, it: RiskItem): Promise<{ ok: boolean; message?: string }> {
  const action: RuleAction = actionOf(it.ruleId);
  const d = it.detail ?? {};
  const word = typeof d.word === 'string' ? d.word : typeof d.signal === 'string' ? d.signal : '';
  const chapter = it.chapter;
  // 优先用队列里记的真实路径；没有才退回解析器（并说明这次是推出来的）
  const docPath = file.章节产物?.[chapter] ?? pathsFor(input.paths, identity, input.tier).any('正文', { chapter });

  const common = {
    runId: identity.runId || `legacy-${input.tier}`,
    docPath,
    teacherId: input.teacherId,
    sourceVersion: input.paths.sourceVersion,
    target: versionTargetOf(it, chapter),
  } as const;

  try {
    const t = await txTargetFor(input.paths, identity, input.tier, docPath);
    if (!t) {
      // 正文读不到：没有"当前版本"可谈，用 `recordOnly` 写一条 rejected——
      // 事件照样留痕、卡片照样留在待办里，**绝不静默**
      const R = pathsFor(input.paths, identity, input.tier);
      await recordOnly(txIo(), {
        ...common,
        baseVersion: 'unreadable',
        versionPath: R.version(),
        decisionPath: R.decision(),
        action,
        decision: 'rejected',
        reason: `读不到正文（${docPath}）——产物可能被移动或删除了`,
      });
      return { ok: false, message: `读不到正文（${docPath}）——产物可能被移动或删除了` };
    }

    // 纯表态的动作（事实类"认可"、结构类"手动处理"）：不改正文，只记事件。
    // **仍然走同一个入口**，所以它同样核对 baseVersion、同样回答"当时是哪一版"。
    if (!action.mutates) {
      return toPanelResult(
        await recordOnly(txIo(), {
          ...common,
          baseVersion: t.baseVersion,
          versionPath: t.versionPath,
          decisionPath: t.decisionPath,
          action,
          decision: 'accept',
          reason: action.effect,
        }),
      );
    }

    const dict = await loadBookDict(input.paths);
    return toPanelResult(
      await applyChange(txIo(), {
        ...common,
        baseVersion: t.baseVersion,
        versionPath: t.versionPath,
        decisionPath: t.decisionPath,
        action,
        word,
        zh: glossFor(it, dict),
        removeAll: d.crossSegment === true,
      }),
    );
  } catch (e) {
    // 事务本身抛了（IO 未注入之类）——如实报，卡片留着
    return { ok: false, message: `执行失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * 撤销一条决定。
 *
 * 两件事，一个事务（走 `applyChange`，动作是 `revert`）：
 *   ① 如果被撤销的是**改稿动作**，把当初那一处原样换回去
 *      （`from` 必须仍在**原来的那一段**里，否则事务拒绝并且**不写 undo 事件**——
 *       宁可撤销失败，也不留下假账）；
 *   ② 写一条 `undo` 事件（`undoOf` 指回被撤销的那条）——**历史一条都不删**。
 *
 * 与旧实现的差别有两处，都是真缺陷：
 *   · 旧实现把正文改回去用的是 `doc.replace(after, before)`——**全篇**替换，
 *     会顺手改到别的段里恰好相同的那一处。现在只在那一段里换（`revertInSegment`）。
 *   · 旧实现自己 read→write，没有版本节点。现在撤销也是一次带父版本的正文改动。
 */
async function undoDecision(input: RiskRenderInput, file: RiskQueueFile, identity: RunIdentity, ref: string): Promise<{ ok: boolean; message?: string }> {
  const all = (await loadRiskQueue(input.paths, input.tier, identity)).events;
  const target = all.find((e) => refOf(e) === ref);
  if (!target) return { ok: false, message: '找不到要撤销的那条决定（可能已被撤销过）' };
  if (target.decision === 'undo') return { ok: false, message: '撤销事件本身不能再撤销' };

  const it = file.队列.find((x) => x.id === target.itemId);
  const action = it ? actionOf(it.ruleId) : null;
  const chapter = it?.chapter ?? target.chapter ?? '';
  const docPath = it ? (file.章节产物?.[chapter] ?? pathsFor(input.paths, identity, input.tier).any('正文', { chapter })) : '';
  const runId = identity.runId || `legacy-${input.tier}`;

  const t = docPath ? await txTargetFor(input.paths, identity, input.tier, docPath) : null;
  if (!t) return { ok: false, message: `读不到正文，未撤销（${docPath || '队列里没记产物路径'}）` };

  /* 纯表态的动作（没改过正文）：只写 undo 事件，不动正文，也不产生版本节点。 */
  if (!it || !action?.mutates || !target.after || target.after === target.before) {
    return toPanelResult(
      await recordOnly(txIo(), {
        runId,
        baseVersion: t.baseVersion,
        docPath,
        versionPath: t.versionPath,
        decisionPath: t.decisionPath,
        teacherId: input.teacherId,
        sourceVersion: input.paths.sourceVersion,
        target: { segId: it ? segIdOf(it) : 'P01', chapter, itemId: target.itemId, ruleId: target.ruleIds[0] },
        action: REVERT_ACTION,
        decision: 'undo',
        undoesEvent: ref,
        reason: `撤销 ${DECISION_LABEL[target.decision] ?? target.decision}（${target.timestamp}）`,
      }),
    );
  }

  return toPanelResult(
    await applyChange(txIo(), {
      runId,
      baseVersion: t.baseVersion,
      docPath,
      versionPath: t.versionPath,
      decisionPath: t.decisionPath,
      teacherId: input.teacherId,
      sourceVersion: input.paths.sourceVersion,
      target: { segId: segIdOf(it), chapter, itemId: target.itemId, ruleId: target.ruleIds[0] },
      action: REVERT_ACTION,
      decision: 'undo',
      undoesEvent: ref,
      from: target.after,
      to: target.before,
    }),
  );
}

/**
 * 批量应用一个组。
 *
 * 报告第 3 条要的"全部应用"在这里落地。语义上它**不是**"把 N 条一次记完"，
 * 而是"把同一类改动一次做完"——所以：
 *   · 逐条执行**同一个** `applyAction`（经 `applyChangeBatch`，不另写一条批量路径）；
 *   · 按章聚合、**一章一次事务**（不是在面板里循环调 N 次单条事务）：
 *     一章只读一次、写一次、出一**条**版本节点，事件逐条记；
 *   · 任一条失败**不静默跳过**：那一条写 `rejected`、留在待办，其余照做，最后如实报告几成几败。
 * 返回 `ok` 只在**全部成功**时为真——部分成功也算没做完。
 */
async function runBatchApply(input: RiskRenderInput, file: RiskQueueFile, identity: RunIdentity, group: TaskGroup): Promise<{ ok: boolean; message?: string }> {
  if (!group.uniformAction) return { ok: false, message: '这一组的动作不统一，只能逐条处理' };
  const dict = await loadBookDict(input.paths);
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
    const t = await txTargetFor(input.paths, identity, input.tier, docPath);
    if (!t) {
      failedCount += items.length;
      if (!firstError.length) firstError.push(`读不到正文（${docPath}）`);
      continue;
    }
    const r = await applyChangeBatch(txIo(), {
      runId: identity.runId || `legacy-${input.tier}`,
      baseVersion: t.baseVersion,
      docPath,
      versionPath: t.versionPath,
      decisionPath: t.decisionPath,
      teacherId: input.teacherId,
      sourceVersion: input.paths.sourceVersion,
      // 批量来源必须留痕：事后分得清"我一条条点的"还是"我按了全部应用"
      reasonPrefix: '批量',
      steps: items.map((it) => ({
        target: versionTargetOf(it, chapter),
        action: actionOf(it.ruleId),
        word: typeof it.detail?.word === 'string' ? it.detail.word : '',
        zh: glossFor(it, dict),
        removeAll: it.detail?.crossSegment === true,
      })),
    });
    if (r.status === 'applied') {
      doneCount += r.applied;
      failedCount += r.rejected;
      if (r.rejected && !firstError.length) firstError.push(r.rejectedItems[0]?.reason ?? '有若干条未能执行');
    } else {
      failedCount += r.applied + r.rejected || items.length;
      if (!firstError.length) firstError.push(r.reason);
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
    /* 有意兜底：读不到＝空词典；补注动作会因此被拒并说明原因（"未带词典"），不静默 */
  }
  return out;
}

// Compatibility exports: callers keep importing these helpers from risk.ts.
export { itemMinutes, countByCategory, ruleLabel } from './risklogic.js';
