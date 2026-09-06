/**
 * LayerText 分层读 · 审校工作台 v0.2
 * 多版本文件 tab → 三态高亮正文 → 点词/拖选句标记 → 侧栏（配额/门禁/清单）→ 标记自动落盘。
 */

import { invoke } from '@tauri-apps/api/core';
import { open as openFileDialog, save as saveFileDialog } from '@tauri-apps/plugin-dialog';
import bundledWordlist from '../../assets/wordlists/curriculum_2022_level3_1600.txt?raw';
import exampleMd from '../../examples/texts/aesop_tortoise_hare.md?raw';
import exampleVocab from '../../examples/vocab/sample_teaching_vocab.csv?raw';
import { buildLexicon, type Lexicon } from '../../src/core/lexicon.js';
import { IRR } from '../../src/core/irregular.js';
import { runQc, toLegacyReport, type QcResult, type Tier } from '../../src/core/qc.js';
import {
  extractParas, hitOrigin, hit, pendHit, sentsOf, splitChapter, tokenizeTxt, cardGlossWords,
} from '../../src/core/textpipe.js';
import { sentenceRisks } from '../../src/core/risks.js';
import { jumpTo, refreshMarkDom, removeMarkDom, renderSidebar, restoreAllMarkDom, scheduleSave } from './review.js';
import {
  GATES, SENT_TYPES, WORD_TYPES, newMarkId, newReviewState, typeLabel,
  type FileSession, type Mark, type MarkType,
} from './types.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/* ---------- 全局状态 ---------- */

let sessions: FileSession[] = [];
let activeIdx = -1;
let vocabCsvText: string | null = null;
let vocabName = '';
let termsText: string | null = null;
/** 当前会话的合并已知词表（含词句卡），供词面板显示原形 */
let currentKnown: Set<string> = new Set();

function activeSession(): FileSession | null {
  return activeIdx >= 0 ? sessions[activeIdx] : null;
}

function buildLexiconNow(): Lexicon {
  return buildLexicon({
    vocabCsvTexts: vocabCsvText ? [vocabCsvText] : [],
    plainWordlistTexts: [bundledWordlist],
    terms: termsText ? termsText.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')) : [],
  });
}

function setStatus(msg: string, cls = ''): void {
  $('status').innerHTML = msg ? `<span class="${cls}">${esc(msg)}</span>` : '';
}

function fileSummary(): void {
  const s = activeSession();
  const parts: string[] = [];
  parts.push(s ? `当前：${s.fileName}` : '未载入文本');
  parts.push('词库：课标1600（内置）');
  if (vocabCsvText) parts.push(`+ ${vocabName}`);
  if (termsText) parts.push('+ 术语表');
  parts.push('标记自动保存：' + (s ? s.markPath : '打开文件后生效'));
  setStatus(parts.join(' ｜ '));
}

/* ---------- 会话管理 ---------- */

async function markPathFor(sourcePath: string | null, fileName: string): Promise<string> {
  if (sourcePath) {
    const dir = sourcePath.slice(0, sourcePath.lastIndexOf('/'));
    const base = fileName.replace(/\.(md|txt|markdown)$/i, '');
    return `${dir}/${base}_审校标记.json`;
  }
  const dir = await invoke<string>('reports_dir');
  return `${dir}/示例_审校标记.json`;
}

async function addSession(md: string, fileName: string, sourcePath: string | null): Promise<void> {
  const same = sessions.findIndex((s) => s.sourcePath === sourcePath && s.fileName === fileName);
  if (same >= 0) {
    activeIdx = same;
    renderAll();
    return;
  }
  const markPath = await markPathFor(sourcePath, fileName);
  const review = newReviewState(fileName);
  try {
    const saved = await invoke<string>('read_text_file', { path: markPath });
    const parsed = JSON.parse(saved);
    if (parsed && Array.isArray(parsed.marks)) {
      review.marks = parsed.marks;
      review.quota = parsed.quota ?? [];
      review.gate = parsed.gate ?? {};
    }
  } catch {
    /* 无历史标记，正常 */
  }
  sessions.push({ md, fileName, sourcePath, markPath, review, report: null, reportSavedPath: null, dirty: false });
  activeIdx = sessions.length - 1;
  renderAll();
}

function closeSession(i: number): void {
  sessions.splice(i, 1);
  activeIdx = Math.min(activeIdx, sessions.length - 1);
  renderAll();
}

/* ---------- 渲染 ---------- */

