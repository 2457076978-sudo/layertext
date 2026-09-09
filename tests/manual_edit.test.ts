/**
 * 手动改这句（人工矫正兜底）· 单测：标记存留规则
 * 该句句级标记随人工修订完成；被改掉的词不留幽灵标记；其余存留。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { marksSurvivingManualEdit } from '../app/src/pure.js';
import type { Mark } from '../app/src/types.js';

const wm = (word: string, pi = 0, si = 0): Mark => ({ id: 'w-' + word, level: 'word', pi, si, wi: 0, word, text: 'x', type: 'simpl', ts: 1 });

test('手动改句：该句句级标记完成、被改掉的词不留幽灵、其余存留', () => {
  const marks: Mark[] = [
    { id: 's1', level: 'sent', pi: 0, si: 1, text: 'y', type: 'long', ts: 1 }, // 目标句的句级标记 → 完成
    { id: 's2', level: 'sent', pi: 0, si: 0, text: 'z', type: 'syntax', ts: 1 }, // 别句的句级标记 → 存留
    wm('cynical', 0, 1), // 原句有、新句没有 → 连带完成（防幽灵）
    wm('boar', 0, 1), // 原句有、新句还有 → 存留
    wm('donkey', 1, 0), // 别处的词标记 → 存留
  ];
  const before = 'The cynical donkey saw a boar.';
  const after = 'The donkey looked at a boar.'; // cynical 没了
  const alive = marksSurvivingManualEdit(marks, { pi: 0, si: 1 }, before, after);
  assert.deepEqual(alive.map((m) => m.id).sort(), ['s2', 'w-boar', 'w-donkey']);
});

test('手动改句：大小写不敏感判定（Word→word 被改掉照样连带完成）', () => {
  const marks: Mark[] = [wm('Cynical'), wm('boar')];
  const alive = marksSurvivingManualEdit(marks, { pi: 0, si: 0 }, 'The Cynical boar', 'The angry boar');
  assert.deepEqual(
    alive.map((m) => m.id),
    ['w-boar'],
  );
});

test('手动改句：只影响该句——同词在别句的标记不动（按 pi/si 区分不了时保守存留）', () => {
  // word 标记只带自己句的 pi/si；别句的 cyn在标记因 pi 不同天然存留
  const marks: Mark[] = [wm('cynical', 0, 1), wm('cynical', 2, 0)];
  const alive = marksSurvivingManualEdit(marks, { pi: 0, si: 1 }, 'cynical old Major spoke', 'old Major spoke');
  assert.deepEqual(
    alive.map((m) => m.id),
    ['w-cynical'],
  ); // 只剩 pi=2 那条
});
