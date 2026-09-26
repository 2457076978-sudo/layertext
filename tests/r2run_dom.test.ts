/**
 * R2「开始第二轮修订」按钮 · DOM 级测试（B1 批次②b 验收标准 C，2026-09-26）
 *
 * 锁三条件状态机的呈现契约：任务单未确认→无 R2 按钮（只有「开始修订」）；
 * confirmed 后按钮恒在，禁用时 title 必须写明缺什么（交互自解释性 A1/A3——
 * 禁用不是消失，是解释）。纯函数 r2ButtonState 的判定由本文件与
 * tests/round2.test.ts 的闸门用例共同覆盖。
 */

import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { Window } from 'happy-dom';

const win = new Window();
before(() => {
  (globalThis as Record<string, unknown>).document = win.document;
  (globalThis as Record<string, unknown>).window = win;
});

import { renderAdaptTaskPreview } from '../app/src/review.js';
import { planRevisionTask } from '../src/core/adaptcheck.js';
import { r2ButtonState, type R2ButtonConds } from '../app/src/r2run.js';

const TARGET = { taskPath: '/tmp/x/_运行/调适任务单_A层85_第一章.json', outRoot: '/tmp/x', tag: 'A层85' };
const SESSION = { sourcePath: '/tmp/x/第一章/原文_A层85_2026-09-26_R1.md' } as never;

const good: R2ButtonConds = { confirmed: true, isR1: true, feedbackText: '词汇太难', gateOk: true, gateReason: '' };

function preview(taskConfirmed: boolean, state?: R2ButtonConds): void {
  win.document.body.innerHTML = '<div id="adapt-task-preview" style="display:none"></div>';
  renderAdaptTaskPreview(TARGET, { task: planRevisionTask('第一章', 'R1', '词汇太难'), confirmed: taskConfirmed }, SESSION, state);
}

function r2btn(): HTMLButtonElement | null {
  return win.document.getElementById('adapt-r2-run') as HTMLButtonElement | null;
}

test('任务单未确认：不出现 R2 按钮（先走「开始修订」确认链）', () => {
  preview(false);
  assert.equal(r2btn(), null);
  assert.ok(win.document.getElementById('adapt-task-go'));
});

test('三条件齐备：可点，title 预告后果（写终稿+报告、R1 保留）', () => {
  preview(true, good);
  const b = r2btn()!;
  assert.ok(b);
  assert.equal(b.hasAttribute('disabled'), false);
  assert.match(b.getAttribute('title') ?? '', /写终稿\+调适报告（R1 保留）/);
});

test('条件一：打开的不是 R1 → 禁用且 title 说清去哪改', () => {
  preview(true, { ...good, isR1: false });
  const b = r2btn()!;
  assert.equal(b.hasAttribute('disabled'), true);
  assert.match(b.getAttribute('title') ?? '', /请先打开本层的 R1 初稿/);
});

test('条件二：反馈文件不在 → 禁用且给出补救路径', () => {
  preview(true, { ...good, feedbackText: null });
  const b = r2btn()!;
  assert.equal(b.hasAttribute('disabled'), true);
  assert.match(b.getAttribute('title') ?? '', /调适反馈_.*\.json/);
  assert.match(b.getAttribute('title') ?? '', /重新保存一次反馈/);
});

test('条件三：两轮闸门拒绝 → 禁用且 title=闸门人话理由（core 的 gate.reason 直通）', () => {
  preview(true, { ...good, gateOk: false, gateReason: '两轮已用完——剩余问题交教师修改或说明保留，不再自动重试。' });
  const b = r2btn()!;
  assert.equal(b.hasAttribute('disabled'), true);
  assert.equal(b.getAttribute('title'), '两轮已用完——剩余问题交教师修改或说明保留，不再自动重试。');
});

test('confirmed 但未给三条件（首渲染保守态）：按钮在且禁用，title 指向 R1 前置', () => {
  preview(true, undefined);
  const b = r2btn()!;
  assert.ok(b);
  assert.equal(b.hasAttribute('disabled'), true);
});

test('r2ButtonState 纯函数：五态判定一览（未确认优先级最高）', () => {
  assert.equal(r2ButtonState({ ...good, confirmed: false }).disabled, true);
  assert.equal(r2ButtonState(good).disabled, false);
  assert.match(r2ButtonState({ ...good, gateOk: false, gateReason: 'x' }).title, /^x$/);
});
