// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，本仓库已部署版权验证体系，细节不予公开（docs/版权与授权.md）。
/**
 * LayerText · 单句/单段改写服务契约（SentenceRewrite）
 *
 * 来源：《LayerText 审查报告 v4_方向》第 1 条 ——
 *   「App 与管线可以有不同上下文大小，但必须共用同一个输入输出 schema、
 *     同一个 `gateSegment` 判定和写入事务。App 单句改写当前只调用 `buildSystemPrompt`，
 *     随后只运行 `checkRev`，没有词表、词典、专名和事实检查。**这是残余 P0。**」
 *
 * 项目里原本有两条产生正文的路径，约束强度差一个数量级：
 *   · 管线会话改写：19.6k tokens 开场（词表+词典+专名+情节底线）+ 段级门禁 4 条 blocker
 *   · App 单句改写：只带句长上限/句法黑名单/教师意图 + 事后只查句法黑名单
 * 于是"静默坏产物"在管线侧被封死之后，整体搬到了教师天天点的 App 侧。
 *
 * 本模块的做法（与 v4 方向一致）：**合并契约与门禁，分离上下文与成本**。
 *   · 契约：无论谁调用，进出都是 `RewriteRequest` / `RewriteResult`；
 *   · 门禁：两条路最后都走同一个 `gateSegment`，判定口径只有一份；
 *   · 上下文：管线传全量策略（LexiconSnapshot），App 只传**局部切片**
 *     （本书专名 + 本句相关的 OOV + 已注词 + 词典里命中的那几条），几百 token 级。
 *
 * ── 与段级门禁的一处**有意差异**（单句 scope）──────────────────────────
 * 段级门禁问"这一段该注的词注了没有"；单句改写问的是
 * 「**这次改写有没有把原来没有的难词带进来而没注**」。
 * 理由：单句改写不是"给这一段做加注"的场合——源句里本就该注而没注的词，
 * 是**补注脚本**的活；把它算在单句改写头上，会让老师每改一句都被要求顺手加注，
 * 而他要的可能只是"把这句拆短一点"。所以 ANNO-01 在 sentence scope 下只针对
 * **新引入**的超纲词。这条差异写在类型注释里、有断言锁定，不靠口头约定。
 */

import { makeCovers, parseAnnotations } from './annot.js';
import { annotatableOf, gateSegment, normalizeSegmentBody, stripLookup, type GateProblem, type SegmentVerdict } from './segmentgate.js';
import { hit, sentsOf, tokenizeTxt } from './textpipe.js';

/** 改写的粒度：整段（管线）｜单句（App 点一句改一句） */
export type RewriteScope = 'segment' | 'sentence';

/**
 * 改写策略：调用方按自己付得起的成本给多少算多少。
 * 缺字段**不会**被当成"没问题"，而是被记进 `missingPolicy` ——
 * 于是"这次判定是在缺约束的情况下做的"是可见的，而不是假装查过了。
 */
export interface RewritePolicy {
  /** 难度标签。**故意是自由字符串而不是 `Tier`**：管线有 A/M/B 三档，
   *  而 App 侧早已停用分层（`app/src/state.ts:25`：句长上限可调、黑名单一律禁用），
   *  它只有一个"简化标准"。真正的判定输入是 `maxLen`（与 `target`），tier 只进 traceId 与显示。
   *  把 tier 做成枚举会逼 App 编一个假的档位——那比不写更糟。 */
  tier: string;
  /** 本层句长上限 */
  maxLen: number;
  /** 学生已知词（引擎口径：课标 + 词库 + 专名 + 词句卡）+ 本书专名 */
  known: Iterable<string>;
  /** 已注词账本（全篇一词一注）——不给就等于放弃了"重复注"这条检查 */
  annotated?: Iterable<string>;
  /** 统一词典（同词同义）——不给就等于放弃了"释义冲突"这条检查 */
  dict?: Map<string, string>;
  /** 整段改写的目标词数（单句 scope 下忽略：长度是段级约束） */
  target?: number;
}

