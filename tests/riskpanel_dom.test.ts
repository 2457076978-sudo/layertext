/**
 * 风险队列面板 · DOM 级测试（happy-dom，无屏幕环境可跑）
 *
 * 验收（《LayerText 项目审查报告（2026-09-11）》§一）：
 *   「每项显示原句、改写句、触发规则、上下文两句和『一键采纳/退回/标记误报』」
 *   「界面应先显示 风险 = 概率 × 后果 队列」——也就是**不再按段顺序呈现**。
 */

import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { Window } from 'happy-dom';

const win = new Window();
before(() => {
  (globalThis as Record<string, unknown>).document = win.document;
  (globalThis as Record<string, unknown>).window = win;
});

import { parseDecisionLog } from '../src/core/decision.js';
import { renderRiskPane, setRiskIo, type RiskQueueFile } from '../app/src/risk.js';
import type { RiskItem } from '../src/core/riskqueue.js';

const TAG = 'A层85';

const item = (over: Partial<RiskItem> = {}): RiskItem => ({
  id: '第一章#2:FACT-01:1911',
  ruleId: 'FACT-01',
  category: '事实',
  severity: 'warn',
  consequence: 22,
  probability: 0.6,
  risk: 13.2,
  chapter: '第一章',
  segIndex: 2,
  segLabel: '第一章 第3段',
  title: '原文的「1911」在改写里找不到',
  sourceSentence: 'In 1911 Napoleon gave a speech.',
  rewrittenSentence: 'The pig gave a speech.',
  context: { prev: 'The animals met in the barn.', next: 'Everyone listened quietly.' },
  detail: { signal: '1911' },
  ...over,
});

function queueFile(): RiskQueueFile {
  return {
    schemaVersion: 1,
    书名: 'Animal Farm',
    层级: ['A'],
    章节: [1],
    摘要: { total: 2, blockers: 1, byRule: {}, byCategory: {}, estimatedMinutes: 3 },
    队列: [
      item(),
      item({ id: '第一章#2:ANNO-01:windmill', ruleId: 'ANNO-01', category: '加注', severity: 'blocker', risk: 10, title: '超纲词 windmill 没有加注', detail: { word: 'windmill' } }),
    ],
  };
}

function setup(files: Record<string, string>): void {
  win.document.body.innerHTML = '<section id="pane-risk"></section>';
  setRiskIo({
    read: (p) => (p in files ? Promise.resolve(files[p]!) : Promise.reject(new Error('no file'))),
    write: (p, c) => { files[p] = c; return Promise.resolve(); },
    listDir: () => Promise.resolve([]),
  });
}

const render = (files: Record<string, string>, tier = 'A') =>
  renderRiskPane({
    dom: win.document as never,
    tier,
    paths: { outDir: '/out', workDir: '/work', sourceVersion: 'sha-1' },
    teacherId: 'wayne',
  }).then((r) => r);

test('每张卡都齐：原句、改写句、上下文两句、触发规则、风险分、位置', async () => {
  const files = { [`/out/_运行/风险队列_${TAG}.json`]: JSON.stringify(queueFile()) };
  setup(files);
  const r = await render(files);
  assert.equal(r.ok, true);
  const html = win.document.getElementById('pane-risk')!.innerHTML;
  for (const need of [
    'In 1911 Napoleon gave a speech.',      // 原句
    'The pig gave a speech.',               // 改写句
    'The animals met in the barn.',         // 上下文（上）
    'Everyone listened quietly.',           // 上下文（下）
    'FACT-01',                              // 触发规则
    '风险 13.2',                            // 风险 = 概率 × 后果
    '第一章 第3段',                          // 位置
  ]) {
    assert.equal(html.includes(need), true, `卡片缺「${need}」`);
  }
});

