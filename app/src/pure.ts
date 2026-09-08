/**
 * 纯逻辑模块（无 DOM / Tauri 依赖，可单测）
 * AI 返回解析容错 · 书级替换 · 章节识别与导入归一化 · 定位与标记重排（O4 自 main.ts 抽出）
 */

import { chnoFromPath, extractParas, sentsOf, splitChapter } from '../../src/core/textpipe.js';
import { tokenizeTxt } from '../../src/core/textpipe.js';
import type { Mark } from './types.js';

/** 章号/报告 tag 的路径解析已收敛到 core/textpipe（CLI 与 App 共用唯一实现），此处转发导出 */
export { chnoFromPath, tagFromPath } from '../../src/core/textpipe.js';

/** CSV 单元格转义（含逗号/引号/换行加双引号，内部引号翻倍） */
export function csvCell(v: string): string {
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

/** 在正文中唯一定位原句（句文本精确匹配；多处或未找到返回 null）——行内建议挂载用 */
export function locateOriginal(md: string, original: string): { pi: number; si: number } | null {
  const paras = extractParas(splitChapter(md).body);
  const hits: { pi: number; si: number }[] = [];
  paras.forEach((p, pi) =>
    sentsOf(p, false).forEach((sent, si) => {
      if (sent === original) hits.push({ pi, si });
    }),
  );
  return hits.length === 1 ? hits[0] : null;
}

/** 文本变化后，按句子前缀把现有标记重新对齐（防替换/拆句后错位；就地修改 marks） */
export function remapMarks(marks: Mark[], md: string): void {
  const paras = extractParas(splitChapter(md).body);
  const sents = paras.map((p) => sentsOf(p, false));
  for (const m of marks) {
    const prefix = (m.text ?? '').slice(0, 12);
    if (!prefix) continue; // 旧数据无句前缀，保留原索引
    const cur = sents[m.pi]?.[m.si];
    let ok = cur && cur.startsWith(prefix);
    if (!ok) {
      const hits: [number, number][] = [];
      sents.forEach((ss, pi) =>
        ss.forEach((sent, si) => {
          if (sent.startsWith(prefix)) hits.push([pi, si]);
        }),
      );
      if (hits.length === 1) {
        m.pi = hits[0][0];
        m.si = hits[0][1];
        ok = true;
      }
    }
    if (ok && m.level === 'word' && m.word) {
      const sent = sents[m.pi]?.[m.si] ?? '';
      const toks = tokenizeTxt(sent);
      const raws = sent.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
      const wi = raws.findIndex((w, i) => (toks[i] ?? w.toLowerCase()) === m.word!.toLowerCase());
      if (wi >= 0) m.wi = wi;
    }
  }
}

/** 从 AI 返回文本中尽力解析出 JSON 数组（代码围栏/单对象/多对象无括号/截断修复/前后解释文字） */
export function parseAiJson(raw: string): unknown[] {
  let t = (raw ?? '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const tryArr = (s: string): unknown[] | null => {
    try {
      const v = JSON.parse(s) as unknown;
      return Array.isArray(v) ? v : [v];
    } catch {
      return null;
    }
  };
  const s1 = t.indexOf('[');
  if (s1 >= 0) {
    const e1 = t.lastIndexOf(']');
    if (e1 > s1) {
      const r = tryArr(t.slice(s1, e1 + 1));
      if (r) return r;
    }
    // 截断修复：在最后一个完整对象后补 ]
    const lastObj = t.lastIndexOf('}');
    if (lastObj > s1) {
      const r = tryArr(t.slice(s1, lastObj + 1) + ']');
      if (r) return r;
    }
  }
  const s2 = t.indexOf('{');
  const e2 = t.lastIndexOf('}');
  if (s2 >= 0 && e2 > s2) {
    const slice = t.slice(s2, e2 + 1);
    const r = tryArr(slice) ?? tryArr('[' + slice + ']'); // 单对象 / 无括号多对象
    if (r) return r;
  }
  throw new Error('AI 返回中未找到 JSON（AI 原话前 200 字：' + (raw ?? '').slice(0, 200).replace(/\s+/g, ' ') + '）');
}

/** 空白归一化：连续空白压成单个空格并去首尾（比对用，不改原文） */
export function normWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * 空白不敏感地在正文中定位 AI 给出的 original（欠账#2：句末空格/多重空格曾导致比对失败、AI 反复重试）。
 * 优先唯一精确匹配；否则按空白归一化匹配；多处命中（歧义）或未命中返回 null。
 * 返回的 exact 是正文里的原文切片（含其原始空白），供后续精确替换使用。
 */
export function findOriginalFlex(md: string, original: string): { start: number; exact: string } | null {
  if (!original.trim()) return null;
  // ① 唯一精确匹配直接用
  const first = md.indexOf(original);
  if (first >= 0 && md.indexOf(original, first + 1) < 0) return { start: first, exact: original };
  // ② 归一化匹配：构建压缩视图 + 原文位置映射
  let norm = '';
  const map: number[] = [];
  for (let i = 0; i < md.length; i++) {
    const c = md[i];
    if (/\s/.test(c)) {
      if (norm.endsWith(' ')) continue; // 连续空白只记第一个的位置
      norm += ' ';
    } else {
      norm += c;
    }
    map.push(i);
  }
  const target = normWs(original);
  if (!target) return null;
  const hits: number[] = [];
  let at = norm.indexOf(target);
  while (at >= 0) {
    hits.push(at);
    at = norm.indexOf(target, at + 1);
  }
  if (hits.length !== 1) return null;
  const h = hits[0];
  const start = map[h];
  const end = map[h + target.length - 1] + 1;
  return { start, exact: md.slice(start, end) };
}

/** 书级替换：词边界确定性替换（机器执行，零遗漏） */
export function applyRewriteTo(text: string, rules: { from: string; to: string }[]): string {
  let t = text;
  for (const r of rules) {
    if (!r.from || !r.to) continue;
    const esc = r.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`\\b${esc}\\b`, 'g'), r.to);
  }
  return t;
}

