/**
 * 书级纯逻辑域（WP-F 拆分）：全书批处理队列规划与书级报告 / 班级多人定制目标合并 /
 * 工作区解析（_工作区.json）/ 书架书封与过滤 / EPUB 导入解析 / 审校过程档案与书级看板汇总
 * —— 从 pure.ts 整块迁出（单章文本与 AI 形态纯逻辑留在 pure.ts），行为零变化。
 */

import { chnoFromPath } from './pure.js';

/* ---------- 全书批处理（O2）：队列规划与书级汇总报告（纯逻辑可测） ---------- */

/** 进度文件（书稿文件夹/_全书批处理进度.json）：中断可续跑——done 的章下次自动跳过 */
export interface BatchProgressFile {
  date: string;
  instructions: string;
  /** key = 章节源文件完整路径 */
  status: Record<string, 'done' | 'failed'>;
}

export interface BatchChapterItem {
  path: string;
  name: string;
  /** 上次批处理已完成（续跑时默认跳过） */
  done: boolean;
  /** 源文本段落数（[P##] 计数；供队列预估） */
  segCount: number;
}

/** 队列规划：全部候选文件 + 进度文件 → 待跑清单（保持文件名排序；done 项保留在列表中供界面展示"已完成"） */
export function planBatchChapters(paths: string[], progress: BatchProgressFile | null): BatchChapterItem[] {
  return paths.map((path) => ({
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    done: progress?.status[path] === 'done',
    segCount: 0,
  }));
}

export interface BookReportRow {
  chapter: string;
  output: string;
  segCount: number;
  /** 生词率（词型） */
  oovRate: string;
  avgLen: string;
  maxLen: number;
  passive: number;
  relcl: number;
  pastperf: number;
  overlong: number;
  /** 书级替换规则残留总数 */
  ruleLeft: number;
  elapsedMs: number;
  outTokens: number;
  status: 'done' | 'failed';
  error?: string;
  /** 篇幅收缩百分比（正=缩，负=扩写；同义转换守恒口径，>15 进复查提示） */
  shrinkPct?: number;
}

