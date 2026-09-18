// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，本仓库已部署版权验证体系，细节不予公开（docs/版权与授权.md）。
/**
 * MCP 工具层（纯逻辑，无 SDK 依赖）——LayerText 质检引擎的 4 个标准工具
 *
 * 与桌面应用共用同一套 src/core 引擎（红线：不重写内核，只加壳）。
 * 上壳见 src/mcp-server.ts（stdio）；测试见 tests/mcp_tools.test.ts。
 * 隐私：工具只处理调用方传入的文本、只返回结果，不落盘、不缓存、零遥测。
 */

import { alignSentencePairs } from './align.js';
import { buildLexicon, type Lexicon } from './lexicon.js';
import { hit, hitOrigin, pendHit, sentsOf } from './textpipe.js';
import { runQc, toLegacyReport } from './qc.js';
import { sentenceRisks } from './risks.js';
import { IRR } from './irregular.js';
import { triageOov, type ZipfTable } from './wordfreq.js';
import { acceptanceV2, cleanForAcceptance } from './acceptance.js';
import { reworkGates, summarizeLedger } from './rework.js';
import { probeChapterSource } from './sourceprobe.js';

/** 任意英文文本 → 章节 md（按空行切段、编 [P01]，与应用"导入归一化"同构的最小版） */
export function wrapAsChapter(text: string, title = 'MCP text'): string {
  const paras = text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter((p) => /[A-Za-z]/.test(p));
  return `# ${title}\n\n## Chapter One\n\n${paras.map((p, i) => `[P${String(i + 1).padStart(2, '0')}] ${p}`).join('\n\n')}\n`;
}

export interface McpLexiconOptions {
  /** 自定义词库 CSV 文本（教材已学词），可多个 */
  vocabCsvTexts?: string[];
  /** 附加纯文本词表 */
  plainWordlistTexts?: string[];
  terms?: string[];
  properNouns?: string[];
}

export function buildMcpLexicon(opts: McpLexiconOptions, bundledWordlists: string[]): Lexicon {
  return buildLexicon({
    vocabCsvTexts: opts.vocabCsvTexts ?? [],
    plainWordlistTexts: [...bundledWordlists, ...(opts.plainWordlistTexts ?? [])],
    terms: opts.terms ?? [],
    properNouns: (opts.properNouns ?? []).map((p) => p.toLowerCase()),
  });
}

/** 工具1 layer_qc：全文体检（生词率/覆盖率/句长/被动/定从/过去完成/OOV清单）；reinforce=已学词集（⑩复现指标）；
 *  zipfTable=词频先验表（提供时 OOV 清单逐词带 zipf 与分诊：高频未收=疑似漏收候选，低频=真·生词教学优先——只出候选不碰判定） */
export function toolQcText(text: string, lex: Lexicon, oovLimit = 50, reinforceWords?: string[], zipfTable?: ZipfTable, aoaTable?: ZipfTable): Record<string, unknown> {
  const md = /[P]\d+\]/.test(text) ? `# qc\n\n## Chapter One\n\n${text}` : wrapAsChapter(text);
  const r = runQc(md, lex, { tier: 'M', fileName: 'mcp', ...(reinforceWords ? { reinforceWords } : {}) });
  const oovDetail = [...new Set(r.oov)].slice(0, oovLimit).map((w) => {
    const item: Record<string, unknown> = { word: w, pending: pendHit(w, lex.pending) };
    if (zipfTable) {
      const t = triageOov(w, zipfTable, aoaTable);
      item.zipf = t.zipf;
      item.aoa = t.aoa;
      item.分诊 = t.label;
    }
    return item;
  });
  return {
    ...(toLegacyReport(r) as Record<string, unknown>),
    OOV清单前N: oovDetail,
    口径说明: '句法黑名单（被动/定从/过去完成）按初中教学进度一律禁用；直接引语内豁免；词形还原命中内置课标1600+补录+IRR',
    ...(zipfTable ? { OOV分诊口径: 'zipf 词频先验（wordfreq，纯离线）：≥4.0 高频未收=疑似漏收（教师核对后入库），3.0–4.0 中频，<3.0 低频=真·生词教学优先。只出候选，词库表仍是唯一判定锚' } : {}),
  };
}

