/**
 * 教师任务实验 回归测试
 *
 * 验收标准（《LayerText 工程优化总计划》阶段 4）：
 *   「然后做真实教师任务实验：至少 3 位教师、同一章、相同任务，记录首次成功、撤销、回退和完成时间。」
 *   「教师实验能回答『第一次点击是否成功』和『10 次操作后是否疲劳』，而不是只报告模型输出指标」
 *
 * 这份测试盯的是**降级**而不是顺利路径：人数不够、操作数不够、章节没记、
 * 完成标记没写——每一种都必须给出"算不出来 + 为什么"，而不是一个看起来像结论的数。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eventIdOf, makeDecisionEvent, type DecisionEvent, type MakeDecisionInput } from '../src/core/decision.js';
import { productMetrics, sessionOpenEvent, SESSION_OPEN } from '../src/core/productmetrics.js';
import { compositeFields } from '../src/core/experimentrun.js';
import {
  ALL_TEACHERS,
  assertSeparateQuestions,
  freezeTeacherTask,
  MIN_TEACHERS,
  QUESTION_FATIGUE,
  QUESTION_FIELDS,
  QUESTION_FIRST_CLICK,
  sessionRecordOf,
  taskDoneEvent,
  taskDriftOf,
  TEACHER_METRICS,
  teacherExperiment,
  traceTeacherAll,
  traceTeacherMetric,
  type TeacherTaskSpec,
} from '../src/core/teacherexperiment.js';

const T0 = Date.UTC(2026, 8, 20, 9, 0, 0);
const at = (sec: number): string => new Date(T0 + sec * 1000).toISOString();

const TASK_INPUT = {
  taskId: '任务-2026-09-20',
  chapter: '第一章',
  segments: [
    { id: 'P01', text: 'The farm was quiet that night.' },
    { id: 'P02', text: 'Nobody spoke about the milk.' },
  ],
  tier: 'A',
  instruction: '把这一章逐条过一遍风险队列：能采纳的采纳，不同意的退回，最后点"我做完了"。',
  successCriterion: '队列里不再有待办，且每一段都被你看过一遍。',
  frozenAt: at(0),
};

const TASK: TeacherTaskSpec = freezeTeacherTask(TASK_INPUT);

let seq = 0;
const ev = (over: Partial<MakeDecisionInput> = {}): DecisionEvent =>
  makeDecisionEvent({
    itemId: `item-${seq++}`,
    decision: 'accept',
    before: 'a',
    after: 'b',
    reason: '',
    ruleIds: ['ANNO-01'],
    teacherId: 'T1',
    sourceVersion: 's',
    timestamp: at(0),
    chapter: '第一章',
    tier: 'A',
    ...over,
  });

interface RunOpts {
  startSec: number;
  /** 待办条数；`null` = 打开事件里不记待办（用来测"完成与否无从判断"） */
  pending?: number | null;
  /** 决定条数 */
  ops: number;
  /** 第一下就是执行失败（系统没做成） */
  firstFail?: boolean;
  /** 这些下标的决定带"批量"标记 */
  batchIndexes?: number[];
  /** 撤销这些下标的决定 */
  undoIndexes?: number[];
  /** 点"我做完了" */
  done?: boolean;
  /** `null` = 事件里不记章节（用来测"同一章无从核对"） */
  chapter?: string | null;
}

