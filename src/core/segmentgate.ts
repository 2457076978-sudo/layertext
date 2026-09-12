// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，本仓库已部署版权验证体系，细节不予公开（docs/版权与授权.md）。
/**
 * LayerText · 段级门禁（segment gate）
 *
 * 存在的理由（2026-09-11 审查报告 P0）：
 *   会话脚本原先在每段复检达到上限后**照常落盘并把段标为 done**，
 *   只有抛异常才进 failures ——「反复不达标的段落」于是能一路进最终书稿而不触发失败。
 *   确定性门禁形同虚设。本模块把"这段到底算不算过"做成一个纯函数、可单测、有规则号，
 *   让管线、风险队列、报告三处共用同一个判定，不再各写一遍 probs 拼字符串。
 *
 * 规则分两级：
 *   blocker（不过 → needs-review，不可完成）：
 *     LEN-01 篇幅偏离  SENT-01 超长句  ANNO-01 漏注  ZH-01 正文混入中文
 *     —— 四条都是确定性、无歧义的硬约束（格式/篇幅/句长/零中文是发布前提）。
 *   warn（过，但进风险队列按"概率×后果"排队等人工）：
 *     FACT-01 数字丢失  FACT-02 专名丢失  ANNO-02 重复注释  ANNO-03 释义与统一词典冲突
 *     —— 机器只能提示、不能可靠判定，因此不阻塞，但权重最高（见 GATE_RULES.weight）。
 */

import { lostSignals, signalsOf } from './align.js';
import { parseAnnotations, chineseOutsideAnnotations } from './annot.js';
import { extractParas, sentsOf, splitChapter } from './textpipe.js';

export type Tier = 'A' | 'B' | 'M';
export type GateSeverity = 'blocker' | 'warn';
/** 风险类别：与审查报告的风险表一一对应（事实 / 加注 / 语言 / 格式） */
export type GateCategory = '事实' | '加注' | '语言' | '格式';

export interface GateRule {
  id: string;
  category: GateCategory;
  severity: GateSeverity;
  /** 后果（风险 = 概率 × 后果 里的"后果"）：这条规则漏掉时，坏产物流到学生面前的严重程度 */
  weight: number;
  /** 这条规则触发时"真的是问题"的概率（1 = 确定性规则，无假阳性；< 1 = 机器只能提示）。
   *  取值依据见风险队列的排序验收测试——事实类必须置顶。 */
  probability: number;
  label: string;
}

/** 规则总表：**唯一口径**。风险队列、报告、门禁都从这里取规则元数据，避免三处漂移。
 *
 *  risk = weight × probability 的排序结果（审查报告 §一 明确要求的优先级）：
 *    段标记错乱 14.4 ＞ 数字变化 13.2 ＞ 专名缺失 12.0 ＞ 正文混入中文 11.0 ＞ 超纲词漏注 10.0
 *    ＞ 超长句 8.0 ＞ 同词多义 7.2 ＞ 释义冲突 6.3 ＞ 篇幅偏离 6.0 = 注释畸形 6.0 ＞ 重复注释 4.5
 *  也就是：**先保证这一章的对照本身没被结构问题弄错**，其次事实差异置顶 → 漏注与超长
 *  → 最后低风险语言润色。 */
export const GATE_RULES: Record<string, GateRule> = {
  'LEN-01': { id: 'LEN-01', category: '语言', severity: 'blocker', weight: 6, probability: 1, label: '篇幅偏离目标' },
  'SENT-01': { id: 'SENT-01', category: '语言', severity: 'blocker', weight: 8, probability: 1, label: '超长句' },
  'ANNO-01': { id: 'ANNO-01', category: '加注', severity: 'blocker', weight: 10, probability: 1, label: '超纲词漏注' },
  'ZH-01': { id: 'ZH-01', category: '格式', severity: 'blocker', weight: 11, probability: 1, label: '正文混入中文' },
  'ANNO-02': { id: 'ANNO-02', category: '加注', severity: 'warn', weight: 5, probability: 0.9, label: '同词重复注释' },
  'ANNO-03': { id: 'ANNO-03', category: '加注', severity: 'warn', weight: 9, probability: 0.7, label: '释义与统一词典冲突' },
  'FACT-01': { id: 'FACT-01', category: '事实', severity: 'warn', weight: 22, probability: 0.6, label: '数字变化/丢失' },
  'FACT-02': { id: 'FACT-02', category: '事实', severity: 'warn', weight: 20, probability: 0.6, label: '专名缺失' },
  // ── 结构类（来自章节 AST src/core/docast.ts，报告 §四）：正则看不出来的那些 ──
  //   段标记一旦缺失/重复/跳号，**这一章所有按标记配对的对照都是错的**，
  //   所以它的后果权重最高——比任何单条事实差异都更该先看。
  'AST-01': { id: 'AST-01', category: '格式', severity: 'warn', weight: 16, probability: 0.9, label: '段标记缺失/重复/跳号' },
  'AST-02': { id: 'AST-02', category: '加注', severity: 'warn', weight: 9, probability: 0.8, label: '同词多义（一份产物里同词不同释义）' },
  'AST-03': { id: 'AST-03', category: '加注', severity: 'warn', weight: 6, probability: 1, label: '注释畸形（嵌套/括号不配对）' },
};

