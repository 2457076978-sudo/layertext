/** AI 边界 #18 / #21 显式测试（枚举表「待验证 P2」收口）：
 *  #18 同句多条建议顺序依赖——每条独立定位，第一条改完后第二条要么重新定位成功、要么落建议页（null），
 *      绝不写错位置；不同句多条正序/倒序应用结果一致。
 *  #21 AI 不按 schema 返回多条变体——revised/original 非单一非空字符串一律拒收（数组/对象/空串）。 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickSingleRewrite, resolveSuggestionTarget, validSuggestionText } from '../app/src/pure.js';

const MD = '## Chapter One\n\n[P01] Old Major was a boar. He lived on the farm. The hen-houses were old.\n';

/** 手工应用一条建议（与 acceptSuggestion 的写入路径同式：定位 → 切片替换） */
function applyOne(md: string, g: { pi?: number; si?: number; original: string; revised: string }): string | null {
  const t = resolveSuggestionTarget(md, g);
  if (!t) return null;
  return md.slice(0, t.at) + g.revised + md.slice(t.at + t.original.length);
}

test('#18 同句两条建议：第一条应用后，第二条定位失败→null（落建议页，不动正文）', () => {
  const g1 = { pi: 0, si: 0, original: 'Old Major was a boar.', revised: 'Old Major was a pig.' };
  const g2 = { pi: 0, si: 0, original: 'Old Major was a boar.', revised: 'Old Major was an old pig.' };
  const md2 = applyOne(MD, g1);
  assert.ok(md2);
  assert.equal(applyOne(md2, g2), null); // 原句已被第一条换掉：第二条独立定位失败，绝不写错位置
  assert.ok(md2.includes('Old Major was a pig.'));
});

test('#18 同句两条建议：第二条的 original 仍在（部分改写）→ 仍能定位', () => {
  const g1 = { pi: 0, si: 2, original: 'The hen-houses were old.', revised: 'The houses were old.' };
  const g2 = { pi: 0, si: 2, original: 'The hen-houses were old.', revised: 'The sheds were old.' };
  const md2 = applyOne(MD, g1);
  assert.ok(md2);
  assert.equal(applyOne(md2, g2), null); // 同句同样失败
  // 反过来：g2 先应用，g1 同样失败——顺序无关，行为一致
  const md2b = applyOne(MD, g2);
  assert.ok(md2b);
  assert.equal(applyOne(md2b, g1), null);
});

test('#18 不同句多条建议：正序与倒序应用，最终正文一致（无位移依赖）', () => {
  const ga = { pi: 0, si: 0, original: 'Old Major was a boar.', revised: 'Old Major was a pig.' };
  const gb = { pi: 0, si: 1, original: 'He lived on the farm.', revised: 'He lived on a farm for years.' };
  const step1 = applyOne(MD, ga);
  const step1b = applyOne(MD, gb);
  assert.ok(step1 && step1b);
  const forward = applyOne(step1, gb);
  const backward = applyOne(step1b, ga);
  assert.ok(forward && backward);
  assert.equal(forward, backward);
});

test('#18 坐标漂移：pi/si 指向的句子已变，original 在别处唯一 → 自动重定位', () => {
  const g = { pi: 5, si: 5, original: 'He lived on the farm.', revised: 'X' };
  const t = resolveSuggestionTarget(MD, g);
  assert.ok(t);
  assert.equal(t.pi, 0);
  assert.equal(t.si, 1);
  assert.ok(t.at > 0);
});

test('#18 连字符形态差：original 写成空格形态 → 宽容匹配命中并回写正文原句切片', () => {
  const t = resolveSuggestionTarget(MD, { original: 'The hen houses were old.' });
  assert.ok(t);
  assert.equal(t.original, 'The hen-houses were old.'); // exact 回写为正文形态
  assert.equal(MD.slice(t.at, t.at + t.original.length), t.original);
});

