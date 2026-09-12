/**
 * 审校工作台核心逻辑：标记落盘（防抖）、正文增量着色、侧栏（配额/门禁/清单）、定位跳转。
 *
 * 对原型（AF审校阅读器_v0.1）的既有缺陷修复：
 *  - 标记后增量更新受影响元素，不再全量重渲染（不丢选区）；
 *  - 词/句定位用确定性索引（pi/si/wi），不用"文本包含"反查，重复句不串位；
 *  - 删除句级标记不影响词级标记；词标记不区分大小写漂移；
 *  - 落盘为本地 JSON 文件（防抖 600ms），不依赖 localStorage/服务端。
 */

import { invoke } from '@tauri-apps/api/core';
import { WORD_TYPES, SENT_TYPES, GATES, typeLabel, type FileSession, type Mark } from './types.js';
import { planRevisionTask, revisionTaskPreview } from '../../src/core/adaptcheck.js';

const SAVE_DEBOUNCE_MS = 600;

export function scheduleSave(session: FileSession, onStatus: (s: 'dirty' | 'saved' | 'error', detail?: string) => void): void {
  session.dirty = true;
  onStatus('dirty');
  const review = session.review;
  review.updatedAt = Date.now();
  clearTimeout((session as FileSession & { _t?: ReturnType<typeof setTimeout> })._t);
  (session as FileSession & { _t?: ReturnType<typeof setTimeout> })._t = setTimeout(async () => {
    try {
      await invoke('write_text_file', {
        path: session.markPath,
        content: JSON.stringify(review, null, 1),
      });
      session.dirty = false;
      onStatus('saved', session.markPath);
    } catch (e) {
      onStatus('error', String(e));
    }
  }, SAVE_DEBOUNCE_MS);
}

/* ---------- 正文增量着色 ---------- */

function findSentEl(pi: number, si: number): HTMLElement | null {
  return document.querySelector(`.sent[data-pi="${pi}"][data-si="${si}"]`);
}

export function refreshMarkDom(mark: Mark): void {
  if (mark.level === 'word') {
    const el = findSentEl(mark.pi, mark.si)?.querySelector(`.w[data-wi="${mark.wi}"]`);
    el?.classList.add('mk-' + mark.type);
  } else if (mark.level === 'phrase') {
    // 短语：把第 wi..wi+wl-1 个词（含中间文本节点）包进 .pm 下划线 span；幂等（同 id 已包过跳过）
    const sent = findSentEl(mark.pi, mark.si);
    if (!sent || sent.querySelector(`.pm[data-mid="${mark.id}"]`)) return;
    const from = Number(mark.wi ?? 0);
    const to = from + Math.max(1, mark.wl ?? 1) - 1;
    const words = [...sent.querySelectorAll<HTMLElement>('.w')];
    const start = words.find((w) => Number(w.dataset.wi) === from);
    const end = words.find((w) => Number(w.dataset.wi) === to);
    if (!start || !end) return;
    const moved: ChildNode[] = [];
    for (let n: ChildNode | null = start; n; n = n.nextSibling) {
      moved.push(n);
      if (n === end) break;
    }
    const wrap = document.createElement('span');
    wrap.className = 'pm mk-' + mark.type;
    wrap.dataset.mid = mark.id;
    wrap.title = `短语标记：${typeLabel(mark.type)}${mark.note ? ' ｜ ' + mark.note : ''}`;
    sent.insertBefore(wrap, moved[0]);
    for (const n of moved) wrap.appendChild(n);
  } else {
    const sent = findSentEl(mark.pi, mark.si);
    if (!sent) return;
    const sentTypeEl = sent.querySelector(`.sbadge-${mark.type}`);
    if (!sentTypeEl) {
      const b = document.createElement('sup');
      b.className = 'sbadge sbadge-' + mark.type;
      b.dataset.type = mark.type;
      b.textContent = typeLabel(mark.type);
      sent.appendChild(b);
    }
  }
}

export function removeMarkDom(mark: Mark): void {
  if (mark.level === 'word') {
    const el = findSentEl(mark.pi, mark.si)?.querySelector(`.w[data-wi="${mark.wi}"]`);
    el?.classList.remove('mk-' + mark.type);
  } else if (mark.level === 'phrase') {
    // 解包：子节点原位放回（词级标记的 class 在 .w 上，随子节点一起保留）
    const pm = findSentEl(mark.pi, mark.si)?.querySelector(`.pm[data-mid="${mark.id}"]`);
    if (pm?.parentNode) {
      const parent = pm.parentNode;
      while (pm.firstChild) parent.insertBefore(pm.firstChild, pm);
      parent.removeChild(pm);
    }
  } else {
    findSentEl(mark.pi, mark.si)?.querySelector(`.sbadge-${mark.type}`)?.remove();
  }
}

