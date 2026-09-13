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
import {
  aiErrHuman as aiErrHumanCore,
  auxReady,
  buildTargets,
  composePrompt,
  COST_HEADER,
  parseManifest,
  shouldFailover,
  toCostLine,
  type ProviderTarget,
  type PromptManifest,
} from '../../src/core/aiops.js';
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
    /* 有意兜底：自定义提示词目录里**大多数名字本来就没有文件**（教师只覆盖个别几个），
     * 所以"读不到"是每次加载都会走的常态，不是异常。代价也写清楚：
     * 真读不到时台账记的是内置版本号——这是本设计里已知的取舍。 */
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
  } catch (e) {
    /* 读设置失败**不许假装"这台机器从没配过"**：S.appConfig 一变成空对象，
     * 后面任何一次 saveConfig()（切章、记最近文件、换主题都会触发）都会把空设置**写回磁盘**，
     * 教师的 AI 配置与阅读进度就这样静默消失。所以这里必须说出来，并明确"先别动设置"。
     * 本层无界面依赖（依赖注入的 onStatus 就是它的状态出口），所以走 ui?.onStatus。 */
    S.appConfig = {};
    ui?.onStatus?.(`⚠ 设置文件读不出来：${String(e)}——本次按默认设置运行；先修好它，否则改设置会把原文件覆盖成默认值`);
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

/* ---------- 辅助模型（可选）：本机小模型干"短输入 + 单任务 + 输出可机检"的活 ---------- */

/**
 * 默认指向本机 oMLX 的 OpenAI 兼容端点。oMLX 需要真 Key（在 `~/.omlx/settings.json`），
 * 所以「留空 Key」这条路留给不校验 Key 的本地服务（如 Ollama，随便填个占位符也行）。
 */
export const AUX_DEFAULT_BASE_URL = 'http://127.0.0.1:8000/v1';
export const AUX_DEFAULT_MODEL = 'Ling-3.0-tiny-oQ4e';

/* 判据（`auxReady` / `auxSuitedFor` / `AUX_MAX_WORDS`）在 `src/core/aiops.ts`——
   放纯逻辑那边才能在 node 下单测，App 与管线也共用同一份。 */
export { AUX_MAX_WORDS, auxSuitedFor } from '../../src/core/aiops.js';

/** 辅助模型启用且地址/模型都填了没有 */
export function auxConfigured(): boolean {
  return auxReady(S.appConfig.aux);
}

/** 给辅助模型补的一条硬约束：实测它会先把"分析过程"吐出来（`1. **Analyze the Request:** …`） */
const AUX_NO_TALK = '只输出要求的内容本身。不要输出分析、思考过程、步骤、标题或任何解释。';

/** 按辅助模型的要求重整消息：把"别解释"并进 system，避免多一条 system 让某些服务端挑食 */
function auxMessages(messages: { role: string; content: string }[]): { role: string; content: string }[] {
  const out = messages.map((m) => ({ ...m }));
  const first = out[0];
  if (first && first.role === 'system') out[0] = { role: 'system', content: `${AUX_NO_TALK}\n\n${first.content}` };
  else out.unshift({ role: 'system', content: AUX_NO_TALK });
  return out;
}

async function auxTarget(): Promise<ProviderTarget | null> {
  if (!auxConfigured()) return null;
  const a = S.appConfig.aux!;
  let key: string;
  try {
    key = (await invoke<string>('load_api_key', { account: 'aux' })) ?? '';
  } catch {
    /* 有意兜底：辅助模型的 Key 允许没配（本地服务常常不校验）——空串照发，
       真正的鉴权失败会由下面的请求如实报出来，不在这里假装成功。 */
    key = '';
  }
  return { name: '辅助模型', baseUrl: (a.baseUrl ?? '').trim().replace(/\/+$/, ''), model: (a.model ?? '').trim(), key, index: -1 };
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
      /* 有意兜底：备用供应商的 Key 允许没配（没配就没配，不是错误）。
       * 空串交给 buildTargets，它会退回主 Key 或跳过这一路。 */
      fallbackKeys[i] = '';
    }
  }
  return buildTargets({ baseUrl: (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, ''), model: cfg.model || 'gpt-4o-mini', key }, cfg.failover, fallbackKeys);
}

