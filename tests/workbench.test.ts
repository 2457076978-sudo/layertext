/**
 * 任务工作台 回归测试（《LayerText工程优化总计划》阶段 2）
 *
 * 验收标准：
 *   「教师可在 10 分钟后暂停，重新打开仍回到同一任务状态」
 *   「撤销连续发生三次时状态仍可解释（若实测需要多级，再升级为版本树）」
 *   「增加今日任务、暂停并恢复、已判记录和变更历史」
 *
 * 这一层是纯逻辑（无 fs、无 DOM、无系统时间）——所以"10 分钟后"是真的造出来的时间差，
 * 不是 `sleep(600000)`；"三次撤销"是六条真事件，不是桩。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeDecisionEvent, type DecisionEvent, type DecisionKind } from '../src/core/decision.js';
import type { RiskItem } from '../src/core/riskqueue.js';
import {
  changeHistory,
  currentPause,
  dayOf,
  diffTaskState,
  digestOf,
  explainState,
  formatGap,
  historyRows,
  isSettled,
  itemHistory,
  latestDecisionMap,
  parseWorkbenchLog,
  pauseMarker,
  pendingOf,
  resumeCheck,
  resumeMarker,
  stateAfterUndos,
  taskStateOf,
  toWorkbenchLine,
  todayTasks,
  undoCountOf,
  undoneEventRefs,
} from '../src/core/workbench.js';

const MUTATING = { mutatingRules: ['ANNO-01', 'ANNO-02', 'ANNO-03', 'AST-02'] };

/** 本地时间的 ISO（测试里写 `'2026-09-11T09:00:00'` 这种"墙上时间"，与 `dayOf` 同一套） */
const iso = (local: string): string => new Date(local).toISOString();
const localDate = (local: string): Date => new Date(local);

const item = (over: Partial<RiskItem> = {}): RiskItem => ({
  id: '第一章#2:ANNO-01:barn',
  ruleId: 'ANNO-01',
  category: '加注',
  severity: 'blocker',
  consequence: 10,
  probability: 1,
  risk: 10,
  chapter: '第一章',
  segIndex: 2,
  segLabel: '第一章 第3段',
  title: '超纲词 barn 没有加注',
  sourceSentence: 'The boy ran to the barn.',
  rewrittenSentence: 'The boy ran to the barn.',
  context: { prev: '', next: '' },
  detail: { word: 'barn' },
  ...over,
});

/** 一个 5 条待办的小队列：3 条同一个词（会聚成一组）+ 2 条别的 */
const ITEMS: RiskItem[] = [
  item({ id: '第一章#0:ANNO-01:barn', segIndex: 0, segLabel: '第一章 第1段' }),
  item({ id: '第一章#1:ANNO-01:barn', segIndex: 1, segLabel: '第一章 第2段' }),
  item({ id: '第一章#2:ANNO-01:barn' }),
  item({ id: '第一章#3:ANNO-02:straw', segIndex: 3, segLabel: '第一章 第4段', ruleId: 'ANNO-02', severity: 'warn', title: '同一个词 straw 注了不止一次', detail: { word: 'straw' } }),
  item({ id: '第一章#4:SENT-01:0', segIndex: 4, segLabel: '第一章 第5段', ruleId: 'SENT-01', category: '语言', title: '改写句 30 词，超过本层上限 20 词', detail: {} }),
];

const ev = (over: Partial<DecisionEvent> & { itemId: string; decision: DecisionKind; timestamp: string }): DecisionEvent =>
  makeDecisionEvent({
    before: '原句',
    after: '改写句',
    reason: '',
    ruleIds: ['ANNO-01'],
    teacherId: 'wayne',
    sourceVersion: 'sha-1',
    book: 'Animal Farm',
    chapter: '第一章',
    ...over,
  });

const undoOf = (target: DecisionEvent, timestamp: string, reason = '我点错了'): DecisionEvent =>
  ev({ itemId: target.itemId, decision: 'undo', timestamp, before: target.after, after: target.before, undoOf: `${target.itemId}@${target.timestamp}`, reason });

