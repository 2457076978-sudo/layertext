/**
 * UI 部件渲染（DOM 依赖、无 Tauri/业务依赖，happy-dom 可直接测）
 * 模式胶囊 · 视图切换 · 版本对比 diff —— 从 main.ts 抽出（O4：先抽函数再测，行为不变）。
 */

import { esc } from './state.js';
import { extractParas, splitChapter } from '../../src/core/textpipe.js';

/* ---------- 修改模式胶囊：一眼可见、一键切换（即改=立即生效 / 候选=点✓生效） ---------- */

export function renderModePill(pill: HTMLElement, autoRewrite: boolean): void {
  pill.className = 'mode-pill ' + (autoRewrite ? 'green' : 'yellow');
  pill.innerHTML = autoRewrite ? '<svg class="ico"><use href="#i-bolt"/></svg>即改模式：标记即生效' : '<svg class="ico"><use href="#i-eye"/></svg>候选模式：等你点 ✓';
  pill.title = autoRewrite ? '当前：点了标记/建议，AI 改完立即生效（写原稿+日志）。点击切到候选模式' : '当前：AI 只出建议（黄色框），你逐条点 ✓ 才生效。点击切到即改模式';
}

/* ---------- 视图切换（正文/报告/建议/对比/对照/复盘 六个标签页） ---------- */

const VIEW_MAP = [
  ['tab-text', 'pane-text'],
  ['tab-report', 'pane-report'],
  ['tab-suggest', 'pane-suggest'],
  ['tab-diff', 'pane-diff'],
  ['tab-align', 'pane-align'],
  ['tab-board', 'pane-board'],
  ['tab-dossier', 'pane-dossier'],
  ['tab-retro', 'pane-retro'],
  ['tab-data', 'pane-data'],
] as const;

export type ViewName = 'text' | 'report' | 'suggest' | 'diff' | 'align' | 'board' | 'dossier' | 'retro' | 'data';

/** 一级三组（按教师任务流）：读=阅读与版本比对 / 检=体检与书级状态 / 改=修订处理与回顾 */
export const VIEW_GROUPS: { label: string; hint: string; views: readonly ViewName[] }[] = [
  { label: '读', hint: '阅读与版本比对：正文审校 · 逐句对照 · 版本对比', views: ['text', 'align', 'diff'] },
  { label: '检', hint: '体检与书级状态：质检报告 · 看板 · 审校档案', views: ['report', 'board', 'dossier'] },
  { label: '改', hint: '修订处理与回顾：修订建议 · 复盘', views: ['suggest', 'retro'] },
  { label: '库', hint: '数据资产：词库 / 知识库 / 词典 / 专名 / 分层参数（在此增删改，写回前自动校验）', views: ['data'] },
];

const SUB_LABELS: Record<ViewName, string> = {
  text: '正文',
  align: '逐句对照',
  diff: '版本对比',
  report: '报告',
  board: '看板',
  dossier: '档案',
  suggest: '建议',
  retro: '复盘',
  data: '数据',
};

const groupOf = (v: ViewName): { label: string; hint: string; views: readonly ViewName[] } =>
  VIEW_GROUPS.find((g) => g.views.includes(v)) ?? VIEW_GROUPS[0]!;

/** 每组最近视图（会话级记忆：点一级组回到上次所在页） */
const lastOfGroup: Record<string, ViewName> = {};

export function switchView(root: Document, name: ViewName): void {
  for (const [id, pane] of VIEW_MAP) {
    root.getElementById(id)?.classList.toggle('active', id === `tab-${name}`); // 旧 tab-* 兼容（测试 DOM 用；生产已容器化）
    // 容错：测试 DOM / 旧页面可能没有某些面板，缺了不该炸（曾因非空断言导致新增视图即崩）
    root.getElementById(pane)?.classList.toggle('active', pane === `pane-${name}`);
  }
  lastOfGroup[groupOf(name).label] = name;
  syncViewTabs(root, name);
}

/** 同步两级页签渲染（一级组高亮 + 组内二级；容器不存在时静默——happy-dom 旧测试不受影响） */
export function syncViewTabs(root: Document, active: ViewName): void {
  const g = groupOf(active);
  const groupsEl = root.getElementById('vt-groups');
  const subEl = root.getElementById('vt-sub');
  if (!groupsEl || !subEl) return;
  groupsEl.innerHTML = VIEW_GROUPS.map(
    (x) => `<button class="vt-g${x.label === g.label ? ' active' : ''}" data-vt-group="${x.label}" title="${x.hint}">${x.label}</button>`,
  ).join('');
  subEl.innerHTML =
    g.views.length > 1
      ? g.views.map((v) => `<button class="vt-s${v === active ? ' active' : ''}" data-vt-view="${v}">${SUB_LABELS[v]}</button>`).join('')
      : '';
}

/** 两级页签事件委托（一级=回该组上次视图；二级=切具体视图）——main 侧唯一绑定入口 */
export function bindViewTabs(root: Document, go: (v: ViewName) => void): void {
  root.getElementById('vt-groups')?.addEventListener('click', (e) => {
    const label = (e.target as HTMLElement).closest('[data-vt-group]')?.getAttribute('data-vt-group');
    if (!label) return;
    const g = VIEW_GROUPS.find((x) => x.label === label)!;
    go(lastOfGroup[label] ?? g.views[0]!);
  });
  root.getElementById('vt-sub')?.addEventListener('click', (e) => {
    const v = (e.target as HTMLElement).closest('[data-vt-view]')?.getAttribute('data-vt-view');
    if (v) go(v as ViewName);
  });
  syncViewTabs(root, 'text');
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