/** 书级汇总报告（全书简化报告_日期.md）：各章指标横向表 + 合计 + 人工复查提示 */
export function buildBookReportMd(rows: BookReportRow[], meta: { book: string; date: string; maxLen: number; instructions?: string; provider?: string }): string {
  const done = rows.filter((r) => r.status === 'done');
  const sum = (f: (r: BookReportRow) => number): number => done.reduce((n, r) => n + f(r), 0);
  const cell = (r: BookReportRow, f: (x: BookReportRow) => number | string): string => (r.status === 'failed' ? '—' : String(f(r)));
  const lines: string[] = [`# 全书简化报告 · ${meta.book}`, '', `- 日期：${meta.date}｜简化标准：句长上限 ${meta.maxLen} 词/句｜完成 ${done.length}/${rows.length} 章`];
  if (meta.instructions) lines.push(`- 方向指令：${meta.instructions}`);
  if (meta.provider) lines.push(`- AI 供应商：${meta.provider}`);
  lines.push(
    '',
    '| 章 | 产物 | 段数 | 篇幅收缩 | 生词率 | 平均句长 | 最长句 | 被动 | 定从 | 过去完成 | 超长 | 规则残留 | 耗时 | 出tokens |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${r.chapter} | ${r.status === 'failed' ? '（失败）' : r.output} | ${cell(r, (x) => x.segCount)} | ${cell(r, (x) => (x.shrinkPct === undefined ? '—' : x.shrinkPct >= 0 ? `−${x.shrinkPct}%` : `+${-x.shrinkPct}%`))} | ${cell(r, (x) => x.oovRate)} | ${cell(r, (x) => x.avgLen)} | ${cell(r, (x) => x.maxLen)} | ${cell(r, (x) => x.passive)} | ${cell(r, (x) => x.relcl)} | ${cell(r, (x) => x.pastperf)} | ${cell(r, (x) => x.overlong)} | ${cell(r, (x) => x.ruleLeft)} | ${cell(r, (x) => `${(x.elapsedMs / 1000).toFixed(0)}s`)} | ${cell(r, (x) => x.outTokens)} |`,
    ),
    `| **合计** | | ${sum((r) => r.segCount)} | | | | ${sum((r) => r.passive)} | ${sum((r) => r.relcl)} | ${sum((r) => r.pastperf)} | ${sum((r) => r.overlong)} | ${sum((r) => r.ruleLeft)} | ${(sum((r) => r.elapsedMs) / 1000).toFixed(0)}s | ${sum((r) => r.outTokens)} |`,
    '',
  );
  const attention = rows.filter((r) => r.status === 'failed' || (r.status === 'done' && (r.passive + r.relcl + r.pastperf + r.overlong > 0 || r.ruleLeft > 0 || (r.shrinkPct ?? 0) > 15)));
  if (attention.length) {
    lines.push('## 建议人工复查', '');
    for (const r of attention) {
      if (r.status === 'failed') lines.push(`- ${r.chapter}：简化失败（${r.error ?? '原因未知'}）——可单独打开该章用「📖 整章改写」处理`);
      else {
        const bits = [
          r.passive ? `被动 ${r.passive}` : '',
          r.relcl ? `定从 ${r.relcl}` : '',
          r.pastperf ? `过去完成 ${r.pastperf}` : '',
          r.overlong ? `超长 ${r.overlong}` : '',
          r.ruleLeft ? `替换规则残留 ${r.ruleLeft} 处` : '',
          (r.shrinkPct ?? 0) > 15 ? `篇幅收缩 ${r.shrinkPct}%（超守恒线，检查是否丢细节）` : '',
        ].filter(Boolean);
        lines.push(`- ${r.chapter}：${bits.join('、')}——打开产物做标记精修`);
      }
    }
    lines.push('');
  } else if (done.length) {
    lines.push('全部章节黑名单清零、无规则残留 🎉 逐章打开产物做标记精修即可。', '');
  }
  lines.push('> 指标口径与单章体检一致（黑名单=被动/定从/过去完成一律禁用；超长=超过简化标准句长上限）。产物文件与本章报告在同一文件夹。');
  return lines.join('\n');
}

/* ---------- 班级多人定制（feature/reinforce）：分组/个人目标合并（纯逻辑，测试全假数据） ---------- */

export interface ClassTarget {
  id: string; // 如 "组:B" / "人:焦佳琪"
  名称: string; // 显示名，如 "B层(32人)" / "焦佳琪(B)"
  类型: '组' | '人';
  句长上限?: number; // 缺省用全局简化标准
  覆盖目标?: number; // 该目标覆盖目标带下限%（分层个体化：B98/M97/A95，文献95/98群体均值的分层版）
  成员数?: number;
  已学词?: string[]; // 该目标的已学词集（个人/组内合并）
  到期词?: string[]; // 本篇应复现的到期队列
}

export interface MergedTargets {
  active: boolean;
  minLen: number; // 最严句长上限（无选择=全局）
  coverageTarget: number | null; // 多目标取最严覆盖目标带（max）；无=用文献通用 95/98
  knownInter: string[]; // 已学词交集（只在有个人词集的目标间求交；组词集=全体成员并集，参与交集）
  dueUnion: string[]; // 到期词并集（稳定序：被选次数降序→字母序，上限 12——"尽量多复现"教师指令）
  label: string; // 目标标签（命名/提示用）
}

