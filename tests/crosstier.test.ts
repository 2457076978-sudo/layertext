/**
 * 层间体检（功能四项 · 项 1）· 测试
 *
 * 锁三件事：
 *  · 装配一致性：crossTierOf 的逐章字段 === 直接调 acceptanceV2（同一引擎、同输入）——
 *    它是装配层不是第二把尺（引擎行为本身由 tests/acceptance_golden.test.ts 锁）。
 *  · 未算点名：单层/缺 A 或 B 的章进「未算」清单且带原因；语义维度无源稿时计数为
 *    **null（未算）**、hasSemantic=false——与 0 条警报是两回事，不许混。
 *  · 纪律扫描：crosstier.ts 不许本地复刻判定（1.15 算术/判定函数/IRREG）。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { acceptanceV2 } from '../src/core/acceptance.js';
import { crossTierCardHtml, crossTierChapterLine, crossTierOf, crossTierVerdict } from '../app/src/crosstier.js';
import type { BookScanResult } from '../app/src/bookscan.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/* ── 合成书（CC0 自写；词表收全真实词，生造词=flarn/zorb/plim）── */

const KNOWN = 'the old man kept a light on rock for years moved below cold sea door was open bell rang times at dawn boats carried coal down to tessin marlow said word never'.split(/\s+/);

const MD = {
  A: '[P01] the old man kept a light on the rock for 3 years.\n\n[P02] the flarn moved below the cold sea.',
  M: '[P01] the old man kept a light on the rock for years.\n\n[P02] the flarn moved below the cold sea.',
  B: '[P01] the old man kept a light on the rock.\n\n[P02] the zorb and the plim moved below the cold sea.',
  A2: '[P01] the door（门）was open and the bell（铃）rang.',
  B2: '[P01] the door was open.\n\n[P02] the boats carried coal down to the sea.',
  SRC: '[P01] the old man kept a light on the rock.\n\n[P02] the sea was cold.',
};

const mk = (rows: Array<[name: string, tier: string, path: string, text: string]>): BookScanResult => ({
  chapters: rows.map(([name, tier, path, text]) => ({ name, tier, path, text, marks: [] })),
  coverage: 'test',
});

test('1a：三层章逐字段=直算 acceptanceV2（装配层不是第二把尺）；缺 A 或 B 的章点名未算', () => {
  const scan = mk([
    ['第一章', 'A', '/b/1/a.md', MD.A],
    ['第一章', 'M', '/b/1/m.md', MD.M],
    ['第一章', 'B', '/b/1/b.md', MD.B],
    ['第二章', 'A', '/b/2/a.md', MD.A2], // 缺 B
    ['第三章', 'B', '/b/3/b.md', MD.B2], // 缺 A（连 M 都没有）
    ['第四章', '', '/b/4/src.md', MD.SRC], // 无层标签：根本不进判定
  ]);
  const r = crossTierOf(scan, { known: KNOWN });
  assert.equal(r.chapters.length, 1, '只有第一章 A+B 齐');
  const direct = acceptanceV2({ tiers: { A: MD.A, M: MD.M, B: MD.B }, known: KNOWN, proper: [] });
  const c = r.chapters[0]!;
  assert.deepEqual(c.rates, direct.rates);
  assert.equal(c.rateOrderPass, direct.rateOrderPass);
  assert.deepEqual(
    c.倒挂段.map((x) => ({ seg: x.seg, bUnnoted: x.bUnnoted, aUnnoted: x.aUnnoted, words: x.words })),
    direct.segInversions,
  );
  assert.deepEqual(c.句长, direct.sentGradient);
  assert.deepEqual(c.密度, direct.density);
  assert.equal(c.结构数, direct.structure.length);
  assert.equal(c.重复注数, direct.duplicateAnnos.length);
  assert.deepEqual(c.paths, { A: '/b/1/a.md', M: '/b/1/m.md', B: '/b/1/b.md' });
  assert.equal(
    c.倒挂段.every((x) => x.bPath === '/b/1/b.md'),
    true,
    '倒挂段带 B 层产物路径（点行跳转用）',
  );
  // 未算点名：第二章缺 B、第三章缺 A——静默跳过是最坏的一种
  assert.deepEqual(
    r.未算.map((u) => u.章),
    ['第二章', '第三章'],
  );
  assert.match(r.未算[0]!.原因, /缺 B/);
  assert.match(r.未算[1]!.原因, /缺 A/);
});

