/**
 * 校准台账回归测试
 *
 * 验收的是 2026-09-13 查出的那个真事故：
 *   「教师点了确认，换一版产物之后校准就不见了」——
 *   根因是标记按**文件名**落盘（`_审校标记.json`），而管线每次重新生成都换文件名。
 *
 * 所以这里逐条钉死：
 *   1. 事件锚在 书/章/层/词，**不含文件名**——换版本照样重放得回来；
 *   2. `remove` 能撤销，且折叠结果与事件顺序无关（重放必须可复现）；
 *   3. 找不到锚的事件**如实进 unmatched**，不许静默少给；
 *   4. `human` 与 `ai` 分得开——论文里"人工校准"必须是可审计的教师判断。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CALIBRATION_SCHEMA_VERSION,
  calibrationFromMark,
  calibrationIdOf,
  calibrationKeyOf,
  bookKeyFromPath,
  calibrationsFor,
  ledgerPathFromChapterPath,
  scopeFromChapterPath,
  foldCalibrations,
  locatePhrase,
  locateWord,
  makeCalibrationEvent,
  parseCalibrationLog,
  replayCalibrations,
  toCalibrationLine,
  unmatchedVerdict,
  type CalibrationEvent,
} from '../src/core/calibration.js';

/** 夹具：一章两段，词面/位置都是确定的（pi/si/wi 与 App 渲染同一套索引） */
const MD = [
  '# AF 第一章',
  '',
  '## Chapter One',
  '',
  '[P01] Mr. Jones locked the hen-houses for the night. He was too drunk to remember the pop-holes.',
  '',
  '[P02] The birds jumped on to their perches. Old Major had had a strange dream.',
  '',
].join('\n');

const SCOPE = { book: 'Animal Farm', chapter: '第一章', tier: 'A层85' };

function ev(over: Partial<Parameters<typeof makeCalibrationEvent>[0]> = {}): CalibrationEvent {
  return makeCalibrationEvent({
    teacher: 'wayne',
    ...SCOPE,
    level: 'word',
    word: 'pellets',
    type: 'simpl',
    action: 'add',
    source: 'human',
    ts: '2026-09-13T00:00:00.000Z',
    ...over,
  });
}

test('事件必须带 书/章/层/锚——缺了就没法在新版本上归属（这正是本次修复的核心）', () => {
  assert.throws(() => makeCalibrationEvent({ teacher: 'wayne', book: '', chapter: '第一章', tier: 'A层85', level: 'word', word: 'x', type: 'simpl', action: 'add', source: 'human' }), /书\/章\/层/);
  assert.throws(() => makeCalibrationEvent({ teacher: 'wayne', ...SCOPE, level: 'word', word: '  ', type: 'simpl', action: 'add', source: 'human' }), /word 或 text/);
  assert.throws(() => makeCalibrationEvent({ teacher: '', ...SCOPE, level: 'word', word: 'x', type: 'simpl', action: 'add', source: 'human' }), /teacher/);
});

test('ID 稳定：同 (教师, 时间, 锚, 类型, 动作) 恒等——重复导入不会造出两条账', () => {
  const a = calibrationIdOf({ teacher: 'wayne', ts: 't1', level: 'word', anchor: 'Pellets', type: 'simpl', action: 'add' });
  const b = calibrationIdOf({ teacher: 'wayne', ts: 't1', level: 'word', anchor: 'pellets', type: 'simpl', action: 'add' });
  const c = calibrationIdOf({ teacher: 'wayne', ts: 't1', level: 'word', anchor: 'pellets', type: 'zh', action: 'add' });
  assert.equal(a, b, '词面大小写不该改 ID');
  assert.notEqual(a, c, '不同类型是两条账');
  assert.equal(ev().schemaVersion, CALIBRATION_SCHEMA_VERSION);
});

test('解析坏行如实上报，不静默丢（项目惯例：账坏要说出来）', () => {
  const text = [toCalibrationLine(ev()).trim(), '{坏 JSON', '{"teacher":"wayne"}', ''].join('\n');
  const r = parseCalibrationLog(text);
  assert.equal(r.events.length, 1);
  assert.equal(r.bad.length, 2);
  assert.match(r.bad[0]!.reason, /JSON/);
  assert.match(r.bad[1]!.reason, /缺关键字段/);
});

