/**
 * 句级修改三件（拆分/句单元/拼回）+ 句级四闸 + 教材已学词口径 回归测试
 *
 * 锁的是 2026-10-05 定案（原实现 68a9bd2 随迁移事故丢失，2026-10-24 按定案重写）：
 *   ① 拼回按拆分序号定位、**同文句不误替换**——agent 不做字符串手术；
 *   ② 句级四闸与段级回炉同一把尺（红词不增必减/句长·引语豁免/注释不丢/保真）；
 *   ③ 教材口径：之前的册全册计入、当前册未标单元不计入、exposure≠acquisition 红线。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { lexiconFromWords } from '../src/core/lexicon.js';
import { editSentenceInSegment, redWordsOf, roundtripUnits, sentenceEditGates, spliceSentence, splitSentUnits } from '../src/core/sentunit.js';
import { textbookProgress, type TextbookUnitsData } from '../src/core/textbookvocab.js';
import { toolSentenceEdit, toolTextbookVocab, buildOverriddenLexicon, vocabFingerprint } from '../src/core/mcpTools.js';

const lex = lexiconFromWords(['the', 'dog', 'ran', 'fast', 'cat', 'slept', 'he', 'had', 'apples', 'big', 'said', 'and', 'again']);

const SEG = '[P03] The dog ran fast. The cat slept. The dog ran fast.';

test('拆句：S1…Sn 编号、区间落在原串上、重拼逐字节一致', () => {
  const units = splitSentUnits(SEG);
  assert.deepEqual(
    units.map((u) => u.id),
    ['S1', 'S2', 'S3'],
  );
  for (const u of units) assert.equal(SEG.slice(u.start, u.end), u.text);
  assert.ok(units[0]!.text.startsWith('The dog'));
  assert.equal(units[0]!.start, SEG.indexOf('The dog')); // [P03] 标记不在任何句里
  assert.ok(roundtripUnits(SEG));
  assert.ok(roundtripUnits('[P07] One. Two words. He said "Go home now!" Three.'));
  assert.ok(roundtripUnits(''));
});

test('拼回铁律：同段同文句只改指定的那句（S1 与 S3 文本相同）', () => {
  const out = spliceSentence(SEG, 'S3', 'The dog jumped.');
  assert.ok(out.includes('The dog ran fast.'), 'S1 必须原样');
  assert.ok(out.includes('The dog jumped.'));
  assert.ok(out.includes('The cat slept.'));
  assert.equal(out.match(/The dog ran fast\./g)!.length, 1);
  const out2 = spliceSentence(SEG, 'S1', 'The dog jumped.');
  assert.ok(out2.endsWith('The dog ran fast.'), 'S3 必须原样');
  assert.throws(() => spliceSentence(SEG, 'S9', 'x'), /没有句单元/);
  assert.throws(() => spliceSentence(SEG, 'S1', '  '), /revised 不能为空/);
});

test('红词（唯一实现）：注释过的词不算、词形家族按词库、明细分词', () => {
  const r = redWordsOf('The burly dog（狗） ran fast. The writhing cat ran.', lex);
  assert.equal(r.count, 2); // burly + writhing；dog 注释过、ran 词形命中
  assert.deepEqual(r.words, ['burly', 'writhing']);
});

test('句级四闸：全绿（红词严格减少 + 信号保留 + 句长在限内）', () => {
  const r = sentenceEditGates({ before: 'The burly dog ran fast.', revised: 'The big dog ran fast.', maxLen: 16, lex });
  assert.equal(r.pass, true);
  assert.equal(r.measured.redBefore, 1);
  assert.equal(r.measured.redAfter, 0);
});

test('句级四闸：四类拒绝各红各的', () => {
  const cases: [string, ReturnType<typeof sentenceEditGates>, string][] = [
    ['红词不减（1→1）', sentenceEditGates({ before: 'The burly dog ran fast.', revised: 'The burly cat ran fast.', maxLen: 16, lex }), '红词不增必减'],
    ['红词新增（0→1）', sentenceEditGates({ before: 'The dog ran fast.', revised: 'The writhing dog ran fast.', maxLen: 16, lex }), '红词不增必减'],
    ['句长超线', sentenceEditGates({ before: 'The dog ran fast.', revised: 'The dog ran very very very very very very very fast in the morning.', maxLen: 10, lex }), '句长上限'],
    ['注释丢失', sentenceEditGates({ before: 'The dog（狗） ran fast.', revised: 'The dog ran fast.', maxLen: 16, lex }), '注释不丢'],
    ['保真（three 丢了）', sentenceEditGates({ before: 'He had three apples.', revised: 'He had apples.', maxLen: 16, lex }), '保真'],
  ];
  for (const [name, r, gate] of cases) {
    assert.equal(r.pass, false, name);
    assert.ok(
      r.failures.some((f) => f.gate === gate),
      `${name} 应红 ${gate}`,
    );
  }
});

test('句长闸：直接引语豁免（整句引语内的长句不拦）', () => {
  const long = '"I will never ever stop running away from that big angry cat in the garden."';
  const r = sentenceEditGates({ before: 'He said "Go!"', revised: `He said ${long}`, maxLen: 10, lex });
  assert.ok(!r.failures.some((f) => f.gate === '句长上限'), '引语内长句豁免');
});

test('双形态·看靶：units 带词数/红词/超长标记', () => {
  const r = editSentenceInSegment({ segment_md: '[P03] The burly dog ran fast. The cat slept.', maxLen: 8, lex });
  const u1 = r.units!.find((u) => u.id === 'S1')!;
  assert.equal(u1.redCount, 1);
  assert.deepEqual(u1.redWords, ['burly']);
  assert.equal(u1.overlong, false); // 5 词 ≤ 8
  const u2 = r.units!.find((u) => u.id === 'S2')!;
  assert.equal(u2.redCount, 0);
});

test('双形态·修改：双闸全绿，拼回整段一次返回', () => {
  const r = editSentenceInSegment({ segment_md: SEG, sentence_id: 'S1', revised: 'The big dog ran fast.', maxLen: 16, lex });
  assert.equal(r.pass, true);
  assert.ok(r.spliced!.startsWith('[P03] The big dog ran fast.'));
  assert.equal(r.sentenceGates!.pass, true);
  assert.equal(r.segmentGates!.pass, true);
});

test('双形态·修改：句级绿但段级红（段长比出带）照样不许落盘', () => {
  const seg = '[P04] ' + 'The dog ran fast. '.repeat(5).trim(); // 25 词段
  const revised = 'The dog ran fast and the dog ran fast and the dog ran fast again.'; // 4→15 词，段比 25→36=1.44 出带
  const r = editSentenceInSegment({ segment_md: seg, sentence_id: 'S1', revised, maxLen: 16, lex });
  assert.equal(r.sentenceGates!.pass, true, '单句本身没问题（红词零增减、句长在限内）');
  assert.equal(r.pass, false, '段级闸必须能一票否决');
  assert.ok(r.segmentGates!.failures.some((f) => f.gate === '段长比'));
});

test('MCP 包装：错误进 error 字段不抛（工具契约）', () => {
  assert.equal((toolSentenceEdit({ segment_md: 'x', sentence_id: 'S9', revised: 'y', max_len: 16 }, lex) as { error: string }).error !== undefined, true);
  assert.equal((toolSentenceEdit({ segment_md: '', max_len: 16 }, lex) as { error: string }).error !== undefined, true);
  const list = toolSentenceEdit({ segment_md: SEG, max_len: 16 }, lex) as { units: unknown[]; 形态: string };
  assert.equal(list.units.length, 3);
  assert.ok(list.形态.includes('看靶'));
});

test('词库覆盖：vocab_csv_content 叠加基础词库改判定口径 + 指纹自述', () => {
  // 词库 CSV 格式与教师词库同款：表头「词,类型」，类型=单词/课标词/待定词 才入账
  const csv = '词,类型\nburly,单词\nwrithing,课标词\n';
  const baseOpts = { plainWordlistTexts: ['the\ndog'] };
  const base = buildOverriddenLexicon(baseOpts, []);
  const over = buildOverriddenLexicon(baseOpts, [], { vocabCsvTexts: [csv] });
  assert.equal(redWordsOf('The burly dog.', base).count, 1);
  assert.equal(redWordsOf('The burly dog.', over).count, 0, '覆盖后 burly 不再是红词（the/dog 来自基础词库，叠加不替换）');
  const fp = vocabFingerprint({ vocabCsvTexts: [csv] });
  assert.ok(String(fp!.口径).includes('sha8:'));
  assert.equal(vocabFingerprint(undefined), undefined);
});

/* ───────────────── 教材已学词口径 ───────────────── */

