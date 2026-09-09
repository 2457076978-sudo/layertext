/**
 * 短语级标记（三级粒度：词/短语/句）+ 编码探测 + AI 边界防线 + 缩写拆句 · 单测
 * 覆盖：选区路由、短语切片定位、DOM 包裹/解包、remap 重对齐、GBK/GB2312 导入、
 * Markdown 记号剥离（枚举表 #16）、屈折形态预警（#17）、缩写不拆句（#19）、段落前导空格（#20）。
 */

import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { Window } from 'happy-dom';

const win = new Window();
before(() => {
  (globalThis as Record<string, unknown>).document = win.document;
  (globalThis as Record<string, unknown>).window = win;
});

import { phraseSpan, routeSelection, decodeAuto, stripMarkdownNoise, morphMismatch, remapMarks } from '../app/src/pure.js';
import { refreshMarkDom, removeMarkDom, jumpTo } from '../app/src/review.js';
import { sentsOf } from '../src/core/textpipe.js';
import type { Mark } from '../app/src/types.js';

const SENT = 'Alice was tired of sitting by her sister on the bank.';

test('routeSelection：整句→sent，≥2词→phrase，单词→word（选区即范围，无隐式判定）', () => {
  assert.equal(routeSelection(SENT, SENT), 'sent');
  assert.equal(routeSelection('  ' + SENT + '  ', SENT), 'sent'); // 首尾空白不干扰
  assert.equal(routeSelection('tired of sitting', SENT), 'phrase');
  assert.equal(routeSelection('by her sister on the', SENT), 'phrase');
  assert.equal(routeSelection('Alice', SENT), 'word');
  assert.equal(routeSelection('', SENT), 'word');
  assert.equal(routeSelection('…', SENT), 'word'); // 纯标点无英文词
});

test('phraseSpan：按词索引取原文切片（重复词不串位、含句内标点与空白）', () => {
  const s = 'The hare ran, and the hare won the race.';
  // 第 0 个 the 与第 4 个 the 重复——短语定位必须拿对
  assert.equal(phraseSpan(s, 4, 2)?.text, 'the hare'); // 第 4 词起 2 词（第二个 the hare）
  assert.equal(phraseSpan(s, 0, 2)?.text, 'The hare');
  assert.equal(phraseSpan(s, 2, 2)?.text, 'ran, and'); // 标点与空白在切片内
  assert.equal(phraseSpan('well known fact', 0, 2)?.text, 'well known');
  assert.equal(phraseSpan(s, 0, 0), null); // 越界
  assert.equal(phraseSpan(s, 100, 1), null);
});

test('短语 DOM：包裹成 .pm 下划线（含中间文本节点、角标留在框外），解包无残留', () => {
  win.document.body.innerHTML = `
    <div id="reader"><div class="para">
      <span class="sent" data-pi="0" data-si="0"><span class="w" data-wi="0">tired</span> <span class="w" data-wi="1">of</span> <span class="w" data-wi="2">sitting</span><sup class="sbadge sbadge-long">句太长</sup></span>
    </div></div>`;
  const mk = { id: 'p1', level: 'phrase', pi: 0, si: 0, wi: 0, wl: 3, word: 'tired of sitting', text: SENT.slice(0, 40), type: 'zh', ts: 1 } as Mark;
  refreshMarkDom(mk);
  const sent = win.document.querySelector('.sent')!;
  const pm = sent.querySelector('.pm[data-mid="p1"]');
  assert.ok(pm, '应生成 .pm 包裹');
  assert.equal(pm!.className, 'pm mk-zh');
  assert.equal(pm!.textContent, 'tired of sitting'); // 中间空格保留、词全在框内
  assert.ok(sent.querySelector('.sbadge'), '句级角标不被卷进短语框');
  assert.equal(pm!.querySelectorAll('.w').length, 3, '词 span 随迁');
  // 幂等：重复 refresh 不再包一层
  refreshMarkDom(mk);
  assert.equal(sent.querySelectorAll('.pm').length, 1);
  // 解包：子节点原位放回
  removeMarkDom(mk);
  assert.equal(sent.querySelectorAll('.pm').length, 0);
  assert.equal(sent.textContent, 'tired of sitting句太长'); // 顺序与内容无损
});

