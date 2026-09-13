/**
 * 校准台账 · App 侧接线
 *
 * ## 它修的是什么
 *
 * 2026-09-13 查出的真事故：`_审校标记.json` 按**文件名**落盘，而管线每重新生成一版产物就换文件名。
 * 于是教师在旧版上点的校准，在新版里"不见了"——账没丢，只是新文件读的是它自己那张空表。
 * 实测证据（Animal Farm 第一章）：
 *
 *   原文_A层85_2026-09-10_审校标记.json        1 条（pellets / 词汇简化）
 *   原文_A层85_2026-09-12_工序化_审校标记.json  0 条   ← 教师后来打开的是这一版
 *
 * ## 分工
 *
 * · `_审校标记.json` = **视图**：仍是主要数据源（App 的既有逻辑一行不动），换版本失效但不致命；
 * · `_运行/校准台账.jsonl` = **正本**：append-only，挂 书/章/层/词，**换版本重放得回来**。
 *
 * 打开一章时：先读视图（老逻辑），再把台账重放到**当前这一版**上（新逻辑）。
 * 教师点的每一下：视图照常落盘，**同时**往台账追加一条 `source: 'human'` 的事件。
 *
 * 纯逻辑（路径推导、范围解析、重放合并）在 `bookpure.ts` / `src/core/calibration.ts` 里，本文件只管 IO。
 */

import { invoke } from '@tauri-apps/api/core';
import {
  parseCalibrationLog,
  replayCalibrations,
  toCalibrationLine,
  calibrationFromMark,
  ledgerPathFromChapterPath,
  scopeFromChapterPath,
  type CalibrationEvent,
  type CalibrationScope,
  type ReplayedMark,
} from '../../src/core/calibration.js';
import type { FileSession, Mark } from './types.js';

/** 读台账；不存在＝这本书还没记过账，是常态（`read_text_file` 对缺失文件报错）。 */
export async function readLedger(sourcePath: string): Promise<CalibrationEvent[]> {
  const path = ledgerPathFromChapterPath(sourcePath);
  if (!path) return [];
  try {
    const text = await invoke<string>('read_text_file', { path });
    const { events, bad } = parseCalibrationLog(text);
    if (bad.length) console.warn(`校准台账有 ${bad.length} 行读不动（首条：${bad[0]!.reason}）——按项目纪律报出来，不静默吞`);
    return events;
  } catch {
    /* 有意兜底：台账还不存在＝这本书第一次审，读不到不是错误。 */
    return [];
  }
}

/** 把台账重放到当前版本，得到"该补的标记"。找不到锚的事件由调用方决定怎么提示。 */
export async function replayInto(session: FileSession): Promise<ReplayedMark[]> {
  if (!session.sourcePath) return [];
  const scope = scopeFromChapterPath(session.sourcePath);
  if (!scope) return [];
  const events = await readLedger(session.sourcePath);
  if (!events.length) return [];
  const r = replayCalibrations({
    md: session.md,
    events,
    scope,
    existing: session.review.marks,
    sources: ['human'],
  });
  if (r.unmatched.length) {
    /* 找不到锚**不是错误**：待办类的多半是"已办结"（教师标了"该换掉"，新版确实换掉了）。
     * 只把"保留类却不见了"的报给控制台——那些才值得人看一眼。 */
    const suspicious = r.unmatched.filter((e) => !['simpl', 'oov', 'hard', 'cut', 'syntax', 'long', 'others'].includes(e.type));
    if (suspicious.length) console.info(`校准台账：${suspicious.length} 条旧校准在新版里找不到锚（标的是"该留下/该标注"，值得看一眼）`, suspicious);
  }
  return r.marks;
}

/** 一条校准事件 → App 的标记（保留来源与溯源，界面上分得清"人定的"和"台账重放回来的"）。 */
export function markFromReplayed(r: ReplayedMark): Mark {
  return {
    id: r.id,
    level: r.level,
    pi: r.pi,
    si: r.si,
    wi: r.wi,
    word: r.word,
    text: r.text,
    type: r.type as Mark['type'],
    note: r.note,
    origin: r.origin,
    ts: r.ts,
  };
}

export interface CalibrationCtx {
  teacher: string;
  file?: string;
  action?: 'add' | 'remove';
  source?: 'human' | 'ai';
  /** 要不要向下层传播：`none` = 只在做决定的那一层生效（「忽略」就是这一档） */
  propagation?: 'none' | 'annotate' | 'rewrite';
  /** `decision` = 只记决定、不变成标记（「忽略」用这个） */
  kind?: 'mark' | 'decision';
}

/**
 * 教师点了一下 → 记一条账。**fire-and-forget**：台账写失败不该拦教师干活
 * （与项目既有的 `logCost` 口径一致：账坏不能把活干坏），但要在控制台说出来。
 */
export async function recordCalibration(session: FileSession, mark: Mark, ctx: CalibrationCtx): Promise<void> {
  if (!session.sourcePath) return;
  const path = ledgerPathFromChapterPath(session.sourcePath);
  const scope: CalibrationScope | null = scopeFromChapterPath(session.sourcePath);
  if (!path || !scope) return;
  try {
    const e = calibrationFromMark(mark, {
      teacher: ctx.teacher,
      book: scope.book,
      chapter: scope.chapter,
      tier: scope.tier,
      file: ctx.file ?? session.fileName,
      action: ctx.action,
      source: ctx.source,
      propagation: ctx.propagation,
      kind: ctx.kind,
    });
    await invoke('append_text_file', { path, content: toCalibrationLine(e) });
  } catch (e) {
    /* 有意兜底：台账写失败**不拦教师干活**（与既有 logCost 同口径：账坏不能把活干坏）；
       视图 `_审校标记.json` 已经落盘，本版校准不丢，只是缺一条跨版本正本记录。 */
    console.warn('校准台账写入失败（不影响本次操作）：' + String(e).slice(0, 120));
  }
}