export interface RewriteRequest {
  /** 待改写的原文（单句或整段，含 `[P##]` 与否都行） */
  source: string;
  /** 教师意图（"太长"/"从句太多"/"换个说法"…），与 App 现有标记类型对齐 */
  intent?: string;
  scope: RewriteScope;
  tier: string;
  /** 书籍版本标识（清单 runId 或稿件内容哈希）：写进结果，回答"这条是对着哪一版做的" */
  bookVersion: string;
  /** 上下文各一句（只用于显示，不参与判定） */
  context?: { prev?: string; next?: string };
  /** 本段应有的段号（形如 P07）。segment scope 下管线知道它、必须传下来，
   *  否则模型漏写段号时会被补成 [P01]，产物里出现重复段号、下游按标记配对整体错位 */
  markerId?: string;
  /** 提示词版本：进 traceId，失败复现时能定位是哪一版写的 */
  promptVersion?: string;
}

export interface RewriteResult {
  revised: string;
  checks: SegmentVerdict;
  /** candidate = 可以给教师看/写；blocked = **不许直写正文**，只显示候选与原因 */
  status: 'candidate' | 'blocked';
  /** 稳定追踪 ID：同一 (书版本|scope|原文|提示词版本) 永远同一个 */
  traceId: string;
  /** 这次判定在缺哪些策略下做的（空数组 = 策略齐备） */
  missingPolicy: string[];
  /** 被门禁拦下的原因（status='blocked' 时非空，直接进界面文案） */
  blockedReasons: string[];
}

/* ────────────────────── 词表工具（与 runQc 同一口径，但不依赖 Lexicon 对象） ────────────────────── */

/**
 * 文本里的超纲词型（分词 → 词形还原命中 → 按**应注词型**的口径收口）。
 *
 * ★ 这里原来是 `t.length > 1`，而管线、风险队列、QC 报告用的都是 `> 2`——
 * 于是同一个 2 字母超纲词（`ox`、`so` 这类）在 App 里会被拦下要求加注，
 * 在别处却根本不进分母：**同一个指标两个答案**。
 * 现在统一走 `annotatableOf`（口径定义在 `segmentgate.ts`，也就是门禁自己那里）。
 */
export function oovOfText(text: string, known: Iterable<string>): string[] {
  const knownSet = known instanceof Set ? (known as Set<string>) : new Set([...known].map((w) => String(w).toLowerCase()));
  const toks = tokenizeTxt(sentsOf(text, false).join(' '));
  return annotatableOf(toks.filter((t) => !hit(t, knownSet)));
}

/** 本书里已经注过的词（账本）：从一段或多段正文里解析 */
export function annotationLedgerOf(...texts: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) for (const a of parseAnnotations(t).list) out.add(a.key);
  return out;
}

/* ────────────────────── 契约核心 ────────────────────── */

/** 稳定 traceId（FNV-1a 双通道，与 manifest 的 contentHash 同法，浏览器与 Node 结果一致） */
export function traceIdOf(req: RewriteRequest, scope: RewriteScope = req.scope): string {
  const parts = [req.bookVersion, scope, req.tier, req.source, req.intent ?? '', req.promptVersion ?? ''];
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const s = parts.join('\u0001');
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
  }
  h2 = Math.imul(h2 ^ (h1 >>> 13), 0xc2b2ae35) >>> 0;
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 16);
}

/** 策略缺了什么（**可见地缺**，不假装查过） */
export function missingPolicyOf(policy: RewritePolicy): string[] {
  const miss: string[] = [];
  if (!policy.annotated) miss.push('已注词账本（本句无法判断是否重复注）');
  if (!policy.dict || policy.dict.size === 0) miss.push('统一词典（本句无法判断释义是否与全书一致）');
  if (![...policy.known].length) miss.push('学生词汇表（本句无法判断哪些词超纲）');
  return miss;
}

/**
 * 判定一次改写。**这是两条路径唯一的那道门**。
 * 纯函数：不读文件、不写文件；App 与管线调用它得到同样的结论。
 */
