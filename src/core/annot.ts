// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，本仓库已部署版权验证体系，细节不予公开（docs/版权与授权.md）。
/**
 * LayerText · 注释（`word（中文）`）的 token 级解析
 *
 * 为什么要把注释从"正则扫一遍"改成结构：
 *   2026-09-11 审查报告第 ③ 条 —— 加注覆盖率原先按字符串正则统计
 *   （`src/core/qc.ts` 的 `/([A-Za-z][A-Za-z'-]*)（/g` 写进一个 Set），
 *   于是四类问题全部会造成**假通过**：
 *     ① 大小写：`Boxer（拳击手）` 与词表里的 `boxer` 若大小写口径不一，两边各自为政；
 *     ② 词形：正文注的是 `trembled（发抖）`，引擎判的 OOV 是 `tremble` —— 归一靠不上一路，
 *        要么假通过（注了别的词形却算这个注了）要么假失败（冤枉）；
 *     ③ 连字符：`blood-curdling（令人毛骨悚然的）` 只记整串会让 `curdling` 永远"该注没注"；
 *     ④ 同形异义：同一个词注了**另一个释义**（与统一词典冲突）照样计数为"已注"。
 *
 * 本模块把这些都变成可查询的结构：解析成 Annotation[]（**保留原词**），
 * 并提供词形归一后的 `covers()`、重复注释、释义冲突三类判定。
 * QC（qc.ts）、段级门禁（segmentgate.ts）、风险队列与补注工具共用这一份口径。
 */

import { suffixCandidates, tokenizeTxt } from './textpipe.js';

/** 一条正文注释：`word（中文）` */
export interface Annotation {
  /** 原词（保留原始大小写与连字符，报告要求"保存原词"） */
  word: string;
  /** 归一键（小写） */
  key: string;
  /** 连字符成分（`blood-curdling` → ['blood','curdling']；无连字符时为 [key]） */
  parts: string[];
  /** 中文释义（全角括号内的内容，已 trim） */
  zh: string;
  /** 在原文中的字符下标（word 的起首位置） */
  index: number;
}

export interface AnnotationIndex {
  /** 按出现顺序的注释清单 */
  list: Annotation[];
  /** 已注词的归一键集合（整词小写） */
  keys: Set<string>;
  /** 已注词的连字符成分集合 */
  parts: Set<string>;
  /** key → 释义（同词多次注释时取首次，重复项见 duplicates） */
  gloss: Map<string, string>;
  /** 同一 key 被注了多次（第 2 次起为多余，正文注释唯一性原则的违反处） */
  duplicates: Annotation[];
  /** 与统一词典释义冲突的注释（同形异义造成"假通过"的现场） */
  conflicts: { word: string; zh: string; expected: string }[];
  /** 覆盖判定：给定引擎判定的 OOV 词，正文里是否已注出（含词形与连字符成分归一） */
  covers: (word: string) => boolean;
  /** 取某词的释义（词形归一） */
  glossOf: (word: string) => string | undefined;
}

/** 注释词的字符类：字母起首、可含撇号与连字符（与词库/分词口径一致） */
const WORD = "[A-Za-z][A-Za-z'-]*";
/** 完整注释：word（中文）——全角括号、词与括号之间无空格、释义 1–24 字且不含括号 */
const ANNOT_RE = new RegExp(`(${WORD})（([^（）]{1,24})）`, 'g');
/** 归一：连字符成分（`blood-curdling` → blood, curdling） */
const partKeys = (key: string): string[] => key.split('-').map((s) => s.replace(/^'+|'+$/g, '')).filter(Boolean);

/** 把一个词形展开成"同族候选"——与 textpipe.hit 同一套后缀还原，避免两边口径打架。
 *  额外补上连字符整词与成分：`blood-curdling` 的候选里要有 `curdling`。 */
function familyOf(w: string): Set<string> {
  const key = w.toLowerCase();
  const out = new Set<string>(suffixCandidates(key));
  for (const p of partKeys(key)) {
    out.add(p);
    for (const c of suffixCandidates(p)) out.add(c);
  }
  // 反向：已注的是屈折形、OOV 是原形时也要命中（annotated=trembled, oov=tremble）
  return out;
}

