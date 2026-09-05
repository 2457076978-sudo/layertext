/**
 * LayerText · 句级风险检测（审校正文着色用）
 *
 * 与 qc.ts 的全文计数共用同一套正则与豁免表（含 R12-inv-case 修复），
 * 区别在于逐句检测、供 UI 给风险句加底色/角标；不参与指标口径与对照测试。
 * 单句内同样先剥离直接引语（引语只降词不降句式）。
 */

import { FAKE, HAD_ADVERBS, PASSIVE_IRR, PART_LIST, THAT_EXEMPT } from './irregular.js';

export interface SentenceRisk {
  overlong: boolean;
  passive: boolean;
  relcl: boolean;
  pastperf: boolean;
}

export function sentenceRisks(sent: string, maxLen = 20): SentenceRisk {
  const t = sent.replace(/"[^"]*"/g, ' ');
  const len = sent.split(/\s+/).filter(Boolean).length;
  const has = (re: RegExp) => re.test(t);
  return {
    overlong: len > maxLen,
    passive:
      has(new RegExp(String.raw`\b(?:was|were|is|are|be|been|being)\s+${FAKE}\w+ed\b`)) ||
      has(new RegExp(String.raw`\b(?:was|were)\s+(?:${PASSIVE_IRR})\b`)) ||
      has(/,\s*\w+ed\s+by\s/),
    relcl:
      has(/,?\s+(?:who|which)\s+\w+/) ||
      has(new RegExp(String.raw`\b[a-z]+\s+that\s+(?!${THAT_EXEMPT})[a-z]+(?:ed|s|ing)\b`)),
    pastperf:
      has(new RegExp(String.raw`\bhad\s+${HAD_ADVERBS}${FAKE}(\w+ed)\b`)) ||
      has(new RegExp(String.raw`\bhad\s+${HAD_ADVERBS}(?:${PART_LIST})\b`)) ||
      has(/\b(?:[Nn]ever|[Hh]ardly|[Ss]carcely|[Ss]eldom|[Nn]o sooner)\s+had\s+\w+\s+\w+(?:ed|en)\b/),
  };
}
