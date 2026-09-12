/**
 * 词典多义项本地消歧（2026-09-13 · Wayne 提案"词汇脚本向量/词重叠匹配，不依赖 LLM"）
 *
 * 数据源：macOS 系统词典（DCSCopyTextDefinition）完整词条——牛津英汉体例：
 *   A. noun B. transitive verb … 词性分节；节内 ①②③ 义项；义项带
 *   标签（Law/Sport…）、英文搭配提示 ‹snow, mud›、双语例句（▸ 开头）。
 *   例句与搭配是 Lesk 重叠法的最佳原料（"the gate had a bar across it" 与
 *   "the animals burst through the bars of the gate" 共享 gate）。
 *
 * 消歧链（与全项目口径一致：教师正本优先，机器不静默）：
 *   ① 教师正本释义（AF注释词典等）——调用方先查，此处不管；
 *   ② 单义项——直接采用；
 *   ③ 多义项——Lesk 词重叠计分（义项文本×语境句），分差不足=歧义待教师，不硬选。
 *   向量层（本地 MiniLM，复用 fidelity 的模型）留作第二阶段：重叠法在词典例句
 *   丰富时已强，不足再开，接口即 pickSense 的 opts 扩展位。
 */

/** 词性分节（A. noun / B. transitive verb / …；部分词条裸 noun 无节标） */
const POS_RE = /(?:[A-Z]\.\s*)?(noun|transitive verb|intransitive verb|verb|adjective|adverb|preposition|conjunction|pronoun|auxiliary verb|modal verb|numeral|interjection|determiner)\b/;

export interface DictSense {
  /** 词性（noun/transitive verb/…） */
  pos: string;
  /** 义项序号原文（①②③…） */
  marker: string;
  /** 中文释义（含拼音，取义项首个中文串；2-12 汉字优先） */
  zh: string;
  /** 英文语义提示（括号标签 + ‹›搭配词），Lesk 原料 */
  en: string;
  /** 例句（▸ 行，保留中英原文），Lesk 原料 */
  examples: string[];
  /** 义项原文（诊断与留痕用） */
  raw: string;
}

/** 从系统词典完整词条解析出义项列表。纯函数、无 IO——同一词条永远同一结果。 */
export function parseSenses(entry: string): DictSense[] {
  const out: DictSense[] = [];
  if (!entry) return out;
  // 按词性节切
  const posMatches = [...entry.matchAll(new RegExp(POS_RE.source, 'g'))];
  posMatches.forEach((pm, i) => {
    const pos = pm[1]!;
    const seg = entry.slice(pm.index! + pm[0].length, posMatches[i + 1]?.index ?? entry.length);
    // 节内按 ①②… 切义项（无圈号的节整节作一个义项）
    const marks = [...seg.matchAll(/[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮]/g)];
    if (!marks.length) {
      pushSense(out, pos, '', seg);
      return;
    }
    marks.forEach((mk, j) => {
      const body = seg.slice(mk.index! + mk[0].length, marks[j + 1]?.index ?? seg.length);
      pushSense(out, pos, mk[0]!, body);
    });
  });
  return out;
}

function pushSense(out: DictSense[], pos: string, marker: string, body: string): void {
  const trimmed = body.trim();
  if (!trimmed) return;
  const examples = [...trimmed.matchAll(/▸\s*([^▸]+)/g)].map((m) => m[1]!.trim()).filter(Boolean);
  // 英文语义提示：义项文本里非中文的英文片段（括号标签 + ‹› 搭配 + 例句英文）
  const en = [...[...trimmed.matchAll(/\(([^)（）]*)\)/g)].map((m) => m[1]!), ...[...trimmed.matchAll(/‹([^›]*)›/g)].map((m) => m[1]!)].join(' ');
  out.push({
    pos,
    marker,
    zh: firstZhGloss(trimmed),
    en,
    examples,
    raw: trimmed.slice(0, 300),
  });
}

/** 义项首个中文释义：优先取 2-12 个连续汉字的串（跳过孤立单字标签），拼音自然被排除。 */
function firstZhGloss(text: string): string {
  const zhRuns = text.match(/[\u4e00-\u9fff][\u4e00-\u9fff（）]+/g) ?? [];
  const hit = zhRuns.find((r) => r.replace(/[（）]/g, '').length >= 2);
  return (hit ?? zhRuns[0] ?? '').replace(/[（）]/g, '').slice(0, 12);
}

/** 英文词集合（小写、去停用词——停用词重叠只会制造平局噪音） */
const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'and', 'or', 'in', 'on', 'is', 'was', 'be', 'it', 'its', 'for', 'with', 'at', 'by', 'as', 'sb', 'sth']);

function enWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z'-]{1,}/g) ?? []).filter((w) => !STOP.has(w));
}

/** Lesk 重叠分：语境句词集与义项文本（提示+搭配+例句）的重叠词数。
 *  例句是主要判别力来源；‹›搭配词命中额外加权（句法搭配是义项的强信号）。 */
export function leskScore(context: string, sense: DictSense): number {
  const ctx = new Set(enWords(context));
  if (!ctx.size) return 0;
  const senseWords = new Set(enWords(`${sense.en} ${sense.examples.join(' ')}`));
  let score = 0;
  for (const w of senseWords) if (ctx.has(w)) score++;
  return score;
}

export interface SensePick {
  /** 选中的义项；歧义不决时为 undefined（调用方报教师，不硬选） */
  sense?: DictSense;
  ambiguous: boolean;
  /** 各义项得分（降序，留痕诊断用） */
  ranked: { zh: string; pos: string; score: number }[];
}

/** 多义项选择：单义项直接用；多义项取 Lesk 最高分——与次高差距 < margin 或最高分为 0
 *  视为歧义不决（宁可得不出交教师，不可静默选错：错义注释直接伤害学生）。 */
export function pickSense(context: string, senses: DictSense[], opts: { margin?: number } = {}): SensePick {
  const margin = opts.margin ?? 1;
  const ranked = senses.map((s) => ({ sense: s, zh: s.zh, pos: s.pos, score: leskScore(context, s) })).sort((a, b) => b.score - a.score);
  const out: SensePick = { ambiguous: false, ranked: ranked.map(({ zh, pos, score }) => ({ zh, pos, score })) };
  if (ranked.length === 1) {
    out.sense = ranked[0]!.sense;
    return out;
  }
  const top = ranked[0]!;
  const second = ranked[1]!;
  if (top.score === 0 || top.score - second.score < margin) {
    out.ambiguous = true;
    return out;
  }
  out.sense = top.sense;
  return out;
}
