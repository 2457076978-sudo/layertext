/**
 * 纯逻辑模块（无 DOM / Tauri 依赖，可单测）
 * AI 返回解析容错 · 书级替换 · 章节识别与导入归一化 · 定位与标记重排（O4 自 main.ts 抽出）
 */

import { extractParas, sentsOf, splitChapter } from '../../src/core/textpipe.js';
import { tokenizeTxt } from '../../src/core/textpipe.js';
import type { Mark } from './types.js';

/** 章号/报告 tag 的路径解析已收敛到 core/textpipe（CLI 与 App 共用唯一实现），此处转发导出 */
export { chnoFromPath, tagFromPath } from '../../src/core/textpipe.js';

/** CSV 单元格转义（含逗号/引号/换行加双引号，内部引号翻倍） */
export function csvCell(v: string): string {
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

/** 在正文中唯一定位原句（归一化比对：sentsOf 输出带尾随空格、连字符被拆成空格——精确比对曾致
 *  #18 重定位恒失败；多处或未找到返回 null）——行内建议挂载与建议重定位共用 */
export function locateOriginal(md: string, original: string): { pi: number; si: number } | null {
  if (!original.trim()) return null;
  const target = normWs(original);
  const paras = extractParas(splitChapter(md).body);
  const hits: { pi: number; si: number }[] = [];
  paras.forEach((p, pi) =>
    sentsOf(p, false).forEach((sent, si) => {
      if (normWs(sent) === target) hits.push({ pi, si });
    }),
  );
  return hits.length === 1 ? hits[0] : null;
}

/** 文本变化后，按句子前缀把现有标记重新对齐（防替换/拆句后错位；就地修改 marks） */
export function remapMarks(marks: Mark[], md: string): void {
  const paras = extractParas(splitChapter(md).body);
  const sents = paras.map((p) => sentsOf(p, false));
  for (const m of marks) {
    const prefix = (m.text ?? '').slice(0, 12);
    if (!prefix) continue; // 旧数据无句前缀，保留原索引
    const cur = sents[m.pi]?.[m.si];
    let ok = cur && cur.startsWith(prefix);
    if (!ok) {
      const hits: [number, number][] = [];
      sents.forEach((ss, pi) =>
        ss.forEach((sent, si) => {
          if (sent.startsWith(prefix)) hits.push([pi, si]);
        }),
      );
      if (hits.length === 1) {
        m.pi = hits[0][0];
        m.si = hits[0][1];
        ok = true;
      }
    }
    if (ok && m.level === 'word' && m.word) {
      const sent = sents[m.pi]?.[m.si] ?? '';
      const toks = tokenizeTxt(sent);
      const raws = sent.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
      const wi = raws.findIndex((w, i) => (toks[i] ?? w.toLowerCase()) === m.word!.toLowerCase());
      if (wi >= 0) m.wi = wi;
    }
    if (ok && m.level === 'phrase' && m.word) {
      // 短语重对齐：句内找连续词序列匹配（大小写不敏感），找到即更新 wi/wl；找不到保留原值（渲染自然跳过）
      const sent = sents[m.pi]?.[m.si] ?? '';
      const raws = sent.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
      const target = (m.word.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).map((w) => w.toLowerCase());
      for (let i = 0; target.length > 0 && i + target.length <= raws.length; i++) {
        const hit = raws.slice(i, i + target.length).every((w, j) => w.toLowerCase() === target[j]);
        if (hit) {
          m.wi = i;
          m.wl = target.length;
          break;
        }
      }
    }
  }
}

/* ---------- 短语级标记（三级粒度：词/短语/句） ---------- */

/** 句内第 wi 个词起 wl 个词的原文切片（与渲染器同款逐词推进，重复词不串位）；越界返回 null */
export function phraseSpan(sent: string, wi: number, wl: number): { text: string; so: number; eo: number } | null {
  const raws = sent.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
  if (wi < 0 || wl <= 0 || wi + wl > raws.length) return null;
  let pos = 0;
  let so = -1;
  let eo = -1;
  for (let i = 0; i <= wi + wl - 1; i++) {
    const at = sent.indexOf(raws[i], pos);
    if (at < 0) return null;
    if (i === wi) so = at;
    if (i === wi + wl - 1) eo = at + raws[i].length;
    pos = at + raws[i].length;
  }
  return so >= 0 && eo > so ? { text: sent.slice(so, eo), so, eo } : null;
}

/** 拖选路由（选区即范围，无隐式判定）：归一化后等于整句 → 'sent'；
 *  含 ≥2 个英文词 → 'phrase'（短语）；≤1 词 → 'word'（按词处理） */
export function routeSelection(selText: string, sentText: string): 'sent' | 'phrase' | 'word' {
  const sel = normWs(selText);
  if (!sel) return 'word';
  if (normWs(sentText) === sel) return 'sent';
  const words = sel.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
  return words.length >= 2 ? 'phrase' : 'word';
}

/* ---------- 手动改这句（人工矫正兜底）：教师亲手改句后的标记存留规则 ---------- */

/** 手动修订一句后哪些标记存留：
 *  ① 该句的句级标记全部完成（教师手改=对它们的人工响应）；② 该句（仅该句）的词/短语级标记中，
 *  原句里有、新句里没有的词=被改掉，连带完成（防幽灵标记）——别句同词标记不动；其余存留（remap 另行重定位） */
export function marksSurvivingManualEdit(marks: Mark[], at: { pi: number; si: number }, before: string, after: string): Mark[] {
  const b = before.toLowerCase();
  const a = after.toLowerCase();
  const onThisSent = (m: Mark): boolean => m.pi === at.pi && m.si === at.si;
  return marks.filter((m) => {
    if (onThisSent(m) && m.level === 'sent') return false;
    if (onThisSent(m) && m.level !== 'sent' && m.word) {
      const w = m.word.toLowerCase();
      if (b.includes(w) && !a.includes(w)) return false;
    }
    return true;
  });
}

/* ---------- 跨版本标记同步（同一章多版本文件：词/短语级审校意图广播） ---------- */

export interface SyncPlanItem {
  /** 源标记（词/短语级） */
  source: Mark;
  /** 目标版本中新建的标记（每处出现一条；同词多处出现=多条） */
  created: Mark[];
  /** 未建或部分未建的原因：目标无此词（更简版本往往已换掉=已处理）/ 目标已有同词同类型（幂等跳过） */
  skipped?: 'not-found' | 'duplicate';
}

export interface SyncPlan {
  items: SyncPlanItem[];
  totalCreated: number;
}

/** 把源版本的词/短语级标记同步到目标版本 md：
 *  词级=目标中每处出现建标；短语级=连续词序列匹配处建标；目标无此词=跳过并记录；
 *  目标已有同词同类型（existing）=幂等跳过。句级标记不同步（三版本句结构完全不同，句对不上）。
 *  语义：同步的是"审校意图"（待办），执行仍由各版本自己的管线按需跑——B 版句长/词库口径可能不同。 */
export function syncMarksToMd(marks: Mark[], targetMd: string, existing: Mark[], newId: () => string, now = Date.now()): SyncPlan {
  const paras = extractParas(splitChapter(targetMd).body);
  const sents = paras.map((p) => sentsOf(p, false));
  const items: SyncPlanItem[] = [];
  let totalCreated = 0;
  for (const m of marks) {
    if (m.level === 'sent' || !m.word) continue;
    const targetWords = (m.word.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).map((w) => w.toLowerCase());
    if (!targetWords.length) continue;
    if (existing.some((x) => x.word?.toLowerCase() === m.word!.toLowerCase() && x.type === m.type)) {
      items.push({ source: m, created: [], skipped: 'duplicate' });
      continue;
    }
    const created: Mark[] = [];
    sents.forEach((ss, pi) =>
      ss.forEach((sent, si) => {
        const raws = sent.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
        for (let i = 0; i + targetWords.length <= raws.length; i++) {
          const hit = raws.slice(i, i + targetWords.length).every((w, j) => w.toLowerCase() === targetWords[j]);
          if (!hit) continue;
          created.push({
            id: newId(),
            level: m.level,
            pi,
            si,
            wi: i,
            ...(m.level === 'phrase' ? { wl: targetWords.length } : {}),
            word: m.word,
            text: sent.slice(0, 40),
            type: m.type,
            ...(m.note ? { note: m.note } : {}),
            ...(m.origin ? { origin: m.origin } : {}),
            ts: now,
          });
        }
      }),
    );
    totalCreated += created.length;
    items.push({ source: m, created, ...(created.length ? {} : { skipped: 'not-found' as const }) });
  }
  return { items, totalCreated };
}

/** 从 AI 返回文本中尽力解析出 JSON 数组（代码围栏/单对象/多对象无括号/截断修复/前后解释文字） */
export function parseAiJson(raw: string): unknown[] {
  let t = (raw ?? '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const tryArr = (s: string): unknown[] | null => {
    try {
      const v = JSON.parse(s) as unknown;
      return Array.isArray(v) ? v : [v];
    } catch {
      return null;
    }
  };
  const s1 = t.indexOf('[');
  if (s1 >= 0) {
    const e1 = t.lastIndexOf(']');
    if (e1 > s1) {
      const r = tryArr(t.slice(s1, e1 + 1));
      if (r) return r;
    }
    // 截断修复：在最后一个完整对象后补 ]
    const lastObj = t.lastIndexOf('}');
    if (lastObj > s1) {
      const r = tryArr(t.slice(s1, lastObj + 1) + ']');
      if (r) return r;
    }
  }
  const s2 = t.indexOf('{');
  const e2 = t.lastIndexOf('}');
  if (s2 >= 0 && e2 > s2) {
    const slice = t.slice(s2, e2 + 1);
    const r = tryArr(slice) ?? tryArr('[' + slice + ']'); // 单对象 / 无括号多对象
    if (r) return r;
  }
  throw new Error('AI 返回中未找到 JSON（AI 原话前 200 字：' + (raw ?? '').slice(0, 200).replace(/\s+/g, ' ') + '）');
}

/** 比对归一化：连续空白压成单个空格、去首尾、连字符/破折号/markdown 引用符视同空格
 *  （引擎拆句会吃掉 hen-houses 的连字符与歌篇引用块的 > 前缀，AI 原句与正文往返必见此类差异；比对用，不改原文） */
export function normWs(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(/[-—–>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 空白与连字符不敏感地在正文中定位 AI 给出的 original（欠账#2：句末空格/多重空格；09-09：连字符）。
 * 优先唯一精确匹配；否则按归一化匹配；多处命中（歧义）或未命中返回 null。
 * 返回的 exact 是正文里的原文切片（含其原始空白与连字符），供后续精确替换使用。
 */
export function findOriginalFlex(md: string, original: string): { start: number; exact: string } | null {
  if (!original.trim()) return null;
  // ① 唯一精确匹配直接用
  const first = md.indexOf(original);
  if (first >= 0 && md.indexOf(original, first + 1) < 0) return { start: first, exact: original };
  // ② 归一化匹配：构建压缩视图（空白/连字符/引用符同置为单空格）+ 原文位置映射
  let norm = '';
  const map: number[] = [];
  for (let i = 0; i < md.length; i++) {
    const c = md[i];
    if (/\s|[-—–>]/.test(c)) {
      if (norm.endsWith(' ')) continue; // 连续分隔符只记第一个的位置
      norm += ' ';
    } else {
      norm += c;
    }
    map.push(i);
  }
  const target = normWs(original);
  if (!target) return null;
  const hits: number[] = [];
  let at = norm.indexOf(target);
  while (at >= 0) {
    hits.push(at);
    at = norm.indexOf(target, at + 1);
  }
  if (hits.length !== 1) return null;
  const h = hits[0];
  const start = map[h];
  const end = map[h + target.length - 1] + 1;
  return { start, exact: md.slice(start, end) };
}

/** 正文已有生词注释放射：word（中文）→ { word: 中文 }（生词卡释义优先用它——教师校过的释义最可信）。
 *  英文 run 会贪婪吃掉前置词（"The boar（野猪）"的 run 是 "The boar"）——剥离前导虚词后作 key */
const ZH_NOTE_LEADING_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'his', 'her', 'its', 'their', 'our', 'my', 'your', 'this', 'that', 'these', 'those',
  'to', 'in', 'on', 'for', 'with', 'and', 'but', 'or', 'was', 'is', 'are', 'were', 'be', 'been', 'he', 'she', 'it', 'they', 'we', 'you', 'i',
]);
export function extractZhNotes(md: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*)*)（([^（）]{1,12})）/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) {
    const toks = m[1].split(/\s+/);
    while (toks.length > 1 && ZH_NOTE_LEADING_STOPWORDS.has(toks[0].toLowerCase())) toks.shift();
    out[toks.join(' ')] = m[2];
  }
  return out;
}

