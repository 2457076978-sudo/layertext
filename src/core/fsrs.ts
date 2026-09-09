/**
 * FSRS 间隔重复调度（并行试点）：open-spaced-repetition/ts-fsrs（MIT）薄封装。
 * 现行复现策略=固定隔 2 篇（Nakata 2015 等距依据）——FSRS 不替换它，只并排给出
 * "按记忆曲线算，该词下次该隔几篇"的对照建议；一学期限定班 A/B 后再定切换（Wayne 09-09 拍板）。
 * 单位换算：FSRS 输出天；复现体系单位是"篇"（1 篇 ≈ daysPerPiece 天，晚读节奏默认 3 天/篇）。
 */

import { createEmptyCard, fsrs, generatorParameters, Rating } from 'ts-fsrs';

export interface FsrsOptions {
  /** 每次命中记的复习评级（默认 Good=记得住） */
  rating: Exclude<Rating, Rating.Manual>;
  /** 单位换算：1 篇 ≈ N 天（晚读节奏默认 3） */
  daysPerPiece: number;
  /** 现行策略：固定隔 N 篇（Nakata 2015 等距依据） */
  currentPolicyPieces: number;
}

export const FSRS_DEFAULTS: FsrsOptions = { rating: Rating.Good, daysPerPiece: 3, currentPolicyPieces: 2 };

export interface FsrsWordInput {
  /** 词（或词形家族代表词） */
  word: string;
  /** 已复现（命中）次数——每次命中记一次复习 */
  hits: number;
}

export interface FsrsRow {
  word: string;
  hits: number;
  /** FSRS 建议的下次间隔（天） */
  nextDays: number;
  /** FSRS 建议的下次间隔（篇，向上取整、至少 1） */
  nextPieces: number;
  /** 现行策略间隔（固定隔 N 篇） */
  currentPieces: number;
}

/** 模拟一个词：空卡起，连续 hits 次 rating 复习 → 返回下次应复习的天数 */
function nextDaysAfter(hits: number, rating: Exclude<Rating, Rating.Manual>): number {
  const f = fsrs(generatorParameters());
  let card = createEmptyCard(new Date('2026-09-01T00:00:00Z'));
  for (let i = 0; i < Math.max(0, hits); i++) {
    const day = new Date(card.last_review ?? card.due);
    day.setDate(day.getDate() + Math.max(1, i + 1)); // 复习事件按序推进（间隔不影响下次建议的计算骨架）
    card = f.repeat(card, day)[rating].card;
  }
  return Math.max(1, Math.round(card.elapsed_days + (card.scheduled_days || 1)));
}

/** 批量规划：每词输出 FSRS 建议 vs 现行固定策略并排（纯计算、零网络、可单测） */
export function planFsrs(items: FsrsWordInput[], opts: Partial<FsrsOptions> = {}): FsrsRow[] {
  const o = { ...FSRS_DEFAULTS, ...opts };
  return items.map(({ word, hits }) => {
    const days = nextDaysAfter(hits, o.rating);
    return {
      word,
      hits,
      nextDays: days,
      nextPieces: Math.max(1, Math.ceil(days / o.daysPerPiece)),
      currentPieces: o.currentPolicyPieces,
    };
  });
}

/** 汇总：平均建议间隔 vs 现行，差异词数（建议≠现行的词）——回写脚本/报告头部用 */
export function summarizeFsrs(rows: FsrsRow[]): { avgPieces: number; currentPieces: number; differCount: number; total: number } {
  if (!rows.length) return { avgPieces: 0, currentPieces: 0, differCount: 0, total: 0 };
  return {
    avgPieces: Math.round((rows.reduce((n, r) => n + r.nextPieces, 0) / rows.length) * 10) / 10,
    currentPieces: rows[0]!.currentPieces,
    differCount: rows.filter((r) => r.nextPieces !== r.currentPieces).length,
    total: rows.length,
  };
}
