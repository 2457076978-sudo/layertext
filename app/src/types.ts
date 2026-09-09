/** 审校工作台数据模型（照原型 AF审校阅读器_v0.1 的标记 schema，定位方式改为确定性索引） */

import type { QcResult } from '../../src/core/qc.js';

export type WordMarkType = 'simpl' | 'zh' | 'oov' | 'hard' | 'factw' | 'goodw' | 'anchor' | 'otherw';
export type SentMarkType = 'syntax' | 'long' | 'ref' | 'cohesion' | 'fact' | 'stiff' | 'cut' | 'goods' | 'others';
export type MarkType = WordMarkType | SentMarkType;
/** 标记粒度三级（选区即范围）：word=点词 / phrase=拖选短语（下划线，类型色沿用词级色板）/ sent=整句 */
export type MarkLevel = 'word' | 'phrase' | 'sent';

export interface Mark {
  id: string;
  level: MarkLevel;
  /** 定位：段落索引 / 句索引 / 词索引（词级与短语级起始词）——不随文本大小写或重复句漂移 */
  pi: number;
  si: number;
  wi?: number;
  /** 短语级：覆盖的词数（word 级恒 1；渲染下划线与 remap 用） */
  wl?: number;
  /** 显示用：词面 / 短语文本 / 句子前缀（同时做轻量校验：若当前句与 text 前缀不符，清单里提示"待复核"） */
  word?: string;
  text?: string;
  type: MarkType;
  note?: string;
  ts: number;
}

export interface QuotaItem {
  text: string;
  done: boolean;
}

/** 段落书签：双击段号收藏，随 _审校标记.json 落盘（text=段首句前缀，预览与漂移校验用） */
export interface ParaBookmark {
  pi: number;
  text: string;
  ts: number;
}

export interface ReviewState {
  file: string;
  marks: Mark[];
  quota: QuotaItem[];
  gate: Record<string, boolean>;
  bookmarks: ParaBookmark[];
  updatedAt: number;
}

export interface FileSession {
  md: string;
  fileName: string;
  sourcePath: string | null; // null = 示例模式
  markPath: string; // 审校标记自动落盘路径
  review: ReviewState;
  report: QcResult | null;
  reportSavedPath: string | null;
  dirty: boolean; // 有未落盘的标记变更（防抖中）
  /* UX 补齐（2026-09-08）：文件级撤销栈 + 滚动位置记忆 */
  undoStack?: string[];
  redoStack?: string[];
  scrollTop?: number;
}

export const GATES = ['事实核对', '情节要点齐全', '段落对齐', 'QC 指标达标'] as const;

/** 终审门禁各项的一句话说明（？点击查看） */
export const GATE_HELP: Record<string, string> = {
  事实核对: '人名、事件、数字、时间线与原著（或史实）一致，无改编失真。',
  情节要点齐全: '本章应保留的情节点与伏笔都在——对照上方"要点配额"逐项核对。',
  段落对齐: '简化版段落与原文段落一一对应，无漏段、无并段丢失信息。',
  'QC 指标达标': '自动质检的各项指标达到简化标准（句长上限可调；点击查看本章实际数字与参考值的核对表）。',
};

/** 简化标准的默认句长上限（词/句）。难度由教师词库锚定，不预设 B/M/A 层级；
 *  需要更简版本：把简化结果再导入、再简化一遍（迭代深化）。 */
export const DEFAULT_MAX_LEN = 16;

export const WORD_TYPES: { key: WordMarkType; label: string; badge: string; cls: string }[] = [
  { key: 'simpl', label: '词汇简化', badge: '简', cls: 'mk-simpl' },
  { key: 'zh', label: '加中文标注', badge: '注', cls: 'mk-zh' },
  { key: 'oov', label: '超纲', badge: '纲', cls: 'mk-oov' },
  { key: 'hard', label: '太难', badge: '难', cls: 'mk-hard' },
  { key: 'factw', label: '事实用词存疑', badge: '疑', cls: 'mk-factw' },
  { key: 'goodw', label: '好词保留', badge: '留', cls: 'mk-goodw' },
  { key: 'anchor', label: '复现锚点', badge: '复', cls: 'mk-anchor' },
  { key: 'otherw', label: '其他问题', badge: '他', cls: 'mk-otherw' },
];

export const SENT_TYPES: { key: SentMarkType; label: string; badge: string }[] = [
  { key: 'syntax', label: '语法太难', badge: '法' },
  { key: 'long', label: '句太长', badge: '长' },
  { key: 'ref', label: '指代不清', badge: '代' },
  { key: 'cohesion', label: '衔接断裂', badge: '接' },
  { key: 'fact', label: '事实逻辑疑', badge: '实' },
  { key: 'stiff', label: '表达生硬', badge: '硬' },
  { key: 'cut', label: '建议删', badge: '删' },
  { key: 'goods', label: '好句锚点', badge: '锚' },
  { key: 'others', label: '其他问题', badge: '他' },
];

export function typeLabel(t: MarkType): string {
  return [...WORD_TYPES, ...SENT_TYPES].find((x) => x.key === t)?.label ?? t;
}

export function typeBadge(t: MarkType): string {
  return [...WORD_TYPES, ...SENT_TYPES].find((x) => x.key === t)?.badge ?? '?';
}

export function newReviewState(fileName: string): ReviewState {
  return { file: fileName, marks: [], quota: [], gate: {}, bookmarks: [], updatedAt: 0 };
}

export function newMarkId(): string {
  return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** AI 修订建议（AI 只出候选；check 为本地 QC 引擎对建议句的机器复核） */
export interface Suggestion {
  markId: string;
  type: string;
  original: string;
  revised: string;
  basis: string;
  alternative?: string;
  check: { passive: boolean; relcl: boolean; pastperf: boolean; overlong: boolean };
  /** 行内定位（正文唯一匹配到 original 时填，用于左栏直接对照） */
  pi?: number;
  si?: number;
  status?: 'pending' | 'accepted' | 'rejected';
}

/** 变更日志 CSV 表头（与原型审计 schema 一致） */
export const CHANGELOG_HEADER = ['轮次', '日期', '版本', '章', '位置', '修改前', '修改后', '规则号', '依据/理由', '详单来源'];