const UNITS: TextbookUnitsData = {
  base: ['the', 'a', 'is'],
  books: {
    七上: { U1: { 词: ['name', 'what'], 语法: ['be 动词'] }, U2: { 词: ['this', 'family'], 语法: [] } },
    八上: { U1: { 词: ['windmill'], 语法: ['一般过去时'] }, U2: { 词: ['already', 'yet', 'still'], 语法: ['现在完成时'] }, '（未标单元）': { 词: ['mystery'], 语法: [] } },
  },
};

test('教材口径：at=八上:U2 → 基础层+七上全册+八上U1/U2；当前册未标单元不计入', () => {
  const r = textbookProgress({ data: UNITS, at: '八上:U2' });
  const w = new Set(r.learnedWords);
  for (const x of ['the', 'name', 'this', 'windmill', 'already']) assert.ok(w.has(x), `${x} 应已学`);
  assert.ok(!w.has('mystery'), '八上未标单元不计入（本册未学完）');
  assert.deepEqual(r.coveredBooks, ['七上', '八上']);
  assert.deepEqual(r.missingBooks, ['七下', '八下', '九上', '九下']);
  assert.ok(
    r.detail.some((d) => d.includes('课标基础层')),
    '基础层要在明细里列行（2026-09-10 修复）',
  );
  assert.ok(r.口径.includes('八上:U2'));
});