test('#18 空 original：一律定位失败（防 indexOf("") 落 0 位事故）', () => {
  assert.equal(resolveSuggestionTarget(MD, { original: '' }), null);
  assert.equal(resolveSuggestionTarget(MD, { original: '   ' }), null);
});

test('#21 validSuggestionText：数组/对象/空串/纯空白 = 拒收，非空字符串 = 通过', () => {
  assert.equal(validSuggestionText(['v1', 'v2']), false); // 多条变体
  assert.equal(validSuggestionText({ text: 'v1' }), false); // 字段包装
  assert.equal(validSuggestionText(''), false);
  assert.equal(validSuggestionText('   '), false);
  assert.equal(validSuggestionText(42), false);
  assert.equal(validSuggestionText('A fine sentence.'), true);
});

test('#21 pickSingleRewrite：多条变体拒收（multi），此前会被静默取第一条', () => {
  const r = pickSingleRewrite([
    { original: 'A.', revised: 'B.' },
    { original: 'A.', revised: 'C.' },
  ]);
  assert.deepEqual(r, { ok: false, reason: 'multi' });
});

test('#21 pickSingleRewrite：revised 为数组/对象/空 → bad-shape；合法单条 → 通过', () => {
  assert.deepEqual(pickSingleRewrite([{ original: 'A.', revised: ['B.', 'C.'] }]), { ok: false, reason: 'bad-shape' });
  assert.deepEqual(pickSingleRewrite([{ original: 'A.', revised: { text: 'B.' } }]), { ok: false, reason: 'bad-shape' });
  assert.deepEqual(pickSingleRewrite([{ original: 'A.', revised: '' }]), { ok: false, reason: 'bad-shape' });
  assert.deepEqual(pickSingleRewrite([]), { ok: false, reason: 'empty' });
  assert.deepEqual(pickSingleRewrite([{ original: 'A.', revised: 'B.', basis: '理由', alternative: '备选' }]), {
    ok: true,
    original: 'A.',
    revised: 'B.',
    basis: '理由',
    alternative: '备选',
  });
});

/* ---------- 生词卡导出（Anki + 复现队列）纯逻辑 ---------- */
import { ankiCsv, ankiRowsOf, extractZhNotes, reinforceQueueCsv } from '../app/src/pure.js';

const CH = '## Chapter One\n\n[P01] The boar（野猪） slept. He was cynical about the rules.\n';

test('Anki：正文已有注释放射（word（中文）→ 映射）', () => {
  const notes = extractZhNotes(CH);
  assert.equal(notes['boar'], '野猪');
  assert.equal(Object.keys(notes).length, 1);
});

test('Anki：组装去重、释义优先正文注释>词典>空、例句含该词、出处累记', () => {
  const rows = ankiRowsOf(
    [
      { from: 'ch1.md', md: CH, words: ['boar', 'cynical'] },
      { from: 'ch2.md', md: CH, words: ['boar'] },
    ],
    { boar: '野猪' },
    { cynical: '愤世嫉俗的' },
    (w) => (w === 'boar' ? 'B2' : ''),
  );
  assert.equal(rows.length, 2);
  const boar = rows.find((r) => r.word === 'boar')!;
  assert.equal(boar.zh, '野猪'); // 正文注释优先
  assert.ok(boar.sent.includes('boar'));
  assert.equal(boar.from, 'ch1.md、ch2.md'); // 出处累记
  const cyn = rows.find((r) => r.word === 'cynical')!;
  assert.equal(cyn.zh, '愤世嫉俗的'); // 词典兜底
  assert.equal(cyn.cefr, ''); // cefrOfWord 只给 boar 定级
  const none = ankiRowsOf([{ from: 'c', md: CH, words: ['rules'] }], {}, {}, () => '');
  assert.equal(none[0].zh, ''); // 无释义留空
});

