/** EPUB 导入 / 审校档案 md 构建 / 书级看板汇总 —— 纯逻辑测试 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { boardSummary, buildChapterDossierMd, dossierFileName, epubChapterMd, parseEpubChapters } from '../app/src/bookpure.js';

/* ---------- epub ---------- */

function miniEpub(): Uint8Array {
  const container = `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
  const opf = `<?xml version="1.0"?>
<package xmlns:dc="http://purl.org/dc/elements/1.1/">
  <metadata><dc:title>Animal Farm &amp; Us</dc:title></metadata>
  <manifest>
    <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`;
  const ch1 = `<html><head><title>Chapter One</title></head><body><h1>One</h1><p>Mr. Jones locked the hen&#45;houses.</p><p>He was &amp; glad.</p><p></p></body></html>`; // h1 不进段落（标题已由 title 提供）
  const ch2 = `<html><head><title>Chapter Two</title></head><body><p>The animals met in the barn.</p></body></html>`;
  return zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(container),
    'OEBPS/content.opf': strToU8(opf),
    'OEBPS/ch1.xhtml': strToU8(ch1),
    'OEBPS/ch2.xhtml': strToU8(ch2),
  });
}

test('parseEpubChapters：container→opf→spine 顺序抽章，实体解码，空段丢弃', () => {
  const { bookTitle, chapters } = parseEpubChapters(miniEpub());
  assert.equal(bookTitle, 'Animal Farm & Us'); // &amp; 解码
  assert.equal(chapters.length, 2); // nav.xhtml 不在 spine
  assert.equal(chapters[0]!.title, 'Chapter One');
  assert.deepEqual(chapters[0]!.paragraphs, ['Mr. Jones locked the hen-houses.', 'He was & glad.']); // 实体解码、空段丢弃、h1 不入正文
  assert.equal(chapters[1]!.paragraphs.length, 1);
});

test('parseEpubChapters：坏文件如实报错', () => {
  assert.throws(() => parseEpubChapters(strToU8('not a zip')), /unzip|zip|epub|文件/i);
});

test('epubChapterMd：包装成章节格式（标题 + [P01] 段标）', () => {
  const md = epubChapterMd('Animal Farm', { title: 'Chapter One', paragraphs: ['First para.', 'Second para.'] });
  assert.match(md, /# Animal Farm — Chapter One/);
  assert.match(md, /## Chapter One/);
  assert.match(md, /\[P01\] First para\./);
  assert.match(md, /\[P02\] Second para\./);
});

/* ---------- 审校档案 ---------- */

const DOSSIER = {
  书名: '调适工作区',
  章名: '第一章',
  版本: 'B层工作区',
  生成时间: '2026/9/8 22:00:00',
  句长上限: 16,
  基准摘要: { newWordRate: 0.082, avgLen: 18.4, sentCount: 90, passive: 12, relcl: 5, pastperf: 2, oovCount: 41 },
  当前摘要: { newWordRate: 0.021, avgLen: 10.2, sentCount: 95, passive: 0, relcl: 0, pastperf: 0, oovCount: 9 },
  对照: {
    对齐: 87,
    丢句: [{ pos: 'P02·01', base: 'The wind broke the windmill.', lost: [] }],
    信号缺失: [{ pos: 'P03·02', cur: 'Napoleon told the pigs to remember the commandments.', lost: ['7'] }],
    新增: ['Snowball planned the windmill for many weeks.'],
  },
  台账: [{ ts: '2026-09-08 21:00', markType: '词汇简化', outcome: '采纳', original: 'utilize the harness', revised: 'use the harness', basis: '词表外→词表内' }],
  标记: [
    { label: '词汇简化', n: 3 },
    { label: '超纲', n: 2 },
  ],
  门禁: { 事实核对: true, 情节要点齐全: false, 段落对齐: true, 'QC 指标达标': false },
};

test('buildChapterDossierMd：四节齐全（指标对照/对照摘要/决策记录/标记门禁）', () => {
  const md = buildChapterDossierMd(DOSSIER);
  assert.match(md, /# 审校档案 ·《调适工作区》第一章（B层工作区）/);
  assert.match(md, /\| ② 生词率 \| 8\.2% \| 2\.1% \|/); // 基准列在前
  assert.match(md, /对齐 87 句 ｜ 疑似丢句 1 ｜ 信号缺失 1 处 ｜ 新增 1/);
  assert.match(md, /P02·01：The wind broke the windmill\./);
  assert.match(md, /缺：7/);
  assert.match(md, /\| 2026-09-08 21:00 \| 词汇简化 \| 采纳 \|/);
  assert.match(md, /标记 5 处：词汇简化 3／超纲 2/);
  assert.match(md, /事实核对 ✓\u3000情节要点齐全 ✗/); // \u3000=全角空格（门禁分隔符）
});

test('buildChapterDossierMd：无基准无对照时降级为两节且无基准列', () => {
  const md = buildChapterDossierMd({ ...DOSSIER, 基准摘要: undefined, 对照: undefined, 台账: [] });
  assert.doesNotMatch(md, /基准版/);
  assert.match(md, /## 二、决策记录（AI 建议台账·本章）/);
  assert.match(md, /（本章暂无 AI 建议记录）/);
});

test('dossierFileName：章号映射与日期后缀', () => {
  assert.equal(dossierFileName('/book/第一章/候选版.md', '2026-09-08'), '审校档案_第一章_2026-09-08.md');
  assert.equal(dossierFileName('preface', '2026-09-08'), '审校档案_preface_2026-09-08.md');
});

/* ---------- 看板汇总 ---------- */

test('boardSummary：过门禁/平均生词率/总标记/采纳率', () => {
  const rows = [
    { path: '/a', 章: '一', 门禁勾选: 4, 门禁总数: 4, 标记数: 3, 书签数: 1, 生词率: 0.02, 建议数: 10, 采纳数: 8, 当前: true },
    { path: '/b', 章: '二', 门禁勾选: 1, 门禁总数: 4, 标记数: 5, 书签数: 0, 生词率: 0.04, 建议数: 10, 采纳数: 2, 当前: false },
    { path: '/c', 章: '三', 门禁勾选: 0, 门禁总数: 4, 标记数: 0, 书签数: 0, 生词率: null, 建议数: 0, 采纳数: 0, 当前: false },
  ];
  const sum = boardSummary(rows);
  assert.equal(sum.过门禁, '1/3');
  assert.equal(sum.平均生词率, '3.0%'); // (2%+4%)/2，null 不计入
  assert.equal(sum.总标记, 8);
  assert.equal(sum.采纳率, '50%（10/20）'); // 采纳+直改口径
});
