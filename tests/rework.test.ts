/**
 * 段级回炉公共原语（src/core/rework.ts）——项 3 验收 3a/3d。
 * 引语豁免的口径来自 segmentgate 2026-09-12 定案（生成闸门先例）：句法工序改不了直接引语，
 * 不该为它否决；豁免只作用于"要不要打回"，报表照常计数。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyReworkPicks, classifyHangReason, maxSentenceLen, pickReworkSegments, reworkGates } from '../src/core/rework.js';

test('maxSentenceLen：中文注释整体剔除后再计数（word（中文）不算负荷）', () => {
  // 注释里 4 个汉字不进词数；正文 The/windmill/turned/slowly/in/the/wind = 7 词
  assert.equal(maxSentenceLen('The windmill（风车磨坊） turned slowly in the wind.'), 7);
  // 同一句若把注释当正文数会得 11+，这里锁定它不发生：构造注释极长的例子
  assert.equal(maxSentenceLen('He ran（飞快地跑向那座早已荒废的谷仓旁边的小屋） home.'), 3); // He/ran/home
});

test('maxSentenceLen：默认（不豁免）按全文计——引语长句照算', () => {
  const t = 'He said, "I will work harder every single day of my whole life in this farm than ever before." Then he left.';
  // 引号内 18 词 + He said 2 词同句；Then he left 3 词
  assert.ok(maxSentenceLen(t) >= 18, `不豁免时应把引语算进句长（实测 ${maxSentenceLen(t)}）`);
});

test('★ maxSentenceLen：exemptQuotes 时直接引语剔除——引语内长句不再否决（生成闸门同口径）', () => {
  const t = 'He said, "I will work harder every single day of my whole life in this farm than ever before." Then he left.';
  const n = maxSentenceLen(t, { exemptQuotes: true });
  // 引语剥掉后剩 He said,  Then he left.（中间无句号，算同一"句"）= He/said/Then/he/left = 5 词
  assert.equal(n, 5);
});

test('maxSentenceLen：引号未闭合时不豁免（与 stripDirectQuotes 同行为，防止豁免吞掉半章）', () => {
  const t = 'He began to speak and the words kept coming and coming without any end in sight or any sign of stopping "forever';
  assert.ok(maxSentenceLen(t, { exemptQuotes: true }) >= 18, '未闭合引号必须按全文计数');
});

test("maxSentenceLen：撇号口径=don't 数 2 词（lim+2 阈值在本口径标定，锁定不漂移）", () => {
  assert.equal(maxSentenceLen("I don't know."), 4); // i / don / t / know
});

test('classifyHangReason：旧台账 reason 文本 → 机器分类（优先级=闸序）', () => {
  assert.equal(classifyHangReason('未过锁闸（缺snowball,jones 数字无 否定）'), '锁失败');
  assert.equal(classifyHangReason('未过闸（锁✗ 未注3>2 长45→38）'), '锁失败'); // 锁在闸序最前
  assert.equal(classifyHangReason('未过闸（锁✓ 未注3>2 长45→45）'), '未注超标');
  assert.equal(classifyHangReason('未过闸（锁✓ 未注1>0 长40→52）'), '未注超标'); // 未注闸先于段长闸
  assert.equal(classifyHangReason('未过闸（锁✓ 长40→52）'), '段长越界');
  assert.equal(classifyHangReason('调用失败'), '调用失败');
  assert.equal(classifyHangReason('未过闸（句长 19>16）'), '句长超线');
  assert.equal(classifyHangReason('注释数减少 3→1'), '注释丢失');
});

test('classifyHangReason：未知形态如实归"未知"，不猜', () => {
  assert.equal(classifyHangReason(''), '未知');
  assert.equal(classifyHangReason('某种没见过的问题'), '未知');
});

test('classifyHangReason：v1 遗留格式（无条件罗列四个测量值）按数字判真凶', () => {
  // 红词未减（红2→2）按闸序先归类——引语豁免上线后句max不再是拦路闸，红词才是下一轮真靶子
  assert.equal(classifyHangReason('未过闸（红2→2 长115→102 注0→0 句max58）', { sentLimit: 19 }), '未注超标');
  assert.equal(classifyHangReason('未过闸（红2→2 长115→102 注0→0 句max12）', { sentLimit: 19 }), '未注超标');
  // 红词降了（2→1）但句超线 → 句长超线
  assert.equal(classifyHangReason('未过闸（红2→1 长115→102 注0→0 句max58）', { sentLimit: 19 }), '句长超线');
  // 没给 sentLimit 时句 max 判不了，不猜——退到红词/段长的可判定项
  assert.equal(classifyHangReason('未过闸（红2→1 长115→102 注0→0 句max58）'), '未知');
  // 段长真出带（v1 阈值 ±25%）：94/113=0.83 在带内不判；出带的才判
  assert.equal(classifyHangReason('未过闸（红1→0 长100→60 注1→1 句max12）', { sentLimit: 19 }), '段长越界');
  assert.equal(classifyHangReason('未过闸（红0→0 长113→94 注1→1 句max13）', { sentLimit: 19 }), '未知'); // 四项都判不出，如实归未知
  // v1 用「注」不用「注释」：注1→0 = 注释丢失
  assert.equal(classifyHangReason('未过闸（红8→4 长102→101 注1→0）'), '注释丢失');
});

/* ───────────── 项 1 追加：四闸细节 + 选段/装配（app_rework.test.ts 锁端到端，这里锁原语） ───────────── */

