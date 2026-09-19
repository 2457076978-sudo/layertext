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

/* ── 本周到期（功能四项 · 项 3，2026-09-19）──────────────────────────────────
 * 口径不变（并行试点定案）：FSRS 只给建议、不切换现行固定隔 2 篇——weeklyDue 输出的
 * 行同时带 nextPieces（FSRS 建议）与 currentPieces（现行），教师端两列并排。
 * 到期判定沿用 hits-only 模型：FSRS 建议的下次间隔 nextDays 天 ≤ 窗口 horizonDays 即
 * 「本周到期」（空卡=首次复习，自然在窗内）；无真实复习时间戳——这是既有设计，
 * 不在本项里引入打卡/复习日志（教师端 only 边界）。 */

export interface WeeklyDueOptions extends Partial<FsrsOptions> {
  /** 窗口起点（默认今天）；测试传固定日期保证确定性 */
  today?: Date;
  /** 窗口天数（默认 7） */
  horizonDays?: number;
}

export interface WeeklyDueRow extends FsrsRow {
  /** 到期日（ISO 日期，today + nextDays） */
  dueDay: string;
}

/** 本周到期词：FSRS 建议间隔 ≤ 窗口的词，到期早在前（同日按字母序）。 */
export function weeklyDue(items: FsrsWordInput[], opts: WeeklyDueOptions = {}): WeeklyDueRow[] {
  const { today = new Date(), horizonDays = 7, ...fsrsOpts } = opts;
  return planFsrs(items, fsrsOpts)
    .filter((r) => r.nextDays <= horizonDays)
    .sort((a, b) => a.nextDays - b.nextDays || a.word.localeCompare(b.word))
    .map((r) => {
      const d = new Date(today);
      d.setDate(d.getDate() + r.nextDays);
      return { ...r, dueDay: d.toISOString().slice(0, 10) };
    });
}
