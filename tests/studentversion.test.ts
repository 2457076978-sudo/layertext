/**
 * 学生版 · 测试
 *
 * 验收（《LayerText 工程优化总计划》「商业化产品边界」）：
 *   「第一版应卖一个清晰的闭环：导入文本、选择层级、生成候选、教师快速审校、
 *     **发布学生版**、查看质量与变更记录。」
 *
 * 这一环此前完全没有。管线产出的那份 Markdown 是**教师的工作稿**——
 * 带 `[P##]` 段标记（段落对齐的稳定 ID）、带内部制作说明、门禁未通过的段还留着占位注释。
 * 直接发给学生，学生看到的是一段读得通的文字里夹着 `[P07]` 和一串来源说明。
 *
 * 这一组用例里最重要的是**占位段那条**：把它默默删掉，学生版会变成一个
 * 读得通的段落序列——而中间少了一整段这件事，在成品里长得跟"这一段本来就没有"一模一样。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_DROP_SECTIONS, isPublishable, studentVersionOf } from '../src/core/studentversion.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 一份**真的长这样**的产物（结构照抄真项目第一章） */
const REAL_LIKE = `# AF 第一章 原文基线（清理对齐版 v0.1）

> 来源：7月重建稿128句（\`原文基线_重建稿.txt\`）。清理=①去除OCR英文粘连词 ②按原版段落结构对齐。
> 段落ID [P01]-[P14] 为稳定锚，改写稿沿用同ID。

## Chapter One

[P01] Mr. Jones, of the Manor Farm, had locked the hen-houses for the night, but was too drunk to remember the pop-holes. He lurched（踉跄着走） across the yard.

[P02] As soon as the light in the bedroom went out, there was a stirring（搅动） all through the farm buildings.
`;

/* ────────────────────── ① 该去的去、该留的留 ────────────────────── */

test('★ 内部制作说明不进学生版（那是给管线和教师看的）', () => {
  const r = studentVersionOf(REAL_LIKE);
  assert.equal(r.text.includes('清理对齐版'), false, '内部版本号不该出现');
  assert.equal(r.text.includes('来源：7月重建稿'), false, '制作来源不该出现');
  assert.equal(r.text.includes('为稳定锚'), false, '段 ID 的说明不该出现');
  assert.equal(r.removed.frontMatterLines > 0, true, `丢了几行要**报数**，实得 ${r.removed.frontMatterLines}`);
});

test('★ 段标记去掉，但**释义必须留着**——那正是这份产品要给学生的东西', () => {
  const r = studentVersionOf(REAL_LIKE);
  assert.equal(/\[P\d+\]/.test(r.text), false, '段标记是内部对齐 ID，对读者只是噪音');
  assert.equal(r.removed.markers, 2, '去掉几个要报数');
  assert.equal(r.text.includes('（踉跄着走）'), true, '**理解支架不能被顺手一起清掉**');
  assert.equal(r.text.includes('（搅动）'), true);
  // 清得只剩噪音是另一种错：正文必须还在
  assert.equal(r.text.includes('Mr. Jones, of the Manor Farm'), true);
});

test('章节标题保留——学生要知道这是哪一章', () => {
  const r = studentVersionOf(REAL_LIKE);
  assert.equal(r.text.includes('## Chapter One'), true);
});

test('标题只有**调用方明确给了**才加（按产物第一行猜出来的十有八九是内部版本号）', () => {
  assert.equal(studentVersionOf(REAL_LIKE).text.startsWith('# '), false, '不给标题就不加');
  const withTitle = studentVersionOf(REAL_LIKE, { title: 'Animal Farm · Chapter One' });
  assert.equal(withTitle.text.startsWith('# Animal Farm · Chapter One\n'), true);
});

test('内部小节（词句卡）去掉，并报出小节名', () => {
  const md = `${REAL_LIKE}\n## 词句卡\n\n- windmill（风车）\n- barn（谷仓）\n`;
  const r = studentVersionOf(md);
  assert.equal(r.text.includes('词句卡'), false);
  assert.equal(r.text.includes('windmill（风车）'), false, '词句卡是给教师排课用的，不是读物');
  assert.deepEqual(r.removed.sections, ['词句卡']);
  assert.deepEqual(DEFAULT_DROP_SECTIONS, ['词句卡']);
});

test('可以额外指定要去掉的小节（不给就不去）', () => {
  const md = `${REAL_LIKE}\n## 附录\n\n内部附录\n`;
  assert.equal(studentVersionOf(md).text.includes('附录'), true, '默认不动别的小节');
  const r = studentVersionOf(md, { dropSections: ['附录'] });
  assert.equal(r.text.includes('内部附录'), false);
  assert.deepEqual(r.removed.sections, ['附录'], '这一份里没有词句卡，所以只报附录');
});

/* ────────────────────── ② ★ 占位段：不许默默删掉 ────────────────────── */