/** 生词卡行（Anki 导出）：词 / CEFR / 中文释义 / 例句 / 出处 */
export interface AnkiRow {
  word: string;
  cefr: string;
  zh: string;
  sent: string;
  from: string;
}

/** 生词卡组装：多章词去重（首章出例句，出处累记）；释义优先级=正文已有注释 > 系统词典 > 留空教师补；
 *  例句=含该词（词边界、大小写不敏感）的第一个句子，截断 90 字符 */
export function ankiRowsOf(
  chapters: { from: string; md: string; words: string[] }[],
  zhNotes: Record<string, string>,
  dictZh: Record<string, string>,
  cefrOfWord: (w: string) => string,
): AnkiRow[] {
  const rows = new Map<string, AnkiRow>();
  for (const ch of chapters) {
    const sents = (() => {
      try {
        return extractParas(splitChapter(ch.md).body).flatMap((p) => sentsOf(p, false));
      } catch {
        return [];
      }
    })();
    for (const w of ch.words) {
      const key = w.toLowerCase();
      const exist = rows.get(key);
      if (exist) {
        if (!exist.from.includes(ch.from)) exist.from += '、' + ch.from;
        continue;
      }
      const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      const sent = sents.find((x) => re.test(x)) ?? '';
      rows.set(key, {
        word: w,
        cefr: cefrOfWord(w),
        zh: zhNotes[w] ?? dictZh[w] ?? '',
        sent: sent.length > 90 ? sent.slice(0, 90) + '…' : sent.trim(),
        from: ch.from,
      });
    }
  }
  return [...rows.values()];
}

