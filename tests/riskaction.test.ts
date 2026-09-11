/**
 * 风险决定「动作」层 回归测试
 *
 * 验收标准（《LayerText 审查报告 v4_方向》第 2 条）：
 *   「『采纳』必须拆成规则动作：事实类『保留/确认删减』（不改正文）、漏注『补上注释』、
 *     重复注『删除多余注释』、释义冲突『改为词典释义』、格式类『修复并应用』。
 *     每个动作调用 applyChange(before, after, event)：先校验当前版本仍等于 before，
 *     再原子写正文和事件；失败则只写 rejected 事件，**不得让卡片消失**。」
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actionOf, applyAction, failureText } from '../src/core/riskaction.js';
import { parseAnnotations } from '../src/core/annot.js';

test('规则 → 动作：该改正文的五类都改，只是表态的四类明确不改', () => {
  // 事实 / 长度：认可现状，不动正文
  for (const r of ['FACT-01', 'FACT-02', 'SENT-01', 'LEN-01']) {
    assert.equal(actionOf(r).mutates, false, `${r} 不该改正文`);
    assert.equal(actionOf(r).kind, 'confirm');
    assert.match(actionOf(r).label, /认可/);
  }
  // 加注三类：确定性修法，改正文
  assert.equal(actionOf('ANNO-01').kind, 'insert-annotation');
  assert.equal(actionOf('ANNO-01').label, '＋ 补上注释');
  assert.equal(actionOf('ANNO-02').kind, 'remove-annotation');
  assert.equal(actionOf('ANNO-03').kind, 'set-sense');
  assert.equal(actionOf('AST-02').kind, 'set-sense');
  for (const r of ['ANNO-01', 'ANNO-02', 'ANNO-03', 'AST-02']) assert.equal(actionOf(r).mutates, true);
});

test('没有确定性修法的规则一律 manual（只记录），不猜', () => {
  for (const r of ['ZH-01', 'AST-01', 'AST-03', '不存在的规则']) {
    const a = actionOf(r);
    assert.equal(a.kind, 'manual');
    assert.equal(a.mutates, false);
    assert.match(a.label, /手动处理/);
  }
});

test('按钮文案跟着规则走：十条规则不能共用同一个「采纳」', () => {
  const labels = ['FACT-01', 'ANNO-01', 'ANNO-02', 'ANNO-03'].map((r) => actionOf(r).label);
  assert.equal(new Set(labels).size, 4, '每个动作要有自己的说法');
  assert.equal(labels.includes('采纳改写'), false, '模糊的"采纳改写"正是 v4 报告点名要去掉的');
});

/* ────────────────── 补注 ────────────────── */

test('补注：在**文中真实那个词形**上插注释（引擎报的是 windmill，文中是 Windmills）', () => {
  const doc = '## Chapter One\n\n[P01] The Windmills stood there and the windmill was old.\n';
  const r = applyAction(actionOf('ANNO-01'), { doc, segId: 'P01', word: 'windmill', zh: '风车' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.match(r.next, /The Windmills（风车） stood there and the windmill was old\./);
  assert.equal(r.before, 'Windmills', '事件里记的是文中那个词形');
  assert.equal(r.after, 'Windmills（风车）');
});

test('补注：只在**首次出现处**插一次（全篇一词一注）', () => {
  const doc = '## Chapter One\n\n[P01] A barn and a barn and a barn.\n';
  const r = applyAction(actionOf('ANNO-01'), { doc, segId: 'P01', word: 'barn', zh: '谷仓' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(parseAnnotations(r.next).list.length, 1);
  assert.match(r.next, /A barn（谷仓） and a barn and a barn\./);
});

test('补注：段里已经有注释 → no-op（重复点不会插两次，幂等）', () => {
  const doc = '## Chapter One\n\n[P01] A barn（谷仓） stood.\n';
  const r = applyAction(actionOf('ANNO-01'), { doc, segId: 'P01', word: 'barn', zh: '谷仓' });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'no-op');
  assert.match(r.message, /已经有注释/);
});

test('补注：段里找不到这个词 → not-found（稿件改过），绝不假装改完', () => {
  const doc = '## Chapter One\n\n[P01] Nothing here.\n';
  const r = applyAction(actionOf('ANNO-01'), { doc, segId: 'P01', word: 'barn', zh: '谷仓' });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'not-found');
});

test('补注：没有释义就不能插（不许插一个空括号）', () => {
  const doc = '## Chapter One\n\n[P01] A barn stood.\n';
  const r = applyAction(actionOf('ANNO-01'), { doc, segId: 'P01', word: 'barn', zh: '   ' });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'missing-arg');
  assert.match(r.message, /还没在统一词典里/);
});

test('段号对不上 → not-found（这是"先校验当前版本"那一步）', () => {
  const doc = '## Chapter One\n\n[P01] A barn stood.\n';
  const r = applyAction(actionOf('ANNO-01'), { doc, segId: 'P09', word: 'barn', zh: '谷仓' });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'not-found');
  assert.match(r.message, /找不到段落 P09/);
});

