/**
 * 工序化调适 · 编排核心测试（四方向方案 v2 方向一验收）
 *
 * 用注入的假 callStage 完整跑编排（无网络无 key），锁五条验收：
 *   ① 无风险段零调用：干净段不出现在任何请求里；
 *   ② 只返回变化段：请求里的段 = 本地扫描命中的段；
 *   ③ 失败段隔离：门禁拒绝且重试用尽 → quarantined，后续工序跳过它；
 *   ④ 检查点可回放：每道工序记版本/改动/拒绝原因；
 *   ⑤ 原文永远保留：合并只在产物副本上做，segs 入参不动。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runStagePipeline, buildChapterRecap, isChapterRecap, type StagePipeOpts, type StagePipeSeg } from '../src/core/stagepipe.js';
import type { StagePatchRequest } from '../src/core/stagepatch.js';

const KNOWN = new Set(['the', 'run', 'work', 'hard', 'day', 'animal', 'farm', 'was', 'big', 'they', 'and', 'came', 'home', 'all', 'unfairly', 'made', 'up', 'stories']);

const segs = (): StagePipeSeg[] => [
  { id: 'P01', source: '[P01] Napoleon worked hard all day.', draft: '[P01] Napoleon worked hard all day.' },
  { id: 'P02', source: '[P02] The animals tyrannised the farm and fabricated stories about the harvest.', draft: '[P02] The animals tyrannised the farm and fabricated stories about the harvest.' },
  { id: 'P03', source: '[P03] They came home.', draft: '[P03] They came home.' },
];

/** 把段文本规范成带正确段号开头 */
const withMarker = (id: string, text: string): string =>
  text.startsWith(`[${id}]`) ? text : `[${id}] ${text.replace(/^\[P\d+\]\s*/, '')}`;

function optsWith(callStage: StagePipeOpts['callStage'], over: Partial<StagePipeOpts> = {}): StagePipeOpts {
  return {
    chapter: '第一章',
    tier: 'M',
    sourceVersion: 'src-test',
    segs: segs(),
    knownWords: KNOWN,
    properNouns: ['Napoleon'],
    maxLen: 17,
    ratio: 0.75,
    callStage,
    ...over,
  };
}

test('全零调用：所有段干净时五道工序都跳过，callStage 一次都不被调', async () => {
  let calls = 0;
  const r = await runStagePipeline(optsWith(async () => {
    calls++;
    return '{"patches":[]}';
  }, { segs: [{ id: 'P01', source: '[P01] They worked hard.', draft: '[P01] They worked hard.' }] }));
  assert.equal(calls, 0, '无风险段零调用');
  assert.equal(r.finalVersion, 0);
  assert.ok(r.checkpoints.every((c) => !c.called));
  assert.equal(r.text.P01, '[P01] They worked hard.', '原文即产物');
});

test('工序化主路径：词汇粗筛只请求命中段；patch 合并且未提及段原样', async () => {
  const requests: StagePatchRequest[] = [];
  const r = await runStagePipeline(optsWith(async (req) => {
    requests.push(req);
    if (req.stage === 'vocab-primary') {
      return JSON.stringify({
        patches: [
          { id: 'P02', status: 'changed', text: '[P02] The animals ruled the farm unfairly and made up stories.' },
          { id: 'P01', status: 'unchanged' },
        ],
      });
    }
    /* 其余工序本地扫描已无命中（干净稿）：返回空不调用 */
    return '{"patches":[]}';
  }));

  const vocabReq = requests.find((q) => q.stage === 'vocab-primary');
  assert.ok(vocabReq, '词汇粗筛必须被调用（P02 有 OOV）');
  assert.deepEqual(vocabReq!.segments.map((s) => s.id), ['P02'], '只请求命中段');
  assert.ok(vocabReq!.segments[0]!.issues.length > 0, 'issues 带本地扫描结果');

  assert.equal(r.text.P02.includes('tyrannised'), false, '难词已换');
  assert.equal(r.text.P01, '[P01] Napoleon worked hard all day.', 'P01 未提及原样');
  assert.equal(r.text.P03, '[P03] They came home.');
  assert.ok(r.checkpoints.find((c) => c.stage === 'vocab-primary')!.called);
});