test('折叠：后一条覆盖前一条；remove 撤销；与事件顺序无关', () => {
  const add = ev({ type: 'simpl', ts: '2026-09-13T01:00:00.000Z' });
  const change = ev({ type: 'zh', ts: '2026-09-13T02:00:00.000Z' });
  const remove = ev({ type: 'zh', action: 'remove', ts: '2026-09-13T03:00:00.000Z' });

  const f1 = foldCalibrations([add, change, remove]);
  assert.equal(f1.size, 0, '最后一条是 remove，该处应无有效校准');

  const f2 = foldCalibrations([add, change]);
  assert.equal(f2.size, 1);
  assert.equal([...f2.values()][0]!.type, 'zh', '后写的类型生效');

  const f3 = foldCalibrations([remove, change, add]);
  assert.deepEqual([...f3.keys()], [...foldCalibrations([add, change, remove]).keys()], '乱序输入结果一致');
});

test('范围过滤：书/章/层三级都要对得上', () => {
  const a = ev({ chapter: '第一章', tier: 'A层85' });
  const b = ev({ chapter: '第二章' });
  const c = ev({ tier: 'B层60' });
  assert.equal(calibrationsFor([a, b, c], { chapter: '第一章', tier: 'A层85' }).length, 1);
  assert.equal(calibrationsFor([a, b, c], { book: 'Animal Farm' }).length, 3);
  assert.equal(calibrationsFor([a, b, c], {}).length, 3, '空范围=不限');
});

test('定位用与 App 同一套索引（pi/si/wi）——错一格教师就会看到校准跑偏', () => {
  const hits = locateWord(MD, 'perches');
  assert.deepEqual(hits, [{ pi: 1, si: 0, wi: 6 }], 'The(0) birds(1) jumped(2) on(3) to(4) their(5) perches(6)');
  assert.deepEqual(locateWord(MD, 'drunk'), [{ pi: 0, si: 1, wi: 3 }]);
  assert.deepEqual(locateWord(MD, 'Major'), [{ pi: 1, si: 1, wi: 1 }], '词形归一到原形也要能定位');
  assert.deepEqual(locateWord(MD, 'nonexistent'), []);
});

test('短语锚：整句里能找到才认', () => {
  assert.equal(locatePhrase(MD, 'on to their perches').length, 1);
  assert.equal(locatePhrase(MD, 'jumped perches').length, 0);
});

test('重放：换版本后校准回得来（词面锚，不靠下标）', () => {
  const r = replayCalibrations({ md: MD, events: [ev({ word: 'perches' })], scope: SCOPE });
  assert.equal(r.marks.length, 1);
  assert.deepEqual({ pi: r.marks[0]!.pi, si: r.marks[0]!.si, wi: r.marks[0]!.wi }, { pi: 1, si: 0, wi: 6 });
  assert.equal(r.marks[0]!.source, 'human');
  assert.equal(r.unmatched.length, 0);
});

test('重放：重复跑幂等（不会每打开一次就多一条）', () => {
  const events = [ev({ word: 'perches' })];
  const first = replayCalibrations({ md: MD, events, scope: SCOPE });
  const second = replayCalibrations({ md: MD, events, scope: SCOPE, existing: first.marks });
  assert.equal(second.marks.length, 0, '已有同位同类标记就不再补');
});

test('重放：找不到锚的如实进 unmatched（不许静默少给）', () => {
  const r = replayCalibrations({ md: MD, events: [ev({ word: 'pellets' }), ev({ word: 'perches' })], scope: SCOPE });
  assert.equal(r.marks.length, 1);
  assert.equal(r.unmatched.length, 1);
  assert.equal(r.unmatched[0]!.word, 'pellets', '"校准没了"必须变成"这条没落上"——教师看得见');
});

test('重放：来源可筛——人类校准与 AI 候选分得开', () => {
  const human = ev({ word: 'perches', source: 'human' });
  const ai = ev({ word: 'drunk', source: 'ai', ts: '2026-09-13T02:00:00.000Z' });
  assert.equal(replayCalibrations({ md: MD, events: [human, ai], scope: SCOPE }).marks.length, 2);
  const onlyHuman = replayCalibrations({ md: MD, events: [human, ai], scope: SCOPE, sources: ['human'] });
  assert.equal(onlyHuman.marks.length, 1);
  assert.equal(onlyHuman.marks[0]!.source, 'human');
});

