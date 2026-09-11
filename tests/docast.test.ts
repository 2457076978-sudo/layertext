/**
 * 章节文档 AST 回归测试
 *
 * 验收标准（《LayerText 项目审查报告（2026-09-11）》§四）：
 *   「`word（中文）` 和 `[P##]` 可以保留为发布格式，但内部应转成 AST/中间表示；发布时再序列化。
 *     这样不改变教师可见格式，却避免正则在连字符、多义词、嵌套标记上失真。
 *     迁移代价是一次性写解析器、为旧文件生成稳定 ID，并在对齐失败时进入人工队列。」
 *
 * 最关键的一条是**往返恒等**：serialize(parse(x)) === x，一个字节都不许变。
 * 否则"内部转 AST"会悄悄改写教师手里的书稿，比正则失真更严重。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyRepairs,
  flattenNestedAnnotations,
  isPlaceholder,
  parseDoc,
  removeAnnotation,
  repairDoc,
  serializeDoc,
  setSense,
  type SegmentNode,
} from '../src/core/docast.js';

/** 覆盖各种真实出现过的形状：连字符、撇号、多段、空行、词句卡、无标记旧稿 */
const CORPUS: { name: string; md: string }[] = [
  { name: '最简一章', md: '## Chapter One\n\n[P01] The boy ran.\n' },
  { name: '多段 + 注释', md: '## Chapter One\n\n[P01] The barn（谷仓） was old.\n\n[P02] A windmill（风车） stood there.\n' },
  { name: '连字符与撇号', md: "## Chapter One\n\n[P01] A blood-curdling（令人毛骨悚然的） cry, and the boys'（男孩们的） hats.\n" },
  { name: '段号不连续', md: '## Chapter One\n\n[P01] One.\n\n[P05] Five.\n' },
  { name: '带词句卡', md: '## Chapter One\n\n[P01] The barn（谷仓） was old.\n\n## 词句卡\n\n| 词 | 释义 |\n|---|---|\n| barn | 谷仓 |\n' },
  { name: '无段标记的旧稿', md: '## Chapter One\n\nThe boy ran to the barn.\n' },
  { name: '有 BOM 与前置说明', md: '\uFEFF# 书名\n\n说明一行\n\n## Chapter One\n\n[P01] Text.\n' },
  { name: '窗口换行 CRLF', md: '## Chapter One\r\n\r\n[P01] The barn（谷仓） was old.\r\n' },
  { name: '段标记后没有空格', md: '## Chapter One\n\n[P01]Text.\n\n[P02] More.\n' },
  { name: '门禁占位段', md: '## Chapter One\n\n[P01] Good.（好的）\n\n[P02] <!-- 本段未通过复检，未收录；原文与改写见 _待复核/A层85/ -->\n' },
  { name: '同为一行多个注释', md: '## Chapter One\n\n[P01] A barn（谷仓） and a windmill（风车） and a boxer（拳师）.\n' },
];

test('往返恒等：serialize(parse(x)) === x（这是本模块存在的前提）', () => {
  for (const { name, md } of CORPUS) {
    const back = serializeDoc(parseDoc(md));
    assert.equal(back, md, `「${name}」往返后内容变异了`);
  }
});

test('往返恒等：干净文档跑一遍修复也逐字节不变（幂等）', () => {
  for (const { name, md } of CORPUS.slice(0, 9)) {
    const r = repairDoc(md);
    assert.equal(r.md, md, `「${name}」修复不该动干净文档`);
    assert.equal(r.changed, false);
  }
});

test('段 ID 来自 [P##]，是稳定 ID（不是数组下标）', () => {
  const ast = parseDoc('## Chapter One\n\n[P07] Seven.\n\n[P08] Eight.\n');
  assert.deepEqual(ast.segments.map((s) => s.id), ['P07', 'P08']);
  assert.deepEqual(ast.segments.map((s) => s.idSource), ['marker', 'marker']);
  assert.equal(ast.segments[0]!.marker, '[P07]');
});

test('旧文件补稳定 ID，并**标成需要人确认**（对齐是猜的）', () => {
  const ast = parseDoc('## Chapter One\n\nThe boy ran.\n');
  assert.equal(ast.segments.length, 1);
  assert.equal(ast.segments[0]!.idSource, 'assigned');
  const issue = ast.issues.find((i) => i.kind === 'marker-missing');
  assert.ok(issue);
  assert.equal(issue.needsHuman, true, '分段对齐失败必须进人工队列，不许静默');
});

test('段号重复/不连续都要报出来（否则按标记配对会整体错位）', () => {
  const dup = parseDoc('## Chapter One\n\n[P03] A.\n\n[P03] B.\n');
  assert.equal(dup.issues.some((i) => i.kind === 'marker-duplicate'), true);
  const gap = parseDoc('## Chapter One\n\n[P01] A.\n\n[P05] B.\n');
  const g = gap.issues.find((i) => i.kind === 'marker-gap');
  assert.ok(g);
  assert.equal(g.needsHuman, true);
});

test('连字符与撇号：原词完整保留，下标精确（正则在这里最容易切错）', () => {
  const md = "## Chapter One\n\n[P01] A blood-curdling（令人毛骨悚然的） cry, and the boys'（男孩们的） hats.\n";
  const seg = parseDoc(md).segments[0]!;
  const anns = seg.spans.filter((s) => s.kind === 'annotation');
  assert.equal(anns.length, 2);
  assert.equal((anns[0] as { word: string }).word, 'blood-curdling');
  assert.equal((anns[1] as { word: string }).word, "boys'");
  // 用下标精确改一条，另一条与周围文字一个字节不动
  const ast = parseDoc(md);
  assert.equal(setSense(ast, 'P01', 'blood-curdling', '令人毛骨悚然'), true);
  assert.equal(serializeDoc(ast), "## Chapter One\n\n[P01] A blood-curdling（令人毛骨悚然） cry, and the boys'（男孩们的） hats.\n");
});

