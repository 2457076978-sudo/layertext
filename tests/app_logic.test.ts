/** 纯逻辑模块测试：AI 解析容错 / 书级替换 / 章节识别（稳定性回归） */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyRewriteTo, normalizeAndSplitChapters, parseAiJson, withRetry } from '../app/src/pure.js';

test('withRetry：网络错误自动重试后成功', async () => {
  let calls = 0;
  const r = await withRetry(async () => {
    calls++;
    if (calls < 3) throw new Error('Failed to fetch');
    return 'ok';
  });
  assert.equal(r, 'ok');
  assert.equal(calls, 3);
});

test('withRetry：不可重试错误（401）立即抛出', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw new Error('HTTP 401: unauthorized'); }),
    /401/,
  );
  assert.equal(calls, 1);
});

test('withRetry：429 限流可重试', async () => {
  let calls = 0;
  const r = await withRetry(async () => {
    calls++;
    if (calls === 1) throw new Error('HTTP 429: too many requests');
    return 'done';
  });
  assert.equal(r, 'done');
  assert.equal(calls, 2);
});

test('parseAiJson：标准数组', () => {
  const r = parseAiJson('[{"a":1}]') as { a: number }[];
  assert.equal(r[0].a, 1);
});

test('parseAiJson：单对象自动包数组', () => {
  const r = parseAiJson('好的，这是改写：{"original":"x","revised":"y"}') as { original: string }[];
  assert.equal(r[0].original, 'x');
});

test('parseAiJson：代码围栏剥离', () => {
  const r = parseAiJson('```json\n[{"a":2}]\n```') as { a: number }[];
  assert.equal(r[0].a, 2);
});

test('parseAiJson：截断修复（最后一个完整对象补 ]）', () => {
  const r = parseAiJson('[{"a":1},{"a":2},{"a":3') as { a: number }[];
  assert.equal(r.length, 2);
  assert.equal(r[1].a, 2);
});

test('parseAiJson：纯文本报错带原话', () => {
  assert.throws(() => parseAiJson('抱歉，我无法完成这个请求。'), /无法完成/);
});

test('applyRewriteTo：词边界替换不误伤子串', () => {
  const out = applyRewriteTo('Mr. Jones and Jonesy saw the jones.', [{ from: 'Jones', to: 'X' }]);
  assert.equal(out, 'Mr. X and Jonesy saw the jones.');
});

test('applyRewriteTo：多处全替换 + 词组', () => {
  const out = applyRewriteTo('Napoleon said. Napoleon ran. Old Major slept.', [
    { from: 'Napoleon', to: 'Pig King' },
    { from: 'Old Major', to: '老少校' },
  ]);
  assert.equal(out.includes('Napoleon'), false);
  assert.equal(out, 'Pig King said. Pig King ran. 老少校 slept.');
});

test('章节识别：多章标题拆分', () => {
  const raw = 'Intro text here.\n\nChapter One\n\nA dog ran.\n\nChapter Two\n\nA cat sat.';
  const r = normalizeAndSplitChapters(raw, 'book.txt');
  assert.equal(r.chapters.length, 2);
  assert.ok(r.chapters[0].md.includes('## Chapter 1'));
  assert.ok(r.chapters[1].md.includes('## Chapter 2'));
  assert.ok(r.chapters[0].md.includes('[P01] A dog ran.'));
});

test('章节识别：中文章标题拆分', () => {
  const raw = '第一章\n\nHello world.\n\n第二章\n\nGoodbye world.';
  const r = normalizeAndSplitChapters(raw, '书.txt');
  assert.equal(r.chapters.length, 2);
});

test('章节识别：无章节结构 → 单章包装', () => {
  const r = normalizeAndSplitChapters('One two three.\n\nFour five six.', 'note.txt');
  assert.equal(r.chapters.length, 1);
  assert.ok(r.chapters[0].md.includes('## Chapter 1'));
  assert.ok(r.chapters[0].md.includes('[P02] Four five six.'));
});

test('章节识别：已含 ## Chapter 标记直接使用', () => {
  const md = '# t\n\n## Chapter One\n\n[P01] hi\n';
  const r = normalizeAndSplitChapters(md, 'a.md');
  assert.equal(r.alreadyFormatted, true);
  assert.equal(r.chapters[0].md, md);
});

test('checkRevisedText：多句改写逐句复核（拆句后不再误报超长）', async () => {
  const { checkRevisedText } = await import('../app/src/pure.js');
  const fakeRisk = (sent: string, maxLen: number) => ({
    passive: / was driven/.test(sent),
    relcl: / who /.test(sent),
    pastperf: / had /.test(sent),
    overlong: sent.split(/\s+/).length > maxLen,
  });
  // 41 词长句拆成三短句后：每句 ≤12 词 → 不再超长
  const revised = 'The song was new to them. Yet every animal knew the tune. It made them happier than anything else.';
  const r = checkRevisedText(revised, 20, fakeRisk);
  assert.equal(r.overlong, false);
  assert.equal(r.passive, false);
  // 整串 22 词若不拆会被误判——对照：单句模式（旧逻辑）确实超长
  assert.equal(fakeRisk(revised, 20).overlong, true);
  // 任一句含被动则整体标被动
  const r2 = checkRevisedText('He ran. The car was driven away.', 20, fakeRisk);
  assert.equal(r2.passive, true);
});