/** 多选合并口径：句长取最严、已学词取交集、到期词取并集（5-8 词/篇的复现预算） */
export function mergeTargets(selected: ClassTarget[], globalMaxLen: number, dueCap = 12): MergedTargets {
  if (selected.length === 0) {
    return { active: false, minLen: globalMaxLen, coverageTarget: null, knownInter: [], dueUnion: [], label: '' };
  }
  const minLen = Math.min(globalMaxLen, ...selected.map((t) => t.句长上限 ?? globalMaxLen));
  const covs = selected.map((t) => t.覆盖目标).filter((c): c is number => typeof c === 'number');
  const coverageTarget = covs.length ? Math.max(...covs) : null;
  // 交集：只在提供了已学词的目标之间求交；目标词集为空数组=“无个人数据”不参与（避免空交吞掉全部）
  const withWords = selected.filter((t) => (t.已学词?.length ?? 0) > 0);
  let knownInter: string[] = [];
  if (withWords.length > 0) {
    const sets = withWords.map((t) => new Set(t.已学词!));
    knownInter = [...sets[0]].filter((w) => sets.every((s) => s.has(w))).sort();
  }
  // 并集：按被选目标出现次数降序，同频字母序，截断 dueCap
  const freq = new Map<string, number>();
  for (const t of selected) for (const w of t.到期词 ?? []) freq.set(w, (freq.get(w) ?? 0) + 1);
  const dueUnion = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, dueCap)
    .map(([w]) => w);
  const label = selected.map((t) => t.名称).join('+');
  return { active: true, minLen, coverageTarget, knownInter, dueUnion, label: label.length > 28 ? label.slice(0, 27) + '…' : label };
}

/** 个人目标搜索过滤（折叠多选栏的过滤框） */
export function filterTargets(targets: ClassTarget[], q: string): ClassTarget[] {
  const s = q.trim().toLowerCase();
  if (!s) return targets;
  return targets.filter((t) => t.名称.toLowerCase().includes(s) || t.id.toLowerCase().includes(s));
}

/* ---------- 工作区（2026-09-08 Wayne 指令：3 层次=3 工作区，像浏览器标签切换） ---------- */

export interface Workspace {
  名: string; // 如 "B层工作区"
  定制目标?: string; // 绑定的班级定制目标 id（如 "组:B"），激活工作区时自动勾选
  文件: string[]; // 章节文件绝对路径（按序展示为章节 chips）
}

/** 解析书目录 _工作区.json（宽容：缺字段/空文件列表跳过；返回 [] 表示无工作区） */
export function parseWorkspaces(raw: string): Workspace[] {
  let j: { 工作区?: unknown };
  try {
    j = JSON.parse(raw) as { 工作区?: unknown };
  } catch {
    return [];
  }
  if (!Array.isArray(j.工作区)) return [];
  const out: Workspace[] = [];
  for (const w of j.工作区 as Array<Record<string, unknown>>) {
    const 名 = typeof w.名 === 'string' ? w.名.trim() : '';
    const files = Array.isArray(w.文件) ? (w.文件 as unknown[]).filter((f): f is string => typeof f === 'string' && f.trim() !== '') : [];
    if (!名 || files.length === 0) continue;
    out.push({ 名, 定制目标: typeof w.定制目标 === 'string' ? w.定制目标 : undefined, 文件: files });
  }
  return out;
}

/** 工作区章节 chip 显示名：候选版文件（同层各章同名）取目录名（第一章），否则取文件名去扩展 */
export function workspaceChipName(path: string): string {
  const file = path.slice(path.lastIndexOf('/') + 1).replace(/\.(md|txt|markdown|docx)$/i, '');
  if (file.startsWith('候选版')) {
    const dir = path.slice(0, path.lastIndexOf('/')).split('/').pop() ?? '';
    if (/^第.{1,4}章$|^Chapter/i.test(dir)) return dir; // 只认章节目录名，避免普通目录名误用
  }
  return file || path;
}

/* ---------- 书架书封（2026-09-08 Wayne：正常书比例 + 书名当封面字号自适应 + 两级导航） ---------- */

/** 书名视觉宽度（CJK 全角=1、其余≈0.55），用于封面字号分档 */
export function coverVisualWidth(title: string): number {
  let w = 0;
  for (const ch of title) w += /[\u2e80-\u9fff\u3000-\u303f\u30a0-\u30ff\uff00-\uffef]/.test(ch) ? 1 : 0.55;
  return w;
}

/** 文字封面的书名字号：按视觉宽度分档收缩，保证除极端长名外书名完整可见（长名最多 4 行换行显示） */
/** 文字封面的书名字号：按视觉宽度分档收缩（基准 150px 宽书封），并随容器宽度等比缩放——小容器里字号不缩，书名逐字断行看着就像乱码 */
export function coverTitlePx(title: string, boxW = 150): number {
  const w = coverVisualWidth(title);
  const base = w <= 3.5 ? 30 : w <= 5 ? 26 : w <= 7 ? 21 : w <= 10 ? 18 : w <= 14 ? 15 : 12.5;
  return Math.round(((base * boxW) / 150) * 10) / 10;
}