test('reworkGates：段长比只对 ≥20 词的段生效（短段波动是噪音，与整章守恒重试同先例）', () => {
  const long = Array.from({ length: 25 }, (_, i) => `word${i}`).join(' ') + '.';
  const shrunk = Array.from({ length: 12 }, (_, i) => `word${i}`).join(' ') + '.'; // 25→12 = 0.48 出带
  assert.ok(reworkGates({ before: long, after: shrunk, maxLen: 60, redBefore: 1, redAfter: 0 }).failures.some((f) => f.gate === '段长比'));
  // 短段 6→4（0.67）：不卡段长（红词 1→0 已过）
  const r = reworkGates({ before: 'The farmzxxx hardxxx animals ran home.', after: 'The animals ran home.', maxLen: 16, redBefore: 1, redAfter: 0 });
  assert.deepEqual(
    r.failures.map((f) => f.gate),
    [],
  );
});

test('pickReworkSegments：红项段=未注生词或引语豁免后超长；非红段不进清单', () => {
  const md = `# 书\n\n## Chapter One\n\n[P01] The animals worked hard.\n\n[P02] The farmzxxx ran home.\n\n[P03] The animals worked and worked and the farm grew and the seasons turned and the years passed by.\n`;
  const oovOf = (t: string): string[] => (t.includes('farmzxxx') ? ['farmzxxx'] : []);
  const pick = pickReworkSegments(md, oovOf, 16);
  assert.deepEqual(
    pick.reds.map((r) => r.id),
    ['P02', 'P03'],
  );
  assert.equal(pick.segs.length, 3);
  assert.ok(!pick.redSet.has(pick.segs[0]), '干净段不在红项集合');
  // 引语内的长句不算红（豁免口径与四闸同源）
  const md2 = `# 书\n\n## Chapter One\n\n[P01] He said, "I will work harder every single day of my whole life in this farm than ever before." Then he left.\n`;
  const pick2 = pickReworkSegments(md2, () => [], 16);
  assert.deepEqual(
    pick2.reds.map((r) => r.id),
    [],
    '引语长句不触发红项',
  );
});

test('applyReworkPicks：只替换过闸段；挂起/未选段原文一字不动；锚失效点名', () => {
  const md = `# 书\n\n## Chapter One\n\n[P01] aaa bbb.\n\n[P02] ccc ddd.\n\n[P03] eee fff.\n`;
  const seg2 = '[P02] ccc ddd.';
  const r = applyReworkPicks(md, [
    { find: seg2, replace: '[P02] ccc ddd eee.' },
    { find: '[P99] not exists.', replace: 'x' },
  ]);
  assert.equal(r.replaced, 1);
  assert.equal(r.failed.length, 1, '锚失效如实点名');
  assert.ok(r.md.includes('[P01] aaa bbb.\n\n[P02] ccc ddd eee.\n\n[P03] eee fff.'), '其余段与分隔原样');
});
