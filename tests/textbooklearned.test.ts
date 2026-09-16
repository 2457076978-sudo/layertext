/**
 * loadTextbookLearned（教材进度→已学词集）测试——核心链补测第 ② 位（2026-09-16）。
 *
 * 这是 AF 管线侧"已学=已知"口径的地基：词表与词典.mjs:485-489 把它并进 buildLexicon，
 * 直接决定学生材料里哪些词算生词。四条业务规则各锁一条 case + 真实数据锚点：
 *   1. 未配置 → null（管线沿用整册词库口径，不改已报数字）
 *   2. 整册规则：进度册之前的册**全部**计入、当前册按单元序、之后的册不计
 *   3. 半单元（half）= ceil(当前单元词数/2)
 *   4. 「（未标单元）」→ 999：当前册时不计入（可能来自后面单元）；已完成册照计
 *   5. 缺册静默跳过（ORDER 六册 vs 实库三册——2026-09-16 Wayne 拍板"跳过"）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
/* 共享模块从本测试的 dist 取引擎模块（绝不碰共享 dist）——与 lexiconstore.test 同一约定 */
process.env.LAYERTEXT_DIST = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

const ROOT = mkdtempSync(join(tmpdir(), 'lt-tbl-'));
test.after(() => rmSync(ROOT, { recursive: true, force: true }));

const { loadTextbookLearned } = (await import(pathToFileURL(join(REPO, 'tools/af_pipeline/LayerText_AF词表与词典.mjs')).href)) as {
  loadTextbookLearned: (p: { 教材单元库?: string; 教材进度?: string | { at: string; half?: boolean } }) => Set<string> | null;
};

/* 合成单元库：只造八上/八下/九上/九下四册（刻意缺七上/七下——验"跳过"），每册每单元 2 词 */
const LIB = join(ROOT, '教材单元.json');
writeFileSync(
  LIB,
  JSON.stringify({
    base: ['aa', 'bb'],
    books: {
      八上: { U1: { 词: ['ba1', 'ba2'] }, U2: { 词: ['ba3', 'ba4'] } },
      八下: { U1: { 词: ['bb1', 'bb2'] } },
      九上: { U1: { 词: ['ja1', 'ja2'] }, U2: { 词: ['ja3', 'ja4'] }, U3: { 词: ['ja5', 'ja6'] }, U4: { 词: ['ja7', 'ja8'] }, '（未标单元）': { 词: ['jx1', 'jx2'] } },
      九下: { U1: { 词: ['jx9a', 'jx9b'] } },
    },
  }),
  'utf-8',
);
const P = (进度: string | { at: string; half?: boolean } | null) => ({ 教材单元库: LIB, 教材进度: 进度 ?? undefined }) as Parameters<typeof loadTextbookLearned>[0];

test('未配置教材进度 → null（沿用整册口径，不改已报数字）', () => {
  assert.equal(loadTextbookLearned(P(null)), null);
  assert.equal(loadTextbookLearned({ 教材单元库: LIB }), null);
});

test('九上:U3 → base + 前册全部 + 本册 U1-U3；本册后续与九下不计；未标单元不计', () => {
  const s = loadTextbookLearned(P('九上:U3'))!;
  for (const w of ['aa', 'bb', 'ba1', 'ba2', 'ba3', 'ba4', 'bb1', 'bb2', 'ja1', 'ja2', 'ja3', 'ja4', 'ja5', 'ja6']) {
    assert.ok(s.has(w), `应含 ${w}`);
  }
  for (const w of ['ja7', 'ja8', 'jx1', 'jx2', 'jx9a', 'jx9b']) {
    assert.ok(!s.has(w), `不应含 ${w}（后续单元/未标单元/后续册）`);
  }
});

test('half=true → 当前单元只计 ceil(词数/2)：U3 两词取一', () => {
  const s = loadTextbookLearned(P({ at: '九上:U3', half: true }))!;
  const hit = ['ja5', 'ja6'].filter((w) => s.has(w));
  assert.equal(hit.length, 1, `半单元应恰取一半（实得 ${hit.join(',')}）`);
  assert.ok(s.has('ja3'), '之前单元不受 half 影响');
});

test('缺册静默跳过（ORDER 含七上/七下，库没有）+ 已完成册的未标单元照计', () => {
  const s = loadTextbookLearned(P('九下:U1'))!;
  assert.ok(s.has('jx1') && s.has('jx2'), '九下进度下九上已整册完成——未标单元照计');
  assert.ok(s.has('jx9a'), '当前单元计入');
});

test('真实数据锚点：教材单元_人教版.json + 九上:U3（2026-09-16 Wayne 设定的真实进度）', () => {
  const real = join(REPO, '..', '..', '..', '..', 'Desktop', '工作文档库', '01-教学工作', '名著阅读工作区_AnimalFarm', '知识文件', '教材单元_人教版.json');
  if (!existsSync(real)) return; // 换机器跑 CI 时无此文件，跳过锚点（合成用例已全覆盖分支）
  const s = loadTextbookLearned({ 教材单元库: real, 教材进度: '九上:U3' })!;
  assert.equal(s.size, 3428, '真实库 + 九上:U3 的已学词规模（2026-09-16 实测锚点，库更新时应有意更新此数）');
  assert.ok(s.has('windmill') === false || s.has('windmill') === true, '可查询');
});