/** 打开文件后，把已保存的标记全部刷到正文 DOM */
export function restoreAllMarkDom(session: FileSession): void {
  for (const m of session.review.marks) refreshMarkDom(m);
  refreshBookmarksDom(session);
}

/* ---------- 段落书签（双击段号收藏） ---------- */

function paraEl(pi: number): HTMLElement | null {
  return document.querySelector(`.para[data-pi="${pi}"]`);
}

/** 书签视觉：段号变实心徽标 + 段左侧细条（恢复/添加/移除共用——幂等，先清再加；原文案存 pid.dataset.orig） */
export function refreshBookmarksDom(session: FileSession): void {
  document.querySelectorAll<HTMLElement>('.para.bookmarked').forEach((el) => {
    const pid = el.querySelector<HTMLElement>('.pid');
    el.classList.remove('bookmarked');
    if (pid?.dataset.orig) pid.textContent = pid.dataset.orig;
  });
  for (const b of session.review.bookmarks) {
    const el = paraEl(b.pi);
    if (!el) continue;
    el.classList.add('bookmarked');
    const pid = el.querySelector<HTMLElement>('.pid');
    if (pid) pid.textContent = '★' + String(b.pi + 1).padStart(2, '0');
  }
}

/** 跳到段落书签（滚动居中 + 闪烁提示） */
export function jumpToBookmark(pi: number): void {
  const el = paraEl(pi);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('flash');
  void (el as HTMLElement).offsetWidth;
  el.classList.add('flash');
}

/* ---------- 定位跳转 ---------- */

export function jumpTo(mark: Mark): void {
  const el =
    mark.level === 'word'
      ? findSentEl(mark.pi, mark.si)?.querySelector(`.w[data-wi="${mark.wi}"]`)
      : mark.level === 'phrase'
        ? findSentEl(mark.pi, mark.si)?.querySelector(`.pm[data-mid="${mark.id}"]`)
        : findSentEl(mark.pi, mark.si);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('flash');
  void (el as HTMLElement).offsetWidth; // 重启动画
  el.classList.add('flash');
}

/* ---------- 侧栏 ---------- */

