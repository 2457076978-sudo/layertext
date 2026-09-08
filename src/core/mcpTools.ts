/**
 * MCP 工具层（纯逻辑，无 SDK 依赖）——LayerText 质检引擎的 4 个标准工具
 *
 * 与桌面应用共用同一套 src/core 引擎（红线：不重写内核，只加壳）。
 * 上壳见 src/mcp-server.ts（stdio）；测试见 tests/mcp_tools.test.ts。
 * 隐私：工具只处理调用方传入的文本、只返回结果，不落盘、不缓存、零遥测。
 */

import { buildLexicon, type Lexicon } from './lexicon.js';
import { hit, hitOrigin, pendHit } from './textpipe.js';
import { runQc, toLegacyReport } from './qc.js';
import { sentenceRisks } from './risks.js';
import { IRR } from './irregular.js';

/** 任意英文文本 → 章节 md（按空行切段、编 [P01]，与应用"导入归一化"同构的最小版） */
export function wrapAsChapter(text: string, title = 'MCP text'): string {
  const paras = text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter((p) => /[A-Za-z]/.test(p));
  return `# ${title}\n\n## Chapter One\n\n${paras.map((p, i) => `[P${String(i + 1).padStart(2, '0')}] ${p}`).join('\n\n')}\n`;
}

export interface McqLexiconOptions {
  /** 自定义词库 CSV 文本（教材已学词），可多个 */
  vocabCsvTexts?: string[];
  /** 附加纯文本词表 */
  plainWordlistTexts?: string[];
  terms?: string[];
  properNouns?: string[];
}

export function buildMcpLexicon(opts: McqLexiconOptions, bundledWordlists: string[]): Lexicon {
  return buildLexicon({
    vocabCsvTexts: opts.vocabCsvTexts ?? [],
    plainWordlistTexts: [...bundledWordlists, ...(opts.plainWordlistTexts ?? [])],
    terms: opts.terms ?? [],
    properNouns: (opts.properNouns ?? []).map((p) => p.toLowerCase()),
  });
}

/** 工具1 layer_qc：全文体检（生词率/覆盖率/句长/被动/定从/过去完成/OOV清单）；reinforce=已学词集（⑩复现指标） */
export function toolQcText(text: string, lex: Lexicon, oovLimit = 50, reinforceWords?: string[]): Record<string, unknown> {
  const md = /[P]\d+\]/.test(text) ? `# qc\n\n## Chapter One\n\n${text}` : wrapAsChapter(text);
  const r = runQc(md, lex, { tier: 'M', fileName: 'mcp', ...(reinforceWords ? { reinforceWords } : {}) });
  const oovDetail = [...new Set(r.oov)].slice(0, oovLimit).map((w) => ({
    word: w,
    pending: pendHit(w, lex.pending),
  }));
  return {
    ...(toLegacyReport(r) as Record<string, unknown>),
    OOV清单前N: oovDetail,
    口径说明: '句法黑名单（被动/定从/过去完成）按初中教学进度一律禁用；直接引语内豁免；词形还原命中内置课标1600+补录+IRR',
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