function renderAll(): void {
  renderFileTabs();
  const s = activeSession();
  if (!s) {
    $('reader').innerHTML = '<div class="empty">尚未载入文本<br/>点击上方「载入示例」或「打开章节文件…」</div>';
    $('pane-report').innerHTML = '<div class="empty">尚未运行质检</div>';
    $('sidebar').innerHTML = '<div class="side-empty">打开文件后：要点配额 / 终审门禁 / 标记清单</div>';
    hidePop();
    fileSummary();
    return;
  }
  renderReader(s);
  renderReportPane(s);
  renderSidebar(s, sidebarHandlers);
  fileSummary();
}

function renderFileTabs(): void {
  const el = $('filetabs');
  if (sessions.length === 0) {
    el.innerHTML = '<span class="hint">可同时打开同一文本的多个难度版本（B/M/A 各一个文件）并排切换</span>';
    return;
  }
  el.innerHTML = sessions
    .map(
      (s, i) =>
        `<span class="ftab ${i === activeIdx ? 'active' : ''}" data-ftab="${i}">${esc(s.fileName)}<span class="x" data-ftab-close="${i}" title="关闭">×</span></span>`,
    )
    .join('');
  el.querySelectorAll('[data-ftab]').forEach((t) =>
    t.addEventListener('click', (e) => {
      const x = (e.target as HTMLElement).closest('[data-ftab-close]');
      if (x) return;
      activeIdx = Number((t as HTMLElement).dataset.ftab);
      renderAll();
    }),
  );
  el.querySelectorAll('[data-ftab-close]').forEach((x) =>
    x.addEventListener('click', () => closeSession(Number((x as HTMLElement).dataset.ftabClose))),
  );
}

function badge(text: string): HTMLElement {
  const b = document.createElement('sup');
  b.className = 'badge';
  b.textContent = text;
  return b;
}

