/**
 * 本周复现清单（功能四项 · 项 3，2026-09-19）：FSRS 调度 → 教师端清单 → 复现词优先入题。
 *
 * 数据流：生词卡导出已把 `复现队列_日期.csv`（词,hits）写进书目录——本模块读**字典序最新**
 * 一份（bookscan latestPerTier 同思想），喂 `core/fsrs.ts` 的 `weeklyDue`（唯一 FSRS 实现，
 * 本模块零复算），得到"本周到期词"。
 *
 * 边界（规划定案 3）：**教师端 only**——只有清单与出题选词，没有任何学生端或通知类功能；
 * 并行试点口径不变——FSRS 建议与现行固定隔 2 篇两列并排给教师，FSRS 列标"试点参考"。
 */

import { invoke } from '@tauri-apps/api/core';
import { weeklyDue, type FsrsWordInput, type WeeklyDueRow } from '../../src/core/fsrs.js';
import { readTextChecked } from './fsx.js';

const escHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** 复现队列 CSV 解析（宽容口径与 CLI fsrs 同款：CSV/TSV 首列=词、次列=hits（缺省 0）；# 注释跳过） */
export function parseReinforceCsv(text: string): Array<{ word: string; hits: number }> {
  const out: Array<{ word: string; hits: number }> = [];
  for (const line of String(text ?? '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l.startsWith('#')) continue;
    const [w, h] = l.split(/[,;\t]/);
    const word = (w ?? '').trim().toLowerCase();
    if (!word) continue;
    const hits = Number((h ?? '0').trim());
    out.push({ word, hits: Number.isFinite(hits) && hits > 0 ? Math.floor(hits) : 0 });
  }
  return out;
}

/** 多个 `复现队列_*.csv` 文件名 → 字典序最新（日期后缀约定下=最新一次导出） */
export function latestReinforceFile(names: string[]): string | null {
  const hits = names.filter((n) => /^复现队列_.*\.csv$/i.test(n)).sort();
  return hits.at(-1) ?? null;
}

export interface WeeklyQueue {
  queuePath: string | null;
  /** 全队列词（保序去重） */
  queue: string[];
  /** 本周到期行（到期早在前） */
  due: WeeklyDueRow[];
}

/** 读书目录里最新一份复现队列 → 本周到期（无文件=queuePath:null，不是空清单）。 */
export async function loadWeeklyQueue(bookDir: string | null, opts: { today?: Date; horizonDays?: number } = {}): Promise<WeeklyQueue> {
  if (!bookDir) return { queuePath: null, queue: [], due: [] };
  let names: string[];
  try {
    names = (await invoke<string[]>('list_dir', { dir: bookDir })).map((p) => p.slice(p.lastIndexOf('/') + 1));
  } catch {
    /* 有意兜底：目录列不出来（示例会话没有书目录/权限不在）→ 按无队列处理，
     * 卡片给"去导出生词卡"引导——这是正常路径不是错误；真读坏文件由 readTextChecked 分支点名 */
    return { queuePath: null, queue: [], due: [] };
  }
  const latest = latestReinforceFile(names);
  if (!latest) return { queuePath: null, queue: [], due: [] };
  const path = `${bookDir}/${latest}`;
  const r = await readTextChecked(path);
  if (r.kind !== 'ok') return { queuePath: null, queue: [], due: [] };
  const rows = parseReinforceCsv(r.text);
  const seen = new Set<string>();
  const items: FsrsWordInput[] = [];
  for (const { word, hits } of rows) {
    if (seen.has(word)) continue;
    seen.add(word);
    items.push({ word, hits });
  }
  return { queuePath: path, queue: [...seen], due: weeklyDue(items, opts) };
}

/** 出题选词（3b）：到期词优先且带标注、不足补队列前 N；无队列返回 null（调用方走既有回退） */
export function pickQuizWords(due: WeeklyDueRow[], queue: string[], cap = 30): { words: string; dueCount: number } | null {
  const dueWords = due.slice(0, cap).map((r) => `${r.word}（本周到期，优先入题）`);
  const dueSet = new Set(due.map((r) => r.word));
  const fill = queue.filter((w) => !dueSet.has(w)).slice(0, Math.max(0, cap - dueWords.length));
  return { words: [...dueWords, ...fill].join(', '), dueCount: Math.min(due.length, cap) };
}

/** 数据面板「本周复现清单」卡（3c）：无队列给"去导出生词卡"引导而非报错。 */
export function weeklyCardHtml(w: WeeklyQueue | null, running: boolean): string {
  const head = `<div class="dp-card"><b>本周复现清单</b>（FSRS 试点参考 × 现行固定隔 2 篇并排）`;
  if (running) return `${head}<br><span class="dim">读取复现队列中…</span></div>`;
  if (!w || !w.queuePath)
    return `${head}<br><span class="dim">这本书还没有 复现队列_*.csv——在章内「导出生词卡」会顺带写出（词,hits）。</span><br><button id="dp-weekly-run" style="font-size:var(--fs-xs);padding:2px 8px">读取本周清单</button></div>`;
  if (w.due.length === 0)
    return `${head}<br><span class="dim">队列 ${w.queue.length} 词（<code>${escHtml(w.queuePath.slice(w.queuePath.lastIndexOf('/') + 1))}</code>），本周没有到期词——下周再看。</span><br><button id="dp-weekly-run" style="font-size:var(--fs-xs);padding:2px 8px">重新读取</button></div>`;
  const rows = w.due
    .slice(0, 30)
    .map(
      (r) =>
        `<div class="dp-ld-chip" title="已复现 ${r.hits} 次；FSRS 建议隔 ${r.nextPieces} 篇（试点参考），现行固定隔 ${r.currentPieces} 篇">${escHtml(r.word)}<b>${escHtml(r.dueDay.slice(5))}</b></div>`,
    )
    .join('');
  return `${head}<br>
    <span><b>${w.due.length} 词本周到期</b>（已按到期排序——读后检测题的词汇题将优先用它们）</span><br>
    <span class="dp-ld-chips">${rows}</span><br>
    <span class="dim" style="font-size:var(--fs-xs)">队列 ${w.queue.length} 词 · <code>${escHtml(w.queuePath.slice(w.queuePath.lastIndexOf('/') + 1))}</code> · 出题入口在章节的「读后检测题」</span><br>
    <button id="dp-weekly-run" style="font-size:var(--fs-xs);padding:2px 8px">重新读取</button>
  </div>`;
}
