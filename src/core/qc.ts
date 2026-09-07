/**
 * LayerText · QC 引擎（自动质检，指标①-⑨）
 *
 * 逐行移植自原型 qc_chapter.py。口径要点：
 *  - 直接引语豁免（R08）：双引号内文本在句法计数前整体移除（引语只降词不降句式）
 *  - 锚点白名单：教师可将特定短语设为豁免（计数前替换为占位符）
 *  - 待定词暂计已知（覆盖率口径），风险量由指标⑨单独计量
 *  - 词句卡首列词条并入已知（"注释后口径"）
 */

import { FAKE, HAD_ADVERBS, IRR, PASSIVE_IRR, PART_LIST, THAT_EXEMPT } from './irregular.js';
import type { Lexicon } from './lexicon.js';
import { extractParas, hit, pendHit, sentsOf, splitChapter, tokenizeTxt, cardGlossWords } from './textpipe.js';

export type Tier = 'A' | 'B' | 'M';

export interface QcOptions {
  tier: Tier;
  /** 章号（用于 A 层被动/定从解禁判定；null = 未知 → 不禁） */
  chno?: number | null;
  /** 分层方案覆盖（教师可调；缺省用原型设定：被动第5章起、定从第8章起解禁） */
  tierGates?: { passiveFromCh: number; relclFromCh: number };
  /** 原文级锚点豁免短语（整短语替换后计数） */
  anchors?: string[];
  /** 歌篇标记（含该短语的段落按歌词口径单独统计；默认沿用原型标记） */
  songMarker?: string;
  /** ⑧ 专名一致性检查名单（正文出现的专名必须出现在词句卡） */
  propCheckList?: string[];
  /** 免检专名（不出词句卡也不报错） */
  propExempt?: string[];
  /** 已学词集（复现队列，feature/reinforce）：①不再计 OOV ②单独统计复现命中 */
  reinforceWords?: string[];
  fileName?: string;
}

export interface QcResult {
  tier: Tier;
  chno: number | null;
  fileName: string;
  paraCount: number;
  sentCount: number;
  tokenCount: number;
  coverage: number;        // ① 词表覆盖率（注释后口径）
  newWordRate: number;     // ② 生词率（词型口径）
  avgLenRaw: number;       // ③ 平均句长（原始值，展示时再舍入）
  avgLenNarrRaw: number;   // ③ 平均句长（去歌词）
  maxLen: number;          // ④ 单句最长
  over20: number;          // ④ 超 20 词句数
  passive: number;         // ⑤ 被动式计数（叙事区）
  relcl: number;           // ⑥ 定语从句计数（叙事区）
  pastperf: number;        // ⑦ 过去完成计数（叙事区）
  propConsistent: boolean; // ⑧ 专名-术语表一致
  thatCheck: number;       // that 从句待人工复核
  pendingHits: number;     // ⑨ 待定词 token 命中（保守口径风险）
  oov: string[];           // OOV 词（未去重）
  gates: { passiveOk: boolean; relclOk: boolean }; // A 层解禁门
  // ---- ⑩ 复现指标（feature/reinforce；仅当 reinforceWords 提供时存在，保证旧报告 schema 不变） ----
  reinforceQueue?: number;     // 队列词数
  reinforceHits?: number;      // 命中队列的词种数
  reinforceTokens?: number;    // 命中 token 总次数（重复强度）
  reinforceHitList?: string[]; // 命中词清单
}

function count(re: RegExp, t: string): number {
  return [...t.matchAll(re)].length;
}

/** Python round(x, 1) 等价实现：对 double 的精确十进制展开做半偶舍入。
 *  不能用 x*10 再取整——乘法自身会制造/抹掉 tie（如 6.35 的二进制真值是
 *  6.3499…，Python round(6.35,1)==6.3）。 */
