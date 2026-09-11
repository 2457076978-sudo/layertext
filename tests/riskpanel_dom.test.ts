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
import { parseWorkbenchLog } from '../src/core/workbench.js';
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
    队列: [item(), item({ id: '第一章#2:ANNO-01:windmill', ruleId: 'ANNO-01', category: '加注', severity: 'blocker', risk: 10, title: '超纲词 windmill 没有加注', detail: { word: 'windmill' } })],
  };
}

function setup(files: Record<string, string>): void {
  win.document.body.innerHTML = '<section id="pane-risk"></section>';
  setRiskIo({
    read: (p) => (p in files ? Promise.resolve(files[p]!) : Promise.reject(new Error('no file'))),
    write: (p, c) => {
      files[p] = c;
      return Promise.resolve();
    },
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
    'In 1911 Napoleon gave a speech.', // 原句
    'The pig gave a speech.', // 改写句
    'The animals met in the barn.', // 上下文（上）
    'Everyone listened quietly.', // 上下文（下）
    'FACT-01', // 触发规则
    '风险 13.2', // 风险 = 概率 × 后果
    '第一章 第3段', // 位置
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
  const events = decisionsIn(log);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.decision, 'false-positive');
  assert.equal(events[0]!.itemId, '第一章#2:FACT-01:1911');
  assert.equal(events[0]!.teacherId, 'wayne');
  /* ★ `sourceVersion` 现在记的是**这一轮队列产物的内容哈希**，不是层级标签。
   * 层级标签（`A层85`）回答不了"这条决定是对着哪一版做的"——一个季度后再看，
   * 它指向的那份稿早被改过很多次了。哈希让"同一份队列"与"改过一点的队列"当场可区分。 */
  assert.match(events[0]!.sourceVersion, /^[0-9a-f]{16}$/);
  assert.notEqual(events[0]!.sourceVersion, 'sha-1', '不再是调用方随便传进来的那个标签');
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

/** 决定日志里还会混着"打开队列"那条 session-open（面板打开时写，用来算首次上手时间）。
 *  数"决定"时要把它滤掉——但**不能因此就说它不该写**：产品指标正是靠它算的。 */
const decisionsIn = (log: string) => parseDecisionLog(log).events.filter((e) => e.itemId !== 'session-open');

function actionSetup(files: Record<string, string>): void {
  win.document.body.innerHTML = '<section id="pane-risk"></section>';
  setRiskIo({
    read: (p) => (p in files ? Promise.resolve(files[p]!) : Promise.reject(new Error('no file'))),
    write: (p, c) => {
      files[p] = c;
      return Promise.resolve();
    },
    listDir: () => Promise.resolve([]),
  });
}

test('主键按钮文案跟着规则走（不再是三个统一的"采纳/退回/误报"）', async () => {
  const f: RiskQueueFile = {
    schemaVersion: 1,
    层级: ['A'],
    章节: [1],
    摘要: { total: 2, blockers: 1, byRule: {}, byCategory: {}, estimatedMinutes: 3 },
    队列: [ANNO_ITEM(), item({ id: '第一章#2:FACT-01:1911', ruleId: 'FACT-01', category: '事实', detail: { signal: '1911' } })],
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
  assert.match(html, /主键会改正文并同时记事件/, '改正文的卡片要说明主键会改稿');
});

test('点「补上注释」= 改正文 + 记事件（一次事务），两个结果都落在盘上', async () => {
  const f: RiskQueueFile = {
    schemaVersion: 1,
    层级: ['A'],
    章节: [1],
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
  const ev = decisionsIn(files[`/work/_决定/${TAG}.jsonl`] ?? '');
  assert.equal(ev.length, 1);
  assert.equal(ev[0]!.decision, 'accept');
  assert.equal(ev[0]!.itemId, '第一章#0:ANNO-01:barn');
  assert.match(ev[0]!.reason, /barn → barn（谷仓）/);
});

test('动作执行失败：只写 rejected 事件，**卡片不许消失**、正文不许动', async () => {
  const f: RiskQueueFile = {
    schemaVersion: 1,
    层级: ['A'],
    章节: [1],
    摘要: { total: 1, blockers: 1, byRule: {}, byCategory: {}, estimatedMinutes: 0.5 },
    队列: [ANNO_ITEM({ id: '第一章#9:ANNO-01:barn' })], // 段号 P10，正文里没有
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
  const ev = decisionsIn(files[`/work/_决定/${TAG}.jsonl`] ?? '');
  assert.equal(ev.length, 1);
  assert.equal(ev[0]!.decision, 'rejected', '"执行失败"与教师的"退回重写"是两回事，必须分开记');
  assert.match(ev[0]!.reason, /找不到段落|找不到/);
  const html = win.document.getElementById('pane-risk')!.innerHTML;
  assert.match(html, /这一条仍在待办里/, '失败要有说明，不是白点一下');
  assert.match(html, /data-item="第一章#9:ANNO-01:barn"/, '★ 卡片不许消失——否则就是"卡片没了、正文也没变"的两头空');
});

test('没有统一词典时补注被拒并说明原因（不插一个空括号）', async () => {
  const f: RiskQueueFile = {
    schemaVersion: 1,
    层级: ['A'],
    章节: [1],
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
    paths: { outDir: '/out', workDir: '/work', sourceVersion: 's' }, // 没给 dictPath
    teacherId: 'wayne',
  });
  const btn = win.document.querySelector('#pane-risk [data-act="insert-annotation"]') as unknown as { click(): void };
  btn.click();
  await new Promise((res) => setTimeout(res, 30));
  assert.equal(files['/out/第一章/原文_A层85_2026-09-10.md'], before);
  const ev = decisionsIn(files[`/work/_决定/${TAG}.jsonl`] ?? '');
  assert.equal(ev[0]!.decision, 'rejected');
  assert.match(ev[0]!.reason, /释义/);
});

/* ────────────────── 任务组与批量应用（v4 方向第 3 条） ────────────────── */

test('按任务组呈现：同词一组、给代表样本、其余可展开', async () => {
  const items = Array.from({ length: 5 }, (_, i) => ANNO_ITEM({ id: `第一章#${i}:ANNO-01:barn`, segIndex: i, segLabel: `第一章 第${i + 1}段` }));
  const f: RiskQueueFile = {
    schemaVersion: 1,
    层级: ['A'],
    章节: [1],
    摘要: { total: 5, blockers: 5, byRule: {}, byCategory: {}, estimatedMinutes: 2.5 },
    章节产物: { 第一章: '/out/第一章/原文_A层85_2026-09-10.md' },
    队列: items,
  };
  const files: Record<string, string> = { [`/out/_运行/风险队列_${TAG}.json`]: JSON.stringify(f) };
  actionSetup(files);
  await renderRiskPane({
    dom: win.document as never,
    tier: 'A',
    paths: { outDir: '/out', workDir: '/work', sourceVersion: 's', dictPath: '/p/dict.csv' },
    teacherId: 'wayne',
  });
  const html = win.document.getElementById('pane-risk')!.innerHTML;
  assert.match(html, /同一个词：barn/, '同词聚成一组');
  assert.match(html, /5 条/);
  // 代表样本在 <details> 之外（默认可见），其余收在折叠区里——数"折叠前"的卡片才作数
  const beforeDetails = html.split('<details class="rq-more"')[0]!;
  assert.equal((beforeDetails.match(/data-item=/g) ?? []).length, 3, '默认只展开 3 条代表样本');
  assert.equal((html.match(/data-item=/g) ?? []).length, 5, '全部条目仍在 DOM 里（展开即可见）');
  assert.match(html, /展开这一组其余 2 条/);
  assert.match(html, /⚡ 全部应用（5 处）/, '动作统一 → 给批量入口');
  assert.match(html, /本次预算怎么排/, '一小时路径降级为折叠的后台估算');
  assert.match(html, /还没完：剩 5 条/, '"本次完成"状态是队列的权威判据');
});

test('批量应用：一章只读一次写一次，逐条走同一个 applyAction', async () => {
  const items = Array.from({ length: 3 }, (_, i) => ANNO_ITEM({ id: `第一章#${i}:ANNO-01:barn`, segIndex: i, segLabel: `第一章 第${i + 1}段` }));
  const f: RiskQueueFile = {
    schemaVersion: 1,
    层级: ['A'],
    章节: [1],
    摘要: { total: 3, blockers: 3, byRule: {}, byCategory: {}, estimatedMinutes: 1.5 },
    章节产物: { 第一章: '/out/第一章/原文_A层85_2026-09-10.md' },
    队列: items,
  };
  const src = '## Chapter One\n\n[P01] A barn here.\n\n[P02] A barn there.\n\n[P03] A barn again.\n';
  const files: Record<string, string> = {
    [`/out/_运行/风险队列_${TAG}.json`]: JSON.stringify(f),
    '/out/第一章/原文_A层85_2026-09-10.md': src,
    '/p/dict.csv': '词,释义,来源\nbarn,谷仓\n',
  };
  // 只数**正文**的写入次数（决定日志本来就要一条一条写，混在一起数说明不了任何事）
  let docWrites = 0;
  const DOC = '/out/第一章/原文_A层85_2026-09-10.md';
  win.document.body.innerHTML = '<section id="pane-risk"></section>';
  setRiskIo({
    read: (p) => (p in files ? Promise.resolve(files[p]!) : Promise.reject(new Error('no file'))),
    write: (p, c) => {
      if (p === DOC) docWrites++;
      files[p] = c;
      return Promise.resolve();
    },
    listDir: () => Promise.resolve([]),
  });
  await renderRiskPane({
    dom: win.document as never,
    tier: 'A',
    paths: { outDir: '/out', workDir: '/work', sourceVersion: 's', dictPath: '/p/dict.csv' },
    teacherId: 'wayne',
  });
  const btn = win.document.querySelector('#pane-risk [data-batch]') as unknown as { click(): void };
  btn.click();
  await new Promise((res) => setTimeout(res, 40));

  const out = files['/out/第一章/原文_A层85_2026-09-10.md']!;
  assert.equal((out.match(/barn（谷仓）/g) ?? []).length, 3, '三段都补上了注释');
  assert.equal(docWrites, 1, '一章只写一次（不是每条一次读改写）');
  const ev = decisionsIn(files[`/work/_决定/${TAG}.jsonl`] ?? '');
  assert.equal(ev.filter((e) => e.decision === 'accept').length, 3);
  assert.equal(
    ev.every((e) => /^批量/.test(e.reason)),
    true,
    '批量来源要留痕，事后分得清是批量还是逐条',
  );
});

test('动作不统一的组不给批量入口（宁可少一个按钮，也不做半对的事）', async () => {
  const f: RiskQueueFile = {
    schemaVersion: 1,
    层级: ['A'],
    章节: [1],
    摘要: { total: 2, blockers: 1, byRule: {}, byCategory: {}, estimatedMinutes: 1 },
    章节产物: { 第一章: '/out/第一章/原文_A层85_2026-09-10.md' },
    队列: [
      ANNO_ITEM({ detail: { word: 'barn' } }),
      item({ id: '第一章#0:ANNO-03:barn', ruleId: 'ANNO-03', category: '加注', severity: 'warn', risk: 6.3, title: 'barn 注成「仓房」', detail: { word: 'barn' } }),
    ],
  };
  const files: Record<string, string> = { [`/out/_运行/风险队列_${TAG}.json`]: JSON.stringify(f) };
  actionSetup(files);
  await renderRiskPane({
    dom: win.document as never,
    tier: 'A',
    paths: { outDir: '/out', workDir: '/work', sourceVersion: 's', dictPath: '/p/dict.csv' },
    teacherId: 'wayne',
  });
  const html = win.document.getElementById('pane-risk')!.innerHTML;
  assert.match(html, /同一个词：barn/, '还是归一组（同一个词）');
  assert.equal(html.includes('data-batch'), false, '但动作不同 → 不给"全部应用"');
});

test('卡片显示情节先验：等级 + 依据（只影响排序，不拦任何东西）', async () => {
  const f: RiskQueueFile = {
    schemaVersion: 1,
    层级: ['A'],
    章节: [1],
    摘要: { total: 1, blockers: 1, byRule: {}, byCategory: {}, estimatedMinutes: 0.5 },
    章节产物: { 第一章: '/out/第一章/原文_A层85_2026-09-10.md' },
    队列: [
      ANNO_ITEM({
        plot: {
          score: 0.72,
          level: '高',
          hits: ['底线原文锚点：i will work harder', '角色/地名：boxer'],
          parts: [],
        },
      }),
    ],
  };
  const files: Record<string, string> = { [`/out/_运行/风险队列_${TAG}.json`]: JSON.stringify(f) };
  actionSetup(files);
  await renderRiskPane({
    dom: win.document as never,
    tier: 'A',
    paths: { outDir: '/out', workDir: '/work', sourceVersion: 's', dictPath: '/p/dict.csv' },
    teacherId: 'wayne',
  });
  const html = win.document.getElementById('pane-risk')!.innerHTML;
  assert.match(html, /情节估计：高｜命中 底线原文锚点：i will work harder/);
  assert.match(html, /角色\/地名：boxer/);
});

test('★ 事件写失败 → 正文回滚，不留"改了稿却没记录"的状态', async () => {
  const f: RiskQueueFile = {
    schemaVersion: 1,
    层级: ['A'],
    章节: [1],
    摘要: { total: 1, blockers: 1, byRule: {}, byCategory: {}, estimatedMinutes: 0.5 },
    章节产物: { 第一章: '/out/第一章/原文_A层85_2026-09-10.md' },
    队列: [ANNO_ITEM()],
  };
  const src = '## Chapter One\n\n[P01] The boy ran to the barn.\n';
  const files: Record<string, string> = {
    [`/out/_运行/风险队列_${TAG}.json`]: JSON.stringify(f),
    '/out/第一章/原文_A层85_2026-09-10.md': src,
    '/p/dict.csv': '词,释义,来源\nbarn,谷仓\n',
  };
  win.document.body.innerHTML = '<section id="pane-risk"></section>';
  setRiskIo({
    read: (p) => (p in files ? Promise.resolve(files[p]!) : Promise.reject(new Error('no file'))),
    // 决定日志**写不进去**；正文照写——正好构造"改稿成功、记账失败"
    write: (p, c) => (/决定/.test(p) ? Promise.reject(new Error('磁盘满')) : ((files[p] = c), Promise.resolve())),
    listDir: () => Promise.resolve([]),
  });
  await renderRiskPane({
    dom: win.document as never,
    tier: 'A',
    paths: { outDir: '/out', workDir: '/work', sourceVersion: 's', dictPath: '/p/dict.csv' },
    teacherId: 'wayne',
  });
  const btn = win.document.querySelector('#pane-risk [data-act="insert-annotation"]') as unknown as { click(): void };
  btn.click();
  await new Promise((res) => setTimeout(res, 40));
  assert.equal(files['/out/第一章/原文_A层85_2026-09-10.md'], src, '记账失败必须把正文改回去');
  assert.match(win.document.getElementById('pane-risk')!.innerHTML, /已把正文改回原样/);
});

/* ══════════ 任务工作台（《LayerText工程优化总计划》阶段 2）：今日任务 / 暂停并恢复 / 变更历史 ══════════ */

/** 固定"现在"到当天中午：跨零点跑测试也不该把事件算到昨天去 */
const noon = (): Date => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d;
};
/** 相对"现在"的墙上时间（分钟） */
const atMin = (offset: number): string => new Date(noon().getTime() + offset * 60000).toISOString();

const ACT = (id: string, decision: 'accept' | 'reject' | 'false-positive' | 'edit' | 'undo', timestamp: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    schemaVersion: 1,
    itemId: id,
    decision,
    before: '原句',
    after: '改写句',
    reason: '',
    ruleIds: ['ANNO-01'],
    teacherId: 'wayne',
    timestamp,
    sourceVersion: 's',
    ...over,
  }) + '\n';

const items3 = (): RiskItem[] => [
  ANNO_ITEM({ id: '第一章#0:ANNO-01:barn', segIndex: 0, segLabel: '第一章 第1段' }),
  ANNO_ITEM({ id: '第一章#1:ANNO-01:barn', segIndex: 1, segLabel: '第一章 第2段' }),
  ANNO_ITEM({ id: '第一章#2:ANNO-01:barn' }),
];

const queueOf = (items: RiskItem[]): RiskQueueFile => ({
  schemaVersion: 1,
  层级: ['A'],
  章节: [1],
  摘要: { total: items.length, blockers: items.length, byRule: {}, byCategory: {}, estimatedMinutes: items.length * 0.5 },
  队列: items,
});

/** 面板在这一次渲染里长什么样：待办卡片、任务组、以及"页首"那一堆状态行 */
const snapshot = () => {
  const html = win.document.getElementById('pane-risk')!.innerHTML;
  return {
    html,
    items: Array.from(win.document.querySelectorAll('#pane-risk [data-item]')).map((b) => b.getAttribute('data-item')),
    groups: Array.from(win.document.querySelectorAll('#pane-risk [data-group]')).map((b) => b.getAttribute('data-group')),
  };
};

test('★ 重新打开仍是同一任务状态：暂停 → 10 分钟后 reopen → 待办与任务组一模一样，且暂停不进决定日志', async () => {
  let clock = new Date();
  clock.setHours(9, 0, 0, 0);
  const now = () => clock;
  const f = queueOf(items3());
  const DECISION = `/work/_决定/${TAG}.jsonl`;
  const WORKBENCH = `/work/_决定/工作台_${TAG}.jsonl`;
  const files: Record<string, string> = { [`/out/_运行/风险队列_${TAG}.json`]: JSON.stringify(f) };
  setup(files);
  const render = () => renderRiskPane({ dom: win.document as never, tier: 'A', paths: { outDir: '/out', workDir: '/work', sourceVersion: 's', dictPath: '/p/dict.csv' }, teacherId: 'wayne', now });

  await render();
  const before = snapshot();
  assert.equal(before.items.length, 3);
  assert.deepEqual(before.groups, ['word:barn']);
  assert.match(before.html, /data-workbench="pause"/, '暂停入口在页首');

  // 按暂停
  (win.document.querySelector('#pane-risk [data-workbench="pause"]') as unknown as { click(): void }).click();
  await new Promise((res) => setTimeout(res, 30));

  // ① 暂停点落进了**自己那本账**，而且是可核对的（指纹 + 组顺序）
  const journal = parseWorkbenchLog(files[WORKBENCH] ?? '');
  assert.equal(journal.badLines, 0);
  assert.equal(journal.markers.length, 1);
  assert.equal(journal.markers[0]!.kind, 'pause');
  assert.deepEqual(journal.markers[0]!.pending, before.items, '指纹 = 暂停那一刻的待办');
  assert.deepEqual(journal.markers[0]!.groups, before.groups);
  assert.match(journal.markers[0]!.pendingDigest, /^[0-9a-f]{12}$/);
  // ② ★ 决定日志里**一条暂停都没有**：它要是混进去，误报率/撤销率的分母就被挤偏了
  const ledger = parseDecisionLog(files[DECISION] ?? '').events;
  assert.deepEqual(
    ledger.map((e) => e.itemId),
    ['session-open'],
    '共享账本上只多了"打开队列"这一条，没有暂停',
  );
  assert.equal(
    ledger.some((e) => /暂停/.test(e.reason)),
    false,
  );

  // ③ 10 分钟后重新打开（同一个 clock 前进 10 分钟）
  clock = new Date(clock.getTime() + 10 * 60 * 1000);
  await render();
  const after = snapshot();
  assert.deepEqual(after.items, before.items, '★ 验收：10 分钟后重新打开仍是同一批待办');
  assert.deepEqual(after.groups, before.groups, '任务组与组顺序也一模一样');
  assert.match(after.html, /已暂停/);
  assert.match(after.html, /一模一样/);
  assert.match(after.html, /10\.0 分钟/);
  assert.match(after.html, /继续（回到同一任务状态）/, '回到面板时给的是"继续"，不是"重新开始"');

  // ④ 继续：再追加一条恢复标记，历史一条不删
  (win.document.querySelector('#pane-risk [data-workbench="resume"]') as unknown as { click(): void }).click();
  await new Promise((res) => setTimeout(res, 30));
  const j2 = parseWorkbenchLog(files[WORKBENCH] ?? '');
  assert.deepEqual(
    j2.markers.map((m) => m.kind),
    ['pause', 'resume'],
  );
  const resumed = snapshot();
  assert.deepEqual(resumed.items, before.items);
  assert.match(resumed.html, /data-workbench="pause"/, '恢复之后又变回"暂停"入口');
});

test('★ 暂停之后有人动了队列 → 恢复时**当场说**状态变了，并说清变的是哪几条', async () => {
  const clock = new Date();
  clock.setHours(10, 0, 0, 0);
  const now = () => clock;
  const f = queueOf(items3());
  const DECISION = `/work/_决定/${TAG}.jsonl`;
  const files: Record<string, string> = { [`/out/_运行/风险队列_${TAG}.json`]: JSON.stringify(f) };
  setup(files);
  const render = () => renderRiskPane({ dom: win.document as never, tier: 'A', paths: { outDir: '/out', workDir: '/work', sourceVersion: 's', dictPath: '/p/dict.csv' }, teacherId: 'wayne', now });

  await render();
  (win.document.querySelector('#pane-risk [data-workbench="pause"]') as unknown as { click(): void }).click();
  await new Promise((res) => setTimeout(res, 20));

  // 教师暂停期间，别处判了一条（批量 / 另一位教师 / 命令行都行）——直接写进决定日志
  files[DECISION] = (files[DECISION] ?? '') + ACT('第一章#0:ANNO-01:barn', 'accept', atMin(5), { reason: '批量' });
  clock.setMinutes(clock.getMinutes() + 10);

  (win.document.querySelector('#pane-risk [data-workbench="resume"]') as unknown as { click(): void }).click();
  await new Promise((res) => setTimeout(res, 30));

  const html = win.document.getElementById('pane-risk')!.innerHTML;
  assert.match(html, /你暂停之后任务状态变了/, '"回到同一任务状态"这句承诺不成立时，必须当场撤回');
  assert.match(html, /少了 1 条待办/);
  assert.match(html, /第一章 第1段/);
  assert.match(html, /待办列表已按最新的日志重算/, '不许读旧快照——列表是现算的');
  assert.equal(snapshot().items.length, 2, '列表真的少了一条');
});

test('★ 「看我判过的」真的渲染出来了（含已撤销标记与撤销键）', async () => {
  const f = queueOf([item({ id: '第一章#2:FACT-01:1911', detail: { signal: '1911' } }), ANNO_ITEM({ id: '第一章#0:ANNO-01:barn' })]);
  const acc = atMin(-30);
  const accB = atMin(-20);
  const files: Record<string, string> = {
    [`/out/_运行/风险队列_${TAG}.json`]: JSON.stringify(f),
    [`/work/_决定/${TAG}.jsonl`]:
      ACT('第一章#2:FACT-01:1911', 'accept', acc) +
      ACT('第一章#0:ANNO-01:barn', 'accept', accB) +
      JSON.stringify({
        schemaVersion: 1,
        itemId: '第一章#0:ANNO-01:barn',
        decision: 'undo',
        before: '改写句',
        after: '原句',
        reason: '改主意',
        ruleIds: ['ANNO-01'],
        teacherId: 'wayne',
        timestamp: atMin(-10),
        sourceVersion: 's',
        undoOf: `第一章#0:ANNO-01:barn@${accB}`,
      }) +
      '\n',
  };
  setup(files);
  await renderRiskPane({ dom: win.document as never, tier: 'A', paths: { outDir: '/out', workDir: '/work', sourceVersion: 's', dictPath: '/p/dict.csv' }, teacherId: 'wayne', now: noon });

  const rows = Array.from(win.document.querySelectorAll('#pane-risk .rq-done-row'));
  assert.equal(rows.length, 2, '两条都判过，都该出现在「看我判过的」里');
  const html = win.document.getElementById('pane-risk')!.innerHTML;
  assert.match(html, /看我判过的（2 条，可撤销）/);
  assert.match(html, /（已撤销）/, '被撤销的那条要标出来');
  const undoBtn = Array.from(win.document.querySelectorAll('#pane-risk [data-undo]'));
  assert.equal(undoBtn.length, 1, '只有还成立的那条给撤销键');
  assert.equal(undoBtn[0]!.getAttribute('data-undo'), `第一章#2:FACT-01:1911@${acc}`);
  assert.equal(html.includes(`data-undo="第一章#0:ANNO-01:barn@${accB}"`), false, '已经撤销过的不该再给撤销键');
});

test('★ 产品指标真的渲染出来了（而这些指标全靠事件日志算出来）', async () => {
  const f = queueOf([item({ id: '第一章#2:FACT-01:1911', detail: { signal: '1911' } }), ANNO_ITEM({ id: '第一章#0:ANNO-01:barn' })]);
  const files: Record<string, string> = {
    [`/out/_运行/风险队列_${TAG}.json`]: JSON.stringify(f),
    [`/work/_决定/${TAG}.jsonl`]:
      ACT('第一章#2:FACT-01:1911', 'accept', atMin(-30)) +
      ACT('第一章#0:ANNO-01:barn', 'accept', atMin(-20), { reason: '批量' }) +
      JSON.stringify({
        schemaVersion: 1,
        itemId: '第一章#0:ANNO-01:barn',
        decision: 'undo',
        before: '',
        after: '',
        reason: '撤销',
        ruleIds: ['ANNO-01'],
        teacherId: 'wayne',
        timestamp: atMin(-10),
        sourceVersion: 's',
        undoOf: `第一章#0:ANNO-01:barn@${atMin(-20)}`,
      }) +
      '\n',
  };
  setup(files);
  await renderRiskPane({ dom: win.document as never, tier: 'A', paths: { outDir: '/out', workDir: '/work', sourceVersion: 's', dictPath: '/p/dict.csv' }, teacherId: 'wayne', now: noon });

  const html = win.document.getElementById('pane-risk')!.innerHTML;
  assert.match(html, /我这边用得怎么样（产品指标）/);
  assert.equal(Array.from(win.document.querySelectorAll('#pane-risk .rq-metrics li')).length >= 3, true, '指标要逐条列出来，不是一个数');
  assert.match(html, /撤销率 \d+\.\d+%/);
  assert.match(html, /批量采纳占/);
  assert.match(html, /错误采纳率.*代理指标/, '错误采纳率只能标成代理指标，不许写成准确率');
  assert.equal(/准确率/.test(html), false);
});

test('★ 今日任务与变更历史都在页面上（变更历史是逐轮的，不是最新一条）', async () => {
  const f = queueOf([ANNO_ITEM({ id: '第一章#0:ANNO-01:barn' }), ANNO_ITEM({ id: '第一章#1:ANNO-01:barn', segIndex: 1, segLabel: '第一章 第2段' })]);
  const A = '第一章#0:ANNO-01:barn';
  const B = '第一章#1:ANNO-01:barn';
  const a1 = atMin(-50);
  const undoTxt = (id: string, target: string, t: string) =>
    JSON.stringify({
      schemaVersion: 1,
      itemId: id,
      decision: 'undo',
      before: '改写',
      after: '原句',
      reason: '改主意',
      ruleIds: ['ANNO-01'],
      teacherId: 'wayne',
      timestamp: t,
      sourceVersion: 's',
      undoOf: target,
    }) + '\n';
  const files: Record<string, string> = {
    [`/out/_运行/风险队列_${TAG}.json`]: JSON.stringify(f),
    [`/work/_决定/${TAG}.jsonl`]:
      // A：采纳 → 撤销 → 标记误报（三轮，最后那轮是今天成立的）
      ACT(A, 'accept', a1, { before: '原句 A', after: '改写 A', version: 'v-1' }) +
      undoTxt(A, `${A}@${a1}`, atMin(-40)) +
      ACT(A, 'false-positive', atMin(-10), { before: '原句 A', after: '原句 A' }) +
      // B：采纳 → 撤销（回到待办）
      ACT(B, 'accept', atMin(-30)) +
      undoTxt(B, `${B}@${atMin(-30)}`, atMin(-20)),
  };
  setup(files);
  await renderRiskPane({ dom: win.document as never, tier: 'A', paths: { outDir: '/out', workDir: '/work', sourceVersion: 's', dictPath: '/p/dict.csv' }, teacherId: 'wayne', now: noon });

  const html = win.document.getElementById('pane-risk')!.innerHTML;
  assert.match(html, /变更历史（2 项 · 5 条事件，逐轮列出）/);
  const rounds = Array.from(win.document.querySelectorAll('#pane-risk .rq-history-round')).map((b) => b.textContent ?? '');
  assert.equal(rounds.length, 5, '五轮都列出来，不是只列最新那条');
  assert.match(rounds[0]!, /第 1 轮 采纳（已被第 2 轮撤销）：原句 A → 改写 A/);
  assert.match(rounds[0]!, /版本 v-1/);
  assert.match(rounds[1]!, /第 2 轮 撤销（作废第 1 轮）/);
  assert.match(rounds[2]!, /第 3 轮 标记误报/);
  assert.match(rounds[4]!, /第 2 轮 撤销（作废第 1 轮）/, 'B 那两轮也在');
  assert.match(html, /现在：已决/);
  assert.match(html, /现在：待办/);
  assert.match(html, /状态可解释/, '这一串轮次加起来算什么状态，页面要有一句话');

  // 今日任务：同样在页首，而且**说清它不是日历**
  assert.match(html, /今日任务：今天开工时欠 \d+ 条/);
  assert.match(html, /今天办成 1 条/);
  assert.match(html, /撤销回待办 1 条/);
  assert.match(html, /现在还剩 1 条/);
  assert.match(html, /它不是日历、不是截止时间/);
});