test('教材口径：half=当前单元取前半词、语法标注未讲完', () => {
  const r = textbookProgress({ data: UNITS, at: '八上:U2', half: true });
  const w = new Set(r.learnedWords);
  assert.ok(w.has('already'), '3 词取前半（ceil(3/2)=2）含 already');
  assert.ok(!w.has('still'), 'still 在后半，不计入');
  assert.ok(
    r.grammars.some((g) => g.includes('学到一半')),
    '半单元语法带标注',
  );
});

test('教材口径：进度之前的册全册计入（含未标单元）；不存在的册如实报错', () => {
  const UNITS2: TextbookUnitsData = {
    ...UNITS,
    books: { ...UNITS.books, 九上: { U1: { 词: ['duty'], 语法: [] } } },
  };
  const r = textbookProgress({ data: UNITS2, at: '九上:U1' });
  const w = new Set(r.learnedWords);
  assert.ok(w.has('mystery'), '八上已学完 → 未标单元也计入');
  assert.ok(w.has('duty'));
  assert.throws(() => textbookProgress({ data: UNITS2, at: '高三:U1' }), /教材库中没有/);
  const t = toolTextbookVocab({ units_json: UNITS2, at: '高三:U1' }) as { error: string };
  assert.ok(t.error.includes('教材库中没有'));
  const ok = toolTextbookVocab({ units_json: UNITS2, at: '八上:U2' }) as { 红线自述: string };
  assert.ok(ok.红线自述.includes('exposure≠acquisition'));
});
