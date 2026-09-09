/**
 * M2 审校工作台 · DOM 级测试（happy-dom，无屏幕环境可跑）
 * 覆盖：标记着色/角标增量更新、删除、批量恢复、侧栏（配额/门禁/清单）渲染与回调、标记 schema。
 */

import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { Window } from 'happy-dom';

const win = new Window();
before(() => {
  (globalThis as Record<string, unknown>).document = win.document;
  (globalThis as Record<string, unknown>).window = win;
});

import { jumpTo, refreshMarkDom, removeMarkDom, renderSidebar, restoreAllMarkDom } from '../app/src/review.js';
import { GATES, WORD_TYPES, SENT_TYPES, newMarkId, newReviewState, typeLabel, type Mark } from '../app/src/types.js';

function buildReader(): void {
  win.document.body.innerHTML = `
    <div id="side-review"></div>
    <div id="reader">
      <div class="para"><span class="pid">P01</span>
        <span class="sent" data-pi="0" data-si="0"><span class="w" data-wi="0" data-tok="the">The</span>
          <span class="w" data-wi="1" data-tok="hare">hare</span>
          <span class="w" data-wi="2" data-tok="laughed">laughed</span></span>
        <span class="sent" data-pi="0" data-si="1"><span class="w" data-wi="0" data-tok="loudly">loudly</span></span>
      </div>
    </div>`;
}

function wMark(pi: number, si: number, wi: number, type: Mark['type'] = 'simpl', word = 'hare'): Mark {
  return { id: newMarkId(), level: 'word', pi, si, wi, word, type, ts: Date.now() };
}
function sMark(pi: number, si: number, type: Mark['type'] = 'syntax', text = 'The hare laughed'): Mark {
  return { id: newMarkId(), level: 'sent', pi, si, text, type, ts: Date.now() };
}

test('词标记：refreshMarkDom 给对应词加类型类（索引定位，不受大小写/重复词影响）', () => {
  buildReader();
  refreshMarkDom(wMark(0, 0, 1, 'oov', 'hare'));
  const w1 = win.document.querySelector('.sent[data-pi="0"][data-si="0"] .w[data-wi="1"]')!;
  assert.ok(w1.classList.contains('mk-oov'));
  // 其他词不受影响
  const w0 = win.document.querySelector('.w[data-wi="0"]')!;
  assert.ok(!w0.classList.contains('mk-oov'));
});

test('句标记：句尾追加类型角标（含中文标签）', () => {
  buildReader();
  refreshMarkDom(sMark(0, 0, 'syntax'));
  const sent = win.document.querySelector('.sent[data-pi="0"][data-si="0"]')!;
  const badge = sent.querySelector('.sbadge-syntax')!;
  assert.equal(badge.textContent, '语法太难');
  // 同类型不重复追加
  refreshMarkDom(sMark(0, 0, 'syntax'));
  assert.equal(sent.querySelectorAll('.sbadge-syntax').length, 1);
  // 另一类型角标共存
  refreshMarkDom(sMark(0, 0, 'goods'));
  assert.ok(sent.querySelector('.sbadge-goods'));
});

test('删除标记：句级删除不影响词级（原型坑3修复）', () => {
  buildReader();
  const wm = wMark(0, 0, 1, 'simpl');
  const sm = sMark(0, 0, 'syntax');
  refreshMarkDom(wm);
  refreshMarkDom(sm);
  removeMarkDom(sm);
  const sent = win.document.querySelector('.sent[data-pi="0"][data-si="0"]')!;
  assert.ok(!sent.querySelector('.sbadge-syntax'));
  assert.ok(sent.querySelector('.w[data-wi="1"]')!.classList.contains('mk-simpl'), '词标记应保留');
});

test('restoreAllMarkDom：重新打开文件后全部标记恢复到 DOM', () => {
  buildReader();
  const marks = [wMark(0, 0, 1, 'zh'), wMark(0, 1, 0, 'hard'), sMark(0, 0, 'cut')];
  restoreAllMarkDom({ review: { marks, bookmarks: [] } } as never);
  assert.ok(win.document.querySelector('.w[data-wi="1"]')!.classList.contains('mk-zh'));
  assert.ok(win.document.querySelector('.sent[data-si="1"] .w')!.classList.contains('mk-hard'));
  assert.ok(win.document.querySelector('.sbadge-cut'));
});