/** 网络类自动重试：可重试错误（断连/超时/5xx/429 限流）指数退避重试，其余立即抛出 */
export async function withRetry<T>(fn: () => Promise<T>, onStatus?: (s: string) => void, maxAttempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const s = String(e);
      const retriable = /Failed to fetch|NetworkError|timeout|Timeout|aborted|ECONNRESET|socket|HTTP 5\d{2}|HTTP 429/.test(s);
      if (!retriable || i === maxAttempts - 1) throw e;
      const wait = (i + 1) * 2000;
      onStatus?.(`网络不稳，${wait / 1000} 秒后自动重试（第 ${i + 1}/${maxAttempts - 1} 次）…`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

const CH_TITLE = /^(chapter\s+[\w-]+|第[一二三四五六七八九十百\d]+章)/i;

export interface SplitChapterResult {
  /** 拆分后的章节（单章或无章节时长度为 1） */
  chapters: { title: string; md: string }[];
  /** 原文本是否含 ## Chapter 标记（已合规则直接使用） */
  alreadyFormatted: boolean;
}

/**
 * 导入归一化：任意文本 → 章节 md 数组。
 * ① 已含 ## Chapter 标记：直接使用；② 含多个章节标题行（Chapter X / 第X章）：按标题拆章；
 * ③ 无章节结构：按空行分段包装为单章（不要求落盘，内存直接可显示）。
 */
export function normalizeAndSplitChapters(raw: string, fileName: string): SplitChapterResult {
  if (/^## Chapter \w+/m.test(raw)) {
    return { chapters: [{ title: fileName, md: raw }], alreadyFormatted: true };
  }
  const text = raw.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const heads: { line: number; title: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trim().match(CH_TITLE);
    if (m && lines[i].trim().length <= 60) heads.push({ line: i, title: lines[i].trim() });
  }
  const wrap = (bodyText: string, title: string, chNo: number): string => {
    const paras = bodyText
      .split(/\n\s*\n/)
      .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
      .filter((p) => /[A-Za-z\u4e00-\u9fff]/.test(p));
    return `# ${fileName}\n\n## Chapter ${chNo}\n\n${paras.map((p, i) => `[P${String(i + 1).padStart(2, '0')}] ${p}`).join('\n\n')}\n`;
  };
  if (heads.length >= 2) {
    const chapters = heads.map((h, idx) => {
      const end = idx + 1 < heads.length ? heads[idx + 1].line : lines.length;
      return { title: `${fileName.replace(/\.(md|txt|docx|doc)$/i, '')} · ${h.title}`, md: wrap(lines.slice(h.line + 1, end).join('\n'), h.title, idx + 1) };
    });
    return { chapters, alreadyFormatted: false };
  }
  return { chapters: [{ title: fileName, md: wrap(text, fileName, 1) }], alreadyFormatted: false };
}

/**
 * 复核改写文本（可能含多句）：按句拆分逐句检测，overlong = 最长一句超限。
 * riskOne：单句检测函数（由 UI 层注入 sentenceRisks 的单句版，避免本模块依赖引擎）。
 */
export function checkRevisedText(
  revised: string,
  maxLen: number,
  riskOne: (sent: string, maxLen: number) => { passive: boolean; relcl: boolean; pastperf: boolean; overlong: boolean },
): { passive: boolean; relcl: boolean; pastperf: boolean; overlong: boolean } {
  const sents = revised.split(/(?<=[.!?])\s+/).filter((s) => /[A-Za-z]/.test(s));
  const out = { passive: false, relcl: false, pastperf: false, overlong: false };
  for (const s of sents) {
    const r = riskOne(s, maxLen);
    out.passive ||= r.passive;
    out.relcl ||= r.relcl;
    out.pastperf ||= r.pastperf;
    out.overlong ||= r.overlong;
  }
  return out;
}

/** 诊断包配置摘要（W5）：只保留域名/模型名/开关/数量，不含任何书稿与学生文本、不含 Key 与约定内容 */
export interface DiagConfigInput {
  baseUrl?: string;
  model?: string;
  failover?: unknown[];
  autoRewriteOnMark?: boolean;
  trustEdit?: boolean;
  inPlaceEdit?: boolean;
  lowThinking?: boolean;
  simplify?: unknown;
  recentFiles?: string[];
  instructions?: string;
}

export function buildDiagSummary(cfg: DiagConfigInput, appVersion: string, userAgent: string): Record<string, unknown> {
  let host = cfg.baseUrl ?? '';
  try {
    host = new URL(host).host;
  } catch {
    if (host) host = '(自定义地址)';
  }
  return {
    应用版本: appVersion,
    系统: userAgent,
    导出时间: new Date().toISOString(),
    配置摘要: {
      AI服务商域名: host || '(未配置)',
      模型: cfg.model || '(未配置)',
      备用供应商数: cfg.failover?.length ?? 0,
      全局AI直改: cfg.autoRewriteOnMark ?? false,
      信任模式: cfg.trustEdit ?? false,
      原地编辑原稿: cfg.inPlaceEdit ?? true,
      关闭思考: cfg.lowThinking !== false,
      简化标准自定义: Boolean(cfg.simplify),
      长期审校约定字数: (cfg.instructions ?? '').length,
      最近文件数: cfg.recentFiles?.length ?? 0,
    },
    隐私说明: '本诊断包不含任何书稿、学生文本或 API Key；仅含配置摘要、错误日志与成本统计。',
  };
}

/** 估算 tokens（英文≈3.5字符/词符，中文≈1.6字）——压缩与请求前的成本预估共用同一口径 */
export function estTokens(s: string): number {
  const cjk = (s.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const rest = s.length - cjk;
  return Math.round(cjk * 1.6 + rest / 3.5);
}

export interface ChatMsgLike {
  role: string;
  content: string;
  tool_calls?: unknown;
  tool_call_id?: string;
}

export interface CompactionPlan {
  need: boolean;
  /** 保留尾段的起始索引（need=true 时必为 user 消息：不拆散 assistant.tool_calls 与其 tool 结果） */
  keptFrom: number;
  /** 被压缩为摘要的前段条数 */
  headCount: number;
  estBefore: number;
  estHead: number;
  estTail: number;
}

export const COMPACT_DEFAULTS = { maxEst: 6000, maxMsgs: 40, keepUserTurns: 6, summaryEst: 300 } as const;

/**
 * 对话压缩计划（欠账#1：长对话越滚越贵越慢）。估算 tokens 超限或消息条数超限时，
 * 把倒数第 keepUserTurns 轮 user 之前的旧消息摘要化。user 轮数不足时不压（没有安全切点）。
 */
export function planCompaction(msgs: ChatMsgLike[], opts?: Partial<typeof COMPACT_DEFAULTS>): CompactionPlan {
  const o = { ...COMPACT_DEFAULTS, ...opts };
  const estOf = (m: ChatMsgLike) => estTokens(m.content) + (m.tool_calls ? estTokens(JSON.stringify(m.tool_calls)) : 0);
  const estBefore = msgs.reduce((n, m) => n + estOf(m), 0);
  const userIdx: number[] = [];
  msgs.forEach((m, i) => {
    if (m.role === 'user') userIdx.push(i);
  });
  const cut = userIdx.length > o.keepUserTurns ? userIdx[userIdx.length - o.keepUserTurns] : -1;
  const need = cut > 0 && (estBefore > o.maxEst || msgs.length > o.maxMsgs);
  const headCount = need ? cut : 0;
  const estHead = need ? msgs.slice(0, cut).reduce((n, m) => n + estOf(m), 0) : 0;
  return { need, keptFrom: need ? cut : 0, headCount, estBefore, estHead, estTail: estBefore - estHead };
}

/* ---------- 全书批处理（O2）：队列规划与书级汇总报告（纯逻辑可测） ---------- */

/** 进度文件（书稿文件夹/_全书批处理进度.json）：中断可续跑——done 的章下次自动跳过 */
export interface BatchProgressFile {
  date: string;
  instructions: string;
  /** key = 章节源文件完整路径 */
  status: Record<string, 'done' | 'failed'>;
}

export interface BatchChapterItem {
  path: string;
  name: string;
  /** 上次批处理已完成（续跑时默认跳过） */
  done: boolean;
  /** 源文本段落数（[P##] 计数；供队列预估） */
  segCount: number;
}

/** 队列规划：全部候选文件 + 进度文件 → 待跑清单（保持文件名排序；done 项保留在列表中供界面展示"已完成"） */
export function planBatchChapters(paths: string[], progress: BatchProgressFile | null): BatchChapterItem[] {
  return paths.map((path) => ({
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    done: progress?.status[path] === 'done',
    segCount: 0,
  }));
}

export interface BookReportRow {
  chapter: string;
  output: string;
  segCount: number;
  /** 生词率（词型） */
  oovRate: string;
  avgLen: string;
  maxLen: number;
  passive: number;
  relcl: number;
  pastperf: number;
  overlong: number;
  /** 书级替换规则残留总数 */
  ruleLeft: number;
  elapsedMs: number;
  outTokens: number;
  status: 'done' | 'failed';
  error?: string;
}

/** 书级汇总报告（全书简化报告_日期.md）：各章指标横向表 + 合计 + 人工复查提示 */
export function buildBookReportMd(rows: BookReportRow[], meta: { book: string; date: string; maxLen: number; instructions?: string; provider?: string }): string {
  const done = rows.filter((r) => r.status === 'done');
  const sum = (f: (r: BookReportRow) => number): number => done.reduce((n, r) => n + f(r), 0);
  const cell = (r: BookReportRow, f: (x: BookReportRow) => number | string): string => (r.status === 'failed' ? '—' : String(f(r)));
  const lines: string[] = [`# 全书简化报告 · ${meta.book}`, '', `- 日期：${meta.date}｜简化标准：句长上限 ${meta.maxLen} 词/句｜完成 ${done.length}/${rows.length} 章`];
  if (meta.instructions) lines.push(`- 方向指令：${meta.instructions}`);
  if (meta.provider) lines.push(`- AI 供应商：${meta.provider}`);
  lines.push(
    '',
    '| 章 | 产物 | 段数 | 生词率 | 平均句长 | 最长句 | 被动 | 定从 | 过去完成 | 超长 | 规则残留 | 耗时 | 出tokens |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${r.chapter} | ${r.status === 'failed' ? '（失败）' : r.output} | ${cell(r, (x) => x.segCount)} | ${cell(r, (x) => x.oovRate)} | ${cell(r, (x) => x.avgLen)} | ${cell(r, (x) => x.maxLen)} | ${cell(r, (x) => x.passive)} | ${cell(r, (x) => x.relcl)} | ${cell(r, (x) => x.pastperf)} | ${cell(r, (x) => x.overlong)} | ${cell(r, (x) => x.ruleLeft)} | ${cell(r, (x) => `${(x.elapsedMs / 1000).toFixed(0)}s`)} | ${cell(r, (x) => x.outTokens)} |`,
    ),
    `| **合计** | | ${sum((r) => r.segCount)} | | | | ${sum((r) => r.passive)} | ${sum((r) => r.relcl)} | ${sum((r) => r.pastperf)} | ${sum((r) => r.overlong)} | ${sum((r) => r.ruleLeft)} | ${(sum((r) => r.elapsedMs) / 1000).toFixed(0)}s | ${sum((r) => r.outTokens)} |`,
    '',
  );
  const attention = rows.filter((r) => r.status === 'failed' || (r.status === 'done' && (r.passive + r.relcl + r.pastperf + r.overlong > 0 || r.ruleLeft > 0)));
  if (attention.length) {
    lines.push('## 建议人工复查', '');
    for (const r of attention) {
      if (r.status === 'failed') lines.push(`- ${r.chapter}：简化失败（${r.error ?? '原因未知'}）——可单独打开该章用「📖 整章改写」处理`);
      else {
        const bits = [
          r.passive ? `被动 ${r.passive}` : '',
          r.relcl ? `定从 ${r.relcl}` : '',
          r.pastperf ? `过去完成 ${r.pastperf}` : '',
          r.overlong ? `超长 ${r.overlong}` : '',
          r.ruleLeft ? `替换规则残留 ${r.ruleLeft} 处` : '',
        ].filter(Boolean);
        lines.push(`- ${r.chapter}：${bits.join('、')}——打开产物做标记精修`);
      }
    }
    lines.push('');
  } else if (done.length) {
    lines.push('全部章节黑名单清零、无规则残留 🎉 逐章打开产物做标记精修即可。', '');
  }
  lines.push('> 指标口径与单章体检一致（黑名单=被动/定从/过去完成一律禁用；超长=超过简化标准句长上限）。产物文件与本章报告在同一文件夹。');
  return lines.join('\n');
}

/** 初步诊断：句法风险 → 对应的句标记类型（被/从/完归"语法太难"，超长归"句太长"） */
export function pickSentMarkType(risk: { passive: boolean; relcl: boolean; pastperf: boolean; overlong: boolean }): 'syntax' | 'long' {
  return risk.passive || risk.relcl || risk.pastperf ? 'syntax' : 'long';
}

/** 初步诊断：AI 情节要点并入要点配额——按文本精确去重，返回实际新增的条目 */
export function mergeQuotaTexts(existing: string[], incoming: string[]): string[] {
  const set = new Set(existing.map((t) => t.trim()));
  return incoming.map((t) => t.trim()).filter((t) => t && !set.has(t) && (set.add(t), true));
}

/* ---------- 班级多人定制（feature/reinforce）：分组/个人目标合并（纯逻辑，测试全假数据） ---------- */

export interface ClassTarget {
  id: string; // 如 "组:B" / "人:焦佳琪"
  名称: string; // 显示名，如 "B层(32人)" / "焦佳琪(B)"
  类型: '组' | '人';
  句长上限?: number; // 缺省用全局简化标准
  覆盖目标?: number; // 该目标覆盖目标带下限%（分层个体化：B98/M97/A95，文献95/98群体均值的分层版）
  成员数?: number;
  已学词?: string[]; // 该目标的已学词集（个人/组内合并）
  到期词?: string[]; // 本篇应复现的到期队列
}

export interface MergedTargets {
  active: boolean;
  minLen: number; // 最严句长上限（无选择=全局）
  coverageTarget: number | null; // 多目标取最严覆盖目标带（max）；无=用文献通用 95/98
  knownInter: string[]; // 已学词交集（只在有个人词集的目标间求交；组词集=全体成员并集，参与交集）
  dueUnion: string[]; // 到期词并集（稳定序：被选次数降序→字母序，上限 12——"尽量多复现"教师指令）
  label: string; // 目标标签（命名/提示用）
}

/** 多选合并口径：句长取最严、已学词取交集、到期词取并集（5-8 词/篇的复现预算） */
export function mergeTargets(selected: ClassTarget[], globalMaxLen: number, dueCap = 12): MergedTargets {
  if (selected.length === 0) {
    return { active: false, minLen: globalMaxLen, coverageTarget: null, knownInter: [], dueUnion: [], label: '' };
  }
  const minLen = Math.min(globalMaxLen, ...selected.map((t) => t.句长上限 ?? globalMaxLen));
  const covs = selected.map((t) => t.覆盖目标).filter((c): c is number => typeof c === 'number');
  const coverageTarget = covs.length ? Math.max(...covs) : null;
  // 交集：只在提供了已学词的目标之间求交；目标词集为空数组=“无个人数据”不参与（避免空交吞掉全部）
  const withWords = selected.filter((t) => (t.已学词?.length ?? 0) > 0);
  let knownInter: string[] = [];
  if (withWords.length > 0) {
    const sets = withWords.map((t) => new Set(t.已学词!));
    knownInter = [...sets[0]].filter((w) => sets.every((s) => s.has(w))).sort();
  }
  // 并集：按被选目标出现次数降序，同频字母序，截断 dueCap
  const freq = new Map<string, number>();
  for (const t of selected) for (const w of t.到期词 ?? []) freq.set(w, (freq.get(w) ?? 0) + 1);
  const dueUnion = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, dueCap)
    .map(([w]) => w);
  const label = selected.map((t) => t.名称).join('+');
  return { active: true, minLen, coverageTarget, knownInter, dueUnion, label: label.length > 28 ? label.slice(0, 27) + '…' : label };
}

/** 个人目标搜索过滤（折叠多选栏的过滤框） */
export function filterTargets(targets: ClassTarget[], q: string): ClassTarget[] {
  const s = q.trim().toLowerCase();
  if (!s) return targets;
  return targets.filter((t) => t.名称.toLowerCase().includes(s) || t.id.toLowerCase().includes(s));
}

/* ---------- 工作区（2026-09-08 Wayne 指令：3 层次=3 工作区，像浏览器标签切换） ---------- */

export interface Workspace {
  名: string; // 如 "B层工作区"
  定制目标?: string; // 绑定的班级定制目标 id（如 "组:B"），激活工作区时自动勾选
  文件: string[]; // 章节文件绝对路径（按序展示为章节 chips）
}

/** 解析书目录 _工作区.json（宽容：缺字段/空文件列表跳过；返回 [] 表示无工作区） */
export function parseWorkspaces(raw: string): Workspace[] {
  let j: { 工作区?: unknown };
  try {
    j = JSON.parse(raw) as { 工作区?: unknown };
  } catch {
    return [];
  }
  if (!Array.isArray(j.工作区)) return [];
  const out: Workspace[] = [];
  for (const w of j.工作区 as Array<Record<string, unknown>>) {
    const 名 = typeof w.名 === 'string' ? w.名.trim() : '';
    const files = Array.isArray(w.文件) ? (w.文件 as unknown[]).filter((f): f is string => typeof f === 'string' && f.trim() !== '') : [];
    if (!名 || files.length === 0) continue;
    out.push({ 名, 定制目标: typeof w.定制目标 === 'string' ? w.定制目标 : undefined, 文件: files });
  }
  return out;
}

/** 工作区章节 chip 显示名：候选版文件（同层各章同名）取目录名（第一章），否则取文件名去扩展 */
export function workspaceChipName(path: string): string {
  const file = path.slice(path.lastIndexOf('/') + 1).replace(/\.(md|txt|markdown|docx)$/i, '');
  if (file.startsWith('候选版')) {
    const dir = path.slice(0, path.lastIndexOf('/')).split('/').pop() ?? '';
    if (/^第.{1,4}章$|^Chapter/i.test(dir)) return dir; // 只认章节目录名，避免普通目录名误用
  }
  return file || path;
}

/* ---------- 书架书封（2026-09-08 Wayne：正常书比例 + 书名当封面字号自适应 + 两级导航） ---------- */

/** 书名视觉宽度（CJK 全角=1、其余≈0.55），用于封面字号分档 */
export function coverVisualWidth(title: string): number {
  let w = 0;
  for (const ch of title) w += /[\u2e80-\u9fff\u3000-\u303f\u30a0-\u30ff\uff00-\uffef]/.test(ch) ? 1 : 0.55;
  return w;
}

/** 文字封面的书名字号：按视觉宽度分档收缩，保证除极端长名外书名完整可见（长名最多 4 行换行显示） */
export function coverTitlePx(title: string): number {
  const w = coverVisualWidth(title);
  if (w <= 3.5) return 30;
  if (w <= 5) return 26;
  if (w <= 7) return 21;
  if (w <= 10) return 18;
  if (w <= 14) return 15;
  return 12.5;
}

export interface VersionCardInfo {
  idx: number;
  名: string;
  desc: string;
  first: string;
  target?: string;
}

/** 版本选择页卡片数据（点书 → 先选版本 → 再进工作区）：desc=章数+绑定口径，first=第一章 chip 名 */
export function buildVersionCards(ws: Workspace[]): VersionCardInfo[] {
  return ws.map((w, idx) => ({
    idx,
    名: w.名,
    desc: `${w.文件.length} 章${w.定制目标 ? ` · 绑定口径 ${w.定制目标}` : ''}`,
    first: w.文件.length ? workspaceChipName(w.文件[0]) : '',
    target: w.定制目标,
  }));
}

/* ---------- 书架管理（搜索 / 分组 / 进度，Feature Parity：对所有书统一生效） ---------- */

export interface ShelfFilters {
  q: string;
  group: string | null;
}

/** 命中分组：null=全部；''=未分组；其他=精确分组（书架分组以相等为命中） */
function inGroup(b: { 分组?: string }, want: string | null): boolean {
  if (want === null) return true;
  return (b.分组 ?? '').trim() === want;
}

/** 命中搜索：多词 AND，匹配书名/副标题/分组（大小写不敏感） */
function matchesWords(b: { 名: string; 副标题?: string; 分组?: string }, words: string[]): boolean {
  if (words.length === 0) return true;
  const hay = `${b.名} ${b.副标题 ?? ''} ${b.分组 ?? ''}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** 书架过滤 = 命中分组 且 命中搜索词 */
export function filterShelfBooks<T extends { 名: string; 副标题?: string; 分组?: string }>(books: T[], f: ShelfFilters): T[] {
  const words = f.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return books.filter((b) => inGroup(b, f.group) && matchesWords(b, words));
}

/** 书架现有分组清单（去重排序；空分组不入列） */
export function shelfGroupsOf<T extends { 分组?: string }>(books: T[]): string[] {
  return [...new Set(books.map((b) => b.分组?.trim() ?? '').filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

/** 阅读进度百分比（0-100 整数；总数缺失或未开卷 → 0，封顶 100） */
export function progressPct(read: number, total: number | undefined): number {
  if (!total || read <= 0) return 0;
  return Math.min(100, Math.round((read / total) * 100));
}

/** 段落书签切换：已有同段书签则移除，否则追加（按 pi 去重排序；返回新数组与是否为"添加"） */
export function toggleParaBookmark(list: { pi: number; text: string; ts: number }[], pi: number, text: string, ts: number): { list: { pi: number; text: string; ts: number }[]; added: boolean } {
  if (list.some((b) => b.pi === pi)) return { list: list.filter((b) => b.pi !== pi), added: false };
  return { list: [...list, { pi, text: text.slice(0, 60), ts }].sort((a, b) => a.pi - b.pi), added: true };
}

/* ---------- 双栏逐句对照（审校核心：基准版 vs 当前版，行对行 + 信号丢失检测） ---------- */

export interface AlignSentRef {
  pi: number;
  si: number;
  text: string;
}
export interface AlignRow {
  kind: 'match' | 'lost' | 'added';
  base?: AlignSentRef;
  cur?: AlignSentRef;
  /** match 行：基准句里的数字/专名在当前句找不到的清单（"信息丢了"机器核对） */
  lostSignals?: string[];
}

/** 英文数字词 → 数字串（three→3），让数字词与阿拉伯数字能互认 */
const NUM_WORDS: Record<string, string> = {
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
  eleven: '11',
  twelve: '12',
  thirteen: '13',
  fourteen: '14',
  fifteen: '15',
  sixteen: '16',
  seventeen: '17',
  eighteen: '18',
  nineteen: '19',
  twenty: '20',
  thirty: '30',
  forty: '40',
  fifty: '50',
  hundred: '100',
  thousand: '1000',
  first: '1st',
  second: '2nd',
  third: '3rd',
  once: '1',
  twice: '2',
};

/** 常见句首词（小写）——句首大写不算专名，避免整章误报 */
const SENT_STARTERS = new Set([
  'the',
  'a',
  'an',
  'he',
  'she',
  'it',
  'they',
  'we',
  'you',
  'i',
  'but',
  'and',
  'or',
  'when',
  'while',
  'after',
  'before',
  'if',
  'then',
  'now',
  'there',
  'this',
  'that',
  'these',
  'those',
  'his',
  'her',
  'its',
  'their',
  'my',
  'your',
  'our',
  'so',
  'for',
  'at',
  'in',
  'on',
  'no',
  'yes',
  'all',
  'each',
  'every',
  'some',
  'many',
  'few',
  'both',
  'what',
  'who',
  'where',
  'why',
  'how',
  'as',
  'by',
  'from',
  'with',
  'to',
  'of',
  'up',
  'out',
  'about',
  'into',
  'over',
  'under',
  'not',
  'never',
  'always',
  'often',
  'sometimes',
  'soon',
  'later',
  'next',
  'last',
  'mr',
  'mrs',
  'miss',
  'dr',
  'one',
  'two',
  'three',
  'everyone',
  'everybody',
  'somebody',
  'nobody',
  'anyone',
  'another',
  'several',
  'most',
  'none',
  'today',
  'tomorrow',
  'yesterday',
  'long',
  'only',
  'very',
  'just',
  'still',
  'even',
  'perhaps',
  'maybe',
  'neither',
  'whether',
  'because',
  'since',
  'until',
  'though',
  'although',
  'here',
  'come',
  'look',
  'listen',
  'said',
  'asked',
  'one day',
  'suddenly',
  'at last',
]);

/** 句子指纹：小写、去标点、压空白——完全相同句的对齐锚点 */
function sentKey(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 内容词集（>2 字符），配对相似度用 */
function wordSet(t: string): Set<string> {
  return new Set(
    sentKey(t)
      .split(' ')
      .filter((w) => w.length > 2),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

/** 抽取句子的"事实信号"：数字（含英文数字词归一）+ 专名（句首外的大写词） */
export function signalsOf(t: string): string[] {
  const out: string[] = [];
  out.push(...(t.match(/\d+(?:\.\d+)?/g) ?? []));
  const words = t.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
  for (const w of words) {
    const lower = w.toLowerCase();
    if (NUM_WORDS[lower]) out.push(NUM_WORDS[lower]);
    // 大写词且不在常见句首词白名单 → 视为专名（Boxer 句首也可检出；The/They 排除）
    if (/^[A-Z]/.test(w) && !SENT_STARTERS.has(lower)) out.push(w);
  }
  return out;
}

/** 基准句有、当前句没有的信号（"信息丢了"的机器核对口径） */
export function lostSignals(baseText: string, curText: string): string[] {
  const cur = new Set(signalsOf(curText));
  return [...new Set(signalsOf(baseText).filter((x) => !cur.has(x)))];
}

/** 句级对齐：完全相同句做 LCS 锚点；锚点间隙按词集 Jaccard≥0.45 贪心配对（改写句），
 *  配不上=lost（基准有此处无）/ added（此处新增）。match 行附信号丢失清单。 */
export function alignSentencePairs(base: AlignSentRef[], cur: AlignSentRef[]): AlignRow[] {
  const bk = base.map((s) => sentKey(s.text));
  const ck = cur.map((s) => sentKey(s.text));
  const n = base.length;
  const m = cur.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = bk[i] === ck[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const anchors: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (bk[i] === ck[j]) {
      anchors.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  const rows: AlignRow[] = [];
  let bi = 0;
  let cj = 0;
  const emitGap = (bEnd: number, cEnd: number): void => {
    const bs: AlignSentRef[] = [];
    const cs: AlignSentRef[] = [];
    while (bi < bEnd) bs.push(base[bi++]);
    while (cj < cEnd) cs.push(cur[cj++]);
    const used = new Set<number>();
    for (const b of bs) {
      let best = -1;
      let bestSim = 0.45;
      cs.forEach((c, k) => {
        if (used.has(k)) return;
        const sim = jaccard(wordSet(b.text), wordSet(c.text));
        if (sim > bestSim) {
          bestSim = sim;
          best = k;
        }
      });
      if (best >= 0) {
        used.add(best);
        rows.push({ kind: 'match', base: b, cur: cs[best] });
      } else rows.push({ kind: 'lost', base: b });
    }
    cs.forEach((c, k) => {
      if (!used.has(k)) rows.push({ kind: 'added', cur: c });
    });
  };
  for (const [ai, aj] of anchors) {
    emitGap(ai, aj);
    rows.push({ kind: 'match', base: base[ai], cur: cur[aj] });
    bi = ai + 1;
    cj = aj + 1;
  }
  emitGap(n, m);
  for (const r of rows) {
    if (r.kind === 'match' && r.base && r.cur) {
      const lost = lostSignals(r.base.text, r.cur.text);
      if (lost.length) r.lostSignals = lost;
    }
  }
  return rows;
}

/* ================= EPUB 导入（拖一本书直接进管线：zip→spine→段落） ================= */

import { unzipSync, strFromU8 } from 'fflate';

export interface EpubChapter {
  title: string;
  paragraphs: string[];
}

function xmlAttr(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`${name}="([^"]*)"`))?.[1];
}