/** Anki 可导入 CSV（首行表头；例句含逗号/引号由 csvCell 转义） */
export function ankiCsv(rows: AnkiRow[]): string {
  // \ufeff BOM：教师双击用 Excel 打开时中文列不乱码（Anki 导入对 BOM 兼容）
  return '\ufeff' + ['词,CEFR,中文释义,例句,出处', ...rows.map((r) => [r.word, r.cefr, r.zh, r.sent, r.from].map(csvCell).join(','))].join('\n') + '\n';
}

/** 复现队列 CSV：词,hits（hits=已复现次数，默认 0——画像数据可补；# 注释行 fsrs CLI 会跳过）。
 *  与 CLI 闭环：node dist/src/cli.js fsrs 队列文件.csv → FSRS 建议隔篇 vs 现行固定 2 篇并排 */
export function reinforceQueueCsv(rows: AnkiRow[]): string {
  return ['# 复现队列：词,hits（hits=已复现次数，默认 0，画像数据可补）', '# 查看 FSRS 间隔建议：node dist/src/cli.js fsrs 本文件.csv', ...rows.map((r) => `${r.word},0`)].join('\n') + '\n';
}

/* ================= 读后检测题（阅读侧配套：AI 出题候选裁决 + 试卷组装） ================= */

export interface QuizItem {
  q: string;
  options: string[];
  answer: string; // A-D 字母
  why: string;
  focus: 'comprehension' | 'inference' | 'vocabulary';
}
/** AI 边界 #26（检测题候选裁决）：题干非空；选项 3~5 个非空字符串；answer 是有效字母且指向存在选项；
 *  focus 白名单；不合规整题拒收计数 */