function renderReader(session: FileSession): void {
  const reader = $('reader');
  let body: string;
  try {
    body = splitChapter(session.md).body;
  } catch (e) {
    reader.innerHTML = `<div class="empty">文件格式不符：${esc((e as Error).message)}<br/>需要包含 "## Chapter One" 章节标记与 [P01] 段落标记</div>`;
    return;
  }
  const lex = buildLexiconNow();
  const card = splitChapter(session.md).card;
  currentKnown = new Set([...lex.known, ...IRR, ...cardGlossWords(card)]);
  const terms = new Set(
    (termsText ?? '').split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#')),
  );

  reader.replaceChildren();
  extractParas(body).forEach((p, pi) => {
    const div = document.createElement('div');
    div.className = 'para';
    const pid = document.createElement('span');
    pid.className = 'pid';
    pid.textContent = 'P' + String(pi + 1).padStart(2, '0');
    div.appendChild(pid);
    sentsOf(p, false).forEach((sent, si) => {
      const s = document.createElement('span');
      s.className = 'sent';
      s.dataset.pi = String(pi);
      s.dataset.si = String(si);
      s.dataset.text = sent.slice(0, 60);
      const risk = sentenceRisks(sent);
      if (risk.overlong || risk.passive || risk.relcl || risk.pastperf) {
        s.classList.add('risk');
        if (risk.passive) s.appendChild(badge('被'));
        if (risk.relcl) s.appendChild(badge('从'));
        if (risk.pastperf) s.appendChild(badge('完'));
        if (risk.overlong) s.appendChild(badge('长'));
      }
      const toks = tokenizeTxt(sent);
      const rawWords = sent.match(/[A-Za-z][A-Za-z'\-]*/g) ?? [];
      let rest = sent;
      for (let i = 0; i < rawWords.length; i++) {
        const raw = rawWords[i];
        const at = rest.indexOf(raw);
        if (at > 0) s.appendChild(document.createTextNode(rest.slice(0, at)));
        const w = document.createElement('span');
        const tok = toks[i] ?? raw.toLowerCase();
        const cls = terms.has(tok) ? 'term' : pendHit(tok, lex.pending) ? 'pending' : hit(tok, currentKnown) ? '' : 'oov';
        w.className = 'w' + (cls ? ' ' + cls : '');
        w.dataset.wi = String(i);
        w.dataset.tok = tok;
        w.dataset.state = cls || 'known';
        w.textContent = raw;
        const label = cls === 'oov' ? '词表外' : cls === 'pending' ? '待定词' : cls === 'term' ? '术语' : '已知';
        w.title = `${raw} · ${label}`;
        s.appendChild(w);
        rest = rest.slice(at + raw.length);
      }
      s.appendChild(document.createTextNode(rest));
      div.appendChild(s);
      div.appendChild(document.createTextNode(' '));
    });
    reader.appendChild(div);
  });
  restoreAllMarkDom(session);
}

/* ---------- 标记动作 ---------- */

function addMark(session: FileSession, mark: Mark): void {
  session.review.marks.push(mark);
  refreshMarkDom(mark);
  renderSidebar(session, sidebarHandlers);
  scheduleSave(session, (st, detail) => {
    if (st === 'dirty') setStatus('标记待保存…', 'dirty');
    else if (st === 'saved') setStatus('✓ 标记已自动保存：' + detail, 'saved');
    else setStatus('标记保存失败：' + detail, 'err');
  });
}

function removeMark(session: FileSession, m: Mark): void {
  session.review.marks = session.review.marks.filter((x) => x.id !== m.id);
  removeMarkDom(m);
  renderSidebar(session, sidebarHandlers);
  scheduleSave(session, () => undefined);
}

const sidebarHandlers = {
  onQuotaToggle: (i: number) => {
    const s = activeSession();
    if (!s) return;
    s.review.quota[i].done = !s.review.quota[i].done;
    renderSidebar(s, sidebarHandlers);
    scheduleSave(s, () => undefined);
  },
  onQuotaRemove: (i: number) => {
    const s = activeSession();
    if (!s) return;
    s.review.quota.splice(i, 1);
    renderSidebar(s, sidebarHandlers);
    scheduleSave(s, () => undefined);
  },
  onQuotaAdd: (text: string) => {
    const s = activeSession();
    if (!s) return;
    s.review.quota.push({ text, done: false });
    renderSidebar(s, sidebarHandlers);
    scheduleSave(s, () => undefined);
  },
  onGateToggle: (g: string) => {
    const s = activeSession();
    if (!s) return;
    s.review.gate[g] = !s.review.gate[g];
    renderSidebar(s, sidebarHandlers);
    scheduleSave(s, () => undefined);
  },
  onMarkJump: (m: Mark) => jumpTo(m),
  onMarkRemove: (m: Mark) => {
    const s = activeSession();
    if (s) removeMark(s, m);
  },
};

/* ---------- 弹层面板 ---------- */

const pop = $('pop');
let popSession: FileSession | null = null;

function hidePop(): void {
  pop.classList.remove('open');
  popSession = null;
}

function placePop(x: number, y: number): void {
  pop.classList.add('open');
  const rect = pop.getBoundingClientRect();
  const px = Math.min(Math.max(8, x), window.innerWidth - rect.width - 8);
  const py = Math.min(Math.max(8, y), window.innerHeight - rect.height - 8);
  pop.style.left = px + 'px';
  pop.style.top = py + 'px';
}

function marksAt(session: FileSession, level: 'word' | 'sent', pi: number, si: number, wi?: number): Mark[] {
  return session.review.marks.filter((m) =>
    m.level === level && m.pi === pi && m.si === si && (level === 'sent' || m.wi === wi),
  );
}

function renderPopMarks(existing: Mark[]): void {
  const box = pop.querySelector('.pop-marks');
  if (!box) return;
  box.innerHTML = existing.length
    ? existing
        .map(
          (m) =>
            `<span class="mchip">${typeLabel(m.type)}${m.note ? ' ✎' : ''}<button class="x" data-pop-rm="${m.id}" title="删除该标记">×</button></span>`,
        )
        .join('')
    : '<span style="color:var(--muted);font-size:12px">尚无标记</span>';
  box.querySelectorAll('[data-pop-rm]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const m = popSession?.review.marks.find((x) => x.id === (btn as HTMLElement).dataset.popRm);
      if (m && popSession) {
        removeMark(popSession, m);
        refreshPop('sent-or-word');
      }
    }),
  );
}

function refreshPop(_why: string): void {
  if (!popSession) return;
  const ctx = pop.dataset;
  const pi = Number(ctx.pi), si = Number(ctx.si), wi = ctx.wi === undefined ? undefined : Number(ctx.wi);
  const level = ctx.level as 'word' | 'sent';
  renderPopMarks(marksAt(popSession, level, pi, si, wi));
  // 类型按钮置灰已选项
  pop.querySelectorAll('[data-mk]').forEach((b) => {
    const t = (b as HTMLElement).dataset.mk!;
    const has = marksAt(popSession!, level, pi, si, wi).some((m) => m.type === t);
    (b as HTMLElement).style.opacity = has ? '.45' : '';
  });
}