export interface VersionCardInfo {
  idx: number;
  名: string;
  desc: string;
  first: string;
  target?: string;
}

/** 版本选择页卡片数据（点书 → 先选版本 → 再进工作区）：desc=章数+绑定口径，first=第一章 chip 名 */
export function buildVersionCards(ws: Workspace[]): VersionCardInfo[] {
  return ws.map((w, idx) => ({
    idx,
    名: w.名,
    desc: `${w.文件.length} 章${w.定制目标 ? ` · 绑定口径 ${w.定制目标}` : ''}`,
    first: w.文件.length ? workspaceChipName(w.文件[0]) : '',
    target: w.定制目标,
  }));
}

/* ---------- 书架管理（搜索 / 分组 / 进度，Feature Parity：对所有书统一生效） ---------- */

export interface ShelfFilters {
  q: string;
  group: string | null;
}

/** 命中分组：null=全部；''=未分组；其他=精确分组（书架分组以相等为命中） */
function inGroup(b: { 分组?: string }, want: string | null): boolean {
  if (want === null) return true;
  return (b.分组 ?? '').trim() === want;
}

/** 命中搜索：多词 AND，匹配书名/副标题/分组（大小写不敏感） */
function matchesWords(b: { 名: string; 副标题?: string; 分组?: string }, words: string[]): boolean {
  if (words.length === 0) return true;
  const hay = `${b.名} ${b.副标题 ?? ''} ${b.分组 ?? ''}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** 书架过滤 = 命中分组 且 命中搜索词 */
export function filterShelfBooks<T extends { 名: string; 副标题?: string; 分组?: string }>(books: T[], f: ShelfFilters): T[] {
  const words = f.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return books.filter((b) => inGroup(b, f.group) && matchesWords(b, words));
}

/** 书架现有分组清单（去重排序；空分组不入列） */
export function shelfGroupsOf<T extends { 分组?: string }>(books: T[]): string[] {
  return [...new Set(books.map((b) => b.分组?.trim() ?? '').filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

/** 阅读进度百分比（0-100 整数；总数缺失或未开卷 → 0，封顶 100） */
export function progressPct(read: number, total: number | undefined): number {
  if (!total || read <= 0) return 0;
  return Math.min(100, Math.round((read / total) * 100));
}

/* ================= EPUB 导入（拖一本书直接进管线：zip→spine→段落） ================= */

import { unzipSync, strFromU8 } from 'fflate';

export interface EpubChapter {
  title: string;
  paragraphs: string[];
}

function xmlAttr(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`${name}="([^"]*)"`))?.[1];
}

function decodeEntities(s: string): string {
  return s
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[e]!)
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));
}

/** epub（zip 字节）→ 阅读顺序的章列表：container.xml → OPF（书名/manifest/spine）→ 各文档的段落。
 *  环节缺失如实抛错，由调用方提示"不是有效的 epub 文件"。 */
