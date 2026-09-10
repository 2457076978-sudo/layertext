/**
 * AI 网络与配置层（无界面依赖）
 * 依赖注入：main 启动时 setAiUi({ onStatus }) 传入状态出口；本层可独立测试。
 * W3：提示词按名加载（prompts/ 内置 ∪ 教师自定义覆盖）· 供应商 failover · 成本台账。
 */

import { invoke } from '@tauri-apps/api/core';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { S, type AppConfig } from './state.js';
import { withRetry } from './pure.js';
import { DEFAULT_MAX_LEN } from './types.js';
import { aiErrHuman as aiErrHumanCore, buildTargets, composePrompt, COST_HEADER, parseManifest, shouldFailover, toCostLine, type ProviderTarget, type PromptManifest } from '../../src/core/aiops.js';
import manifestText from '../../prompts/manifest.json?raw';
import promptSimplify from '../../prompts/system_simplify.md?raw';
import promptDraft from '../../prompts/system_draft.md?raw';
import promptAssistant from '../../prompts/system_assistant.md?raw';
import promptRewriteSentence from '../../prompts/rewrite_sentence.md?raw';
import promptPlotPoints from '../../prompts/plot_points.md?raw';

let ui: { onStatus?: (s: string) => void } | null = null;
export function setAiUi(u: { onStatus?: (s: string) => void }): void {
  ui = u;
}

export const MANIFEST: PromptManifest = parseManifest(manifestText);
const BUNDLED_PROMPTS: Record<string, string> = {
  system_simplify: promptSimplify,
  system_draft: promptDraft,
  system_assistant: promptAssistant,
  rewrite_sentence: promptRewriteSentence,
  plot_points: promptPlotPoints,
};

/* ---------- 提示词按名加载（改提示词不改代码） ---------- */

const promptCache = new Map<string, { version: string; body: string; custom: boolean }>();

/** 教师自定义目录（~/Documents/LayerText配置/prompts/）优先；否则用随应用打包的 prompts/。
 *  版本号来自 manifest；自定义生效时记 v{N}*。 */
export async function loadPrompt(name: string): Promise<{ version: string; body: string; custom: boolean }> {
  const hit = promptCache.get(name);
  if (hit) return hit;
  let out = { version: MANIFEST.prompts[name]?.version ?? '?', body: BUNDLED_PROMPTS[name] ?? '', custom: false };
  try {
    const dir = await invoke<string>('prompts_dir');
    const custom = (await invoke<string>('read_text_file', { path: `${dir}/${name}.md` })).trim();
    if (custom) out = { version: out.version + '*', body: custom, custom: true };
  } catch {
    /* 无自定义则用内置 */
  }
  promptCache.set(name, out);
  return out;
}

/** AI 设置保存后调用：清缓存让下一次请求重新读自定义目录 */
export function reloadPrompts(): void {
  promptCache.clear();
}

/** 当前整套提示词版本（写入台账；任一提示词被自定义覆盖则加 *） */
export async function promptSetVersion(): Promise<string> {
  let custom = false;
  for (const name of Object.keys(MANIFEST.prompts)) if ((await loadPrompt(name)).custom) custom = true;
  return custom ? MANIFEST.setVersion + '*' : MANIFEST.setVersion;
}

export async function loadConfig(): Promise<AppConfig> {
  try {
    S.appConfig = JSON.parse(await invoke<string>('load_app_config')) as AppConfig;
  } catch {
    S.appConfig = {};
  }
  return S.appConfig;
}

export async function saveConfig(): Promise<void> {
  await invoke('save_app_config', { config: JSON.stringify(S.appConfig) });
}

/** 简化标准的句长上限（无预设难度：教师词库锚定难度，句长一个数可调；默认 16 词） */
export function simplifyMaxLen(): number {
  return S.appConfig.simplify?.maxLen ?? DEFAULT_MAX_LEN;
}

