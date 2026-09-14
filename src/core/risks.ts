/**
 * LayerText · 句级风险检测（审校正文着色用）
 *
 * 与 qc.ts 的全文计数**共用同一份正则**——模式串只在 irregular.ts 里定义一次
 * （`PAT_*`），这里只决定"不带 /g 的逐句 test"。
 * 2026-09-13 之前这里是第二份手抄的正则，注释写着"共用"而代码并没有共用：
 * 两边任一处改了豁免词，UI 着色的句子与报表数字就会指向不同的句，而不会有测试报出来。
 *
 * 区别在于逐句检测、供 UI 给风险句加底色/角标；不参与指标口径与对照测试。
 * 单句内同样先剥离直接引语（引语只降词不降句式）。
 */

import { PAT_PASSIVE_BE, PAT_PASSIVE_IRR, PAT_PASSIVE_BY, PAT_RELCL_WHO_WHICH, PAT_RELCL_THAT, PAT_PASTPERF_PARTICIPLE, PAT_PASTPERF_IRR, PAT_PASTPERF_INVERSION } from './irregular.js';

export interface SentenceRisk {
  overlong: boolean;
  passive: boolean;
  relcl: boolean;
  pastperf: boolean;
}

export function sentenceRisks(sent: string, maxLen = 20): SentenceRisk {
  const t = sent.replace(/"[^"]*"/g, ' ');
  const len = sent.split(/\s+/).filter(Boolean).length;
  const has = (pat: string) => new RegExp(pat).test(t);
  return {
    overlong: len > maxLen,
    passive: has(PAT_PASSIVE_BE) || has(PAT_PASSIVE_IRR) || has(PAT_PASSIVE_BY),
    relcl: has(PAT_RELCL_WHO_WHICH) || has(PAT_RELCL_THAT),
    pastperf: has(PAT_PASTPERF_PARTICIPLE) || has(PAT_PASTPERF_IRR) || has(PAT_PASTPERF_INVERSION),
  };
}
