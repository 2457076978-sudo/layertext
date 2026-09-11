// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，本仓库已部署版权验证体系，细节不予公开（docs/版权与授权.md）。
/**
 * LayerText · 统一词典的增量合并（并发安全）
 *
 * 审查报告 §三 点名的第一条规模崩点：「第二本书、第二位教师或同一书多层并行时，
 * 输出路径、**会话日志、统一词典**和标记文件可能互相覆盖」。
 *
 * 统一词典是这些文件里**唯一一个被所有运行共享且会被写**的：
 *   · 会话脚本在「查词」时给新词配释义，跑完 `appendDict` 一次；
 *   · 而 `appendDict` 是「读整份 CSV → 合并 → 写回整份 CSV」——两个进程同时跑，
 *     后写的会把先写的整份覆盖掉（lost update）。表现是"明明配过的词下次又问一遍"，
 *     而且**不会报任何错**。
 *
 * 改法（与事件日志同一套路：不可变增量 + 可重建视图）：
 *   ① 每个运行只往自己的私有目录写 `词典增量.json`（append-only、不共享、不可能撞）；
 *   ② 合并是**显式的一步**：读基线词典 + 全部增量 → 确定性合并 → 原子替换（临时文件 + rename）；
 *   ③ 合并不是覆盖：基线的释义优先（它是教师审过的正本），增量之间**冲突要报出来**，不静默择一。
 *
 * 本模块是纯逻辑（解析/合并/渲染）。读写与加锁由调用方负责。
 */

export interface DictEntry {
  word: string;
  zh: string;
  /** 来源（教师知识库 / 归一（多数票）/ 新配 …）：进 CSV 第三列，人要看得出这条是谁定的 */
  source: string;
}

/** 解析统一词典 CSV（首列词、次列释义、三列来源；容忍 BOM、空行、坏行） */
export function parseDictCsv(text: string): DictEntry[] {
  const out: DictEntry[] = [];
  for (const line of String(text).replace(/^\uFEFF/, '').split('\n')) {
    if (!line.trim()) continue;
    const cells = line.split(',');
    const w = cells[0]?.trim();
    if (!w || w === '词') continue; // 表头
    const zh = (cells[1] ?? '').trim();
    if (!zh) continue;
    out.push({ word: w.toLowerCase(), zh, source: (cells[2] ?? '').trim() });
  }
  return out;
}

/** 渲染成 CSV（BOM + 表头 + 按词排序，保证同内容同字节——便于比对与版本化） */
export function toDictCsv(entries: DictEntry[]): string {
  const rows = ['词,释义,来源'];
  for (const e of [...entries].sort((a, b) => (a.word < b.word ? -1 : a.word > b.word ? 1 : 0))) {
    rows.push(`${e.word},${e.zh},${e.source}`);
  }
  return '\uFEFF' + rows.join('\n') + '\n';
}

export interface DictDelta {
  /** 增量来自哪个运行（冲突时人要知道找谁） */
  origin: string;
  entries: DictEntry[];
}

export interface DictConflict {
  word: string;
  /** 保留的释义（基线的） */
  kept: string;
  /** 被丢弃的释义 */
  dropped: string;
  /** 谁提供的 */
  origins: string[];
}

export interface MergeResult {
  entries: DictEntry[];
  /** 新增词数（基线里没有的） */
  added: number;
  /** 与基线一致的增量条数（无变化） */
  unchanged: number;
  /** 冲突：基线已有这个词，但增量给了不同释义——**不静默择一** */
  conflicts: DictConflict[];
  /** 增量之间互相冲突（基线没有这个词，两个运行给了不同释义） */
  interConflicts: DictConflict[];
}

/**
 * 确定性合并：基线优先，其次按增量来源名排序。
 *
 * 为什么基线优先而不是"后写覆盖"：
 *   基线词典是教师审过的正本（教师知识库 > 归一多数票）。一次自动新配的释义
 *   不该覆盖教师定过的释义——这正是"任何入库都要人工确认"的同一原则。
 */
export function mergeDict(base: DictEntry[], deltas: DictDelta[]): MergeResult {
  const map = new Map<string, DictEntry>();
  for (const e of base) if (!map.has(e.word)) map.set(e.word, e);
  // 基线单独留一张表：要区分"与教师定过的释义冲突"（基线冲突，基线赢）与
  // "两个并列运行各配了一个不同释义"（增量互冲突，得人来定）——两者处置不同，不能混。
  const inBase = new Set(map.keys());
  let added = 0;
  let unchanged = 0;
  const conflicts: DictConflict[] = [];
  const seenInDelta = new Map<string, { zh: string; origin: string }>();
  const interConflicts: DictConflict[] = [];

  const sorted = [...deltas].sort((a, b) => (a.origin < b.origin ? -1 : 1));
  for (const d of sorted) {
    for (const e of d.entries) {
      if (inBase.has(e.word)) {
        const cur = map.get(e.word)!;
        if (cur.zh === e.zh) unchanged++;
        else conflicts.push({ word: e.word, kept: cur.zh, dropped: e.zh, origins: [d.origin, cur.source || '基线'] });
        continue;
      }
      const prev = seenInDelta.get(e.word);
      if (prev === undefined) {
        seenInDelta.set(e.word, { zh: e.zh, origin: d.origin });
        map.set(e.word, e);
        added++;
        continue;
      }
      if (prev.zh === e.zh) unchanged++;
      else interConflicts.push({ word: e.word, kept: prev.zh, dropped: e.zh, origins: [prev.origin, d.origin] });
    }
  }
  return { entries: [...map.values()], added, unchanged, conflicts, interConflicts };
}

/** 合并报告（人看的一行行），供脚本打印与写进运行清单 */
export function describeMerge(r: MergeResult): string[] {
  const out = [`词典合并：新增 ${r.added} 条，无变化 ${r.unchanged} 条`];
  if (r.conflicts.length) {
    out.push(`⚠ ${r.conflicts.length} 条与基线冲突（**保留基线释义**，未覆盖教师定过的释义）：`);
    for (const c of r.conflicts.slice(0, 10)) out.push(`   ${c.word}：保留「${c.kept}」，忽略「${c.dropped}」（来自 ${c.origins[0]}）`);
  }
  if (r.interConflicts.length) {
    out.push(`⚠ ${r.interConflicts.length} 条在增量之间互相冲突（并列运行给的释义不同，需要人定）：`);
    for (const c of r.interConflicts.slice(0, 10)) out.push(`   ${c.word}：「${c.kept}」(${c.origins[0]}) vs 「${c.dropped}」(${c.origins[1]})`);
  }
  return out;
}

/* ────────────────────── 锁（防止两个合并同时做原子替换） ────────────────────── */

export interface LockInfo {
  pid: number;
  host: string;
  at: string;
}

/** 锁是否还能用：持有者进程还在 → 占用中；超过 staleMs → 视为陈旧可夺（进程崩了不会永远锁住） */
export function lockState(info: LockInfo | null, now: number, isAlive: (pid: number) => boolean, staleMs = 10 * 60 * 1000): 'free' | 'held' | 'stale' {
  if (!info) return 'free';
  const at = Date.parse(info.at);
  if (!Number.isFinite(at) || now - at > staleMs) return 'stale';
  return isAlive(info.pid) ? 'held' : 'stale';
}
