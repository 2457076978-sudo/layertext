/**
 * 待确认面板 · DOM 级测试（happy-dom，无屏幕环境可跑）
 *
 * ## 为什么专门测它
 *
 * 2026-09-13 教师的原话：**"我怎么也没看到那个生成的候选项呀"**。
 * 第一版把面板埋在「检 → 补注」视图里，功能是好的、测试也是绿的，**但人看不见**。
 * 所以这个用例盯的不是"数据对不对"，而是**"打开一章，右栏顶上有没有那条横幅、列表里有没有卡片"**。
 *
 * 另加一条：三个键点下去要**写回队列**（status），否则重算队列时决定就丢了。
 */

import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { Window } from 'happy-dom';

const win = new Window();
before(() => {
  (globalThis as Record<string, unknown>).document = win.document;
  (globalThis as Record<string, unknown>).window = win;
});

import { refreshPendingBanner, renderAnnotatePane, setAnnotateIo, setPaneFilter } from '../app/src/annotate.js';
import type { PendingItem, PendingQueue } from '../src/core/pendingqueue.js';
import type { FileSession } from '../app/src/types.js';

const SRC = '/book/调适工作区/重制三版/第一章/原文_A层85_2026-09-12_工序化.md';
/** 正文夹具：① 补注要能在文里**定位到词**（`locateWord` 用与渲染同一套索引）。 */
const MD = ['## Chapter One', '', '[P03] Major was respected for his tremendous powers of work. The straw was dry.', ''].join('\n');
const QUEUE_PATH = '/book/调适工作区/重制三版/_运行/待确认队列_A层85.json';

const item = (over: Partial<PendingItem> = {}): PendingItem => ({
  id: 'pq-1',
  kind: 'restore',
  chapter: '第一章',
  tier: 'A层85',
  para: 'P03',
  word: 'straw',
  gloss: '稻草',
  sentence: 'Major was already settled on his bed of dry grass there.',
  why: '教师词典登记过这个词，产物里却找不到它了',
  source: 'canon',
  ...over,
});

function fixture(): PendingQueue {
  return {
    tier: 'A层85',
    items: [
      item({ id: 'pq-star', word: 'tremendous', gloss: '极大的', star: true, kind: 'restore' }),
      item({ id: 'pq-canon', word: 'straw' }),
      item({ id: 'pq-anno', word: 'unsteady', gloss: '摇晃的', kind: 'annotate', source: 'model' }),
      item({ id: 'pq-other', chapter: '第二章', word: 'windmill' }), // 别的章：不该出现在本章列表里
      item({ id: 'pq-done', word: 'pellets', status: 'keep' }), // 已决定：不该再出现
    ],
    fragments: [],
    updatedAt: '',
  };
}

function setup(files: Record<string, string>): { files: Record<string, string>; views: string[]; marks: unknown[] } {
  win.document.body.innerHTML = '<aside><div id="side-review"></div></aside><section id="pane-annotate"></section>';
  const views: string[] = [];
  const marks: unknown[] = [];
  setAnnotateIo({
    read: (p) => (p in files ? Promise.resolve(files[p]!) : Promise.reject(new Error('no file'))),
    write: (p, c) => {
      files[p] = c;
      return Promise.resolve();
    },
    switchTo: (v) => {
      views.push(v);
    },
    session: () => ({ sourcePath: SRC, fileName: '原文_A层85_2026-09-12_工序化.md', md: MD }) as unknown as FileSession,
    addMark: (_s, m) => {
      marks.push(m);
    },
  });
  setPaneFilter('all');
  return { files, views, marks };
}

test('右栏横幅：打开一章就看得见「待确认 N 条 ▸ 去看」（教师找不到入口＝等于没做）', async () => {
  const { files, views } = setup({ [QUEUE_PATH]: JSON.stringify(fixture()) });
  assert.equal(files[QUEUE_PATH] !== undefined, true);
  await refreshPendingBanner();
  const banner = win.document.getElementById('pending-banner');
  assert.ok(banner, '右栏顶部必须有横幅——这正是上一版"看不见"的修法');
  assert.match(banner!.textContent ?? '', /待确认/);
  assert.match(banner!.textContent ?? '', /3/, '本章待确认 3 条（★/正本/补注各一；别的章与已决定的都不算）');
  (banner!.querySelector('#pending-go') as unknown as HTMLElement).click();
  assert.deepEqual(views, ['annotate'], '「去看」要切到待确认视图');
});

test('列表：只列本章未决定的，三档判据的标签各自不同', async () => {
  setup({ [QUEUE_PATH]: JSON.stringify(fixture()) });
  await renderAnnotatePane();
  const html = win.document.getElementById('pane-annotate')!.innerHTML;
  assert.equal(html.includes('tremendous'), true);
  assert.equal(html.includes('unsteady'), true);
  assert.equal(html.includes('windmill'), false, '第二章的词不该出现在第一章列表里');
  assert.equal(html.includes('pellets'), false, '已决定的条目不该再冒出来');
  assert.match(html, /★正本加注词/);
  assert.match(html, /补注/);
  assert.match(html, /待确认 3 条/);
});