export interface GateProblem {
  ruleId: string;
  category: GateCategory;
  severity: GateSeverity;
  weight: number;
  /** 后果 × 概率（= 这条问题在风险队列里的排序分；见 GATE_RULES） */
  risk: number;
  /** 人话描述（直接进复检回流提示与风险队列卡片） */
  message: string;
  /** 结构化明细（风险队列按它渲染"原句 / 改写句 / 触发规则"） */
  detail?: Record<string, unknown>;
}

export interface AnnotationStat {
  /** 引擎判定应注的词型数 */
  annotatable: number;
  /** 其中已按 `word（中文）` 注出的词型数 */
  annotated: number;
  /** 0–1，加注覆盖率 */
  coverage: number;
  /** 漏注词型 */
  missing: string[];
  /** 注释总处数 */
  total: number;
  /** 重复注释（第 2 次起）处数 */
  extra: number;
}

export interface SegmentVerdict {
  /** pass = 可以落盘并标 done；needs-review = 不可完成，进隔离目录与人工队列 */
  status: 'pass' | 'needs-review';
  problems: GateProblem[];
  blockers: GateProblem[];
  warns: GateProblem[];
  words: number;
  target: number;
  sentences: number;
  overLen: number;
  overLenSentences: string[];
  annotation: AnnotationStat;
}

export interface SegmentGateInput {
  /** 改写正文（可为 `[P01] ...` 或纯段落；两者都能算） */
  text: string;
  /** 对应原文段（算事实信号用） */
  source: string;
  /** 本层目标词数（= 原文词数 × 层比例） */
  target: number;
  /** 本层句长上限 */
  maxLen: number;
  /** 引擎判定的应注词型（来自 runQc 的 OOV，已去重、已去两字母词） */
  oov: string[];
  /** 统一释义词典；给了才做 ANNO-03 释义冲突判定 */
  dict?: Map<string, string>;
  /** 本段应有的段落编号（形如 P07）。模型漏写/写错段号时按它归一，保证段落对齐不错位 */
  markerId?: string;
  /** 生成闸门作用域：豁免直接引语内长句的 SENT-01 计数（句法工序被禁止拆引语，
   *  不该为改不了的句子否决整段）。报表/风险队列/回放不传 → 照常计数。 */
  exemptQuoteLen?: boolean;
  /**
   * 调用方已判定"全篇别处注过、这里又注了"的词。
   * 门禁自己只看得到手里这一段的文本（`idx.duplicates` 是**段内**重复），
   * 而"全篇一词一注"要跨段才知道——这份账本只有调用方有，所以由它传进来，
   * 由门禁统一算进 ANNO-02。**不另开规则号**：同一条规则只该有一个判定处。
   */
  reannotated?: string[];
  /**
   * 判定粒度：`segment`（默认，整段）｜`sentence`（单句改写）。
   * 单句 scope 下**不补段号**——给一句话前面加 `[P01]` 是错的；
   * 且调用方（`src/core/rewrite.ts`）会传 `target: 0` 让段级的长度约束彻底不参与。
   */
  scope?: 'segment' | 'sentence';
}

/**
 * 「该注的词」的最小长度。**唯一口径**。
 *
 * 为什么要有这个常量：这条规则原来散在四处，而且**两两不同**——
 *   · `qc.ts` 的 `annotable`：`w.length > 2`
 *   · 管线（`会话改写.mjs`）喂给门禁前：`w.length > 2`
 *   · 风险队列（`风险队列.mjs`）：`w.length > 2`
 *   · **App 单句改写（`rewrite.ts` 的 `oovOfText`）：`t.length > 1`**
 * 于是同一个 2 字母超纲词（`ox`、`so` 这类），在 App 里会被拦下要求加注，
 * 而在管线与风险队列里根本不进分母。**同一个指标、两个答案**——
 * 正是《工程优化总计划》「最关键的代码纪律」第 2 条点名的那件事：
 * 「任何门禁字段只能由 `gateSegment` 生成；报告、风险队列和 App 不得重新计算同一指标。」
 *
 * 真项目实测（Animal Farm A/M 层第一章）恰好没有 2 字母超纲词，所以这个分歧一直是**潜在**的；
 * 换一本书、换一份词库它就会浮出来——而那时没人会想到去比对两条路径的分母。
 *
 * 取 3（而不是 2）的理由沿用既有口径：两字母词是 a/an/it/of 这类功能词，
 * 学生本来就认得，把它们算进"该注"只会制造噪音。
 */
