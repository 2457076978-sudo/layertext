#!/usr/bin/env node
/** 生成 xlsx 读取回归锁的夹具（A5，2026-09-26；一次性可复跑）。
 * 用**当前在用的** xlsx@0.18.5 写出三份典型教师词表形状——锁的是"这堆字节进、
 * 那份 CSV 出"，与生成器是谁无关；换实现后夹具不动、期望不动，绿了才算迁移安全。 */
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
/* xlsx 装在 app/node_modules（根目录只有类型桩）——用 createRequire 从 app 包解析 */
import { createRequire } from 'node:module';
const appPkg = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'package.json');
const XLSX = createRequire(appPkg)('xlsx');

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'xlsx');
mkdirSync(outDir, { recursive: true });

/* ①基础：纯词表 + 空行 + # 注释行 */
{
  const ws = XLSX.utils.aoa_to_sheet([['abandon'], [], ['# 注释：导入时忽略'], ['battery'], ['   curious   '], ['1234numeric?'], []]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  XLSX.writeFile(wb, join(outDir, 'basic.xlsx'));
}
/* ②表头 + 数字单元格 + 多 sheet（只读第一个） */
{
  const ws = XLSX.utils.aoa_to_sheet([['词'], [42], ['decide'], ['eager']]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '词表');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['不该被读到']]), 'Sheet2');
  XLSX.writeFile(wb, join(outDir, 'header_numeric.xlsx'));
}
/* ③含重音符/连字符/空格词与中文列名 */
{
  const ws = XLSX.utils.aoa_to_sheet([['单词'], ['self-discipline'], ['martial arts'], ['naïve'], ['中文行不该出现？不——首列即词，原样保留']]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'S1');
  XLSX.writeFile(wb, join(outDir, 'edge.xlsx'));
}
console.log('✓ 夹具已生成 →', outDir);