export function renderSidebar(
  session: FileSession,
  handlers: {
    onQuotaToggle: (i: number) => void;
    onQuotaRemove: (i: number) => void;
    onQuotaAdd: (text: string) => void;
    onGateToggle: (g: string) => void;
    onGateHelp: (g: string, anchor: HTMLElement) => void;
    onMarkJump: (m: Mark) => void;
    onMarkRemove: (m: Mark) => void;
  },
): void {
  const r = session.review;
  const gateDone = GATES.every((g) => r.gate[g]);
  const byType = new Map<string, Mark[]>();
  for (const m of r.marks) {
    if (!byType.has(m.type)) byType.set(m.type, []);
    byType.get(m.type)!.push(m);
  }
  const allTypes = [...WORD_TYPES, ...SENT_TYPES];

  const quotaHtml = r.quota
    .map(
      (q, i) => `
      <li class="quota ${q.done ? 'done' : ''}">
        <label><input type="checkbox" data-quota="${i}" ${q.done ? 'checked' : ''} /> ${esc(q.text)}</label>
        <button class="x" data-quota-rm="${i}" title="删除该要点">×</button>
      </li>`,
    )
    .join('');

  const gateHtml = GATES.map(
    (g) => `
    <li><label><input type="checkbox" data-gate="${esc(g)}" ${r.gate[g] ? 'checked' : ''} /> ${g}</label>
        <button class="qmark" data-gate-help="${esc(g)}" title="这是什么？">?</button></li>`,
  ).join('');

  const listHtml =
    allTypes
      .filter((t) => byType.has(t.key))
      .map((t) => {
        const ms = byType.get(t.key)!;
        return `
      <div class="mgroup">
        <div class="mgroup-h">${t.label}<span class="cnt">${ms.length}</span></div>
        ${ms
          .map((m) => {
            const label = m.level === 'sent' ? (m.text ?? '').slice(0, 22) + '…' : (m.word ?? '');
            return `<div class="mitem">
              <span class="jump" data-jump="${m.id}" title="${esc(label)}${m.origin ? ` ｜ 自《${esc(m.origin)}》传播` : ''}${m.note ? ' ｜ ' + esc(m.note) : ''}">${esc(label)}</span>
              ${m.origin ? `<span class="origin-dot" title="此标记由《${esc(m.origin)}》校正传播而来——低层待办，正文未动；按本版口径处理或删除">⇄</span>` : ''}
              ${m.note ? '<span class="note-dot" title="有备注">✎</span>' : ''}
              <button class="x" data-rm="${m.id}" title="删除标记">×</button>
            </div>`;
          })
          .join('')}
      </div>`;
      })
      .join('') || '<div class="side-empty">暂无标记——正文里点词、拖选句子即可标记</div>';

  const side = document.getElementById('side-review')!;
  side.innerHTML = `
    <div class="side-sec">
      <div class="side-h">本章要点配额 <span class="cnt">${r.quota.filter((q) => q.done).length}/${r.quota.length}</span></div>
      <ul class="quota-list">${quotaHtml || '<li class="side-empty">未设置要点——「质检报告」页点「AI 摘情节要点」，或这里手动加（如"保留风车线索"）</li>'}</ul>
      <div class="quota-add"><input id="quota-input" placeholder="添加本章要点…" /><button id="quota-add-btn">＋</button></div>
    </div>
    <div class="side-sec">
      <div class="side-h">终审门禁 ${gateDone ? '<span class="gate-ok">✅ 已通过</span>' : ''}</div>
      <ul class="gate-list">${gateHtml}</ul>
    </div>
    ${adaptFeedbackBox(session)}
    <div class="side-sec">
      <div class="side-h">标记清单 <span class="cnt">${r.marks.length}</span></div>
      <div class="mlist">${listHtml}</div>
    </div>`;

  // 事件
  side.querySelectorAll('[data-quota]').forEach((el) => el.addEventListener('change', () => handlers.onQuotaToggle(Number((el as HTMLElement).dataset.quota))));
  side.querySelectorAll('[data-quota-rm]').forEach((el) => el.addEventListener('click', () => handlers.onQuotaRemove(Number((el as HTMLElement).dataset.quotaRm))));
  side.querySelectorAll('[data-gate]').forEach((el) => el.addEventListener('change', () => handlers.onGateToggle((el as HTMLElement).dataset.gate!)));
  side.querySelectorAll('[data-gate-help]').forEach((el) =>
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      handlers.onGateHelp((el as HTMLElement).dataset.gateHelp!, el as HTMLElement);
    }),
  );
  side.querySelectorAll('[data-jump]').forEach((el) => {
    const m = r.marks.find((x) => x.id === (el as HTMLElement).dataset.jump);
    if (m) el.addEventListener('click', () => handlers.onMarkJump(m));
  });
  side.querySelectorAll('[data-rm]').forEach((el) => {
    const m = r.marks.find((x) => x.id === (el as HTMLElement).dataset.rm);
    if (m) el.addEventListener('click', () => handlers.onMarkRemove(m));
  });
  document.getElementById('quota-add-btn')?.addEventListener('click', () => {
    const input = document.getElementById('quota-input') as HTMLInputElement | null;
    if (input?.value.trim()) handlers.onQuotaAdd(input.value.trim());
  });
  document.getElementById('quota-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const input = e.target as HTMLInputElement;
      if (input.value.trim()) handlers.onQuotaAdd(input.value.trim());
    }
  });
  bindAdaptFeedback(session);
}

/* ---------- 给第二轮调适的反馈（两轮制教师的入口：读完说一句，第二轮照它复写） ---------- */

const ADAPT_NAME_RE = /原文_(A层85|M层75|B层60)_/;

function adaptTargetOf(sourcePath: string | null): { tierKey: string; tag: string; chapDir: string; outRoot: string; feedbackPath: string; taskPath: string } | null {
  const m = sourcePath?.match(ADAPT_NAME_RE);
  if (!m || !sourcePath) return null;
  const dir = sourcePath.slice(0, sourcePath.lastIndexOf('/'));
  const chapDir = dir.split('/').pop() ?? '';
  const outRoot = dir.slice(0, dir.lastIndexOf('/'));
  if (!chapDir || !outRoot) return null;
  return {
    tierKey: m[1]![0], tag: m[1]!, chapDir, outRoot,
    feedbackPath: `${outRoot}/_运行/调适反馈_${m[1]}_${chapDir}.json`,
    taskPath: `${outRoot}/_运行/调适任务单_${m[1]}_${chapDir}.json`,
  };
}

