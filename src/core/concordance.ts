// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，本仓库已部署版权验证体系，细节不予公开（docs/版权与授权.md）。
/**
 * LayerText · 跨章词画卷（concordance）引擎（2026-09-18；规划与验收标准见
 * docs/词画卷与传播咬合_规划与验收标准_2026-09-18.md）
 *
 * 一句话：**词 → 全书哪几章哪几句（含层与已注状态）**。它是传播的地图——
 * 传播前预览（propagationPreview）、传播后审计（annotationDebt）、专名排查
 * （properSuspects）、词表缺口与复现统计（wordChapterMatrix）都查这一张图。
 *
 * 六条设计定案（规划文档第零节）在这里落地的三条：
 *   · **词形归并口径唯一**：baseOf 走 textpipe.hitOrigin（与判定链同一套表面形/IRR/剥变形），
 *     本模块**不自写**词形还原；词表外词不强行归并（按表面形独立成键并标 unmerged）。
 *   · **画卷是视图不是正本**：纯函数零 IO，按需重算；教师决定从稳定 ID（词+章+层+段）由
 *     调用方带回来（attachOrigin 只做展示性附加，不写任何东西）。
 *   · 句子切分走 textpipe.sentsOf、段落标记走 textpipe 的 [P##] 约定——与 QC 同一口径。
 */

import { hitOrigin, sentsOf } from './textpipe.js';
import { SENT_STARTERS } from './align.js';

export interface ConcordanceChapterInput {
  name: string;
  /** 层标签 → 该层整章文本（'source'/'A'/'M层75'/自定义；不分层的书只给一个键） */
  tiers: Record<string, string>;
}

export interface ConcordanceOccurrence {
  chapter: string;
  tier: string;
  segId: string;
  /** 含词句（按截断上限裁剪；同句同词只记一行） */
  sentence: string;
  /** 文中实际形（保留大小写，画卷高亮与专名判定用） */
  wordForm: string;
  /** 该处是否带 word（中文） 注释 */
  annotated: boolean;
  /** 词出现在句中非句首位置且大写（properSuspects 的判定输入） */
  capitalizedMid: boolean;
  /** 词表外且归并失败——按表面形独立成键（防假归并，如实标注） */
  unmerged?: boolean;
  /** 教师决定的溯源（attachOrigin 附加；不伪造） */
  origin?: string;
}

export interface ConcordanceOptions {
  /** 词库（给了才做归并；不给则全部按表面形成键并标 unmerged） */
  known?: Set<string>;
  /** 含词句截断上限（词数），默认 24 */
  sentenceWords?: number;
}

/** 段标记约定同 textpipe（[P##] 起段）；无标记的文本整块当一段、段号按序补 P01… */
function segmentsOf(text: string): Array<{ segId: string; body: string }> {
  const out: Array<{ segId: string; body: string }> = [];
  const blocks = String(text ?? '')
    .replace(/\r/g, '')
    .split(/\n\s*\n/);
  let auto = 0;
  for (const b of blocks) {
    const m = b.match(/^\[P(\d+)\]\s*([\s\S]*)$/);
    if (m) out.push({ segId: `P${m[1]}`, body: m[2] });
    else if (b.trim()) out.push({ segId: `P${String(++auto).padStart(2, '0')}`, body: b });
  }
  return out;
}

const cutSentence = (s: string, maxWords: number): string => {
  const words = s.trim().split(/\s+/);
  return words.length <= maxWords ? s.trim() : `${words.slice(0, maxWords).join(' ')}…`;
};