export const ANNOTATABLE_MIN_LEN = 3;

/** 应注词型的过滤（去重 + 归一大小写 + 长度阈值）。**所有路径都从这里过。** */
export const annotatableOf = (words: Iterable<string>): string[] => [...new Set([...words].map((w) => String(w).toLowerCase()))].filter((w) => w.length >= ANNOTATABLE_MIN_LEN);

/** 词数（与管线各处一致：字母起首的英文词） */
export const wordCount = (t: string): number => (t.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).length;

/** 去掉 `[P##]` 段标记。段号是结构不是正文内容——混进"事实信号"抽取会造出
 *  「原文的 03 在改写里找不到」这类纯假警报（实测于 2026-09-11 风险队列首跑）。 */
export const stripMarkers = (t: string): string => t.replace(/\[P\d+\]/g, ' ');

/** 分句：包成最小章节喂给 textpipe，保证与 QC 的分句口径完全一致。
 *
 *  ⚠ 没有 `[P##]` 标记时必须**退化成"整块当一段"**，不能返回空数组。
 *  `extractParas` 是按段标记切段的，没有标记就一段都切不出来——
 *  于是 `overLenSentences` 恒为空、**SENT-01（超长句）永远不会触发**。
 *  这个坑是在接单句改写（`src/core/rewrite.ts`，传进来的是光秃秃一句话）时才暴露的：
 *  门禁看起来在跑、指标也在算，实际那条规则一直是死的。 */
export function segmentSentences(text: string): string[] {
  const md = `## Chapter One\n\n${text}\n`;
  const body = splitChapter(md).body;
  const paras = extractParas(body);
  const blocks = paras.length ? paras : [body];
  return blocks.flatMap((p) => sentsOf(p, p.includes('Beasts of England')));
}

/** 去掉模型可能残留的「查词」回合标记（不补段号）——单句改写用 */
export const stripLookup = (text: string): string => text.replace(/【查[^】]*】/g, '').trim();

/** 去掉模型可能残留的「查词」回合标记，并把段落标记归一到**该段应有的编号**。
 *
 *  为什么不是简单地"没有 [P 就补 [P01]"：段号是段落对齐的稳定 ID。
 *  模型偶尔漏写标记或写错段号（第 3 段写成 [P01]），产物里就会出现重复段号，
 *  下游按标记配对的台账与风险队列会**整体错位**——把第 8 段的原句配到第 7 段的改写上。
 *  所以这里把开头的标记强制改写成本段应有的编号。**只有明确给出 markerId 时才改写**：
 *  不给就保持原样，免得把已有的正确段号踩成 P01。 */
export function normalizeSegmentBody(text: string, markerId?: string): string {
  const clean = stripLookup(text);
  if (/^\[P\d+\]/.test(clean)) return markerId ? clean.replace(/^\[P\d+\]/, `[${markerId}]`) : clean;
  return `[${markerId ?? 'P01'}] ${clean}`;
}

/** 直接引语跨度（双引号包起，直/弯两种）从超长句计量中剔除：句法指令同源要求
 *  "直接引语只降词不降句式"（引语修辞属教学内容），门禁与指令必须同一口径——
 *  否则引语密集段（演讲/歌词）在句法点数学上无解，只能反复重试后整段隔离
 *  （2026-09-12 AF 第一章 ecnu-max 全书重制实跑：11/14 段因此隔离）。
 *  **只作用于生成闸门**（exemptQuoteLen，由 stagepatch 的工序门禁传入）：学生读到的
 *  引语长句仍是真实阅读难度，报表/风险队列/回放层照常计数——豁免是"句法工序
 *  改不了引语、不该为它否决"的过程责任口径，不是测量口径。引号未闭合时不豁免。 */
export function stripDirectQuotes(text: string): string {
  return text.replace(/"[^"]*"|“[^”]*”/g, ' ');
}

/**
 * 段级门禁：把一段的客观测量变成 pass / needs-review。
 * 纯函数——同样的输入永远同样的判定，可单测、可回放、可解释。
 */