/* ────────────────── §一 判定语义与任务状态 ────────────────── */

test('任务状态 = (队列 + 决定日志) 的纯函数：三件事同源，没有第二份口径', () => {
  const a = ev({ itemId: ITEMS[0]!.id, decision: 'accept', timestamp: iso('2026-09-11T09:00:00') });
  const s = taskStateOf(ITEMS, [a], MUTATING);
  assert.deepEqual(
    s.pendingIds,
    ITEMS.slice(1).map((x) => x.id),
    '决定过的从待办里消失',
  );
  assert.equal(s.total, 5);
  assert.equal(s.done, false);
  assert.equal(s.pending.length, s.pendingIds.length);
  assert.deepEqual(
    pendingOf(ITEMS, [a]).map((x) => x.id),
    s.pendingIds,
    'TaskState 与 pendingOf 必须是同一份判定',
  );

  // 全部办完 → 「本次完成」
  const all = ITEMS.map((it, i) => ev({ itemId: it.id, decision: 'reject', timestamp: iso(`2026-09-11T09:${String(10 + i).padStart(2, '0')}:00`) }));
  const fin = taskStateOf(ITEMS, all, MUTATING);
  assert.equal(fin.done, true);
  assert.equal(fin.groupIds.length, 0);
  assert.match(fin.sessionText, /本次完成/);
});

test('★ rejected（动作没执行成）不算办完——引擎与面板同一份判定', () => {
  const failed = ev({ itemId: ITEMS[0]!.id, decision: 'rejected', timestamp: iso('2026-09-11T09:00:00'), reason: '找不到段落 P10' });
  assert.equal(isSettled(latestDecisionMap([failed]).get(ITEMS[0]!.id), undoneEventRefs([failed])), false);
  assert.deepEqual(
    taskStateOf(ITEMS, [failed], MUTATING).pendingIds,
    ITEMS.map((x) => x.id),
    '失败了就还得办',
  );
});

test('diffTaskState：一模一样 → 空数组；差在哪儿逐条说清（这是"同一任务状态"的定义）', () => {
  const s0 = taskStateOf(ITEMS, [], MUTATING);
  assert.deepEqual(diffTaskState(s0, taskStateOf(ITEMS, [], MUTATING)), [], '同样输入必须零差异');

  const a = ev({ itemId: ITEMS[0]!.id, decision: 'accept', timestamp: iso('2026-09-11T09:00:00') });
  const s1 = taskStateOf(ITEMS, [a], MUTATING);
  const d = diffTaskState(s0, s1);
  assert.match(d[0]!, /待办少了 1 条/);
  assert.match(d[0]!, /第一章 第1段/);

  // 分组结果本身变了，也要报出来（不能被"待办少了一条"盖过去）
  const pair = [item({ id: '第一章#0:ANNO-01:barn', segIndex: 0 }), item({ id: '第一章#1:ANNO-01:barn', segIndex: 1, segLabel: '第一章 第2段' })];
  const g0 = taskStateOf(pair, [], MUTATING);
  assert.deepEqual(g0.groupIds, ['word:barn'], '两条同一个词 = 一组');
  const g1 = taskStateOf(pair, [ev({ itemId: pair[0]!.id, decision: 'accept', timestamp: iso('2026-09-11T09:00:00') })], MUTATING);
  assert.deepEqual(g1.groupIds, ['ch:第一章:加注'], '只剩一条 → 聚不成"同一个词"，落回同章同类型');
  assert.match(diffTaskState(g0, g1).join('；'), /任务组从 1 组变成 1 组（聚合结果变了）/, '组数没变、组不一样，也必须说');

  const all = ITEMS.map((it) => ev({ itemId: it.id, decision: 'accept', timestamp: iso('2026-09-11T09:30:00') }));
  assert.match(diffTaskState(s1, taskStateOf(ITEMS, all, MUTATING)).join('；'), /「本次完成」从「还没完」变成「已完成」/);
});

/* ────────────────── §二 暂停 / 恢复（10 分钟后仍是同一任务状态） ────────────────── */

