// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，本仓库已部署版权验证体系，细节不予公开（docs/版权与授权.md）。
/**
 * 工序化调适 · 本地工序扫描（四方向方案 v2 §3.2，唯一定义）
 *
 * 存在的理由：既有生成路径**所有段一律全量送 AI**（只有会话改写有 OOV 预扫描）。
 * 本模块把"每段进哪道工序"变成纯本地判定：scanFor 命中问题的段才进请求，
 * 无命中 = 零调用（方案方向一验收第 1 条）。
 *
 * 口径纪律（方案 §3.2）：阈值与判定**只复用既有实现**，本模块不新写第二套——
 *   · 词汇边界：adaptcheck 的 knownWordHit/expandForms（词形家族容错）
 *   · 句法风险：risks 的 sentenceRisks + adaptcheck 的 SENT_LEN_CHECK（A20/M17/B14）
 *   · 引入词：adaptcheck 的 introducedHardWords（家族容错的差集）
 *   · 事实/否定/因果：segmentgate 的 lostSignals + adaptcheck 的 fidelityCountsOf
 *   · 加注密度：adaptcheck 的 ANNO_DENSITY_LIMIT（A6/M4/B3）——补注/检查/本模块同一把尺
 *
 * 纯逻辑：不读文件、不调 AI。
 */

import { Stage } from './stagepatch.js';
import { knownWordHit, introducedHardWords, fidelityCountsOf, SENT_LEN_CHECK } from './adaptcheck.js';
import { sentenceRisks } from './risks.js';
import { lostSignals, stripMarkers, segmentSentences } from './segmentgate.js';

export interface ScanSeg {
  /** 段号（形如 P07） */
  id: string;
  /** 原文段（事实对照的锚） */
  source: string;
  /** 当前稿本段 */
  draft: string;
}

export interface ScanCtx {
  tier: 'A' | 'M' | 'B';
  /** 词库正本的已知词集（原形；判定锚永远是词库） */
  knownWords: Set<string>;
  /** 专名表（专名不计 OOV、不加注） */
  properNouns: string[];
  /** 全章已注词账本 word→释义：已注过的词不再触发加注工序 */
  glossary: Map<string, string>;
  /** 词汇复筛的差集基准：全章**原文**（对它取差，抓出管线任意一道引入的词表外词） */
  prevStageText?: string;
}

const WORD_RE = /[A-Za-z][A-Za-z'-]*/g;
const ANNO_RE = /（[^）（]*）/gu;

/** 一段稿本的词表外实词（去注释、去段标记、去专名、词形家族容错） */
export function oovOfSeg(seg: string, ctx: ScanCtx): string[] {
  const proper = new Set(ctx.properNouns.map((w) => w.toLowerCase()));
  const body = seg.replace(ANNO_RE, ' ');
  const out: string[] = [];
  for (const m of body.toLowerCase().match(WORD_RE) ?? []) {
    if (m.length < 3 || proper.has(m)) continue;
    if (!knownWordHit(m, ctx.knownWords) && !out.includes(m)) out.push(m);
  }
  return out.sort();
}

/**
 * 这段在这道工序上有没有要处理的问题；返回问题清单（进请求的 issues，
 * 也是"零调用"判定：空清单 = 本段本工序不进请求）。
 */
export function scanFor(stage: Stage, seg: ScanSeg, ctx: ScanCtx): string[] {
  switch (stage) {
    case 'vocab-primary':
      return oovOfSeg(seg.draft, ctx);

    case 'syntax': {
      const maxLen = SENT_LEN_CHECK[ctx.tier] ?? SENT_LEN_CHECK.M;
      const kinds = new Set<string>();
      for (const s of segmentSentences(seg.draft)) {
        const r = sentenceRisks(s, maxLen);
        if (r.overlong) kinds.add(`超长句（>${maxLen} 词）`);
        if (r.passive) kinds.add('被动语态');
        if (r.relcl) kinds.add('定语从句');
        if (r.pastperf) kinds.add('过去完成');
      }
      return [...kinds];
    }

    case 'vocab-secondary': {
      if (!ctx.prevStageText) return [];
      const introduced = introducedHardWords(ctx.prevStageText, seg.draft, (w) => !knownWordHit(w, ctx.knownWords));
      return introduced.length ? [`新引入词表外词 ${introduced.length} 个：${introduced.slice(0, 12).join('、')}`] : [];
    }

    case 'coherence': {
      const issues: string[] = [];
      /* 事实信号（数字/专名）以原文段为锚：改写弄丢了就点名 */
      const lost = lostSignals(stripMarkers(seg.source), stripMarkers(seg.draft));
      if (lost.length) issues.push(`原文信号丢失：${lost.slice(0, 10).join('、')}`);
      /* 否定/因果：整段清零才算问题（合并同类规则时计数自然波动，不冤枉改写） */
      const a = fidelityCountsOf(seg.source);
      const b = fidelityCountsOf(seg.draft);
      if (a.negations > 0 && b.negations === 0) issues.push('本段否定表达全部消失（方向不能反）');
      if (a.causal > 0 && b.causal === 0) issues.push('本段因果连接全部消失');
      return issues;
    }

    case 'annotation': {
      /* 该注而未注：OOV 且不在全章已注账本里（一词一注，注过的不重复注） */
      const need = oovOfSeg(seg.draft, ctx).filter((w) => !ctx.glossary.has(w));
      return need.length ? [`待加注 ${need.length} 词：${need.slice(0, 12).join('、')}`] : [];
    }
  }
}

/** 一份稿本的注释密度（处/百词，与两轮调适检查同尺）——加注工序的预算与收线用。
 *  段标记先剥掉：[P01] 里的 P 不是学生读的词（与 adaptcheck 的 SEG_MARK_RE 同理由）。 */
export function annoDensityOf(texts: readonly string[]): { words: number; annos: number } {
  let words = 0;
  let annos = 0;
  for (const t of texts) {
    const body = stripMarkers(t).replace(ANNO_RE, ' ');
    words += (body.match(WORD_RE) ?? []).length;
    annos += (t.match(ANNO_RE) ?? []).length;
  }
  return { words, annos };
}