export function parseEpubChapters(bin: Uint8Array): { bookTitle: string; chapters: EpubChapter[] } {
  const files = unzipSync(bin);
  const read = (p: string): string => {
    const f = files[p] ?? files[p.replace(/^\//, '')];
    if (!f) throw new Error(`epub 缺少文件：${p}`);
    return strFromU8(f);
  };
  const opfPath = read('META-INF/container.xml').match(/full-path="([^"]+)"/)?.[1];
  if (!opfPath) throw new Error('container.xml 里找不到 OPF 路径');
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const opf = read(opfPath);
  const bookTitle = decodeEntities(opf.match(/<dc:title[^>]*>([^<]*)<\/dc:title>/)?.[1] ?? '') || '未命名书';
  const manifest = new Map<string, string>();
  for (const m of opf.matchAll(/<item\b[^>]*>/g)) {
    const id = xmlAttr(m[0], 'id');
    const href = xmlAttr(m[0], 'href');
    if (id && href) manifest.set(id, href);
  }
  const chapters: EpubChapter[] = [];
  for (const m of opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)) {
    const href = manifest.get(m[1]!);
    if (!href || !/\.x?html?$/i.test(href)) continue;
    const html = read(opfDir + decodeURIComponent(href));
    // 章标题：<title> 优先，缺省取第一个标题块；标题块不进正文段落（与 <title> 重复）
    const title =
      decodeEntities(html.match(/<title[^>]*>([^<]*)<\/title>/)?.[1] ?? '') ||
      decodeEntities(
        html
          .match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i)?.[1]
          ?.replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim() ?? '',
      );
    const paragraphs = [...html.matchAll(/<(?:p|blockquote)\b[^>]*>([\s\S]*?)<\/(?:p|blockquote)>/gi)]
      .map((x) =>
        decodeEntities(
          x[1]!
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim(),
        ),
      )
      .filter((t) => /[A-Za-z]/.test(t));
    if (paragraphs.length > 0) chapters.push({ title: title || `第 ${chapters.length + 1} 节`, paragraphs });
  }
  if (chapters.length === 0) throw new Error('epub 未解析出任何英文段落（spine 为空或内容为扫描图）');
  return { bookTitle, chapters };
}

/** epub 章节包装成会话章节 md（与导入归一化同款格式：## Chapter One + [P01] 段标） */
export function epubChapterMd(bookTitle: string, ch: EpubChapter): string {
  return `# ${bookTitle} — ${ch.title}\n\n## Chapter One\n\n${ch.paragraphs.map((p, i) => `[P${String(i + 1).padStart(2, '0')}] ${p}`).join('\n\n')}\n`;
}

/* ================= 审校过程档案（论文素材自动成卷） ================= */

export interface QcSummaryLite {
  newWordRate: number; // ② 生词率
  avgLen: number; // ③ 平均句长
  sentCount: number;
  passive: number; // ⑤
  relcl: number; // ⑥
  pastperf: number; // ⑦
  oovCount: number;
}

export interface DossierData {
  书名: string;
  章名: string;
  版本: string;
  生成时间: string;
  句长上限: number;
  基准摘要?: QcSummaryLite;
  当前摘要: QcSummaryLite;
  对照?: { 对齐: number; 丢句: { pos: string; base: string; lost: string[] }[]; 信号缺失: { pos: string; cur: string; lost: string[] }[]; 新增: string[] };
  台账: { ts: string; markType: string; outcome: string; original: string; revised: string; basis: string }[];
  标记: { label: string; n: number }[];
  门禁: Record<string, boolean>;
}

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + '…' : s);