export const AI_PROVIDERS: { name: string; url: string; models: string[]; keyTip: string }[] = [
  { name: 'DeepSeek（深度求索）', url: 'https://api.deepseek.com/v1', models: ['deepseek-chat'], keyTip: 'platform.deepseek.com → 左侧「API Keys」→ 创建' },
  { name: '智谱 AI', url: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4.5', 'glm-4.5-flash', 'glm-4-flash'], keyTip: 'bigmodel.cn → 右上角控制台 → API Keys' },
  { name: '月之暗面 Kimi', url: 'https://api.moonshot.cn/v1', models: ['kimi-latest'], keyTip: 'platform.moonshot.cn → API Key 管理' },
  { name: '阿里通义', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-turbo'], keyTip: 'bailian.aliyun.com → API-KEY 管理' },
  { name: 'OpenAI', url: 'https://api.openai.com/v1', models: ['gpt-4o-mini'], keyTip: 'platform.openai.com → API keys' },
  { name: '自定义 / 其他', url: '', models: [], keyTip: '填该服务的 OpenAI 兼容地址（一般以 /v1 结尾）' },
];

export function aiErrHuman(e: unknown): string {
  return aiErrHumanCore(e);
}

/* ---------- 供应商序列（failover） ---------- */

async function activeTargets(): Promise<ProviderTarget[]> {
  const key = await invoke<string>('load_api_key');
  if (!key) throw new Error('未配置 API Key（菜单 LayerText → AI 设置）');
  const cfg = S.appConfig;
  const fallbackKeys: Record<number, string> = {};
  for (let i = 0; i < (cfg.failover ?? []).length; i++) {
    try {
      fallbackKeys[i] = await invoke<string>('load_api_key', { account: 'fb' + i });
    } catch {
      fallbackKeys[i] = '';
    }
  }
  return buildTargets({ baseUrl: (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, ''), model: cfg.model || 'gpt-4o-mini', key }, cfg.failover, fallbackKeys);
}

/* ---------- 成本台账（每次 AI 调用一行，全落 reports_dir） ---------- */

async function logCost(scene: string, t: ProviderTarget, elapsedMs: number, ok: boolean, usage?: { promptTokens?: number; completionTokens?: number }, note?: string): Promise<void> {
  try {
    const s = S.sessions[S.activeIdx];
    const dir = s?.sourcePath ? s.sourcePath.slice(0, s.sourcePath.lastIndexOf('/')) : '';
    const book = dir ? dir.slice(dir.lastIndexOf('/') + 1) : '';
    const dirRep = await invoke<string>('reports_dir');
    let csv = '';
    const path = `${dirRep}/AI成本台账.csv`;
    try {
      csv = await invoke<string>('read_text_file', { path });
    } catch {
      /* 新建 */
    }
    if (!csv.trim()) csv = COST_HEADER.join(',') + '\n';
    csv += toCostLine({
      ts: new Date().toLocaleString('sv-SE'),
      scene,
      book,
      chapter: s?.fileName ?? '',
      provider: t.name,
      model: t.model,
      promptVer: await promptSetVersion(),
      promptTokens: usage?.promptTokens,
      completionTokens: usage?.completionTokens,
      elapsedMs,
      failover: t.index > 0,
      ok,
      note,
    });
    await invoke('write_text_file', { path, content: csv });
  } catch {
    /* 成本台账尽力而为 */
  }
}

/* ---------- 单次请求（含思考模式兼容与自动重试） ---------- */

interface UsageNums {
  promptTokens?: number;
  completionTokens?: number;
}
type UsageText = string;

function usageText(u?: UsageNums): UsageText {
  return u ? `（消耗 ${u.promptTokens ?? '?'} 入 + ${u.completionTokens ?? '?'} 出 tokens）` : '';
}

async function chatOnce(t: ProviderTarget, messages: { role: string; content: string }[], maxTokens: number, externalSignal: AbortSignal | undefined): Promise<{ content: string; usage: UsageNums }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000);
  const onAbort = () => ctrl.abort();
  externalSignal?.addEventListener('abort', onAbort);
  try {
    const mkBody = (withEffort: boolean) =>
      JSON.stringify({
        model: t.model,
        temperature: 0.3,
        max_tokens: maxTokens,
        messages,
        ...(withEffort && S.appConfig.lowThinking !== false
          ? { reasoning_effort: 'low', thinking: { type: 'disabled' } } // DeepSeek：关思考（改写任务无需深度思考）
          : {}),
      });
    let resp = await withRetry(
      () =>
        tauriFetch(`${t.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t.key}` },
          body: mkBody(true),
          signal: ctrl.signal,
        }),
      (s) => ui?.onStatus?.(s),
    );
    if (!resp.ok) {
      const errText = (await resp.text()).slice(0, 200); // body 只读一次，之后要么重试要么抛出
      if (/reasoning_effort|thinking|unknown (field|parameter|argument)/i.test(errText)) {
        resp = await withRetry(
          () =>
            tauriFetch(`${t.baseUrl}/chat/completions`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t.key}` },
              body: mkBody(false),
              signal: ctrl.signal,
            }),
          (s) => ui?.onStatus?.(s),
        );
        if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      } else {
        throw new Error(`HTTP ${resp.status}: ${errText}`);
      }
    }
    const data = (await resp.json()) as {
      choices?: { message?: { content?: string; reasoning_content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const u = data.usage;
    const usage: UsageNums = { promptTokens: u?.prompt_tokens, completionTokens: u?.completion_tokens };
    // 思考型模型（reasoner 类）正文可能在 reasoning_content；合并保证可见
    const msg = data.choices?.[0]?.message;
    const content = [msg?.content ?? '', msg?.reasoning_content ?? ''].filter(Boolean).join('\n');
    return { content, usage };
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onAbort);
  }
}

/** 按序列尝试：主供应商失败（网络/超时/限流/5xx/4xx）→ 逐个备用；每次实际用哪家落成本台账 */
async function callWithFailover<T>(
  scene: string,
  attempt: (t: ProviderTarget) => Promise<{ result: T; usage: UsageNums }>,
): Promise<{ result: T; usage: UsageNums; provider: string; model: string; failoverUsed: boolean }> {
  const targets = await activeTargets();
  let lastErr: unknown = new Error('无可用供应商');
  for (const t of targets) {
    const start = Date.now();
    try {
      const { result, usage } = await attempt(t);
      S.lastProvider = { name: t.name, model: t.model }; // 实际用哪家（failover 切换后为备用名）——建议台账据此记录
      await logCost(scene, t, Date.now() - start, true, usage);
      if (t.index > 0) ui?.onStatus?.(`主供应商不可用，已自动切换到备用「${t.name}」（本次请求已正常完成）`);
      return { result, usage, provider: t.name, model: t.model, failoverUsed: t.index > 0 };
    } catch (e) {
      lastErr = e;
      await logCost(scene, t, Date.now() - start, false, undefined, String(e).slice(0, 80));
      if (t.index === targets.length - 1 || !shouldFailover(e)) throw e;
      ui?.onStatus?.(`「${t.name}」请求失败，尝试备用供应商…`);
    }
  }
  throw lastErr;
}

export async function callChat(messages: { role: string; content: string }[], maxTokens: number, externalSignal?: AbortSignal, scene = 'AI 请求'): Promise<{ content: string; usage: string }> {
  const { result, usage } = await callWithFailover(scene, async (t) => {
    const { content, usage: nums } = await chatOnce(t, messages, maxTokens, externalSignal);
    return { result: content, usage: nums };
  });
  return { content: result, usage: usageText(usage) };
}

/* ---------- 提示词组装（内置模板 + 动态注入） ---------- */

export async function buildSystemPrompt(): Promise<string> {
  const custom = (S.appConfig.instructions ?? '').trim();
  const base = (await loadPrompt('system_simplify')).body;
  return base + (custom ? `\n\n6. 教师的长期审校约定（优先级最高）：\n${custom}` : '') + rewritePrompt();
}

export function rewritePrompt(): string {
  if (!S.rewriteRules.replacements.length && S.rewriteRules.viewpoint === 'keep' && !S.rewriteRules.extra) return '';
  const lines = ['本书全局改写规则（最高优先级，每段都必须遵守）：'];
  if (S.rewriteRules.replacements.length) {
    lines.push('- 人名/词汇替换（必须严格执行，输出中不得出现原词）：');
    for (const r of S.rewriteRules.replacements) lines.push(`  · "${r.from}" 一律写作 "${r.to}"`);
  }
  if (S.rewriteRules.viewpoint === 'first' && S.rewriteRules.viewpointName) {
    lines.push(
      `- 叙事视角：全书以 ${S.rewriteRules.viewpointName} 的第一人称"I"叙述——凡指称 ${S.rewriteRules.viewpointName} 的第三人称（he/she/his/her 或其名）改为 I/my/me（注意动词搭配：he was→I was, he goes→I go）；其他人物对话中提及 ${S.rewriteRules.viewpointName} 时保留其名。`,
    );
  }
  if (S.rewriteRules.extra) lines.push(`- ${S.rewriteRules.extra}`);
  return '\n\n' + lines.join('\n');
}

/** AI 简化本章 system（system_simplify 规则 + system_draft 任务模板） */
export async function buildDraftSystemPrompt(vars: { tierRule: string; chnoNote: string; instructions: string }): Promise<string> {
  const tpl = (await loadPrompt('system_draft')).body;
  return `${await buildSystemPrompt()}\n\n${composePrompt(tpl, vars)}`;
}

/** 逐句改写 user 消息（模板占位符填充） */
export async function buildRewriteSentencePrompt(vars: { maxLen: number | string; intent: string; sent: string }): Promise<string> {
  const tpl = (await loadPrompt('rewrite_sentence')).body;
  return composePrompt(tpl, vars);
}

/** AI 助手身份块（模板占位符填充） */
export async function buildAssistantPrompt(vars: { submitRule: string; fileName: string; markCount: number | string }): Promise<string> {
  const tpl = (await loadPrompt('system_assistant')).body;
  return '\n\n' + composePrompt(tpl, vars);
}

/** AI 批改候选 user 消息（批改域：AI 只出候选，教师勾选定稿——同情节要点方法论） */
export async function buildGradingPrompt(vars: { student: string; vocabNote: string; engine: string; text: string }): Promise<string> {
  const tpl = (await loadPrompt('grading')).body;
  return composePrompt(tpl, vars);
}

/** 定向复习材料 system（review_material 模板：词汇置换+队列词定向复现+目标语法点） */
export async function buildRevSystemPrompt(vars: { words: string; grammar: string; instructions: string; vocabRule: string }): Promise<string> {
  const tpl = (await loadPrompt('review_material')).body;
  return composePrompt(tpl, vars);
}

/** 读后检测题生成 user 消息（AI 出候选，教师勾选定卷；词汇题优先复现队列词） */
export async function buildReadingQuizPrompt(vars: { chapter: string; words: string }): Promise<string> {
  const tpl = (await loadPrompt('reading_quiz')).body;
  return composePrompt(tpl, vars);
}

/** 初步诊断·情节要点提取 user 消息（AI 出候选，教师勾选后进要点配额） */
export async function buildPlotPointsPrompt(chapter: string): Promise<string> {
  const tpl = (await loadPrompt('plot_points')).body;
  return composePrompt(tpl, { chapter });
}

/* ---------- 流式对话（助手侧栏；同样走 failover 与成本台账） ---------- */

export async function chatStream(
  messages: { role: string; content: string; tool_calls?: unknown; tool_call_id?: string }[],
  tools: unknown[],
  onDelta: (t: string) => void,
  scene = 'AI 助手',
): Promise<{ content: string; reasoning: string; toolCalls: { id: string; name: string; arguments: string }[]; usage: string }> {
  const { result, usage } = await callWithFailover(scene, async (t) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 180000);
    try {
      const mkBody = (withEffort: boolean) =>
        JSON.stringify({
          model: t.model,
          temperature: 0.3,
          max_tokens: 4000,
          messages,
          tools,
          stream: true,
          stream_options: { include_usage: true },
          ...(withEffort && S.appConfig.lowThinking !== false ? { reasoning_effort: 'low', thinking: { type: 'disabled' } } : {}),
        });
      let resp = await withRetry(
        () =>
          tauriFetch(`${t.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t.key}` },
            body: mkBody(true),
            signal: ctrl.signal,
          }),
        (s) => ui?.onStatus?.(s),
      );
      if (!resp.ok) {
        const errText = (await resp.text()).slice(0, 200); // body 只读一次，之后要么重试要么抛出
        if (/reasoning_effort|thinking|unknown (field|parameter|argument)/i.test(errText)) {
          resp = await withRetry(
            () =>
              tauriFetch(`${t.baseUrl}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t.key}` },
                body: mkBody(false),
                signal: ctrl.signal,
              }),
            (s) => ui?.onStatus?.(s),
          );
          if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
        } else {
          throw new Error(`HTTP ${resp.status}: ${errText}`);
        }
      }
      const reader = resp.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let content = '';
      let reasoning = '';
      const tc = new Map<number, { id: string; name: string; arguments: string }>();
      const nums: UsageNums = {};
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const s = line.trim();
          if (!s.startsWith('data:')) continue;
          const payload = s.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const j = JSON.parse(payload) as {
              choices?: { delta?: { content?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
              usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
            };
            const d = j.choices?.[0]?.delta as
              { content?: string; reasoning_content?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } | undefined;
            if (d?.content) {
              content += d.content;
              onDelta(d.content);
            }
            if (d?.reasoning_content) reasoning += d.reasoning_content;
            for (const c of d?.tool_calls ?? []) {
              const i = c.index ?? 0;
              const cur = tc.get(i) ?? { id: '', name: '', arguments: '' };
              if (c.id) cur.id = c.id;
              if (c.function?.name) cur.name += c.function.name;
              if (c.function?.arguments) cur.arguments += c.function.arguments;
              tc.set(i, cur);
            }
            if (j.usage) {
              nums.promptTokens = j.usage.prompt_tokens;
              nums.completionTokens = j.usage.completion_tokens;
            }
          } catch {
            /* 忽略半行 */
          }
        }
      }
      return { result: { content: content || reasoning, reasoning, toolCalls: [...tc.values()] }, usage: nums };
    } finally {
      clearTimeout(timer);
    }
  });
  return { ...result, usage: usageText(usage) };
}