export function parseQuizItems(raw: unknown[]): { ok: QuizItem[]; rejected: number } {
  let rejected = 0;
  const ok: QuizItem[] = [];
  for (const x of raw as { q?: unknown; options?: unknown; answer?: unknown; why?: unknown; focus?: unknown }[]) {
    const q = typeof x?.q === 'string' ? x.q.trim() : '';
    const opts = Array.isArray(x?.options) ? x.options.filter((o) => typeof o === 'string' && o.trim()) : [];
    const answer = typeof x?.answer === 'string' ? x.answer.trim().toUpperCase() : '';
    const focus = x?.focus;
    if (!q || opts.length < 3 || opts.length > 5 || !/^[A-D]$/.test(answer) || answer.charCodeAt(0) - 65 >= opts.length || (focus !== 'comprehension' && focus !== 'inference' && focus !== 'vocabulary')) {
      rejected++;
      continue;
    }
    ok.push({ q, options: opts, answer, why: typeof x?.why === 'string' ? x.why.trim() : '', focus });
  }
  return { ok, rejected };
}

/** 检测卷组装：题卷（学生用，无答案）+ 答案页（教师用，含 why）；focus 标注词汇题 */
export function buildQuizMd(title: string, items: QuizItem[], meta: { date: string; maxLen: number }): string {
  const letters = ['A', 'B', 'C', 'D', 'E'];
  const head = [`# 读后检测 · ${title}`, '', `日期：${meta.date} ｜ ${items.length} 题（理解/推断/词汇）｜ 建议用时 8 分钟`, '', '## 学生卷', ''];
  items.forEach((it, i) => {
    head.push(`${i + 1}. ${it.q}${it.focus === 'vocabulary' ? '' : ''}`);
    it.options.forEach((o, j) => head.push(`   ${letters[j]}. ${o}`));
    head.push('');
  });
  head.push('---', '', '## 答案（教师页）', '');
  items.forEach((it, i) => head.push(`${i + 1}. ${it.answer}${it.why ? ` —— ${it.why}` : ''}${it.focus === 'vocabulary' ? '（词汇题）' : ''}`));
  head.push('');
  return head.join('\n') + '\n';
}

/* ================= 批改域纯逻辑（学生产出体检：AI 批改候选裁决 + 批改稿/班级汇总组装） ================= */

export type GradingNoteType = 'grammar' | 'usage' | 'structure' | 'highlight' | 'comment';
export interface GradingNote {
  type: GradingNoteType;
  original: string;
  note: string;
  suggestion?: string;
}
export const GRADING_TYPE_LABEL: Record<GradingNoteType, string> = {
  grammar: '语法',
  usage: '用词',
  structure: '结构',
  highlight: '亮点',
  comment: '总评',
};

/** AI 边界 #25（批改候选裁决）：type 必须在白名单；note 必须非空；grammar/usage/structure/highlight 的
 *  original 必须是非空字符串且能在学生原文中定位（宽容匹配），comment 类不需要 original；
 *  不合规整条拒收并计数（UI 明示），绝不进批改稿 */
export function parseGradingItems(raw: unknown[], text: string): { ok: GradingNote[]; rejected: number } {
  let rejected = 0;
  const ok: GradingNote[] = [];
  for (const x of raw as { type?: unknown; original?: unknown; note?: unknown; suggestion?: unknown }[]) {
    const type = x?.type as GradingNoteType;
    const note = typeof x?.note === 'string' ? x.note.trim() : '';
    const suggestion = typeof x?.suggestion === 'string' && x.suggestion.trim() ? x.suggestion.trim() : undefined;
    let original = typeof x?.original === 'string' ? x.original.trim() : '';
    if (!(type in GRADING_TYPE_LABEL) || !note) {
      rejected++;
      continue;
    }
    if (type === 'comment') {
      original = '';
    } else if (!original || (text.indexOf(original) < 0 && !findOriginalFlex(text, original))) {
      rejected++; // 原文定位不到：AI 编造/改写了学生句子——拒收
      continue;
    }
    ok.push({ type, original, note, ...(suggestion ? { suggestion } : {}) });
  }
  return { ok, rejected };
}

/** 批改稿组装：原文按空行分段保留，勾选的批注挂在包含其 original 的段之后；comment 类进头部总评；
 *  定位不到段的批注集中列尾（不静默丢弃） */
export function buildGradingSheetMd(name: string, text: string, notes: GradingNote[], meta: { date: string; vocabNote?: string }): string {
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const matches = (p: string, o: string) => p.includes(o) || normWs(p).includes(normWs(o));
  const comments = notes.filter((n) => n.type === 'comment');
  const inline = notes.filter((n) => n.type !== 'comment');
  const out: string[] = [`# 批改稿 · ${name}`, '', `批改日期：${meta.date}${meta.vocabNote ? ` ｜ 词库口径：${meta.vocabNote}` : ''}`, ''];
  if (comments.length) out.push('## 总评', ...comments.map((c) => `- ${c.note}`), '');
  out.push('## 原文与批注', '');
  const placed = new Set<GradingNote>();
  for (const p of paras) {
    out.push(p, '');
    for (const n of inline) {
      if (n.original && matches(p, n.original) && !placed.has(n)) {
        placed.add(n);
        out.push(`> ✏ **${GRADING_TYPE_LABEL[n.type]}**：${n.note}${n.suggestion ? `（建议：${n.suggestion}）` : ''}`, '');
      }
    }
  }
  const unplaced = inline.filter((n) => !placed.has(n));
  if (unplaced.length) out.push('## 未定位批注（对应段落有变动，请人工核对）', ...unplaced.map((n) => `- [${GRADING_TYPE_LABEL[n.type]}] ${n.original}：${n.note}`), '');
  return out.join('\n') + '\n';
}