/**
 * 解析正文里的全部注释。
 * @param text 待解析文本（一般为章节正文；含 [P##] 不影响解析）
 * @param dict 统一释义词典（word→中文）；提供时额外产出 conflicts（释义冲突）
 */
export function parseAnnotations(text: string, dict?: Map<string, string>): AnnotationIndex {
  const list: Annotation[] = [];
  for (const m of text.matchAll(ANNOT_RE)) {
    const word = m[1];
    const key = word.toLowerCase();
    list.push({ word, key, parts: partKeys(key), zh: m[2].trim(), index: m.index ?? 0 });
  }
  const keys = new Set<string>();
  const parts = new Set<string>();
  const gloss = new Map<string, string>();
  const duplicates: Annotation[] = [];
  for (const a of list) {
    if (gloss.has(a.key)) duplicates.push(a);
    else gloss.set(a.key, a.zh);
    for (const p of a.parts) {
      parts.add(p);
      if (!gloss.has(p)) gloss.set(p, a.zh);
    }
    keys.add(a.key);
  }
  // 同族归一索引：词形候选 → 命中的注释
  const family = new Map<string, Annotation>();
  for (const a of list) {
    for (const c of familyOf(a.key)) if (!family.has(c)) family.set(c, a);
  }
  const conflicts: { word: string; zh: string; expected: string }[] = [];
  if (dict && dict.size) {
    for (const a of list) {
      const expected = dict.get(a.key) ?? (a.parts.length > 1 ? dict.get(a.parts[a.parts.length - 1]) : undefined);
      if (expected && !sameZh(expected, a.zh)) conflicts.push({ word: a.word, zh: a.zh, expected });
    }
  }
  return {
    list,
    keys,
    parts,
    gloss,
    duplicates,
    conflicts,
    covers: (word: string): boolean => {
      const key = word.toLowerCase();
      if (keys.has(key) || parts.has(key)) return true;
      if (family.has(key)) return true;
      // 反向：OOV 是屈折形、注释是原形（oov=trembled, annotated=tremble）
      return suffixCandidates(key).some((c) => keys.has(c) || parts.has(c));
    },
    glossOf: (word: string): string | undefined => {
      const key = word.toLowerCase();
      return gloss.get(key) ?? family.get(key)?.zh ?? gloss.get(suffixCandidates(key).find((c) => gloss.has(c)) ?? '');
    },
  };
}

/** 释义等价判定：先剥括注（`（使）发抖` → `发抖`），再去空白与全/半角标点后比较 */
function sameZh(a: string, b: string): boolean {
  const norm = (s: string): string =>
    s
      .replace(/[（(][^)）]*[)）]/g, '')
      .replace(/[\s（）()【】，,。.、；;：:'"“”‘’·]/g, '');
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return true; // 归一后为空 → 不判冲突（避免噪音）
  return x === y || x.includes(y) || y.includes(x);
}

/** 注释词型清单（供"注了多少处 / 多少个词型"两种旧口径复用） */
export function annotatedKeys(text: string): Set<string> {
  return parseAnnotations(text).keys;
}

/** 重复注释率：多余注释处数 / 注释总处数（报告 §二 要求报告的指标之一）。
 *  教学复现走独立的「复现提示」标记或词卡层，不该在正文里反复注同一个词。 */
export function duplicateRate(text: string): { total: number; extra: number; rate: number } {
  const idx = parseAnnotations(text);
  const total = idx.list.length;
  const extra = idx.duplicates.length;
  return { total, extra, rate: total ? extra / total : 0 };
}

/** 正文里的纯英文校验辅助：除注释外是否混入中文（格式红线） */
export function chineseOutsideAnnotations(text: string): string[] {
  const stripped = text.replace(new RegExp(ANNOT_RE.source, 'g'), ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  return stripped.match(/[\u4e00-\u9fff]+/g) ?? [];
}

export { tokenizeTxt };
