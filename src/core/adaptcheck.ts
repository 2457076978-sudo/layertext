// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，本仓库已部署版权验证体系，细节不予公开（docs/版权与授权.md）。
/**
 * 两轮调适制 · 本地检查引擎（第一轮之后、教师反馈之前的那道检查）
 *
 * 来源：2026-09-12 Wayne 的《两轮调适制》方向文档第三、五部分。它回答三个问题：
 *   ① 这份稿子的**实际阅读负担**在哪（注释拥挤、长句）——给教师看，也决定第二轮复写哪些段；
 *   ② 情节保真有没有**可疑的变化**（否定消失、因果连接变化）——只提请人工确认，不当场判错；
 *   ③ 第二轮有没有**用新难词绕过**旧问题（引入了原文里没有的超纲词）。
 *
 * ── 口径声明（不许丢） ─────────────────────────────────────────────────
 * 阈值是**首版工程试运行阈值**，不是已验证的教学标准：先用最难、注释最拥挤的章节
 * 验证再调，不得写成"适合某年级"的依据。所有判定都是"提醒再简化"，不是禁止教师
 * 保留例外——教师说保留就保留。
 *
 * 纯逻辑：不读文件、不调 AI。文件与调用轮次由管线（tools/）管。
 */

import { sentsOf } from './textpipe.js';

/* ────────────────────── 阈值（工程试运行，非教学标准） ────────────────────── */

/** 每百英文词**显示注释处数**超过该线 → 该段进入第二轮复写清单 */
export const ANNO_DENSITY_LIMIT: Record<string, number> = { A: 6, M: 4, B: 3 };
/** 最长英文句超过该词数 → 触发检查（提醒，不是硬门禁） */
export const SENT_LEN_CHECK: Record<string, number> = { A: 20, M: 17, B: 14 };
/** 拥挤窗口的词数（短段不单独按百分比触发，并入约百词窗口计算） */
export const WINDOW_WORDS = 100;

/* ────────────────────── 基础口径 ────────────────────── */

