/**
 * 债务总览卡 · 单测+纪律扫描（复盘方案 A6，2026-09-26）
 *
 * 锁四件事：①两个表头解析器吃真实报告格式（回炉重测/待人工清单，逐字取自
 * 重制三版/_运行 实物）；②卡面呈现契约（数量+日期+入口钩子）；③空态/缺态
 * 如实说"还没有"，不编数；④纪律扫描——本模块不自算：源体检必须 import core
 * 的 probeChapterSource，且不得出现回炉闸/验收的重新实现痕迹。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { debtCardHtml, parseQuarantineHeader, parseRecheckHeader, type DebtState } from '../app/src/debtcard.js';

const REAL_RECHECK_HEAD = '# 回炉挂起重测 · 2026-09-18（当前产物 × 当前闸·引语豁免）\n\n台账挂起去重 209 段：**已消化 94｜仍挂 114**｜产物缺失 1。';
const REAL_QUARANTINE_HEAD = '# 工序化待人工 · M层（中层） 第一章\n\n总段数 14｜自动完成 9｜隔离 5（事实疑点 0｜结构损坏 0｜难度残留 5）';

test('回炉重测表头解析：吃真实报告格式', () => {
  assert.deepEqual(parseRecheckHeader(REAL_RECHECK_HEAD), { digested: 94, still: 114, missing: 1 });
  assert.equal(parseRecheckHeader('# 别的报告'), null);
});

test('待人工清单表头解析：吃真实格式（"隔离 N（"带全角括号）', () => {
  assert.equal(parseQuarantineHeader(REAL_QUARANTINE_HEAD), 5);
  assert.equal(parseQuarantineHeader('总段数 14｜自动完成 14'), null);
});

test('卡面契约：数量+日期+入口钩子成对出现；点行 reveal 的 data 钩子齐', () => {
  const st: DebtState = {
    recheck: { digested: 94, still: 114, missing: 1, date: '2026-09-18', path: '/r/回炉重测_2026-09-18.md' },
    quarantine: { total: 323, byTier: { A层: 60, M层: 116, B层: 147 }, files: 30, date: '2026-09-12', firstPath: '/x/工序化待人工_M层75_2026-09-12.md' },
    sourceBad: [{ name: '第十章', words: 358, notes: ['词数骤降：358 词（相邻章中位 3871 的 9%）'], path: '/s/第十章/原文_规范化.md' }],
  };
  const html = debtCardHtml(st, false);
  assert.match(html, /回炉仍挂 <b>114<\/b> 段/);
  assert.match(html, /重测于 2026-09-18/);
  assert.match(html, /工序化隔离 <b>323<\/b> 段（A层 60·M层 116·B层 147｜30 份/);
  assert.match(html, /源残缺：<b>第十章<\/b>（358 词）/);
  for (const id of ['recheck', 'quarantine', 'source']) assert.ok(html.includes(`data-dp-debt="${id}"`), `入口钩子 ${id} 缺`);
  assert.ok(html.includes('data-dp-src="第十章"'));
});

test('空态如实：没有报告/清单时说"还没有"，不编数', () => {
  const html = debtCardHtml({ recheck: null, quarantine: null, sourceBad: [] }, false);
  assert.match(html, /还没有重测报告/);
  assert.match(html, /没有待人工清单/);
  assert.match(html, /源体检：各章原文完整/);
  assert.match(debtCardHtml(null, false), /还没有可读的债务台账/);
  assert.match(debtCardHtml(null, true), /正在读台账与报告/);
});

test('纪律扫描：不自算——源体检走 core 唯一实现，无闸门/验收重现痕迹', () => {
  const src = readFileSync(fileURLToPath(new URL('../../app/src/debtcard.ts', import.meta.url)), 'utf8');
  assert.match(src, /from '\.\.\/\.\.\/src\/core\/sourceprobe\.js'/, '源体检必须直调 core.probeChapterSource（装配不自算）');
  assert.match(src, /回炉重测_/, '回炉数字必须来自重测报告文件（--recheck 的结论），不许从台账 jsonl 自行重判');
  for (const banned of ['reworkGates', 'acceptanceV2', 'SENT_LEN_CHECK', 'redBefore']) assert.ok(!src.includes(banned), `债务卡不得重新实现 ${banned}`);
});