test('★ 暂停 10 分钟后重新打开：待办、组顺序、「本次完成」三件事一模一样', () => {
  const done0 = ev({ itemId: ITEMS[0]!.id, decision: 'accept', timestamp: iso('2026-09-11T09:00:00') });
  const events = [done0];
  const t0 = iso('2026-09-11T09:10:00');

  const atPause = taskStateOf(ITEMS, events, MUTATING);
  const marker = pauseMarker({ teacherId: 'wayne', sourceVersion: 'sha-queue', tier: 'A', state: atPause, timestamp: t0, cursor: ITEMS[1]!.id });
  assert.equal(marker.kind, 'pause');
  assert.deepEqual(marker.pending, atPause.pendingIds, '指纹 = 暂停那一刻现算出来的待办');
  assert.equal(marker.pendingDigest, digestOf(atPause.pendingIds));
  assert.equal(marker.pendingDigest.length, 12);

  // 10 分钟后重新打开：**状态是现算的**，暂停点只用来比对
  const r10 = resumeCheck(ITEMS, events, [marker], { now: localDate('2026-09-11T09:20:00'), groups: MUTATING });
  assert.equal(r10.paused, true);
  assert.equal(r10.gapMs, 10 * 60 * 1000, '间隔算得出来（但它只用于"说"，不参与"判"）');
  assert.equal(r10.sameAsPaused, true, '★ 验收：暂停 10 分钟后重新打开仍回到同一任务状态');
  assert.deepEqual(r10.drift, []);
  assert.deepEqual(r10.state.pendingIds, atPause.pendingIds);
  assert.deepEqual(r10.state.groupIds, atPause.groupIds, '组的顺序也一模一样（它由待办 + 聚合规则唯一决定）');
  assert.equal(r10.state.done, atPause.done);
  assert.match(r10.text, /一模一样/);
  assert.match(r10.text, /10\.0 分钟/);
  assert.equal(r10.cursor?.id, ITEMS[1]!.id, '回来先看暂停时那条');
  assert.equal(r10.cursorNote, '');

  // 久得多也一样：任务状态不随时间变，所以"10 分钟"不是代码里的阈值，而是一条性质
  const r26h = resumeCheck(ITEMS, events, [marker], { now: localDate('2026-09-12T11:20:00'), groups: MUTATING });
  assert.equal(r26h.sameAsPaused, true);
  assert.deepEqual(r26h.state.pendingIds, r10.state.pendingIds);
  assert.match(r26h.text, /26\.2 小时/);
});

test('★ 暂停点是指纹不是快照：中途有人动了队列 → 报差异；现算的状态**不读**旧指纹', () => {
  const events = [ev({ itemId: ITEMS[0]!.id, decision: 'accept', timestamp: iso('2026-09-11T09:00:00') })];
  const marker = pauseMarker({ teacherId: 'wayne', sourceVersion: 'sha-queue', state: taskStateOf(ITEMS, events, MUTATING), timestamp: iso('2026-09-11T09:10:00') });

  // 教师暂停期间，别处又判了一条（批量、另一位教师、命令行都行）
  events.push(ev({ itemId: ITEMS[1]!.id, decision: 'accept', timestamp: iso('2026-09-11T09:15:00'), reason: '批量' }));
  const r = resumeCheck(ITEMS, events, [marker], { now: localDate('2026-09-11T09:20:00'), groups: MUTATING });

  assert.equal(r.sameAsPaused, false);
  assert.equal(r.drift.length, 2, '待办少了 1 条 + 组结果变了');
  assert.match(r.drift[0]!, /暂停之后少了 1 条待办/);
  assert.match(r.drift[0]!, /第一章 第2段/);
  assert.match(r.text, /任务状态变了/);
  // ★ 这一条才是"不是快照"的落点：状态必须是**现在**算出来的，绝不能拿 marker.pending 顶上
  assert.equal(r.state.pendingIds.length, 3, '现算 = 3 条（5 - 2）');
  assert.notDeepEqual(r.state.pendingIds, marker.pending, '与暂停时的指纹不同，而且返回的是新状态');
  assert.deepEqual(
    r.state.pendingIds,
    pendingOf(ITEMS, events).map((x) => x.id),
  );
});

