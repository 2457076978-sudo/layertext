/**
 * AI 运维纯逻辑（W3）· 无 DOM/Tauri/Node 依赖
 * 提示词 manifest 解析与模板填充 · 供应商 failover 目标序列 · 成本台账行
 * 应用（app/src/ai.ts）与 CLI 评测（src/eval.ts）共用。
 */

export interface PromptMeta { version: string; file: string; desc?: string }
export interface PromptManifest {
  setVersion: string;
  prompts: Record<string, PromptMeta>;
  changelog?: { version: string; date: string; note: string }[];
}

export function parseManifest(json: string): PromptManifest {
  const m = JSON.parse(json) as PromptManifest;
  if (!m?.setVersion || typeof m.prompts !== 'object') throw new Error('manifest.json 格式不符（需 setVersion 与 prompts）');
  return m;
}

/** 模板填充：{{key}} → 值；未知占位符原样保留（便于发现拼写错） */
export function fillTemplate(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (whole, k: string) => (k in vars ? String(vars[k]) : whole));
}

/** 完整 prompt 组装：内置/自定义体 + 变量；返回带版本信息的正文 */
export function composePrompt(body: string, vars: Record<string, string | number>): string {
  return fillTemplate(body, vars).trim();
}

/* ---------- 供应商 failover ---------- */

export interface ProviderTarget {
  name: string;
  baseUrl: string;
  model: string;
  key: string;
  /** 序列位置：0=主供应商，>0=第 N 备 */
  index: number;
}

export interface FailoverConfig { name?: string; baseUrl?: string; model?: string; key?: string }

/** 由 host 推导服务商显示名（未知 host 原样显示） */
export function providerNameOf(baseUrl: string): string {
  try { return new URL(baseUrl).host; } catch { return baseUrl ? '自定义' : '未配置'; }
}

/** 组装调用序列：主供应商在前，备用按配置顺序；备用未单独配 key 则复用主 key */
export function buildTargets(
  primary: { baseUrl: string; model: string; key: string },
  failover: (FailoverConfig | undefined)[] | undefined,
  fallbackKeys: Record<number, string>,
): ProviderTarget[] {
  const out: ProviderTarget[] = [{
    name: providerNameOf(primary.baseUrl), baseUrl: primary.baseUrl, model: primary.model, key: primary.key, index: 0,
  }];
  (failover ?? []).forEach((f, i) => {
    if (!f?.baseUrl?.trim() || !f.model?.trim()) return;
    const key = (fallbackKeys[i] ?? '').trim() || (f.key ?? '').trim() || primary.key;
    out.push({ name: f.name?.trim() || providerNameOf(f.baseUrl), baseUrl: f.baseUrl.trim(), model: f.model.trim(), key, index: i + 1 });
  });
  return out;
}

/** 错误是否值得降级到下一家（网络类/限流/服务端错；4xx 参数类在换家后同样可能失败，但按"逐级降级"口径也换） */
export function shouldFailover(err: unknown): boolean {
  const s = String(err);
  return /Failed to fetch|NetworkError|timeout|Timeout|aborted|ECONNRESET|socket|HTTP 5\d{2}|HTTP 429|HTTP 4\d{2}/.test(s);
}

/** 服务商错误 → 教师能看懂的人话（欠账#7：补 403/模型无权限等分类；不认识的原样返回） */
export function aiErrHuman(e: unknown): string {
  const s = String(e);
  if (s.includes('403') || /permission|not authorized|access denied|无权限|权限不足|无权访问/i.test(s))
    return 'Key 没有这个模型的权限——常见原因：①模型名写错（回到 AI 设置，选服务商后用自动推荐的模型名）②这个模型需要单独开通或实名认证 ③免费额度 Key 只支持部分模型。换个模型再试';
  if (s.includes('401')) return 'Key 不对或已过期——回到服务商网站重新复制一次';
  if (s.includes('404')) return '地址或模型名不对——检查 API 地址末尾是否带 /v1、模型名拼写是否与服务商一致';
  if (s.includes('429')) return '请求太频繁或额度不足——稍等再试，或去服务商网站看看余额';
  if (s.includes('Failed to fetch') || s.includes('NetworkError')) return '连不上服务器——检查网络，或 API 地址是否填错';
  if (/insufficient|余额不足|欠费/i.test(s)) return '账户余额不足——到服务商网站充值';
  if (/model.*not.*(found|exist)|invalid model|未知模型|模型不存在/i.test(s)) return '没有这个模型——AI 设置里检查模型名拼写（不同服务商叫法不同，用预设推荐的准没错）';
  return s;
}

/* ---------- 成本台账 ---------- */

export const COST_HEADER = ['时间', '场景', '书', '章节', '供应商', '模型', '提示词版本', '入tokens', '出tokens', '耗时ms', 'failover', '结果'] as const;

export interface CostRow {
  ts: string; scene: string; book: string; chapter: string;
  provider: string; model: string; promptVer: string;
  promptTokens?: number; completionTokens?: number; elapsedMs: number;
  failover: boolean; ok: boolean; note?: string;
}

export function toCostLine(r: CostRow): string {
  const cell = (v: string | number | boolean | undefined) => {
    const s = String(v ?? '');
    return /[",]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [
    r.ts, r.scene, r.book, r.chapter, r.provider, r.model, r.promptVer,
    r.promptTokens ?? '', r.completionTokens ?? '', r.elapsedMs,
    r.failover ? '是' : '', r.ok ? 'ok' : 'err' + (r.note ? ':' + r.note.slice(0, 60) : ''),
  ].map(cell).join(',') + '\n';
}

export interface CostSummary { calls: number; promptTokens: number; completionTokens: number; errCount: number; failoverCount: number }

/** 汇总成本台账文本（宽容解析：列序即 COST_HEADER；bookFilter 只统计某本书） */
export function summarizeCost(csv: string, bookFilter?: string): CostSummary {
  const s: CostSummary = { calls: 0, promptTokens: 0, completionTokens: 0, errCount: 0, failoverCount: 0 };
  for (const line of csv.split('\n')) {
    if (!line.trim() || line.startsWith(COST_HEADER[0] + ',')) continue;
    const c = line.split(',');
    if (c.length < 12) continue;
    if (bookFilter && (c[2] ?? '') !== bookFilter) continue;
    s.calls++;
    s.promptTokens += Number(c[7]) || 0;
    s.completionTokens += Number(c[8]) || 0;
    if (c[10] === '是') s.failoverCount++;
    if (c[11]?.startsWith('err')) s.errCount++;
  }
  return s;
}