test('每张卡：一个规则主键 + 两个决定键，都带 data-id（决定靠 itemId 关联）', async () => {
  const files = { [`/out/_运行/风险队列_${TAG}.json`]: JSON.stringify(queueFile()) };
  setup(files);
  await render(files);
  const acts = Array.from(win.document.querySelectorAll('#pane-risk [data-act]'));
  const decs = Array.from(win.document.querySelectorAll('#pane-risk [data-decide]'));
  assert.equal(acts.length, 2, '两条待办 × 一个规则主键');
  assert.equal(decs.length, 4, '两条待办 × 两个决定键');
  assert.deepEqual([...new Set(decs.map((b) => b.getAttribute('data-decide')))].sort(), ['false-positive', 'reject']);
  assert.equal(acts[0]!.getAttribute('data-id'), '第一章#2:FACT-01:1911');
  assert.equal(acts[0]!.getAttribute('data-act'), 'confirm', 'FACT 类主键是"认可"，不改正文');
});

test('按风险排序呈现，不是按段顺序：事实类（13.2）排在漏注（10）之前', async () => {
  const files = { [`/out/_运行/风险队列_${TAG}.json`]: JSON.stringify(queueFile()) };
  setup(files);
  await render(files);
  const html = win.document.getElementById('pane-risk')!.innerHTML;
  assert.equal(html.indexOf('FACT-01') < html.indexOf('ANNO-01'), true, '引擎给的顺序必须原样呈现');
});

test('先看统计：总数/待办/不可完成/估时/误报率/未完成段落都在页首', async () => {
  const f = queueFile();
  f.未完成段落 = [{ tier: 'A', chapter: '第一章', segId: 'P02', segIndex: 1, source: 'x' }];
  const files = { [`/out/_运行/风险队列_${TAG}.json`]: JSON.stringify(f) };
  setup(files);
  await render(files);
  const html = win.document.getElementById('pane-risk')!.innerHTML;
  assert.match(html, /共 <b>2<\/b> 条/);
  assert.match(html, /待办 <b>2<\/b>/);
  assert.match(html, /不可完成 <b>1<\/b>/);
  assert.match(html, /未完成段落 1/);
  assert.match(html, /一小时|看统计|处理事实/);
});

test('点「标记误报」= 追加一条不可变事件，卡片从待办里消失但不删历史', async () => {
  const files: Record<string, string> = { [`/out/_运行/风险队列_${TAG}.json`]: JSON.stringify(queueFile()) };
  setup(files);
  await render(files);
  const btn = win.document.querySelector('#pane-risk [data-decide="false-positive"]') as unknown as { click(): void; dispatchEvent(e: Event): boolean };
  // happy-dom 的 click() 会派发事件并走委托绑定
  btn.click();
  await new Promise((res) => setTimeout(res, 10));
  const log = files[`/work/_决定/${TAG}.jsonl`]!;
  const { events } = parseDecisionLog(log);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.decision, 'false-positive');
  assert.equal(events[0]!.itemId, '第一章#2:FACT-01:1911');
  assert.equal(events[0]!.teacherId, 'wayne');
  assert.equal(events[0]!.sourceVersion, 'sha-1');
  assert.equal(events[0]!.ruleIds.includes('FACT-01'), true);
  assert.deepEqual(events[0]!.subject, { kind: 'number', value: '1911' });
  const html = win.document.getElementById('pane-risk')!.innerHTML;
  assert.equal(html.includes('data-id="第一章#2:FACT-01:1911"'), false, '决定过的从待办里消失');
  assert.equal(html.includes('data-id="第一章#2:ANNO-01:windmill"'), true, '没决定的还在');
});

test('没有队列时给人话提示而不是空白崩溃', async () => {
  const files: Record<string, string> = {};
  setup(files);
  const r = await render(files);
  assert.equal(r.ok, false);
  const html = win.document.getElementById('pane-risk')!.innerHTML;
  assert.match(html, /还没有风险队列/);
  assert.match(html, /LayerText_AF风险队列\.mjs/, '告诉教师怎么生成，而不是只说"没有"');
});

/* ────────────────── 动作 + 事件 = 一个事务（v4 方向第 2 条） ────────────────── */

