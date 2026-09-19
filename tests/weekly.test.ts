/**
 * 本周复现清单（功能四项 · 项 3）· 测试
 *
 * 3b：pickQuizWords——到期优先带标注、不足补队列、cap 截断、无队列由调用方回退。
 * 3c：weeklyCardHtml 三分支（无队列引导/无到期/清单）+ CSV 定位（字典序最新）+ 解析宽容。
 * 3d：教师端 only 纪律扫描——新代码不出现打卡/提醒/推送词形；FSRS 只准 import core/fsrs。
 * （weeklyDue 本体在 tests/cefr_fsrs.test.ts 3a 两例；CLI 行为零变化由该文件既有用例守。）
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { weeklyDue } from '../src/core/fsrs.js';
import { latestReinforceFile, parseReinforceCsv, pickQuizWords, weeklyCardHtml } from '../app/src/weekly.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TODAY = new Date('2026-09-19T00:00:00Z');

test('3c：parseReinforceCsv 宽容口径——词,hits / 纯词行 / 注释 / 坏 hits 归 0 / BOM', () => {
  const rows = parseReinforceCsv('\uFEFF# 复现队列：词,hits\ndog,3\ncat\n# 注释\nbird,abc\nfish,-2\nsheep;4\n');
  assert.deepEqual(
    rows.map((r) => `${r.word}:${r.hits}`),
    ['dog:3', 'cat:0', 'bird:0', 'fish:0', 'sheep:4'],
  );
});

test('3c：latestReinforceFile——多个日期文件取字典序最新；没有返回 null', () => {
  assert.equal(latestReinforceFile(['复现队列_2026-09-10.csv', '复现队列_2026-09-18.csv', '生词卡_Anki_2026-09-18.csv']), '复现队列_2026-09-18.csv');
  assert.equal(latestReinforceFile(['生词卡_Anki_2026-09-18.csv', '别的.md']), null);
  assert.equal(latestReinforceFile([]), null);
});

test('3b：pickQuizWords——到期词优先且带"（本周到期，优先入题）"、不足补队列、cap 截断、到期补齐不重复', () => {
  const due = weeklyDue(
    [
      { word: 'dog', hits: 0 },
      { word: 'cat', hits: 0 },
    ],
    { today: TODAY },
  );
  const r = pickQuizWords(due, ['dog', 'fox', 'owl'], 30);
  assert.equal(r!.dueCount, 2);
  assert.match(r!.words, /^cat（本周到期，优先入题）, dog（本周到期，优先入题）/, '到期词按 due 顺序（同日字母序）');
  assert.match(r!.words, /, fox, owl$/, '不足 30 用队列词补齐（dog 已在到期里不重复）');
  const capped = pickQuizWords(due, ['a', 'b', 'c'], 3);
  assert.equal(capped!.words.split(', ').length, 3, 'cap 截断');
});

test('3c：weeklyCardHtml 三分支——无队列给"去导出生词卡"引导而非报错；无到期=下周再看；清单=到期数+试点口径', () => {
  assert.match(weeklyCardHtml(null, false), /还没有 复现队列/, '无队列引导');
  assert.match(weeklyCardHtml(null, false), /导出生词卡/);
  assert.match(weeklyCardHtml(null, false), /dp-weekly-run/);
  assert.match(weeklyCardHtml({ queuePath: '/b/复现队列_2026-09-18.csv', queue: ['dog', 'cat'], due: [] }, false), /本周没有到期词——下周再看/);
  const due = weeklyDue([{ word: 'dog', hits: 0 }], { today: TODAY });
  const html = weeklyCardHtml({ queuePath: '/b/复现队列_2026-09-18.csv', queue: ['dog'], due }, false);
  assert.match(html, /1 词本周到期/);
  assert.match(html, /词汇题将优先用它们/);
  assert.match(html, /FSRS 建议隔 \d+ 篇（试点参考），现行固定隔 2 篇/, '并行试点口径两列并排');
  assert.match(html, /09-20/, '到期日进 chip');
  assert.match(weeklyCardHtml(null, true), /读取复现队列中/);
});

test('3d：教师端 only 纪律扫描——weekly/bookcards 不许出现打卡/提醒/推送词形；FSRS 只准 import core/fsrs', () => {
  for (const f of ['app/src/weekly.ts', 'app/src/bookcards.ts']) {
    const body = readFileSync(join(REPO, f), 'utf-8');
    assert.equal(/打卡|提醒|notify|reminder|推送|push\s*notification/i.test(body), false, `${f}：教师端 only——不许出现打卡/提醒/推送词形`);
    assert.equal(/createEmptyCard|generatorParameters|new\s+Date\([^)]*\)\s*\)\s*\[\s*rating/.test(body), false, `${f}：不许本地复刻 FSRS 模拟`);
  }
  const w = readFileSync(join(REPO, 'app/src/weekly.ts'), 'utf-8');
  assert.match(w, /from '\.\.\/\.\.\/src\/core\/fsrs\.js'/, 'FSRS 唯一实现从 core/fsrs import');
});