test('remapMarks：短语在句内被改写后按词序列重对齐（大小写不敏感）', () => {
  const md0 = '# T\n\n## Chapter One\n\n[P01] Alice was tired of sitting by her sister.\n';
  const marks: Mark[] = [{ id: 'p1', level: 'phrase', pi: 0, si: 0, wi: 2, wl: 3, word: 'tired of sitting', text: 'Alice was', type: 'simpl', ts: 1 }];
  // 句首前缀稳定（锚点命中），短语前插了词 → 句内按词序列重新定位
  const md1 = '# T\n\n## Chapter One\n\n[P01] Alice was soon very tired of sitting by the river.\n';
  remapMarks(marks, md1);
  assert.equal(marks[0].pi, 0);
  const sent = sentsOf('Alice was soon very tired of sitting by the river.', false)[0];
  const raws = sent.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
  assert.equal(raws[marks[0].wi!], 'tired');
  assert.equal(marks[0].wl, 3);
  void md0;
});

test('decodeAuto：UTF-8 直读、BOM 剥离、GBK/GB2312 自动兜底（中文 txt 不再乱码）', () => {
  // UTF-8
  assert.equal(decodeAuto(new TextEncoder().encode('hello 野猪')), 'hello 野猪');
  // UTF-8 BOM
  assert.equal(decodeAuto(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('ok')])), 'ok');
  // GBK："工作" = B9 A4 D7 F7（0xB9 不是合法 UTF-8 起始字节 → 自动落 GB18030）
  assert.equal(decodeAuto(new Uint8Array([0xb9, 0xa4, 0xd7, 0xf7])), '工作');
  // GB2312 兼容（GB18030 是其超集）
  assert.equal(decodeAuto(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4])), '中文');
  // UTF-16LE BOM
  assert.equal(decodeAuto(new Uint8Array([0xff, 0xfe, 0x41, 0x00])), 'A');
});

test('stripMarkdownNoise（枚举表 #16）：AI 混入的 Markdown 记号归一化剥离', () => {
  assert.equal(stripMarkdownNoise('**a big** house'), 'a big house');
  assert.equal(stripMarkdownNoise('*quiet* and calm'), 'quiet and calm');
  assert.equal(stripMarkdownNoise('`run` fast'), 'run fast');
  assert.equal(stripMarkdownNoise('__very__ old'), 'very old');
  assert.equal(stripMarkdownNoise('no marks here'), 'no marks here');
});

test('morphMismatch（枚举表 #17）：词尾形态类不一致预警口径', () => {
  assert.equal(morphMismatch('ran', 'running'), true);
  assert.equal(morphMismatch('laughed', 'laugh'), true);
  assert.equal(morphMismatch('cats', 'dogs'), false);
  assert.equal(morphMismatch('big', 'large'), false);
});

test('sentsOf（枚举表 #19）：Mr./U.S./单字母缩写后不切句', () => {
  // 注：既有约定——非末句保留句尾空格（与拆分正则零宽切分一致），比较用 trim 口径
  const t = (s: string): string[] => sentsOf(s, false).map((x) => x.trim());
  assert.deepEqual(t('Mr. Jones went home. The dog slept.'), ['Mr. Jones went home.', 'The dog slept.']);
  assert.deepEqual(t('She met Dr. Smith. Then they left.'), ['She met Dr. Smith.', 'Then they left.']);
  assert.equal(t('The U.S. Army came. It stayed.').length, 2);
  assert.equal(t('The U.S. Army came.')[0], 'The U.S. Army came.');
  // 正常句界不受影响
  assert.equal(t('One. Two. Three.').length, 3);
});

test('段落前导空格与空白形态（枚举表 #20）：归一化定位不受影响', () => {
  // extractParas 切片带前导空格属正常形态，sentsOf 归一化后句子一致
  assert.equal(sentsOf('   tired of sitting by her sister.   ', false)[0], 'tired of sitting by her sister.');
});

test('jumpTo：短语标记跳转到 .pm 元素（不抛错即过，目标存在时滚动）', () => {
  win.document.body.innerHTML = `
    <div id="reader"><div class="para">
      <span class="sent" data-pi="0" data-si="0"><span class="pm mk-zh" data-mid="j1"><span class="w" data-wi="0">tired</span> <span class="w" data-wi="1">of</span></span></span>
    </div></div>`;
  const mk = { id: 'j1', level: 'phrase', pi: 0, si: 0, wi: 0, wl: 2, word: 'tired of', text: 'tired', type: 'zh', ts: 1 } as Mark;
  jumpTo(mk); // happy-dom 下 scrollIntoView 为空实现，不抛错即通过
  assert.ok(win.document.querySelector('.pm[data-mid="j1"]'));
});