/** 造一位教师的一次完整会话：打开队列 → N 次决定 →（可选）撤销 →（可选）完成标记 */
function runSession(teacherId: string, o: RunOpts): DecisionEvent[] {
  const chapter = o.chapter === null ? undefined : (o.chapter ?? '第一章');
  const out: DecisionEvent[] = [];
  out.push(
    o.pending === null || o.pending === undefined
      ? ev({ teacherId, itemId: SESSION_OPEN, decision: 'edit', reason: '打开风险队列', timestamp: at(o.startSec), chapter, ruleIds: [] })
      : sessionOpenEvent({ tier: 'A', teacherId, sourceVersion: 's', pending: o.pending, timestamp: at(o.startSec) }),
  );
  const decisions: DecisionEvent[] = [];
  for (let i = 0; i < o.ops; i++) {
    const e = ev({
      teacherId,
      itemId: `${teacherId}-item-${i}`,
      decision: o.firstFail && i === 0 ? 'rejected' : 'accept',
      reason: o.batchIndexes?.includes(i) ? '批量＋ 补上注释' : '',
      timestamp: at(o.startSec + 1 + i),
      chapter,
    });
    decisions.push(e);
    out.push(e);
  }
  (o.undoIndexes ?? []).forEach((idx, k) => {
    const d = decisions[idx]!;
    out.push(ev({ teacherId, itemId: d.itemId, decision: 'undo', undoOf: `${d.itemId}@${d.timestamp}`, reason: '撤销', timestamp: at(o.startSec + 1 + o.ops + k), chapter }));
  });
  const end = o.startSec + 1 + o.ops + (o.undoIndexes?.length ?? 0);
  if (o.done) out.push(taskDoneEvent({ taskHash: TASK.hash, teacherId, sourceVersion: 's', tier: 'A', settled: o.ops - (o.undoIndexes?.length ?? 0), timestamp: at(end + 1) }));
  return out;
}

/* ══════════════════ ① 任务书：先冻，再发 ══════════════════ */

test('任务书指纹只认输入：编号与冻结时刻不进来，指令/原文一变就换指纹', () => {
  const same = freezeTeacherTask({ ...TASK_INPUT, taskId: '另一批-2026-10-01', frozenAt: at(999) });
  assert.equal(same.hash, TASK.hash, '编号与冻结时刻是身份，不是输入（同 experimentrun 排除 runId/createdAt）');
  const otherInstruction = freezeTeacherTask({ ...TASK_INPUT, instruction: TASK_INPUT.instruction + '（这次先用批量）' });
  assert.notEqual(otherInstruction.hash, TASK.hash, '换一句指令 = 换了任务，指纹必须变');
  const otherText = freezeTeacherTask({
    ...TASK_INPUT,
    segments: [
      { id: 'P01', text: 'The farm was silent that night.' },
      { id: 'P02', text: 'Nobody spoke about the milk.' },
    ],
  });
  assert.notEqual(otherText.hash, TASK.hash, '同一章改一个词，两条结论就不可比了');
});

test('任务书漂移逐项点名，且一有内容漂移就不许把两组数放一起比', () => {
  const d = taskDriftOf(TASK, { ...TASK, instruction: '随便点几下就行', tier: 'M', chapterSnapshot: { ...TASK.chapterSnapshot, hash: 'changed' } });
  assert.equal(d.blocksConclusion, true);
  assert.equal(d.drift.length, 3);
  assert.match(d.drift.join('｜'), /指令变了/);
  assert.match(d.drift.join('｜'), /层级换了（A → M）/);
  assert.match(d.drift.join('｜'), /原文变了/);
  const onlyId = taskDriftOf(TASK, { ...TASK, taskId: '第三批' });
  assert.deepEqual(onlyId.drift, []);
  assert.equal(onlyId.blocksConclusion, false, '只换编号不动摇结论');
  assert.match(onlyId.warnings.join('｜'), /任务编号变了/);
});

/* ══════════════════ ② 一位教师的一次会话 ══════════════════ */