test('Anki：CSV 转义（例句含逗号引号）与复现队列格式（词,hits=0 + # 注释头）', () => {
  const rows = ankiRowsOf([{ from: 'c', md: CH, words: ['boar'] }], { boar: '野猪' }, {}, () => '');
  const csv = ankiCsv(rows);
  assert.ok(csv.startsWith('\ufeff词,CEFR,中文释义,例句,出处\n')); // 首字符 BOM（Excel 中文兼容）
  assert.ok(csv.includes('boar,'));
  const tricky = ankiCsv([{ word: 'x', cefr: '', zh: '', sent: 'He said "run", loudly.', from: 'c' }]);
  assert.ok(tricky.includes('"He said ""run"", loudly."')); // csvCell 转义
  const q = reinforceQueueCsv(rows);
  assert.ok(q.startsWith('# 复现队列'));
  assert.ok(q.includes('boar,0'));
});

/* ---------- 复核角标重排（warns 带句身份）与单句改写回退 ---------- */
import { remapWarns } from '../app/src/pure.js';

test('remapWarns：上方插段后角标跟随原句移位（pi 跟着变）', () => {
  const md1 = '## Chapter One\n\n[P01] A new first line here. Old Major was a boar. He slept.\n';
  const warns = ['0:1|He slept.|超长(18词)'];
  const out = remapWarns(warns, md1);
  assert.equal(out.length, 1);
  assert.ok(out[0].startsWith('0:2|')); // 原句挪到第 3 句，角标跟着走
});

test('remapWarns：原句被删/被改写→角标使命结束（丢弃）；旧格式条目同样丢弃', () => {
  const md1 = '## Chapter One\n\n[P01] Totally different text now.\n';
  assert.deepEqual(remapWarns(['0:0|He slept.|超长'], md1), []); // 句子没了
  assert.deepEqual(remapWarns(['0:0|仅旧格式原因'], md1), []); // 无原句身份，无法重定位
  assert.deepEqual(remapWarns(undefined, md1), []);
});

test('#21 pickSingleRewrite：original 缺省回退到调用方给出的原句（不再整条拒收）', () => {
  const r = pickSingleRewrite([{ revised: 'A fine pig.' }], 'The boar slept.');
  assert.ok(r.ok === true);
  assert.equal(r.original, 'The boar slept.');
  const r2 = pickSingleRewrite([{ revised: 'A fine pig.' }]); // 无回退且无 original → 拒收
  assert.deepEqual(r2, { ok: false, reason: 'bad-shape' });
});

test('Anki CSV 带 BOM（Excel 中文不乱码），复现队列不带（CLI 解析干净）', () => {
  const row = { word: 'boar', cefr: '', zh: '野猪', sent: '', from: 'c' };
  assert.equal(ankiCsv([row]).charCodeAt(0), 0xfeff);
  assert.notEqual(reinforceQueueCsv([row]).charCodeAt(0), 0xfeff);
});

/* ---------- 批改域（学生产出体检）：AI 批改候选裁决 + 批改稿/班级汇总 ---------- */
import { buildClassGradingMd, buildGradingSheetMd, classGradingCsv, parseGradingItems } from '../app/src/pure.js';

const ESSAY = 'I have read the book. The story was interesting. He was seen by the farmer, and it surprised me.';

test('#25 批改候选：type 白名单外/原文定位不到/note 空 = 拒收计数；合法条目（含 comment 无 original）通过', () => {
  const raw = [
    { type: 'grammar', original: 'He was seen', note: '被动语态还没学，建议改主动' },
    { type: 'comment', note: '整体结构清楚，能复现故事主线' },
    { type: 'praise', original: 'interesting', note: '类型不在白名单' },
    { type: 'grammar', original: 'This sentence never existed.', note: '原文定位不到' },
    { type: 'usage', original: 'the book', note: '' },
    { type: 'highlight', original: 'it surprised me', note: '好句', suggestion: 'It surprised me.' },
  ];
  const { ok, rejected } = parseGradingItems(raw, ESSAY);
  assert.equal(rejected, 3);
  assert.equal(ok.length, 3);
  assert.equal(ok[1].type, 'comment');
  assert.equal(ok[1].original, '');
  assert.equal(ok[2].suggestion, 'It surprised me.');
});