/** 工具2 layer_word_status：单词的词表状态与原形（词库=难度锚点：词表内=学生已学） */
export function toolWordStatus(word: string, lex: Lexicon): Record<string, unknown> {
  const tok = word.trim().toLowerCase();
  if (!tok) return { error: 'word 为空' };
  const known = new Set([...lex.known, ...IRR]);
  const status = hit(tok, known) ? '词表内（学生已学）' : pendHit(tok, lex.pending) ? '待定词（暂计已知，需人工定去留）' : '词表外（生词，需简化或入词库）';
  return { word: tok, status, 词形还原原形: hitOrigin(tok, known) ?? null };
}

export interface RiskDetail {
  sentence: string;
  words: number;
  passive: boolean;
  relcl: boolean;
  pastperf: boolean;
  overlong: boolean;
}

function splitSentences(t: string): string[] {
  return t
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => /[A-Za-z]/.test(s));
}

/** 工具3 layer_sentence_risks：单句（或多句逐句）句法黑名单检测 */
export function toolSentenceRisks(text: string, maxLen = 16): RiskDetail[] {
  return splitSentences(text).map((s) => {
    const r = sentenceRisks(s, maxLen);
    return { sentence: s, words: s.split(/\s+/).filter(Boolean).length, ...r };
  });
}

/** 工具4 layer_check_revision：改写句复核——AI/人改写后自查黑名单与超长残留（与 App 引擎复核同口径） */
export function toolCheckRevision(revised: string, maxLen = 16): Record<string, unknown> {
  const details = toolSentenceRisks(revised, maxLen);
  const agg = { passive: false, relcl: false, pastperf: false, overlong: false };
  for (const d of details) {
    agg.passive ||= d.passive;
    agg.relcl ||= d.relcl;
    agg.pastperf ||= d.pastperf;
    agg.overlong ||= d.overlong;
  }
  const issues: string[] = [];
  if (agg.passive) issues.push('被动语态残留');
  if (agg.relcl) issues.push('定语从句残留');
  if (agg.pastperf) issues.push('过去完成残留');
  if (agg.overlong) issues.push(`超长（> ${maxLen} 词）`);
  return { 通过: issues.length === 0, 问题: issues, 最长句词数: Math.max(0, ...details.map((d) => d.words)), 逐句明细: details };
}

/** 工具5 layer_align：两个版本逐句核对（基准版 vs 改写/简化版）——丢句/新增/数字专名缺失
 *  与 App「逐句对照」页同一实现（src/core/align.ts）：完全相同句 LCS 锚点 + 改写句 Jaccard≥0.45 配对。 */
export function toolAlignPairs(baseText: string, curText: string): Record<string, unknown> {
  const toRefs = (text: string) => {
    const paras = text
      .replace(/\r\n?/g, '\n')
      .split(/\n\s*\n/)
      .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
      .filter((p) => /[A-Za-z]/.test(p));
    const refs: { pi: number; si: number; text: string }[] = [];
    paras.forEach((p, pi) => sentsOf(p, false).forEach((s, si) => refs.push({ pi: pi + 1, si: si + 1, text: s.trim() })));
    return refs;
  };
  const rows = alignSentencePairs(toRefs(baseText), toRefs(curText));
  const cut = (s: string) => (s.length > 90 ? s.slice(0, 90) + '…' : s);
  const lost = rows.filter((r) => r.kind === 'lost').map((r) => ({ 位置: `P${r.base!.pi}-S${r.base!.si}`, 基准句: cut(r.base!.text) }));
  const added = rows.filter((r) => r.kind === 'added').map((r) => ({ 位置: `P${r.cur!.pi}-S${r.cur!.si}`, 当前句: cut(r.cur!.text) }));
  const signalLost = rows.filter((r) => r.kind === 'match' && r.lostSignals?.length).map((r) => ({ 位置: `P${r.base!.pi}-S${r.base!.si}`, 缺失信号: r.lostSignals!, 基准句: cut(r.base!.text) }));
  return {
    对齐句数: rows.filter((r) => r.kind === 'match').length,
    丢句数: lost.length,
    新增句数: added.length,
    信号缺失数: signalLost.length,
    丢句: lost,
    新增: added,
    信号缺失: signalLost,
    口径说明: '丢句=基准有此处无（疑似丢情节）；新增=当前版多出；信号缺失=基准句里的数字（three↔3 互认）或专名在配对句中找不到。改写句配对阈值 Jaccard≥0.45。',
  };
}

/* ───────────── 2026-09-18 项 2 新增：SOP 闸门 MCP 化（工具 6–9） ───────────── */