const ANNO_ITEM = (over: Partial<RiskItem> = {}): RiskItem =>
  item({
    id: '第一章#0:ANNO-01:barn',
    ruleId: 'ANNO-01',
    category: '加注',
    severity: 'blocker',
    risk: 10,
    title: '超纲词 barn 没有加注',
    detail: { word: 'barn', field: undefined },
    ...over,
  });

function actionSetup(files: Record<string, string>): void {
  win.document.body.innerHTML = '<section id="pane-risk"></section>';
  setRiskIo({
    read: (p) => (p in files ? Promise.resolve(files[p]!) : Promise.reject(new Error('no file'))),
    write: (p, c) => { files[p] = c; return Promise.resolve(); },
    listDir: () => Promise.resolve([]),
  });
}

test('主键按钮文案跟着规则走（不再是三个统一的"采纳/退回/误报"）', async () => {
  const f: RiskQueueFile = {
    schemaVersion: 1, 层级: ['A'], 章节: [1],
    摘要: { total: 2, blockers: 1, byRule: {}, byCategory: {}, estimatedMinutes: 3 },
    队列: [
      ANNO_ITEM(),
      item({ id: '第一章#2:FACT-01:1911', ruleId: 'FACT-01', category: '事实', detail: { signal: '1911' } }),
    ],
  };
  const files: Record<string, string> = {
    [`/out/_运行/风险队列_${TAG}.json`]: JSON.stringify(f),
    '/book/第一章/原文_A层85_2026-09-10.md': '## Chapter One\n\n[P01] The boy ran to the barn.\n',
  };
  actionSetup(files);
  await renderRiskPane({
    dom: win.document as never,
    tier: 'A',
    paths: { outDir: '/out', workDir: '/work', sourceVersion: 's', dictPath: '/p/dict.csv' },
    teacherId: 'wayne',
  });
  const html = win.document.getElementById('pane-risk')!.innerHTML;
  assert.match(html, /＋ 补上注释/, 'ANNO-01 的主键是"补上注释"');
  assert.match(html, /✓ 认可这个删减/, 'FACT-01 的主键是"认可这个删减"');
  assert.equal(html.includes('✓ 采纳改写'), false, '模糊的"采纳改写"必须消失');
  assert.equal(html.includes('主键会**改正文**'), true, '改正文的卡片要说明主键会改稿');
});

test('点「补上注释」= 改正文 + 记事件（一次事务），两个结果都落在盘上', async () => {
  const f: RiskQueueFile = {
    schemaVersion: 1, 层级: ['A'], 章节: [1],
    摘要: { total: 1, blockers: 1, byRule: {}, byCategory: {}, estimatedMinutes: 0.5 },
    队列: [ANNO_ITEM()],
    章节产物: { 第一章: '/out/第一章/原文_A层85_2026-09-10.md' },
  };
  const files: Record<string, string> = {
    [`/out/_运行/风险队列_${TAG}.json`]: JSON.stringify(f),
    '/out/第一章/原文_A层85_2026-09-10.md': '## Chapter One\n\n[P01] The boy ran to the barn.\n',
    '/p/dict.csv': '词,释义,来源\nbarn,谷仓\n',
  };
  actionSetup(files);
  const r = await renderRiskPane({
    dom: win.document as never,
    tier: 'A',
    paths: { outDir: '/out', workDir: '/work', sourceVersion: 's', dictPath: '/p/dict.csv' },
    teacherId: 'wayne',
  });
  assert.equal(r.ok, true);
  const btn = win.document.querySelector('#pane-risk [data-act="insert-annotation"]') as unknown as { click(): void };
  btn.click();
  await new Promise((res) => setTimeout(res, 30));

  // ① 正文真的改了（这是"事件不是理由、正文变更才是结果"）
  assert.match(files['/out/第一章/原文_A层85_2026-09-10.md']!, /barn（谷仓）/);
  // ② 事件也写了，带 before/after
  const ev = parseDecisionLog(files[`/work/_决定/${TAG}.jsonl`] ?? '').events;
  assert.equal(ev.length, 1);
  assert.equal(ev[0]!.decision, 'accept');
  assert.equal(ev[0]!.itemId, '第一章#0:ANNO-01:barn');
  assert.match(ev[0]!.reason, /barn → barn（谷仓）/);
});

