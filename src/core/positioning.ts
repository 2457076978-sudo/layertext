// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，本仓库已部署版权验证体系，细节不予公开（docs/版权与授权.md）。
/**
 * LayerText · 产品定位：两条轴要分开说
 *
 * 来源：《LayerText 审查报告 v4_方向》——
 *   「产品定位应明确为『**受控的分层阅读适配**』：**简化**负责句法和词汇负荷，
 *     **加注**负责即时理解支架。不要把两者包装成同一指标；
 *     销售文案和界面都应分别显示『**阅读负荷下降**』和『**理解支架覆盖率**』。」
 *
 * 为什么这条不是文案问题：这个产品的核心机制是"难词就地加中文注释"，
 * 它降低的是**理解门槛**，不是**阅读负荷**——学生仍然要解码那个难词，只是有拐杖。
 * 把两件事合成一个"覆盖率 98%"去讲，买家会以为文本变简单了；
 * 拿到手发现英文原样还在、只是多了中文，落差就变成退货。
 * 所以界面上必须是**两个数、两个名字、两句话**。
 */

import type { QcResult } from './qc.js';

/** 一条轴：一个数 + 它的含义 + 它**不**代表什么 */
export interface Axis {
  name: string;
  /** 0–1（或百分数已换算前的原值） */
  value: number;
  /** 一句话说清它是什么 */
  what: string;
  /** 一句话说清它**不是**什么——防误读比解释更值钱 */
  notThis: string;
}

export interface Positioning {
  /** 阅读负荷：生词率下降（相对原文） */
  load: Axis;
  /** 理解支架：应注的词注出来了多少 */
  scaffolding: Axis;
  /** 原文 → 产物的生词率（两个数都留着，人能自己核） */
  newWordRate: { source: number; out: number };
  /** 界面/报告用的一行 */
  headline: string;
}

/**
 * 从两份 QC 结果算定位。
 *
 * - **阅读负荷下降** = 相对原文的生词率降幅：`(原文生词率 − 产物生词率) / 原文生词率`。
 *   取相对值而不是绝对百分点，是因为"从 24% 降到 12%"和"从 4% 降到 2%"虽然都降了 12 个百分点，
 *   对学生的意义完全不同。
 * - **理解支架覆盖率** = 产物自己的 ⑪加注覆盖率（应注的词注出来了多少）。
 *
 * 两者**刻意不做加权合成**：合成出来的那个数没有任何人能用它做判断。
 */
export function positioningOf(source: Pick<QcResult, 'newWordRate'>, out: Pick<QcResult, 'newWordRate' | 'annotationCoverage' | 'annotated' | 'annotatable'>): Positioning {
  const s = source.newWordRate;
  const o = out.newWordRate;
  const drop = s > 0 ? (s - o) / s : 0;
  return {
    load: {
      name: '阅读负荷下降',
      value: drop,
      what: `生词率从 ${(s * 100).toFixed(1)}% 降到 ${(o * 100).toFixed(1)}%（相对下降 ${(drop * 100).toFixed(0)}%）`,
      notThis: '只反映"难词变少了"；句式负荷另算，**不代表学生读起来更轻松**',
    },
    scaffolding: {
      name: '理解支架覆盖率',
      value: out.annotationCoverage,
      what: `该注的词注出了 ${out.annotated}/${out.annotatable} 个词型（${(out.annotationCoverage * 100).toFixed(0)}%）`,
      notThis: '加注是给难词配拐杖，**不减少阅读负荷**——学生仍要解码那个词',
    },
    newWordRate: { source: s, out: o },
    headline: `阅读负荷下降 ${(drop * 100).toFixed(0)}%（生词率 ${(s * 100).toFixed(1)}% → ${(o * 100).toFixed(1)}%）｜理解支架覆盖率 ${(out.annotationCoverage * 100).toFixed(0)}%（${out.annotated}/${out.annotatable} 词型）`,
  };
}

/** 产品定位的一句话（进 README / 界面空状态 / 报告抬头） */
export const POSITIONING_LINE =
  'LayerText 做的是**受控的分层阅读适配**：简化管句法与词汇负荷，加注管即时理解支架——两者分开计量，不合成一个数。';

/** 给报告用的两行（分开列，不合并） */
export function positioningLines(p: Positioning): string[] {
  return [
    `**${p.load.name}**：${p.load.what}`,
    ` （${p.load.notThis}）`,
    `**${p.scaffolding.name}**：${p.scaffolding.what}`,
    ` （${p.scaffolding.notThis}）`,
  ];
}