test('队列换了一版（条目没了 / 多出来）：也算"状态变了"，并说得出是哪些', () => {
  const marker = pauseMarker({ teacherId: 'wayne', sourceVersion: 'sha-queue', state: taskStateOf(ITEMS, [], MUTATING), timestamp: iso('2026-09-11T09:10:00') });
  const shorter = ITEMS.slice(0, 4);
  const r = resumeCheck(shorter, [], [marker], { now: localDate('2026-09-11T09:20:00'), groups: MUTATING });
  assert.equal(r.sameAsPaused, false);
  assert.match(r.drift[0]!, /暂停之后少了 1 条待办/);
  assert.equal(r.state.total, 4);

  // 没有暂停点：不假装"回到"了什么
  const none = resumeCheck(ITEMS, [], [], { now: localDate('2026-09-11T09:20:00'), groups: MUTATING });
  assert.equal(none.paused, false);
  assert.equal(none.marker, null);
  assert.equal(none.gapMs, null);
  assert.deepEqual(none.drift, []);
  assert.match(none.text, /没有暂停点/);
});

test('暂停点是**追加**的：暂停 → 恢复 → 再暂停，账本自己就答得出"那时一样不一样"', () => {
  const events = [ev({ itemId: ITEMS[0]!.id, decision: 'accept', timestamp: iso('2026-09-11T09:00:00') })];
  const state = taskStateOf(ITEMS, events, MUTATING);
  const p1 = pauseMarker({ teacherId: 'wayne', sourceVersion: 'sha-q', state, timestamp: iso('2026-09-11T09:10:00') });
  const r1 = resumeMarker({ teacherId: 'wayne', sourceVersion: 'sha-q', state, timestamp: iso('2026-09-11T09:20:00') });
  const p2 = pauseMarker({ teacherId: 'wayne', sourceVersion: 'sha-q', state, timestamp: iso('2026-09-11T09:30:00') });

  const text = [p1, r1, p2].map(toWorkbenchLine).join('');
  const parsed = parseWorkbenchLog(text);
  assert.equal(parsed.badLines, 0);
  assert.equal(parsed.markers.length, 3, '历史一条不删');
  assert.deepEqual(
    parsed.markers.map((m) => m.kind),
    ['pause', 'resume', 'pause'],
  );
  assert.equal(currentPause(parsed.markers)?.timestamp, iso('2026-09-11T09:30:00'), '最后一次标记是暂停才算"停着"');
  assert.equal(currentPause(parsed.markers.slice(0, 2)), null, '恢复之后就不算停着了');
  assert.equal(currentPause([]), null);

  // 坏行计数但不丢整份账（与 parseDecisionLog 同一约定）
  const dirty = parseWorkbenchLog(`${toWorkbenchLine(p1)}{坏行\n${JSON.stringify({ kind: '别的' })}\n`);
  assert.equal(dirty.markers.length, 1);
  assert.equal(dirty.badLines, 2);
});

test('暂停**不是决定**：它不进决定日志，也就污染不了误报率/撤销率那几个指标', () => {
  const marker = pauseMarker({ teacherId: 'wayne', sourceVersion: 'sha-q', state: taskStateOf(ITEMS, [], MUTATING), timestamp: iso('2026-09-11T09:10:00') });
  assert.equal('decision' in marker, false, '暂停点不是 DecisionEvent——共享账本上不许再多一种"所有消费方都要记得过滤"的事件');
  assert.deepEqual(Object.keys(marker).sort(), ['cursor', 'groups', 'kind', 'note', 'pending', 'pendingDigest', 'schemaVersion', 'sourceVersion', 'teacherId', 'tier', 'timestamp'].sort());
  // 它落在自己的那本账里；来回一趟（写→读）一个字都不许变
  const back = parseWorkbenchLog(toWorkbenchLine(marker)).markers[0]!;
  assert.deepEqual(back.pending, marker.pending);
  assert.deepEqual(back.groups, marker.groups);
  assert.equal(back.pendingDigest, marker.pendingDigest);
});