test('三张卡各三个键 + 一个替换词输入框（② 要能直接填词，不能只说"换掉"）', async () => {
  setup({ [QUEUE_PATH]: JSON.stringify(fixture()) });
  await renderAnnotatePane();
  const btns = Array.from(win.document.querySelectorAll('#pane-annotate [data-pk-act]'));
  assert.equal(btns.length, 9, '3 条 × 3 个键');
  assert.deepEqual([...new Set(btns.map((b) => b.getAttribute('data-pk-act')))].sort(), ['annotate', 'keep', 'rewrite']);
  const inputs = Array.from(win.document.querySelectorAll('#pane-annotate [data-pk-input]'));
  assert.equal(inputs.length, 3, '每条一个替换词输入框——教师 2026-09-13："你直接换一个词不好吗？"');
});

test('筛选条：点「★加注词」只剩最硬的那一档', async () => {
  setup({ [QUEUE_PATH]: JSON.stringify(fixture()) });
  await renderAnnotatePane();
  const chips = Array.from(win.document.querySelectorAll('#pane-annotate [data-pk-filter]'));
  assert.equal(chips.length, 4, '全部 / ★ / 正本 / 补注');
  assert.match(win.document.getElementById('pane-annotate')!.innerHTML, /全部/);
  /* 计数按**渲染出来的文字**校验：2026-09-13 UI 重建把数字包进 .pk-count（等宽对齐），
     再拿 innerHTML 去匹配"全部 3"就变成了在测标签写法，而不是测这条筛选的行为。 */
  assert.match(chips[0]!.textContent ?? '', /全部\s*3/);
  (win.document.querySelector('[data-pk-filter="star"]') as unknown as HTMLElement).click();
  await new Promise((r) => setTimeout(r, 0));
  const html = win.document.getElementById('pane-annotate')!.innerHTML;
  assert.equal(html.includes('tremendous'), true);
  assert.equal(html.includes('unsteady'), false, '筛★时补注那一档不该出现');
});

test('② 填了替换词就记进队列（replacement），不是只写一个"换掉"', async () => {
  const { files } = setup({ [QUEUE_PATH]: JSON.stringify(fixture()) });
  await renderAnnotatePane();
  const box = win.document.querySelector('[data-pk-input="1"]') as unknown as HTMLInputElement;
  box.value = 'unkind';
  (win.document.querySelectorAll('#pane-annotate [data-pk-act="rewrite"]')[1] as unknown as HTMLElement).click();
  await new Promise((r) => setTimeout(r, 10));
  const saved = JSON.parse(files[QUEUE_PATH]!) as PendingQueue;
  const decided = saved.items.find((i) => i.id === 'pq-canon');
  assert.equal(decided?.status, 'rewrite');
  assert.equal(decided?.replacement, 'unkind', '教师填的词必须记下来，否则"直接换"只是换了个说法');
});

test('点「③ 忽略」要把 status 写回队列——否则重算时决定就丢了', async () => {
  const { files } = setup({ [QUEUE_PATH]: JSON.stringify(fixture()) });
  await renderAnnotatePane();
  // 第三张卡（补注 unsteady）的第 3 个键
  const acts = Array.from(win.document.querySelectorAll('#pane-annotate [data-pk-act="keep"]'));
  (acts[2] as unknown as HTMLElement).click();
  await new Promise((r) => setTimeout(r, 10));
  const saved = JSON.parse(files[QUEUE_PATH]!) as PendingQueue;
  const decided = saved.items.find((i) => i.id === 'pq-anno');
  assert.equal(decided?.status, 'keep', '教师点的决定必须落在队列里');
  assert.ok(decided?.decidedAt, '要留时间戳（决定是可审计的）');
});

test('③ 忽略**不许产生标记**——教师 2026-09-13 踩出来的机制打架', async () => {
  const { files, marks } = setup({ [QUEUE_PATH]: JSON.stringify(fixture()) });
  await renderAnnotatePane();
  const keeps = Array.from(win.document.querySelectorAll('#pane-annotate [data-pk-act="keep"]'));
  (keeps[0] as unknown as HTMLElement).click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(marks.length, 0, '忽略是"什么都不做"，长出标记就会被 AI 审核流程当待办去跑一轮');
  const saved = JSON.parse(files[QUEUE_PATH]!) as PendingQueue;
  assert.equal(saved.items.find((i) => i.id === 'pq-star')?.status, 'keep', '但决定要落进队列');
});

test('① 补注 / ② 换写 才是真待办，要落成标记（zh / simpl）', async () => {
  const { marks } = setup({ [QUEUE_PATH]: JSON.stringify(fixture()) });
  await renderAnnotatePane();
  const one = win.document.querySelectorAll('#pane-annotate [data-pk-act="annotate"]')[0] as unknown as HTMLElement;
  one.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((marks[0] as { type: string }).type, 'zh', '补注 → zh 标记');
  assert.equal((marks[0] as { note: string }).note, '极大的', '注释内容就是候选释义');
});

test('没有队列时给一句"怎么办"，不是空白', async () => {
  setup({});
  await renderAnnotatePane();
  const html = win.document.getElementById('pane-annotate')!.innerHTML;
  assert.match(html, /还没有待确认队列/);
  assert.match(html, /LayerText_AF待确认队列\.mjs/, '要告诉教师跑哪条命令');
});

test('没有打开章节时，横幅不出现（不要在书架页凭空多一条）', async () => {
  setup({ [QUEUE_PATH]: JSON.stringify(fixture()) });
  setAnnotateIo({ session: () => null });
  await refreshPendingBanner();
  assert.equal(win.document.getElementById('pending-banner'), null);
});