/* ────────────────── 删重复注释 ────────────────── */

test('删多余注释：**保留首次**、删掉后面重复的（删错那一处就等于把对的删了）', () => {
  const doc = '## Chapter One\n\n[P02] A barn（谷仓） and a barn（仓房） here.\n';
  const r = applyAction(actionOf('ANNO-02'), { doc, segId: 'P02', word: 'barn' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const left = parseAnnotations(r.next).list;
  assert.equal(left.length, 1);
  assert.equal(left[0]!.zh, '谷仓', '留下的是首次那处');
  assert.match(r.next, /A barn（谷仓） and a barn here\./);
});

test('删多余注释（跨段重复）：removeAll 时本段这处整段去掉', () => {
  const doc = '## Chapter One\n\n[P05] A barn（谷仓） here.\n';
  const r = applyAction(actionOf('ANNO-02'), { doc, segId: 'P05', word: 'barn', removeAll: true });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(parseAnnotations(r.next).list.length, 0);
  assert.match(r.next, /A barn here\./);
});

test('删多余注释：只剩一处时不动它（那是"首次"，按一词一注该留着）', () => {
  const doc = '## Chapter One\n\n[P02] A barn（谷仓） here.\n';
  const r = applyAction(actionOf('ANNO-02'), { doc, segId: 'P02', word: 'barn' });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'no-op');
  assert.match(r.message, /只有一处注释/);
});

test('删多余注释：这一段没有这条注释 → no-op', () => {
  const doc = '## Chapter One\n\n[P01] A barn here.\n';
  const r = applyAction(actionOf('ANNO-02'), { doc, segId: 'P01', word: 'barn' });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'no-op');
});

/* ────────────────── 统一释义 ────────────────── */

test('统一释义：把该词的注释改成本书词典的释义，正文其余一字不动', () => {
  const doc = '## Chapter One\n\n[P03] A barn（仓房） stood by the windmill（风车）.\n';
  const r = applyAction(actionOf('ANNO-03'), { doc, segId: 'P03', word: 'barn', zh: '谷仓' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.next, '## Chapter One\n\n[P03] A barn（谷仓） stood by the windmill（风车）.\n');
  assert.equal(r.before, 'barn（仓房）');
  assert.equal(r.after, 'barn（谷仓）');
});

test('统一释义：已经是那个释义 → no-op（点了也不会写一条假事件）', () => {
  const doc = '## Chapter One\n\n[P03] A barn（谷仓） stood.\n';
  const r = applyAction(actionOf('ANNO-03'), { doc, segId: 'P03', word: 'barn', zh: '谷仓' });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'no-op');
});

test('动作类型与规则不匹配 → unsupported（宁可报错也不做半截事）', () => {
  const doc = '## Chapter One\n\n[P01] A barn stood.\n';
  const r = applyAction(actionOf('FACT-01'), { doc, segId: 'P01', word: 'barn', zh: '谷仓' });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'unsupported');
  assert.match(r.message, /不该走 applyAction/);
});

/* ────────────────── 非目标段不被动到 ────────────────── */

test('只动目标段：其它段与词句卡一字不变', () => {
  const doc = '## Chapter One\n\n[P01] A barn stood.\n\n[P02] Another barn（谷仓） here.\n\n## 词句卡\n\n| 词 | 释义 |\n|---|---|\n| barn | 谷仓 |\n';
  const r = applyAction(actionOf('ANNO-01'), { doc, segId: 'P01', word: 'barn', zh: '谷仓' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.match(r.next, /\[P01\] A barn（谷仓） stood\./);
  assert.match(r.next, /\[P02\] Another barn（谷仓） here\./, 'P02 原样');
  assert.match(r.next, /## 词句卡/, '词句卡原样');
});

test('失败原因有人话（进 toast 与 rejected 事件的 reason）', () => {
  const r = applyAction(actionOf('ANNO-01'), { doc: '## Chapter One\n\n[P01] x\n', segId: 'P01', word: 'barn', zh: '谷仓' });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(typeof failureText(r), 'string');
  assert.equal(failureText(r).length > 0, true);
});
