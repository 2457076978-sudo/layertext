/**
 * 审查单（A 方案）回归测试
 *
 * 锁的是 2026-10-05 定案的三件事（原实现随 2026-10-09 迁移事故丢失，按定案重写）：
 *   ① 自包含 HTML：手机优先三键（补注/换成X/忽略）、机器候选只预填、
 *      出处句高亮 TS 侧预计算、localStorage 草稿、键盘 J/K/1/2/3；
 *   ② 内嵌 JS **零正则、零模板字符串**（复刻正则会炸 `${}`——这条写成断言锁死）；
 *   ③ ingest 只校验不执行改文：校验失败台账一个字不落；通过则 append-only + eventId 幂等。
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

import { contentHash } from '../src/core/manifest.js';
import { lexiconFromWords } from '../src/core/lexicon.js';
import {
  buildReviewSheet,
  buildReviewSheetHtml,
  highlightSegments,
  parasForReview,
  reviewEventsFromDecisions,
  ReviewValidationError,
  type ReviewDecisionsFile,
  type ReviewSheetManifest,
} from '../src/core/reviewsheet.js';
import { parseDecisionLog } from '../src/core/decision.js';

const MD = ['# Test Passage', '', '[P01] The burly man gripped his broomstick. The man was burly and slow.', '', '[P02] Storms writhing across the sky. He watched the storms.'].join('\n');

const lex = lexiconFromWords(['the', 'man', 'was', 'and', 'slow', 'he', 'watched', 'his', 'across', 'sky']);

const sheet = buildReviewSheet(MD, lex, { tier: 'A', fileName: 'demo.md', builtAt: '2026-10-24T00:00:00.000Z' });

const dec = (over: Partial<ReviewDecisionsFile> = {}): ReviewDecisionsFile => ({
  schemaVersion: 1,
  sheetId: sheet.sheetId,
  sourceFile: 'demo.md',
  sourceVersion: sheet.sourceVersion,
  teacherId: 'wayne',
  decidedAt: '2026-10-24T01:00:00.000Z',
  decisions: [
    { word: 'burly', action: 'replace', value: 'big' },
    { word: 'broomstick', action: 'annotate', value: '扫帚' },
    { word: 'writhing', action: 'ignore' },
  ],
  ...over,
});

test('清单：OOV 词型按出现次数降序（同数按字母序），出处句带预计算三段', () => {
  // hit() 带词形归一：watched→watch 命中；gripped→grip 未收所以是 OOV
  assert.equal(sheet.oovWordCount, 5);
  assert.deepEqual(
    sheet.items.map((i) => i.word),
    ['burly', 'storms', 'broomstick', 'gripped', 'writhing'],
  );
  const burly = sheet.items.find((i) => i.word === 'burly')!;
  assert.equal(burly.count, 2);
  // 高亮三段在 TS 侧预计算好：hit 恰是原词（保留原大小写形态）
  assert.ok(burly.sentences.length >= 1);
  assert.match(burly.sentences[0]!.hit, /^burly$/i);
  assert.ok((burly.sentences[0]!.pre + burly.sentences[0]!.hit + burly.sentences[0]!.post).includes('burly'));
});

test('清单：sheetId/sourceVersion 由源内容哈希锚定（决定必须对着这一版做）', () => {
  assert.equal(sheet.sourceVersion, contentHash(MD));
  assert.equal(sheet.sheetId, `rs-${contentHash(MD).slice(0, 12)}`);
  const again = buildReviewSheet(MD, lex, { tier: 'A', fileName: 'demo.md' });
  assert.equal(again.sheetId, sheet.sheetId);
});

test('机器候选只预填：--kb 资产进 items.candidate，不改变判定', () => {
  const kb = new Map([['burly', 'big']]);
  const s2 = buildReviewSheet(MD, lex, { candidates: kb });
  assert.equal(s2.items.find((i) => i.word === 'burly')!.candidate, 'big');
  assert.equal(s2.items.find((i) => i.word === 'writhing')!.candidate, undefined);
  assert.equal(s2.oovWordCount, sheet.oovWordCount);
});

test('段落双路：[P##] 书稿与空行分段的裸文本都能出句', () => {
  assert.equal(parasForReview(MD).length, 2);
  const raw = 'The burly man came.\n\nHe had a broomstick.';
  const s3 = buildReviewSheet(raw, lex, {});
  assert.ok(s3.items.length > 0);
  // 标题行不进段落
  assert.ok(parasForReview('# Title\n\nBody text here.')[0].startsWith('Body'));
});

test('highlightSegments：整词大小写不敏感；未命中返回 null', () => {
  const seg = highlightSegments('He gripped his Broomstick tight.', 'broomstick');
  assert.equal(seg?.hit, 'Broomstick');
  assert.equal(seg?.pre, 'He gripped his ');
  assert.equal(highlightSegments('rebroomstickx', 'broomstick'), null); // 词边界
  assert.equal(highlightSegments('nothing here', 'broomstick'), null);
});

test('HTML 自包含：无外链 JS/CSS、无网络请求、手机优先视口', () => {
  const html = buildReviewSheetHtml(sheet, 'wayne');
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.doesNotMatch(html, /<script[^>]+src=/);
  assert.doesNotMatch(html, /<link[^>]+href=/);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.match(html, /name="viewport"/);
});

test('HTML 三键 + 候选预填 + J/K/1/2/3 + localStorage 草稿', () => {
  const s2 = buildReviewSheet(MD, lex, { candidates: new Map([['burly', 'big']]) });
  const html = buildReviewSheetHtml(s2, 'wayne');
  for (const a of ['annotate', 'replace', 'ignore']) assert.match(html, new RegExp(`data-action="${a}"`));
  assert.match(html, /① 补注/);
  assert.match(html, /② 换成X/);
  assert.match(html, /③ 忽略/);
  // 候选预填进 input value（教师可改）
  assert.match(html, /value="big"/);
  // 键盘流与草稿
  assert.match(html, /'j' \|\| e\.key === 'J'/);
  assert.match(html, /'1': 'annotate', '2': 'replace', '3': 'ignore'/);
  assert.match(html, /localStorage/);
  assert.match(html, /lt-sheet-draft-/);
});

test('HTML 铁律：内嵌 JS 零模板字符串、零正则字面量（2026-10-05 定案）', () => {
  const html = buildReviewSheetHtml(sheet, 'wayne');
  const js = html.split('<script>')[1]!.split('</script>')[0]!;
  assert.ok(js.length > 500, '页面 JS 不应缩成空壳');
  assert.ok(!js.includes('`'), '内嵌 JS 禁用模板字符串（复刻正则会炸 ${} 的教训）');
  assert.ok(!js.includes('${'), '内嵌 JS 不得出现 ${ 插值');
  assert.ok(!/\bnew RegExp\b/.test(js), '内嵌 JS 禁止运行时构造正则');
});

test('HTML 转义：句中 HTML 特殊字符不得裸进页面（教师内容不可信）', () => {
  const mdTrap = '[P01] The burly "man" <b>gripped</b> the \'stick\' & ran.';
  const sTrap = buildReviewSheet(mdTrap, lex, { fileName: 'a<b>.md' });
  const html = buildReviewSheetHtml(sTrap, 'w<"y">');
  assert.ok(!html.includes('<b>gripped</b>'), '句子里的标签必须被转义');
  assert.ok(html.includes('&lt;b&gt;'));
  assert.ok(html.includes('&quot;man&quot;'));
  assert.ok(html.includes('&amp; ran'), '& 必须转义');
  assert.ok(html.includes('a&lt;b&gt;.md'), '文件名必须转义');
});

test('三键 → 决定事件映射：补注=accept(资产可传播) / 换成X=edit(只记待办) / 忽略=false-positive(本层)', () => {
  const r = reviewEventsFromDecisions(dec(), sheet);
  assert.equal(r.events.length, 3);
  assert.equal(r.skipped, 0);
  assert.deepEqual(r.pendingWords, ['storms', 'gripped']);
  const byWord = new Map(r.events.map((e) => [e.subject!.value, e]));
  assert.equal(byWord.get('burly')!.decision, 'edit');
  assert.equal(byWord.get('burly')!.after, 'big');
  assert.equal(byWord.get('burly')!.before.includes('burly'), true);
  assert.equal(byWord.get('broomstick')!.decision, 'accept');
  assert.equal(byWord.get('broomstick')!.after, 'broomstick（扫帚）');
  assert.equal(byWord.get('writhing')!.decision, 'false-positive');
  assert.equal(byWord.get('writhing')!.after, byWord.get('writhing')!.before, '忽略=原样');
  for (const e of r.events) {
    assert.deepEqual(e.ruleIds, ['RS-OOV']);
    assert.equal(e.teacherId, 'wayne');
    assert.equal(e.sourceVersion, sheet.sourceVersion);
    assert.equal(e.tier, 'A');
    assert.match(e.itemId, new RegExp(`^${sheet.sheetId}:`));
    assert.ok(e.eventId);
  }
});

test('幂等：同一份决定再入库 → 全部跳过，事件零新增', () => {
  const r1 = reviewEventsFromDecisions(dec(), sheet);
  const r2 = reviewEventsFromDecisions(dec(), sheet, r1.events);
  assert.equal(r2.events.length, 0);
  assert.equal(r2.skipped, 3);
});

test('校验失败 → 抛 ReviewValidationError（台账一个字不落）', () => {
  const cases: [string, ReviewDecisionsFile][] = [
    ['sheetId 不符（决定不是对着这张单做的）', dec({ sheetId: 'rs-other' })],
    ['sourceVersion 不符（源文件改过，旧决定作废）', dec({ sourceVersion: 'sha-changed' })],
    ['teacherId 空', dec({ teacherId: '  ' })],
    ['词不在清单', dec({ decisions: [{ word: 'napoleon', action: 'ignore' }] })],
    [
      '一词两票',
      dec({
        decisions: [
          { word: 'burly', action: 'ignore' },
          { word: 'burly', action: 'ignore' },
        ],
      }),
    ],
    ['换成X 没给替换词', dec({ decisions: [{ word: 'burly', action: 'replace', value: '' }] })],
    ['换成X 替换成自己', dec({ decisions: [{ word: 'burly', action: 'replace', value: 'Burly' }] })],
    ['补注没给释义', dec({ decisions: [{ word: 'burly', action: 'annotate', value: ' ' }] })],
    ['动作不在三键内', dec({ decisions: [{ word: 'burly', action: 'delete' as never }] })],
  ];
  for (const [name, d] of cases) {
    assert.throws(() => reviewEventsFromDecisions(d, sheet), ReviewValidationError, name);
  }
});

test('端到端（CLI）：生成审查单 → 判定 → 入台账；源文件分毫不动', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lt-reviewsheet-'));
  const mdPath = join(dir, 'demo.md');
  const wlPath = join(dir, 'wl.txt');
  writeFileSync(mdPath, MD, 'utf-8');
  writeFileSync(wlPath, 'the\nman\nwas\nand\nslow\nhe\nwatched\nhis\nacross\nsky\n', 'utf-8');
  const run = promisify(execFile);
  const node = process.execPath;
  const cli = new URL('../src/cli.js', import.meta.url).pathname; // dist/tests/x.test.js → dist/src/cli.js

  const sheetHtml = join(dir, 'sheet.html');
  await run(node, [cli, 'reviewsheet', mdPath, '--wordlist', wlPath, '--tier', 'A', '--out', sheetHtml]);
  const html = readFileSync(sheetHtml, 'utf-8');
  const manifest = JSON.parse(readFileSync(`${sheetHtml}.json`, 'utf-8')) as ReviewSheetManifest;
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.equal(manifest.oovWordCount, 5);

  const decisionsPath = join(dir, '决定.json');
  const d: ReviewDecisionsFile = {
    schemaVersion: 1,
    sheetId: manifest.sheetId,
    sourceFile: 'demo.md',
    sourceVersion: manifest.sourceVersion,
    teacherId: 'wayne',
    decidedAt: '2026-10-24T02:00:00.000Z',
    decisions: [
      { word: 'burly', action: 'replace', value: 'big' },
      { word: 'writhing', action: 'ignore' },
    ],
  };
  writeFileSync(decisionsPath, JSON.stringify(d), 'utf-8');

  const ledger = join(dir, '台账.jsonl');
  const before = readFileSync(mdPath, 'utf-8');
  await run(node, [cli, 'reviewsheet-ingest', decisionsPath, '--sheet', `${sheetHtml}.json`, '--ledger', ledger]);
  const { events, badLines } = parseDecisionLog(readFileSync(ledger, 'utf-8'));
  assert.equal(badLines, 0);
  assert.equal(events.length, 2);
  // 只校验不执行改文：源文件一个字节都没动
  assert.equal(readFileSync(mdPath, 'utf-8'), before);
  // 再入一次：幂等
  await run(node, [cli, 'reviewsheet-ingest', decisionsPath, '--sheet', `${sheetHtml}.json`, '--ledger', ledger]);
  assert.equal(parseDecisionLog(readFileSync(ledger, 'utf-8')).events.length, 2);
});

test('与 qc 同口径：不规则动词（was/had/went/gone）不算超纲', () => {
  // 冒烟实测教训：漏并 IRR 时 was×7 霸榜首行，教师收到的审查单第一条就是误报
  const s = buildReviewSheet('[P01] He was sad. They had gone. She went home.', lexiconFromWords(['he', 'sad', 'they', 'she', 'home']), {});
  assert.equal(s.oovWordCount, 0);
});

test('清单正本可序列化往返（sheet.json 落盘再读回，形状不变）', () => {
  const round = JSON.parse(JSON.stringify(sheet)) as ReviewSheetManifest;
  assert.deepEqual(round, sheet);
});