function decodeEntities(s: string): string {
  return s
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[e]!)
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));
}

/** epub（zip 字节）→ 阅读顺序的章列表：container.xml → OPF（书名/manifest/spine）→ 各文档的段落。
 *  环节缺失如实抛错，由调用方提示"不是有效的 epub 文件"。 */
export function parseEpubChapters(bin: Uint8Array): { bookTitle: string; chapters: EpubChapter[] } {
  const files = unzipSync(bin);
  const read = (p: string): string => {
    const f = files[p] ?? files[p.replace(/^\//, '')];
    if (!f) throw new Error(`epub 缺少文件：${p}`);
    return strFromU8(f);
  };
  const opfPath = read('META-INF/container.xml').match(/full-path="([^"]+)"/)?.[1];
  if (!opfPath) throw new Error('container.xml 里找不到 OPF 路径');
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const opf = read(opfPath);
  const bookTitle = decodeEntities(opf.match(/<dc:title[^>]*>([^<]*)<\/dc:title>/)?.[1] ?? '') || '未命名书';
  const manifest = new Map<string, string>();
  for (const m of opf.matchAll(/<item\b[^>]*>/g)) {
    const id = xmlAttr(m[0], 'id');
    const href = xmlAttr(m[0], 'href');
    if (id && href) manifest.set(id, href);
  }
  const chapters: EpubChapter[] = [];
  for (const m of opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)) {
    const href = manifest.get(m[1]!);
    if (!href || !/\.x?html?$/i.test(href)) continue;
    const html = read(opfDir + decodeURIComponent(href));
    // 章标题：<title> 优先，缺省取第一个标题块；标题块不进正文段落（与 <title> 重复）
    const title =
      decodeEntities(html.match(/<title[^>]*>([^<]*)<\/title>/)?.[1] ?? '') ||
      decodeEntities(
        html
          .match(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i)?.[1]
          ?.replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim() ?? '',
      );
    const paragraphs = [...html.matchAll(/<(?:p|blockquote)\b[^>]*>([\s\S]*?)<\/(?:p|blockquote)>/gi)]
      .map((x) =>
        decodeEntities(
          x[1]!
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim(),
        ),
      )
      .filter((t) => /[A-Za-z]/.test(t));
    if (paragraphs.length > 0) chapters.push({ title: title || `第 ${chapters.length + 1} 节`, paragraphs });
  }
  if (chapters.length === 0) throw new Error('epub 未解析出任何英文段落（spine 为空或内容为扫描图）');
  return { bookTitle, chapters };
}