function showWordPanel(session: FileSession, wEl: HTMLElement, x: number, y: number): void {
  popSession = session;
  const pi = Number(wEl.closest('.sent')!.dataset.pi);
  const si = Number(wEl.closest('.sent')!.dataset.si);
  const wi = Number(wEl.dataset.wi);
  const tok = wEl.dataset.tok!;
  const state = wEl.dataset.state;
  const origin = hitOrigin(tok, currentKnown);
  const stateLabel = state === 'oov' ? '<span class="warn">词表外（红）</span>'
    : state === 'pending' ? '<span class="warn">待定词（橙）—暂计已知，风险另计</span>'
    : state === 'term' ? '术语（蓝）' : '<span class="ok">词表内</span>';
  pop.dataset.level = 'word';
  pop.dataset.pi = String(pi);
  pop.dataset.si = String(si);
  pop.dataset.wi = String(wi);
  pop.innerHTML = `
    <div class="pop-h">${esc(wEl.textContent ?? '')}</div>
    <div class="pop-info">词表状态：${stateLabel}${origin && origin !== tok ? `<br/>词形还原原形：${esc(origin)}` : ''}</div>
    <div class="pop-marks"></div>
    <div class="pop-btns">${WORD_TYPES.map((t) => `<button data-mk="${t.key}">${t.label}</button>`).join('')}</div>
    <textarea id="pop-note" placeholder="备注（可选，随下一条标记保存）"></textarea>
    <div class="pop-tip">可连续标记多个类型；点击空白处关闭</div>`;
  bindTypeButtons(session, 'word', pi, si, wi);
  refreshPop('open');
  placePop(x, y);
}

function showSentPanel(session: FileSession, sentEl: HTMLElement, x: number, y: number, crossSentence: boolean): void {
  popSession = session;
  const pi = Number(sentEl.dataset.pi);
  const si = Number(sentEl.dataset.si);
  const text = sentsOf(extractParas(splitChapter(session.md).body)[pi], false)[si] ?? '';
  const wc = text.split(/\s+/).filter(Boolean).length;
  const risk = sentenceRisks(text);
  const riskBits = [
    risk.passive ? '被动' : '', risk.relcl ? '定从' : '', risk.pastperf ? '过去完成' : '',
    risk.overlong ? `超长(${wc}词)` : '',
  ].filter(Boolean).join(' / ');
  pop.dataset.level = 'sent';
  pop.dataset.pi = String(pi);
  pop.dataset.si = String(si);
  delete pop.dataset.wi;
  pop.innerHTML = `
    <div class="pop-h">句子标记（P${String(pi + 1).padStart(2, '0')} · 第${si + 1}句 · ${wc} 词）</div>
    <div class="pop-info">${esc(text.slice(0, 80))}${text.length > 80 ? '…' : ''}<br/>自动检测：${riskBits ? `<span class="warn">${riskBits}</span>` : '<span class="ok">未命中黑名单句法</span>'}${crossSentence ? '<br/>⚠ 跨句选择，仅标记所选末句' : ''}</div>
    <div class="pop-marks"></div>
    <div class="pop-btns">${SENT_TYPES.map((t) => `<button data-mk="${t.key}">${t.label}</button>`).join('')}</div>
    <textarea id="pop-note" placeholder="备注（可选，随下一条标记保存）"></textarea>`;
  bindTypeButtons(session, 'sent', pi, si);
  refreshPop('open');
  placePop(x, y);
}

function bindTypeButtons(session: FileSession, level: 'word' | 'sent', pi: number, si: number, wi?: number): void {
  pop.querySelectorAll('[data-mk]').forEach((b) =>
    b.addEventListener('click', () => {
      const type = (b as HTMLElement).dataset.mk as MarkType;
      const note = (pop.querySelector('#pop-note') as HTMLTextAreaElement | null)?.value.trim() || undefined;
      if (marksAt(session, level, pi, si, wi).some((m) => m.type === type)) return; // 已有同类型标记
      addMark(session, {
        id: newMarkId(), level, pi, si, ...(level === 'word' ? { wi } : {}),
        ...(level === 'word' ? { word: pop.querySelector('.pop-h')?.textContent ?? '' } : { text: sentsOf(extractParas(splitChapter(session.md).body)[pi], false)[si]?.slice(0, 40) ?? '' }),
        type, note, ts: Date.now(),
      });
      const ta = pop.querySelector('#pop-note') as HTMLTextAreaElement | null;
      if (ta) ta.value = '';
      refreshPop('marked');
    }),
  );
}

