/**
 * 跨章词画卷引擎（src/core/concordance.ts）——规划项 1 验收 1a–1f。
 * 设计定案对应：归并走 hitOrigin 唯一实现（1b 静态扫描）、词表外不归并（1c）、
 * 画卷是视图（纯函数零 IO）、句首大写不算专名候选（align 同口径）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { annotationDebt, attachOrigin, buildConcordance, propagationPreview, properSuspects, wordChapterMatrix, type ConcordanceChapterInput } from '../src/core/concordance.js';

/* 归并对用 dogs→dog（s-strip，引擎真支持的口径）。f/ves 复数（wolves/leaves）现口径不归并——
 * IRR_NOUN 未收，动它=动全局判定链，不属本计划（如实记录边界）。 */
const KNOWN = new Set(['the', 'a', 'and', 'of', 'to', 'in', 'farm', 'dog', 'animals', 'worked', 'hard', 'ran', 'home', 'chapter', 'is', 'was']);

const CH: ConcordanceChapterInput[] = [
  {
    name: '一',
    tiers: {
      A: '[P01] The dog ran home.\n\n[P02] Animals worked hard.',
      M: '[P01] The dogs（狗） ran home fast.',
    },
  },
  {
    name: '二',
    tiers: {
      A: '[P03] A dog slept. Pinchfield was far away.',
      B: '[P03] The farmz grew big. Foxwood was near.',
    },
  },
];

test('1a：词形归并同键（wolf/wolves → wolf），出现记录字段齐、同句同词一行', () => {
  const conc = buildConcordance(CH, { known: KNOWN });
  const occs = conc.get('dog') ?? [];
  // ch一/A/P01 wolf、ch一/M/P01 wolves、ch二/A/P03 wolf = 3 处
  assert.equal(occs.length, 3, JSON.stringify(occs));
  const m1 = occs.find((o) => o.tier === 'M');
  assert.equal(m1?.chapter, '一');
  assert.equal(m1?.segId, 'P01');
  assert.equal(m1?.wordForm, 'dogs');
  assert.equal(m1?.annotated, true, 'dogs（狗） 应识别为已注');
  const a1 = occs.find((o) => o.tier === 'A' && o.chapter === '一');
  assert.equal(a1?.annotated, false, '裸 dog 未注');
  // 同句同词只一行：'ran' 在 ch一 A/M 各一次 → 2 行（不是按 token 翻倍）
  assert.equal((conc.get('ran') ?? []).length, 2);
});

test('1c：词表外词不归并——按表面形独立成键并标 unmerged', () => {
  const conc = buildConcordance(CH, { known: KNOWN });
  const z = conc.get('farmz') ?? [];
  assert.equal(z.length, 1);
  assert.equal(z[0].unmerged, true, '词表外不强行归并（防假归并）');
  const merged = conc.get('dog') ?? [];
  assert.ok(!merged[0].unmerged, '词表内归并不标 unmerged');
});

test('1e：wordChapterMatrix 章分布（复现统计底表，按总数降序）', () => {
  const conc = buildConcordance(CH, { known: KNOWN });
  const m = wordChapterMatrix(conc);
  const hard = m.find((x) => x.baseForm === 'hard');
  assert.deepEqual(hard?.byChapter, { 一: 1 });
  const ran = m.find((x) => x.baseForm === 'ran');
  assert.equal(ran?.total, 2);
  assert.ok(m[0].total >= m[m.length - 1].total, '降序');
});

test('1e：properSuspects——跨章句中大写专名候选命中，句首大写/表内词零误报', () => {
  const conc = buildConcordance(
    [
      ...CH,
      {
        name: '三',
        tiers: { A: '[P01] Pinchfield appeared again. The dogs barked at Pinchfield.' },
      },
    ],
    { known: KNOWN },
  );
  const s = properSuspects(conc, { proper: ['foxwood'], known: KNOWN, minChapters: 2 });
  // Pinchfield：ch二 + ch三 两章、句中非句首大写 → 候选；Foxwood 在专名表 → 排除
  assert.ok(
    s.some((x) => x.word === 'pinchfield'),
    JSON.stringify(s),
  );
  assert.ok(!s.some((x) => x.word === 'foxwood'), '专名表内词不进候选');
  assert.ok(!s.some((x) => x.word === 'the' || x.word === 'animals'), '句首大写/普通词零误报');
  // 单章大写词不进候选（minChapters=2）
  assert.ok(!s.some((x) => x.word === 'chapter'));
});

