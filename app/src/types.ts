/** 审校工作台数据模型（照原型 AF审校阅读器_v0.1 的标记 schema，定位方式改为确定性索引） */

import type { QcResult } from '../../src/core/qc.js';

export type WordMarkType = 'simpl' | 'zh' | 'oov' | 'hard' | 'factw' | 'goodw' | 'otherw';
export type SentMarkType = 'syntax' | 'long' | 'ref' | 'fact' | 'stiff' | 'cut' | 'goods' | 'others';
export type MarkType = WordMarkType | SentMarkType;

export interface Mark {
  id: string;
  level: 'word' | 'sent';
  /** 定位：段落索引 / 句索引 / 词索引（词级才有）——不随文本大小写或重复句漂移 */
  pi: number;
  si: number;
  wi?: number;
  /** 显示用：词面 / 句子前缀（同时做轻量校验：若当前句与 text 前缀不符，清单里提示"待复核"） */
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

export interface ReviewState {
  file: string;
  marks: Mark[];
  quota: QuotaItem[];
  gate: Record<string, boolean>;
  updatedAt: number;
}

export interface FileSession {
  md: string;
  fileName: string;
  sourcePath: string | null; // null = 示例模式
  markPath: string;          // 审校标记自动落盘路径
  review: ReviewState;
  report: QcResult | null;
  reportSavedPath: string | null;
  dirty: boolean;            // 有未落盘的标记变更（防抖中）
}

export const GATES = ['事实核对', '情节要点齐全', '段落对齐', 'QC 指标达标'] as const;

/** 终审门禁各项的一句话说明（？点击查看） */
export const GATE_HELP: Record<string, string> = {
  事实核对: '人名、事件、数字、时间线与原著（或史实）一致，无改编失真。',
  情节要点齐全: '本章应保留的情节点与伏笔都在——对照上方"要点配额"逐项核对。',
  段落对齐: '简化版段落与原文段落一一对应，无漏段、无并段丢失信息。',
  'QC 指标达标': '自动质检的各项指标达到本层级参考标准（点击查看本章实际数字与参考值的核对表）。',
};

/** 各层级句长参考上限（词/句），源自原型项目三层设计 */
export const TIER_MAX_LEN: Record<string, number> = { B: 14, M: 16, A: 20 };

export const WORD_TYPES: { key: WordMarkType; label: string; badge: string; cls: string }[] = [
  { key: 'simpl', label: '词汇简化', badge: '简', cls: 'mk-simpl' },
  { key: 'zh', label: '加中文标注', badge: '注', cls: 'mk-zh' },
  { key: 'oov', label: '超纲', badge: '纲', cls: 'mk-oov' },
  { key: 'hard', label: '太难', badge: '难', cls: 'mk-hard' },
  { key: 'factw', label: '事实用词存疑', badge: '疑', cls: 'mk-factw' },
  { key: 'goodw', label: '好词保留', badge: '留', cls: 'mk-goodw' },
  { key: 'otherw', label: '其他问题', badge: '他', cls: 'mk-otherw' },
];

export const SENT_TYPES: { key: SentMarkType; label: string; badge: string }[] = [
  { key: 'syntax', label: '语法太难', badge: '法' },
  { key: 'long', label: '句太长', badge: '长' },
  { key: 'ref', label: '指代不清', badge: '代' },
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
  return { file: fileName, marks: [], quota: [], gate: {}, updatedAt: 0 };
}

export function newMarkId(): string {
  return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