test('1b：语义维度缺源稿=未算（计数 null、hasSemantic=false），不是 0 条警报；给了 sourceOf 才算', () => {
  const scan = mk([
    ['第一章', 'A', '/b/1/a.md', MD.A],
    ['第一章', 'B', '/b/1/b.md', MD.B],
  ]);
  const noSrc = crossTierOf(scan, { known: KNOWN });
  assert.equal(noSrc.hasSemantic, false);
  assert.equal(noSrc.chapters[0]!.语义警报数, null, '无源稿=未算（null），区别于 0 条警报');
  assert.equal(noSrc.汇总.语义警报总数, null);
  assert.match(crossTierCardHtml(noSrc, false), /语义维度需章目录里有 原文_规范化/);

  const withSrc = crossTierOf(scan, { known: KNOWN, sourceOf: () => MD.SRC });
  assert.equal(withSrc.hasSemantic, true);
  assert.equal(typeof withSrc.chapters[0]!.语义警报数, 'number');
  const direct = acceptanceV2({
    tiers: { A: MD.A, B: MD.B },
    source: new Map([
      ['P01', MD.SRC.split('\n\n')[0]!.replace('[P01] ', '')],
      ['P02', MD.SRC.split('\n\n')[1]!.replace('[P02] ', '')],
    ]),
    known: KNOWN,
    proper: [],
  });
  assert.equal(withSrc.chapters[0]!.语义警报数, direct.semantic.length, '有源稿时语义计数也=直算');
});

test('1c：判读与卡片——健康/违规两向、倒挂行带 data-path 可跳、未算行在场', () => {
  /* 健康章需三层齐且 B<M<A（引擎语义：排序判定要求三层都在）：A 两生造词、M 一个、B 零 */
  const healthy = mk([
    ['第一章', 'A', '/b/a.md', '[P01] the old man kept a light on the rock for 3 years.\n\n[P02] the flarn and the zorb moved below the cold sea.'],
    ['第一章', 'M', '/b/m.md', '[P01] the old man kept a light on the rock.\n\n[P02] the flarn moved below the cold sea.'],
    ['第一章', 'B', '/b/b.md', '[P01] the old man kept a light on the rock.\n\n[P02] the cold sea moved below the door.'],
  ]);
  const hv = crossTierVerdict(crossTierOf(healthy, { known: KNOWN }));
  assert.match(hv, /层间健康|通过/, '全绿的书要说健康');

  const violating = mk([
    ['第一章', 'A', '/b/a.md', MD.A],
    ['第一章', 'B', '/b/b.md', MD.B],
    ['第二章', 'A', '/b/2a.md', MD.A2],
  ]);
  const r = crossTierOf(violating, { known: KNOWN });
  const verdict = crossTierVerdict(r);
  assert.match(verdict, /倒挂 \d+ 段/, '违规书点名倒挂段总数');
  assert.match(verdict, /第一章/, '点名最多倒挂的章');
  const line = crossTierChapterLine(r.chapters[0]!);
  assert.match(line, /第一章：生词率 A/);
  assert.match(line, /注密度 \d(\.\d)?\/[—\d.]+\/\d(\.\d)?/);
  const html = crossTierCardHtml(r, false);
  assert.match(html, /data-path="\/b\/b\.md"/, '倒挂行带 B 层产物路径（跳转接线）');
  assert.match(html, /data-seg="P02"/);
  assert.match(html, /未算 1 章：第二章（缺 B/, '未算章在卡片上点名');
  assert.match(html, /dp-crosstier-run/, '重新体检按钮在');
  assert.match(crossTierCardHtml(null, false), /体检这本书/, '无报告占位卡带运行按钮');
  assert.match(crossTierCardHtml(null, true), /扫描中/, '运行中占位');
});

test('1d：纪律扫描——crosstier.ts 不许本地复刻判定（只准 import core/acceptance）', () => {
  const body = readFileSync(join(REPO, 'app/src/crosstier.ts'), 'utf-8');
  assert.equal(/[)\w]\s*\*\s*1\.15\b|1\.15\s*\*\s*[\w(]/u.test(body), false, '本地复刻 1.15 容差算术（判容忍度只准走引擎）');
  assert.equal(/function\s+(cleanForAcceptance|makeIsUnknown|annoTypesOf|unnotedTokensOf|sentLensOfSegs|semanticSuspectsOf)\s*\(/u.test(body), false, '本地复刻判定函数');
  assert.equal(/(?:const|let)\s+IRREG\s*[=:]/u.test(body), false, '本地复刻不规则形表');
  assert.match(body, /from '\.\.\/\.\.\/src\/core\/acceptance\.js'/, '必须 runtime-import 唯一实现');
  // 判读纪律：verdict/line 不许重算比值，只消费报告字段（形状锁：不得出现 avgB/avgA 除法或乘容差）
  assert.equal(/\bavgB\s*\/\s*avgA\b|\bratio\s*\*/u.test(body), false, '判读不许重算或复用比值做算术');
});
