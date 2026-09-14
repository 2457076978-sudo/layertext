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
  /** 备用供应商序列（W3 failover）：主供应商失败时按序降级；key 留空则复用主 Key。
   *  `id`：**稳定标识**（2026-09-14 加）。Key 存在钥匙串里，账号名原先用**行下标**
   *  （`fb0`/`fb1`…）——删掉一行，剩下的行就会读到**被删那家的 Key**，鉴权失败，
   *  而报错文案还会让教师去怀疑自己填的 Key。现在账号用 `fb:<id>`，并保留旧下标的回落。 */
  failover?: { id?: string; name?: string; baseUrl?: string; model?: string; key?: string }[];
  /** 简化标准（无预设难度）：句长上限可调，黑名单句法一律禁用。旧配置的 tiers 字段已停用忽略 */
  simplify?: { maxLen: number };
  /* UX 补齐：阅读字号 + 上次会话恢复（书架"继续上次编辑"） */
  readerFont?: number;
  lastSession?: { bookDir?: string; book名?: string; workspace?: string; files: { path: string; scroll: number }[]; activeIdx: number; savedAt: string } | null;
  /* 阅读体验：主题（白/灰/深色）+ 行距档位（默认 2.1） */
  theme?: 'light' | 'gray' | 'dark';
  lineHeight?: number;
  /* 书架：视图（网格/列表，Feature Parity——两种视图下搜索/分组同样生效） */
  shelfView?: 'grid' | 'list';
  /* 每本书的阅读进度：chapters=打开过的章节绝对路径（去重），total=全书章节总数 */
  progress?: Record<string, { chapters: string[]; total?: number; lastChapter?: string; lastAt?: string }>;
}

export interface RewriteRules {
  replacements: { from: string; to: string }[];
  viewpoint: 'keep' | 'first';
  viewpointName: string;
  extra: string;
}

/** 全局（非本书）AI 附加约定：由 AI 设置面板写入 `~/.layertext.json`，不属于任何一本书。
 *  `_本书配置.json` 也会带一份 `instructions`，打开一本书会临时把它覆盖成本书的；
 *  而"下一本书没有这一项"时必须能**退回全局值**，否则上一本书的约定会留在下一本书上。
 *  放在 state.ts（而不是 bookio.ts）：settings.ts 要能写它，而 settings → bookio 会成环。 */
let globalInstructions: string | undefined;
let globalCaptured = false;
/** 打开任何一本书之前先记下当时的全局值（只在第一次生效）。 */
export function rememberGlobalInstructions(): void {
  if (!globalCaptured) {
    globalInstructions = S.appConfig.instructions;
    globalCaptured = true;
  }
}
/** AI 设置面板保存时调用：全局值变了。 */
export function setGlobalInstructions(v: string): void {
  globalInstructions = v;
  globalCaptured = true;
}
/** 打开一本书时用它把 `instructions` 退回全局值（本书没带这一项时）。 */
export function globalInstructionsValue(): string | undefined {
  return globalInstructions;
}
export function globalInstructionsCaptured(): boolean {
  return globalCaptured;
}

export const S = {
  /** 打开的章节会话 */
  sessions: [] as FileSession[],
  activeIdx: -1,
  /** **解析坏了、读不进来的**标记文件路径（2026-09-14）。
   *  存在的理由：`main.ts` 打开章节时原先把"文件不存在"和"JSON 损坏"共用一个 catch，
   *  损坏的 `_审校标记.json` 被当成空清单打开，教师接着标记、下次保存整体覆盖，整章标记全丢。
   *  现在损坏会当场报出来并进这个集合，保存时**跳过**它——宁可这一次存不下，也不覆盖教师的数据。 */
  markFileBroken: new Set<string>(),
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
  classTargets: [] as import('./bookpure.js').ClassTarget[],
  selectedIds: [] as string[],
  /** 工作区（书目录 _工作区.json，像浏览器标签按版本切换；各工作区可绑定班级定制目标） */
  workspaces: [] as import('./bookpure.js').Workspace[],
  activeWorkspace: null as string | null,
  /** 当前书的根目录（进度记账用；openBook/resume 设置，回书架清空） */
  currentBookDir: null as string | null,
  /** 书架会话态：搜索词 + 分组过滤（视图切换持久化在 appConfig.shelfView） */
  shelfQ: '',
  shelfGroup: null as string | null,
  /** 逐句对照的基准版本（会话级：切章保留选择自动重对齐） */
  alignBase: null as { name: string; md: string; path: string | null } | null,
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