test('间隔说人话', () => {
  assert.equal(formatGap(30 * 1000), '不到 1 分钟');
  assert.equal(formatGap(10 * 60 * 1000), '10.0 分钟');
  assert.equal(formatGap(90 * 60 * 1000), '1.5 小时');
  assert.equal(formatGap(3 * 24 * 3600 * 1000), '3.0 天');
});

/* ────────────────── §三 今日任务 ────────────────── */

const openEv = (pending: number, at: string): DecisionEvent =>
  ev({ itemId: 'session-open', decision: 'edit', timestamp: at, before: '', after: '', reason: `打开风险队列（待办 ${pending} 条）`, ruleIds: [], subject: { kind: 'other', value: 'session-open' } });

test('今日任务：开工时欠多少、今天办成多少、还剩多少——全部现算，且**只算现在仍然成立**的', () => {
  const events: DecisionEvent[] = [
    openEv(5, iso('2026-09-11T08:00:00')),
    // 今天办成 1 条
    ev({ itemId: ITEMS[0]!.id, decision: 'accept', timestamp: iso('2026-09-11T08:05:00') }),
    // 昨天办的：不算今天
    ev({ itemId: ITEMS[1]!.id, decision: 'accept', timestamp: iso('2026-09-10T08:05:00') }),
    // 今天没办成 1 条（动作没执行）
    ev({ itemId: ITEMS[2]!.id, decision: 'rejected', timestamp: iso('2026-09-11T08:10:00'), reason: '找不到段落' }),
    // 今天判了又撤销：回到待办，不算"办成"
    ev({ itemId: ITEMS[3]!.id, decision: 'accept', timestamp: iso('2026-09-11T08:15:00') }),
    undoOf(ev({ itemId: ITEMS[3]!.id, decision: 'accept', timestamp: iso('2026-09-11T08:15:00') }), iso('2026-09-11T08:20:00')),
  ];
  const t = todayTasks(ITEMS, events, { now: localDate('2026-09-11T09:00:00'), groups: MUTATING });

  assert.equal(t.day, '2026-09-11');
  assert.equal(t.openedWithPending, 5, '开工时的欠账来自当天那条 session-open 记下的数');
  assert.deepEqual(
    t.done.map((r) => r.itemId),
    [ITEMS[0]!.id],
    '昨天办的不算今天；判了又撤销的不算办成',
  );
  assert.deepEqual(
    t.failed.map((r) => r.itemId),
    [ITEMS[2]!.id],
  );
  assert.deepEqual(
    t.undoneBack.map((r) => r.itemId),
    [ITEMS[3]!.id],
  );
  assert.equal(t.remaining.length, 3, '5 条里已决 2 条（今天 1 条 + 昨天 1 条），还剩 3 条');
  assert.match(t.text, /今日任务：今天开工时欠 5 条/);
  assert.match(t.text, /今天办成 1 条/);
  assert.match(t.text, /没执行成 1 条/);
  assert.match(t.text, /撤销回待办 1 条/);
  assert.match(t.text, /现在还剩 3 条/);
  assert.match(t.disclaimer, /不是日历/);
  assert.doesNotMatch(t.text, /\*\*/, '这几句直接进界面，不许带 markdown 记号');
});

test('今日任务退化得诚实：没有当天的记录就说"算不出来"，不拿当前待办冒充', () => {
  const events: DecisionEvent[] = [ev({ itemId: ITEMS[0]!.id, decision: 'accept', timestamp: iso('2026-09-10T09:00:00') })];
  const t = todayTasks(ITEMS, events, { now: localDate('2026-09-11T09:00:00'), groups: MUTATING });
  assert.equal(t.openedWithPending, null, '没有当天的 session-open = 算不出来，不是 0');
  assert.equal(t.done.length, 0, '昨天办的不能算成今天的成绩');
  assert.match(t.text, /今天还没有打开过队列的记录（这一项算不出来，不猜）/);
  assert.match(t.text, /现在还剩 4 条/, '还剩多少仍然给得出来——那是队列的事实，不是今天的成绩');

  // 一条数据都没有：说"无从谈起"，而不是给一个"今日 0 条"的假结论
  const none = todayTasks([], [], { now: localDate('2026-09-11T09:00:00') });
  assert.equal(none.openedWithPending, null);
  assert.equal(none.done.length, 0);
  assert.match(none.text, /无从谈起/);
  assert.match(none.text, /不知道/);
  assert.equal(none.text.includes('今天办成'), false, '一条数据都没有时，不许报"今天办成 0 条"这种看着像结论的数');
});

