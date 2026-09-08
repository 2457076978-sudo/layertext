/**
 * O4 UI 部件 DOM 级测试（happy-dom）：模式胶囊 · 视图切换 · 版本对比 diff。
 * 从 main.ts 抽出的编排分支（widgets.ts），无 Tauri 依赖可直接跑。
 */

import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { Window } from 'happy-dom';

const win = new Window();
before(() => {
  (globalThis as Record<string, unknown>).document = win.document;
  (globalThis as Record<string, unknown>).window = win;
});

import { renderDiffPane, renderModePill, switchView } from '../app/src/widgets.js';

const CH1 = '# Book\n\n## Chapter One\n\n[P01] The hare was very fast.\n\n[P02] The tortoise walked slowly.\n';
const CH1_SIM = '# Book\n\n## Chapter One\n\n[P01] The hare ran fast.\n\n[P02] The tortoise walked slowly.\n\n[P03] They raced to the hill.\n';

test('模式胶囊：即改=绿/候选=黄，文案与提示随模式切换', () => {
  const pill = win.document.createElement('button');
  win.document.body.appendChild(pill);
  renderModePill(pill as unknown as HTMLElement, true);
  assert.ok(pill.classList.contains('green'));
  assert.match(pill.textContent!, /即改模式/);
  assert.match(pill.title, /立即生效/);
  renderModePill(pill as unknown as HTMLElement, false);
  assert.ok(pill.classList.contains('yellow'));
  assert.match(pill.textContent!, /候选模式/);
  assert.match(pill.title, /点 ✓ 才生效/);
});

test('视图切换：五组标签/面板互斥，只有目标页 active', () => {
  win.document.body.innerHTML = `
    <button id="tab-text" class="active"></button><button id="tab-report"></button><button id="tab-suggest"></button><button id="tab-diff"></button><button id="tab-align"></button><button id="tab-board"></button><button id="tab-dossier"></button><button id="tab-retro"></button>
    <section id="pane-text" class="active"></section><section id="pane-report"></section><section id="pane-suggest"></section><section id="pane-diff"></section><section id="pane-align"></section><section id="pane-board"></section><section id="pane-dossier"></section><section id="pane-retro"></section>`;
  switchView(win.document as unknown as Document, 'diff');
  assert.ok(win.document.getElementById('tab-diff')!.classList.contains('active'));
  assert.ok(win.document.getElementById('pane-diff')!.classList.contains('active'));
  assert.ok(!win.document.getElementById('tab-text')!.classList.contains('active'));
  assert.ok(!win.document.getElementById('pane-text')!.classList.contains('active'));
  switchView(win.document as unknown as Document, 'retro');
  assert.ok(win.document.getElementById('tab-retro')!.classList.contains('active'));
  assert.ok(!win.document.getElementById('tab-diff')!.classList.contains('active'));
});

test('版本对比：修改段红/绿着色、一致段无色、段落一致计数、两侧版本下拉', () => {
  const pane = win.document.createElement('section');
  win.document.body.appendChild(pane);
  renderDiffPane(
    pane as unknown as HTMLElement,
    [
      { fileName: '第一章.md', md: CH1 },
      { fileName: '第一章_简化.md', md: CH1_SIM },
    ],
    0,
    1,
    () => {},
  );

  const rows = pane.querySelectorAll('tr');
  // 表头 + 3 个段落行（P03 仅右版本）
  assert.equal(rows.length, 1 + 3);
  const p1 = rows[1];
  assert.ok(p1.querySelector('.diff-del'), 'P01 已修改 → 左红');
  assert.ok(p1.querySelector('.diff-add'), 'P01 已修改 → 右绿');
  const p2 = rows[2];
  assert.ok(!p2.querySelector('.diff-del') && !p2.querySelector('.diff-add'), 'P02 一致 → 无色');
  const p3 = rows[3];
  assert.ok(p3.querySelector('.diff-add'), 'P03 仅右版本 → 右绿');
  assert.ok(p3.textContent!.includes('（无此段）'), 'P03 左侧缺段 → 显示（无此段）占位');
  assert.ok(pane.textContent!.includes('段落一致 1/3'));
  assert.equal(pane.querySelectorAll('#diff-l option, #diff-r option').length, 4, '两个下拉各 2 个版本');
});

test('版本对比：下拉切换回调（选右侧版本 → 以新索引重渲染）', () => {
  const pane = win.document.createElement('section');
  win.document.body.appendChild(pane);
  const calls: [number, number][] = [];
  const sessions = [
    { fileName: 'a.md', md: CH1 },
    { fileName: 'b.md', md: CH1_SIM },
    { fileName: 'c.md', md: CH1 },
  ];
  renderDiffPane(pane as unknown as HTMLElement, sessions, 0, 1, (l, r) => calls.push([l, r]));
  const selR = pane.querySelector('#diff-r') as unknown as HTMLSelectElement;
  selR.value = '2';
  selR.dispatchEvent(new win.Event('change') as unknown as Event);
  assert.deepEqual(calls, [[0, 2]]);
});

test('版本对比：会话不足时给空状态提示', () => {
  const pane = win.document.createElement('section');
  renderDiffPane(pane as unknown as HTMLElement, [{ fileName: 'a.md', md: CH1 }], 0, 1, () => {});
  assert.match(pane.textContent!, /先打开两个版本/);
});
