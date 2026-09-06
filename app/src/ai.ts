/**
 * AI 网络与配置层（无界面依赖）
 * 依赖注入：main 启动时 setAiUi({ onStatus }) 传入状态出口；本层可独立测试。
 */

import { invoke } from '@tauri-apps/api/core';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { S, type AppConfig } from './state.js';
import { withRetry } from './pure.js';
import { DEFAULT_TIER_PLANS, type TierPlan } from './types.js';

let ui: { onStatus?: (s: string) => void } | null = null;
export function setAiUi(u: { onStatus?: (s: string) => void }): void { ui = u; }



export async function loadConfig(): Promise<AppConfig> {
  try {
    S.appConfig = JSON.parse(await invoke<string>('load_app_config')) as AppConfig;
  } catch { S.appConfig = {}; }
  return S.appConfig;
}

export async function saveConfig(): Promise<void> {
  await invoke('save_app_config', { config: JSON.stringify(S.appConfig) });
}

export function tierPlan(tier: string): TierPlan {
  return { ...DEFAULT_TIER_PLANS[tier] ?? DEFAULT_TIER_PLANS.M, ...(S.appConfig.tiers?.[tier] ?? {}) };
}

export function tierMaxLen(tier: string): number {
  return tierPlan(tier).maxLen;
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
  const s = String(e);
  if (s.includes('401')) return 'Key 不对或已过期——回到服务商网站重新复制一次';
  if (s.includes('404')) return '地址或模型名不对——检查 API 地址末尾是否带 /v1、模型名拼写是否与服务商一致';
  if (s.includes('429')) return '请求太频繁或额度不足——稍等再试，或去服务商网站看看余额';
  if (s.includes('Failed to fetch') || s.includes('NetworkError')) return '连不上服务器——检查网络，或 API 地址是否填错';
  if (s.includes('insufficient')) return '账户余额不足——到服务商网站充值';
  return s;
}

export async function callChat(
  messages: { role: string; content: string }[],
  maxTokens: number,
  externalSignal?: AbortSignal,
): Promise<{ content: string; usage: string }> {
  const cfg = S.appConfig;
  const key = await invoke<string>('load_api_key');
  if (!key) throw new Error('未配置 API Key（菜单 LayerText → AI 设置）');
  const base = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = cfg.model || 'gpt-4o-mini';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000);
  const onAbort = () => ctrl.abort();
  externalSignal?.addEventListener('abort', onAbort);
  try {
    const resp = await withRetry(() => tauriFetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, temperature: 0.3, max_tokens: maxTokens, messages }),
      signal: ctrl.signal,
    }), (s) => ui?.onStatus?.(s));
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data = (await resp.json()) as {
      choices?: { message?: { content?: string; reasoning_content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const u = data.usage;
    const usage = u ? `（消耗 ${u.prompt_tokens ?? '?'} 入 + ${u.completion_tokens ?? '?'} 出 = ${u.total_tokens ?? '?'} tokens）` : '';
    // 思考型模型（reasoner 类）正文可能在 reasoning_content；合并保证可见
    const msg = data.choices?.[0]?.message;
    const content = [msg?.content ?? '', msg?.reasoning_content ?? ''].filter(Boolean).join('\n');
    return { content, usage };
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onAbort);
  }
}

export async function buildSystemPrompt(): Promise<string> {
  const custom = (S.appConfig.instructions ?? '').trim();
  return AI_SYSTEM_PROMPT + (custom ? `\n\n6. 教师的长期审校约定（优先级最高）：\n${custom}` : '') + rewritePrompt();
}