/** 红词计数（回炉闸口径）：词库外 token 出现次数，注释过的词不算、词形家族按词库口径 */
function redCountOf(text: string, lex: Lexicon): number {
  const ann = new Set([...String(text ?? '').matchAll(/([A-Za-z][A-Za-z-]*)（[^）]*）/g)].map((m) => m[1].toLowerCase()));
  let n = 0;
  for (const w of cleanForAcceptance(String(text ?? '')).match(/[a-z]+/g) || []) {
    if (w.length < 2 && w !== 'a' && w !== 'i') continue;
    if (!hit(w, lex.known) && !ann.has(w)) n++;
  }
  return n;
}

/** 工具6 layer_rework_gates：一段改写跑回炉四闸（红词必减/段长比/注释不丢/句长上限·引语豁免）。
 *  AI 改完一段、写回产物之前应调用本工具自查——过闸才许交付。 */
export function toolReworkGates(before: string, after: string, maxLen: number, lex: Lexicon): Record<string, unknown> {
  if (!String(before ?? '').trim() || !String(after ?? '').trim()) return { error: 'before 与 after 都不能为空（改前段 / 改后段）' };
  const r = reworkGates({ before, after, maxLen, redBefore: redCountOf(before, lex), redAfter: redCountOf(after, lex) });
  return {
    ...r,
    口径说明:
      '四闸=①红词必减（词库外未注 token 不得增、改前有则必须严格减少）②段长比 [0.7,1.4] ③注释不丢（word（中文）处数不减）④句长上限（直接引语豁免后计量）。红词口径=本服务启动时的词库（可叠加 --vocab/--wordlist）。',
  };
}

/** 工具7 layer_rework_ledger：回炉台账 JSONL 汇总——决定计数、挂起按原因分组、下一轮建议顺序。
 *  输入是台账文件内容（agent 自行读文件后传入；本服务不读盘）。 */
export function toolReworkLedger(ledgerText: string, sentLimits?: Record<string, number>): Record<string, unknown> {
  const sum = summarizeLedger(String(ledgerText ?? ''), { sentLimitOf: (t) => sentLimits?.[t] });
  if (!sum) return { error: '台账为空或没有可解析的行（应为一行一条 JSON 的 JSONL）' };
  return {
    ...sum,
    口径说明: '挂起分类 v2 行读 class 字段、v1 遗留行按 reason 数字判真凶；句长超线判定需要各层上限（sent_limits，如 {A:19,M:17,B:16}），不给则句 max 判不了、如实归其它类。',
  };
}

/** 工具8 layer_source_probe：R0 源完整性探针——词数骤降/章末无收束/碎片残留。整本书的章一起给。 */
export function toolSourceProbe(chapters: Array<{ name?: string; text?: string }>): Record<string, unknown> {
  if (!Array.isArray(chapters) || chapters.length === 0) return { error: 'chapters 不能为空：[{name, text}, …]（整本书一起给——词数骤降要比较相邻章）' };
  return {
    results: probeChapterSource(chapters.map((c) => ({ name: String(c?.name ?? ''), text: String(c?.text ?? '') }))),
    口径说明: '三探针=①词数骤降（<相邻章中位数×0.5）②章末无收束（断章形态）③碎片残留（连续≥3行孤词/词表行）。命中任何一条，R0 应拒绝把这份源喂进生成。',
  };
}

/** 工具9 layer_acceptance_v2：验收 v2 七维度（可本地计算子集）——三层文本入，结构化报告出。
 *  proper_nouns 给了才做专名丢失校验；source 给了（{P01: 源段, …}）才做语义确定性校验。 */
export function toolAcceptanceV2(tiers: { A?: string; M?: string; B?: string }, source: Record<string, string> | undefined, properNouns: string[] | undefined, lex: Lexicon): Record<string, unknown> {
  if (!tiers?.A || !tiers?.B) return { error: '至少要给 A 与 B 两层的整章 md（[P##] 段格式）；M 可选。{A: "...", B: "..."}' };
  const r = acceptanceV2({
    tiers: { A: tiers.A, ...(tiers.M ? { M: tiers.M } : {}), B: tiers.B },
    ...(source ? { source: new Map(Object.entries(source)) } : {}),
    known: lex.known,
    proper: properNouns ?? [],
  });
  return {
    ...r,
    unnotedByTier: undefined,
    口径说明:
      '未注率排序要求 B<M<A；同段倒挂=B 段未注>A 同段；句长梯度=B 均句长≤A×1.15（v2.1 容差）；注密度 per100=注/百词。不含照抄检测与注位审计（要读 recap/注位审计.json，走管线脚本 验收v2.mjs）。',
  };
}