export function pyRound1(x: number): number {
  if (!Number.isFinite(x) || Math.abs(x) >= 1e15) return x;
  const sign = x < 0 ? -1 : 1;
  const s = Math.abs(x).toFixed(20);
  const point = s.indexOf('.');
  const scaled = parseInt(s.slice(0, point) + s[point + 1], 10); // 保留到 0.1 的整数
  const rest = s.slice(point + 2);
  let n = scaled;
  const c = rest.length ? rest[0] : '0';
  if (c > '5') n = scaled + 1;
  else if (c === '5') {
    if (/[1-9]/.test(rest.slice(1))) n = scaled + 1; // 超过半 → 进
    else n = scaled % 2 === 0 ? scaled : scaled + 1; // 恰半 → 半偶
  }
  return (sign * n) / 10;
}

export function runQc(md: string, lex: Lexicon, opts: QcOptions): QcResult {
  const { body, card } = splitChapter(md);
  const paras = extractParas(body);

  const songMarker = opts.songMarker ?? 'Beasts of England';
  const allSents: string[] = [];
  const songSents: string[] = [];
  for (const p of paras) {
    const isSong = p.includes(songMarker);
    const ss = sentsOf(p, isSong);
    if (isSong) songSents.push(...ss);
    allSents.push(...ss);
  }
  if (allSents.length === 0) throw new Error('未切分出任何句子（正文区缺少 [P01] 段落标记？）');

  const wc = (s: string) => s.split(/\s+/).filter(Boolean).length;
  const lens = allSents.map(wc);
  const songSet = new Set(songSents);
  const lensNarr = lens.filter((_, i) => !songSet.has(allSents[i]));
  const lensN = lensNarr.length ? lensNarr : lens;

  // ---- 句法黑名单计数（叙事区 = 非歌篇；直接引语整体豁免；锚点替换豁免） ----
  let txtNarr = allSents.filter((s) => !songSet.has(s)).join(' ');
  txtNarr = txtNarr.replace(/"[^"]*"/g, ' ');
  (opts.anchors ?? []).forEach((a, i) => {
    txtNarr = txtNarr.split(a).join(`LAYERTEXT-ANCHOR-${i}`);
  });

  const passiveBase =
    count(new RegExp(String.raw`\b(?:was|were|is|are|be|been|being)\s+${FAKE}\w+ed\b`, 'g'), txtNarr) +
    count(new RegExp(String.raw`\b(?:was|were)\s+(?:${PASSIVE_IRR})\b`, 'g'), txtNarr);
  const relclWhoWhich = count(/,?\s+(?:who|which)\s+\w+/g, txtNarr);
  const thatRelcl = count(
    new RegExp(String.raw`\b[a-z]+\s+that\s+(?!${THAT_EXEMPT})[a-z]+(?:ed|s|ing)\b`, 'g'),
    txtNarr,
  );
  const relcl = relclWhoWhich + thatRelcl;
  const thatCheck = count(/\b\w+\s+that\s+\w+(?:s|ed|ing)?\b/g, txtNarr);
  const pastperf =
    count(new RegExp(String.raw`\bhad\s+${HAD_ADVERBS}${FAKE}(\w+ed)\b`, 'g'), txtNarr) +
    count(new RegExp(String.raw`\bhad\s+${HAD_ADVERBS}(?:${PART_LIST})\b`, 'g'), txtNarr) +
    // R12 倒装过去完成。注意：原型 Python 版此处仅小写触发词，句首大写
    // （Never/Hardly/No sooner had …）会漏检——而其注释示例恰为大写句首。
    // 此为与原版唯一的有意分歧（R12-inv-case 修复），参照版已同步，见对照报告。
    count(/\b(?:[Nn]ever|[Hh]ardly|[Ss]carcely|[Ss]eldom|[Nn]o sooner)\s+had\s+\w+\s+\w+(?:ed|en)\b/g, txtNarr);
  const passive = passiveBase + count(/,\s*\w+ed\s+by\s/g, txtNarr);

  // ---- 词句卡首列词条并入已知（注释后口径）；已学词集（复现队列）同样并入 ----
  const gloss = cardGlossWords(card);
  const reinforceList = [...new Set((opts.reinforceWords ?? []).map((w) => w.trim().toLowerCase()).filter(Boolean))];
  const hasReinforce = opts.reinforceWords !== undefined;
  const known = new Set([...lex.known, ...IRR, ...gloss, ...reinforceList]);

  // ---- 覆盖率 / 生词率 / 待定词风险 ----
  const txt = allSents.join(' ');
  const toks = tokenizeTxt(txt);
  const oov = toks.filter((t) => !hit(t, known) && t.length > 1);
  const coverage = toks.length ? 1 - oov.length / toks.length : 1;
  const newWordRate = new Set(toks).size ? new Set(oov).size / new Set(toks).size : 0;
  const pendingHits = toks.reduce((n, t) => (pendHit(t, lex.pending) ? n + 1 : n), 0);

  // ---- ⑩ 复现词命中（队列词的词形家族计一次命中；token 次数计重复强度） ----
  let reinforceHits = 0;
  let reinforceTokens = 0;
  const reinforceHitList: string[] = [];
  for (const w of reinforceList) {
    const single = new Set([w]);
    const n = toks.reduce((acc, t) => acc + (hit(t, single) ? 1 : 0), 0);
    if (n > 0) { reinforceHits++; reinforceTokens += n; reinforceHitList.push(w); }
  }

  // ---- ⑧ 专名一致性（正文专名 ⊆ 词句卡，免检名单除外） ----
  const cardText = card;
  const exempt = new Set(opts.propExempt ?? []);
  const propInText = (opts.propCheckList ?? []).filter((w) => txt.includes(w));
  const propConsistent = propInText.every((w) => cardText.includes(w) || exempt.has(w));

  const chno = opts.chno ?? null;
  return {
    tier: opts.tier,
    chno,
    fileName: opts.fileName ?? '',
    paraCount: paras.length,
    sentCount: allSents.length,
    tokenCount: toks.length,
    coverage,
    newWordRate,
    avgLenRaw: lens.reduce((a, b) => a + b, 0) / lens.length,
    avgLenNarrRaw: lensN.reduce((a, b) => a + b, 0) / lensN.length,
    maxLen: Math.max(...lens),
    over20: lens.filter((l) => l > 20).length,
    passive,
    relcl,
    pastperf,
    propConsistent,
    thatCheck,
    pendingHits,
    oov,
    gates: {
      passiveOk: opts.tier !== 'A' || chno === null || chno >= (opts.tierGates?.passiveFromCh ?? 5),
      relclOk: opts.tier !== 'A' || chno === null || chno >= (opts.tierGates?.relclFromCh ?? 8),
    },
    ...(hasReinforce
      ? { reinforceQueue: reinforceList.length, reinforceHits, reinforceTokens, reinforceHitList }
      : {}),
  };
}

