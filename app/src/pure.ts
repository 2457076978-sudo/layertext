/**
 * 纯逻辑模块（无 DOM / Tauri 依赖，可单测）
 * AI 返回解析容错 · 书级替换 · 章节识别与导入归一化
 */

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
  try { host = new URL(host).host; } catch { if (host) host = '(自定义地址)'; }
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

/** 初步诊断：句法风险 → 对应的句标记类型（被/从/完归"语法太难"，超长归"句太长"） */
export function pickSentMarkType(risk: { passive: boolean; relcl: boolean; pastperf: boolean; overlong: boolean }): 'syntax' | 'long' {
  return risk.passive || risk.relcl || risk.pastperf ? 'syntax' : 'long';
}

/** 初步诊断：AI 情节要点并入要点配额——按文本精确去重，返回实际新增的条目 */
export function mergeQuotaTexts(existing: string[], incoming: string[]): string[] {
  const set = new Set(existing.map((t) => t.trim()));
  return incoming.map((t) => t.trim()).filter((t) => t && !set.has(t) && (set.add(t), true));
}