test('「今天」是本机日历日：跨零点不该把同一批活算成两天的', () => {
  assert.equal(dayOf(localDate('2026-09-11T00:00:00')), '2026-09-11');
  assert.equal(dayOf(localDate('2026-09-11T23:59:59')), '2026-09-11');
  assert.notEqual(dayOf(localDate('2026-09-11T23:59:59')), dayOf(localDate('2026-09-12T00:00:01')));
  assert.equal(dayOf('坏时间戳'), '', '坏时间戳归到"谁都不是"，不会被算成今天');
});

/* ────────────────── §四 变更历史（逐轮，不是最新一条） ────────────────── */

test('★ 变更历史逐轮列出：before→after 一轮不落，撤销也占一轮并指回它作废的那轮', () => {
  const e1 = ev({ itemId: ITEMS[0]!.id, decision: 'accept', timestamp: iso('2026-09-11T09:00:00'), before: '原句 A', after: '改写 A', version: 'v-1' });
  const e2 = undoOf(e1, iso('2026-09-11T09:05:00'), '改主意');
  const e3 = ev({ itemId: ITEMS[0]!.id, decision: 'false-positive', timestamp: iso('2026-09-11T09:10:00'), before: '原句 A', after: '原句 A', reason: '年份是教学锚点' });
  const h = itemHistory(ITEMS[0]!.id, ITEMS, [e1, e2, e3]);

  assert.equal(h.rounds.length, 3, '三轮就是三条，不是"最新一条"');
  assert.deepEqual(
    h.rounds.map((r) => r.label),
    ['采纳', '撤销', '标记误报'],
  );
  assert.deepEqual(
    h.rounds.map((r) => r.kind),
    ['decision', 'undo', 'decision'],
  );
  assert.equal(h.rounds[0]!.before, '原句 A');
  assert.equal(h.rounds[0]!.after, '改写 A');
  assert.equal(h.rounds[0]!.version, 'v-1', '改稿动作产生的版本要能回查');
  assert.equal(h.rounds[0]!.undone, true, '第 1 轮被撤销了');
  assert.equal(h.rounds[0]!.undoneByRound, 2);
  assert.equal(h.rounds[1]!.undoesRound, 1, '撤销指回它作废的那一轮');
  assert.equal(h.rounds[2]!.undone, false);
  assert.equal(h.rounds[2]!.changed, false, '标记误报是原样留痕，before === after');
  assert.equal(h.settled, true);
  assert.equal(h.undoCount, 1);
  assert.match(h.text, /3 轮（采纳 → 撤销第1轮 → 标记误报）/);
  assert.match(h.text, /现在=已决·标记误报/);

  const map = changeHistory(ITEMS, [e1, e2, e3]);
  assert.deepEqual([...map.keys()], [ITEMS[0]!.id]);
  assert.equal(historyRows(ITEMS, [e1, e2, e3]).length, 1);
});

