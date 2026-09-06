/**
 * 应用状态唯一来源（Single Source of Truth）
 * 所有跨模块可变状态集中在 S 对象；UI 状态出口 setStatus / 文本转义 esc 也在此。
 */

import type { TierPlan, Suggestion, FileSession } from './types.js';

export interface AppConfig {
  baseUrl?: string;
  model?: string;
  instructions?: string;
  tiers?: Record<string, TierPlan>;
  firstRunSeen?: boolean;
  tourSeen?: boolean;
  recentFiles?: string[];
}

export interface RewriteRules {
  replacements: { from: string; to: string }[];
  viewpoint: 'keep' | 'first';
  viewpointName: string;
  extra: string;
}

export const S = {
  /** 打开的章节会话 */
  sessions: [] as FileSession[],
  activeIdx: -1,
  /** 词库状态 */
  vocabCsvText: null as string | null,
  vocabName: '',
  termsText: null as string | null,
  properRows: [] as string[],
  extraWordlistText: null as string | null,
  /** 当前会话合并已知词表（含词句卡） */
  currentKnown: new Set<string>(),
  /** 全局配置（~/.layertext.json） */
  appConfig: {} as AppConfig,
  /** AI 修订候选 */
  suggestions: [] as Suggestion[],
  /** 一键建议的会话历史（按指令调整用） */
  aiHistory: [] as { role: 'user' | 'assistant'; content: string }[],
  /** AI 助手对话 */
  chatMsgs: [] as { role: 'user' | 'assistant' | 'tool'; content: string; tool_calls?: unknown; tool_call_id?: string }[],
  chatBusy: false,
  /** 书级改写规则 */
  rewriteRules: { replacements: [], viewpoint: 'keep', viewpointName: '', extra: '' } as RewriteRules,
  draftAbort: null as AbortController | null,
  tourIdx: -1,
  demoMenuOpen: false,
  popSession: null as FileSession | null,
};

export function setStatus(msg: string, cls = ''): void {
  const el = document.getElementById('status');
  if (el) el.innerHTML = msg ? `<span class="${cls}">${esc(msg)}</span>` : '';
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
