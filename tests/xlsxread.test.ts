/**
 * xlsx 词表读取 · 字节级回归锁（A5 第一步，2026-09-26）
 *
 * 锁的是"夹具字节进 → 标准 CSV 出"——期望值由**当前在用的 xlsx@0.18.5** 冻结。
 * A5 第二步换底层实现（去 npm xlsx 依赖）时本文件一个字不改，全绿即迁移安全；
 * 红了就是新实现的读数与旧实现有语义差（数字格式化/过滤/序），不许改期望迁就实现。
 * 夹具由 tools/make_xlsx_fixtures.mjs 生成（形状：基础+注释+空行 / 表头+数字+多 sheet /
 * 连字符空格重音符中文）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { xlsxFirstColumnToCsv } from '../app/src/xlsxread.js';

const dir = fileURLToPath(new URL('../../tests/fixtures/xlsx/', import.meta.url)); // dist/tests/ → 仓库根
const read = (f: string): Uint8Array => new Uint8Array(readFileSync(`${dir}${f}`));

test('basic：首列全收，空行与 # 注释行被滤，首尾空白被 trim', () => {
  const out = xlsxFirstColumnToCsv(read('basic.xlsx'));
  assert.equal(out, ['abandon', 'battery', 'curious', '1234numeric?'].map((w) => `${w},单词,,,,,,`).join('\n'));
});

test('header_numeric：数字单元格按文本读（raw:false 口径）、第二 sheet 不读', () => {
  const out = xlsxFirstColumnToCsv(read('header_numeric.xlsx'));
  assert.equal(out, ['词', '42', 'decide', 'eager'].map((w) => `${w},单词,,,,,,`).join('\n'));
});

test('edge：连字符/空格短语/重音符原样保留；中文行同样是"首列即词"', () => {
  const out = xlsxFirstColumnToCsv(read('edge.xlsx'));
  assert.equal(out, ['单词', 'self-discipline', 'martial arts', 'naïve', '中文行不该出现？不——首列即词，原样保留'].map((w) => `${w},单词,,,,,,`).join('\n'));
});
