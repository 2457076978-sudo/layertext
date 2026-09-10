/**
 * 编辑工具域（WP-F 拆分）：撤销/重做（快照+标记重对齐）/ 查找替换 / 键盘审校流（跳难句/弹层数字键）/
 * 正文右侧难句热力轨 —— 从 main.ts 整块迁出，行为零变化。
 */

import { invoke } from '@tauri-apps/api/core';
import { $, setStatus, toast, pop } from './uikit.js';
import { activeSession, persistEdit, renderAll } from './main.js';
import { scheduleSaveLastSession } from './shelf.js';
import { csvCell, remapMarks } from './pure.js';
import { scheduleSave } from './review.js';
import { CHANGELOG_HEADER } from './types.js';
import { simplifyMaxLen } from './ai.js';
import type { FileSession } from './types.js';

/* ================= UX 补齐（2026-09-08 Wayne：文本软件该有的东西） ================= */

export function scrollEl(): HTMLElement | null {
  for (const sel of ['#reader', '.content', 'main']) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el && el.scrollHeight > el.clientHeight) return el;
  }
  return document.querySelector<HTMLElement>('#reader');
}
export function scrollNow(): number {
  return scrollEl()?.scrollTop ?? 0;
}

/* ---- 撤销 / 重做 ---- */
async function applyMdSnapshot(s: FileSession, md: string, label: string): Promise<void> {
  await persistEdit(s, md);
  s.md = md;
  s.review.warns = []; // 快照级回退：所有句位置已变，复核角标整体失效清空
  remapMarks(s.review.marks, s.md); // 正文变了标记跟着重对齐（撤销/查找替换曾是欠账：标记错位不修）
  scheduleSave(s, () => undefined);
  renderAll();
  setStatus(label + '（文件已同步保存）', 'saved');
  scheduleSaveLastSession();
}
export async function doUndo(): Promise<void> {
  const s = activeSession();
  if (!s?.undoStack?.length) {
    toast('没有可撤销的更改');
    return;
  }
  const prev = s.undoStack.pop()!;
  (s.redoStack ??= []).push(s.md);
  await applyMdSnapshot(s, prev, '↩︎ 已撤销');
}
export async function doRedo(): Promise<void> {
  const s = activeSession();
  if (!s?.redoStack?.length) {
    toast('没有可重做的更改');
    return;
  }
  const next = s.redoStack.pop()!;
  (s.undoStack ??= []).push(s.md);
  await applyMdSnapshot(s, next, '↪︎ 已重做');
}

/* ---- 查找 / 替换 ---- */
let findHits: HTMLElement[] = [];
let findPos = -1;
export function openFind(): void {
  const bar = document.getElementById('findbar');
  if (!bar) return;
  bar.style.display = 'flex';
  const inp = document.getElementById('find-input') as HTMLInputElement | null;
  inp?.focus();
  inp?.select();
  runFind();
}
export function closeFind(): void {
  const bar = document.getElementById('findbar');
  if (bar) bar.style.display = 'none';
  document.querySelectorAll('.flash-hit').forEach((el) => el.classList.remove('flash-hit'));
}
export function runFind(): void {
  const q = (document.getElementById('find-input') as HTMLInputElement | null)?.value.trim().toLowerCase() ?? '';
  document.querySelectorAll('.flash-hit').forEach((el) => el.classList.remove('flash-hit'));
  findHits = [];
  findPos = -1;
  const cnt = document.getElementById('find-count');
  if (!q) {
    if (cnt) cnt.textContent = '';
    return;
  }
  document.querySelectorAll<HTMLElement>('#reader .sent').forEach((el) => {
    if (el.textContent?.toLowerCase().includes(q)) findHits.push(el);
  });
  if (cnt) cnt.textContent = findHits.length ? `${findHits.length} 句命中` : '无命中';
}
export function jumpFind(dir: 1 | -1): void {
  if (findHits.length === 0) return;
  findPos = (findPos + dir + findHits.length) % findHits.length;
  const el = findHits[findPos];
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.add('flash-hit');
  const cnt = document.getElementById('find-count');
  if (cnt) cnt.textContent = `${findPos + 1}/${findHits.length} 句`;
}
export async function replaceAllFind(): Promise<void> {
  const s = activeSession();
  if (!s) {
    toast('先打开章节');
    return;
  }
  const q = (document.getElementById('find-input') as HTMLInputElement)?.value ?? '';
  const r = (document.getElementById('replace-input') as HTMLInputElement)?.value ?? '';
  if (!q) {
    toast('先输入要查找的内容');
    return;
  }
  const n = s.md.split(q).length - 1;
  if (n === 0) {
    toast('没有可替换的内容');
    return;
  }
  if (!confirm(`把「${q}」全部替换为「${r}」？共 ${n} 处（可用 ↩︎ 撤销）`)) return;
  await applyMdSnapshot(s, s.md.split(q).join(r), `已替换 ${n} 处`);
  toast(`已替换 ${n} 处（↩︎ 可撤销）`, 'ok');
  // 人工矫正可审计：手动替换同样进变更日志（此前只有 AI 修改留痕）
  try {
    const date = new Date().toLocaleDateString('sv-SE');
    const outDir = s.sourcePath ? s.sourcePath.slice(0, s.sourcePath.lastIndexOf('/')) : await invoke<string>('reports_dir');
    const logPath = `${outDir}/变更日志_AI审核.csv`;
    let csv = '';
    try {
      csv = await invoke<string>('read_text_file', { path: logPath });
    } catch {
      /* 新建 */
    }
    if (!csv.trim()) csv = CHANGELOG_HEADER.join(',') + '\n';
    csv += ['R1', date, `标准${simplifyMaxLen()}词`, '', '', q, r, 'R15', `教师查找替换（${n} 处，可撤销）`, '人工矫正-查找替换'].map(csvCell).join(',') + '\n';
    await invoke('write_text_file', { path: logPath, content: csv });
  } catch {
    /* 日志失败不阻塞替换 */
  }
}