test('第一次点击是否成功：落定=成，撤销/系统没做成=不成，没点=判不了', () => {
  const ok = sessionRecordOf({ events: runSession('T1', { startSec: 0, pending: 5, ops: 3 }), teacherId: 'T1', task: TASK });
  assert.equal(ok.firstClick.succeeded, true);
  assert.equal(ok.firstClick.responseMs, 1000, '从打开队列算到第一下');

  const undone = sessionRecordOf({ events: runSession('T2', { startSec: 0, pending: 5, ops: 3, undoIndexes: [0] }), teacherId: 'T2', task: TASK });
  assert.equal(undone.firstClick.succeeded, false);
  assert.match(undone.firstClick.why, /自己撤销了/);
  assert.match(undone.firstClick.why, /不是系统出错/, '撤销是教师改主意，与系统失败必须分开说');

  const failed = sessionRecordOf({ events: runSession('T3', { startSec: 0, pending: 5, ops: 3, firstFail: true }), teacherId: 'T3', task: TASK });
  assert.equal(failed.firstClick.succeeded, false);
  assert.match(failed.firstClick.why, /系统没做成/);

  const idle = sessionRecordOf({ events: runSession('T4', { startSec: 0, pending: 5, ops: 0 }), teacherId: 'T4', task: TASK });
  assert.equal(idle.firstClick.succeeded, null, '★ 没点到 ≠ 点失败了');
  assert.match(idle.firstClick.why, /一次操作都没有/);
  assert.equal(idle.usable, false);
});

test('首次成功：打了几下才成、花了多久，都指得回具体事件', () => {
  const log = [...runSession('T1', { startSec: 0, pending: 5, ops: 2, undoIndexes: [0] }), ...runSession('T1', { startSec: 100, pending: 0, ops: 1 })];
  const rec = sessionRecordOf({ events: log, teacherId: 'T1', task: TASK });
  assert.equal(rec.firstSuccess.attempts, 2, '只算第一次会话里的：第一下被撤，第二下才落定');
  assert.equal(rec.firstSuccess.latencyMs, 2000);
  assert.ok(rec.firstSuccess.eventIds.length >= 2, '追溯要能看到"那几下"');
  assert.match(rec.notes.join('｜'), /打开了 2 次队列/, '多次会话必须点出来，不能静默');
});

test('一次都没成时说清楚"没有记录到成功"，而不是报 0 秒', () => {
  const rec = sessionRecordOf({ events: runSession('T1', { startSec: 0, pending: 5, ops: 2, undoIndexes: [0, 1] }), teacherId: 'T1', task: TASK });
  assert.equal(rec.firstSuccess.attempts, null);
  assert.equal(rec.firstSuccess.latencyMs, null);
  assert.match(rec.firstSuccess.why, /没有一次是"落定且没被撤销"/);
});

test('撤销率 / 批量回退率 / 执行失败率：口径与 productmetrics 逐字一致（两处口径不许漂移）', () => {
  const log = runSession('T1', { startSec: 0, pending: 10, ops: 12, batchIndexes: [2, 3], undoIndexes: [2, 10] });
  const rec = sessionRecordOf({ events: log, teacherId: 'T1', task: TASK });
  const pm = productMetrics(log);
  assert.equal(rec.undo.rate, pm.undoRate);
  assert.equal(rec.batch.rollbackRate, pm.batchRollbackRate);
  assert.equal(rec.failures.rate, pm.applyFailureRate);
  assert.equal(rec.batch.rollbackRate, 0.5, '两条批量里回退了一条');
});

test('完成：有标记才算事实，没标记只能"推断"，两者都读不到就只能"不确定"', () => {
  const marked = sessionRecordOf({ events: runSession('T1', { startSec: 0, pending: 3, ops: 3, done: true }), teacherId: 'T1', task: TASK });
  assert.equal(marked.completion.state, '完成');
  assert.equal(marked.completion.basis, '完成标记');
  assert.equal(marked.completion.durationMs, 5000);

  const inferred = sessionRecordOf({ events: runSession('T1', { startSec: 0, pending: 3, ops: 3 }), teacherId: 'T1', task: TASK });
  assert.equal(inferred.completion.state, '完成');
  assert.equal(inferred.completion.basis, '待办条数（推断）');
  assert.match(inferred.completion.why, /是\*\*推断\*\*出来的/);

  const short = sessionRecordOf({ events: runSession('T1', { startSec: 0, pending: 8, ops: 3 }), teacherId: 'T1', task: TASK });
  assert.equal(short.completion.state, '未完成');

  const unknown = sessionRecordOf({ events: runSession('T1', { startSec: 0, pending: null, ops: 3 }), teacherId: 'T1', task: TASK });
  assert.equal(unknown.completion.state, '不确定', '★ 没有完成标记、也读不到待办条数：不许猜成"没做完"');
  assert.equal(unknown.completion.durationMs, null, '★ 完成用时算不出来就是 null，不许填 0');
  assert.match(unknown.completion.why, /没有这件事实/);
});

