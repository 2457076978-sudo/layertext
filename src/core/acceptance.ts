// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，本仓库已部署版权验证体系，细节不予公开（docs/版权与授权.md）。
/**
 * LayerText · 验收 v2 七维度（可本地计算子集）——MCP `layer_acceptance_v2` 的引擎实现
 * （2026-09-18 第一梯队项 2；标准文档 LayerText_验收标准v2_2026-09-17.md，Wayne 七维度表冻结）。
 *
 * 与 `tools/af_pipeline/LayerText_AF验收v2.mjs` 的关系：本模块是**同一套判定的引擎实现**
 * （文本入、结构化结果出，无 IO）；mjs 脚本仍负责 AF 项目的文件装配与报告渲染，判定函数
 * 从本模块取（dist import）——同一条判定只许有一份实现。改造前后以真项目输出逐字节对照验证。
 *
 * 覆盖的维度（文本可算）：未注率排序 B<M<A ｜层间梯度（同段倒挂、句长 1.15 容差）｜
 * 语义确定性（凭空数字/专名丢失/否定归零）｜注释（未注词清单、注密度、重复注）｜
 * 结构（段 ID 对齐/空段/注释外中文/近重复代理）。**不含**：照抄检测与注位审计
 * （它们要读 recap/注位审计.json，属文件装配层的活，见 mjs 脚本）。
 */

export type TierKey = 'A' | 'M' | 'B';

/** 已知词判定器：K = 引擎已学 ∪ 专名 ∪ 功能词前缀 ∪ 分档允许表（调用方装配） */
export type IsUnknown = (w: string) => boolean;

/* ── AF 全书标定的口径常量与私有助手（从验收 v2 脚本原样移植；PHRASE_WINDOW 变更须跑回归——v2.2 待办二）── */

const IRREG: Record<string, string> = {
  been: 'be',
  knew: 'know',
  stood: 'stand',
  feet: 'foot',
  went: 'go',
  came: 'come',
  took: 'take',
  said: 'say',
  made: 'make',
  got: 'get',
  saw: 'see',
  ran: 'run',
  brought: 'bring',
  told: 'tell',
  thought: 'think',
  found: 'find',
  felt: 'feel',
  left: 'leave',
  lost: 'lose',
  kept: 'keep',
  held: 'hold',
  met: 'meet',
  paid: 'pay',
  built: 'build',
  spent: 'spend',
  sang: 'sing',
  sat: 'sit',
  spoke: 'speak',
  wrote: 'write',
  broke: 'break',
  ate: 'eat',
  drank: 'drink',
  drove: 'drive',
  fell: 'fall',
  grew: 'grow',
  wore: 'wear',
  won: 'win',
  woke: 'wake',
  chose: 'choose',
  forgot: 'forget',
  meant: 'mean',
  drew: 'draw',
  flew: 'fly',
  hid: 'hide',
  swam: 'swim',
  rose: 'rise',
  lent: 'lend',
  sent: 'send',
  understood: 'understand',
  done: 'do',
  given: 'give',
  gone: 'go',
  seen: 'see',
  known: 'know',
  shown: 'show',
  spoken: 'speak',
  written: 'write',
  broken: 'break',
  eaten: 'eat',
  drunk: 'drink',
  driven: 'drive',
  fallen: 'fall',
  grown: 'grow',
  worn: 'wear',
  chosen: 'choose',
  forgotten: 'forget',
  thrown: 'throw',
  taken: 'take',
  taught: 'teach',
  caught: 'catch',
  bought: 'buy',
  sold: 'sell',
  led: 'lead',
  fed: 'feed',
  fled: 'flee',
  heard: 'hear',
  beaten: 'beat',
  froze: 'freeze',
  drawn: 'draw',
  torn: 'tear',
  blown: 'blow',
  flung: 'fling',
  bitten: 'bite',
  forbade: 'forbid',
  wept: 'weep',
  dug: 'dig',
  bred: 'breed',
  clung: 'cling',
  swung: 'swing',
  sank: 'sink',
  woken: 'wake',
  swept: 'sweep',
  shrank: 'shrink',
  bled: 'bleed',
  knelt: 'kneel',
  children: 'child',
  men: 'man',
  women: 'woman',
  teeth: 'tooth',
  mice: 'mouse',
  geese: 'goose',
  halves: 'half',
  knives: 'knife',
  lives: 'life',
  leaves: 'leaf',
  wolves: 'wolf',
  shelves: 'shelf',
  wives: 'wife',
  better: 'good',
  best: 'good',
  worse: 'bad',
  worst: 'bad',
  farther: 'far',
  farthest: 'far',
};

