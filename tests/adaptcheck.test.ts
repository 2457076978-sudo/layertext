/**
 * 两轮调适制 · 本地检查引擎测试
 *
 * 三类样本（普通叙述 / 多人对话 / 注释最拥挤段）锁定行为——来源是 2026-09-12
 * 方向文档第七部分：自动验收负责计数、定位与"平均值不掩盖局部"。
 * 阈值断言全部对着**试运行阈值表**打，改表这里会红（改阈值必须是显式决定）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ANNO_DENSITY_LIMIT,
  burdenFindings,
  burdenProfileOf,
  fidelityCountsOf,
  fidelityFindings,
  introducedHardWords,
  knownWordHit,
  MAGNITUDE_UNITS,
  parseTeacherFeedback,
  SENT_LEN_CHECK,
} from '../src/core/adaptcheck.js';

/** 造一段指定注释处数的文本：plain 词 x N + 注释句 */
const para = (marks: string, annos: [string, string][]): string =>
  `${marks} The animals worked hard all day and the windmill grew taller. ${annos.map(([w, zh]) => `${w}（${zh}）`).join(' ')} They were tired but happy.`;

test('负担剖面：注释处数/密度按全角括号口径计，段号不算词也不算注', () => {
  const md = para('[P01]', [
    ['barn', '谷仓'],
    ['lantern', '提灯'],
  ]);
  const p = burdenProfileOf(md);
  assert.equal(p.annos, 2, '两处 word（中文）注释');
  assert.ok(p.words > 10 && p.words < 40, `英文词数应只数英文（实得 ${p.words}）`);
  assert.equal(p.densityPer100 > 0, true, '密度为正');
});

test('最拥挤一句：一句 3 处注释必须被点名（全文平均合格也拦得住）', () => {
  /* 前 100 词干净 + 一句 3 注：全文密度可能合格，但那句的拥挤是真实的 */
  const clean = Array.from({ length: 8 }, (_, i) => `[P${String(i + 1).padStart(2, '0')}] The animals worked hard all day and the windmill grew taller and taller every week.`).join('\n');
  const md = `${clean}\n[P09] Major cleared his throat and spoke about the barn（谷仓）, the lantern（提灯） and the flag（旗帜）.`;
  const r = burdenFindings(md, { tier: 'A' });
  assert.ok(r.profile.worstSentence, '最拥挤一句要被找出');
  assert.equal(r.profile.worstSentence!.annos, 3);
  assert.equal(r.profile.worstSentence!.segId, 'P09', '段号要继承（定位用）');
  assert.ok(r.findings.some((f) => f.note.includes('一句 3 处注释') && f.segId === 'P09'), '必须产生点名 finding');
});

test('最拥挤窗口：局部拥挤不被全文平均掩盖（滑窗按词序列，短段并入相邻窗）', () => {
  const clean = Array.from({ length: 10 }, () => 'The animals worked hard all day and the windmill grew taller and taller every week without rest.').join('\n');
  const crowd = Array.from({ length: 6 }, () => 'The barn（谷仓） shone under the lantern（提灯） near the flag（旗帜） by the gate（大门） at dawn（黎明）.').join('\n');
  const p = burdenProfileOf(`${clean}\n${crowd}`);
  assert.ok(p.worstWindow, '要算出最拥挤窗口');
  assert.ok(p.worstWindow!.density >= 10, `拥挤区密度应显著高于 M 线 4（实得 ${p.worstWindow!.density}）`);
  /* 全文平均应明显低于最差窗口——这正是"保留最差局部"的意义 */
  assert.ok(p.densityPer100 < p.worstWindow!.density, '全文平均不得冒充最差局部');
});

test('阈值表：A6/M4/B3 与句长 20/17/14（试运行阈值，改表必须显式）', () => {
  assert.deepEqual(ANNO_DENSITY_LIMIT, { A: 6, M: 4, B: 3 });
  assert.deepEqual(SENT_LEN_CHECK, { A: 20, M: 17, B: 14 });
});