test('句级锚：句子结构没变时可重放，变了就进 unmatched', () => {
  const e = ev({ level: 'sent', word: undefined, text: 'The birds jumped on to their perches.', type: 'long' });
  assert.equal(replayCalibrations({ md: MD, events: [e], scope: SCOPE }).marks.length, 1);
  const drifted = ev({ level: 'sent', word: undefined, text: 'This sentence never existed anywhere.', type: 'long' });
  assert.equal(replayCalibrations({ md: MD, events: [drifted], scope: SCOPE }).unmatched.length, 1);
});

test('由 App 的标记造事件：默认 human + add，文件名只进溯源不进锚', () => {
  const e = calibrationFromMark({ level: 'word', word: 'perches', type: 'zh', note: '栖木' }, { teacher: 'wayne', ...SCOPE, file: '原文_A层85_2026-09-12_工序化.md' });
  assert.equal(e.source, 'human');
  assert.equal(e.action, 'add');
  assert.equal(e.file, '原文_A层85_2026-09-12_工序化.md');
  assert.equal(calibrationKeyOf(e), calibrationKeyOf(ev({ word: 'perches', type: 'zh', level: 'word' })));
});

test('找不到锚要分「办结」和「要看一眼」——糊在一起报，教师分不清完成和事故', () => {
  assert.equal(unmatchedVerdict({ type: 'simpl', level: 'word' }).verdict, 'done', '「词汇简化」的意图就是让这个词离开，词没了=办完了');
  assert.equal(unmatchedVerdict({ type: 'oov', level: 'word' }).verdict, 'done');
  assert.equal(unmatchedVerdict({ type: 'zh', level: 'word' }).verdict, 'check', '要加注的词却不见了，得看一眼');
  assert.equal(unmatchedVerdict({ type: 'goodw', level: 'word' }).verdict, 'check');
  assert.equal(unmatchedVerdict({ type: 'anchor', level: 'word' }).verdict, 'check');
});

test('书键/范围/台账路径：App 与管线必须算出同一个（否则台账成了"我写的你看不见"）', () => {
  const p = '/books/演示书/调适工作区/重制三版/第一章/原文_A层85_2026-09-12_工序化.md';
  assert.equal(bookKeyFromPath(p), '演示书', '书键 = 「工作区」上一层目录名');
  assert.deepEqual(scopeFromChapterPath(p), { book: '演示书', chapter: '第一章', tier: 'A层85' });
  assert.equal(ledgerPathFromChapterPath(p), '/books/演示书/调适工作区/重制三版/_运行/校准台账.jsonl');
  assert.equal(scopeFromChapterPath('/tmp/随便.md'), null, '认不出就不猜');
  assert.equal(scopeFromChapterPath('/tmp/x/第一章/学生版.md'), null, '文件名里没有层 tag 也不猜');
});

test('decision 类事件不重放成标记——「忽略」不该每次打开文件都长回标记清单', () => {
  const decided = ev({ word: 'perches', kind: 'decision', type: 'otherw' });
  assert.equal(replayCalibrations({ md: MD, events: [decided], scope: SCOPE }).marks.length, 0);
  const realMark = ev({ word: 'perches', kind: 'mark' });
  assert.equal(replayCalibrations({ md: MD, events: [realMark], scope: SCOPE }).marks.length, 1);
  const legacy = ev({ word: 'perches' }); // 老账没有 kind
  assert.equal(replayCalibrations({ md: MD, events: [legacy], scope: SCOPE }).marks.length, 1, '没有 kind 的老账按 mark 处理，向后兼容');
});

test('锚键不含文件名——换版本键不变（这条就是本次修复的判据）', () => {
  const oldFile = ev({ file: '原文_A层85_2026-09-10.md' });
  const newFile = ev({ file: '原文_A层85_2026-09-12_工序化.md' });
  assert.equal(calibrationKeyOf(oldFile), calibrationKeyOf(newFile));
});