test('1e+2a：annotationDebt 债务清单 + propagationPreview 全书预览', () => {
  const conc = buildConcordance(CH, { known: KNOWN });
  // dogs 已注（ch一/M），dog 裸奔两处（ch一/A、ch二/A）→ 债务
  const debt = annotationDebt(conc).find((d) => d.baseForm === 'dog');
  assert.equal(debt?.rows.length, 2, JSON.stringify(debt));
  assert.ok(debt!.rows.every((r) => !r.sentence.includes('（狗）')));
  const pv = propagationPreview(conc, 'dog', 'A层85');
  assert.equal(pv.total, 3);
  assert.equal(pv.byTier.M, 1);
  // 当前层='A层85' 无匹配 → 全部 3 处都算"非当前层"；其中未注 2 处
  assert.equal(pv.unannotatedLower.length, 2);
});

test('2e：attachOrigin 按稳定 ID 挂溯源，匹配不上省略（不伪造）', () => {
  const conc = buildConcordance(CH, { known: KNOWN });
  const occs = conc.get('dog') ?? [];
  const marked = attachOrigin(occs, [{ word: 'dog', chapter: '一', tier: 'A', segId: 'P01', origin: 'A层重制·原文85%' }]);
  assert.equal(marked.find((o) => o.chapter === '一' && o.tier === 'A')?.origin, 'A层重制·原文85%');
  assert.equal(marked.find((o) => o.chapter === '二')?.origin, undefined, '无标记不伪造');
  assert.equal(occs.find((o) => o.chapter === '一' && o.tier === 'A')?.origin, undefined, '纯函数不改入参');
});

test('1b：纪律扫描——concordance.ts 不许自写词形还原（归并只准走 hitOrigin）', () => {
  const src = readFileSync(join(process.cwd(), 'src/core/concordance.ts'), 'utf8');
  for (const suffix of ["endsWith('s')", "endsWith('es')", "endsWith('ed')", "endsWith('ing')", "endsWith('ies')", "endsWith('er')", "endsWith('est')"]) {
    assert.ok(!src.includes(suffix), `concordance.ts 出现本地词形还原 ${suffix}——归并必须走 textpipe.hitOrigin`);
  }
  assert.ok(src.includes('hitOrigin'), '必须消费 textpipe.hitOrigin');
  assert.ok(!src.includes("from 'node:fs'") && !src.includes('invoke('), '画卷引擎是纯函数，零 IO');
});

test('1f：性能——合成 10 章×3 层全书重算 < 200ms（性能基线同尺度）', () => {
  const paras = (i: number): string => Array.from({ length: 40 }, (_, p) => `[P${String(p + 1).padStart(2, '0')}] The dogs and farm animals worked hard ${i} ${p}.`).join('\n\n');
  const big: ConcordanceChapterInput[] = Array.from({ length: 10 }, (_, i) => ({
    name: `第${i + 1}章`,
    tiers: { A: paras(i), M: paras(i), B: paras(i) },
  }));
  const t0 = process.hrtime.bigint();
  const conc = buildConcordance(big, { known: KNOWN });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 200, `全书重算 ${ms.toFixed(0)}ms 超过硬阈 200ms`);
  assert.ok((conc.get('dog') ?? []).length >= 10, '合成书确实建出了图');
});

test('1f 补：AF 真项目十章×三层实跑（LAYERTEXT_AF_DIR 有则计时记录，无则 skip 说出口）', { skip: !process.env.LAYERTEXT_AF_DIR }, async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const ws = process.env.LAYERTEXT_AF_DIR!;
  const srcDir = join(ws, '重制三版');
  const chapters: ConcordanceChapterInput[] = [];
  for (const d of readdirSync(srcDir)) {
    if (!/^第.+章$/.test(d)) continue;
    const tiers: Record<string, string> = {};
    for (const f of readdirSync(join(srcDir, d))) {
      const m = f.match(/^原文_(A层85|M层75|B层60)_.*\.md$/);
      if (m && !f.includes('备份')) tiers[m[1]] = readFileSync(join(srcDir, d, f), 'utf-8');
    }
    if (Object.keys(tiers).length) chapters.push({ name: d, tiers });
  }
  if (!chapters.length) return; // 产物目录形态变化时如实不比（existsSync 防御）
  const t0 = process.hrtime.bigint();
  const conc = buildConcordance(chapters, { known: new Set(['the', 'and', 'farm', 'animals']) });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.error(`AF 真文本词画卷重算：${chapters.length} 章 × 3 层，${ms.toFixed(0)}ms（阈值 200ms）`);
  assert.ok(ms < 200, `AF 实测 ${ms.toFixed(0)}ms 超阈`);
  assert.ok(conc.size > 500, '真书确实建出了大图');
});