/** 班级批改汇总行（学生 × 指标：超纲结构/超纲词/复现词产出命中） */
export interface ClassGradingRow {
  name: string;
  words: number;
  sents: number;
  avgLen: number;
  structure: number;
  longSents: number;
  oovWords: number;
  used: number;
  queue: number;
}
export function buildClassGradingMd(rows: ClassGradingRow[], meta: { date: string; folder: string; vocabNote?: string }): string {
  const sum = (f: (r: ClassGradingRow) => number) => rows.reduce((n, r) => n + f(r), 0);
  const qRows = rows.filter((r) => r.queue > 0);
  const head = [
    `# 班级批改汇总 · ${meta.folder.split('/').pop() ?? ''}`,
    '',
    `批改日期：${meta.date}${meta.vocabNote ? ` ｜ 词库口径：${meta.vocabNote}` : ''} ｜ 学生 ${rows.length} 人`,
    '',
    `**合计**：平均词数 ${rows.length ? Math.round(sum((r) => r.words) / rows.length) : 0} ｜ 平均句长 ${rows.length ? (sum((r) => r.avgLen) / rows.length).toFixed(1) : 0} 词 ｜ 未学结构 ${sum((r) => r.structure)} 处 ｜ 超纲词 ${sum((r) => r.oovWords)} 个${qRows.length ? ` ｜ 复现词产出命中 ${sum((r) => r.used)}/${sum((r) => r.queue)}（队列均摊）` : ''}`,
    '',
    '| 学生 | 词数 | 句数 | 均长 | 未学结构 | 长句 | 超纲词 | 复现命中 |',
    '|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.name} | ${r.words} | ${r.sents} | ${r.avgLen.toFixed(1)} | ${r.structure} | ${r.longSents} | ${r.oovWords} | ${r.queue ? `${r.used}/${r.queue}` : '—' } |`),
    '',
    '> 指标口径：未学结构=被动/定语从句/过去完成（学生未学，出现即列出教师判断）；超纲词=班级词库（课标1600+教师词库）之外；复现命中=复现队列词在本篇产出中的使用（词形家族计一次）。全部本地引擎计算。',
    '',
  ];
  return head.join('\n') + '\n';
}
export function classGradingCsv(rows: ClassGradingRow[]): string {
  return '\ufeff' + ['学生,词数,句数,平均句长,未学结构,长句,超纲词,复现命中,队列词数', ...rows.map((r) => [r.name, r.words, r.sents, r.avgLen.toFixed(1), r.structure, r.longSents, r.oovWords, r.used, r.queue].map((v) => csvCell(String(v))).join(','))].join('\n') + '\n';
}

/** ⚠︎ 复核角标随正文重排（与 remapMarks 同思想）：角标条目带原句身份（pi:si|原句|原因），
 *  正文变化后按原句文本重新定位；原句已不存在（被删/被改写）= 该角标使命结束，丢弃。
 *  旧格式（pi:si|原因，无原句）无法重定位，同样丢弃。 */
export function remapWarns(warns: string[] | undefined, md: string): string[] {
  if (!warns?.length) return [];
  const out: string[] = [];
  for (const w of warns) {
    const parts = w.split('|');
    if (parts.length < 3) continue; // 旧格式/损坏条目
    const loc = locateOriginal(md, parts[1]);
    if (!loc) continue; // 句子没了：角标随之失效
    const key = `${loc.pi}:${loc.si}`;
    if (!out.some((x) => x.startsWith(key + '|'))) out.push(`${key}|${parts[1]}|${parts.slice(2).join('|')}`);
  }
  return out;
}

/** AI 边界 #18：建议定位三段决策（每条独立定位，同句多条互不依赖）——
 *  ① 缺坐标或坐标句已变 → locateSent 重定位（尽力而为，只影响日志）；
 *  ② indexOf 精确匹配；③ findOriginalFlex 宽容匹配（空白/连字符差异，命中回写正文原句形态）。
 *  返回 null = 定位失败：建议留在「修订建议」页人工处理，绝不写错位置（UI 归宿②）。 */
export function resolveSuggestionTarget(
  md: string,
  g: { pi?: number; si?: number; original: string },
): { pi?: number; si?: number; at: number; original: string } | null {
  if (!g.original.trim()) return null; // 空 original：indexOf("") 恒返 0，会把建议写进文首——直接定位失败
  let { pi, si } = g;
  const original0 = g.original;
  if (pi === undefined || si === undefined) {
    const loc = locateOriginal(md, original0);
    if (loc) {
      pi = loc.pi;
      si = loc.si;
    }
  } else {
    const paras = extractParas(splitChapter(md).body);
    const cur = sentsOf(paras[pi] ?? '', false)[si];
    if (cur !== original0) {
      const loc = locateOriginal(md, original0);
      if (loc) {
        pi = loc.pi;
        si = loc.si;
      }
    }
  }
  let at = md.indexOf(original0);
  let original = original0;
  if (at < 0) {
    const flex = findOriginalFlex(md, original0);
    if (flex) {
      at = flex.start;
      original = flex.exact;
    }
  }
  if (at < 0) return null;
  return { pi, si, at, original };
}

/** AI 边界 #21：建议字段 schema 校验——revised/original 必须是单一非空字符串。
 *  数组（多条变体）、对象（字段包装）、空串一律 false（拒收+明示，UI 归宿③）。 */
