// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，本仓库已部署版权验证体系，细节不予公开（docs/版权与授权.md）。
/**
 * LayerText · 章节文档的中间表示（AST）
 *
 * 审查报告 §四 的原话：「`word（中文）` 和 `[P##]` 可以保留为发布格式，但内部应转成
 * AST/中间表示；发布时再序列化。这样不改变教师可见格式，却避免正则在连字符、多义词、
 * 嵌套标记上失真。迁移代价是一次性写解析器、为旧文件生成稳定 ID，并在对齐失败时进入人工队列。」
 *
 * 为什么正则终究不够：
 *   · `word（中文）` 里 word 可以带连字符与撇号，释义里可能再出现括号或另一个「词（中文）」
 *     （模型偶尔会嵌套输出），正则只看得到"第一个 `（` 到第一个 `）`"；
 *   · 同一个词在不同位置注了不同释义，正则扫一遍只能各自为政，拼不出"这本书里同一个词注了两种说法"；
 *   · 段落是 `[P##]` 编号的，可一个段号一旦缺失或重复，所有按顺序配对的逻辑（台账、风险队列、
 *     逐句对照）会**整体错位**，而按标记配对又要求标记存在且唯一。
 *
 * 三个设计约束（缺一不可）：
 *   ① **往返是恒等的**：`serialize(parse(x)) === x`，一个字节都不许变。
 *      否则"内部转 AST"会悄悄改写教师手里的书稿——这比正则失真更严重。
 *   ② **教师可见格式不变**：序列化出来还是 `[P07] … word（中文） …`，没有新语法。
 *   ③ **旧文件也能进**：没有 `[P##]` 的旧稿按段序补稳定 ID；补不上的进人工队列，不猜。
 */

import { parseAnnotations, type Annotation } from './annot.js';
import { sentsOf } from './textpipe.js';

export const DOC_AST_VERSION = 1;

/** 段内的一段内联内容 */
export interface TextSpan {
  kind: 'text';
  text: string;
}
/** 段内的一条注释（保留原词与释义，且记下它在段内的位置） */
export interface AnnotationSpan {
  kind: 'annotation';
  /** 原词（保留原始大小写；报告要求"保存原词"） */
  word: string;
  /** 中文释义 */
  zh: string;
  /** 在段内（`raw` 中）的起止下标，用于精确改写而不重排整段 */
  start: number;
  end: number;
}

export type InlineSpan = TextSpan | AnnotationSpan;

export interface SegmentNode {
  /** 稳定 ID：`P07`（来自 `[P##]`；旧文件按段序补） */
  id: string;
  /** 段标记原文（含方括号），序列化时原样写回 */
  marker: string;
  /** 段标记与原段首内容之间的空白（一般是换行或空格） */
  prefix: string;
  /** 段正文（不含标记） */
  raw: string;
  /** 解析出的内联结构（与 raw 一一对应，可精确重建） */
  spans: InlineSpan[];
  /** 该段的 ID 是解析出来的还是补出来的 */
  idSource: 'marker' | 'assigned';
}

export interface DocAst {
  schemaVersion: number;
  /** `## Chapter` 行之前的全部内容（含可能的 BOM/空行） */
  header: string;
  /** `## Chapter One` 这一行（含行首行尾空白，原样保留） */
  chapterLine: string;
  /** 正文区（`## Chapter` 行之后、`## 词句卡` 之前）里段与段之间的分隔符，按段序排列
   *  长度 = segments.length + 1（首尾各一段"夹缝"文本）；序列化时原样写回 */
  gaps: string[];
  segments: SegmentNode[];
  /** `## 词句卡` 之后的全部内容（含标记行本身）；无词句卡时为空串 */
  tail: string;
  /** 解析时发现的问题（不阻断解析，交给人看） */
  issues: DocIssue[];
}

export type DocIssueKind =
  /** 段标记缺失（旧文件）——已按段序补 ID，但**对齐关系是猜的**，需要人确认 */
  | 'marker-missing'
  /** 段标记重复（同一章里出现两次 [P03]）——按标记配对会整体错位 */
  | 'marker-duplicate'
  /** 段号不连续（P01, P02, P05）——可能漏段 */
  | 'marker-gap'
  /** 注释未闭合（有 `（` 没有 `）`，或反之） */
  | 'annotation-unclosed'
  /** 注释里又出现注释（模型偶尔嵌套输出） */
  | 'annotation-nested'
  /** 同一个词在这份文档里注了不同释义 */
  | 'sense-conflict';

export interface DocIssue {
  kind: DocIssueKind;
  /** 发生在哪一段（补出的 ID 也算） */
  segId: string;
  /** 人话描述 */
  message: string;
  /** 需要人处理吗（true = 进人工队列；false = 已自动修复或仅提示） */
  needsHuman: boolean;
  detail?: Record<string, unknown>;
}

