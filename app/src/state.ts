/**
 * 应用状态唯一来源（Single Source of Truth）
 * 所有跨模块可变状态集中在 S 对象；UI 状态出口 setStatus / 文本转义 esc 也在此。
 */

import type { Suggestion, FileSession } from './types.js';

export interface AppConfig {
  baseUrl?: string;
  model?: string;
  instructions?: string;
  firstRunSeen?: boolean;
  tourSeen?: boolean;
  /** 信任模式：AI 助手可直接编辑（工作稿+日志，原稿不动） */
  trustEdit?: boolean;
  /** 标记即改写：点标记后 AI 自动改写该句并直接生效 */
  autoRewriteOnMark?: boolean;
  /** 直接修改原稿文件（首次修改前自动备份原始版）；关闭写工作稿 */
  inPlaceEdit?: boolean;
  /** 限制思考：请求带 reasoning_effort=low（服务商不识自动去除）；默认开 */
  lowThinking?: boolean;
  recentFiles?: string[];
  /** 备用供应商序列（W3 failover）：主供应商失败时按序降级；key 留空则复用主 Key */
  failover?: { name?: string; baseUrl?: string; model?: string; key?: string }[];
  /** 简化标准（无预设难度）：句长上限可调，黑名单句法一律禁用。旧配置的 tiers 字段已停用忽略 */
  simplify?: { maxLen: number };
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
  /** 已学词集/复现队列（_已学词.csv / _已学词.txt 自动加载；feature/reinforce：不计生词 + ⑩复现指标 + 简化注入约束） */
  reinforceText: null as string | null,
  reinforceName: '',
  /** 班级多人定制（折叠多选栏）：分组/个人目标与当前选择 */
  classTargets: [] as import('./pure.js').ClassTarget[],
  selectedIds: [] as string[],
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
  /** 最近一次成功请求实际使用的供应商（欠账#8：failover 切换后建议台账也要记实际那家） */
  lastProvider: null as { name: string; model: string } | null,
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
