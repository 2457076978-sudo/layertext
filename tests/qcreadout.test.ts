/**
 * 人话判读（功能四项 · 项 2）· 测试
 *
 * 2a：每条判读函数的档位边界——阈值必须来自既有定标（两轮调适制档位/中考句长定标/
 *     回放层 95·80 线/ANNO_DENSITY_WARN），测试按档位边界值逐段断言。
 * 2b：门禁弹层核对表=gateTableHtml（从 chat.ts 移入）逐行判读在场、注密度行原样并入。
 * 2c：renderReportPane（动态 import——?raw 资产需先注册 _dom_env 的 raw-hook）输出含五行判读。
 * 2d：书级汇总一句话总结（达标口径=无超长且无禁用项）。
 * 2e：模块头注释必须写明阈值出处（防新造阈值的形状锁）。
 */

import './_dom_env.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { bookSummaryLine, gateTableHtml, readoutAnnoCoverage, readoutAvgLen, readoutCoverage, readoutNewWordRate, readoutOverCount, readoutPending, reportReadouts } from '../app/src/qcreadout.js';
import { qcDensityRow } from '../app/src/qcdensity.js';
import { runQc } from '../src/core/qc.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('2a：生词率四档（两轮调适制档位目标）边界逐段', () => {
  assert.match(readoutNewWordRate(0.019), /顺畅档/);
  assert.match(readoutNewWordRate(0.02), /顺畅档/, '2% 恰在线上=顺畅');
  assert.match(readoutNewWordRate(0.021), /可读档/);
  assert.match(readoutNewWordRate(0.05), /可读档/, '5% 在线上=可读');
  assert.match(readoutNewWordRate(0.052), /吃力档/);
  assert.match(readoutNewWordRate(0.1), /吃力档/, '10% 在线上=吃力');
  assert.match(readoutNewWordRate(0.105), /读不下去档/);
});

test('2a：平均句长对中考定标带（P50≈10 / P75=14 / 干净年 P90 17-20）叙述', () => {
  assert.match(readoutAvgLen(9, 16), /中考卷主流/);
  assert.match(readoutAvgLen(10, 16), /中考卷主流/);
  assert.match(readoutAvgLen(11, 16), /P75（14 词）以内——舒适/);
  assert.match(readoutAvgLen(15, 16), /仍在干净年 P90/);
  assert.match(readoutAvgLen(21, 22), /超出中考 P90/, '超 P90 用不超标准的上限来测');
  assert.match(readoutAvgLen(20, 20), /有点长/, '20 词仍在 P90 带内');
  // 超当前简化标准优先于中考带叙述
  assert.match(readoutAvgLen(17, 14), /超当前简化标准（14）/);
});

test('2a：覆盖率文献带 / 加注覆盖率 95·80 线 / 超长句 / 待定词', () => {
  assert.match(readoutCoverage(0.985), /98%\+ = 无辅助顺畅/);
  assert.match(readoutCoverage(0.96), /95-98% = 最低限度理解/);
  assert.match(readoutCoverage(0.92), /偏紧/);
  assert.match(readoutCoverage(0.85), /不足 90%/);
  assert.match(readoutAnnoCoverage(0.96), /≥95% 守卫线/);
  assert.match(readoutAnnoCoverage(0.9), /80-95% 之间有漏注/);
  assert.match(readoutAnnoCoverage(0.7), /低于 80% 是事故级/);
  assert.match(readoutOverCount(0), /无超长句/);
  assert.match(readoutOverCount(3), /3 句超线/);
  assert.match(readoutPending(0), /无待定词/);
  assert.match(readoutPending(4), /4 个待定词/);
});

