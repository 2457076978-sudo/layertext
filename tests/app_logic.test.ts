/** 纯逻辑模块测试：AI 解析容错 / 书级替换 / 章节识别（稳定性回归） */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyRewriteTo, findOriginalFlex, normalizeAndSplitChapters, normWs, parseAiJson, withRetry } from '../app/src/pure.js';

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

test('findOriginalFlex：唯一精确匹配直接返回（欠账#2 回归）', () => {
  const md = '[P01] The hare laughed. The tortoise walked slowly.';
  const r = findOriginalFlex(md, 'The tortoise walked slowly.');
  assert.ok(r);
  assert.equal(r.start, md.indexOf('The tortoise'));
  assert.equal(r.exact, 'The tortoise walked slowly.');
});

test('findOriginalFlex：句末多空格/句中多重空格差异仍命中，返回正文原文切片', () => {
  const md = '[P01] The hare   laughed.   The tortoise walked slowly.  ';
  // AI 抄句时把多重空格压成一个、句末空格丢了——仍应命中，且 exact 是正文里的原样
  const r = findOriginalFlex(md, 'The hare laughed. The tortoise walked slowly.');
  assert.ok(r);
  assert.equal(r.exact, 'The hare   laughed.   The tortoise walked slowly.');
  assert.equal(md.slice(r.start, r.start + r.exact.length), r.exact);
});

test('findOriginalFlex：换行差异（AI 给了单空格，正文是换行）也能命中', () => {
  const md = '[P01] The hare\nlaughed loudly.';
  const r = findOriginalFlex(md, 'The hare laughed loudly.');
  assert.ok(r);
  assert.equal(r.exact, 'The hare\nlaughed loudly.');
});

test('findOriginalFlex：多处命中（歧义）与未命中返回 null', () => {
  assert.equal(findOriginalFlex('Same words. Same words.', 'Same words.'), null);
  assert.equal(findOriginalFlex('Nothing here.', 'The hare laughed.'), null);
  assert.equal(findOriginalFlex('anything', '   '), null);
});

test('normWs：连续空白压一、去首尾', () => {
  assert.equal(normWs('  a \n\n b\t c  '), 'a b c');
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
  // 整串 19 词若不拆、按上限 12 判——旧逻辑（整串算）确实超长
  assert.equal(fakeRisk(revised, 12).overlong, true);
  // 任一句含被动则整体标被动
  const r2 = checkRevisedText('He ran. The car was driven away.', 20, fakeRisk);
  assert.equal(r2.passive, true);
});

/* ---------- 对话压缩（欠账#1） ---------- */

import { COMPACT_DEFAULTS, estTokens, planCompaction, type ChatMsgLike } from '../app/src/pure.js';

function mkMsgs(n: number, filler = 'word '): ChatMsgLike[] {
  const out: ChatMsgLike[] = [];
  for (let i = 0; i < n; i++) out.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: (filler).repeat(80) + i });
  return out;
}

test('estTokens：英文约 3.5 字符/词符，中文按 1.6 字计', () => {
  assert.equal(estTokens('abcd'.repeat(10)), Math.round(40 / 3.5));
  assert.equal(estTokens('中文中文'), Math.round(4 * 1.6));
});

test('planCompaction：低于阈值不压缩', () => {
  const plan = planCompaction(mkMsgs(10));
  assert.equal(plan.need, false);
});

test('planCompaction：估算 tokens 超限且 user 轮数足够 → 压缩，切点落在 user 消息上', () => {
  const msgs = mkMsgs(20, 'a very long filler sentence here '); // 30 chars × 80 ≈ 2400 est/条 × 20 ≈ 48000
  const plan = planCompaction(msgs);
  assert.equal(plan.need, true);
  assert.equal(msgs[plan.keptFrom].role, 'user', '尾段必须从 user 消息开始');
  assert.equal(plan.headCount, plan.keptFrom);
  assert.ok(plan.estBefore > COMPACT_DEFAULTS.maxEst);
  assert.ok(plan.estTail < plan.estBefore);
  // 压缩后总量（摘要估算 + 尾段）显著小于压缩前
  assert.ok(plan.estTail + COMPACT_DEFAULTS.summaryEst < plan.estBefore);
});

test('planCompaction：消息条数超限同样触发', () => {
  const msgs = mkMsgs(50, 'hi ');
  const plan = planCompaction(msgs);
  assert.equal(plan.need, true);
  assert.ok(plan.keptFrom > 0);
});

