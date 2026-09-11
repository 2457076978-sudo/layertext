/**
 * App 侧改写门禁接线 回归测试
 *
 * 验收标准（《LayerText 审查报告 v4_方向》第 1 条）：
 *   「App 单句改写当前只调用 buildSystemPrompt，随后只运行 checkRev，没有词表、词典、
 *     专名和事实检查。这是残余 P0。」——修法：App 只传**局部切片**，
 *     但判定走**同一个** `checkRewrite`。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAppPolicy, gateBadge, loadBookDict, loadLedger, setGateIo, type GateIo } from '../app/src/rewritegate.js';
import { checkRewrite } from '../src/core/rewrite.js';

function memIo(files: Record<string, string>, dirs: Record<string, string[]> = {}): void {
  const io: GateIo = {
    read: (p) => (p in files ? Promise.resolve(files[p]!) : Promise.reject(new Error('no file: ' + p))),
    listDir: (d) => (d in dirs ? Promise.resolve(dirs[d]!) : Promise.reject(new Error('no dir: ' + d))),
  };
  setGateIo(io);
}

const KNOWN = ['the', 'boy', 'ran', 'to', 'barn', 'and', 'saw', 'a', 'dog', 'was', 'old', 'structure'];

test('账本只扫本书的章节文件（台账/报告等 .md 不算）', async () => {
  memIo(
    {
      '/book/第一章/原文_A层85_2026-09-10.md': 'A barn（谷仓） here.',
      '/book/第一章/原文_M层75_2026-09-10.md': 'A windmill（风车） here.',
      '/book/第一章/台账_A层85_2026-09-10.md': 'A chart（图表） here.',
    },
    { '/book/第一章': ['原文_A层85_2026-09-10.md', '原文_M层75_2026-09-10.md', '台账_A层85_2026-09-10.md'], '/book': ['第一章'] },
  );
  // currentText 就是 sourcePath 的内容（真实调用如此）；它会被跳过重读，靠入参进账本
  const r = await loadLedger({ currentText: 'A barn（谷仓） and a boxer（拳师） here.', sourcePath: '/book/第一章/原文_A层85_2026-09-10.md' });
  assert.equal(r.words.has('barn'), true, '当前章自己的注释要进账本');
  assert.equal(r.words.has('windmill'), true, '同目录其它层的产物也算本书已注');
  assert.equal(r.words.has('boxer'), true);
  assert.equal(r.words.has('chart'), false, '台账不是正文，不该进账本');
});

test('账本扫上层各章目录（产物常见的两级结构）', async () => {
  memIo(
    { '/book/第二章/原文_A层85.md': 'A clover（三叶草） here.' },
    { '/book/第二章': ['原文_A层85.md'], '/book': ['第一章', '第二章'] },
  );
  const r = await loadLedger({ currentText: '', sourcePath: '/book/第一章/原文_A层85.md' });
  assert.equal(r.words.has('clover'), true, '上一级下别的章也要扫到（全篇一词一注）');
});

test('账本读不到路径时如实说"只覆盖当前章"，不静默', async () => {
  memIo({});
  const r = await loadLedger({ currentText: 'A barn（谷仓） here.', sourcePath: null });
  assert.equal(r.words.has('barn'), true);
  assert.match(r.notes.join(''), /只覆盖当前这一章/);
});

test('账本到上限时把"没扫完"说出来（跨章重复注可能漏判）', async () => {
  const many: Record<string, string> = {};
  const names: string[] = [];
  for (let i = 0; i < 40; i++) {
    const n = `原文_A层85_${i}.md`;
    names.push(n);
    many[`/book/第一章/${n}`] = 'A barn（谷仓） here.';
  }
  memIo(many, { '/book/第一章': names, '/book': ['第一章'] });
  const r = await loadLedger({ currentText: '', sourcePath: '/book/第一章/原文_other.md' });
  assert.match(r.notes.join(''), /扫到上限/);
});

test('词典按 调适项目 的 书级.词典 读；读不到返回空（判定端会报"未带词典"）', async () => {
  memIo({ '/p/AF注释词典.csv': '\uFEFF词,释义,来源\nbarn,谷仓,教师知识库\nwindmill,风车,归一\n' });
  const d = await loadBookDict({ 书级: { 词典: '/p/AF注释词典.csv' } });
  assert.equal(d.get('barn'), '谷仓');
  assert.equal(d.get('windmill'), '风车');
  assert.equal((await loadBookDict({ 书级: {} })).size, 0);
  assert.equal((await loadBookDict(null)).size, 0);
});

test('组装策略：专名并进已知词、词典裁成局部切片、账本来自全篇', async () => {
  memIo({ '/p/dict.csv': '词,释义,来源\nbarn,谷仓\nwindmill,风车\n' });
  const { policy, notes } = await buildAppPolicy({
    currentText: 'A boxer（拳师） here.',
    sourcePath: null,
    known: KNOWN,
    properNames: ['Napoleon'],
    config: { 书级: { 词典: '/p/dict.csv' } },
    tier: 'A',
    maxLen: 20,
    involved: ['barn', 'the'],
  });
  assert.equal([...policy.known].includes('napoleon'), true, '专名并进已知词（专名不加注）');
  assert.deepEqual([...policy.dict!.keys()], ['barn'], '词典只带本句命中词');
  assert.equal(policy.maxLen, 20);
  assert.match(notes.join('｜'), /已注词账本/);
});

test('没读到词典要留痕（不假装查过同词同义）', async () => {
  memIo({});
  const { notes } = await buildAppPolicy({
    currentText: '', sourcePath: null, known: KNOWN, properNames: [],
    config: null, tier: 'A', maxLen: 20, involved: [],
  });
  assert.match(notes.join('｜'), /没读到统一词典/);
});

test('端到端：App 策略切片 + 同一个 checkRewrite → 抓住"改写引入未注的难词"', async () => {
  memIo({ '/p/dict.csv': '词,释义,来源\nbarn,谷仓\n' });
  const { policy } = await buildAppPolicy({
    currentText: 'The boy ran to the barn（谷仓）.',
    sourcePath: null, known: KNOWN, properNames: [],
    config: { 书级: { 词典: '/p/dict.csv' } }, tier: 'A', maxLen: 20,
    involved: ['tremendous'],
  });
  const req = { source: 'The boy ran to the barn.', scope: 'sentence' as const, tier: 'A', bookVersion: 'v1' };
  const bad = checkRewrite(req, policy, 'The boy ran to a tremendous structure.');
  assert.equal(bad.status, 'blocked', '这正是改造前会被静默写进正文的那类候选');
  assert.equal(bad.checks.blockers.some((p) => p.ruleId === 'ANNO-01'), true);
  const ok = checkRewrite(req, policy, 'The boy ran to a tremendous（巨大的） structure.');
  assert.equal(ok.status, 'candidate', ok.blockedReasons.join('；'));
});

test('端到端：跨章重复注会被抓住（账本来自全篇）', async () => {
  memIo({ '/p/dict.csv': '词,释义,来源\nbarn,谷仓\n' });
  const { policy } = await buildAppPolicy({
    // 打开的这章没有 barn 的注释，但账本里有（模拟"第 1 章注过"）
    currentText: 'The boy ran to the barn（谷仓）.',
    sourcePath: null, known: KNOWN, properNames: [],
    config: { 书级: { 词典: '/p/dict.csv' } }, tier: 'A', maxLen: 20, involved: ['barn'],
  });
  const r = checkRewrite(
    { source: 'The boy ran to the barn.', scope: 'sentence', tier: 'A', bookVersion: 'v1' },
    policy,
    'The boy ran to the barn（谷仓） again.',
  );
  const hit = r.checks.warns.find((x) => x.ruleId === 'ANNO-02');
  assert.ok(hit, '全篇一词一注：账本里的词再注必须被抓');
  assert.deepEqual(hit.detail?.words, ['barn']);
});

test('界面徽标三态：过门禁 / 部分约束未带 / 未过门禁', () => {
  assert.equal(gateBadge({ status: 'candidate', missingPolicy: [] }).text, '✓ 已过门禁');
  assert.equal(gateBadge({ status: 'candidate', missingPolicy: ['统一词典（…）'] }).text, '⚠ 部分约束未带');
  assert.equal(gateBadge({ status: 'blocked', missingPolicy: [] }).text, '⛔ 未过门禁');
  assert.equal(gateBadge({ status: 'blocked', missingPolicy: [] }).cls, 'gate-blocked');
});