const FUNC = new Set(
  'a an the this that these those i you he she it we they me him her us them my your his its our their who whom whose which what of in on at by for with about to from and but or nor so yet if because although though while unless since as than whether when where why how is am are was were be been being do does did have has had will would shall should can could may might must not mr mrs ms dr one two three four five six seven eight nine ten hundred thousand toward towards quite within entire yourselves ourselves themselves sth sb'.split(
    ' ',
  ),
);

function vb(w: string): string[] {
  const out: string[] = [];
  if (w.endsWith('ies') && w.length > 4) out.push(w.slice(0, -3) + 'y');
  if (w.endsWith('es') && w.length >= 4) out.push(w.slice(0, -2));
  if (w.endsWith('s') && w.length > 3) out.push(w.slice(0, -1));
  if (w.endsWith('ing') && w.length > 4) out.push(w.slice(0, -3) + 'e', w.slice(0, -4), w.slice(0, -3));
  if (w.endsWith('ied')) out.push(w.slice(0, -3) + 'y');
  if (w.endsWith('ed') && w.length > 3) out.push(w.slice(0, -2) + 'e', w.slice(0, -3), w.slice(0, -2));
  if (w.endsWith('est') && w.length > 4) {
    const b = w.slice(0, -3);
    out.push(b, b.slice(0, -1));
  }
  if (w.endsWith('er') && w.length > 3) {
    const b = w.slice(0, -2);
    out.push(b.endsWith('i') ? b.slice(0, -1) + 'y' : b, b.slice(0, -1), b + 'e');
  }
  return out;
}