test('jumpTo：定位到词并触发闪烁动画类', () => {
  buildReader();
  jumpTo(wMark(0, 0, 2));
  const w2 = win.document.querySelector('.w[data-wi="2"]')!;
  assert.ok(w2.classList.contains('flash'));
});

test('侧栏：配额增删勾、门禁、清单分组渲染与回调', () => {
  buildReader();
  const review = newReviewState('ch1.md');
  review.quota = [
    { text: '保留风车线索', done: true },
    { text: '拳击手形象', done: false },
  ];
  review.gate = { 事实核对: true };
  review.marks = [wMark(0, 0, 1, 'simpl'), sMark(0, 0, 'syntax'), sMark(0, 0, 'syntax')];

  const events: string[] = [];
  renderSidebar({ review } as never, {
    onQuotaToggle: (i) => events.push('quota-toggle:' + i),
    onQuotaRemove: (i) => events.push('quota-remove:' + i),
    onQuotaAdd: (t) => events.push('quota-add:' + t),
    onGateToggle: (g) => events.push('gate:' + g),
    onGateHelp: () => {},
    onMarkJump: (m) => events.push('jump:' + m.id),
    onMarkRemove: (m) => events.push('rm:' + m.id),
  });

  const side = win.document.getElementById('side-review')!;
  // 配额计数 1/2
  assert.ok(side.textContent!.includes('1/2'));
  // 勾选切换回调
  (side.querySelector('[data-quota="1"]') as unknown as HTMLInputElement).checked = true;
  side.querySelector('[data-quota="1"]')!.dispatchEvent(new win.Event('change'));
  assert.ok(events.includes('quota-toggle:1'));
  // 配额添加（输入框 + 按钮）
  (side.querySelector('#quota-input') as unknown as HTMLInputElement).value = '新要点';
  side.querySelector('#quota-add-btn')!.dispatchEvent(new win.Event('click'));
  assert.ok(events.includes('quota-add:新要点'));
  // 门禁：？帮助按钮存在且可点
  assert.equal(side.querySelectorAll('.qmark').length, 4);
  // 门禁：已勾项 + 未勾项回调
  assert.ok((side.querySelector('[data-gate="事实核对"]') as unknown as HTMLInputElement).checked);
  side.querySelector('[data-gate="段落对齐"]')!.dispatchEvent(new win.Event('change'));
  assert.ok(events.includes('gate:段落对齐'));
  // 清单：分组标题与计数
  assert.ok(side.textContent!.includes('词汇简化'));
  assert.ok(side.textContent!.includes('语法太难'));
  assert.ok(side.querySelectorAll('.mgroup').length === 2);
  // 清单项点击跳转 / 删除
  const jumpEl = side.querySelector('[data-jump]')!;
  jumpEl.dispatchEvent(new win.Event('click'));
  assert.ok(events.some((e) => e.startsWith('jump:')));
  const rmEl = side.querySelector('[data-rm]')!;
  rmEl.dispatchEvent(new win.Event('click'));
  assert.ok(events.some((e) => e.startsWith('rm:')));
  // 门禁未全勾 → 不显示"已通过"
  assert.ok(!side.textContent!.includes('已通过'));
  review.gate = Object.fromEntries(GATES.map((g) => [g, true]));
  renderSidebar({ review } as never, {
    onQuotaToggle: () => {},
    onQuotaRemove: () => {},
    onQuotaAdd: () => {},
    onGateToggle: () => {},
    onGateHelp: () => {},
    onMarkJump: () => {},
    onMarkRemove: () => {},
  });
  assert.ok(win.document.getElementById('side-review')!.textContent!.includes('✅ 已通过'));
});

test('标记类型集与门禁项定义完整（P0 要求的按钮组）', () => {
  assert.deepEqual(
    WORD_TYPES.map((t) => t.key),
    ['simpl', 'zh', 'oov', 'hard', 'factw', 'goodw', 'anchor', 'otherw'],
  );
  assert.deepEqual(
    SENT_TYPES.map((t) => t.key),
    ['syntax', 'long', 'ref', 'cohesion', 'fact', 'stiff', 'cut', 'goods', 'others'],
  );
  assert.equal(typeLabel('anchor'), '复现锚点');
  assert.equal(typeLabel('cohesion'), '衔接断裂');
  assert.equal(GATES.length, 4);
  assert.ok(!newMarkId().includes(' '), '标记 id 无空格，可作 DOM data 属性值');
});