test('2b：gateTableHtml 逐行判读在场、注密度行原样并入、超线行黄标', () => {
  const r = runQc(
    '# Book\n\n## Chapter One\n\n[P01] The hare ran fast and the tortoise walked on and on and on and on and on and on and on.\n',
    { known: new Set(['the', 'hare', 'ran', 'fast', 'and', 'tortoise', 'walked', 'on']), pending: new Set() },
    { tier: 'M', fileName: 'x.md' },
  );
  const html = gateTableHtml(r, 16, qcDensityRow({ per100: 2.1, worst: { d: 4.3, at: 'P03' } }));
  assert.match(html, /本章实际（人话判读）/);
  assert.match(html, /生词率（词型）/);
  assert.match(html, /顺畅档|可读档|吃力档|读不下去档/, '生词率判读随行');
  assert.match(html, /中考卷主流|P75|P90|超当前简化标准/, '句长判读随行');
  assert.match(html, /注密度/);
  assert.match(html, /低于警戒线 8——支架密度健康/, '注密度行（qcdensity 唯一实现）原样并入');
  assert.equal((html.match(/warnrow/g) ?? []).length >= 1, true, '有超线指标时黄行在场');
});

test('2c：renderReportPane 输出含五行判读（动态 import：?raw 资产走 _dom_env 注册的 raw-hook）', async () => {
  const { renderReportPane } = await import('../app/src/report.js');
  const { newReviewState } = await import('../app/src/types.js');
  const md = '# Book\n\n## Chapter One\n\n[P01] The hare ran fast.\n\n[P02] The tortoise walked slowly.\n';
  const lex = { known: new Set(['the', 'hare', 'ran', 'fast', 'tortoise', 'walked', 'slowly']), pending: new Set<string>() };
  const report = runQc(md, lex, { tier: 'M', fileName: '第一章.md' });
  const session = { md, fileName: '第一章.md', sourcePath: null, markPath: null, review: newReviewState('第一章.md'), report, reportSavedPath: null, dirty: false };
  renderReportPane(session as never);
  const pane = document.getElementById('pane-report')!;
  assert.ok(pane, '骨架里要有 pane-report');
  assert.match(pane.innerHTML, /数字\+人话判读/);
  assert.match(pane.innerHTML, /生词率 [\d.]+%：/, '报告页生词率带判读');
  assert.match(pane.innerHTML, /均句长 [\d.]+ 词：/);
  assert.match(pane.innerHTML, /加注覆盖率 [\d.]+%：/);
  assert.match(pane.innerHTML, /超长句 \d+ 句：/);
});

test('2d：书级一句话总结——达标口径（无超长且无禁用项）、短板点名、空书引导', () => {
  const row = (over: number, p: number): Array<{ status: string; overlong: number; passive: number; relcl: number; pastperf: number }> => [
    { status: 'done', overlong: over, passive: p, relcl: 0, pastperf: 0 },
  ];
  assert.match(bookSummaryLine([...row(0, 0), ...row(0, 0)]), /2 章完成、2 章达标/);
  assert.match(bookSummaryLine([...row(0, 0), ...row(0, 0)]), /全书过关/);
  assert.match(bookSummaryLine([...row(0, 0), ...row(2, 0), ...row(0, 1)]), /3 章完成、1 章达标/);
  assert.match(bookSummaryLine([...row(0, 0), ...row(2, 0), ...row(0, 1)]), /超长句（1 章）、禁用句法（1 章）/);
  assert.match(bookSummaryLine([]), /还没有完成的章/);
});

test('2e：判读阈值零新造——模块头必须写明出处（形状锁）', () => {
  const head = readFileSync(join(REPO, 'app/src/qcreadout.ts'), 'utf-8').split('*/')[0]!;
  assert.match(head, /两轮调适制定标/, '生词率档位出处');
  assert.match(head, /句长定标/, '中考句长定标出处');
  assert.match(head, /ANNO_DENSITY_WARN/, '注密度出处');
  assert.match(head, /95% 解释线 \/ 80% 事故线/, '加注覆盖率线出处');
  assert.match(head, /Laufer 1989/, '覆盖率文献带出处');
});

test('2c 前置：reportReadouts 纯函数五行（复现命中仅在队列存在时出场）', () => {
  const r = runQc('# Book\n\n## Chapter One\n\n[P01] The hare ran fast.\n', { known: new Set(['the', 'hare', 'ran', 'fast']), pending: new Set() }, { tier: 'M', fileName: 'x.md' });
  const lines = reportReadouts(r, 16);
  assert.equal(lines.length, 4, '无复现队列时四行');
  assert.match(lines.join('\n'), /生词率/);
  assert.match(lines.join('\n'), /加注覆盖率/);
});
