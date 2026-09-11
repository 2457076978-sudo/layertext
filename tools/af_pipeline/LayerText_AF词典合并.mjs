#!/usr/bin/env node
/** AF 词典合并：把各运行私有的词典增量并进共享词典
 *
 * 审查报告 §三：「第二本书、第二位教师或同一书多层并行时，输出路径、会话日志、
 * **统一词典**和标记文件可能互相覆盖」。统一词典是这些文件里唯一一个被所有运行共享
 * 且会被写的——原先 `appendDict` 是「读整份 → 合并 → 写回整份」，两个进程同时跑
 * 后写的会把先写的整份盖掉（lost update），表现是"明明配过的词下次又问一遍"，且不报错。
 *
 * 现在：生成阶段只写运行私有的增量（`产物目录/_运行/<runId>/词典增量.json`），
 * 合并是**显式的一步**——原子替换、基线优先、冲突上报、加锁互斥。
 *
 * 用法：
 *   node LayerText_AF词典合并.mjs --tier A          # 合并（加锁 + 原子替换）
 *   node LayerText_AF词典合并.mjs --dry             # 只看会合并什么，不写
 *
 * 产物：直接更新项目配置里的 书级.词典（唯一正本）。
 */
import { readFileSync, existsSync } from 'node:fs';

const SHARED = await import('./LayerText_AF词表与词典.mjs');
const { distOf } = SHARED;
const P = SHARED.loadProject();

const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const { parseDictCsv, mergeDict, describeMerge } = await import(`${distOf(P.引擎目录)}/src/core/dictmerge.js`);

// 增量扫描与合并共用同一份实现（两种布局都要认），别处不要再写第二遍
const found = SHARED.findDictDeltas(P.产物目录);
const deltas = found.filter((d) => !d.bad);
for (const b of found.filter((d) => d.bad)) console.warn(`⚠ 坏增量（跳过）：${b.file}`);

console.log('════ AF 词典合并 ════');
console.log(`词典：${P.词典路径}`);
console.log(`增量：${deltas.length} 份${deltas.length ? `（${deltas.map((d) => d.origin).join('、')}）` : ''}`);
if (!deltas.length) {
  console.log('\n没有增量要合并——生成阶段没配过新释义，或已经合并过了。');
  process.exit(0);
}

const base = existsSync(P.词典路径) ? parseDictCsv(readFileSync(P.词典路径, 'utf-8')) : [];
const merged = mergeDict(base, deltas);
for (const line of describeMerge(merged)) console.log(`  ${line}`);

if (has('--dry')) {
  console.log('\n（--dry，未写词典）');
  process.exit(0);
}

const r = await SHARED.withLock(`${P.词典路径}.lock`, () => SHARED.mergeDictIntoProject(P));
console.log(`\n✓ 已合并：新增 ${r.added}｜无变化 ${r.unchanged}｜基线冲突 ${r.conflicts}｜增量互冲突 ${r.interConflicts}`);
if (r.conflicts || r.interConflicts) {
  console.warn('  冲突已上报、未静默择一：基线（教师定过的释义）优先，增量互冲突的等人工定。');
}
console.log(`  → ${P.词典路径}`);
