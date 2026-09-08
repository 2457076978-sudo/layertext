/**
 * UI 部件渲染（DOM 依赖、无 Tauri/业务依赖，happy-dom 可直接测）
 * 模式胶囊 · 视图切换 · 版本对比 diff —— 从 main.ts 抽出（O4：先抽函数再测，行为不变）。
 */

import { esc } from './state.js';
import { extractParas, sentsOf, splitChapter } from '../../src/core/textpipe.js';

/* ---------- 修改模式胶囊：一眼可见、一键切换（即改=立即生效 / 候选=点✓生效） ---------- */

export function renderModePill(pill: HTMLElement, autoRewrite: boolean): void {
  pill.className = 'mode-pill ' + (autoRewrite ? 'green' : 'yellow');
  pill.innerHTML = autoRewrite ? '⚡ 即改模式：标记即生效' : '👁 候选模式：等你点 ✓';
  pill.title = autoRewrite ? '当前：点了标记/建议，AI 改完立即生效（写原稿+日志）。点击切到候选模式' : '当前：AI 只出建议（黄色框），你逐条点 ✓ 才生效。点击切到即改模式';
}

/* ---------- 视图切换（正文/报告/建议/对比/对照/复盘 六个标签页） ---------- */

const VIEW_MAP = [
  ['tab-text', 'pane-text'],
  ['tab-report', 'pane-report'],
  ['tab-suggest', 'pane-suggest'],
  ['tab-diff', 'pane-diff'],
  ['tab-align', 'pane-align'],
  ['tab-retro', 'pane-retro'],
] as const;

export type ViewName = 'text' | 'report' | 'suggest' | 'diff' | 'align' | 'retro';

export function switchView(root: Document, name: ViewName): void {
  for (const [id, pane] of VIEW_MAP) {
    root.getElementById(id)!.classList.toggle('active', id === `tab-${name}`);
    root.getElementById(pane)!.classList.toggle('active', pane === `pane-${name}`);
  }
}

/* ---------- 版本对比（双版本逐段 diff：红=仅左侧版本，绿=已修改/仅右侧版本） ---------- */

export interface DiffSessionLike {
  fileName: string;
  md: string;
}

export function renderDiffPane(pane: HTMLElement, sessions: DiffSessionLike[], lIdx: number, rIdx: number, onChange: (l: number, r: number) => void): void {
  const L = sessions[lIdx];
  const R = sessions[rIdx];
  if (!L || !R) {
    pane.innerHTML = '<div class="empty">先打开两个版本文件（如原文与简化版）</div>';
    return;
  }
  const lp = extractParas(splitChapter(L.md).body);
  const rp = extractParas(splitChapter(R.md).body);
  const n = Math.max(lp.length, rp.length);
  let rows = '';
  let same = 0;
  for (let i = 0; i < n; i++) {
    const a = (lp[i] ?? '').replace(/\s+/g, ' ').trim();
    const b = (rp[i] ?? '').replace(/\s+/g, ' ').trim();
    const eq = a === b;
    if (eq) same++;
    rows += `<tr>
      <td class="diff-pid">P${String(i + 1).padStart(2, '0')}</td>
      <td class="${eq ? '' : 'diff-del'}">${esc(a) || '<i style="color:var(--muted)">（无此段）</i>'}</td>
      <td class="${eq ? '' : 'diff-add'}">${esc(b) || '<i style="color:var(--muted)">（无此段）</i>'}</td>
    </tr>`;
  }
  pane.innerHTML = `
    <div class="sg-actions">
      <b>版本对比</b>
      <select id="diff-l">${sessions.map((x, i) => `<option value="${i}" ${i === lIdx ? 'selected' : ''}>${esc(x.fileName)}</option>`).join('')}</select>
      <span>↔</span>
      <select id="diff-r">${sessions.map((x, i) => `<option value="${i}" ${i === rIdx ? 'selected' : ''}>${esc(x.fileName)}</option>`).join('')}</select>
      <span style="color:var(--muted);font-size:12px">段落一致 ${same}/${n}（红=仅左侧版本，绿=仅右侧版本/已修改）</span>
    </div>
    <table class="sgtable">
      <tr><th>段</th><th style="width:44%">${esc(L.fileName)}</th><th style="width:44%">${esc(R.fileName)}</th></tr>
      ${rows}
    </table>`;
  pane.querySelector('#diff-l')!.addEventListener('change', (ev) => onChange(Number((ev.target as HTMLSelectElement).value), rIdx));
  pane.querySelector('#diff-r')!.addEventListener('change', (ev) => onChange(lIdx, Number((ev.target as HTMLSelectElement).value)));
}