/* ================= 键盘审校流（跳难句 / 数字键标记 / 切工作区）与难句热力轨 ================= */

/** F8 / ⌘G：跳到下一处风险句（被/从/完/长），循环滚动 + 闪烁 + 计数 */
let riskJumpIdx = -1;
/** 换章时复位难句跳转索引（riskJumpIdx 是本模块私有状态） */
export function resetRiskJump(): void {
  riskJumpIdx = -1;
}
export function jumpNextRisk(dir: 1 | -1): void {
  const risks = [...document.querySelectorAll<HTMLElement>('#reader .sent.risk')];
  if (!risks.length) {
    toast('本章没有检测出难句（被/从/完/长）');
    return;
  }
  riskJumpIdx = (riskJumpIdx + dir + risks.length) % risks.length;
  const el = risks[riskJumpIdx];
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
  const kinds = [...el.querySelectorAll('.badge')].map((b) => b.textContent).join('·');
  toast(`难句 ${riskJumpIdx + 1}/${risks.length}${kinds ? ' · ' + kinds : ''}`);
}

/** 标记弹层开着时：数字键 1-9、0(=第10类) 选标记类型，R = AI 改写本句，E = 手动改这句（note 输入框聚焦时不拦截） */
export function popHotkey(k: string): boolean {
  if (!pop.classList.contains('open')) return false;
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) return false; // 正在写备注，别抢键
  const btns = [...pop.querySelectorAll<HTMLElement>('[data-mk]')];
  let hit: HTMLElement | null = null;
  if (k === 'r' || k === 'R') hit = pop.querySelector<HTMLElement>('[data-mk="__rewrite"]');
  else if (k === 'e' || k === 'E') hit = pop.querySelector<HTMLElement>('[data-mk="__edit"]');
  else if (/^[0-9]$/.test(k)) hit = btns.filter((b) => !b.dataset.mk!.startsWith('__'))[k === '0' ? 9 : Number(k) - 1] ?? null;
  if (!hit) return false;
  hit.click();
  return true;
}

/* ---------- 正文右侧热力轨：风险句红点 / 标记蓝点 / 叠加紫点，点圆点直达 ---------- */

let heatRaf = 0;
export function scheduleHeatRail(): void {
  cancelAnimationFrame(heatRaf);
  heatRaf = requestAnimationFrame(buildHeatRail);
}

/** 内容坐标：元素相对滚动容器内容顶部的 Y（getBoundingClientRect 差 + 已滚过的量） */
function contentY(el: HTMLElement, pane: HTMLElement): number {
  return el.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
}