test('隔离纪律：门禁拒绝且重试用尽 → quarantined，后续工序跳过该段', async () => {
  let syntaxCalls = 0;
  const r = await runStagePipeline(optsWith(async (req) => {
    if (req.stage === 'vocab-primary') {
      /* 换词但塞一个超长句：句法工序点会被 SENT-01 拒 */
      const long = withMarker('P02', 'word '.repeat(24).trim() + ' ruled unfairly.');
      return JSON.stringify({ patches: [{ id: 'P02', status: 'changed', text: long }] });
    }
    if (req.stage === 'syntax') {
      syntaxCalls++;
      /* 两次尝试都拒不改正（仍超长） */
      return JSON.stringify({ patches: [{ id: 'P02', status: 'changed', text: withMarker('P02', 'word '.repeat(24).trim() + ' ruled.') }] });
    }
    return '{"patches":[]}';
  }, { maxStageTries: 2 }));

  assert.equal(r.quarantined.filter((q) => q.stage === 'syntax').length, 1, '两次尝试都被拒 → 隔离');
  assert.equal(syntaxCalls, 2, '单段最多两次尝试');
  const q = r.quarantined.find((x) => x.stage === 'syntax')!;
  assert.ok(q.reason.includes('SENT-01') || q.reason.includes('门禁'), `拒绝原因可解释（实得 ${q.reason}）`);
  assert.ok(r.checkpoints.find((c) => c.stage === 'syntax')!.blockedIds.includes('P02'));
  assert.equal(r.finalVersion > 0, true, '词汇粗筛的 commit 已入库');
});

test('解析失败：整道工序不落地，段保持上一版，problems 留痕', async () => {
  const r = await runStagePipeline(optsWith(async (req) => {
    if (req.stage === 'vocab-primary') return '这不是 JSON，抱歉。';
    return '{"patches":[]}';
  }));
  const cp = r.checkpoints.find((c) => c.stage === 'vocab-primary')!;
  assert.equal(cp.called, false, '无 commit');
  assert.ok(cp.problems.length > 0, '失败原因留痕');
  assert.equal(r.text.P02.includes('tyrannised'), true, '段保持原文（上一版）');
});

test('词汇复筛接住上一道新引入词：prevStageText 生效', async () => {
  const r = await runStagePipeline(optsWith(async (req) => {
    if (req.stage === 'vocab-primary') {
      return JSON.stringify({ patches: [{ id: 'P02', status: 'changed', text: '[P02] The animals fabricated tales on the farm.' }] });
    }
    if (req.stage === 'vocab-secondary') {
      assert.deepEqual(req.segments.map((s) => s.id), ['P02'], '新引入词的段被复筛点名');
      return JSON.stringify({ patches: [{ id: 'P02', status: 'changed', text: '[P02] The animals made up tales on the farm.' }] });
    }
    return '{"patches":[]}';
  }));
  assert.ok(r.checkpoints.find((c) => c.stage === 'vocab-secondary')!.called, '复筛被调用');
  assert.ok(!r.text.P02.includes('fabricated'), '新引入词被换掉');
});

test('原文永远保留：编排不改入参 segs', async () => {
  const input = segs();
  await runStagePipeline(optsWith(async () => '{"patches":[]}', { segs: input }));
  assert.equal(input[1]!.draft.includes('tyrannised'), true, '入参的 draft 字段不被改写');
});

test('ChapterRecap：本地构建（含加注对、隔离段、逐工序结果）且 schema 校验通过', async () => {
  const r = await runStagePipeline(optsWith(async (req) => {
    if (req.stage === 'vocab-primary') {
      return JSON.stringify({ patches: [{ id: 'P02', status: 'changed', text: '[P02] The animals ruled the farm and made up tales（故事）.' }] });
    }
    return '{"patches":[]}';
  }));
  const recap = buildChapterRecap(optsWith(async () => '{"patches":[]}'), r);
  assert.equal(recap.chapter, '第一章');
  assert.ok(recap.acceptedTerms.some((t) => t.word === 'tales' && t.gloss === '故事'), '终稿加注对进 recap');
  assert.equal(recap.stageResults.length, 5);
  const verdict = isChapterRecap(recap);
  assert.deepEqual([verdict.ok, verdict.problems], [true, []], '本地构建的 recap 必然过 schema');

  const bad = isChapterRecap({ chapter: 'x', tier: 'Z', stageResults: 'no' });
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.length >= 2, 'tier 与 stageResults 都被点名');
});