test('批改稿组装：批注挂对应段后、comment 进总评、定位不到的列尾不丢', () => {
  const notes = [
    { type: 'comment' as const, original: '', note: '结构完整' },
    { type: 'grammar' as const, original: 'He was seen', note: '被动未学' },
    { type: 'usage' as const, original: 'never anywhere here', note: '定位不到的批注' },
  ];
  const md = buildGradingSheetMd('李明睿', ESSAY, notes, { date: '2026-09-10', vocabNote: '课标1600' });
  assert.ok(md.includes('# 批改稿 · 李明睿'));
  assert.ok(md.includes('## 总评') && md.includes('结构完整'));
  const gPos = md.indexOf('He was seen');
  const nPos = md.indexOf('被动未学');
  assert.ok(gPos >= 0 && nPos > gPos); // 批注在原句所在段之后
  assert.ok(md.includes('## 未定位批注') && md.includes('定位不到的批注')); // 不静默丢弃
});

test('班级批改汇总：md 表 + csv BOM，复现命中列有队列才显示', () => {
  const rows = [
    { name: '甲', words: 100, sents: 10, avgLen: 10, structure: 2, longSents: 1, oovWords: 3, used: 4, queue: 8 },
    { name: '乙', words: 80, sents: 9, avgLen: 8.9, structure: 0, longSents: 0, oovWords: 1, used: 0, queue: 0 },
  ];
  const md = buildClassGradingMd(rows, { date: '2026-09-10', folder: '/tmp/示例班', vocabNote: '课标1600' });
  assert.ok(md.includes('| 甲 | 100 | 10 |') && md.includes('4/8'));
  assert.ok(md.includes('| 乙 |') && md.includes('—'));
  const csv = classGradingCsv(rows);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.ok(csv.includes('学生,词数,句数,平均句长'));
});

/* ---------- 读后检测题：候选裁决 + 试卷组装 ---------- */
import { buildQuizMd, parseQuizItems } from '../app/src/pure.js';

test('#26 检测题裁决：缺题干/选项不足/答案越界/focus 白名单外 = 拒收；合法题通过', () => {
  const raw = [
    { q: 'Why was the farmer surprised?', options: ['A1', 'B1', 'C1', 'D1'], answer: 'B', why: '事实', focus: 'comprehension' },
    { q: '', options: ['a', 'b', 'c', 'd'], answer: 'A', focus: 'inference' },
    { q: '有题干但选项只有两个', options: ['a', 'b'], answer: 'A', focus: 'inference' },
    { q: '答案指向不存在的选项', options: ['a', 'b', 'c'], answer: 'D', focus: 'vocabulary' },
    { q: 'focus 不在白名单', options: ['a', 'b', 'c', 'd'], answer: 'A', focus: 'grammar' },
  ];
  const { ok, rejected } = parseQuizItems(raw);
  assert.equal(rejected, 4);
  assert.equal(ok.length, 1);
  assert.equal(ok[0].answer, 'B');
});

test('检测卷组装：学生卷不带答案，教师答案页含 why 与词汇题标注', () => {
  const items = [
    { q: 'Q1?', options: ['a', 'b', 'c', 'd'], answer: 'A', why: '考因果', focus: 'comprehension' as const },
    { q: 'Word "boar" means?', options: ['猪', '牛', '羊', '马'], answer: 'A', why: '词汇', focus: 'vocabulary' as const },
  ];
  const md = buildQuizMd('第一章', items, { date: '2026-09-10', maxLen: 16 });
  const studentPart = md.slice(0, md.indexOf('## 答案'));
  assert.ok(studentPart.includes('1. Q1?') && !studentPart.includes('—— 考因果'));
  assert.ok(md.includes('## 答案（教师页）') && md.includes('A —— 考因果') && md.includes('（词汇题）'));
});