test('★ 有占位段就**不能发布**，而且要说清是第几段', () => {
  /* 占位段是"这一段没通过门禁、被隔离了"的记录。
   * 把它默默删掉，学生版会变成一个**读得通的段落序列**——
   * 而中间少了一整段这件事，在成品里长得跟"这一段本来就没有"一模一样。 */
  const md = REAL_LIKE.replace(
    '[P02] As soon as',
    '[P02] <!-- 本段未通过复检（ANNO-01）：见待复核/P02 -->\n\n[P03] As soon as',
  );
  const r = studentVersionOf(md);
  assert.equal(isPublishable(r), false, '**不能发布**');
  assert.equal(r.blockers.length, 1);
  assert.match(r.blockers[0]!, /1 段没通过门禁/);
  assert.match(r.blockers[0]!, /P02/, '要点名是第几段——"少了一段"而不知道少了哪段，等于没说');
  assert.match(r.blockers[0]!, /本来就没有/, '要把后果讲出来：读得通的序列 ≠ 完整的序列');
  // 注释本身当然也不该留在正文里
  assert.equal(r.text.includes('未通过复检'), false);
  assert.match(r.summary, /不能发布/);
});

test('占位段与普通注释：普通注释不用拦，但两者都要报数', () => {
  const md = REAL_LIKE.replace('[P01] Mr. Jones', '[P01] <!-- 校对备注：这处按 1945 年版 --> Mr. Jones');
  const r = studentVersionOf(md);
  assert.equal(isPublishable(r), true, '普通注释只是不发给学生，不是"不能发"');
  assert.equal(r.removed.comments, 1);
  assert.equal(r.text.includes('校对备注'), false);
});

/* ────────────────────── ③ 停下来的那几种情形 ────────────────────── */

test('找不到章节标题就**不发**，并说清为什么', () => {
  const r = studentVersionOf('就是一段没有标题的文字。\n');
  assert.equal(isPublishable(r), false);
  assert.equal(r.text, '');
  assert.match(r.blockers[0]!, /找不到章节标题/);
  assert.match(r.blockers[0]!, /不发/);
});

test('去掉内部内容之后是空的也不发（空文件比没有文件更容易被当成"发过了"）', () => {
  const r = studentVersionOf('# 只有标题\n\n> 只有说明\n\n## Chapter One\n');
  assert.equal(isPublishable(r), false);
  assert.equal(r.blockers.some((b) => /没有正文/.test(b)), true, `实得 ${JSON.stringify(r.blockers)}`);
});

/* ────────────────────── ④ 摘要要说清动了什么 ────────────────────── */

test('摘要逐项报出动了什么（不静默丢东西）', () => {
  const r = studentVersionOf(REAL_LIKE, { title: 'T' });
  for (const bit of ['去内部说明', '去段标记', '去注释']) {
    assert.equal(r.summary.includes(bit), true, `摘要缺「${bit}」：${r.summary}`);
  }
  assert.equal(r.summary.includes(String(r.removed.markers)), true);
});

test('★ 真项目第一章的产物：跑一遍，给出的学生版干净且可发布', () => {
  const p = '/Users/wayne/Desktop/工作文档库/01-教学工作/名著阅读工作区_AnimalFarm/调适工作区/重制三版/第一章/原文_A层85_2026-09-10.md';
  if (!existsSync(p)) return; // 换机器时跳过，而不是假装通过
  const md = readFileSync(p, 'utf-8');
  const r = studentVersionOf(md, { title: 'Animal Farm · Chapter One' });
  assert.equal(isPublishable(r), true, `真产物应当能出学生版：${r.blockers.join('；')}`);
  assert.equal(/\[P\d+\]/.test(r.text), false);
  assert.equal(r.text.includes('清理对齐版'), false);
  assert.equal(r.removed.markers, 14, '这一章是 14 段');
  // 释义是这份产物的重点，一个都不能少
  assert.equal(r.text.includes('（谷仓）'), true);
  assert.equal(r.text.length > md.length * 0.7, true, `学生版不该凭空瘦一大圈：${r.text.length} vs ${md.length}`);
});

/* ────────────────────── ⑤ 端到端：拒绝时**不写文件** ────────────────────── */