let heatBound = false;
let heatViewEl: HTMLElement | null = null;
let heatReaderEl: HTMLElement | null = null;
let heatPaneEl: HTMLElement | null = null;
function heatUpdateView(): void {
  if (!heatViewEl || !heatReaderEl || !heatPaneEl) return;
  const H = heatReaderEl.offsetHeight || 1;
  const total = heatReaderEl.scrollHeight || 1;
  const readerTop = contentY(heatReaderEl, heatPaneEl);
  const top = Math.max(0, ((heatPaneEl.scrollTop - readerTop) / total) * H);
  const vh = (heatPaneEl.clientHeight / total) * H;
  heatViewEl.style.top = top + 'px';
  heatViewEl.style.height = Math.max(18, Math.min(H, vh)) + 'px';
}

function buildHeatRail(): void {
  const reader = $('reader');
  const pane = reader.closest<HTMLElement>('.pane');
  if (!pane) return;
  let rail = reader.querySelector<HTMLElement>('.heat-rail');
  if (!rail) {
    rail = document.createElement('div');
    rail.className = 'heat-rail';
    reader.appendChild(rail);
  }
  if (!heatBound) {
    heatBound = true;
    pane.addEventListener('scroll', heatUpdateView, { passive: true });
    window.addEventListener('resize', scheduleHeatRail);
  }
  rail.replaceChildren();
  const s = activeSession();
  if (!s || !reader.querySelector('.para')) return; // 书架/版本页不画轨
  const H = reader.offsetHeight || 1;
  const total = reader.scrollHeight || 1;
  const readerTop = contentY(reader, pane);
  const dot = (el: HTMLElement, cls: string, title: string, slot = 0): void => {
    const d = document.createElement('div');
    d.className = 'heat-dot ' + cls;
    const y = ((contentY(el, pane) - readerTop) / total) * H;
    d.style.top = Math.max(0, Math.min(H - 6, y + slot * 6)) + 'px'; // 同句多类信号自上而下每类偏移一个点位
    d.title = title;
    d.addEventListener('click', () => {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
    });
    rail!.appendChild(d);
  };
  // 按句聚合三类信号：红=句法风险 / 橙=句内生词 / 蓝=标记（紫=风险+标记融合，title 汇总同句多标记）
  interface RailFlags { risk: boolean; vocab: number; mark: string | null }
  const flags = new Map<HTMLElement, RailFlags>();
  const flagOf = (el: HTMLElement): RailFlags => {
    let f = flags.get(el);
    if (!f) {
      f = { risk: false, vocab: 0, mark: null };
      flags.set(el, f);
    }
    return f;
  };
  document.querySelectorAll<HTMLElement>('#reader .sent.risk').forEach((el) => {
    flagOf(el).risk = true;
  });
  document.querySelectorAll<HTMLElement>('#reader .sent[data-oov]').forEach((el) => {
    flagOf(el).vocab = Number(el.dataset.oov ?? 0);
  });
  const sentByKey = new Map<string, HTMLElement>();
  document.querySelectorAll<HTMLElement>('#reader .sent').forEach((el) => sentByKey.set(`${el.dataset.pi}:${el.dataset.si}`, el));
  for (const m of s.review.marks) {
    const el = sentByKey.get(`${m.pi}:${m.si}`);
    if (!el) continue;
    const label = (m.level === 'word' ? '词' : m.level === 'phrase' ? '短语' : '句') + '标记：' + (m.word ?? m.text ?? '').slice(0, 30);
    const f = flagOf(el);
    f.mark = f.mark ? f.mark + '；' + label : label;
  }
  for (const [el, f] of flags) {
    let slot = 0;
    if (f.risk) dot(el, 'risk', (el.textContent ?? '').slice(0, 50), slot++);
    if (f.vocab) dot(el, 'vocab', `P${Number(el.dataset.pi) + 1}·S${Number(el.dataset.si) + 1} · ${f.vocab} 个生词（点击词面可标记处理）`, slot++);
    if (f.mark !== null) dot(el, f.risk ? 'both' : 'mark', f.mark, slot);
  }
  // 视口指示块
  const view = document.createElement('div');
  view.className = 'heat-view';
  rail.appendChild(view);
  heatViewEl = view;
  heatReaderEl = reader;
  heatPaneEl = pane;
  heatUpdateView();
}