/** 词→全书出现处。同句同词只记一行（画卷一行=一个"此处"） */
export function buildConcordance(chapters: ConcordanceChapterInput[], opts?: ConcordanceOptions): Map<string, ConcordanceOccurrence[]> {
  const maxWords = opts?.sentenceWords ?? 24;
  const known = opts?.known;
  const out = new Map<string, ConcordanceOccurrence[]>();
  for (const ch of Array.isArray(chapters) ? chapters : []) {
    const name = String(ch?.name ?? '');
    for (const [tier, text] of Object.entries(ch?.tiers ?? {})) {
      for (const seg of segmentsOf(String(text ?? ''))) {
        for (const sent of sentsOf(seg.body, false)) {
          const tokens = sent.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
          /* 已注词集每句抽一次（AF 真书实测：逐 token 建正则把重算顶过 200ms 硬阈——
           * 热点就在这，集合查询等价且 O(1)） */
          const annSet = new Set([...sent.matchAll(/([A-Za-z][A-Za-z'-]*)（[^）]*）/g)].map((m) => m[1]));
          const seenInSentence = new Set<string>();
          tokens.forEach((tok, idx) => {
            const lower = tok.toLowerCase();
            const origin = known ? hitOrigin(lower, known) : null;
            const base = origin ?? lower;
            if (seenInSentence.has(base)) return; // 同句同词一行
            seenInSentence.add(base);
            const row: ConcordanceOccurrence = {
              chapter: name,
              tier,
              segId: seg.segId,
              sentence: cutSentence(sent, maxWords),
              wordForm: tok,
              annotated: annSet.has(tok),
              capitalizedMid: idx > 0 && /^[A-Z]/.test(tok) && !SENT_STARTERS.has(lower),
            };
            if (!origin) row.unmerged = true;
            if (!out.has(base)) out.set(base, []);
            out.get(base)!.push(row);
          });
        }
      }
    }
  }
  return out;
}

/* ───────────────────── 聚合查询（都在同一张图上） ───────────────────── */

/** 词 → 章分布（复现统计的底表；按总次数降序） */
export function wordChapterMatrix(conc: Map<string, ConcordanceOccurrence[]>): Array<{ baseForm: string; total: number; byChapter: Record<string, number> }> {
  return [...conc.entries()]
    .map(([baseForm, occs]) => {
      const byChapter: Record<string, number> = {};
      for (const o of occs) byChapter[o.chapter] = (byChapter[o.chapter] ?? 0) + 1;
      return { baseForm, total: occs.length, byChapter };
    })
    .sort((a, b) => b.total - a.total || a.baseForm.localeCompare(b.baseForm));
}

export interface ProperSuspect {
  word: string;
  chapters: string[];
  occurrences: number;
}

/** 专名表漏收候选：**≥minChapters 章出现**（按全部出现计）且**至少一次句中（非句首）大写**
 *  （专名信号——句首大写不算，与 align 的 SENT_STARTERS 同口径）、不在专名表与词表。
 *  pinchfield 型漏收从"人工撞见"变查询。 */
export function properSuspects(conc: Map<string, ConcordanceOccurrence[]>, opts: { proper: Iterable<string>; known?: Iterable<string>; minChapters?: number }): ProperSuspect[] {
  const proper = new Set([...opts.proper].map((p) => String(p).toLowerCase()));
  const known = new Set([...(opts.known ?? [])].map((w) => String(w).toLowerCase()));
  const minChapters = opts.minChapters ?? 2;
  const out: ProperSuspect[] = [];
  for (const [base, occs] of conc) {
    if (proper.has(base) || known.has(base)) continue;
    const capMid = occs.filter((o) => o.capitalizedMid);
    const chapters = [...new Set(occs.map((o) => o.chapter))];
    if (capMid.length >= 1 && chapters.length >= minChapters) out.push({ word: base, chapters, occurrences: capMid.length });
  }
  return out.sort((a, b) => b.chapters.length - a.chapters.length || b.occurrences - a.occurrences);
}

export interface AnnotationDebt {
  baseForm: string;
  rows: Array<{ chapter: string; tier: string; segId: string; sentence: string }>;
}

/** 传播债务：某词在全书任意处已注、而此处裸奔——①补注传播的审计查询。
 *  注意只列事实，不替教师判断"该不该补"（层序语义是调用方的事）。 */
export function annotationDebt(conc: Map<string, ConcordanceOccurrence[]>): AnnotationDebt[] {
  const out: AnnotationDebt[] = [];
  for (const [base, occs] of conc) {
    if (!occs.some((o) => o.annotated)) continue;
    const rows = occs.filter((o) => !o.annotated).map((o) => ({ chapter: o.chapter, tier: o.tier, segId: o.segId, sentence: o.sentence }));
    if (rows.length) out.push({ baseForm: base, rows });
  }
  return out.sort((a, b) => b.rows.length - a.rows.length);
}

/** ①补注的全书预览：看全再批。unannotatedLower=非当前层且未注的出现处（"将覆盖"的候选）。 */
export function propagationPreview(
  conc: Map<string, ConcordanceOccurrence[]>,
  word: string,
  currentTier: string,
): { total: number; byTier: Record<string, number>; unannotatedLower: Array<{ chapter: string; tier: string; segId: string }> } {
  const occs = conc.get(word.toLowerCase()) ?? [];
  const byTier: Record<string, number> = {};
  for (const o of occs) byTier[o.tier] = (byTier[o.tier] ?? 0) + 1;
  return {
    total: occs.length,
    byTier,
    unannotatedLower: occs.filter((o) => o.tier !== currentTier && !o.annotated).map((o) => ({ chapter: o.chapter, tier: o.tier, segId: o.segId })),
  };
}

export interface ConcordanceMark {
  word: string;
  chapter: string;
  tier: string;
  segId: string;
  origin: string;
}

/** 溯源附加（展示性、纯函数）：按 稳定 ID（词+章+层+段）把 origin 挂到出现处；
 *  匹配不上就省略——不伪造溯源。返回新数组，不改入参。 */
export function attachOrigin(occurrences: ConcordanceOccurrence[], marks: Iterable<ConcordanceMark>): ConcordanceOccurrence[] {
  const idx = new Map<string, string>();
  for (const m of marks) idx.set(`${String(m.word).toLowerCase()}|${m.chapter}|${m.tier}|${m.segId}`, m.origin);
  return occurrences.map((o) => {
    const hit = idx.get(`${o.wordForm.toLowerCase()}|${o.chapter}|${o.tier}|${o.segId}`) ?? idx.get(`${o.wordForm.toLowerCase()}|${o.chapter}||${o.segId}`);
    return hit ? { ...o, origin: hit } : o;
  });
}