test('planCompaction：user 轮数不足（无安全切点）不压缩', () => {
  const msgs: ChatMsgLike[] = [
    { role: 'user', content: 'x'.repeat(99999) },
    { role: 'assistant', content: 'y'.repeat(99999), tool_calls: [{ id: 't1', function: { name: 'get_sentence', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't1', content: 'z'.repeat(99999) },
    { role: 'assistant', content: 'w'.repeat(99999) },
  ];
  const plan = planCompaction(msgs);
  assert.equal(plan.need, false, '只有 1 轮 user，没有可保留下来的尾段切点');
});

test('planCompaction：assistant.tool_calls 与其 tool 结果不被拆开（都留在同侧）', () => {
  const msgs = mkMsgs(20, 'a very long filler sentence here ');
  // 在尾段中部放一对 assistant(tool_calls) + tool 消息
  msgs.push(
    { role: 'assistant', content: '让我查一下', tool_calls: [{ id: 't9', function: { name: 'search_text', arguments: '{"query":"windmill"}' } }] },
    { role: 'tool', tool_call_id: 't9', content: 'P02-S03｜The windmill stood.' },
    { role: 'assistant', content: '查到了…' },
  );
  const plan = planCompaction(msgs);
  assert.equal(plan.need, true);
  const tail = msgs.slice(plan.keptFrom);
  const hasCall = tail.some((m) => m.tool_calls && (m.tool_calls as unknown[]).length);
  if (hasCall) {
    // 尾段出现 tool_calls 时，对应的 tool 结果必须也在尾段（DeepSeek 要求成对回传）
    assert.ok(tail.some((m) => m.role === 'tool'), 'tool_calls 与 tool 结果未被拆散');
  }
});

/* ---------- 全书批处理（O2） ---------- */

import { buildBookReportMd, planBatchChapters, type BatchProgressFile, type BookReportRow } from '../app/src/pure.js';

test('planBatchChapters：进度文件里 done 的章标记已完成（续跑跳过），其余可跑', () => {
  const progress: BatchProgressFile = {
    date: '2026-09-07',
    instructions: '面向九年级',
    status: { '/book/第一章.md': 'done', '/book/第三章.md': 'failed' },
  };
  const items = planBatchChapters(['/book/第一章.md', '/book/第二章.md', '/book/第三章.md'], progress);
  assert.deepEqual(items.map((x) => x.done), [true, false, false], '仅 done 标记跳过；failed 需重跑');
  assert.equal(items[0].name, '第一章.md');
});

test('planBatchChapters：无进度文件全部可跑', () => {
  const items = planBatchChapters(['/book/a.md'], null);
  assert.equal(items[0].done, false);
});

test('buildBookReportMd：横向表 + 合计 + 失败章与残留提示', () => {
  const rows: BookReportRow[] = [
    { chapter: '第一章.md', output: '第一章_简化_2026-09-07.md', segCount: 10, oovRate: '2.1%', avgLen: '10.5', maxLen: 15, passive: 0, relcl: 1, pastperf: 0, overlong: 0, ruleLeft: 0, elapsedMs: 61000, outTokens: 3000, status: 'done' },
    { chapter: '第二章.md', output: '', segCount: 8, oovRate: '', avgLen: '', maxLen: 0, passive: 0, relcl: 0, pastperf: 0, overlong: 0, ruleLeft: 0, elapsedMs: 5000, outTokens: 0, status: 'failed', error: 'HTTP 429: rate limit' },
  ];
  const md = buildBookReportMd(rows, { book: '动物农场', date: '2026-09-07', maxLen: 16, instructions: '面向九年级' });
  assert.ok(md.includes('# 全书简化报告 · 动物农场'));
  assert.ok(md.includes('完成 1/2 章'));
  assert.ok(md.includes('| 第一章.md | 第一章_简化_2026-09-07.md | 10 | 2.1% | 10.5 | 15 | 0 | 1 |'));
  assert.ok(md.includes('（失败）'), '失败章产物列显示失败');
  assert.ok(md.includes('**合计**'));
  assert.ok(md.includes('## 建议人工复查'));
  assert.ok(md.includes('定从 1'), '黑名单残留章进入复查提示');
  assert.ok(md.includes('简化失败（HTTP 429: rate limit）'));
});

test('buildBookReportMd：全部达标时不出现复查段，给 🎉 判读', () => {
  const rows: BookReportRow[] = [
    { chapter: '第一章.md', output: 'a_简化_1.md', segCount: 10, oovRate: '1.0%', avgLen: '10.0', maxLen: 14, passive: 0, relcl: 0, pastperf: 0, overlong: 0, ruleLeft: 0, elapsedMs: 60000, outTokens: 3000, status: 'done' },
  ];
  const md = buildBookReportMd(rows, { book: '书', date: '2026-09-07', maxLen: 16 });
  assert.ok(!md.includes('## 建议人工复查'));
  assert.ok(md.includes('🎉'));
});
