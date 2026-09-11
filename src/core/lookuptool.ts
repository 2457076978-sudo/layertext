// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，本仓库已部署版权验证体系，细节不予公开（docs/版权与授权.md）。
/**
 * LayerText · 「查词」工具（严格 schema 的 tool call）
 *
 * 审查报告 §二 的原话：「『查词』目前是文本标记往返，应改为严格 schema 的 tool call。」
 *
 * 为什么文本标记往返不够好：
 *   · 模型要在**正文之外**再写一行 `【查 词1 词2 …】`，于是它天然会污染正文
 *     （实测就得写个 stripLookup 去捞它），也天然会和"纯英文、不要任何解释"的格式要求打架；
 *   · 参数没有 schema：词数没有上限、可能夹进中文、可能夹进句子甚至整段；
 *   · 模型问错了，唯一能做的就是把它当正文一部分去猜。
 *
 * 工具调用是结构化协议：参数是 JSON，可以**严格校验**，错了能明确回一句"参数不合规，
 * 请重发"，而不是去猜一段自然语言。本模块只放 schema 与校验（纯函数、可单测）；
 * 真正的问答在管线脚本里（它才拿得到词典与知识库）。
 */

/** 一次最多问几个词（原来靠提示词里的"一次最多问 8 个词"软约束，现在是 schema 硬约束） */
export const LOOKUP_MAX_WORDS = 8;
/** 单词形态：字母起首，可含撇号与连字符（与词库/分词口径一致） */
const WORD_RE = /^[A-Za-z][A-Za-z'-]{0,40}$/;

/** OpenAI/DeepSeek 兼容的 function 定义。直接喂给 `tools` 字段。 */
export const LOOKUP_TOOL = {
  type: 'function',
  function: {
    name: 'lookup_words',
    description:
      '查这些英文单词在学生词汇表里的状态。返回每个词是「已收录（学生学过，不要加注）」' +
      '还是「释义：xxx（按这个释义加注）」。不确定的词就问，不要猜。',
    parameters: {
      type: 'object',
      properties: {
        words: {
          type: 'array',
          items: { type: 'string' },
          maxItems: LOOKUP_MAX_WORDS,
          description: `要查的英文单词，最多 ${LOOKUP_MAX_WORDS} 个。只写单词本身，不要写句子、释义或中文。`,
        },
      },
      required: ['words'],
      additionalProperties: false,
    },
  },
} as const;

export type LookupParseResult =
  | { ok: true; words: string[] }
  | { ok: false; error: string };

/**
 * 严格校验一次「查词」调用的参数。**不合规就报错让模型重发**，绝不去猜。
 * 这是"严格 schema"的实质：宽松解析等于把文本标记往返的问题换个地方重演。
 */
export function parseLookupArgs(args: unknown): LookupParseResult {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, error: '参数必须是对象 {"words": [...]}' };
  }
  const o = args as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => k !== 'words');
  if (extra.length) return { ok: false, error: `出现未定义的参数：${extra.join('、')}（本工具只接受 words）` };
  const raw = o.words;
  if (!Array.isArray(raw)) return { ok: false, error: 'words 必须是字符串数组' };
  if (!raw.length) return { ok: false, error: 'words 不能为空数组' };
  if (raw.length > LOOKUP_MAX_WORDS) {
    return { ok: false, error: `一次最多查 ${LOOKUP_MAX_WORDS} 个词，你给了 ${raw.length} 个，请分批` };
  }
  const words: string[] = [];
  for (const w of raw) {
    if (typeof w !== 'string') return { ok: false, error: `words 里有非字符串项：${JSON.stringify(w)}` };
    const t = w.trim();
    if (!WORD_RE.test(t)) {
      return { ok: false, error: `「${t}」不是单个英文单词（只写词本身，不要句子/中文/标点）` };
    }
    words.push(t.toLowerCase());
  }
  return { ok: true, words: [...new Set(words)] };
}

/** 从一次模型响应的 tool_calls 里取出「查词」调用（可能有多个，按顺序合并、去重、截断到上限） */
export interface ToolCallLike {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string | Record<string, unknown> };
}

export function collectLookups(toolCalls: ToolCallLike[] | undefined): { words: string[]; ids: string[]; errors: string[] } {
  const words: string[] = [];
  const ids: string[] = [];
  const errors: string[] = [];
  for (const tc of toolCalls ?? []) {
    if (tc?.function?.name !== 'lookup_words') continue;
    const raw = tc.function.arguments;
    let args: unknown = raw;
    if (typeof raw === 'string') {
      try {
        args = JSON.parse(raw);
      } catch {
        errors.push(`lookup_words 的参数不是合法 JSON：${raw.slice(0, 80)}`);
        continue;
      }
    }
    const r = parseLookupArgs(args);
    if (!r.ok) {
      errors.push(r.error);
      continue;
    }
    if (tc.id) ids.push(tc.id);
    for (const w of r.words) if (!words.includes(w)) words.push(w);
  }
  return { words: words.slice(0, LOOKUP_MAX_WORDS), ids, errors };
}

/** 问答结果的回灌文本：每个词一行，状态明确（「已收录」还是「释义：…」） */
export function formatLookupAnswer(entries: { word: string; known: boolean; zh?: string; source?: string }[]): string {
  if (!entries.length) return '（没有需要查的词）';
  return entries
    .map((e) => {
      if (e.known) return `${e.word}：已收录（学生学过）→ 不要加注`;
      if (!e.zh) return `${e.word}：查不到统一释义，请按你的判断配一个 2-6 字释义并加注`;
      return `${e.word}：释义「${e.zh}」${e.source ? `（${e.source}）` : ''}→ 按这个释义加注`;
    })
    .join('\n');
}