test('动作执行失败：只写 rejected 事件，**卡片不许消失**、正文不许动', async () => {
  const f: RiskQueueFile = {
    schemaVersion: 1, 层级: ['A'], 章节: [1],
    摘要: { total: 1, blockers: 1, byRule: {}, byCategory: {}, estimatedMinutes: 0.5 },
    队列: [ANNO_ITEM({ id: '第一章#9:ANNO-01:barn' })],   // 段号 P10，正文里没有
    章节产物: { 第一章: '/out/第一章/原文_A层85_2026-09-10.md' },
  };
  const before = '## Chapter One\n\n[P01] The boy ran to the barn.\n';
  const files: Record<string, string> = {
    [`/out/_运行/风险队列_${TAG}.json`]: JSON.stringify(f),
    '/out/第一章/原文_A层85_2026-09-10.md': before,
    '/p/dict.csv': '词,释义,来源\nbarn,谷仓\n',
  };
  actionSetup(files);
  await renderRiskPane({
    dom: win.document as never,
    tier: 'A',
    paths: { outDir: '/out', workDir: '/work', sourceVersion: 's', dictPath: '/p/dict.csv' },
    teacherId: 'wayne',
  });
  const btn = win.document.querySelector('#pane-risk [data-act="insert-annotation"]') as unknown as { click(): void };
  btn.click();
  await new Promise((res) => setTimeout(res, 30));

  assert.equal(files['/out/第一章/原文_A层85_2026-09-10.md'], before, '失败时正文一个字节都不能动');
  const ev = parseDecisionLog(files[`/work/_决定/${TAG}.jsonl`] ?? '').events;
  assert.equal(ev.length, 1);
  assert.equal(ev[0]!.decision, 'rejected', '"执行失败"与教师的"退回重写"是两回事，必须分开记');
  assert.match(ev[0]!.reason, /找不到段落|找不到/);
  const html = win.document.getElementById('pane-risk')!.innerHTML;
  assert.match(html, /这一条仍在待办里/, '失败要有说明，不是白点一下');
  assert.match(html, /data-item="第一章#9:ANNO-01:barn"/, '★ 卡片不许消失——否则就是"卡片没了、正文也没变"的两头空');
});

test('没有统一词典时补注被拒并说明原因（不插一个空括号）', async () => {
  const f: RiskQueueFile = {
    schemaVersion: 1, 层级: ['A'], 章节: [1],
    摘要: { total: 1, blockers: 1, byRule: {}, byCategory: {}, estimatedMinutes: 0.5 },
    队列: [ANNO_ITEM()],
    章节产物: { 第一章: '/out/第一章/原文_A层85_2026-09-10.md' },
  };
  const before = '## Chapter One\n\n[P01] The boy ran to the barn.\n';
  const files: Record<string, string> = {
    [`/out/_运行/风险队列_${TAG}.json`]: JSON.stringify(f),
    '/out/第一章/原文_A层85_2026-09-10.md': before,
  };
  actionSetup(files);
  await renderRiskPane({
    dom: win.document as never,
    tier: 'A',
    paths: { outDir: '/out', workDir: '/work', sourceVersion: 's' },   // 没给 dictPath
    teacherId: 'wayne',
  });
  const btn = win.document.querySelector('#pane-risk [data-act="insert-annotation"]') as unknown as { click(): void };
  btn.click();
  await new Promise((res) => setTimeout(res, 30));
  assert.equal(files['/out/第一章/原文_A层85_2026-09-10.md'], before);
  const ev = parseDecisionLog(files[`/work/_决定/${TAG}.jsonl`] ?? '').events;
  assert.equal(ev[0]!.decision, 'rejected');
  assert.match(ev[0]!.reason, /释义/);
});