export function validSuggestionText(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** AI 边界 #21：单句改写的响应裁决——schema 约定"单对象"，多条=AI 擅自给变体让用户选，拒收。
 *  original 缺省回退到 fallbackOriginal（调用方发出的原句）——AI 偶省略 original 不至于整条拒收（批量建议路径无此回退，保持严格） */
export function pickSingleRewrite(
  arr: unknown[],
  fallbackOriginal?: string,
): { ok: true; original?: string; revised: string; basis?: string; alternative?: string } | { ok: false; reason: 'multi' | 'empty' | 'bad-shape' } {
  if (arr.length > 1) return { ok: false, reason: 'multi' };
  const one = arr[0] as { original?: unknown; revised?: unknown; basis?: unknown; alternative?: unknown } | undefined;
  if (!one) return { ok: false, reason: 'empty' };
  if (!validSuggestionText(one.revised)) return { ok: false, reason: 'bad-shape' };
  const original = validSuggestionText(one.original) ? one.original : fallbackOriginal;
  if (!original) return { ok: false, reason: 'bad-shape' };
  return {
    ok: true,
    original,
    revised: one.revised,
    basis: typeof one.basis === 'string' ? one.basis : undefined,
    alternative: typeof one.alternative === 'string' ? one.alternative : undefined,
  };
}

/** 生词注释规整：AI 偶用半角括号加空格（word (中文)），统一为全角紧贴（word（中文））——只动"英文词+(纯中文)"模式 */
export function normalizeZhNotes(text: string): string {
  return text.replace(/([A-Za-z])\s*\(([\u4e00-\u9fff][^)()]{0,11})\)/g, '$1（$2）');
}

/** revised 中文防线：剔除「英文词（中文）」生词注释后仍含成句中文（≥4 连续汉字）
 *  = AI 输出了说明文字/翻译（如"（标注：这是歌曲中的诗句…）"），拒用 */
export function hasProseChinese(text: string): boolean {
  const stripped = text.replace(/[A-Za-z\u0027-]+\s*（[^）]*）/g, ' ');
  return /[\u4e00-\u9fff]{4,}/.test(stripped);
}

/** AI 边界 #16：revised 混入 Markdown 记号（**bold** / *italic* / `code` / __xx__）→ 归一化剥离（语义不变） */
export function stripMarkdownNoise(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .trim();
}

/** AI 边界 #17：屈折形态预警——替换前后的词尾形态类（ed/ing/s/原形）不一致时提示教师复核（不拦截，B3 复核不挡路） */
export function morphMismatch(from: string, to: string): boolean {
  const cls = (w: string): string => {
    const t = w.toLowerCase().replace(/[^a-z]/g, '');
    if (t.endsWith('ing')) return 'ing';
    if (t.endsWith('ed')) return 'ed';
    if (t.endsWith('s') && !t.endsWith('ss')) return 's';
    return 'base';
  };
  return cls(from) !== cls(to);
}

/** AI 边界 #24：映射值含任何汉字（哪怕 1 个，如"七诫"）＝AI 把"简单词"答成了中文——拒用（曾漏过 ≥4 字防线） */
export function hasAnyChinese(s: string): boolean {
  return /[\u4e00-\u9fff]/.test(s);
}

/** AI 边界 #23（真事故：短语简化恒 miss）：AI 常把短语的键答成子词（"Seven Commandments"→键只给 "Commandments"）。
 *  查找升级：精确 → 小写 → 词集子集匹配——键词集 ⊆ 标记词集 且标记中剩余词全部已知（known）时，
 *  用键的值替换**整个短语**（the Seven Commandments→the rules 成立；tired of 的 tired 子集匹配若 of 未知则不整换，防语义破坏）。 */
export function glossLookup(gloss: Record<string, string>, word: string, known?: Set<string>): { simple: string; via: 'exact' | 'subset' } | null {
  const keys = [word, word.toLowerCase(), word.replace(/\s+/g, ' ')];
  for (const k of keys) {
    if (gloss[k] && !hasAnyChinese(gloss[k]) && gloss[k].toLowerCase() !== word.toLowerCase()) return { simple: gloss[k], via: 'exact' };
  }
  if (!known) return null;
  const wordsOf = (s: string): string[] => s.toLowerCase().match(/[a-z][a-z'-]*/g) ?? [];
  const target = wordsOf(word);
  if (target.length < 2) return null; // 子集匹配只对多词短语有意义
  for (const [k, v] of Object.entries(gloss)) {
    if (hasAnyChinese(v)) continue;
    const kw = wordsOf(k);
    if (!kw.length || kw.length >= target.length) continue; // 键必须是标记的严格子集
    const kwSet = new Set(kw);
    if (!kw.every((x) => target.includes(x))) continue; // 键词全在标记里
    const rest = target.filter((x) => !kwSet.has(x));
    if (!rest.every((x) => known.has(x))) continue; // 剩余词全已知，整块替换才不破坏语义
    if (v.toLowerCase() === word.toLowerCase()) continue;
    return { simple: v, via: 'subset' };
  }
  return null;
}

/** AI 边界 #22（真事故 09-09：词汇简化映射恒空，全部误降级加注）：
 *  chatUntilJson/parseAiJson 恒返回数组（单对象自动包数组），Object.assign(gloss, 数组) 只会得到 {0:{…}}。
 *  归一化 AI 的"词→替换"映射，兼容真实世界全部形态：纯映射对象（含被包数组）/字段对对象数组
 *  （word+simple、原词+简单词、from+to 等字段名变体）；非字符串值跳过。 */
export function normalizeGlossMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const arr = Array.isArray(raw) ? raw : [raw];
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const obj = it as Record<string, unknown>;
    const entries = Object.entries(obj);
    if (!entries.length) continue;
    // 字段对形态：{word|原词|from, simple|简单词|to|revised}（值为非字符串=映射对象不可能的形态）
    const w = ['word', '原词', '原单词', 'from'].map((k) => obj[k]).find((v): v is string => typeof v === 'string');
    const sv = ['simple', '简单词', '替换', '替换词', 'to', 'revised'].map((k) => obj[k]).find((v): v is string => typeof v === 'string');
    if (w !== undefined && sv !== undefined) {
      out[w] = sv;
      continue;
    }
    // 纯映射对象形态：{"cynical": "bitter", ...}（值全为字符串）
    for (const [k, v] of entries) {
      if (typeof v === 'string' && k.length <= 48) out[k] = v;
    }
  }
  return out;
}