test('密度超线触发难度级 finding；必要概念过半时给归因说明（不为指标删情节）', () => {
  /* 每句 2 注、约 12 词/句 → 密度远超 B 线 3；注释词全是必要概念 */
  const md = Array.from({ length: 8 }, () => '[P01] Napoleon（拿破仑） and Snowball（雪球） argued about the windmill（风车） and the plan（计划） again.').join('\n');
  const r = burdenFindings(md, { tier: 'B', mustKeep: ['napoleon', 'snowball', 'windmill', 'plan'] });
  assert.ok(r.findings.some((f) => f.level === '难度' && f.note.startsWith('注释拥挤')), '密度超线要报');
  assert.ok(r.findings.some((f) => f.note.startsWith('归因') && f.note.includes('必要概念')), '必要概念造成的拥挤要有归因说明');
});

test('最长句超线触发检查（A 层 20 词线）', () => {
  const long = `Major stood on the platform and looked at all the animals who had come into the barn that night and he told them about his dream of a world where animals were free.`;
  assert.ok((long.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).length > 20, '用例前提：这句确实超 20 词');
  const r = burdenFindings(`[P01] ${long}`, { tier: 'A' });
  assert.ok(r.findings.some((f) => f.note.startsWith('最长句')), '超线要报');
});

test('情节保真：否定整类消失触发信息变化级；正常改写不误报', () => {
  const src = Array.from({ length: 6 }, (_, i) => `Rule ${i + 1}: animals must not sleep in a bed, and no animal can drink alcohol.`).join('\n');
  const kept = `Rule one: animals must not sleep in a bed. No animal can drink alcohol. Rule two: no animal shall kill another. Animals never wear clothes. They do not smoke. No animal sleeps in a bed.`;
  assert.equal(fidelityFindings(src, kept).length, 0, '否定保留的改写不应报');

  const flipped = Array.from({ length: 6 }, (_, i) => `Rule ${i + 1}: animals may sleep in a bed and any animal can drink alcohol if they want.`).join('\n');
  const findings = fidelityFindings(src, flipped);
  assert.ok(findings.some((f) => f.level === '信息变化' && f.note.includes('否定表达明显减少')), '"不得→可以"式反向必须被抓为待确认');
  assert.ok(fidelityCountsOf(src).negations >= 3, '用例前提：原文否定数足够');
});

test('新引入词：第二轮换进来的新难词必须被抓（防绕过）；词形变形不算引入', () => {
  const src = 'The old horse worked on the farm every day.';
  const out = 'The decrepit equine laboured on the farmyard daily.';
  const hard = (w: string) => ['decrepit', 'equine', 'laboured', 'farmyard'].includes(w);
  assert.deepEqual(introducedHardWords(src, out, hard), ['decrepit', 'equine', 'farmyard', 'laboured'], '原文已有的词不算，新难词全数点名（laboured 是 worked 换进来的新难词）');

  /* 词形家族容错：原文 action，产物 actions——不是引入 */
  const ok = introducedHardWords('They took action on the farm.', 'They took quick actions on the farm.', () => true);
  assert.deepEqual(ok, ['quick'], '变形词（actions）不算引入，真新词（quick）才点名');
  assert.equal(knownWordHit('actions', new Set(['action'])), true, '已学集合命中要过词形家族');
  assert.equal(knownWordHit("animal's", new Set(['animal'])), true, '所有格归一');
  assert.equal(knownWordHit('running', new Set(['run'])), true, '双写变形');
});

