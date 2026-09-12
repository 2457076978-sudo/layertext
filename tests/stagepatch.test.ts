/**
 * 工序化调适 · 差量 patch 协议测试（四方向方案 v2 §3.1）
 *
 * 锁四条协议纪律：
 *   ① 未返回/unchanged 的段在合并层原样（mergePatch 不清空、不重排）；
 *   ② 一个 changed patch 混多个段标记 = 整章形态，拒绝该 patch；
 *   ③ changed 段过门禁：STAGE_BLOCK_RULES 命中即翻 blocked、不合并；
 *   ④ protectedFacts 丢一条就拒绝（数字/专名/否定口径）。
 * 解析防御：围栏、前后客套话、{patches}/裸数组两种形态、未知 id、重复 id。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { StagePatchResult } from '../src/core/stagepatch.js';
import {
  STAGE_ORDER, STAGE_LABEL, STAGE_BLOCK_RULES,
  parseStagePatch, markerCount, factGuard, gatePatches, mergePatch,
} from '../src/core/stagepatch.js';

test('工序顺序固定：加注最后执行', () => {
  assert.deepEqual(STAGE_ORDER, ['vocab-primary', 'syntax', 'vocab-secondary', 'coherence', 'annotation']);
  assert.equal(STAGE_ORDER[STAGE_ORDER.length - 1], 'annotation');
  assert.equal(STAGE_LABEL['vocab-primary'], '词汇粗筛');
});

test('工序门禁规则：ANNO-01 只在加注工序点生效；FACT 只在连贯性点拦截', () => {
  assert.ok(STAGE_BLOCK_RULES.annotation.includes('ANNO-01'));
  assert.ok(!STAGE_BLOCK_RULES['vocab-primary'].includes('ANNO-01'), '词汇粗筛后还没注，ANNO-01 必然全红，不该拦');
  assert.ok(STAGE_BLOCK_RULES.coherence.includes('FACT-01'));
  assert.ok(STAGE_BLOCK_RULES.coherence.includes('FACT-02'));
  assert.ok(!STAGE_BLOCK_RULES.syntax.includes('FACT-01'), '句法工序不升级事实 warn');
});

test('解析：{patches} 对象、裸数组、围栏与客套话都能解出', () => {
  const ids = ['P01', 'P02'];
  const a = parseStagePatch('{"patches":[{"id":"P01","status":"changed","text":"[P01] new text"}]}', ids);
  assert.equal(a.ok, true);
  assert.equal(a.result?.patches.length, 1);

  const b = parseStagePatch('[{"id":"P02","text":"[P02] hello"}]', ids);
  assert.equal(b.ok, true);
  assert.equal(b.result?.patches[0]?.status, 'changed', '有 text 无 status 默认 changed');

  const c = parseStagePatch('好的，以下是结果：\n```json\n{"patches":[{"id":"P01","status":"unchanged"}]}\n```\n希望有帮助', ids);
  assert.equal(c.ok, true);
  assert.equal(c.result?.patches[0]?.status, 'unchanged');
});

test('解析：非 JSON / 无 patches / 空 patches 都给出人话诊断而非半截结果', () => {
  assert.equal(parseStagePatch('抱歉我不能这样做', ['P01']).ok, false);
  assert.equal(parseStagePatch('{"data":1}', ['P01']).ok, false);
  const empty = parseStagePatch('{"patches":[]}', ['P01']);
  assert.equal(empty.ok, false);
  assert.ok(empty.problems.length > 0);
});

test('解析：未知 id 丢弃并记 problems；重复 id 取第一条', () => {
  const r = parseStagePatch(
    '{"patches":[{"id":"P99","status":"changed","text":"x"},{"id":"P01","text":"a"},{"id":"P01","text":"b"}]}',
    ['P01'],
  );
  assert.equal(r.ok, true);
  assert.equal(r.result?.patches.length, 1, '未知 P99 丢弃、重复 P01 只留一条');
  assert.equal(r.result?.patches[0]?.text, 'a');
  assert.ok(r.problems.some((p) => p.includes('P99')));
  assert.ok(r.problems.some((p) => p.includes('重复')));
});

test('合并纪律：只写 changed；unchanged/未返回的段一律原样', () => {
  const draft = { P01: '[P01] alpha', P02: '[P02] beta', P03: '[P03] gamma' };
  const merged = mergePatch(draft, {
    baseVersion: 'v0',
    patches: [
      { id: 'P01', status: 'changed', text: '[P01] alpha two' },
      { id: 'P02', status: 'unchanged' },
    ],
  });
  assert.equal(merged.text.P01, '[P01] alpha two');
  assert.equal(merged.text.P02, '[P02] beta');
  assert.equal(merged.text.P03, '[P03] gamma', '未提及的段原样');
  assert.deepEqual(merged.changedIds, ['P01']);
  assert.deepEqual(merged.blockedIds, []);
  assert.equal(draft.P01, '[P01] alpha', '合并不改入参（调用方的上一版还在）');
});

test('整章形态拒绝：一个 patch 含多个段标记 → blocked，不合并', () => {
  const result: StagePatchResult = {
    baseVersion: 'v0',
    patches: [{ id: 'P01', status: 'changed', text: '[P01] a\n\n[P02] b\n\n[P03] c' }],
  };
  const segs = [
    { id: 'P01', source: '[P01] src', target: 0, maxLen: 17, oov: [] },
    { id: 'P02', source: '[P02] src', target: 0, maxLen: 17, oov: [] },
    { id: 'P03', source: '[P03] src', target: 0, maxLen: 17, oov: [] },
  ];
  const gated = gatePatches(result, segs, { stage: 'vocab-primary' });
  assert.equal(gated.items[0]?.status, 'blocked');
  assert.equal(gated.blocked[0]?.ruleIds[0], 'WHOLE-CHAPTER');
  const merged = mergePatch({ P01: '[P01] old' }, { patches: gated.items, baseVersion: '' });
  assert.equal(merged.text.P01, '[P01] old', 'blocked 段保持上一版');
});

test('门禁接入：句法工序点 SENT-01 命中即 blocked；词汇粗筛点同一段不拦', () => {
  const longSent = '[P01] ' + 'word '.repeat(30).trim() + '.';
  const result: StagePatchResult = { baseVersion: 'v0', patches: [{ id: 'P01', status: 'changed', text: longSent }] };
  const segs = [{ id: 'P01', source: '[P01] short src', target: 0, maxLen: 17, oov: [] }];

  const atSyntax = gatePatches(result, segs, { stage: 'syntax' });
  assert.equal(atSyntax.blocked.length, 1, '句法工序点超长句必须拦');
  assert.ok(atSyntax.blocked[0]!.ruleIds.includes('SENT-01'));

  const atVocab = gatePatches(result, segs, { stage: 'vocab-primary' });
  assert.equal(atVocab.blocked.length, 0, '词汇粗筛点句子还没到处理句法的时候，不拦');
});

test('事实守卫：protectedFacts 丢一条就拒绝整段', () => {
  const result: StagePatchResult = {
    baseVersion: 'v0',
    patches: [{ id: 'P01', status: 'changed', text: '[P01] Napoleon said nothing about the number.' }],
  };
  const segs = [{ id: 'P01', source: '[P01] Napoleon kept 9 dogs.', target: 0, maxLen: 17, oov: [] }];
  const gated = gatePatches(result, segs, { stage: 'coherence', protectedFacts: { P01: ['Napoleon', '9'] } });
  assert.equal(gated.blocked.length, 1);
  assert.deepEqual(gated.blocked[0]!.lostFacts, ['9']);
  assert.ok(gated.blocked[0]!.reason.includes('受保护事实丢失'));

  assert.deepEqual(factGuard('Napoleon kept 9 dogs', ['napoleon', '9']), [], '大小写不敏感');
});

test('门禁接入：加注工序点 ANNO-01 漏注即 blocked', () => {
  const result: StagePatchResult = {
    baseVersion: 'v0',
    patches: [{ id: 'P01', status: 'changed', text: '[P01] The harvest（收获） was bigger than before.' }],
  };
  const segs = [{ id: 'P01', source: '[P01] The harvest was bigger.', target: 0, maxLen: 17, oov: ['windmill'] }];
  const gated = gatePatches(result, segs, { stage: 'annotation' });
  assert.equal(gated.blocked.length, 1, 'windmill 应注没注');
  assert.ok(gated.blocked[0]!.ruleIds.includes('ANNO-01'));
});

test('markerCount：段标记计数是整章形态检测的尺', () => {
  assert.equal(markerCount('[P01] a'), 1);
  assert.equal(markerCount('[P01] a [P02] b'), 2);
  assert.equal(markerCount('plain text'), 0);
});