/** 章审校档案 → Markdown（论文素材：指标对照 + 逐句对照摘要 + 决策记录 + 标记/门禁） */
export function buildChapterDossierMd(d: DossierData): string {
  const pct = (v: number): string => (v * 100).toFixed(1) + '%';
  const L: string[] = [];
  L.push(`# 审校档案 ·《${d.书名}》${d.章名}${d.版本 ? `（${d.版本}）` : ''}`);
  L.push('');
  L.push(`生成：${d.生成时间} ｜ 简化标准：句长上限 ${d.句长上限} 词/句 ｜ 工具：LayerText 分层读`);
  L.push('');
  L.push('## 一、指标对照');
  L.push('');
  L.push('| 指标 |' + (d.基准摘要 ? ' 基准版 |' : '') + ' 当前版 |');
  L.push('|---|' + (d.基准摘要 ? '---|' : '') + '---|');
  const row = (label: string, f: (s: QcSummaryLite) => string): void => {
    L.push(`| ${label} |` + (d.基准摘要 ? ` ${f(d.基准摘要)} |` : '') + ` ${f(d.当前摘要)} |`);
  };
  row('② 生词率', (s) => pct(s.newWordRate));
  row('③ 平均句长（词）', (s) => s.avgLen.toFixed(1));
  row('句数', (s) => String(s.sentCount));
  row('⑤ 被动句', (s) => String(s.passive));
  row('⑥ 定语从句', (s) => String(s.relcl));
  row('⑦ 过去完成', (s) => String(s.pastperf));
  row('OOV 词种', (s) => String(s.oovCount));
  L.push('');
  if (d.对照) {
    L.push('## 二、逐句对照摘要');
    L.push('');
    L.push(`对齐 ${d.对照.对齐} 句 ｜ 疑似丢句 ${d.对照.丢句.length} ｜ 信号缺失 ${d.对照.信号缺失.length} 处 ｜ 新增 ${d.对照.新增.length}`);
    if (d.对照.丢句.length) {
      L.push('');
      L.push('### 疑似丢句（基准有、当前无）');
      for (const x of d.对照.丢句) L.push(`- ${x.pos}：${clip(x.base, 80)}${x.lost.length ? `（丢：${x.lost.join('、')}）` : ''}`);
    }
    if (d.对照.信号缺失.length) {
      L.push('');
      L.push('### 信号缺失（配对成功但数字/专名对不上）');
      for (const x of d.对照.信号缺失) L.push(`- ${x.pos}：${clip(x.cur, 80)}（缺：${x.lost.join('、')}）`);
    }
    L.push('');
  }
  L.push('## ' + (d.对照 ? '三' : '二') + '、决策记录（AI 建议台账·本章）');
  L.push('');
  if (d.台账.length) {
    L.push('| 时间 | 标记类型 | 结果 | 原句 | 建议句 | 依据 |');
    L.push('|---|---|---|---|---|---|');
    for (const r of d.台账) L.push(`| ${r.ts} | ${r.markType} | ${r.outcome} | ${clip(r.original, 40)} | ${clip(r.revised, 40)} | ${clip(r.basis, 50)} |`);
  } else {
    L.push('（本章暂无 AI 建议记录）');
  }
  L.push('');
  L.push('## ' + (d.对照 ? '四' : '三') + '、标记与终审门禁');
  L.push('');
  L.push(d.标记.length ? `标记 ${d.标记.reduce((n, x) => n + x.n, 0)} 处：` + d.标记.map((x) => `${x.label} ${x.n}`).join('／') : '本章无标记');
  const gates = Object.entries(d.门禁).map(([g, ok]) => `${g}${ok ? ' ✓' : ' ✗'}`);
  L.push('');
  L.push(`终审门禁：${gates.join('　')}`);
  L.push('');
  return L.join('\n');
}

/** 档案文件名：审校档案_第N章_YYYY-MM-DD.md（无章号用章名） */
export function dossierFileName(章名: string, date: string): string {
  const ch = chnoFromPath(章名) ? `第${'一二三四五六七八九十'[chnoFromPath(章名)! - 1]}章` : 章名.replace(/\.(md|txt|markdown|docx)$/i, '');
  return `审校档案_${ch}_${date}.md`;
}

/* ================= 书级审校看板（一张表看懂还剩多少活） ================= */

export interface BoardRow {
  path: string;
  章: string;
  门禁勾选: number;
  门禁总数: number;
  标记数: number;
  书签数: number;
  生词率: number | null;
  建议数: number;
  采纳数: number;
  当前: boolean;
}

/** 看板汇总头部：过门禁 x/y 章、平均生词率、总标记、建议采纳率 */
export function boardSummary(rows: BoardRow[]): { 过门禁: string; 平均生词率: string; 总标记: number; 采纳率: string } {
  const gated = rows.filter((r) => r.门禁总数 > 0 && r.门禁勾选 === r.门禁总数).length;
  const rates = rows.map((r) => r.生词率).filter((x): x is number => x !== null);
  const avgRate = rates.length ? (rates.reduce((a, b) => a + b, 0) / rates.length) * 100 : null;
  const 建议总数 = rows.reduce((n, r) => n + r.建议数, 0);
  const 采纳总数 = rows.reduce((n, r) => n + r.采纳数, 0);
  return {
    过门禁: `${gated}/${rows.length}`,
    平均生词率: avgRate === null ? '—' : avgRate.toFixed(1) + '%',
    总标记: rows.reduce((n, r) => n + r.标记数, 0),
    采纳率: 建议总数 ? `${Math.round((采纳总数 / 建议总数) * 100)}%（${采纳总数}/${建议总数}）` : '—',
  };
}
