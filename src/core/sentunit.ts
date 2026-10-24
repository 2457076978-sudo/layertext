// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，本仓库已部署版权验证体系，细节不予公开（docs/版权与授权.md）。
/**
 * LayerText · 句级修改三件（拆分 / 句单元 / 拼回）+ 句级四闸（2026-10-24 重写版）
 *
 * 原实现（68a9bd2，2026-10-05）随 2026-10-09 迁移事故丢失，本文件按设计定案重写：
 *   「拼回按拆分序号定位、同文句不误替换——agent 不做字符串手术」
 *   「一句问题走句级、多句连环走段级，两线共用同一把红词/句长尺」（lt_sentence_rework SOP）
 *
 * 三件为什么是唯一实现：
 *   - 拼回用**字符区间**替换，不用字符串查找——同一段里有两句一模一样的句子时，
 *     `segment.replace(句, 新句)` 会误伤第一句（"同文句不误替换"的教训）；
 *   - 句长/红词的尺与段级回炉（rework.ts）同一套原语，不许另立口径。
 */

import { lostSignals } from './align.js';
import type { Lexicon } from './lexicon.js';
import { maxSentenceLen, reworkGates } from './rework.js';
import { hit } from './textpipe.js';
import { cleanForAcceptance } from './acceptance.js';

/** 一个句单元：id 稳定（S1…），span 是它在**原段文本**里的字符区间（含两端） */
export interface SentUnit {
  id: string;
  text: string;
  start: number;
  end: number;
}

/**
 * 拆句（区间保持版）。切分约定与 rework.maxSentenceLen / MCP 逐句检测同一套：
 * `(?<=[.!?])\s+`。只给含字母的片段编号；纯空白片段不编号但**保留在原文里**——
 * 拼回按区间操作，重拼结果与原段逐字节一致（见 roundtrip 测试）。
 * 段首的 [P##] 标记是结构不是内容：**不属于任何句单元**（否则改 S1 会把标记吃掉）。
 */
export function splitSentUnits(segment: string): SentUnit[] {
  const s = String(segment ?? '');
  const prefix = s.match(/^\s*\[P\d+\]\s*/)?.[0] ?? ''; // [P##] 标记 + 前导空白
  const offset = prefix.length;
  const units: SentUnit[] = [];
  let cursor = 0;
  let n = 0;
  // 手工扫描分隔符，保证每一段的 start/end 都落在原串上
  const parts = s.slice(offset).split(/(?<=[.!?])\s+/);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const start = offset + cursor;
    const end = start + part.length;
    cursor = end - offset + (s.slice(end).match(/^\s+/)?.[0].length ?? 0);
    if (/[A-Za-z]/.test(part)) {
      n++;
      units.push({ id: `S${n}`, text: part, start, end });
    }
  }
  return units;
}

/** 重拼校验：按 units 的区间拼回应等于原段（防实现漂移的回归锁） */
export function roundtripUnits(segment: string): boolean {
  const s = String(segment ?? '');
  const units = splitSentUnits(s);
  const parts: string[] = [];
  let cursor = 0;
  for (const u of units) {
    parts.push(s.slice(cursor, u.start), u.text);
    cursor = u.end;
  }
  parts.push(s.slice(cursor));
  return parts.join('') === s;
}

/**
 * 拼回：把段里 `sentenceId` 指到的**那个区间**换成 revised。
 * 区间由 splitSentUnits 当场重算——同一份段文本两次拆分必然同区间（纯函数），
 * 所以"同文句不误替换"由构造保证，不靠字符串查找。
 */
export function spliceSentence(segment: string, sentenceId: string, revised: string): string {
  const s = String(segment ?? '');
  const unit = splitSentUnits(s).find((u) => u.id === sentenceId);
  if (!unit) throw new Error(`没有句单元 ${sentenceId}（先不带 revised 调一次拿句单；编号是 S1、S2…）`);
  const rev = String(revised ?? '').trim();
  if (!rev) throw new Error('revised 不能为空');
  return s.slice(0, unit.start) + rev + s.slice(unit.end);
}

/** 红词（回炉口径，唯一实现）：词库外**未注** token 计数 + 明细。
 *  注释过的词（`word（中文）`）不算；token 取 cleanForAcceptance 后的 [a-z]+
 *  ——与 mcpTools 回炉四闸/验收 v2 同一口径（原先三处各写一份，2026-10-24 收口于此）。 */
export function redWordsOf(text: string, lex: Pick<Lexicon, 'known'>): { count: number; words: string[] } {
  const ann = new Set([...String(text ?? '').matchAll(/([A-Za-z][A-Za-z-]*)（[^）]*）/g)].map((m) => m[1].toLowerCase()));
  const words: string[] = [];
  for (const w of cleanForAcceptance(String(text ?? '')).match(/[a-z]+/g) || []) {
    if (w.length < 2 && w !== 'a' && w !== 'i') continue;
    if (!hit(w, lex.known) && !ann.has(w)) words.push(w);
  }
  return { count: words.length, words };
}

/* ───────────────────────────── 句级四闸 ─────────────────────────────
 * 一句改写的验收闸（段级四闸的句级投影，同一把尺）：
 *   ① 红词不增必减（改前有红词必须严格减少，任何时候不得增加）
 *   ② 句长上限（直接引语豁免后计量）
 *   ③ 注释不丢（word（中文）处数不減）
 *   ④ 保真（原句的数字/专名信号不得丢——与 layer_align 同一 signalsOf 实现）
 */

export type SentenceGateName = '红词不增必减' | '句长上限' | '注释不丢' | '保真';

export interface SentenceEditGatesInput {
  before: string;
  revised: string;
  maxLen: number;
  lex: Pick<Lexicon, 'known'>;
  /** 句长容差（上限+容差才拦），默认 0 */
  lenTolerance?: number;
}

