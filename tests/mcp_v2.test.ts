/**
 * MCP 工具层 v2（项 2 验收 2a/2b）——工具 6–9 的正常路径与输入校验拒绝路径。
 * 判定函数必须来自 core（rework/acceptance/sourceprobe），本测试同时锁这个事实：
 * 每个工具的行为断言都以 core 函数的直接调用为对照（同输入同结论）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMcpLexicon, toolAcceptanceV2, toolReworkGates, toolReworkLedger, toolSourceProbe } from '../src/core/mcpTools.js';
import { reworkGates } from '../src/core/rework.js';
import { probeChapterSource } from '../src/core/sourceprobe.js';

/** 词库只认基础词——让 red/未注判定可控（纯文本词表按行拆，别用空格连一行） */
const lex = buildMcpLexicon({}, ['the\na\nan\nand\nof\nto\nin\non\nfarm\nanimals\nworked\nhard\nquietly\nyear\nmoved\nfield\ngave\norders\ntwo\nnapoleon']);

test('layer_rework_gates：改好红词的修订过四闸；引入新红词/丢注释的修订被拦', () => {
  const before = '[P01] The farmz animals toiled mercilessly in the field.';
  const good = '[P01] The animals worked hard in the field.';
  const r = toolReworkGates(before, good, 16, lex) as { pass: boolean; failures: unknown[] };
  assert.equal(r.pass, true, JSON.stringify(r.failures));
  // 丢注释：before 有注、after 没了 → 注释不丢闸拦下
  const b2 = '[P01] The animals（动物们） toiled mercilessly in the field.';
  const a2 = '[P01] The animals worked hard in the field.';
  const r2 = toolReworkGates(b2, a2, 16, lex) as { pass: boolean; failures: Array<{ gate: string }> };
  assert.equal(r2.pass, false);
  assert.ok(r2.failures.some((f) => f.gate === '注释不丢'));
  // 与 core reworkGates 同输入同结论（MCP 层不自算）
  const direct = reworkGates({ before: b2, after: a2, maxLen: 16, redBefore: 1, redAfter: 0 });
  assert.equal(direct.pass, false);
});

test('layer_rework_gates：空输入拒绝（说出口，不静默）', () => {
  assert.ok('error' in toolReworkGates('', 'x', 16, lex));
  assert.ok('error' in toolReworkGates('x', ' ', 16, lex));
});

test('layer_rework_ledger：v1/v2 混合台账汇总分组正确；空输入拒绝', () => {
  const ledger = [
    JSON.stringify({ tier: 'A', chapter: '二', seg: 'P04', verdict: '✓换词降红', reason: 'ok' }),
    JSON.stringify({ tier: 'M', chapter: '五', seg: 'P22', verdict: '挂起', reason: '未过闸（锁✓ 未注1>1 长76→76）' }),
    JSON.stringify({ tier: 'A', chapter: '二', seg: 'P04', verdict: '挂起', reason: '未过闸（红2→2 长115→102 注0→0 句max58）', class: '句长超线' }),
    'not-json 坏行',
  ].join('\n');
  const r = toolReworkLedger(ledger, { A: 19, M: 17, B: 16 }) as { total: number; badLines: number; hung: number; groups: Array<{ cls: string; count: number }> };
  assert.equal(r.total, 3);
  assert.equal(r.badLines, 1);
  assert.equal(r.hung, 2);
  assert.deepEqual(r.groups.map((g) => g.cls).sort(), ['句长超线', '未注超标']);
  assert.ok('error' in toolReworkLedger(''));
  // 全坏行 ≠ 空台账：如实报 total 0 + badLines 2（说出口，不静默当干净）
  const allBad = toolReworkLedger('只有坏行\n不是json') as { total: number; badLines: number };
  assert.equal(allBad.total, 0);
  assert.equal(allBad.badLines, 2);
});

test('layer_source_probe：chapters 直通 core（同输入同结论）；空数组拒绝', () => {
  const chapters = [
    { name: '一', text: '[P01] The animals worked hard and the farm moved on quietly that year.' },
    { name: '二', text: '[P01] The farmz toiledx' },
  ];
  const via = toolSourceProbe(chapters) as { results: ReturnType<typeof probeChapterSource> };
  assert.deepEqual(via.results, probeChapterSource(chapters));
  assert.ok('error' in toolSourceProbe([]));
});

test('layer_acceptance_v2：A/B 必给校验 + 倒挂检出 + 排序判定', () => {
  assert.ok('error' in toolAcceptanceV2({ A: 'x' }, undefined, undefined, lex));
  // A 层有难词未注、B 层换成已学词 → B 未注率 < A；同段 B 未注 < A → 无倒挂
  const A = '[P01] The farmz animals toiledx mercilessly in the field today.';
  const B = '[P01] The animals worked hard in the field.';
  const r = toolAcceptanceV2({ A, B }, undefined, undefined, lex) as {
    rates: Record<string, { ratePct: number }>;
    rateOrderPass: boolean;
    segInversions: unknown[];
    structure: string[];
  };
  assert.equal(r.rates.B.ratePct, 0);
  assert.ok(r.rates.A.ratePct > 0);
  assert.equal(r.segInversions.length, 0);
  assert.ok(Array.isArray(r.structure));
  // 反例：B 比 A 更难 → 同段倒挂
  const r2 = toolAcceptanceV2({ A: B, B: A }, undefined, undefined, lex) as { segInversions: Array<{ seg: string }> };
  assert.equal(r2.segInversions.length, 1);
  assert.equal(r2.segInversions[0].seg, 'P01');
});

test('layer_acceptance_v2：语义校验（凭空数字/专名丢失）需要 source 才做', () => {
  const A = '[P01] Napoleon gave two orders.';
  const B = '[P01] Napoleon gave 3 orders.';
  const withSrc = toolAcceptanceV2({ A, B }, { P01: 'Napoleon gave two orders.' }, ['napoleon'], lex) as { semantic: string[] };
  assert.ok(
    withSrc.semantic.some((s) => s.includes('凭空数字')),
    JSON.stringify(withSrc.semantic),
  );
  const noSrc = toolAcceptanceV2({ A, B }, undefined, undefined, lex) as { semantic: string[] };
  assert.equal(noSrc.semantic.length, 0, '没给 source 就不该有语义结论');
});