/** 输出为与 Python 参照版（qc_chapter.py）完全同 schema 的字典（对照测试用） */
export function toLegacyReport(r: QcResult): Record<string, unknown> {
  return {
    层级: r.tier,
    章号: r.chno,
    文件: r.fileName,
    段落ID数: r.paraCount,
    句子总数: r.sentCount,
    词符数: r.tokenCount,
    '①词表覆盖率(注释后口径=含A层术语)': (r.coverage * 100).toFixed(1) + '%',
    '②生词率(词型口径)': (r.newWordRate * 100).toFixed(1) + '%',
    '③平均句长(词)': pyRound1(r.avgLenRaw),
    '③平均句长(去歌词)': pyRound1(r.avgLenNarrRaw),
    '④单句最长(词)': r.maxLen,
    '④超20词句数': r.over20,
    '⑤被动式计数(叙事区)': r.passive,
    '⑥定语从句计数(叙事区)': r.relcl,
    '⑦过去完成计数(叙事区)': r.pastperf,
    '⑧专名-术语表一致': r.propConsistent,
    that从句待人工复核: r.thatCheck,
    '⑨待定词token命中(保守口径风险)': r.pendingHits,
    'OOV词(去重)': [...new Set(r.oov)].sort(),
    ...(r.reinforceQueue !== undefined
      ? {
          '⑩复现词命中(队列/命中/词次)': `${r.reinforceQueue}/${r.reinforceHits}/${r.reinforceTokens}`,
          复现命中词: r.reinforceHitList ?? [],
        }
      : {}),
  };
}