export interface SentenceEditGatesResult {
  pass: boolean;
  failures: Array<{ gate: SentenceGateName; message: string }>;
  measured: { redBefore: number; redAfter: number; wordsBefore: number; wordsAfter: number; annoBefore: number; annoAfter: number; maxSent: number; lostSignals: string[] };
}

export function sentenceEditGates(input: SentenceEditGatesInput): SentenceEditGatesResult {
  // [P##] 标记是结构不是内容：保真/句长/注释计量前一律剥掉（P03 里的数字不是情节信号）
  const strip = (t: string): string => String(t ?? '').replace(/\[P\d+\]/g, ' ');
  const before = strip(input.before);
  const revised = strip(input.revised);
  const redBefore = redWordsOf(before, input.lex);
  const redAfter = redWordsOf(revised, input.lex);
  const annoBefore = (before.match(/（[^）]*）/g) ?? []).length;
  const annoAfter = (revised.match(/（[^）]*）/g) ?? []).length;
  const maxSent = maxSentenceLen(revised, { exemptQuotes: true });
  const lost = lostSignals(before, revised);
  const failures: Array<{ gate: SentenceGateName; message: string }> = [];
  if (redAfter.count > redBefore.count || (redBefore.count > 0 && redAfter.count === redBefore.count)) {
    failures.push({ gate: '红词不增必减', message: `红词 ${redBefore.count}→${redAfter.count}：改前有红词时必须严格减少，且任何时候不得增加` });
  }
  const limit = input.maxLen + (input.lenTolerance ?? 0);
  if (maxSent > limit) {
    failures.push({ gate: '句长上限', message: `句长 ${maxSent} 词 > ${limit}（引语豁免后计量）` });
  }
  if (annoAfter < annoBefore) {
    failures.push({ gate: '注释不丢', message: `注释 ${annoBefore}→${annoAfter}：已有中文注释一处都不能丢` });
  }
  if (lost.length) {
    failures.push({ gate: '保真', message: `丢失信号：${lost.join('、')}` });
  }
  return {
    pass: failures.length === 0,
    failures,
    measured: {
      redBefore: redBefore.count,
      redAfter: redAfter.count,
      wordsBefore: (before.match(/[A-Za-z]+/g) ?? []).length,
      wordsAfter: (revised.match(/[A-Za-z]+/g) ?? []).length,
      annoBefore,
      annoAfter,
      maxSent,
      lostSignals: lost,
    },
  };
}

/* ───────────────────── 双闸组合（列表 / 修改共用） ───────────────────── */

export interface SentenceUnitView extends SentUnit {
  words: number;
  maxSent: number;
  redCount: number;
  redWords: string[];
  overlong: boolean;
}

export interface EditSentenceResult {
  /** 列表形态：段内全部句单元（看靶用） */
  units?: SentenceUnitView[];
  /** 修改形态：拼回后的整段 */
  spliced?: string;
  /** 句级四闸（只对被改的那句） */
  sentenceGates?: SentenceEditGatesResult;
  /** 段级四闸（对拼回后的整段，与 layer_rework_gates 同一把尺） */
  segmentGates?: ReturnType<typeof reworkGates>;
  /** 双闸全绿才许落盘 */
  pass: boolean;
}

/**
 * 句级修改双形态唯一入口：
 *   不给 sentence_id → 拆句看靶（每句：词数/最长/红词/超长标记）；
 *   给 sentence_id + revised → 改一句过双闸（句级四闸 + 拼回后段级四闸一次返回）。
 */
export function editSentenceInSegment(input: { segment_md: string; sentence_id?: string; revised?: string; maxLen: number; lex: Pick<Lexicon, 'known'>; lenTolerance?: number }): EditSentenceResult {
  const segment = String(input.segment_md ?? '');
  if (!segment.trim()) throw new Error('segment_md 不能为空');
  const units = splitSentUnits(segment);
  if (units.length === 0) throw new Error('段内没有可识别的句子（英文按 .!? 断句）');

  if (!input.sentence_id) {
    return {
      pass: false,
      units: units.map((u) => {
        const red = redWordsOf(u.text, input.lex);
        const maxSent = maxSentenceLen(u.text.replace(/\[P\d+\]/g, ' '), { exemptQuotes: true });
        return {
          ...u,
          words: (u.text.match(/[A-Za-z]+/g) ?? []).length,
          maxSent,
          redCount: red.count,
          redWords: [...new Set(red.words)].slice(0, 10),
          overlong: maxSent > input.maxLen + (input.lenTolerance ?? 0),
        };
      }),
    };
  }

  const unit = units.find((u) => u.id === input.sentence_id);
  if (!unit) throw new Error(`没有句单元 ${input.sentence_id}（编号是 S1…S${units.length}；先不带 sentence_id 调一次拿句单）`);
  if (!input.revised?.trim()) throw new Error('给了 sentence_id 就必须给 revised（改后的这一句）');

  const spliced = spliceSentence(segment, input.sentence_id, input.revised);
  const sentenceGates = sentenceEditGates({
    before: unit.text,
    revised: input.revised,
    maxLen: input.maxLen,
    lex: input.lex,
    ...(input.lenTolerance !== undefined ? { lenTolerance: input.lenTolerance } : {}),
  });
  const segmentGates = reworkGates({
    before: segment,
    after: spliced,
    maxLen: input.maxLen,
    redBefore: redWordsOf(segment, input.lex).count,
    redAfter: redWordsOf(spliced, input.lex).count,
    ...(input.lenTolerance !== undefined ? { lenTolerance: input.lenTolerance } : {}),
  });
  return { spliced, sentenceGates, segmentGates, pass: sentenceGates.pass && segmentGates.pass };
}