/** epub 章节包装成会话章节 md（与导入归一化同款格式：## Chapter One + [P01] 段标） */
export function epubChapterMd(bookTitle: string, ch: EpubChapter): string {
  return `# ${bookTitle} — ${ch.title}\n\n## Chapter One\n\n${ch.paragraphs.map((p, i) => `[P${String(i + 1).padStart(2, '0')}] ${p}`).join('\n\n')}\n`;
}

/* ================= 审校过程档案（论文素材自动成卷） ================= */

export interface QcSummaryLite {
  newWordRate: number; // ② 生词率
  avgLen: number; // ③ 平均句长
  sentCount: number;
  passive: number; // ⑤
  relcl: number; // ⑥
  pastperf: number; // ⑦
  oovCount: number;
}

export interface DossierData {
  书名: string;
  章名: string;
  版本: string;
  生成时间: string;
  句长上限: number;
  基准摘要?: QcSummaryLite;
  当前摘要: QcSummaryLite;
  对照?: { 对齐: number; 丢句: { pos: string; base: string; lost: string[] }[]; 信号缺失: { pos: string; cur: string; lost: string[] }[]; 新增: string[] };
  台账: { ts: string; markType: string; outcome: string; original: string; revised: string; basis: string }[];
  标记: { label: string; n: number }[];
  门禁: Record<string, boolean>;
}

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + '…' : s);