/** 文件字节 → 文本（导入自动编码探测）：BOM 优先 → 严格 UTF-8 校验 → GB18030 兜底（覆盖 GBK/GB2312；
 *  中文环境导出的 txt 常为 GBK，直接按 UTF-8 读会乱码或报错） */
export function decodeAuto(bin: Uint8Array): string {
  if (bin.length >= 3 && bin[0] === 0xef && bin[1] === 0xbb && bin[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bin.subarray(3));
  }
  if (bin.length >= 2 && bin[0] === 0xff && bin[1] === 0xfe) return new TextDecoder('utf-16le').decode(bin.subarray(2));
  if (bin.length >= 2 && bin[0] === 0xfe && bin[1] === 0xff) return new TextDecoder('utf-16be').decode(bin.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bin);
  } catch {
    try {
      return new TextDecoder('gb18030').decode(bin);
    } catch {
      return new TextDecoder('utf-8').decode(bin); // 兜底替换字符（总比打不开好）
    }
  }
}

/** 书级替换：词边界确定性替换（机器执行，零遗漏） */
export function applyRewriteTo(text: string, rules: { from: string; to: string }[]): string {
  let t = text;
  for (const r of rules) {
    if (!r.from || !r.to) continue;
    const esc = r.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`\\b${esc}\\b`, 'g'), r.to);
  }
  return t;
}