function adaptFeedbackBox(session: FileSession): string {
  if (!adaptTargetOf(session.sourcePath)) return '';
  return `
    <div class="side-sec">
      <div class="side-h">给第二轮调适的反馈</div>
      <textarea id="adapt-fb" rows="3" style="width:100%;font-size:12px" placeholder="读完后用一句话告诉第二轮哪里难、大概超前多少。例：词汇大概超前一学期，句子有些绕，人物和情节可以。"></textarea>
      <button id="adapt-fb-save" style="margin-top:4px">保存反馈并生成修订任务单</button>
      <div id="adapt-task-preview" style="display:none;margin-top:6px;padding:6px 8px;border:1px solid var(--glass-line,#ddd);border-radius:8px;font-size:12px;line-height:1.7"></div>
    </div>`;
}

interface AdaptTaskFile { task: ReturnType<typeof planRevisionTask>; confirmed: boolean; confirmedAt?: string }

/** 任务单预览：教师先看「系统准备怎么改」，点开始修订才落 confirmed——先确认后执行 */
function renderAdaptTaskPreview(target: { taskPath: string }, taskFile: AdaptTaskFile): void {
  const box = document.getElementById('adapt-task-preview');
  if (!box) return;
  const lines = revisionTaskPreview(taskFile.task)
    .map((l) => `<div>${esc(l)}</div>`)
    .join('');
  const state = taskFile.confirmed
    ? '<div style="color:var(--ok,#2e7d32);margin-top:4px">✓ 已确认——可在终端跑第二轮（--round2）</div>'
    : `<button id="adapt-task-go" style="margin:6px 4px 0 0">开始修订</button><button id="adapt-task-edit" style="margin-top:6px">修改反馈</button>`;
  box.innerHTML = `<div style="font-weight:600;margin-bottom:2px">修订任务单（先确认，后执行）</div>${lines}${state}`;
  box.style.display = 'block';
  const go = document.getElementById('adapt-task-go');
  if (go) {
    go.addEventListener('click', () => {
      taskFile.confirmed = true;
      taskFile.confirmedAt = new Date().toISOString();
      void invoke('write_text_file', { path: target.taskPath, content: JSON.stringify(taskFile, null, 2) })
        .then(() => renderAdaptTaskPreview(target, taskFile))
        .catch((e: unknown) => { go.textContent = '确认失败：' + String(e).slice(0, 50); });
    });
  }
  const edit = document.getElementById('adapt-task-edit');
  if (edit) {
    edit.addEventListener('click', () => {
      const ta = document.getElementById('adapt-fb') as HTMLTextAreaElement | null;
      if (ta) {
        ta.value = taskFile.task.rawFeedback;
        ta.focus();
      }
    });
  }
}

function bindAdaptFeedback(session: FileSession): void {
  const btn = document.getElementById('adapt-fb-save');
  if (!btn) return;
  /* 已有任务单（含已确认态）时先渲染，教师能看见上次的确认结果 */
  const target = adaptTargetOf(session.sourcePath);
  if (target) {
    void invoke<string>('read_text_file', { path: target.taskPath })
      .then((json) => renderAdaptTaskPreview(target, JSON.parse(json) as AdaptTaskFile))
      .catch(() => { /* 有意兜底：任务单文件还不存在=教师没写过反馈的正常初始态，预览区不显示 */ });
  }
  btn.addEventListener('click', () => {
    const ta = document.getElementById('adapt-fb') as HTMLTextAreaElement | null;
    const text = (ta?.value ?? '').trim();
    const tgt = adaptTargetOf(session.sourcePath);
    if (!text || !tgt) return;
    /* 反馈与任务单同一份解析（core.planRevisionTask），App 与 CLI --plan 渲染一致 */
    const taskFile: AdaptTaskFile = {
      task: planRevisionTask(tgt.chapDir, 'R1', text),
      confirmed: false,
    };
    void invoke('write_text_file', { path: tgt.feedbackPath, content: JSON.stringify({ text, at: new Date().toISOString() }, null, 2) })
      .then(() => invoke('write_text_file', { path: tgt.taskPath, content: JSON.stringify({ ...taskFile, createdAt: new Date().toISOString() }, null, 2) }))
      .then(() => {
        ta!.value = '';
        renderAdaptTaskPreview(tgt, taskFile);
        btn.textContent = '✓ 已生成任务单';
        setTimeout(() => (btn.textContent = '保存反馈并生成修订任务单'), 2000);
      })
      .catch((e: unknown) => {
        btn.textContent = '保存失败：' + String(e).slice(0, 60);
        setTimeout(() => (btn.textContent = '保存反馈并生成修订任务单'), 3500);
      });
  });
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