/** 章审校档案 → Markdown（论文素材：指标对照 + 逐句对照摘要 + 决策记录 + 标记/门禁） */
export function buildChapterDossierMd(d: DossierData): string {
  const pct = (v: number): string => (v * 100).toFixed(1) + '%';
  const L: string[] = [];
  L.push(`# 审校档案 ·《${d.书名}》${d.章名}${d.版本 ? `（${d.版本}）` : ''}`);
  L.push('');
  L.push(`生成：${d.生成时间} ｜ 简化标准：句长上限 ${d.句长上限} 词/句 ｜ 工具：LayerText 分层读`);
  L.push('');
  L.push('## 一、指标对照');
  L.push('');
  L.push('| 指标 |' + (d.基准摘要 ? ' 基准版 |' : '') + ' 当前版 |');
  L.push('|---|' + (d.基准摘要 ? '---|' : '') + '---|');
  const row = (label: string, f: (s: QcSummaryLite) => string): void => {
    L.push(`| ${label} |` + (d.基准摘要 ? ` ${f(d.基准摘要)} |` : '') + ` ${f(d.当前摘要)} |`);
  };
  row('② 生词率', (s) => pct(s.newWordRate));
  row('③ 平均句长（词）', (s) => s.avgLen.toFixed(1));
  row('句数', (s) => String(s.sentCount));
  row('⑤ 被动句', (s) => String(s.passive));
  row('⑥ 定语从句', (s) => String(s.relcl));
  row('⑦ 过去完成', (s) => String(s.pastperf));
  row('OOV 词种', (s) => String(s.oovCount));
  L.push('');
  if (d.对照) {
    L.push('## 二、逐句对照摘要');
    L.push('');
    L.push(`对齐 ${d.对照.对齐} 句 ｜ 疑似丢句 ${d.对照.丢句.length} ｜ 信号缺失 ${d.对照.信号缺失.length} 处 ｜ 新增 ${d.对照.新增.length}`);
    if (d.对照.丢句.length) {
      L.push('');
      L.push('### 疑似丢句（基准有、当前无）');
      for (const x of d.对照.丢句) L.push(`- ${x.pos}：${clip(x.base, 80)}${x.lost.length ? `（丢：${x.lost.join('、')}）` : ''}`);
    }
    if (d.对照.信号缺失.length) {
      L.push('');
      L.push('### 信号缺失（配对成功但数字/专名对不上）');
      for (const x of d.对照.信号缺失) L.push(`- ${x.pos}：${clip(x.cur, 80)}（缺：${x.lost.join('、')}）`);
    }
    L.push('');
  }
  L.push('## ' + (d.对照 ? '三' : '二') + '、决策记录（AI 建议台账·本章）');
  L.push('');
  if (d.台账.length) {
    L.push('| 时间 | 标记类型 | 结果 | 原句 | 建议句 | 依据 |');
    L.push('|---|---|---|---|---|---|');
    for (const r of d.台账) L.push(`| ${r.ts} | ${r.markType} | ${r.outcome} | ${clip(r.original, 40)} | ${clip(r.revised, 40)} | ${clip(r.basis, 50)} |`);
  } else {
    L.push('（本章暂无 AI 建议记录）');
  }
  L.push('');
  L.push('## ' + (d.对照 ? '四' : '三') + '、标记与终审门禁');
  L.push('');
  L.push(d.标记.length ? `标记 ${d.标记.reduce((n, x) => n + x.n, 0)} 处：` + d.标记.map((x) => `${x.label} ${x.n}`).join('／') : '本章无标记');
  const gates = Object.entries(d.门禁).map(([g, ok]) => `${g}${ok ? ' ✓' : ' ✗'}`);
  L.push('');
  L.push(`终审门禁：${gates.join('　')}`);
  L.push('');
  return L.join('\n');
}