test('负担剖面跳过标题与引用元数据行（header 的英文不是学生读的正文）', () => {
  const md = `# AF 第一章 原文基线 v0.1\n\n> 来源：rebuild draft 128 sentences OCR cleaned\n\n[P01] The animals worked hard all day on the farm.`;
  const p = burdenProfileOf(md);
  assert.equal(p.words, (md.match(/The animals worked hard all day on the farm./g) ?? [''])[0].match(/[A-Za-z][A-Za-z'-]*/g)?.length, '只数正文段的词');
});

test('教师反馈解析：维度+保留维度+幅度档位+点名词（自然语言一句话进，结构化出）', () => {
  const f = parseTeacherFeedback('词汇大概超前一学期，句子有些绕，人物和情节可以。这个 barn 他们也不会，同类的一起降一下。');
  assert.deepEqual(f.dims.sort(), ['句法', '词汇']);
  assert.ok(f.keep.some((k) => /理解|情节|人物/.test(k)), '"人物和情节可以"要被识别为保留维度');
  assert.equal(f.magnitude, '明显', '一学期 → 明显（回退 2 单元）');
  assert.ok(f.tooHardWords.includes('barn'), '点名的英文词要被抽出（举一反三的种子）');
  assert.equal(MAGNITUDE_UNITS[f.magnitude!], 2);

  const g = parseTeacherFeedback('整体还是太难了，大概差一整个学年');
  assert.equal(g.magnitude, '大幅');
  assert.equal(MAGNITUDE_UNITS[g.magnitude], 4);
  assert.equal(g.dims.length >= 4, true, '"整体"要展开为全部维度');

  const h = parseTeacherFeedback('稍微容易一点点就行');
  assert.equal(h.magnitude, '轻度');
});

/* ────────────────────── 修订任务单（v2 §5.2：先确认后执行） ────────────────────── */

import { planRevisionTask, planRevisionStages, revisionTaskPreview, FEEDBACK_STAGE_MAP } from '../src/core/adaptcheck.js';

test('任务单：词汇偏难+情节可以 → 只跑词汇线，plot 进保护维度', () => {
  const task = planRevisionTask('第七章', 'v1', '词汇超前一学期，情节和人物可以');
  const stages = planRevisionStages(task);
  assert.deepEqual(stages, ['vocab-primary', 'vocab-secondary', 'annotation'], '表 2：词汇偏难→粗筛→复筛→加注，不碰句法');
  assert.ok(task.protectedDimensions.includes('plot'), '情节可以 → plot 受保护');
  assert.ok(task.protectedDimensions.includes('characters'), '人物可以 → characters 受保护');
  assert.ok(task.protectedDimensions.includes('facts'), 'facts 恒在保护集（数字/否定/因果基线）');
  assert.equal(task.magnitude, '明显', '一学期 → 明显档（2 单元回退）');
  assert.equal(task.needsHuman.length, 0);
});

test('任务单：句子偏长 → 只跑句法+复筛，词汇难度不动', () => {
  const stages = planRevisionStages(planRevisionTask('第七章', 'v1', '句子偏长'));
  assert.deepEqual(stages, ['syntax', 'vocab-secondary']);
});

test('任务单：注释太密 → 只重排加注；情节有疑问 → 转人工不跑 AI', () => {
  const anno = planRevisionStages(planRevisionTask('第七章', 'v1', '注释太密'));
  assert.deepEqual(anno, ['annotation']);
  const plot = planRevisionTask('第七章', 'v1', '这段情节是不是改错了');
  assert.equal(planRevisionStages(plot).length, 0, '情节疑问不进任何工序');
  assert.ok(plot.needsHuman.length > 0, '必须显式提示人工确认');
});

test('任务单：点名词举一反三；整章反馈圈全章；标记词合并', () => {
  const task = planRevisionTask('第七章', 'v1', 'tyrannised 和 emboldened 太难', { markedTooHard: ['tyrannised', 'grudge'] });
  assert.ok(task.stages.some((s) => s.stage === 'vocab-primary' && s.scope === 'terms'), '点名词走 terms 范围');
  assert.deepEqual([...new Set(task.seedWords)].sort(), ['emboldened', 'grudge', 'tyrannised'], '正文标记与点名合并去重');

  const whole = planRevisionTask('第七章', 'v1', '整体还是太难了，超前一学年');
  assert.ok(whole.stages.every((s) => s.scope === 'chapter'), '整体反馈 → 全章范围');
  assert.equal(whole.magnitude, '大幅');
});

test('任务单：解析不出维度时预览必须显式停下（不许默默执行）', () => {
  const task = planRevisionTask('第七章', 'v1', '嗯，还行吧');
  const preview = revisionTaskPreview(task);
  assert.equal(task.stages.length, 0);
  assert.ok(preview.some((l) => l.includes('未解析出可执行的维度')), preview.join(' / '));
});

test('预览渲染：将修改/保留/幅度三行齐全，App 与 CLI 同一份', () => {
  const preview = revisionTaskPreview(planRevisionTask('第七章', 'v1', '词汇偏难一个学期，人物关系可以'));
  assert.ok(preview[0]!.startsWith('将修改：词汇粗筛'), preview[0]);
  assert.ok(preview[1]!.includes('characters'));
  assert.ok(preview[2]!.includes('明显'));
  assert.ok(FEEDBACK_STAGE_MAP.词汇.includes('annotation'));
});