/** 网络类自动重试：可重试错误（断连/超时/5xx/429 限流）指数退避重试，其余立即抛出 */
export async function withRetry<T>(fn: () => Promise<T>, onStatus?: (s: string) => void, maxAttempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const s = String(e);
      const retriable = /Failed to fetch|NetworkError|timeout|Timeout|aborted|ECONNRESET|socket|HTTP 5\d{2}|HTTP 429/.test(s);
      if (!retriable || i === maxAttempts - 1) throw e;
      const wait = (i + 1) * 2000;
      onStatus?.(`网络不稳，${wait / 1000} 秒后自动重试（第 ${i + 1}/${maxAttempts - 1} 次）…`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

const CH_TITLE = /^(chapter\s+[\w-]+|第[一二三四五六七八九十百\d]+章)/i;

export interface SplitChapterResult {
  /** 拆分后的章节（单章或无章节时长度为 1） */
  chapters: { title: string; md: string }[];
  /** 原文本是否含 ## Chapter 标记（已合规则直接使用） */
  alreadyFormatted: boolean;
}

/**
 * 导入归一化：任意文本 → 章节 md 数组。
 * ① 已含 ## Chapter 标记：直接使用；② 含多个章节标题行（Chapter X / 第X章）：按标题拆章；
 * ③ 无章节结构：按空行分段包装为单章（不要求落盘，内存直接可显示）。
 */
export function normalizeAndSplitChapters(raw: string, fileName: string): SplitChapterResult {
  if (/^## Chapter \w+/m.test(raw)) {
    return { chapters: [{ title: fileName, md: raw }], alreadyFormatted: true };
  }
  const text = raw.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const heads: { line: number; title: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trim().match(CH_TITLE);
    if (m && lines[i].trim().length <= 60) heads.push({ line: i, title: lines[i].trim() });
  }
  const wrap = (bodyText: string, title: string, chNo: number): string => {
    const paras = bodyText
      .split(/\n\s*\n/)
      .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
      .filter((p) => /[A-Za-z\u4e00-\u9fff]/.test(p));
    return `# ${fileName}\n\n## Chapter ${chNo}\n\n${paras.map((p, i) => `[P${String(i + 1).padStart(2, '0')}] ${p}`).join('\n\n')}\n`;
  };
  if (heads.length >= 2) {
    const chapters = heads.map((h, idx) => {
      const end = idx + 1 < heads.length ? heads[idx + 1].line : lines.length;
      return { title: `${fileName.replace(/\.(md|txt|docx|doc)$/i, '')} · ${h.title}`, md: wrap(lines.slice(h.line + 1, end).join('\n'), h.title, idx + 1) };
    });
    return { chapters, alreadyFormatted: false };
  }
  return { chapters: [{ title: fileName, md: wrap(text, fileName, 1) }], alreadyFormatted: false };
}

/**
 * 复核改写文本（可能含多句）：按句拆分逐句检测，overlong = 最长一句超限。
 * riskOne：单句检测函数（由 UI 层注入 sentenceRisks 的单句版，避免本模块依赖引擎）。
 */
export function checkRevisedText(
  revised: string,
  maxLen: number,
  riskOne: (sent: string, maxLen: number) => { passive: boolean; relcl: boolean; pastperf: boolean; overlong: boolean },
): { passive: boolean; relcl: boolean; pastperf: boolean; overlong: boolean } {
  const sents = revised.split(/(?<=[.!?])\s+/).filter((s) => /[A-Za-z]/.test(s));
  const out = { passive: false, relcl: false, pastperf: false, overlong: false };
  for (const s of sents) {
    const r = riskOne(s, maxLen);
    out.passive ||= r.passive;
    out.relcl ||= r.relcl;
    out.pastperf ||= r.pastperf;
    out.overlong ||= r.overlong;
  }
  return out;
}

/** 诊断包配置摘要（W5）：只保留域名/模型名/开关/数量，不含任何书稿与学生文本、不含 Key 与约定内容 */
export interface DiagConfigInput {
  baseUrl?: string;
  model?: string;
  failover?: unknown[];
  autoRewriteOnMark?: boolean;
  trustEdit?: boolean;
  inPlaceEdit?: boolean;
  lowThinking?: boolean;
  simplify?: unknown;
  recentFiles?: string[];
  instructions?: string;
}

export function buildDiagSummary(cfg: DiagConfigInput, appVersion: string, userAgent: string): Record<string, unknown> {
  let host = cfg.baseUrl ?? '';
  try {
    host = new URL(host).host;
  } catch {
    if (host) host = '(自定义地址)';
  }
  return {
    应用版本: appVersion,
    系统: userAgent,
    导出时间: new Date().toISOString(),
    配置摘要: {
      AI服务商域名: host || '(未配置)',
      模型: cfg.model || '(未配置)',
      备用供应商数: cfg.failover?.length ?? 0,
      全局AI直改: cfg.autoRewriteOnMark ?? false,
      信任模式: cfg.trustEdit ?? false,
      原地编辑原稿: cfg.inPlaceEdit ?? true,
      关闭思考: cfg.lowThinking !== false,
      简化标准自定义: Boolean(cfg.simplify),
      长期审校约定字数: (cfg.instructions ?? '').length,
      最近文件数: cfg.recentFiles?.length ?? 0,
    },
    隐私说明: '本诊断包不含任何书稿、学生文本或 API Key；仅含配置摘要、错误日志与成本统计。',
  };
}

/** 估算 tokens（英文≈3.5字符/词符，中文≈1.6字）——压缩与请求前的成本预估共用同一口径 */
export function estTokens(s: string): number {
  const cjk = (s.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const rest = s.length - cjk;
  return Math.round(cjk * 1.6 + rest / 3.5);
}

export interface ChatMsgLike {
  role: string;
  content: string;
  tool_calls?: unknown;
  tool_call_id?: string;
}

export interface CompactionPlan {
  need: boolean;
  /** 保留尾段的起始索引（need=true 时必为 user 消息：不拆散 assistant.tool_calls 与其 tool 结果） */
  keptFrom: number;
  /** 被压缩为摘要的前段条数 */
  headCount: number;
  estBefore: number;
  estHead: number;
  estTail: number;
}

export const COMPACT_DEFAULTS = { maxEst: 6000, maxMsgs: 40, keepUserTurns: 6, summaryEst: 300 } as const;

/**
 * 对话压缩计划（欠账#1：长对话越滚越贵越慢）。估算 tokens 超限或消息条数超限时，
 * 把倒数第 keepUserTurns 轮 user 之前的旧消息摘要化。user 轮数不足时不压（没有安全切点）。
 */
export function planCompaction(msgs: ChatMsgLike[], opts?: Partial<typeof COMPACT_DEFAULTS>): CompactionPlan {
  const o = { ...COMPACT_DEFAULTS, ...opts };
  const estOf = (m: ChatMsgLike) => estTokens(m.content) + (m.tool_calls ? estTokens(JSON.stringify(m.tool_calls)) : 0);
  const estBefore = msgs.reduce((n, m) => n + estOf(m), 0);
  const userIdx: number[] = [];
  msgs.forEach((m, i) => {
    if (m.role === 'user') userIdx.push(i);
  });
  const cut = userIdx.length > o.keepUserTurns ? userIdx[userIdx.length - o.keepUserTurns] : -1;
  const need = cut > 0 && (estBefore > o.maxEst || msgs.length > o.maxMsgs);
  const headCount = need ? cut : 0;
  const estHead = need ? msgs.slice(0, cut).reduce((n, m) => n + estOf(m), 0) : 0;
  return { need, keptFrom: need ? cut : 0, headCount, estBefore, estHead, estTail: estBefore - estHead };
}

/** 初步诊断：句法风险 → 对应的句标记类型（被/从/完归"语法太难"，超长归"句太长"） */
export function pickSentMarkType(risk: { passive: boolean; relcl: boolean; pastperf: boolean; overlong: boolean }): 'syntax' | 'long' {
  return risk.passive || risk.relcl || risk.pastperf ? 'syntax' : 'long';
}

/** 初步诊断：AI 情节要点并入要点配额——按文本精确去重，返回实际新增的条目 */
export function mergeQuotaTexts(existing: string[], incoming: string[]): string[] {
  const set = new Set(existing.map((t) => t.trim()));
  return incoming.map((t) => t.trim()).filter((t) => t && !set.has(t) && (set.add(t), true));
}

/** 段落书签切换：已有同段书签则移除，否则追加（按 pi 去重排序；返回新数组与是否为"添加"） */
export function toggleParaBookmark(list: { pi: number; text: string; ts: number }[], pi: number, text: string, ts: number): { list: { pi: number; text: string; ts: number }[]; added: boolean } {
  if (list.some((b) => b.pi === pi)) return { list: list.filter((b) => b.pi !== pi), added: false };
  return { list: [...list, { pi, text: text.slice(0, 60), ts }].sort((a, b) => a.pi - b.pi), added: true };
}

/* ---------- 双栏逐句对照：实现已下沉 src/core/align.ts（App 与 MCP layer_align 共用唯一实现） ---------- */

export { alignSentencePairs, signalsOf, lostSignals } from '../../src/core/align.js';
export type { AlignSentRef, AlignRow } from '../../src/core/align.js';