/** 档案文件名：审校档案_第N章_YYYY-MM-DD.md（无章号用章名） */
export function dossierFileName(章名: string, date: string): string {
  const ch = chnoFromPath(章名) ? `第${'一二三四五六七八九十'[chnoFromPath(章名)! - 1]}章` : 章名.replace(/\.(md|txt|markdown|docx)$/i, '');
  return `审校档案_${ch}_${date}.md`;
}

/* ================= 书级审校看板（一张表看懂还剩多少活） ================= */

export interface BoardRow {
  path: string;
  章: string;
  门禁勾选: number;
  门禁总数: number;
  标记数: number;
  书签数: number;
  生词率: number | null;
  建议数: number;
  采纳数: number;
  当前: boolean;
}

/** 看板汇总头部：过门禁 x/y 章、平均生词率、总标记、建议采纳率 */
export function boardSummary(rows: BoardRow[]): { 过门禁: string; 平均生词率: string; 总标记: number; 采纳率: string } {
  const gated = rows.filter((r) => r.门禁总数 > 0 && r.门禁勾选 === r.门禁总数).length;
  const rates = rows.map((r) => r.生词率).filter((x): x is number => x !== null);
  const avgRate = rates.length ? (rates.reduce((a, b) => a + b, 0) / rates.length) * 100 : null;
  const 建议总数 = rows.reduce((n, r) => n + r.建议数, 0);
  const 采纳总数 = rows.reduce((n, r) => n + r.采纳数, 0);
  return {
    过门禁: `${gated}/${rows.length}`,
    平均生词率: avgRate === null ? '—' : avgRate.toFixed(1) + '%',
    总标记: rows.reduce((n, r) => n + r.标记数, 0),
    采纳率: 建议总数 ? `${Math.round((采纳总数 / 建议总数) * 100)}%（${采纳总数}/${建议总数}）` : '—',
  };
}
