/**
 * 章节会话的**状态访问与落盘**（2026-09-16 从 main.ts 下沉，C1 解环第一步）。
 *
 * 为什么单独一个模块：`activeSession` / `persistEdit` / `markPathFor` 原先长在 main.ts，
 * 而 chat / bookio / edit / pipew / batch / report / settings 等 9 个模块都要用它们——
 * 每个使用方都被迫反向 import main.ts，这是循环依赖的主要根子（main 是 UI 总线，
 * 它 import 所有视图模块）。会话状态本来只依赖 `state`（唯一来源）/`types`/`fsx`，
 * 把这层往下沉之后，上面那些模块直接引 session，不必再绕 main。
 *
 * 本文件只放**闭包干净**的函数：依赖仅限 state/types/fsx 与 Tauri invoke。
 * 涉及 UI 刷新（renderAll 等）的编排函数不在此处——那些属于总线层（见 main.ts / 后续 uibus）。
 */

import { invoke } from '@tauri-apps/api/core';
import { S } from './state.js';
import { saveConfig } from './ai.js';
import { scrollNow } from './uikit.js';
import { makeFirstChangeBackup } from './fsx.js';
import type { FileSession } from './types.js';

export function activeSession(): FileSession | null {
  return S.activeIdx >= 0 ? S.sessions[S.activeIdx] : null;
}

export async function markPathFor(sourcePath: string | null, fileName: string): Promise<string> {
  if (sourcePath) {
    const dir = sourcePath.slice(0, sourcePath.lastIndexOf('/'));
    const base = fileName.replace(/\.(md|txt|markdown)$/i, '');
    return `${dir}/${base}_审校标记.json`;
  }
  const dir = await invoke<string>('reports_dir');
  return `${dir}/示例_审校标记.json`;
}

/**
 * 写盘并**记一次编辑历史**。
 *
 * `opts.recordHistory === false` 是给「撤销/重做」用的：那两个动作自己管理 undo/redo 两个栈，
 * **不能让这里再记一遍**——否则 `redoStack = []` 会把刚压进去的重做项清掉
 * （重做于是永远没得做）。
 */
export async function persistEdit(s: FileSession, newMd: string, opts: { recordHistory?: boolean } = {}): Promise<string> {
  if (newMd !== s.md && opts.recordHistory !== false) {
    // 文件级撤销栈（≤50 快照；重做栈清空）
    (s.undoStack ??= []).push(s.md);
    if (s.undoStack.length > 50) s.undoStack.shift();
    s.redoStack = [];
  }
  if (s.sourcePath && (S.appConfig.inPlaceEdit ?? true)) {
    /* 首改前留一份"原始备份"（策略在 `fsx.makeFirstChangeBackup`，与 risk 面板、
     * aiflow 的 adoptRewrite 共用同一份三态决策）：
     * 确实不存在才写；**存在但读不出来就中止这一次改动**——
     * 宁可这一次不改，也不拿教师唯一的原始版去赌。 */
    await makeFirstChangeBackup()(s.sourcePath, s.md);
    await invoke('write_text_file', { path: s.sourcePath, content: newMd });
    return s.sourcePath;
  }
  const wf = s.sourcePath ? workPath(s) : (await invoke<string>('reports_dir')) + '/示例_工作稿.md';
  await invoke('write_text_file', { path: wf, content: newMd });
  return wf;
}

function workPath(s: FileSession): string {
  if (s.sourcePath) {
    const dir = s.sourcePath.slice(0, s.sourcePath.lastIndexOf('/'));
    return `${dir}/${s.fileName.replace(/\.(md|txt|markdown)$/i, '')}_工作稿.md`;
  }
  return ''; // 示例模式由调用方处理
}

/* ────────────────────── 上次会话的持久化（2026-09-16 从 shelf.ts 下沉，C3 cut2） ────────────────────── */
/* 原先寄居书架模块：edit.ts 为了防抖保存要 import shelf，shelf 为了滚动位置要 import edit——
 * edit↔shelf 互指成环。会话的保存本来就是 session 模块的职责（内聚），搬家后双向边都消失。 */

let lastSessionTimer: ReturnType<typeof setTimeout> | null = null;

export function saveLastSession(): void {
  if (S.sessions.length === 0) return;
  const cur = activeSession();
  if (cur) cur.scrollTop = scrollNow();
  const dir = S.sessions.find((x) => x.sourcePath)?.sourcePath;
  S.appConfig.lastSession = {
    /* 书根锚定（书架注册目录）：hero"继续上次编辑"按 bookDir===书.目录 匹配，
     * 写章目录会导致匹配永远失败（章目录在书根下多层）；无书上下文时退回文件父目录 */
    bookDir: S.currentBookDir ?? (dir ? dir.slice(0, dir.lastIndexOf('/')) : undefined),
    workspace: S.activeWorkspace ?? undefined,
    files: S.sessions.filter((x) => x.sourcePath).map((x) => ({ path: x.sourcePath!, scroll: x.scrollTop ?? 0 })),
    activeIdx: S.activeIdx,
    savedAt: new Date().toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
  };
  void saveConfig();
}

export function scheduleSaveLastSession(): void {
  if (lastSessionTimer) clearTimeout(lastSessionTimer);
  lastSessionTimer = setTimeout(saveLastSession, 1500);
}