/* ---------- 成本台账（每次 AI 调用一行，全落 reports_dir） ---------- */

/** 台账写失败只在本次会话提示一次（每调用一次提示一次＝谁都会去关掉的状态行） */
let costLogWarned = false;

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
      /* 有意兜底：台账还不存在＝第一次记账（`read_text_file` 对缺失文件是报错的，
       * 所以这条 catch 就是"首次"的正常路径），下面补表头。 */
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
  } catch (e) {
    /* 这张表教师平时不盯着，所以**更容易坏得无声无息**：它一坏，复盘页的"本书 AI 成本"
     * 与诊断包里的台账就少记，而"少记"和"本来就只用了这么点"在界面上长得一模一样。
     * 每次调用都提示会变噪音，所以整个会话只说一次。 */
    if (!costLogWarned) {
      costLogWarned = true;
      ui?.onStatus?.(`⚠ AI 成本台账写不上：${String(e)}——本次会话之后的用量不再记账（复盘页的成本会少记）`);
    }
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

async function chatOnce(
  t: ProviderTarget,
  messages: { role: string; content: string }[],
  maxTokens: number,
  externalSignal: AbortSignal | undefined,
  /* `bare`：只发 model/temperature/messages/max_tokens。辅助模型（本机小模型）走这条——
     实测它不认 reasoning_effort/thinking；虽然下面有"不认就重发"的兜底，但那要多一次来回。 */
  opts: { bare?: boolean } = {},
): Promise<{ content: string; usage: UsageNums }> {
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
        ...(!opts.bare && withEffort && S.appConfig.lowThinking !== false
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

/**
 * 一次 AI 请求。
 *
 * `opts.preferAux`：这条活适合辅助模型时置真（调用方负责判断"短输入 + 单任务 + 输出可机检"）。
 * 辅助模型**失败/返回空就自动回主模型**，并把这件事说在状态行上——不静默降级，
 * 也不因为"辅助模型坏了"就让教师的活干不成。
 */
export async function callChat(
  messages: { role: string; content: string }[],
  maxTokens: number,
  externalSignal?: AbortSignal,
  scene = 'AI 请求',
  opts: { preferAux?: boolean } = {},
): Promise<{ content: string; usage: string }> {
  if (opts.preferAux) {
    const aux = await auxTarget();
    if (aux) {
      const start = Date.now();
      try {
        const { content, usage } = await chatOnce(aux, auxMessages(messages), maxTokens, externalSignal, { bare: true });
        if (String(content ?? '').trim()) {
          S.lastProvider = { name: aux.name, model: aux.model };
          await logCost(`${scene}（辅助模型）`, aux, Date.now() - start, true, usage);
          return { content, usage: usageText(usage) };
        }
        /* 空内容不能当成"跑通了"：辅助模型交白卷是实测过的失效模式（2B 两段起就这样）。 */
        ui?.onStatus?.(`辅助模型返回空内容，已自动改走主模型（${scene}）`);
      } catch (e) {
        await logCost(`${scene}（辅助模型）`, aux, Date.now() - start, false, undefined, String(e).slice(0, 80));
        ui?.onStatus?.(`辅助模型不可用（${aiErrHuman(e)}），已自动改走主模型（${scene}）`);
      }
    }
  }
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
      let droppedSse = 0; // 解析失败的流片段数（心跳属正常，截断属事故，两者都要让人看得见有多少）
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
          } catch (e) {
            /* 这里以前写的是"忽略半行"，其实不准确：切出来的每一行都是完整的 SSE 行。
             * 会解析失败的只有两种——服务商的非 JSON 片段（心跳），或者**内容真被截断**。
             * 后者会让人拿到一份变短的答案而毫无察觉，所以计数并让状态行说一句。 */
            droppedSse++;
            if (droppedSse === 1) ui?.onStatus?.(`⚠ 这次回答里有流片段没能解析（${String(e).slice(0, 60)}）——若是内容被截断，回答会明显变短，重试一次`);
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