/** 文本归一（剥注释/括号/方括号、展开缩否、小写）——未注率/语义校验共用的读法 */
export function cleanForAcceptance(t: string): string {
  return String(t ?? '')
    .replace(/\r/g, '')
    .replace(/（[^）]*）/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/can't/gi, 'cannot')
    .replace(/won't/gi, 'will not')
    .replace(/shan't/gi, 'shall not')
    .replace(/n't/gi, ' not')
    .replace(/'(s|re|ve|ll|m|d)\b/gi, ' ')
    .toLowerCase();
}

export function makeIsUnknown(known: Iterable<string>): IsUnknown {
  const K = new Set([...known].map((w) => String(w).toLowerCase()));
  return (w: string) => !(K.has(w) || (IRREG[w] && K.has(IRREG[w])) || vb(w).some((b) => K.has(b)) || FUNC.has(w));
}

/** 章节 md → [P##] 段表（Map 保序） */
export function segsOfMd(md: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const b of String(md ?? '')
    .replace(/\r/g, '')
    .split(/\n\s*\n/)) {
    const m = b.match(/^\[P(\d+)\]\s*([\s\S]*)$/);
    if (m) out.set(`P${m[1]}`, m[2].trim());
  }
  return out;
}

const ANNO_FUNCS = new Set('the a an and or but of to in on at for with from that this by as was were is are be been his her their its they he she it not'.split(' '));

/** 已注词型集（短语感知：注覆盖其前方窗口内的内容词 + 连字符成分；窗口默认 60=AF 拟合值，v2.2 参数化） */
export function annoTypesOf(text: string, phraseWindow = 60): Set<string> {
  const s = new Set<string>([...String(text ?? '').matchAll(/([A-Za-z][A-Za-z-]*)（[^）]*）/g)].map((m) => m[1].toLowerCase()));
  for (const m of String(text ?? '').matchAll(/（[^）]*）/g)) {
    const pre = String(text)
      .slice(Math.max(0, (m.index ?? 0) - phraseWindow), m.index ?? 0)
      .replace(/[,;:."'!?——\s]+$/, '');
    const run = pre.split(/[.;:!?"]|\s(?:in|on|at|of|to|for|with|from|but|the|a|an|was|were|is|are|be|been|his|her|their|that|this)\s/g).pop() || '';
    for (const w of run.match(/[A-Za-z][A-Za-z-]*/g) || []) if (w.length >= 3 && !ANNO_FUNCS.has(w.toLowerCase())) s.add(w.toLowerCase());
  }
  for (const w of [...s]) if (w.includes('-')) for (const p of w.split('-')) if (p.length > 2) s.add(p);
  return s;
}

/** 未注生词计数（token 口径，跳过单字母；注释过的词不算） */
export function unnotedTokensOf(text: string, ann: Set<string>, isUnk: IsUnknown): { tokens: number; n: number; words: string[] } {
  let tokens = 0;
  let n = 0;
  const words: string[] = [];
  for (const w of cleanForAcceptance(text).match(/[a-z]+/g) || []) {
    if (w.length < 2 && w !== 'a' && w !== 'i') continue;
    tokens++;
    if (isUnk(w) && !ann.has(w)) {
      n++;
      words.push(w);
    }
  }
  return { tokens, n, words };
}

/** 句长分布（≥2 词的句才算） */
export function sentLensOfSegs(segs: Iterable<string>): number[] {
  const ls: number[] = [];
  for (const t of segs)
    for (const s of String(t ?? '').split(/(?<=[.!?])\s+/)) {
      const n = (s.toLowerCase().match(/[a-z]+/g) || []).length;
      if (n >= 2) ls.push(n);
    }
  return ls;
}

export interface SemanticSuspects {
  fakeNums: string[];
  lostProps: string[];
  /** 源段否定数（not/never/no/cannot） */
  negSource: number;
  /** 产物否定数 */
  negTier: number;
  /** 源段 ≥2 个否定而产物 0 个（疑似反转） */
  negSuspect: boolean;
}

/** 语义确定性校验（vs 源段）：凭空数字/专名丢失/否定归零 */
export function semanticSuspectsOf(sourceSeg: string, tierSeg: string, proper: Set<string>): SemanticSuspects {
  const s = cleanForAcceptance(sourceSeg);
  const t = cleanForAcceptance(tierSeg);
  const numsS = new Set([...s.matchAll(/\b\d+\b/g)].map((m) => m[0]));
  const fakeNums = [...t.matchAll(/\b\d+\b/g)].map((m) => m[0]).filter((x) => !numsS.has(x));
  const lostProps = [...new Set([...(s.match(/[a-z]+/g) || [])].filter((w) => proper.has(w)))].filter((pr) => !t.includes(pr));
  const negSource = (s.match(/\b(not|never|no|cannot)\b/g) || []).length;
  const negTier = (t.match(/\b(not|never|no|cannot)\b/g) || []).length;
  return { fakeNums, lostProps, negSource, negTier, negSuspect: negSource >= 2 && negTier === 0 };
}

export const norm3 = (t: string): string =>
  cleanForAcceptance(t)
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
export const grams3 = (t: string, n = 3): Set<string> => {
  const w = t.split(' ');
  const s = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) s.add(w.slice(i, i + n).join(' '));
  return s;
};
export const jaccard = (a: Set<string>, b: Set<string>): number => {
  let i = 0;
  for (const x of a) if (b.has(x)) i++;
  return i / (a.size + b.size - i || 1);
};

export interface AcceptanceInput {
  tiers: Partial<Record<TierKey, string>>;
  /** 源段表（[P##] → 段文本）；给了才做语义校验 */
  source?: Map<string, string>;
  known: Iterable<string>;
  proper: Iterable<string>;
  phraseWindow?: number;
  /** 同段倒挂豁免（歌词诗段注册表等）：`章/层/段` 判定回调 */
  exemptSeg?: (segId: string, tier: TierKey) => boolean;
}

export interface AcceptanceV2Report {
  rates: Record<string, { tokens: number; unnoted: number; ratePct: number }>;
  /** 全书未注率排序要求 B<M<A */
  rateOrderPass: boolean;
  /** 同段 B 未注 > A 的段（倒挂） */
  segInversions: Array<{ seg: string; bUnnoted: number; aUnnoted: number; words: string[] }>;
  /** B 均句长 ≤ A 均句长 × 1.15（容差 v2.1） */
  sentGradient: { avgA: number; avgB: number; ratio: number; pass: boolean };
  density: Record<string, { per100: number; worst: { d: number; at: string } }>;
  structure: string[];
  semantic: string[];
  duplicateAnnos: string[];
  unnotedByTier: Record<string, Record<string, string[]>>;
}

/** 验收 v2（可本地计算子集）。输入三层整章 md + 已知词集 + 专名集，输出结构化报告。 */
export function acceptanceV2(input: AcceptanceInput): AcceptanceV2Report {
  const isUnk = makeIsUnknown(input.known);
  const proper = new Set([...input.proper].map((p) => String(p).toLowerCase()));
  const pw = input.phraseWindow ?? 60;
  const tiers: Partial<Record<TierKey, Map<string, string>>> = {};
  for (const tk of ['A', 'M', 'B'] as TierKey[]) if (input.tiers[tk] !== undefined) tiers[tk] = segsOfMd(input.tiers[tk]!);

  const rates: AcceptanceV2Report['rates'] = {};
  const unnotedByTier: Record<string, Record<string, string[]>> = {};
  for (const tk of Object.keys(tiers) as TierKey[]) {
    const ann = annoTypesOf(input.tiers[tk]!, pw);
    let tok = 0;
    let unk = 0;
    const perSeg: Record<string, string[]> = {};
    for (const t of tiers[tk]!.values()) {
      for (const w of cleanForAcceptance(t).match(/[a-z]+/g) || []) {
        if (w.length < 2 && w !== 'a' && w !== 'i') continue;
        tok++;
        if (isUnk(w) && !ann.has(w)) {
          unk++;
          (perSeg[w] ??= []).push(w);
        }
      }
    }
    rates[tk] = { tokens: tok, unnoted: unk, ratePct: Number(((100 * unk) / Math.max(1, tok)).toFixed(2)) };
    unnotedByTier[tk] = perSeg;
  }

  const rateOrderPass = rates.A !== undefined && rates.M !== undefined && rates.B !== undefined && rates.B.ratePct < rates.M.ratePct && rates.M.ratePct < rates.A.ratePct;

  // 同段倒挂（B > A，逐段 token 口径）
  const segInversions: AcceptanceV2Report['segInversions'] = [];
  if (tiers.A && tiers.B) {
    const annA = annoTypesOf(input.tiers.A!, pw);
    const annB = annoTypesOf(input.tiers.B!, pw);
    for (const [id, tB] of tiers.B) {
      if (input.exemptSeg?.(id, 'B')) continue;
      const tA = tiers.A.get(id);
      if (tA === undefined) continue;
      const nb = unnotedTokensOf(tB, annB, isUnk).n;
      const na = unnotedTokensOf(tA, annA, isUnk).n;
      if (nb > na) segInversions.push({ seg: id, bUnnoted: nb, aUnnoted: na, words: unnotedTokensOf(tB, annB, isUnk).words });
    }
  }

  const lensA = tiers.A ? sentLensOfSegs(tiers.A.values()) : [];
  const lensB = tiers.B ? sentLensOfSegs(tiers.B.values()) : [];
  const avg = (ls: number[]): number => (ls.length ? ls.reduce((a, b) => a + b, 0) / ls.length : 0);
  const avgA = avg(lensA);
  const avgB = avg(lensB);
  const sentGradient = { avgA: Number(avgA.toFixed(1)), avgB: Number(avgB.toFixed(1)), ratio: Number((avgA > 0 ? avgB / avgA : 0).toFixed(2)), pass: avgA > 0 ? avgB <= avgA * 1.15 : true };

  // 注密度（全书 per100 + 最差段）
  const density: AcceptanceV2Report['density'] = {};
  for (const tk of Object.keys(tiers) as TierKey[]) {
    let notes = 0;
    let words = 0;
    let worst = { d: 0, at: '' };
    for (const [id, t] of tiers[tk]!) {
      const segNotes = (String(t).match(/（[^）]*）/g) || []).length;
      const segWords = (cleanForAcceptance(t).match(/[a-z]+/g) || []).length;
      notes += segNotes;
      words += segWords;
      const d = segWords > 0 ? (100 * segNotes) / segWords : 0;
      if (d > worst.d) worst = { d: Number(d.toFixed(1)), at: id };
    }
    density[tk] = { per100: Number(((100 * notes) / Math.max(1, words)).toFixed(1)), worst };
  }

  // 结构：段 ID 对齐/唯一/非空/杂中文/近重复
  const structure: string[] = [];
  const ids: Partial<Record<TierKey, string[]>> = {};
  for (const tk of Object.keys(tiers) as TierKey[]) {
    ids[tk] = [...tiers[tk]!.keys()];
    if (new Set(ids[tk]).size !== ids[tk]!.length) structure.push(`${tk} 段ID重复`);
    for (const [id, t] of tiers[tk]!) {
      if (!t.trim()) structure.push(`${tk}/${id} 空段`);
      if (/[\u4e00-\u9fff]/.test(t.replace(/（[^）]*）/g, ''))) structure.push(`${tk}/${id} 注释外中文`);
    }
    const gs = [...tiers[tk]!].map(([id, t]) => ({ id, g: grams3(norm3(t)) }));
    for (let i = 0; i < gs.length; i++)
      for (let j = i + 1; j < gs.length; j++) {
        const s = jaccard(gs[i].g, gs[j].g);
        if (s > 0.55) structure.push(`${tk} 近重复 ${gs[i].id}~${gs[j].id}（3gram J=${s.toFixed(2)}）`);
      }
  }
  if (ids.A && ids.M && ids.B) {
    const align = new Set([...ids.A!, ...ids.M!, ...ids.B!]);
    if (!(ids.A!.length === ids.M!.length && ids.M!.length === ids.B!.length && new Set(ids.A!).size === align.size))
      structure.push(`三层段ID不对齐 A:${ids.A!.length}/M:${ids.M!.length}/B:${ids.B!.length}`);
  }

  // 语义（vs 源）
  const semantic: string[] = [];
  if (input.source)
    for (const tk of Object.keys(tiers) as TierKey[])
      for (const [id, t] of tiers[tk]!) {
        const s = input.source.get(id);
        if (!s) continue;
        const v = semanticSuspectsOf(s, t, proper);
        if (v.fakeNums.length) semantic.push(`${tk}/${id} 凭空数字 ${v.fakeNums.join(',')}`);
        for (const pr of v.lostProps) {
          semantic.push(`${tk}/${id} 专名丢失 ${pr}`);
          break;
        }
        if (v.negSuspect) semantic.push(`${tk}/${id} 否定疑似反转`);
      }

  // 同段同词重复注
  const duplicateAnnos: string[] = [];
  for (const tk of Object.keys(tiers) as TierKey[])
    for (const [id, t] of tiers[tk]!) {
      const ws = [...String(t).matchAll(/([A-Za-z][A-Za-z-]*)（[^）]*）/g)].map((x) => x[1].toLowerCase());
      const seen = new Set<string>();
      for (const w of ws) {
        if (seen.has(w)) duplicateAnnos.push(`${tk}/${id} 重复注 ${w}`);
        seen.add(w);
      }
    }

  return { rates, rateOrderPass, segInversions, sentGradient, density, structure, semantic, duplicateAnnos, unnotedByTier };
}
