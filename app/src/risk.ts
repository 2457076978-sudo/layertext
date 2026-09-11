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

import { buildProposals, decisionIndex, makeDecisionEvent, parseDecisionLog, summarizeDecisions, toDecisionLine, type DecisionEvent, type DecisionKind } from '../../src/core/decision.js';
import { oneHourPlan, type RiskItem, type RiskQueue } from '../../src/core/riskqueue.js';
import { GATE_RULES, type GateCategory } from '../../src/core/segmentgate.js';

export interface RiskIo {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  listDir(dir: string): Promise<string[]>;
  exists?(path: string): Promise<boolean>;
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

/** 队列里还有哪些没被决定过（决定过的从待办里消失，但历史事件一条不删） */
export function pendingItems(file: RiskQueueFile, events: DecisionEvent[]): RiskItem[] {
  const decided = decisionIndex(events);
  return file.队列.filter((it) => !decided.has(it.id));
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

/** 这条决定针对什么——离线汇总器靠它决定"该提议进哪里"（词典/词表例外/改写模板） */
export function subjectOf(item: RiskItem): { kind: 'word' | 'number' | 'proper' | 'sentence' | 'other'; value: string } {
  const d = item.detail ?? {};
  const word = typeof d.word === 'string' ? d.word : '';
  if (word) return { kind: 'word', value: word };
  const signal = typeof d.signal === 'string' ? d.signal : '';
  if (signal) return /^\d/.test(signal) ? { kind: 'number', value: signal } : { kind: 'proper', value: signal };
  if (item.ruleId === 'SENT-01' || item.ruleId === 'LEN-01') return { kind: 'sentence', value: item.rewrittenSentence || item.id };
  return { kind: 'other', value: item.id };
}

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
  const decided = decisionIndex(events);
  const items = file.队列;
  const pending = items.filter((it) => !decided.has(it.id) || decided.get(it.id)!.decision !== 'accept');
  // 计时按"还没处理掉的"算：已经采纳的不该继续占用人工预算
  const remainingMinutes = pending
    .filter((it) => !decided.has(it.id))
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
}

export async function loadRiskQueue(paths: ProjectPaths, tier: string): Promise<{ file: RiskQueueFile | null; events: DecisionEvent[]; error?: string }> {
  if (!io) return { file: null, events: [], error: '面板 IO 未注入' };
  const tag = TAGS[tier] ?? tier;
  let file: RiskQueueFile | null = null;
  let error: string | undefined;
  try {
    file = parseQueueFile(await io.read(`${paths.outDir}/_运行/风险队列_${tag}.json`));
    if (!file) error = `队列文件格式不对：_运行/风险队列_${tag}.json`;
  } catch {
    error = `还没生成过风险队列（${tag}）。先在管线里跑「风险队列」那一步。`;
  }
  let events: DecisionEvent[] = [];
  try {
    events = parseDecisionLog(await io.read(`${paths.workDir}/_决定/${tag}.jsonl`)).events;
  } catch {
    /* 还没有任何决定——这是正常的，不是错误 */
  }
  return { file, events, error };
}

/** 追加一条不可变事件（读→拼接→写；事件日志只增不改） */
export async function appendDecision(paths: ProjectPaths, tier: string, event: DecisionEvent): Promise<void> {
  if (!io) throw new Error('面板 IO 未注入');
  const tag = TAGS[tier] ?? tier;
  const path = `${paths.workDir}/_决定/${tag}.jsonl`;
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
}

/**
 * 渲染「风险队列」页：一条问题一张卡，按 风险 = 概率 × 后果 排序。
 * 每张卡给：原句 / 改写句 / 上下文各一句 / 触发规则 / 位置，加三个决定按钮。
 * 按钮只写事件日志（不可变），不改书稿——改书稿仍走既有的标记/建议通道。
 */
export async function renderRiskPane(input: RiskRenderInput): Promise<{ ok: boolean; message: string }> {
  const el = input.dom.getElementById('pane-risk');
  if (!el) return { ok: false, message: '缺 pane-risk 容器' };
  const { file, events, error } = await loadRiskQueue(input.paths, input.tier);
  if (!file) {
    el.innerHTML = `<div class="empty"><b>还没有风险队列</b><br/>${esc(error ?? '')}<br/><span style="font-size:12px">在管线里跑「风险队列」那一步即可生成（<code>node tools/af_pipeline/LayerText_AF风险队列.mjs --tier A</code>）</span></div>`;
    return { ok: false, message: error ?? '没有队列' };
  }
  const budget = input.budget ?? 60;
  const stat = panelStat(file, events, budget);
  const left = pendingItems(file, events);
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
      <div class="rq-advice">${esc(stat.advice)}</div>
      <div class="rq-plan">${planned.phases.map((p) => `<span class="rq-phase">${esc(p.title)} ${p.budget}′ / ${p.items.length} 条</span>`).join('')}</div>
    </div>`;

  if (!file.队列.length) {
    el.innerHTML = `${head}<div class="empty">队列为空——本层没有机器点得出来的风险，可直接抽样阅读。</div>`;
    return { ok: true, message: '队列为空' };
  }
  if (!left.length) {
    el.innerHTML = `${head}<div class="empty">队列已全部处理完（共 ${stat.total} 条）。历史决定一条没删，可随时回头改。</div>`;
    return { ok: true, message: '已全部处理' };
  }

  const cards = left
    .map(
      (it, i) => `
    <div class="rq-card" data-item="${esc(it.id)}">
      <div class="rq-card-head">
        <span class="rq-rank">${i + 1}</span>
        <span class="rq-rule" title="${esc(ruleLabel(it.ruleId))}">${esc(it.ruleId)}</span>
        <span class="rq-sev rq-sev-${it.severity === 'blocker' ? 'block' : 'warn'}">${SEV_LABEL[it.severity] ?? it.severity}</span>
        <span class="rq-risk">风险 ${it.risk}</span>
        <span class="rq-pos">${esc(it.segLabel)}${it.tier ? `（${esc(it.tier)} 层）` : ''}</span>
      </div>
      <div class="rq-issue">${esc(it.title)}</div>
      <div class="rq-pair">
        <div><span class="rq-lab">原句</span>${esc(it.sourceSentence || '（未定位到原句）')}</div>
        <div><span class="rq-lab">改写</span>${esc(it.rewrittenSentence || '（改写里找不到）')}</div>
        <div class="rq-ctx"><span class="rq-lab">上下文</span>上「${esc(it.context.prev || '—')}」／下「${esc(it.context.next || '—')}」</div>
      </div>
      <div class="rq-actions">
        <button class="rq-btn" data-decide="accept" data-id="${esc(it.id)}">✓ 采纳改写</button>
        <button class="rq-btn" data-decide="reject" data-id="${esc(it.id)}">↺ 退回重写</button>
        <button class="rq-btn" data-decide="false-positive" data-id="${esc(it.id)}">⚑ 标记误报</button>
        <span class="rq-hint">决定只记进事件日志（不可变），改书稿仍走正文里的标记/建议</span>
      </div>
    </div>`,
    )
    .join('');

  el.innerHTML = `${head}<div class="rq-list">${cards}</div>`;

  // 点按钮 = 追加一条不可变事件 → 立刻重渲染（决定过的从待办里消失）
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
      ).then(() => renderRiskPane(input));
    });
  }
  return { ok: true, message: `待办 ${left.length} 条` };
}
