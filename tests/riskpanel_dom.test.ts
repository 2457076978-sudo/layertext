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

test('三个决定键都在，且带 data-decide / data-id（决定靠 itemId 关联）', async () => {
  const files = { [`/out/_运行/风险队列_${TAG}.json`]: JSON.stringify(queueFile()) };
  setup(files);
  await render(files);
  const btns = Array.from(win.document.querySelectorAll('#pane-risk [data-decide]'));
  assert.equal(btns.length, 6, '两条待办 × 三个键');
  const kinds = new Set(btns.map((b) => b.getAttribute('data-decide')));
  assert.deepEqual([...kinds].sort(), ['accept', 'false-positive', 'reject']);
  assert.equal(btns[0]!.getAttribute('data-id'), '第一章#2:FACT-01:1911');
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