const MARKER_RE = /\[(P\d+)\]/g;

/** 解析章节 Markdown → AST。**不改内容**，只建结构。 */
export function parseDoc(md: string): DocAst {
  const issues: DocIssue[] = [];
  const hm = md.match(/## Chapter \w+[^\n]*/);
  const header = hm ? md.slice(0, hm.index ?? 0) : '';
  const chapterLine = hm ? hm[0] : '';
  const afterChapter = hm ? md.slice((hm.index ?? 0) + chapterLine.length) : md;
  const cardIdx = afterChapter.indexOf('## 词句卡');
  const body = cardIdx >= 0 ? afterChapter.slice(0, cardIdx) : afterChapter;
  const tail = cardIdx >= 0 ? afterChapter.slice(cardIdx) : '';

  // 按 [P##] 标记切：记录每段的标记、标记后的空白、正文，以及段与段之间的"夹缝"
  const marks = [...body.matchAll(MARKER_RE)];
  const segments: SegmentNode[] = [];
  const gaps: string[] = [];
  if (!marks.length) {
    // 旧文件：没有段落标记。整块正文当成一段，补一个稳定 ID 并**标记为需要人确认**
    const raw = body;
    const id = 'P01';
    issues.push({
      kind: 'marker-missing',
      segId: id,
      message: '正文里没有任何 [P##] 段落标记——已按段序补 ID，但这意味着段落对齐是"猜"的，请人工确认分段',
      needsHuman: true,
      detail: { bodyLength: body.length },
    });
    segments.push({ id, marker: '', prefix: '', raw, spans: spansOf(raw), idSource: 'assigned' });
    gaps.push('');
    return { schemaVersion: DOC_AST_VERSION, header, chapterLine, gaps, segments, tail, issues };
  }

  gaps.push(body.slice(0, marks[0]!.index ?? 0));
  const seen = new Set<string>();
  marks.forEach((m, i) => {
    const id = m[1]!;
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < marks.length ? (marks[i + 1]!.index ?? body.length) : body.length;
    const chunk = body.slice(start, end);
    // 标记后的第一段空白（缩进/换行）单独存：序列化时原样写回，避免把"标记与正文之间"的格式吃掉
    const ws = chunk.match(/^[ \t]*\n?[ \t]*/)?.[0] ?? '';
    const raw = chunk.slice(ws.length);
    if (seen.has(id)) {
      issues.push({
        kind: 'marker-duplicate',
        segId: id,
        message: `段标记 [${id}] 在同一章里出现了不止一次——按标记配对会整体错位`,
        needsHuman: true,
        detail: { index: i },
      });
    }
    seen.add(id);
    segments.push({ id, marker: m[0], prefix: ws, raw, spans: spansOf(raw), idSource: 'marker' });
    if (i + 1 < marks.length) gaps.push('');
  });
  // 段间夹缝：本实现里段与段之间没有内容（下一段的标记紧接上一段），保留接口以便将来扩展
  while (gaps.length < segments.length + 1) gaps.push('');

  // 段号连续性
  const nums = segments.map((s) => Number(s.id.slice(1))).filter((n) => Number.isFinite(n));
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] !== nums[i - 1]! + 1) {
      issues.push({
        kind: 'marker-gap',
        segId: segments[i]!.id,
        message: `段号不连续：${segments[i - 1]!.id} → ${segments[i]!.id}（可能漏段）`,
        needsHuman: true,
        detail: { from: segments[i - 1]!.id, to: segments[i]!.id },
      });
    }
  }

  issues.push(...structuralIssues(segments));
  issues.push(...senseConflicts(segments));
  return { schemaVersion: DOC_AST_VERSION, header, chapterLine, gaps, segments, tail, issues };
}

/** 段内解析：把 `word（中文）` 切成 text / annotation 两种 span，位置精确到字符 */
function spansOf(raw: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  const anns: Annotation[] = parseAnnotations(raw).list;
  let at = 0;
  for (const a of anns) {
    const end = a.index + a.word.length + 1 + a.zh.length + 1; // word + （ + zh + ）
    if (end > raw.length || a.index < at) continue;
    if (a.index > at) spans.push({ kind: 'text', text: raw.slice(at, a.index) });
    spans.push({ kind: 'annotation', word: a.word, zh: a.zh, start: a.index, end });
    at = end;
  }
  if (at < raw.length) spans.push({ kind: 'text', text: raw.slice(at) });
  return spans;
}

/**
 * 括号深度扫描：找出"注释里套注释"。
 * 为什么不能用 parseAnnotations：它的释义字符类是 `[^（）]`，外层这种畸形注释它**根本匹配不到**
 * ——这正是报告说的"正则解析在嵌套标记上失真"的现场，所以另写一个按深度走的扫描器。
 */