/** 一处显示注释：`word（中文）` 全角括号格式（项目唯一注释口径） */
const ANNO_RE = /([A-Za-z][A-Za-z'-]*)（[^）（]*）/gu;
const WORD_RE = /[A-Za-z][A-Za-z'-]*/g;
/** 段号标记 `[P07]`：计数前去掉（它是锚不是内容） */
const SEG_MARK_RE = /\[P\d+\]/g;

const wordsOf = (s: string): number => (s.match(WORD_RE) ?? []).length;
/** 数英文词之前先剥掉注释里的中文——词数只数学生真正读的英文 */
const stripZh = (s: string): string => s.replace(/（[^）（]*）/gu, ' ');

/* ── 词形家族容错（对照与超纲判定共用的粗版口径） ──
 * 原文有 action、产物写 actions：这是同一个词的变形，不是"引入新词"。
 * 双边都展开常见变形（s/es/ed/ing/双写/ies/所有格），命中任一形态即算同词。
 * 高频不规则过去式/分词也并进来（chose↔choose、drank↔drink 类）——QC 引擎的
 * 不规则表是它自己的口径（红线不动），这张小表只服务于"引入对照"，防止把
 * choose 的过去式误报成新词。 */
const IRREGULAR: Record<string, string> = {
  chose: 'choose',
  drank: 'drink',
  froze: 'freeze',
  blew: 'blow',
  grew: 'grow',
  knew: 'know',
  threw: 'throw',
  flew: 'fly',
  drew: 'draw',
  fell: 'fall',
  felt: 'feel',
  kept: 'keep',
  slept: 'sleep',
  left: 'leave',
  lost: 'lose',
  built: 'build',
  sent: 'send',
  spent: 'spend',
  lent: 'lend',
  burnt: 'burn',
  dreamt: 'dream',
  learnt: 'learn',
  sold: 'sell',
  told: 'tell',
  won: 'win',
  beaten: 'beat',
  blown: 'blow',
  grown: 'grow',
  known: 'know',
  thrown: 'throw',
  shown: 'show',
  drawn: 'draw',
  fallen: 'fall',
  given: 'give',
  taken: 'take',
  eaten: 'eat',
  broken: 'break',
  stolen: 'steal',
  chosen: 'choose',
  frozen: 'freeze',
  driven: 'drive',
  ridden: 'ride',
  risen: 'rise',
  gone: 'go',
  done: 'do',
  seen: 'see',
  been: 'be',
  had: 'have',
  made: 'make',
  said: 'say',
  ran: 'run',
  came: 'come',
  began: 'begin',
  sang: 'sing',
  swam: 'swim',
  sat: 'sit',
  stood: 'stand',
  understood: 'understand',
  hid: 'hide',
  spread: 'spread',
  shut: 'shut',
  cut: 'cut',
  hurt: 'hurt',
  woke: 'wake',
  woken: 'wake',
  better: 'good',
  best: 'good',
  /* 常用过去式补录（2026-09-12 M 层实跑：forgot 被注「忘记了」暴露原表过稀） */
  broke: 'break',
  forgot: 'forget',
  took: 'take',
  gave: 'give',
  saw: 'see',
  went: 'go',
  got: 'get',
  ate: 'eat',
  wrote: 'write',
  spoke: 'speak',
  drove: 'drive',
  rode: 'ride',
  rose: 'rise',
  shook: 'shake',
  wore: 'wear',
  beat: 'beat',
  bit: 'bite',
  fought: 'fight',
  thought: 'think',
  brought: 'bring',
  bought: 'buy',
  caught: 'catch',
  taught: 'teach',
  held: 'hold',
  met: 'meet',
  paid: 'pay',
  laid: 'lay',
};

export const normalizeWord = (w: string): string => w.toLowerCase().replace(/['’]s$/, '');

export function expandForms(w: string): string[] {
  const x = normalizeWord(w);
  const forms = new Set([x]);
  const base = IRREGULAR[x];
  if (base) forms.add(base);
  /* 反向：原形展开也带上它的不规则变形（原文 choose → 产物 chose 不算引入） */
  for (const [k, v] of Object.entries(IRREGULAR)) if (v === x) forms.add(k);
  /* 复数（2026-09-12 修复：旧 -es 分支先命中把 horses 剥成 hors，普通 -s 候选永远
   *  出不来——horses/edges 全被当生词注了「马」「边缘」）。规则：ies→y；
   *  ch/sh/ss/x/z+es→去 es；普通 s→去 s。互斥分支改为一组可叠加候选。 */
  if (x.endsWith('ies')) forms.add(`${x.slice(0, -3)}y`);
  else if (/(?:ch|sh|ss|x|z)es$/.test(x)) forms.add(x.slice(0, -2));
  if (/[^s]s$/.test(x)) forms.add(x.slice(0, -1));
  if (x.endsWith('ed')) {
    forms.add(x.slice(0, -2));
    forms.add(x.slice(0, -1));
    forms.add(`${x.slice(0, -2)}e`);
  }
  if (x.endsWith('ing')) {
    forms.add(x.slice(0, -3));
    forms.add(`${x.slice(0, -3)}e`);
    forms.add(x.slice(0, -4));
  }
  if (x.endsWith('ied')) forms.add(`${x.slice(0, -3)}y`);
  /* 双写去尾：running→run（ing 去掉后双辅音收尾，再收一次） */
  if (/(.)\1(ing|ed)$/.test(x)) {
    forms.add(x.replace(/(.)\1(ing|ed)$/, '$1'));
    forms.add(x.replace(/(.)\1(ing|ed)$/, '$1e'));
  }
  /* 比较级/最高级（2026-09-12 修复：greater 缺 -er 变形被当生词注了「更大的」——
   *  词表收原形，变形靠这里展开）。只收**不产生假命中**的规则：通用 -er 双候选
   *  （greater→great、nicer→nice、worker→work）与 -ier/-iest→y（happier/happiest→happy）。
   *  通用 -est 与双写 -er 不收：west→we、forest→for、modest→mode、summer→sum 会把
   *  生词误判已学（漏注比多注更伤学生）；better/best/greatest 这类不规则与已收录
   *  形走 IRREGULAR 表与词库行。 */
  if (x.endsWith('er')) {
    forms.add(x.slice(0, -2));
    forms.add(x.slice(0, -1));
  }
  if (x.endsWith('ier')) forms.add(`${x.slice(0, -3)}y`);
  if (x.endsWith('iest')) forms.add(`${x.slice(0, -4)}y`);
  return [...forms];
}

/** 一个词是否落在"已学集合"里（词形家族容错；known 为原形集合） */
export function knownWordHit(w: string, known: Set<string>): boolean {
  return expandForms(w).some((f) => known.has(f));
}

export interface CrowdedSentence {
  /** 句子原文（截断到 120 字符，给人看） */
  text: string;
  /** 段号（从所在段继承；拿不到就是空串） */
  segId: string;
  annos: number;
  words: number;
}

export interface CrowdedWindow {
  /** 窗口内英文词数（≈100） */
  words: number;
  annos: number;
  /** 每百词注释处数（一位小数） */
  density: number;
  /** 窗口首句的前 80 字符，定位用 */
  head: string;
}

/** 一份稿子的负担剖面：全文的数 + **最拥挤的一句/一窗**（防平均值掩盖局部） */
export interface BurdenProfile {
  words: number;
  annos: number;
  /** 每百词注释处数（全文，一位小数）——只作参考，判定看段与窗口 */
  densityPer100: number;
  longestSentence: { words: number; text: string } | null;
  /** 一句 ≥2 处注释的句子（触发检查） */
  crowdedSentences: CrowdedSentence[];
  worstSentence: CrowdedSentence | null;
  worstWindow: CrowdedWindow | null;
}

/**
 * 算一份稿子的负担剖面。
 *
 * 为什么必须同时保留"最拥挤一句/一窗"：全文平均 4.0 处/百词合格，
 * 但某一句塞了四处注释——学生读到那一句时的中断是真实的。平均值会撒谎，
 * 最差局部不会。窗口按**词序列**滑（不按段切），短段自然并入相邻窗口。
 */
export function burdenProfileOf(md: string): BurdenProfile {
  /* 标题行（# …）与引用元数据行（> …）不是学生读的正文——header 里的英文不算负担 */
  const paras = md.split(/\n+/).filter((p) => /[A-Za-z]{2,}/.test(p) && !/^\s*[#>]/.test(p));
  const allAnnos: { segId: string; word: string }[] = [];
  const crowded: CrowdedSentence[] = [];
  let longest: { words: number; text: string } | null = null;

  /* 逐段：段号继承给句，注释逐处登记（供窗口滑动用） */
  const tokenStream: { word: string; annoHere: boolean; segId: string }[] = [];
  for (const para of paras) {
    const segId = para.match(SEG_MARK_RE)?.[0]?.replace(/[[\]]/g, '') ?? '';
    const body = para.replace(SEG_MARK_RE, ' ');
    const annos = [...body.matchAll(ANNO_RE)].map((m) => m[1]!);
    for (const w of annos) allAnnos.push({ segId, word: w });
    const sents = sentsOf(body, false);
    for (const s of sents) {
      const n = [...s.matchAll(ANNO_RE)].length;
      const w = wordsOf(stripZh(s));
      if (!longest || w > longest.words) longest = { words: w, text: s.slice(0, 120) };
      if (n >= 2) crowded.push({ text: s.slice(0, 120), segId, annos: n, words: w });
    }
    /* 词序列展开（注释英文词保留在流里，其位置挂注释标记） */
    const wr = new RegExp(WORD_RE.source, 'g');
    for (let m = wr.exec(body); m; m = wr.exec(body)) {
      /* 该词是否落在某个注释的英文词上：词起点在 ANNO_RE 命中区间内 */
      const re2 = new RegExp(ANNO_RE.source, 'gu');
      let inAnno = false;
      for (let a = re2.exec(body); a; a = re2.exec(body)) {
        if (m.index >= a.index && m.index < a.index + a[0].length) {
          inAnno = true;
          break;
        }
      }
      tokenStream.push({ word: m[0], annoHere: inAnno, segId });
    }
  }

  /* 最拥挤窗口：按词序列滑一个 ≈WINDOW_WORDS 的窗，取密度最高者 */
  let worstWindow: CrowdedWindow | null = null;
  if (tokenStream.length >= WINDOW_WORDS / 2) {
    for (let start = 0; start + 10 <= tokenStream.length; start += 20) {
      const end = Math.min(tokenStream.length, start + WINDOW_WORDS);
      const slice = tokenStream.slice(start, end);
      const annos = slice.filter((t) => t.annoHere).length;
      const words = slice.length;
      const density = Number(((annos * 100) / Math.max(1, words)).toFixed(1));
      if (!worstWindow || density > worstWindow.density) {
        worstWindow = {
          words,
          annos,
          density,
          head: slice
            .slice(0, 12)
            .map((t) => t.word)
            .join(' ')
            .slice(0, 80),
        };
      }
    }
  }

  const words = tokenStream.length;
  const annos = allAnnos.length;
  return {
    words,
    annos,
    densityPer100: Number(((annos * 100) / Math.max(1, words)).toFixed(1)),
    longestSentence: longest,
    crowdedSentences: crowded,
    worstSentence: crowded.length ? crowded.reduce((a, b) => (b.annos > a.annos || (b.annos === a.annos && b.words > a.words) ? b : a)) : null,
    worstWindow,
  };
}

/* ────────────────────── 分级检查 ────────────────────── */

export type CheckLevel = '结构' | '信息变化' | '难度';

export interface CheckFinding {
  level: CheckLevel;
  /** 一句人话：问题是什么、在哪 */
  note: string;
  segId?: string;
}

export interface BurdenOptions {
  tier: string;
  /** 专名表（crowdReason 归因用；没有就传空数组） */
  properNouns?: string[];
  /** 知识库"必要保留词"（教师确认的必要概念；没有就传空数组） */
  mustKeep?: string[];
}

/**
 * 负担判定：注释密度与最长句超线 → "难度"级 finding（第二轮处理；教师说保留就保留）。
 * 拥挤注释词若主要是专名/必要概念 → **归因说明**，不为降指标删情节。
 */
export function burdenFindings(md: string, opts: BurdenOptions): { profile: BurdenProfile; findings: CheckFinding[] } {
  const profile = burdenProfileOf(md);
  const findings: CheckFinding[] = [];
  const densityLimit = ANNO_DENSITY_LIMIT[opts.tier] ?? ANNO_DENSITY_LIMIT.M;
  const lenLimit = SENT_LEN_CHECK[opts.tier] ?? SENT_LEN_CHECK.M;

  if (profile.worstWindow && profile.worstWindow.density > densityLimit) {
    findings.push({
      level: '难度',
      note: `注释拥挤：最密窗口每百词 ${profile.worstWindow.density} 处注释（试运行阈值 ${densityLimit}），窗口起于「${profile.worstWindow.head}…」`,
    });
  }
  for (const s of profile.crowdedSentences.slice(0, 5)) {
    findings.push({ level: '难度', segId: s.segId, note: `一句 ${s.annos} 处注释（${s.segId || '（无段号）'}，${s.words} 词）：${s.text}` });
  }
  if (profile.longestSentence && profile.longestSentence.words > lenLimit) {
    findings.push({ level: '难度', note: `最长句 ${profile.longestSentence.words} 词（检查线 ${lenLimit}）：${profile.longestSentence.text}` });
  }

  /* 归因：拥挤到底是谁造成的——必要概念造成的要说明，不许为指标删情节 */
  const proper = new Set((opts.properNouns ?? []).map((w) => w.toLowerCase()));
  const must = new Set((opts.mustKeep ?? []).map((w) => w.toLowerCase()));
  if (findings.some((f) => f.note.startsWith('注释拥挤'))) {
    const crowdedWords = [...md.matchAll(ANNO_RE)].map((m) => m[1]!.toLowerCase());
    const irreplaceable = crowdedWords.filter((w) => proper.has(w) || must.has(w)).length;
    if (crowdedWords.length && irreplaceable / crowdedWords.length >= 0.5) {
      findings.push({
        level: '难度',
        note: `归因：本稿拥挤注释中 ${irreplaceable}/${crowdedWords.length} 属专名或必要概念——第二轮应换写其余难词，这些保留并集中预教，不为降指标删情节`,
      });
    }
  }
  return { profile, findings };
}

/* ────────────────────── 情节保真对照（只提请确认，不当场判错） ────────────────────── */

/** 否定标记与关键因果连接（对照口径：数量级变化=信息变化级 finding） */
const NEG_RE = /\b(not|never|no|none|nothing|nobody|cannot|can't|won't|didn't|doesn't|don't|isn't|aren't|wasn't|weren't|hasn't|haven't|hadn't|wouldn't|shouldn't|couldn't|mustn't)\b/gi;
const CAUSE_RE = /\b(because|so|therefore|as a result|so that|in order to|although|but|however)\b/gi;

export interface FidelityCounts {
  negations: number;
  causal: number;
}

export const fidelityCountsOf = (md: string): FidelityCounts => ({
  negations: (stripZh(md).match(NEG_RE) ?? []).length,
  causal: (stripZh(md).match(CAUSE_RE) ?? []).length,
});

/**
 * 否定/因果对照：原文与产物的计数差。差一两个词通常是改写形态变化（合并同类规则时
 * 否定词数会自然下降）；**整类消失**（产物掉到原文的一半以下）才提请人工确认——
 * "不得杀害"被改成"可以杀害"这类反向，指标全绿也必须有人看一眼。
 */
export function fidelityFindings(src: string, out: string): CheckFinding[] {
  const a = fidelityCountsOf(src);
  const b = fidelityCountsOf(out);
  const findings: CheckFinding[] = [];
  if (a.negations >= 3 && b.negations < a.negations * 0.5) {
    findings.push({ level: '信息变化', note: `否定表达明显减少（原文 ${a.negations} → 产物 ${b.negations}）——请人工确认没有"不得做"被改成"可以做"这类反向改写` });
  }
  if (a.causal >= 3 && b.causal < a.causal * 0.5) {
    findings.push({ level: '信息变化', note: `因果连接明显减少（原文 ${a.causal} → 产物 ${b.causal}）——请确认因果关系没有在简化中丢失` });
  }
  return findings;
}

/* ────────────────────── 新引入词（防第二轮绕过） ────────────────────── */

/**
 * 产物超纲词里，**原文没出现过**的那部分——第二轮若用没检查过的新难词替换旧难词，
 * 数字上"超纲数"不变甚至下降，这里把它揪出来。词形家族容错（action↔actions↔acted
 * 算同一个词），否则基础词的普通变形会淹没真正的"引入"。
 */
export function introducedHardWords(src: string, out: string, isHard: (w: string) => boolean): string[] {
  const srcForms = new Set<string>();
  for (const w of stripZh(src).toLowerCase().match(WORD_RE) ?? []) for (const f of expandForms(w)) srcForms.add(f);
  const outWords = [...new Set((stripZh(out).toLowerCase().match(WORD_RE) ?? []).map(normalizeWord))];
  return outWords.filter((w) => isHard(w) && !expandForms(w).some((f) => srcForms.has(f))).sort();
}

/* ────────────────────── 教师反馈解析（第二轮的驱动信号） ────────────────────── */

export type FeedbackMagnitude = '轻度' | '明显' | '大幅';

/** 反馈的幅度 → 单元回退数（**档位折算**，不是精确换算：显式记录、可纠正、从不声称精确） */
export const MAGNITUDE_UNITS: Record<FeedbackMagnitude, number> = { 轻度: 1, 明显: 2, 大幅: 4 };

const DIM_PATTERNS: [string, RegExp][] = [
  ['词汇', /词汇|单词|生词|用词|词太多|词偏难/],
  ['句法', /句子|句长|句式|绕|嵌套|太长/],
  ['理解', /理解|看不懂|推断|指代|关系不清/],
  ['背景', /背景|文化|概念陌生/],
  ['支架', /注释|注太多|太密|中断/],
];
const KEEP_RE = /(词汇|句子|句法|理解|情节|人物|背景|注释)[^，。；,;]{0,6}(可以|没问题|合适|保留|不用动|还行|挺好)/;

/**
 * 解析教师的一句自然语言反馈。教师不必填表——"词汇超前一学期，句子偏长，情节可以"
 * 就是完整输入。解析不出来的部分保留在 raw 里交给第二轮 prompt 原样参考（AI 自己读得懂）。
 */
export interface TeacherFeedback {
  /** 需要处理的维度（词汇/句法/理解/背景/支架） */
  dims: string[];
  /** 教师明确说"可以"的维度——第二轮**不改**这些方面已经合适的表达 */
  keep: string[];
  magnitude: FeedbackMagnitude | null;
  /** 教师点名的英文词（"这几个词他们不会"）——举一反三的种子 */
  tooHardWords: string[];
  raw: string;
}

export function parseTeacherFeedback(text: string): TeacherFeedback {
  const t = text ?? '';
  const dims: string[] = [];
  for (const [dim, re] of DIM_PATTERNS) if (re.test(t) && !dims.includes(dim)) dims.push(dim);
  const keep: string[] = [];
  for (const m of t.matchAll(new RegExp(KEEP_RE.source, 'g'))) {
    const dim = DIM_PATTERNS.find(([, re]) => re.test(m[1]!))?.[0] ?? m[1]!;
    if (!keep.includes(dim)) keep.push(dim);
  }
  let magnitude: FeedbackMagnitude | null = null;
  if (/一(个)?学年|整个学年|一整年|差一年|大幅/.test(t)) magnitude = '大幅';
  else if (/一(个)?学期|半学年|半学期|明显/.test(t)) magnitude = '明显';
  else if (/两个月|一个月|几周|稍微|略|一点|轻度/.test(t)) magnitude = '轻度';
  if (/整体|全都|整体太|还是太/.test(t) && magnitude) {
    for (const [dim] of DIM_PATTERNS) if (!dims.includes(dim)) dims.push(dim);
  }
  const tooHardWords = [...new Set((t.match(/\b[A-Za-z][A-Za-z'-]{2,}\b/g) ?? []).map((w) => w.toLowerCase()))];
  return { dims, keep, magnitude, tooHardWords, raw: t };
}

/* ────────────────────── 修订任务单（四方向方案 v2 §5.2，先确认后执行） ────────────────────── */

import { Stage, STAGE_ORDER, STAGE_LABEL } from './stagepatch.js';

/** 反馈维度 → 重跑工序（方案表 2 的唯一代码化；测试锁行为） */
export const FEEDBACK_STAGE_MAP: Record<string, readonly Stage[]> = {
  词汇: ['vocab-primary', 'vocab-secondary', 'annotation'],
  句法: ['syntax', 'vocab-secondary'],
  理解: ['coherence'],
  背景: ['coherence'],
  支架: ['annotation'],
};

/** keep 维度（解析出的"这些方面可以"）→ 结构化保护维度 */
const KEEP_DIM_MAP: Record<string, ProtectedDimension> = {
  情节: 'plot',
  人物: 'characters',
  词汇: 'vocabulary',
  句子: 'syntax',
  句法: 'syntax',
  理解: 'coherence',
  背景: 'background',
  注释: 'support',
};

export type ProtectedDimension = 'plot' | 'characters' | 'facts' | 'syntax' | 'vocabulary' | 'coherence' | 'background' | 'support';

export interface RevisionTask {
  chapterId: string;
  /** 基于哪一版稿（R1 版本；协议只透传） */
  baseVersion: string;
  /** 重跑工序与范围；情节有疑问 → 空（转人工，不跑 AI） */
  stages: Array<{ stage: Stage; scope: 'chapter' | 'segments' | 'terms' }>;
  magnitude: FeedbackMagnitude | null;
  protectedDimensions: ProtectedDimension[];
  /** 教师点名保留的词（「这几个词不用换」类显式保留；解析不出就空，预览不虚报） */
  protectedTerms: string[];
  /** 教师点名的难词（举一反三的种子——是要换掉的，不是要保留的，别拿反） */
  seedWords: string[];
  /** 需要人工确认的疑问（情节类反馈不猜） */
  needsHuman: string[];
  rawFeedback: string;
  /** 解析明细（预览展示与报告留痕用） */
  parsed: TeacherFeedback;
}

/**
 * 把教师反馈解析成结构化任务单。这是「先确认后执行」的数据基础：App 与管线
 * 都从这一份解析出"将修改/将保留"，教师点开始修订才进第二轮。
 * 解析不出的部分留在 parsed.raw 与 needsHuman——预览页必须停在那里等教师，不许默默执行。
 */
export function planRevisionTask(chapterId: string, baseVersion: string, feedbackRaw: string, opts: { markedTooHard?: string[] } = {}): RevisionTask {
  const fb = parseTeacherFeedback(feedbackRaw);
  const tooHardWords = [...new Set([...fb.tooHardWords, ...(opts.markedTooHard ?? []).map((w) => w.toLowerCase())])];

  const stages: RevisionTask['stages'] = [];
  const whole = fb.dims.length >= 4 || /整体|全部|全篇/.test(fb.raw);
  for (const dim of fb.dims) {
    for (const stage of FEEDBACK_STAGE_MAP[dim] ?? []) {
      if (!stages.some((s) => s.stage === stage)) stages.push({ stage, scope: whole ? 'chapter' : 'segments' });
    }
  }
  if (tooHardWords.length && !stages.some((s) => s.stage === 'vocab-primary')) {
    stages.push({ stage: 'vocab-primary', scope: 'terms' });
  }

  /* 逐维度独立扫描而不是用 fb.keep：KEEP_RE 的全局匹配会把「情节和人物可以」
   * 整段吃掉只留下「情节」，人物保护悄悄丢——保护维度是第二轮的硬约束，逐词各查一遍。 */
  const protectedDimensions = new Set<ProtectedDimension>(['facts']);
  for (const [word, dim] of Object.entries(KEEP_DIM_MAP)) {
    if (new RegExp(`${word}[^，。；,;]{0,6}(可以|没问题|合适|保留|不用动|还行|挺好)`).test(feedbackRaw)) {
      protectedDimensions.add(dim);
    }
  }
  for (const k of fb.keep) {
    const d = KEEP_DIM_MAP[k];
    if (d) protectedDimensions.add(d);
  }

  /* 情节类反馈不猜：未被认可的情节（不在保护维度里）不进任何工序，转人工确认（表 2 第 5 行）。
   * 判保护看 protectedDimensions（逐词独立扫描的结果），不看 fb.keep——
   * KEEP_RE 全局匹配会把「人物和情节可以」整段吃掉只留一个词（实测）。 */
  const needsHuman: string[] = [];
  if (/情节|剧情|故事线/.test(fb.raw) && !protectedDimensions.has('plot')) {
    needsHuman.push('反馈提到情节且未被认可为「可以」——系统不猜测情节，请人工处理后再执行');
  }

  return {
    chapterId,
    baseVersion,
    stages,
    magnitude: fb.magnitude,
    protectedDimensions: [...protectedDimensions],
    protectedTerms: [],
    seedWords: tooHardWords,
    needsHuman,
    rawFeedback: feedbackRaw,
    parsed: fb,
  };
}

/** 任务单 → 实际重跑的工序序列（固定顺序，去重） */
export function planRevisionStages(task: RevisionTask): Stage[] {
  const wanted = new Set(task.stages.map((s) => s.stage));
  return STAGE_ORDER.filter((s) => wanted.has(s));
}

/** 任务单 → 预览文本（App 与 CLI --plan 共用同一份渲染，两处不长两种样子） */
export function revisionTaskPreview(task: RevisionTask): string[] {
  const lines: string[] = [];
  const scopeOf = new Map(task.stages.map((s) => [s.stage, s.scope]));
  const modify = task.stages.length
    ? planRevisionStages(task)
        .map((s) => `${STAGE_LABEL[s]}${scopeOf.get(s) === 'chapter' ? '（全章）' : scopeOf.get(s) === 'terms' ? '（点名词举一反三）' : ''}`)
        .join(' → ')
    : '（无）';
  lines.push(`将修改：${modify}`);
  lines.push(`保留（不改这些方面）：${task.protectedDimensions.join('、')}${task.protectedTerms.length ? `；点名保留的词：${task.protectedTerms.slice(0, 8).join('、')}` : ''}`);
  if (task.seedWords.length) lines.push(`点名难词（举一反三处理同类）：${task.seedWords.slice(0, 8).join('、')}${task.seedWords.length > 8 ? '…' : ''}`);
  lines.push(`幅度：${task.magnitude ?? '（未识别——按维度整体处理，不猜档位）'}`);
  for (const n of task.needsHuman) lines.push(`⚠ 待人工确认：${n}`);
  if (!task.parsed.dims.length && !task.protectedTerms.length) {
    lines.push('⚠ 反馈未解析出可执行的维度——请换一句话说明（例：词汇偏难一个学期，P3 和 P8 句子太长，人物关系不用动）');
  }
  return lines;
}