/* ---------- 质检 ---------- */

function tagFromPath(p: string): string {
  if (p.includes('A层')) return 'A';
  if (p.includes('v0.2')) return 'v02';
  return 'v01';
}

async function runQcCurrent(): Promise<void> {
  const s = activeSession();
  if (!s) { setStatus('请先载入文本', 'err'); return; }
  const tier = ($('tier') as HTMLSelectElement).value as Tier;
  try {
    s.report = runQc(s.md, buildLexiconNow(), { tier, fileName: s.fileName });
  } catch (e) {
    setStatus('质检失败：' + (e as Error).message, 'err');
    return;
  }
  let outPath: string;
  if (s.sourcePath) {
    const dir = s.sourcePath.slice(0, s.sourcePath.lastIndexOf('/'));
    outPath = `${dir}/质检报告_${tagFromPath(s.sourcePath)}.json`;
  } else {
    const dir = await invoke<string>('reports_dir');
    outPath = `${dir}/质检报告_示例.json`;
  }
  try {
    await invoke('write_text_file', { path: outPath, content: JSON.stringify(toLegacyReport(s.report), null, 1) });
    s.reportSavedPath = outPath;
    setStatus('质检完成，报告已自动保存：' + outPath, 'saved');
  } catch (e) {
    s.reportSavedPath = null;
    setStatus('质检完成，但报告落盘失败：' + e, 'err');
  }
  renderReportPane(s);
  switchView('report');
}