interface NestedHit {
  /** 外层注释在 raw 中的完整区间（含 `（` 与 `）`） */
  start: number;
  end: number;
  word: string;
  zh: string;
  innerWord: string;
  innerZh: string;
}

function scanNested(raw: string): NestedHit[] {
  const stack: number[] = [];
  const pairs: [number, number][] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '（') stack.push(i);
    else if (raw[i] === '）') {
      const s = stack.pop();
      if (s !== undefined) pairs.push([s, i]);
    }
  }
  const out: NestedHit[] = [];
  for (const [s, e] of pairs) {
    const inner = pairs.find(([s2, e2]) => s2 > s && e2 < e);
    if (inner === undefined) continue;
    // 外层必须是一个注释（`word（`），但**内层不要求有英文词**——
    // `Mollie（莫丽（名字））` 这种内层前面是中文字，卡死在这上面就永远查不出嵌套。
    const m = raw.slice(0, s).match(/([A-Za-z][A-Za-z'-]*)$/);
    if (!m) continue;
    const im = raw.slice(0, inner[0]).match(/([A-Za-z][A-Za-z'-]*)$/);
    out.push({
      start: (m.index ?? 0),
      end: e + 1,
      word: m[1]!,
      zh: raw.slice(s + 1, e),
      innerWord: im?.[1] ?? '',
      innerZh: raw.slice(inner[0] + 1, inner[1]),
    });
  }
  return out;
}

/** 畸形注释的释义该留什么：**第一个 1–6 字的汉字串**。
 *  这与 2026-09-10 修复脚本既有的行为一致（教师可见结果不变），
 *  区别只在于判定嵌套用的是括号深度而不是一条只能处理一层嵌套的正则。 */
function glossOfNested(zh: string): string {
  const runs = zh.match(/[\u4e00-\u9fff]{1,6}/g);
  return runs?.length ? runs[0]! : zh.replace(/[（）]/g, '');
}

/** 结构性检查：未闭合、嵌套 */
function structuralIssues(segments: SegmentNode[]): DocIssue[] {
  const out: DocIssue[] = [];
  for (const seg of segments) {
    const open = (seg.raw.match(/（/g) ?? []).length;
    const close = (seg.raw.match(/）/g) ?? []).length;
    if (open !== close) {
      out.push({
        kind: 'annotation-unclosed',
        segId: seg.id,
        message: `全角括号不配对（（ ${open} 个 / ） ${close} 个）——正则解析在这里必然失真`,
        needsHuman: false,
        detail: { open, close },
      });
    }
    for (const h of scanNested(seg.raw)) {
      out.push({
        kind: 'annotation-nested',
        segId: seg.id,
        message: `注释里又套了一层注释：${h.word}（${h.zh}）${h.innerWord ? `——外层释义里还有 ${h.innerWord}（${h.innerZh}）` : ''}`,
        needsHuman: false,
        detail: { word: h.word, zh: h.zh, inner: `${h.innerWord}（${h.innerZh}）` },
      });
    }
  }
  return out;
}

/** 同一份文档里同一个词注了不同释义 */
function senseConflicts(segments: SegmentNode[]): DocIssue[] {
  const byWord = new Map<string, { zh: Set<string>; segs: string[] }>();
  for (const seg of segments) {
    for (const s of seg.spans) {
      if (s.kind !== 'annotation') continue;
      const k = s.word.toLowerCase();
      if (!byWord.has(k)) byWord.set(k, { zh: new Set(), segs: [] });
      const e = byWord.get(k)!;
      e.zh.add(s.zh);
      if (!e.segs.includes(seg.id)) e.segs.push(seg.id);
    }
  }
  const out: DocIssue[] = [];
  for (const [word, e] of byWord) {
    if (e.zh.size < 2) continue;
    out.push({
      kind: 'sense-conflict',
      segId: e.segs[0]!,
      message: `同一个词注了 ${e.zh.size} 种释义：${word} → ${[...e.zh].join(' / ')}（全篇必须同词同义）`,
      needsHuman: false,
      detail: { word, senses: [...e.zh], segments: e.segs },
    });
  }
  return out;
}

/**
 * AST → Markdown。**未改动的 AST 必须逐字节还原原文**（这是本模块存在的前提）。
 * 只重写被改过的段：没改的段直接把 `marker + prefix + raw` 拼回去，不做任何规范化。
 */
export function serializeDoc(ast: DocAst): string {
  const parts: string[] = [ast.header, ast.chapterLine];
  ast.segments.forEach((s, i) => {
    parts.push(ast.gaps[i] ?? '');
    parts.push(s.marker, s.prefix, s.raw);
  });
  parts.push(ast.gaps[ast.segments.length] ?? '');
  parts.push(ast.tail);
  return parts.join('');
}

/* ────────────────────── 编辑操作（都走 span 下标，不重新格式化整段） ────────────────────── */

/** 在指定段里把某个词的注释改成另一个释义（找不到则不改，返回 false） */
export function setSense(ast: DocAst, segId: string, word: string, zh: string): boolean {
  const seg = ast.segments.find((s) => s.id === segId);
  if (!seg) return false;
  const hit = seg.spans.find((s): s is AnnotationSpan => s.kind === 'annotation' && s.word.toLowerCase() === word.toLowerCase());
  if (!hit) return false;
  seg.raw = seg.raw.slice(0, hit.start) + `${hit.word}（${zh}）` + seg.raw.slice(hit.end);
  seg.spans = spansOf(seg.raw);
  return true;
}

/** 去掉指定段里某个词的注释（还原为裸词） */
export function removeAnnotation(ast: DocAst, segId: string, word: string): boolean {
  const seg = ast.segments.find((s) => s.id === segId);
  if (!seg) return false;
  const hit = seg.spans.find((s): s is AnnotationSpan => s.kind === 'annotation' && s.word.toLowerCase() === word.toLowerCase());
  if (!hit) return false;
  seg.raw = seg.raw.slice(0, hit.start) + hit.word + seg.raw.slice(hit.end);
  seg.spans = spansOf(seg.raw);
  return true;
}

/** 该段是否为占位段（门禁未通过留下的空位） */
export const isPlaceholder = (seg: SegmentNode): boolean => /<!--\s*本段未通过复检/.test(seg.raw);

/** 文档级修复：能确定性修的就修（嵌套注释扁平成一层、同词多义统一为首次出现的释义）。
 *  返回改了什么；改不动的留给 `issues` 里的人。 */
export function applyRepairs(ast: DocAst): { nested: number; senses: number; remaining: DocIssue[] } {
  let nested = 0;
  let senses = 0;
  // ① 同词多义：以**首次出现**的释义为正（与"一个词全篇只注一次"的正本一致）
  const canonical = new Map<string, string>();
  for (const seg of ast.segments) {
    for (const s of seg.spans) {
      if (s.kind !== 'annotation') continue;
      const k = s.word.toLowerCase();
      const zh = canonical.get(k);
      if (zh === undefined) canonical.set(k, s.zh);
      else if (zh !== s.zh && setSense(ast, seg.id, s.word, zh)) senses++;
    }
  }
  // ② 嵌套注释扁平化
  nested += flattenNesting(ast);
  ast.issues = [...structuralIssues(ast.segments), ...senseConflicts(ast.segments)];
  return { nested, senses, remaining: ast.issues.filter((i) => i.needsHuman) };
}

/**
 * 只做"嵌套注释扁平化"（不碰同词多义）。
 * 单独抽出来是给 `LayerText_AF修复_20260910.mjs` 用的：那个脚本有自己的一套
 * 跨文件多数票归一逻辑，不该被这里的"同文档首次出现为准"覆盖；
 * 但**嵌套怎么算**这件事两处必须同一份实现——否则又是一次口径漂移。
 */
export function flattenNesting(ast: DocAst): number {
  let nested = 0;
  for (const seg of ast.segments) {
    let guard = 0;
    while (guard++ < 20) {
      // 从右往左替换，避免前面的改动让后面的下标漂移
      const hits = scanNested(seg.raw).sort((a, b) => b.start - a.start);
      if (!hits.length) break;
      for (const h of hits) {
        seg.raw = seg.raw.slice(0, h.start) + `${h.word}（${glossOfNested(h.zh)}）` + seg.raw.slice(h.end);
        nested++;
      }
      seg.spans = spansOf(seg.raw);
    }
  }
  return nested;
}

/** 文本级便捷入口：只摊平嵌套注释 */
export function flattenNestedAnnotations(md: string): { md: string; nested: number } {
  const ast = parseDoc(md);
  const nested = flattenNesting(ast);
  return { md: nested ? serializeDoc(ast) : md, nested };
}

/** 文本级便捷入口：解析 → 修复 → 序列化（幂等；干净的文档逐字节不变） */
export function repairDoc(md: string): { md: string; changed: boolean; nested: number; senses: number; issues: DocIssue[] } {
  const ast = parseDoc(md);
  const r = applyRepairs(ast);
  const out = serializeDoc(ast);
  return { md: out, changed: out !== md, nested: r.nested, senses: r.senses, issues: ast.issues };
}

/** 段正文里的句子（与引擎分句同一口径，供核对面板用） */
export const sentencesOfSegment = (seg: SegmentNode): string[] => sentsOf(seg.raw, false);