test('同词多义：能查出来，并可按"首次出现的释义"统一', () => {
  const md = '## Chapter One\n\n[P01] A barn（谷仓） here.\n\n[P02] A barn（仓房） there.\n';
  const ast = parseDoc(md);
  const issue = ast.issues.find((i) => i.kind === 'sense-conflict');
  assert.ok(issue, '同一章里同词两义必须报出来');
  assert.equal(issue.needsHuman, false, '能确定性修的不该推给人');
  const r = applyRepairs(ast);
  assert.equal(r.senses, 1);
  assert.equal(serializeDoc(ast), '## Chapter One\n\n[P01] A barn（谷仓） here.\n\n[P02] A barn（谷仓） there.\n');
});

test('嵌套注释：结构上查得出来，且能扁平化（正则只能看到最外层）', () => {
  const md = '## Chapter One\n\n[P01] A barn（谷仓 barn（仓房）） here.\n';
  const ast = parseDoc(md);
  assert.equal(ast.issues.some((i) => i.kind === 'annotation-nested'), true, '畸形嵌套必须被报出来');
  const r = applyRepairs(ast);
  assert.equal(r.nested >= 1, true, '嵌套要被发现并处理');
  // 释义取"第一个 1–6 字汉字串"——与 2026-09-10 修复脚本既有行为一致（教师可见结果不变）
  assert.equal(serializeDoc(ast), '## Chapter One\n\n[P01] A barn（谷仓） here.\n');
});

test('嵌套注释：内层是中文字时也查得出来（Mollie（莫丽（名字））这类真实现场）', () => {
  const md = '## Chapter One\n\n[P01] Mollie（莫丽（名字）） and a hoof（复数 hoofs（蹄子）/hooves（蹄）） here.\n';
  const r = flattenNestedAnnotations(md);
  assert.equal(r.nested, 2);
  assert.equal(/（[^（）]*（/.test(r.md), false, '结果里不该再有任何嵌套');
  assert.equal(r.md.includes('Mollie（莫丽）'), true);
  assert.equal(r.md.includes('hoof（复数）'), true, '与修复脚本既有行为一致');
});

test('括号不配对：报出来但不推给人（是可确定性提示的格式问题）', () => {
  const ast = parseDoc('## Chapter One\n\n[P01] A barn（谷仓 here.\n');
  const issue = ast.issues.find((i) => i.kind === 'annotation-unclosed');
  assert.ok(issue);
  assert.equal(issue.needsHuman, false);
  assert.equal(issue.detail?.open, 1);
  assert.equal(issue.detail?.close, 0);
});

test('编辑操作：去注释还原裸词，前后文一字不动', () => {
  const ast = parseDoc('## Chapter One\n\n[P01] The barn（谷仓） was old and the barn was cold.\n');
  assert.equal(removeAnnotation(ast, 'P01', 'barn'), true);
  assert.equal(serializeDoc(ast), '## Chapter One\n\n[P01] The barn was old and the barn was cold.\n');
  assert.equal(removeAnnotation(ast, 'P01', 'nonexistent'), false, '找不到就不改，不静默');
  assert.equal(setSense(ast, 'P99', 'barn', 'x'), false, '段不存在也不改');
});

test('占位段能被认出（门禁未通过留下的空位不能当正文）', () => {
  const seg: SegmentNode = {
    id: 'P02', marker: '[P02]', prefix: ' ', raw: '<!-- 本段未通过复检，未收录；原文与改写见 _待复核/A层85/ -->',
    spans: [], idSource: 'marker',
  };
  assert.equal(isPlaceholder(seg), true);
  assert.equal(isPlaceholder({ ...seg, raw: 'Normal text.' }), false);
});

test('词句卡与正文分开：卡片内容不进 segments（不会被当成正文段落）', () => {
  const md = '## Chapter One\n\n[P01] The barn（谷仓） was old.\n\n## 词句卡\n\n| 词 | 释义 |\n|---|---|\n| barn | 谷仓 |\n';
  const ast = parseDoc(md);
  assert.equal(ast.segments.length, 1);
  assert.match(ast.tail, /## 词句卡/);
  assert.equal(ast.segments[0]!.raw.includes('词句卡'), false);
});

test('只摊平嵌套（不动同词多义）：给修复脚本用的窄入口', () => {
  const md = '## Chapter One\n\n[P01] Mollie（莫丽（名字）） and a barn（谷仓）.\n\n[P02] A barn（仓房） there.\n';
  const r = flattenNestedAnnotations(md);
  assert.equal(r.nested >= 1, true);
  assert.equal(r.md.includes('（莫丽（名字））'), false, '嵌套被剥掉');
  assert.equal(r.md.includes('barn（谷仓）'), true, '同词多义**不动**（那是跨文件多数票的事，归修复脚本）');
  assert.equal(r.md.includes('barn（仓房）'), true);
  // 干净文档逐字节不变
  const clean = '## Chapter One\n\n[P01] The barn（谷仓） was old.\n';
  assert.equal(flattenNestedAnnotations(clean).md, clean);
  assert.equal(flattenNestedAnnotations(clean).nested, 0);
});

test('任意深度嵌套都能摊平（正则只能处理一层）', () => {
  const md = '## Chapter One\n\n[P01] A hoof（蹄（复数 hoofs（蹄子））） here.\n';
  const r = flattenNestedAnnotations(md);
  assert.equal(r.nested >= 1, true, `三层嵌套必须被发现，实得 ${r.nested}`);
  assert.equal(/（[^（）]*（/.test(r.md), false, '结果里不该再有嵌套');
});