export const AI_SYSTEM_PROMPT = `你是初中英语原著分层简化的审校助手，帮助教师按学生水平改写英文文本。严格遵守：
1. 词汇边界：替换目标词时优先使用中国《义务教育英语课程标准》三级（初中毕业要求，约1600词）范围内的词；专有名词与既定术语表词汇保持不变。
2. 句法黑名单（除直接引语内的原话）：被动语态→改主动；定语从句→拆成短句或用形容词前置；过去完成时→一般过去时并用 before/after 明示先后。
3. 句长上限：改写后的句子不超过指定词数上限；宁可拆成两句。
4. 保真：不改变情节、事实、人物与语气；好词保留/好句锚点类标记不要改写，直接返回 original 原文并在 basis 里说明建议保留。
5. 你只出候选：输出修订建议供教师勾选，不是最终稿。
输出格式：只输出一个 JSON 数组，不要任何其他文字。每个元素：
{"id":"标记ID","type":"标记类型","original":"原句原文（一字不改）","revised":"建议改写后的完整句子","basis":"依据（中文，一句话）","alternative":"可选的备选改写（可省略）"}`;


export function rewritePrompt(): string {
  if (!S.rewriteRules.replacements.length && S.rewriteRules.viewpoint === 'keep' && !S.rewriteRules.extra) return '';
  const lines = ['本书全局改写规则（最高优先级，每段都必须遵守）：'];
  if (S.rewriteRules.replacements.length) {
    lines.push('- 人名/词汇替换（必须严格执行，输出中不得出现原词）：');
    for (const r of S.rewriteRules.replacements) lines.push(`  · "${r.from}" 一律写作 "${r.to}"`);
  }
  if (S.rewriteRules.viewpoint === 'first' && S.rewriteRules.viewpointName) {
    lines.push(`- 叙事视角：全书以 ${S.rewriteRules.viewpointName} 的第一人称"I"叙述——凡指称 ${S.rewriteRules.viewpointName} 的第三人称（he/she/his/her 或其名）改为 I/my/me（注意动词搭配：he was→I was, he goes→I go）；其他人物对话中提及 ${S.rewriteRules.viewpointName} 时保留其名。`);
  }
  if (S.rewriteRules.extra) lines.push(`- ${S.rewriteRules.extra}`);
  return '\n\n' + lines.join('\n');
}

export async function chatStream(
  messages: { role: string; content: string; tool_calls?: unknown; tool_call_id?: string }[],
  tools: unknown[],
  onDelta: (t: string) => void,
): Promise<{ content: string; toolCalls: { id: string; name: string; arguments: string }[]; usage: string }> {
  const cfg = S.appConfig;
  const key = await invoke<string>('load_api_key');
  if (!key) throw new Error('未配置 API Key（菜单 LayerText → AI 设置…）');
  const base = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = cfg.model || 'gpt-4o-mini';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000);
  try {
    const resp = await withRetry(() => tauriFetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model, temperature: 0.3, max_tokens: 4000, messages, tools,
        stream: true, stream_options: { include_usage: true },
      }),
      signal: ctrl.signal,
    }), (s) => ui?.onStatus?.(s));
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const reader = resp.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let content = '';
    let reasoning = '';
    let usage = '';
    const tc = new Map<number, { id: string; name: string; arguments: string }>();
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
          const d = j.choices?.[0]?.delta as { content?: string; reasoning_content?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } | undefined;
          if (d?.content) { content += d.content; onDelta(d.content); }
          if (d?.reasoning_content) reasoning += d.reasoning_content;
          for (const c of d?.tool_calls ?? []) {
            const i = c.index ?? 0;
            const cur = tc.get(i) ?? { id: '', name: '', arguments: '' };
            if (c.id) cur.id = c.id;
            if (c.function?.name) cur.name += c.function.name;
            if (c.function?.arguments) cur.arguments += c.function.arguments;
            tc.set(i, cur);
          }
          if (j.usage) usage = `（本轮 ${j.usage.prompt_tokens ?? '?'} 入 + ${j.usage.completion_tokens ?? '?'} 出 tokens）`;
        } catch { /* 忽略半行 */ }
      }
    }
    return { content: content || reasoning, toolCalls: [...tc.values()], usage };
  } finally {
    clearTimeout(timer);
  }
}