test('★ 端到端：有占位段时拒绝发布（退出码 1）且**一个文件都不写**', () => {
  const root = mkdtempSync(join(tmpdir(), 'lt-stu-'));
  const w = (...p: string[]): string => join(root, ...p);
  mkdirSync(w('原文', '第一章'), { recursive: true });
  mkdirSync(w('产物', '第一章'), { recursive: true });
  writeFileSync(w('原文', '第一章', '原文_规范化.md'), '## Chapter One\n\n[P01] The boy ran to the red barn.\n', 'utf-8');
  // 产物里第 2 段是**占位段**（门禁未通过）
  writeFileSync(
    w('产物', '第一章', '原文_A层85_2026-01-01.md'),
    '## Chapter One\n\n[P01] The boy ran to the red barn（谷仓）.\n\n[P02] <!-- 本段未通过复检（SENT-01） -->\n',
    'utf-8',
  );
  writeFileSync(w('词库.csv'), '词,类型\nboy,单词\n', 'utf-8');
  writeFileSync(w('专名表.txt'), '# 专名\n', 'utf-8');
  writeFileSync(w('知识库.csv'), '类型,词,值,次数\n', 'utf-8');
  writeFileSync(w('词典.csv'), '词,释义,来源\n', 'utf-8');
  const json = w('调适项目_自测.json');
  writeFileSync(
    json,
    JSON.stringify({ 书名: 'T', 工作区: root, 调适工作区: w('调适'), 原文目录: w('原文'), 产物目录: w('产物'), 词库: w('词库.csv'), 书级: { 专名表: w('专名表.txt'), 知识库: w('知识库.csv'), 词典: w('词典.csv') }, 日期: '2026-01-01', 章数: 1, 引擎目录: REPO }, null, 2),
    'utf-8',
  );

  const r = spawnSync(process.execPath, [join(REPO, 'tools', 'af_pipeline', 'LayerText_AF学生版.mjs'), '--tier', 'A', '--chapters', '1'], {
    cwd: REPO,
    encoding: 'utf-8',
    env: { ...process.env, LAYERTEXT_PROJECT: json, LAYERTEXT_ENGINE: REPO },
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  assert.equal(r.status, 1, `有占位段就该拒绝发布：${out.slice(-400)}`);
  assert.match(out, /没通过门禁/);
  assert.match(out, /P02/, '要点名是哪一段');
  assert.equal(
    existsSync(w('产物', '第一章', '学生版_A层85_2026-01-01.md')),
    false,
    '**一个文件都不许写**——写了就等于给出了一份"看起来能用、中间却缺一段"的学生版',
  );
  rmSync(root, { recursive: true, force: true });
});

test('★ 端到端：干净产物给出学生版，落在「学生版」这个产物名下（与正文分开）', () => {
  const root = mkdtempSync(join(tmpdir(), 'lt-stu2-'));
  const w = (...p: string[]): string => join(root, ...p);
  mkdirSync(w('原文', '第一章'), { recursive: true });
  mkdirSync(w('产物', '第一章'), { recursive: true });
  writeFileSync(w('原文', '第一章', '原文_规范化.md'), '## Chapter One\n\n[P01] The boy ran to the red barn.\n', 'utf-8');
  writeFileSync(w('产物', '第一章', '原文_A层85_2026-01-01.md'), '# 内部说明\n\n## Chapter One\n\n[P01] The boy ran to the red barn（谷仓）.\n', 'utf-8');
  writeFileSync(w('词库.csv'), '词,类型\nboy,单词\n', 'utf-8');
  writeFileSync(w('专名表.txt'), '# 专名\n', 'utf-8');
  writeFileSync(w('知识库.csv'), '类型,词,值,次数\n', 'utf-8');
  writeFileSync(w('词典.csv'), '词,释义,来源\n', 'utf-8');
  const json = w('调适项目_自测.json');
  writeFileSync(
    json,
    JSON.stringify({ 书名: 'T', 工作区: root, 调适工作区: w('调适'), 原文目录: w('原文'), 产物目录: w('产物'), 词库: w('词库.csv'), 书级: { 专名表: w('专名表.txt'), 知识库: w('知识库.csv'), 词典: w('词典.csv') }, 日期: '2026-01-01', 章数: 1, 引擎目录: REPO }, null, 2),
    'utf-8',
  );

  const r = spawnSync(process.execPath, [join(REPO, 'tools', 'af_pipeline', 'LayerText_AF学生版.mjs'), '--tier', 'A', '--chapters', '1', '--title', 'Animal Farm · Chapter One'], {
    cwd: REPO,
    encoding: 'utf-8',
    env: { ...process.env, LAYERTEXT_PROJECT: json, LAYERTEXT_ENGINE: REPO },
  });
  assert.equal(r.status, 0, `${r.stdout ?? ''}${r.stderr ?? ''}`);
  const dst = w('产物', '第一章', '学生版_A层85_2026-01-01.md');
  assert.equal(existsSync(dst), true, '学生版要落在这个**独立**的产物名下');
  const t = readFileSync(dst, 'utf-8');
  assert.equal(t.startsWith('# Animal Farm · Chapter One'), true);
  assert.equal(/\[P\d+\]/.test(t), false);
  assert.equal(t.includes('内部说明'), false);
  assert.equal(t.includes('（谷仓）'), true, '释义要跟着走——那是理解支架');
  // 教师工作稿一个字都不许被动
  assert.equal(readFileSync(w('产物', '第一章', '原文_A层85_2026-01-01.md'), 'utf-8').includes('[P01]'), true, '工作稿必须原样保留');
  rmSync(root, { recursive: true, force: true });
});