export function checkRewrite(req: RewriteRequest, policy: RewritePolicy, revised: string): RewriteResult {
  const scope = req.scope;
  /* ★ 判定用的正文 = 返回给调用方写盘的正文，**必须是同一个字符串**。
   * 第一版这里返回的是入参原文、而门禁判的是归一化之后的文本，两者会差一个段号前缀——
   * 于是"门禁说 [P07] 没问题、写进去的却是没有段号的一句"，正是本项目反复在治的那类错配。 */
  const body = scope === 'sentence' ? stripLookup(revised) : normalizeSegmentBody(revised, req.markerId);
  const covers = makeCovers(policy.annotated ?? []);

  const srcOov = oovOfText(req.source, policy.known);
  const revOov = oovOfText(body, policy.known);
  /* ★ sentence scope 的差异（见文件头注释）：
   *   只把**这次改写新引入**的超纲词算作"该注"。
   *   segment scope 保持原语义：这一段出现的超纲词（去掉别处已注的）都该注。 */
  const mustNow =
    scope === 'sentence'
      ? revOov.filter((w) => !srcOov.includes(w)).filter((w) => !covers(w))
      : [...new Set([...srcOov, ...revOov])].filter((w) => !covers(w));

  // 别处已注、这里又注 → 交给门禁统一算进 ANNO-02（全篇一词一注）
  const reannotated = [...new Set(parseAnnotations(body).list.map((a) => a.key))].filter((k) => covers(k));

  const checks = gateSegment({
    text: body,
    source: req.source,
    // 单句 scope 传 0：长度是段级约束，拿"整段目标词数"去卡一句话是错的用法
    target: scope === 'segment' ? (policy.target ?? 0) : 0,
    maxLen: policy.maxLen,
    oov: mustNow,
    dict: policy.dict,
    scope,
    markerId: req.markerId,
    reannotated,
  });

  const blockedReasons = checks.blockers.map((p: GateProblem) => `${p.ruleId} ${p.message}`);
  return {
    revised: body,
    checks,
    status: checks.status === 'pass' ? 'candidate' : 'blocked',
    traceId: traceIdOf(req, scope),
    missingPolicy: missingPolicyOf(policy),
    blockedReasons,
  };
}

/**
 * 从 LexiconSnapshot 那一类**全量**素材造策略（管线用）。
 * 管线付得起 19.6k tokens 的开场，所以这里给的是完整约束。
 */
export function fullPolicy(input: {
  tier: string;
  maxLen: number;
  known: Iterable<string>;
  annotated?: Iterable<string>;
  dict?: Map<string, string>;
  target?: number;
}): RewritePolicy {
  return { ...input };
}

/**
 * App 侧的**局部切片**：只取这本书真正需要的那几百 token。
 *
 * 与全量的差别（v4 方向："分离上下文与成本"）：
 *   · 学生词汇表不给全表，只给"本句相关的判定口径"——因为判定在本地做，
 *     模型不需要看见全表；模型需要知道的是"哪些词必须注、哪些绝不能注"。
 *   · 专名表全给（通常几十个，且是硬约束）。
 *   · 词典只给本句命中词的那几条。
 */
export function policySlice(input: {
  tier: string;
  maxLen: number;
  known: Iterable<string>;
  properNames: string[];
  /** 整本书的已注词（App 从打开的稿件 + 同目录其它章恢复） */
  annotated?: Iterable<string>;
  /** 只把本句相关的那几条释义带进来 */
  dict?: Map<string, string>;
  /** 本句（含候选）里出现的词，用于裁词典 */
  involved?: string[];
}): RewritePolicy {
  const dict = new Map<string, string>();
  if (input.dict && input.involved?.length) {
    const covers = makeCovers(input.annotated ?? []);
    for (const w of input.involved) {
      const k = w.toLowerCase();
      const zh = input.dict.get(k);
      if (zh && !covers(k)) dict.set(k, zh);
    }
  }
  return {
    tier: input.tier,
    maxLen: input.maxLen,
    // 专名并进已知词：专名不加注、不计生词（与管线同一口径）
    known: [...input.known, ...input.properNames.map((w) => w.toLowerCase())],
    annotated: input.annotated,
    dict,
    // 单句 scope 下 target 不参与判定，给 0 让"段级长度"这条彻底不参与
    target: 0,
  };
}

/** 给界面用的一句话说明：这次判定是在什么约束下做的 */
export function describeChecks(r: RewriteResult): string {
  const bits: string[] = [];
  if (r.status === 'blocked') bits.push(`未通过门禁：${r.blockedReasons.join('；')}`);
  else bits.push('通过门禁');
  if (r.missingPolicy.length) bits.push(`⚠ 本次未带：${r.missingPolicy.join('、')}`);
  if (r.checks.warns.length) bits.push(`待判断：${r.checks.warns.map((w) => w.ruleId).join('、')}`);
  return bits.join('｜');
}