function renderReportPane(s: FileSession): void {
  const pane = $('pane-report');
  if (!s.report) {
    pane.innerHTML = '<div class="empty">尚未运行质检（点上方「▶ 质检本章」）</div>';
    return;
  }
  const legacy = toLegacyReport(s.report) as Record<string, unknown>;
  const rows = Object.entries(legacy).filter(([k]) => k !== 'OOV词(去重)');
  const oov = (legacy['OOV词(去重)'] as string[]) ?? [];
  const gatesNote =
    s.report.tier === 'A'
      ? `A 层解禁：被动${s.report.gates.passiveOk ? '已解禁' : '未解禁（第5章起解禁）'} · 定从${s.report.gates.relclOk ? '已解禁' : '未解禁（第8章起解禁）'}`
      : 'B/M 层：三项句法黑名单全时段计数';
  pane.innerHTML = `
    ${s.reportSavedPath ? `<div class="saved-path">报告已自动保存：${esc(s.reportSavedPath)} <button id="btn-reveal">在访达中显示</button></div>` : ''}
    <table class="report">
      ${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${Array.isArray(v) ? v.length + ' 个' : esc(String(v))}</td></tr>`).join('')}
      <tr><th>解禁门（A层）</th><td>${gatesNote}</td></tr>
    </table>
    <div style="font-weight:600;margin-bottom:8px">OOV 生词清单（去重 ${oov.length} 词）</div>
    <div class="oov-chips">${oov.map((w) => `<span class="chip">${esc(w)}</span>`).join('')}</div>`;
  document.getElementById('btn-reveal')?.addEventListener('click', () => {
    if (s.reportSavedPath) void invoke('reveal_path', { path: s.reportSavedPath });
  });
}

/* ---------- 视图切换 ---------- */

function switchView(name: 'text' | 'report'): void {
  for (const [id, pane] of [['tab-text', 'pane-text'], ['tab-report', 'pane-report']] as const) {
    $(id).classList.toggle('active', id === `tab-${name}`);
    $(pane).classList.toggle('active', pane === `pane-${name}`);
  }
}

/* ---------- 事件绑定 ---------- */

$('tab-text').addEventListener('click', () => switchView('text'));
$('tab-report').addEventListener('click', () => switchView('report'));

$('btn-demo').addEventListener('click', () => {
  if (!vocabCsvText) {
    vocabCsvText = exampleVocab;
    vocabName = '示例词库 sample_teaching_vocab.csv';
  }
  void addSession(exampleMd, 'aesop_tortoise_hare.md（示例）', null).then(() => {
    setStatus('已载入内置示例（含示例词库）。正文点词/拖选句子开始审校；「▶ 质检本章」看报告。');
  });
});

$('btn-open').addEventListener('click', async () => {
  const paths = await openFileDialog({
    multiple: true,
    filters: [{ name: '章节 Markdown / 文本', extensions: ['md', 'txt', 'markdown'] }],
  });
  const list = Array.isArray(paths) ? paths : paths ? [paths] : [];
  for (const p of list) {
    try {
      const md = await invoke<string>('read_text_file', { path: p });
      await addSession(md, p.slice(p.lastIndexOf('/') + 1), p);
    } catch (e) {
      setStatus('读取失败：' + e, 'err');
    }
  }
});

$('btn-vocab').addEventListener('click', async () => {
  const path = await openFileDialog({ multiple: false, filters: [{ name: '词库 CSV', extensions: ['csv'] }] });
  if (typeof path !== 'string') return;
  try {
    vocabCsvText = await invoke<string>('read_text_file', { path });
    vocabName = path.slice(path.lastIndexOf('/') + 1);
    renderAll();
  } catch (e) {
    setStatus('读取失败：' + e, 'err');
  }
});

$('btn-terms').addEventListener('click', async () => {
  const path = await openFileDialog({ multiple: false, filters: [{ name: '术语表 TXT（一行一词）', extensions: ['txt'] }] });
  if (typeof path !== 'string') return;
  try {
    termsText = await invoke<string>('read_text_file', { path });
    renderAll();
  } catch (e) {
    setStatus('读取失败：' + e, 'err');
  }
});

$('btn-run').addEventListener('click', () => void runQcCurrent());

$('btn-export').addEventListener('click', async () => {
  const s = activeSession();
  if (!s) { setStatus('请先载入文本', 'err'); return; }
  const path = await saveFileDialog({
    defaultPath: s.fileName.replace(/\.(md|txt|markdown)$/i, '') + '_审校标记.json',
    filters: [{ name: '审校标记 JSON', extensions: ['json'] }],
  });
  if (typeof path !== 'string') return;
  await invoke('write_text_file', { path, content: JSON.stringify(s.review, null, 1) });
  setStatus('标记已导出：' + path, 'saved');
});

$('btn-import').addEventListener('click', async () => {
  const s = activeSession();
  if (!s) { setStatus('请先载入文本', 'err'); return; }
  const path = await openFileDialog({ multiple: false, filters: [{ name: '审校标记 JSON', extensions: ['json'] }] });
  if (typeof path !== 'string') return;
  try {
    const parsed = JSON.parse(await invoke<string>('read_text_file', { path }));
    if (!Array.isArray(parsed?.marks)) throw new Error('不是有效的标记文件');
    const ids = new Set(s.review.marks.map((m) => m.id));
    let added = 0;
    for (const m of parsed.marks) if (!ids.has(m.id)) { s.review.marks.push(m); added++; }
    s.review.quota = [...s.review.quota, ...(parsed.quota ?? []).filter((q: { text: string }) => !s.review.quota.some((x) => x.text === q.text))];
    for (const g of GATES) if (parsed.gate?.[g] !== undefined) s.review.gate[g] = parsed.gate[g];
    renderAll();
    scheduleSave(s, () => undefined);
    setStatus(`已导入 ${added} 条标记（同 ID 去重合并）`, 'saved');
  } catch (e) {
    setStatus('导入失败：' + e, 'err');
  }
});

/* 正文词点击 → 词面板 */
$('reader').addEventListener('click', (e) => {
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return; // 拖选场景交给句面板
  const wEl = (e.target as HTMLElement).closest('.w');
  const s = activeSession();
  if (!wEl || !s) return;
  showWordPanel(s, wEl as HTMLElement, e.clientX + 8, e.clientY + 12);
});

/* 拖选 → 句面板 */
document.addEventListener('mouseup', (e) => {
  if ((e.target as HTMLElement).closest('#pop') || (e.target as HTMLElement).closest('#sidebar')) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return;
  const node = sel.focusNode;
  const host = (node?.nodeType === 3 ? node.parentElement : (node as HTMLElement | null));
  const sentEl = host?.closest('.sent');
  const s = activeSession();
  if (!sentEl || !s) return;
  const anchorSent = (sel.anchorNode?.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode as HTMLElement | null)?.closest('.sent');
  const cross = anchorSent !== sentEl;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  showSentPanel(s, sentEl as HTMLElement, rect.left, rect.bottom + 6, cross);
});

/* 点击空白关闭面板 */
document.addEventListener('mousedown', (e) => {
  if ((e.target as HTMLElement).closest('#pop')) return;
  if (pop.classList.contains('open')) hidePop();
});

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