test('离题事件（章节对不上）被排除出指标，且不静默', () => {
  const log = [...runSession('T1', { startSec: 0, pending: 5, ops: 3 }), ...runSession('T1', { startSec: 100, pending: 5, ops: 4, chapter: '第二章' })];
  const rec = sessionRecordOf({ events: log, teacherId: 'T1', task: TASK });
  // 打开队列那条事件里没有章节字段（`sessionOpenEvent` 只记 tier），所以离题判定落不到它头上——
  // 这也意味着"同一章"这件事只对记了章节的事件成立，报告里会单独提醒。
  assert.equal(rec.onTask.offTask.count, 4, '另一章的 4 次操作一条都不许混进指标');
  assert.equal(rec.operations, 3, '只有任务书那一章的操作才算数');
  assert.match(rec.notes.join('｜'), /不在任务书口径内/);
  const allOff = sessionRecordOf({ events: runSession('T9', { startSec: 0, pending: 5, ops: 6, chapter: '第九十章' }), teacherId: 'T9', task: TASK });
  assert.equal(allOff.usable, false, '全部离题 = 这个人不能进汇总（不是"他 0 次操作"）');
});

test('事件里没记章节时说的是"无从核对"，不是"不是同一章"', () => {
  const rec = sessionRecordOf({ events: runSession('T1', { startSec: 0, pending: 5, ops: 3, chapter: null }), teacherId: 'T1', task: TASK });
  assert.equal(rec.onTask.chapterRecorded, false);
  assert.equal(rec.onTask.offTask.count, 0);
  assert.match(rec.notes.join('｜'), /无从核对/);
});

test('★ 疲劳：操作数不够时是"算不出来"（null），不是"不疲劳"（false）', () => {
  const few = sessionRecordOf({ events: runSession('T1', { startSec: 0, pending: 9, ops: 5 }), teacherId: 'T1', task: TASK });
  assert.equal(few.fatigue.lateOps, 0);
  assert.equal(few.fatigue.lateUndoRate, null, '★ 后段一条决定都没有：撤销率的分母不存在，不许报 0');
  assert.equal(few.fatigue.signal, null, '★ 老写法在这里会返回 false（看着像"测过了，没问题"）');
  assert.match(few.fatigue.why, /不是"不疲劳"/);

  const many = sessionRecordOf({ events: runSession('T1', { startSec: 0, pending: 9, ops: 14, undoIndexes: [10, 11, 12, 13] }), teacherId: 'T1', task: TASK });
  assert.equal(many.fatigue.earlyOps, 10);
  assert.equal(many.fatigue.lateOps, 4);
  assert.equal(many.fatigue.earlyUndoRate, 0);
  assert.equal(many.fatigue.lateUndoRate, 1);
  assert.equal(many.fatigue.signal, true);
});

/* ══════════════════ ③ 跨教师：人数不够就不许有结论 ══════════════════ */

/**
 * 一位"做完了"的教师：14 条待办全部落定（有的靠多做几次补回来）、第 11 次起才出现撤销。
 * `undoLate=false` 的那位是"做完了但后段没变随手"的对照组。
 */
const fullRun = (teacher: string, startSec: number, undoLate = true): DecisionEvent[] =>
  runSession(teacher, { startSec, pending: 14, ops: undoLate ? 18 : 14, undoIndexes: undoLate ? [10, 11, 12, 13] : [] });