export function gateSegment(input: SegmentGateInput): SegmentVerdict {
  const body = input.scope === 'sentence' ? stripLookup(input.text) : normalizeSegmentBody(input.text, input.markerId);
  const words = wordCount(body);
  const sents = segmentSentences(body);
  const lenBase = input.exemptQuoteLen ? stripDirectQuotes(body) : body;
  const overLenSentences = segmentSentences(lenBase).filter((s) => wordCount(s) > input.maxLen);

  const idx = parseAnnotations(body, input.dict);
  /* ★ 门禁**自己**过一遍应注词型的口径，而不是信任调用方已经过好了。
   * 这条过滤以前只写在调用方（管线/风险队列各过一次，App 那次过错了），
   * 于是"同一个词在两条路径上要不要注"有两个答案。
   * 门禁是唯一口径的落点，所以它必须把这条规则**收进自己里面**：
   * 调用方传全量也好、传切好的也好，判定结果都一样。 */
  const oov = annotatableOf(input.oov);
  const missing = oov.filter((w) => !idx.covers(w));
  const annotation: AnnotationStat = {
    annotatable: oov.length,
    annotated: oov.length - missing.length,
    coverage: oov.length ? (oov.length - missing.length) / oov.length : 1,
    missing,
    total: idx.list.length,
    extra: idx.duplicates.length,
  };

  const problems: GateProblem[] = [];
  const push = (ruleId: string, message: string, detail?: Record<string, unknown>): void => {
    const r = GATE_RULES[ruleId];
    problems.push({
      ruleId,
      category: r.category,
      severity: r.severity,
      weight: r.weight,
      risk: Number((r.weight * r.probability).toFixed(2)),
      message,
      detail,
    });
  };

  // ---- blocker ----
  if (input.target > 0 && Math.abs(words - input.target) > input.target * 0.12) {
    push('LEN-01', `本段 ${words} 词，偏离目标 ${input.target} 词太远`, { words, target: input.target });
  }
  if (overLenSentences.length) {
    push('SENT-01', `有 ${overLenSentences.length} 句超过本层 ${input.maxLen} 词上限`, {
      maxLen: input.maxLen,
      sentences: overLenSentences.slice(0, 5),
    });
  }
  if (missing.length) {
    push('ANNO-01', `以下超纲词还没加注：${missing.slice(0, 12).join('、')}`, { missing: missing.slice(0, 60) });
  }
  const zh = chineseOutsideAnnotations(body);
  if (zh.length) {
    push('ZH-01', `正文（注释之外）出现中文：${zh.slice(0, 6).join('、')}`, { samples: zh.slice(0, 20) });
  }

  // ---- warn（进风险队列，不阻塞） ----
  // 事实信号在**去掉段标记**的文本上抽：段号是结构，不是内容
  const lost = lostSignals(stripMarkers(input.source), stripMarkers(body));
  const lostNumbers = lost.filter((x) => /^\d/.test(x));
  const lostProper = lost.filter((x) => !/^\d/.test(x));
  if (lostNumbers.length) {
    push('FACT-01', `原文数字在改写里找不到：${lostNumbers.join('、')}`, {
      signals: lostNumbers,
      source: input.source.slice(0, 300),
      rewritten: body.slice(0, 300),
    });
  }
  if (lostProper.length) {
    push('FACT-02', `原文专名在改写里找不到：${lostProper.slice(0, 10).join('、')}`, {
      signals: lostProper.slice(0, 30),
      source: input.source.slice(0, 300),
      rewritten: body.slice(0, 300),
    });
  }
  const dupWords = [...new Set([...idx.duplicates.map((d) => d.word), ...(input.reannotated ?? [])])];
  if (dupWords.length) {
    push('ANNO-02', `同词重复注释：${dupWords.join('、')}（全篇一个词只注一次）`, { words: dupWords });
  }
  if (idx.conflicts.length) {
    push('ANNO-03', `注释释义与统一词典冲突 ${idx.conflicts.length} 处`, { conflicts: idx.conflicts.slice(0, 20) });
  }

  const blockers = problems.filter((p) => p.severity === 'blocker');
  return {
    status: blockers.length ? 'needs-review' : 'pass',
    problems,
    blockers,
    warns: problems.filter((p) => p.severity === 'warn'),
    words,
    target: input.target,
    sentences: sents.length,
    overLen: overLenSentences.length,
    overLenSentences,
    annotation,
  };
}

/** 事实信号（数字/专名）抽取——导出给风险队列复用，别处不要再写第二份 */
export { signalsOf, lostSignals };