test('队列换版之后，历史仍然查得到（「已判记录」只看最新一条，会漏掉这类）', () => {
  const gone = ev({ itemId: '第X章#9:ANNO-01:windmill', decision: 'accept', timestamp: iso('2026-09-11T09:00:00'), chapter: '第X章' });
  const rows = historyRows(ITEMS, [gone]);
  assert.equal(rows.length, 1, '日志里有过的项，历史里必须在——否则"我当时明明改过"会变成查无此事');
  assert.equal(rows[0]!.item, undefined, '但**不假装**它还在本轮队列里');
  assert.match(rows[0]!.text, /第X章#9:ANNO-01:windmill/);
  assert.equal(changeHistory(ITEMS, [gone]).size, 1);
});

test('历史按最近一条倒序：刚动过的排在最前面', () => {
  const a = ev({ itemId: ITEMS[0]!.id, decision: 'accept', timestamp: iso('2026-09-11T09:00:00') });
  const b = ev({ itemId: ITEMS[1]!.id, decision: 'accept', timestamp: iso('2026-09-11T11:00:00') });
  assert.deepEqual(
    historyRows(ITEMS, [a, b]).map((h) => h.itemId),
    [ITEMS[1]!.id, ITEMS[0]!.id],
  );
});

/* ────────────────── §五 撤销连着三次，状态还得说得清 ────────────────── */

/** 同一项上"决定 → 撤销"做三轮：单级撤销语义下，"三次撤销"实际就长这样 */
function threeUndosOnOneItem(it: RiskItem): DecisionEvent[] {
  const out: DecisionEvent[] = [];
  for (let i = 0; i < 3; i++) {
    const d = ev({ itemId: it.id, decision: i === 1 ? 'reject' : 'accept', timestamp: iso(`2026-09-11T09:0${i * 2}:00`), before: `原句${i}`, after: `改写${i}` });
    out.push(d, undoOf(d, iso(`2026-09-11T09:0${i * 2 + 1}:00`), `第 ${i + 1} 次点错了`));
  }
  return out;
}

test('★ 连续三次撤销（同一项）：状态仍可解释——现状、由谁定、几轮几撤，全答得出来', () => {
  const events = threeUndosOnOneItem(ITEMS[0]!);
  assert.equal(events.length, 6);
  assert.equal(undoCountOf(events), 3);

  const ex = explainState(ITEMS, events);
  assert.equal(ex.explainable, true, '★ 验收：撤销连续三次后状态仍可解释');
  assert.deepEqual(ex.orphans, [], '没有一条事件无处安放');
  assert.deepEqual(ex.dangling, [], '三个撤销指针都指得实');
  assert.deepEqual(ex.noopUndos, []);
  assert.deepEqual(ex.problems, []);

  const one = ex.items.find((x) => x.itemId === ITEMS[0]!.id)!;
  assert.match(one.state, /^已决·采纳（已被撤销 → 回到待办）$/);
  assert.equal(one.rounds, 6);
  assert.equal(one.undos, 3);
  assert.match(one.decidedBy!, /采纳@/);
  assert.match(one.line, /共 6 轮、撤销 3 次，历史一条未删/);
  assert.match(ex.line, /状态可解释/);
  assert.doesNotMatch(ex.line, /\*\*/, '这句话直接进界面');

  // 状态回到待办：三项撤销各作废一轮，第 6 条（第 3 次撤销）之后的现状唯一
  assert.deepEqual(
    pendingOf(ITEMS, events).map((x) => x.id),
    ITEMS.map((x) => x.id),
  );
  const h = itemHistory(ITEMS[0]!.id, ITEMS, events);
  assert.deepEqual(
    h.rounds.filter((r) => r.undone).map((r) => r.round),
    [1, 3, 5],
    '每一轮决定都被对应那轮撤销作废',
  );
  assert.deepEqual(
    h.rounds.filter((r) => r.kind === 'undo').map((r) => r.undoesRound),
    [1, 3, 5],
    '三个撤销指向三轮不同的决定，互不重叠——所以单级撤销够用，不必上版本树',
  );
  assert.equal(h.settled, false);

  // 按日志重放：第 3 次撤销之后的状态，与最终状态一致
  const after = stateAfterUndos(ITEMS, events, 3, MUTATING);
  assert.match(after.line, /^第 3 次撤销之后：/);
  assert.deepEqual(after.state.pendingIds, taskStateOf(ITEMS, events, MUTATING).pendingIds);
  assert.equal(after.explanation.explainable, true);
});

test('连续三次撤销的另一种读法（一次撤销三条不同的项）：也解释得清', () => {
  const [a, b, c] = ITEMS;
  const d1 = ev({ itemId: a!.id, decision: 'accept', timestamp: iso('2026-09-11T09:00:00') });
  const d2 = ev({ itemId: b!.id, decision: 'reject', timestamp: iso('2026-09-11T09:01:00') });
  const d3 = ev({ itemId: c!.id, decision: 'edit', timestamp: iso('2026-09-11T09:02:00') });
  const events = [d1, d2, d3, undoOf(d1, iso('2026-09-11T09:03:00')), undoOf(d2, iso('2026-09-11T09:04:00')), undoOf(d3, iso('2026-09-11T09:05:00'))];
  const ex = explainState(ITEMS, events);
  assert.equal(ex.explainable, true);
  assert.equal(ex.noopUndos.length, 0);
  for (const id of [a!.id, b!.id, c!.id]) {
    const one = ex.items.find((x) => x.itemId === id)!;
    assert.equal(one.undos, 1);
    assert.equal(one.rounds, 2);
    assert.match(one.state, /已被撤销/);
  }
  assert.deepEqual(
    pendingOf(ITEMS, events).map((x) => x.id),
    ITEMS.map((x) => x.id),
    '三条都回到待办',
  );
});

test('可解释不是空口：丑日志必须被**说成说不清**，而不是悄悄给个结论', () => {
  const d1 = ev({ itemId: ITEMS[0]!.id, decision: 'accept', timestamp: iso('2026-09-11T09:00:00') });

  // ① 悬空撤销：undoOf 指向日志里根本没有的事件
  const dangling = ev({ itemId: ITEMS[0]!.id, decision: 'undo', timestamp: iso('2026-09-11T09:05:00'), undoOf: `${ITEMS[0]!.id}@2020-01-01T00:00:00.000Z` });
  const ex1 = explainState(ITEMS, [d1, dangling]);
  assert.equal(ex1.explainable, false, '指针指不到东西 = 说不清这条撤销到底作废了什么');
  assert.equal(ex1.dangling.length, 1);
  assert.match(ex1.line, /^⚠ 状态说不清/);
  assert.match(ex1.problems.join('；'), /悬空指针/);

  // ② 撤销指向撤销：单级语义下是空操作——**不影响**可解释性，但必须被说出来
  const u1 = undoOf(d1, iso('2026-09-11T09:05:00'));
  const u2 = ev({ itemId: ITEMS[0]!.id, decision: 'undo', timestamp: iso('2026-09-11T09:06:00'), undoOf: `${u1.itemId}@${u1.timestamp}` });
  const ex2 = explainState(ITEMS, [d1, u1, u2]);
  assert.equal(ex2.explainable, true, '它答得出来："这条撤销是空操作，状态没变"——这本身就是解释');
  assert.equal(ex2.noopUndos.length, 1);
  assert.match(ex2.problems.join('；'), /空操作/);
  assert.deepEqual(
    pendingOf(ITEMS, [d1, u1, u2]).map((x) => x.id),
    ITEMS.map((x) => x.id),
    '状态确实没变：第 1 轮仍是被撤销的',
  );

  // ③ 谁都不认识的 decision 取值（以后新加类型而这里没跟上）
  const weird = { ...d1, decision: 'future-kind' } as unknown as DecisionEvent;
  const ex3 = explainState(ITEMS, [d1, weird]);
  assert.equal(ex3.explainable, false);
  assert.equal(ex3.orphans.length, 1);
  assert.match(ex3.problems.join('；'), /无法归类/);
});

test('解释覆盖日志里**每一条**事件：既不在队列里、也不是本轮做的，也照样有归宿', () => {
  const old = ev({ itemId: '第九章#1:ANNO-01:x', decision: 'accept', timestamp: iso('2026-09-01T09:00:00'), chapter: '第九章' });
  const ex = explainState(ITEMS, [old]);
  assert.equal(ex.explainable, true);
  const one = ex.items.find((x) => x.itemId === '第九章#1:ANNO-01:x')!;
  assert.equal(one.inQueue, false);
  assert.match(one.state, /不在本轮队列里/);
  assert.equal(ex.items.length, ITEMS.length + 1);
});