test('★ 0/1/2 位教师：两个问题都说"不给结论"并说清为什么，绝不报一个百分比', () => {
  // 门槛从模块里取，不写死 3：门槛改了这条测试跟着改，不会两边各说一套
  const cases: { n: number; state: string }[] = [{ n: 0, state: '未跑' }, ...Array.from({ length: MIN_TEACHERS - 1 }, (_, i) => ({ n: i + 1, state: '教师数不足' }))];
  for (const c of cases) {
    const events = Array.from({ length: c.n }, (_, i) => fullRun(`T${i + 1}`, i * 100)).flat();
    const r = teacherExperiment({ task: TASK, events });
    assert.equal(r.state, c.state, `${c.n} 位教师`);
    assert.equal(r.firstClick.available, false);
    assert.equal(r.fatigue.available, false);
    assert.equal(r.firstClick.conclusion, null, '★ 2 位教师的"100% 成功"不是发现');
    assert.equal(r.fatigue.conclusion, null);
    assert.match(r.firstClick.why, /至少 3 位/);
    assert.match(r.fatigue.why, /至少 3 位/);
    if (c.n === 0) assert.match(r.why, /不是"跑出来是 0"/);
  }
});

test('3 位教师、同一章、相同任务：两个问题各自成结论（分开给，不合成）', () => {
  const events = [...fullRun('T1', 0), ...fullRun('T2', 100), ...fullRun('T3', 200, false)];
  const r = teacherExperiment({ task: TASK, events });
  assert.equal(r.state, '可出结论', r.why);
  assert.equal(r.teachers.length, 3);
  assert.equal(r.firstClick.available, true);
  assert.equal(r.fatigue.available, true);
  assert.match(r.firstClick.conclusion!, /3 位教师里 3 位第一次点击就成功/);
  assert.match(r.fatigue.conclusion!, /3 位教师里 2 位/);
  assert.match(r.fatigue.conclusion!, /10 次操作之后确实更随手/);
  assert.equal(r.fatigue.numbers['后段决定数'], 20, '8 + 8 + 4：三位教师第 11 次起的决定总数');
  assert.equal(r.completion.medianDurationMs, 18000, '完成用时中位数：14 秒 / 18 秒 / 18 秒');
  assert.equal(r.completion.finished, 3);
  assert.deepEqual(r.completion.inferred, ['T1', 'T2', 'T3'], '三份都没有完成标记：用时是推断出来的，必须标着');
  assert.match(r.verdict.join('｜'), /量的是\*\*教师那边的过程\*\*/, '报告必须自己说清这不是"AI 建议对不对"');
});

test('人数够了但"10 次之后"证据不足：状态降成"有缺口"，两个问题各自给不给', () => {
  const events = [...fullRun('T1', 0), ...fullRun('T2', 100), ...runSession('T3', { startSec: 200, pending: 14, ops: 5 })];
  const r = teacherExperiment({ task: TASK, events });
  assert.equal(r.state, '有缺口');
  assert.equal(r.firstClick.available, true, '第一个问题照样能答——降级是逐问题的，不是一刀切');
  assert.equal(r.fatigue.available, false);
  assert.equal(r.fatigue.conclusion, null);
  assert.match(r.why, /够到"10 次之后"的教师只有 2 位/);
  assert.equal(r.idleTeachers.length, 0, 'T3 是操作少，不是没操作');
});

test('打开了队列但一次没操作的人：不计入 3 人次，但不许当噪音删掉', () => {
  const events = [...fullRun('T1', 0), ...fullRun('T2', 100), ...runSession('T3', { startSec: 200, pending: 14, ops: 0 })];
  const r = teacherExperiment({ task: TASK, events });
  assert.equal(r.state, '教师数不足');
  assert.deepEqual(r.idleTeachers, ['T3']);
  assert.match(r.why, /打开了队列但一次都没操作/);
  assert.match(r.verdict.join('｜'), /上手门槛/);
});

test('名单点名了却一条事件都没有：说得出是谁，分得出"没来"和"没做完"', () => {
  const events = [...fullRun('T1', 0), ...fullRun('T2', 100)];
  const r = teacherExperiment({ task: TASK, events, roster: ['T1', 'T2', 'T3'] });
  assert.deepEqual(r.missingTeachers, ['T3']);
  assert.match(r.why, /名单里还缺 T3/);
  assert.match(r.verdict.join('｜'), /是没来，还是日志没落盘/);
});

