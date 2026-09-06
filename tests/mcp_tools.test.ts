/**
 * MCP 工具层测试：4 个工具在评测集文本上的正确性
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildMcpLexicon, toolCheckRevision, toolQcText, toolSentenceRisks, toolWordStatus, wrapAsChapter,
} from '../src/core/mcpTools.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const bundled = [
  readFileSync(join(ROOT, 'assets', 'wordlists', 'curriculum_2022_level3_1600.txt'), 'utf-8'),
  readFileSync(join(ROOT, 'assets', 'wordlists', 'curriculum_2022_amendment.txt'), 'utf-8'),
];
const lex = buildMcpLexicon({}, bundled);

test('wrapAsChapter：任意文本按空行切段编 [P01]；已是章节格式的不重复包装由调用方处理', () => {
  const md = wrapAsChapter('First para here.\n\nSecond para here.');
  assert.match(md, /## Chapter One/);
  assert.match(md, /\[P01\] First para here\./);
  assert.match(md, /\[P02\] Second para here\./);
});

test('layer_qc：评测文本出正确指标与 OOV（与金标准口径一致）', () => {
  const md = readFileSync(join(ROOT, 'examples', 'evals', 'eval01_the_rematch', 'source.md'), 'utf-8');
  const r = toolQcText(md, lex) as Record<string, unknown>;
  assert.equal(r['⑤被动式计数(叙事区)'], 6);
  assert.equal(r['⑥定语从句计数(叙事区)'], 3);
  assert.equal(r['⑦过去完成计数(叙事区)'], 4);
  const oov = r['OOV清单前N'] as { word: string }[];
  assert.ok(oov.some((w) => w.word === 'tortoise'));
  assert.ok(!oov.some((w) => w.word === 'one')); // amendment 补录生效
});

test('layer_word_status：三种状态与词形还原', () => {
  assert.match(String(toolWordStatus('tortoise', lex).status), /词表外/);
  assert.match(String(toolWordStatus('went', lex).status), /词表内/); // IRR 直接命中
  assert.match(String(toolWordStatus('Monday', lex).status), /词表内/); // amendment 补录
  assert.equal(toolWordStatus('Went', lex).词形还原原形, 'went'); // 表内词原形即自身
  assert.equal(toolWordStatus('stories', lex).词形还原原形, 'story'); // 后缀还原
});

test('layer_sentence_risks：多句逐句、超长按 max_len', () => {
  const out = toolSentenceRisks('The boy was seen by the teacher. He ran fast.', 16);
  assert.equal(out.length, 2);
  assert.equal(out[0].passive, true);
  assert.equal(out[1].passive, false);
  const long = toolSentenceRisks('He ran very fast and he ran very far and he ran all day long without any stop at all.', 12);
  assert.equal(long[0].overlong, true);
});

test('layer_check_revision：AI 拆句后不误报超长；被动残留被抓', () => {
  const ok = toolCheckRevision('The old man sang a song. The children walked home.', 12);
  assert.equal(ok.通过, true);
  const bad = toolCheckRevision('The song was sung by the old man, and the children who were tired walked home slowly.', 16);
  assert.equal(bad.通过, false);
  const issues = (bad as { 问题: string[] }).问题;
  assert.ok(issues.some((x) => /被动/.test(x)));
  assert.ok(issues.some((x) => /定语从句/.test(x)));
});
