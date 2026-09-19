/**
 * 分档 × 考试表现回溯（功能四项 · 项 4，2026-09-19）——join 纯函数（引擎层）。
 *
 * 消费方：`tools/af_pipeline/LayerText_AF分档考试回溯.mjs`（只做 IO 与渲染）。
 *
 * 数据红线（模块级承诺）：本模块只消费**梯队级聚合率**（逐题 × 梯队的得分率，0-1），
 * 不接触、不返回任何学生个体数据；产物措辞纪律（exposure≠acquisition、回溯相关不构成
 * 因果）由 DISCLAIMER 固化，报告必须原样带上。
 *
 * 归并口径：词 → 档走 `textpipe.hitOrigin` 唯一实现（变形/不规则复数回原形再对允许表），
 * 本模块不自算词形还原。
 */

import { hitOrigin } from './textpipe.js';

export type Band = '良' | '中' | '优';
export type Tier = 'A' | 'M' | 'B';
export type BandOrNone = Band | '词表外';

/** 报告必须原样带上的声明（exposure≠acquisition：考试词形产出≠习得；回溯相关≠因果证据） */
export const EXAM_DISCLAIMER =
  '> 口径声明：考试作答中的词形产出 ≠ 习得（exposure ≠ acquisition）；本报告为**回溯相关**，不构成因果证据。' +
  '全部数字为梯队级聚合率，无学生个体数据；分档=分档允许表 v0（良/中/优），词形归并走引擎 hitOrigin。';

/** 考试答案文本 → 词表（小写、去标点；答案可为单词/短语/句子） */
export function examWordsOf(answerText: string): string[] {
  return [
    ...new Set(
      (
        String(answerText ?? '')
          .toLowerCase()
          .match(/[a-z][a-z'-]*/g) ?? []
      ).map((w) => w.replace(/-+$/, '')),
    ),
  ];
}

/**
 * 词 → 档：对每档允许表做 hitOrigin 归并命中；一个词可命中多档（良⊂中⊂优的包含关系下
 * 常见——如实返回多档，聚合时各记一次）。都不中返回 []（词表外）。
 */
export function bandsOfWord(word: string, tables: Record<Band, Set<string>>): Band[] {
  const w = String(word ?? '').toLowerCase();
  const out: Band[] = [];
  for (const band of ['良', '中', '优'] as Band[]) if (hitOrigin(w, tables[band]) !== null) out.push(band);
  return out;
}

export interface ExamItemInput {
  /** 该题答案文本提出的词（examWordsOf 输出） */
  words: string[];
  /** 梯队级得分率（0-1）；缺某梯队=该卷无此梯队数据 */
  rates: Partial<Record<Tier, number>>;
}

export interface BandAggregate {
  band: BandOrNone;
  /** 命中该档的题数（一题可命中多档，各档分别计） */
  items: number;
  /** 涉及词（去重，含多档重叠词） */
  words: string[];
  tierRates: Partial<Record<Tier, { mean: number; n: number }>>;
}

/** 逐题 × 档聚合：题命中档=其词经归并命中该档允许表；词表外=全部词无一档命中。 */
export function aggregateByBand(items: ExamItemInput[], tables: Record<Band, Set<string>>): BandAggregate[] {
  const acc = new Map<BandOrNone, { items: number; words: Set<string>; rates: Partial<Record<Tier, number[]>> }>();
  const touch = (band: BandOrNone): NonNullable<ReturnType<typeof acc.get>> => acc.get(band) ?? { items: 0, words: new Set<string>(), rates: {} };
  for (const it of items) {
    const bands = new Set<Band>();
    for (const w of it.words) for (const b of bandsOfWord(w, tables)) bands.add(b);
    const hits: BandOrNone[] = bands.size ? [...bands] : ['词表外'];
    for (const band of hits) {
      const a = touch(band);
      a.items++;
      for (const w of it.words) a.words.add(w);
      for (const t of ['A', 'M', 'B'] as Tier[]) {
        const r = it.rates[t];
        if (typeof r === 'number' && Number.isFinite(r)) (a.rates[t] ??= []).push(r);
      }
      acc.set(band, a);
    }
  }
  return [...acc.entries()]
    .sort((x, y) => (x[0] === '词表外' ? 1 : y[0] === '词表外' ? -1 : x[0].localeCompare(y[0])))
    .map(([band, a]) => ({
      band,
      items: a.items,
      words: [...a.words].sort(),
      tierRates: Object.fromEntries(Object.entries(a.rates).map(([t, rs]) => [t, { mean: rs!.reduce((p, c) => p + c, 0) / rs!.length, n: rs!.length }])),
    }));
}

/** 全卷基线（各梯队平均得分率）——判读的对照面 */
export function baselineRates(items: ExamItemInput[]): Partial<Record<Tier, number>> {
  const out: Partial<Record<Tier, number>> = {};
  for (const t of ['A', 'M', 'B'] as Tier[]) {
    const rs = items.map((i) => i.rates[t]).filter((r): r is number => typeof r === 'number' && Number.isFinite(r));
    if (rs.length) out[t] = rs.reduce((p, c) => p + c, 0) / rs.length;
  }
  return out;
}

/** 人话判读：各档题在各梯队相对全卷基线的差值（负=丢分多于基线），点名最伤的组合 */
export function bandVerdict(aggs: BandAggregate[], base: Partial<Record<Tier, number>>): string {
  const rows: Array<{ band: BandOrNone; tier: Tier; gap: number }> = [];
  for (const a of aggs)
    for (const t of ['A', 'M', 'B'] as Tier[]) {
      const m = a.tierRates[t];
      const b = base[t];
      if (m && b !== undefined) rows.push({ band: a.band, tier: t, gap: (m.mean - b) * 100 });
    }
  if (!rows.length) return '没有可判读的（档×梯队）组合——检查逐题数据与允许表是否对上';
  rows.sort((x, y) => x.gap - y.gap);
  const fmt = (r: { band: BandOrNone; tier: Tier; gap: number }): string => `${r.band}档词的题在 ${r.tier} 层 ${r.gap >= 0 ? '+' : ''}${r.gap.toFixed(1)}pp`;
  const worst = rows[0]!;
  const best = rows[rows.length - 1]!;
  return `最伤：${fmt(worst)}；最稳：${fmt(best)}——负值=该档词的题在这个梯队丢分多于全卷基线（回溯相关，不作因果解读）`;
}