test('任务书被改过（漂移）时状态进"有缺口"，结论先别下', () => {
  const events = [...fullRun('T1', 0), ...fullRun('T2', 100), ...fullRun('T3', 200)];
  const r = teacherExperiment({ task: TASK, events, currentTask: { ...TASK, instruction: '改了' } });
  assert.equal(r.state, '有缺口');
  assert.match(r.why, /任务书在实验之后变了/);
});

test('章节字段全都没记时，明说"同一章"这件事本轮无从核对', () => {
  const events = [
    ...runSession('T1', { startSec: 0, pending: 14, ops: 14, undoIndexes: [10, 11, 12, 13], chapter: null }),
    ...runSession('T2', { startSec: 100, pending: 14, ops: 14, undoIndexes: [10, 11, 12, 13], chapter: null }),
    ...runSession('T3', { startSec: 200, pending: 14, ops: 14, undoIndexes: [10, 11, 12, 13], chapter: null }),
  ];
  const r = teacherExperiment({ task: TASK, events });
  assert.equal(r.state, '可出结论');
  assert.match(r.verdict.join('｜'), /"同一章"这件事本轮\*\*无从核对\*\*/);
});

test('日志乱序读出来也必须一样（append-only 日志不保证顺序）', () => {
  const events = [...fullRun('T1', 0), ...fullRun('T2', 100), ...fullRun('T3', 200)];
  const a = teacherExperiment({ task: TASK, events });
  const b = teacherExperiment({ task: TASK, events: [...events].reverse() });
  assert.equal(a.firstClick.conclusion, b.firstClick.conclusion);
  assert.equal(a.fatigue.conclusion, b.fatigue.conclusion);
  assert.equal(a.completion.medianDurationMs, b.completion.medianDurationMs);
});

/* ══════════════════ ④ 追溯：每个数都指得回原始事件行 ══════════════════ */

test('每条结论都指得回原始事件行（那些行确实在日志里）', () => {
  const events = [...fullRun('T1', 0), ...fullRun('T2', 100), ...fullRun('T3', 200)];
  const r = teacherExperiment({ task: TASK, events });
  // 注意：`sessionOpenEvent`（productmetrics）造出来的事件**没有 `eventId` 字段**，落盘时那一行也就没有稳定 ID。
  // 所以追溯按 `decision.ts` 的同一条规则现算——这正是"不许丢追溯"的兜底（见报告的已知缺口）。
  const raw = new Set(events.map((e) => e.eventId ?? eventIdOf({ itemId: e.itemId, decision: e.decision, teacherId: e.teacherId, timestamp: e.timestamp })));
  const traces = [
    traceTeacherMetric({ metric: '首次点击是否成功', teacherId: 'T1' }, r),
    traceTeacherMetric({ metric: '疲劳信号', teacherId: 'T2' }, r),
    traceTeacherMetric({ metric: '完成用时', teacherId: 'T3' }, r),
    traceTeacherMetric({ metric: QUESTION_FIRST_CLICK, teacherId: ALL_TEACHERS }, r),
    traceTeacherMetric({ metric: QUESTION_FATIGUE, teacherId: ALL_TEACHERS }, r),
  ];
  for (const t of traces) {
    assert.equal(t.ok, true, t.why);
    assert.ok(t.eventIds.length > 0);
    for (const id of t.eventIds) assert.ok(raw.has(id), `追溯给出的 ${id} 必须真的在日志里`);
  }
});

