/**
 * 章号与章节名 · 测试
 *
 * 验收（《LayerText 工程优化总计划》阶段 3）：
 *   「**第二本书只需新建 manifest，不复制脚本**。」
 *
 * 这一组用例盯的是一个**写死在 10 个脚本里**的东西：
 *   `const CN = ['一','二',…,'十']` 然后 `第${CN[i-1]}章`。
 * 它写死了"十章"。换一本 12 章的书，`CN[10]` 是 `undefined`，
 * `第undefined章` 会一路拼进路径和报表，而脚本照常报成功——
 * 又一个"换本书才炸"的坑，而且炸得很安静。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chapterNameOf, chapterNamesFrom, chapterNumberOf, chineseNumeralToInt, resolveChapterNames } from '../src/core/chapters.js';

/* ────────────────────── ① 中文章号 ────────────────────── */

test('中文章号 → 整数：一~十、十一~十九、二十~九十九都对', () => {
  const cases: [string, number][] = [
    ['一', 1],
    ['二', 2],
    ['九', 9],
    ['十', 10],
    ['十一', 11],
    ['十二', 12],
    ['十九', 19],
    ['二十', 20],
    ['二十一', 21],
    ['三十五', 35],
    ['九十九', 99],
    ['两', 2],
  ];
  for (const [s, n] of cases) assert.equal(chineseNumeralToInt(s), n, `${s} 应为 ${n}`);
});

test('★ 解析不出来就返回 null，**不猜**（"第一幕"不是第一章）', () => {
  for (const bad of ['', '  ', '零', '一百', '十十', '二十十', 'abc', '第', '1']) {
    assert.equal(chineseNumeralToInt(bad), null, `「${bad}」不该被解析成一个章号`);
  }
});

test('整数 → 中文章号：往返一致（1..99）', () => {
  for (let n = 1; n <= 99; n++) {
    const s = chapterNameOf(n);
    assert.ok(s, `${n} 应当能写出中文章号`);
    assert.equal(chineseNumeralToInt(s!), n, `${n} → ${s} → 应当回到 ${n}`);
  }
  assert.equal(chapterNameOf(0), null);
  assert.equal(chapterNameOf(100), null);
  assert.equal(chapterNameOf(1.5), null);
});

test('章节名形状收得很窄：`第一幕`/`第3节` 不算章', () => {
  assert.equal(chapterNumberOf('第一章'), 1);
  assert.equal(chapterNumberOf('第1章'), 1);
  assert.equal(chapterNumberOf('第十二章'), 12);
  for (const notChapter of ['第一幕', '第3节', '第一章 ', '序章', 'Chapter One']) {
    if (notChapter === '第一章 ') assert.equal(chapterNumberOf(notChapter), 1, '首尾空白要容忍');
    else assert.equal(chapterNumberOf(notChapter), null, `「${notChapter}」不该被当成章`);
  }
});

/* ────────────────────── ② ★ 排序：不许按字典序 ────────────────────── */

test('★ 按章号排序，不是按字典序（字典序会把"第十章"排到第二位）', () => {
  const entries = ['第十章', '第一章', '第三章', '第九章', '第二章', '第五章', '第八章', '第六章', '第四章', '第七章'];
  const got = chapterNamesFrom(entries);
  assert.deepEqual(got, ['第一章', '第二章', '第三章', '第四章', '第五章', '第六章', '第七章', '第八章', '第九章', '第十章']);
  // 对照：字典序确实会乱
  assert.notDeepEqual([...entries].sort(), got, '如果这里相等，说明用例没测到真问题');
});

test('排序覆盖 12 章（**写死十章的旧代码在这里就断了**）', () => {
  const entries = Array.from({ length: 12 }, (_, i) => `第${chapterNameOf(i + 1)}章`);
  assert.deepEqual(chapterNamesFrom([...entries].reverse()), entries);
  assert.equal(entries[11], '第十二章');
});

test('目录里混着别的东西时只认章节名，重复的章号只算一次', () => {
  const got = chapterNamesFrom(['第一章', 'README.md', '第一章', '第二章', '_备份', '.DS_Store']);
  assert.deepEqual(got, ['第一章', '第二章']);
});

/* ────────────────────── ③ ★ 三个来源的优先级 ────────────────────── */

test('★ 显式配置优先：写了什么就是什么（可以做非"第X章"的书）', () => {
  const r = resolveChapterNames({ configured: ['Prologue', 'Chapter One', 'Chapter Two'], dirEntries: ['第一章', '第二章'] });
  assert.deepEqual(r.names, ['Prologue', 'Chapter One', 'Chapter Two']);
  assert.equal(r.source, '配置');
  assert.deepEqual(r.warnings, []);
});

test('配置里写数字也认（[1,2,3] → 第一章…第三章）', () => {
  const r = resolveChapterNames({ configured: [1, 2, 3] });
  assert.deepEqual(r.names, ['第一章', '第二章', '第三章']);
  assert.equal(r.source, '配置');
});

test('★ 没配置就从**原文目录**推——目录里真有什么章就是什么章', () => {
  const r = resolveChapterNames({ dirEntries: ['第十章', '第一章', '第二章'] });
  assert.deepEqual(r.names, ['第一章', '第二章', '第十章']);
  assert.equal(r.source, '原文目录');
});

test('★ 两处都没有才退回旧行为，且**逐字符复现**（老项目一个字都不变）', () => {
  const r = resolveChapterNames({ count: 10 });
  assert.deepEqual(r.names, ['第一章', '第二章', '第三章', '第四章', '第五章', '第六章', '第七章', '第八章', '第九章', '第十章']);
  assert.equal(r.source, '默认（第N章 × 章数）');
  const three = resolveChapterNames({ count: 3 });
  assert.deepEqual(three.names, ['第一章', '第二章', '第三章']);
});

/* ────────────────────── ④ 如实报告，不静默 ────────────────────── */

test('★ 目录里的章号不连续时必须说出来（"第 5 章不见了"≠"这本书只有 X 章"）', () => {
  const r = resolveChapterNames({ dirEntries: ['第一章', '第二章', '第四章'] });
  assert.deepEqual(r.names, ['第一章', '第二章', '第四章'], '按实际存在的章继续');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!, /不连续/);
  assert.match(r.warnings[0]!, /第三章/, '要点名缺的是哪一章');
});

test('★ 目录里一个章节名都扫不出来时要说出来，而不是悄悄退回默认', () => {
  const r = resolveChapterNames({ dirEntries: ['foo.md', 'bar', '第1节'], count: 2 });
  assert.deepEqual(r.names, ['第一章', '第二章']);
  assert.equal(r.warnings.some((w) => /没有一个像章节名/.test(w)), true, `实得 ${JSON.stringify(r.warnings)}`);
});

test('配置是空数组 / 全是垃圾时不当作"配置了"，而是退回下一层并说明', () => {
  const empty = resolveChapterNames({ configured: [], dirEntries: ['第一章'] });
  assert.equal(empty.source, '原文目录', '空配置应当被当成"没有配置"');
  assert.match(empty.warnings.join(' '), /空的/);

  const junk = resolveChapterNames({ configured: [{}, null], dirEntries: ['第一章'] });
  assert.equal(junk.source, '原文目录');
  assert.match(junk.warnings.join(' '), /不合法/);
});

test('章数非法时退回 10（旧行为），不抛也不给空清单', () => {
  for (const bad of [0, -3, NaN, undefined]) {
    const r = resolveChapterNames({ count: bad as number | undefined });
    assert.equal(r.names.length, 10, `count=${String(bad)} 应退回 10 章`);
  }
});