test('★ 追不到就说追不到，绝不给一个空数组充数', () => {
  const events = [...fullRun('T1', 0), ...fullRun('T2', 100), ...runSession('T3', { startSec: 200, pending: 14, ops: 4 })];
  const r = teacherExperiment({ task: TASK, events });
  const unknownMetric = traceTeacherMetric({ metric: '体验分', teacherId: 'T1' }, r);
  assert.equal(unknownMetric.ok, false);
  assert.match(unknownMetric.why, /不是本实验定义的指标/);

  const unknownTeacher = traceTeacherMetric({ metric: '撤销率', teacherId: '张三' }, r);
  assert.equal(unknownTeacher.ok, false);
  assert.match(unknownTeacher.why, /两种都不是"0 次操作"/);

  const notComputable = traceTeacherMetric({ metric: '疲劳信号', teacherId: 'T3' }, r);
  assert.equal(notComputable.ok, false, 'T3 只按了 4 下，"疲劳信号"没有派生路径');
  assert.match(notComputable.why, /算不出来，不是"不疲劳"/);

  const wrongLevel = traceTeacherMetric({ metric: '撤销率', teacherId: ALL_TEACHERS }, r);
  assert.equal(wrongLevel.ok, false);
  assert.match(wrongLevel.why, /只在教师层面派生/);

  const split = traceTeacherAll(
    [
      { metric: '撤销率', teacherId: 'T1' },
      { metric: '体验分', teacherId: 'T1' },
    ],
    r,
  );
  assert.equal(split.traceable.length, 1);
  assert.equal(split.untraceable.length, 1);
});

test('报出来的数都有源：有值的指标必须能指回事件', () => {
  const events = [...fullRun('T1', 0), ...fullRun('T2', 100), ...fullRun('T3', 200, false)];
  const r = teacherExperiment({ task: TASK, events });
  for (const rec of r.teachers) {
    assert.ok(rec.sources['撤销率'].length > 0, `${rec.teacherId} 的撤销率必须有分母事件`);
    assert.ok(rec.sources['首次点击是否成功'].length > 0);
    if (rec.fatigue.signal !== null) assert.ok(rec.sources['疲劳信号'].length > 0);
    if (rec.completion.durationMs === null) assert.equal(rec.sources['完成用时'].length, 0, '算不出来的指标不许有"看起来有据"的源');
  }
  assert.equal(r.completion.unknownWho.length, 0);
});

test('★ 它报的是教师那边的过程，不是模型输出指标（验收原话：而不是只报告模型输出指标）', () => {
  const r = teacherExperiment({ task: TASK, events: [...fullRun('T1', 0), ...fullRun('T2', 100), ...fullRun('T3', 200)] });
  const metrics = Object.keys(r.teachers[0]!.sources);
  assert.deepEqual(metrics, [...TEACHER_METRICS]);
  for (const m of metrics) assert.doesNotMatch(m, /覆盖率|截断|成本|token|调用/, `「${m}」是模型输出指标，不该出现在教师任务实验里`);
  assert.deepEqual(compositeFields(r), [], '顺带再确认一遍：没有合成分');
});

/* ══════════════════ ⑤ 两个问题分开报，禁止综合分数 ══════════════════ */

test('★ 报告里没有任何合成分字段：两个问题各自成字段', () => {
  const r = teacherExperiment({ task: TASK, events: [...fullRun('T1', 0), ...fullRun('T2', 100), ...fullRun('T3', 200)] });
  assert.deepEqual(compositeFields(r), [], '综合/总分/得分/score 这类字段一个都不许有');
  assert.doesNotThrow(() => assertSeparateQuestions(r));
  assert.deepEqual([...QUESTION_FIELDS], ['firstClick', 'fatigue']);
  assert.equal(r.firstClick.question, QUESTION_FIRST_CLICK);
  assert.equal(r.fatigue.question, QUESTION_FATIGUE);
  assert.notEqual(r.firstClick, r.fatigue, '两个问题不许是同一个东西的两个视图');
});

test('★ 有人塞进来一个"综合体验分"，在报告出门前就被拦住', () => {
  const r = teacherExperiment({ task: TASK, events: [...fullRun('T1', 0)] });
  const merged = { ...r, 综合体验分: 88 } as unknown as typeof r;
  assert.throws(() => assertSeparateQuestions(merged), /合成分字段/);
  const missing = { ...r, fatigue: undefined } as unknown as typeof r;
  assert.throws(() => assertSeparateQuestions(missing), /缺少验收问题字段/);
});
