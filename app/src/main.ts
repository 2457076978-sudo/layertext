/**
 * LayerText 分层读 · 审校工作台 v0.2
 * 多版本文件 tab → 三态高亮正文 → 点词/拖选句标记 → 侧栏（配额/门禁/清单）→ 标记自动落盘。
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open as openFileDialog, save as saveFileDialog } from '@tauri-apps/plugin-dialog';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import * as XLSX from 'xlsx';
import bundledWordlist from '../../assets/wordlists/curriculum_2022_level3_1600.txt?raw';
import exampleMd from '../../examples/texts/aesop_tortoise_hare.md?raw';
import exampleVocab from '../../examples/vocab/sample_teaching_vocab.csv?raw';
import { parseCsv } from '../../src/core/lexicon.js';
import { buildLexicon, type Lexicon } from '../../src/core/lexicon.js';
import { IRR } from '../../src/core/irregular.js';
import { runQc, toLegacyReport, type QcResult, type Tier } from '../../src/core/qc.js';
import {
  extractParas, hitOrigin, hit, pendHit, sentsOf, splitChapter, tokenizeTxt, cardGlossWords,
} from '../../src/core/textpipe.js';
import { sentenceRisks } from '../../src/core/risks.js';
import { jumpTo, refreshMarkDom, removeMarkDom, renderSidebar, restoreAllMarkDom, scheduleSave } from './review.js';
import {
  CHANGELOG_HEADER, GATES, GATE_HELP, SENT_TYPES, TIER_MAX_LEN, WORD_TYPES, newMarkId, newReviewState, typeLabel,
  type FileSession, type Mark, type MarkType, type Suggestion,
} from './types.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/* ---------- 全局状态 ---------- */

let sessions: FileSession[] = [];
let activeIdx = -1;
let vocabCsvText: string | null = null;
let vocabName = '';
let termsText: string | null = null;
/** 专名表原始行（保留大小写与空格短语：既并入已知词，也作 ⑧ 专名一致性检查名单） */
let properRows: string[] = [];
/** 本地示例目录的附加词表（如原型项目的中考1600按词性分类表） */
let extraWordlistText: string | null = null;
/** 当前会话的合并已知词表（含词句卡），供词面板显示原形 */
let currentKnown: Set<string> = new Set();

function activeSession(): FileSession | null {
  return activeIdx >= 0 ? sessions[activeIdx] : null;
}

function buildLexiconNow(): Lexicon {
  return buildLexicon({
    vocabCsvTexts: vocabCsvText ? [vocabCsvText] : [],
    plainWordlistTexts: extraWordlistText ? [bundledWordlist, extraWordlistText] : [bundledWordlist],
    terms: termsText ? termsText.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')) : [],
    properNouns: properRows.map((r) => r.toLowerCase()),
  });
}

/** 章号：从路径识别（第一章→1），与 CLI/原型一致 */
const CH_MAP: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function chnoFromPath(p: string): number | null {
  for (const [k, v] of Object.entries(CH_MAP)) if (p.includes(`第${k}章`)) return v;
  return null;
}

/* ---------- 词表导入：宽容格式 ---------- */

/** 把任意格式的词表文件读成标准词库 CSV 文本。
 *  支持：①标准 CSV（表头含"词/word/单词"列）②无表头 CSV/TSV（每行首字段为词）
 *       ③TXT 一行一词 ④Excel .xlsx/.xls（第一列）。
 *  非标准来源的词一律按"单词"类型计入已知。 */
async function readVocabAsCsv(path: string): Promise<string> {
  const lower = path.toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    const b64 = await invoke<string>('read_file_base64', { path });
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const wb = XLSX.read(bin, { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const words = (XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false }) as unknown as string[][])
      .map((row) => (row?.[0] ?? '').toString().trim())
      .filter((w) => w && !w.startsWith('#'));
    return words.map((w) => `${w},单词,,,,,,`).join('\n');
  }
  const text = await invoke<string>('read_text_file', { path });
  const rows = parseCsv(text.replace(/^\uFEFF/, ''));
  if (rows.length === 0) return '';
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const hasWordCol = header.some((h) => h === '词' || h === 'word' || h === '单词' || h === '词汇');
  if (hasWordCol) return text; // 标准格式，直接使用
  // 无表头：每行取首字段（兼容 CSV/TSV/分号/纯文本），按"单词"类型导入
  const words = rows
    .map((r) => (r[0] ?? '').split(/[\t;；,，]/)[0].trim())
    .filter((w) => /^[A-Za-z][A-Za-z'\- ]*[A-Za-z]$/.test(w));
  return words.map((w) => `${w},单词,,,,,,`).join('\n');
}

async function importVocabFile(): Promise<void> {
  const path = await openFileDialog({
    multiple: false,
    filters: [{ name: '词表（CSV / TXT / Excel）', extensions: ['csv', 'txt', 'tsv', 'xlsx', 'xls'] }],
  });
  if (typeof path !== 'string') return;
  try {
    vocabCsvText = await readVocabAsCsv(path);
    vocabName = path.slice(path.lastIndexOf('/') + 1);
    renderAll();
    setStatus(`已导入词库：${vocabName}（${vocabCsvText.split('\n').filter(Boolean).length} 行）`, 'saved');
  } catch (e) {
    setStatus('词库读取失败：' + e, 'err');
  }
}

async function importTermsFile(): Promise<void> {
  const path = await openFileDialog({ multiple: false, filters: [{ name: '术语表 TXT（一行一词）', extensions: ['txt'] }] });
  if (typeof path !== 'string') return;
  try {
    termsText = await invoke<string>('read_text_file', { path });
    renderAll();
    setStatus('已导入术语表：' + path.slice(path.lastIndexOf('/') + 1), 'saved');
  } catch (e) {
    setStatus('读取失败：' + e, 'err');
  }
}

async function importProperFile(): Promise<void> {
  const path = await openFileDialog({ multiple: false, filters: [{ name: '专名表 TXT（一行一名，可含空格短语）', extensions: ['txt'] }] });
  if (typeof path !== 'string') return;
  try {
    const text = await invoke<string>('read_text_file', { path });
    properRows = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    renderAll();
    setStatus(`已导入专名表：${properRows.length} 个（⑧专名一致性检查同步启用）`, 'saved');
  } catch (e) {
    setStatus('读取失败：' + e, 'err');
  }
}

/** 从本地示例目录自动加载配套词库/术语表/专名表（_ 开头文件） */
async function loadLocalExampleConfig(): Promise<void> {
  try {
    const dir = await invoke<string>('examples_dir');
    const readIf = async (name: string): Promise<string | null> => {
      try {
        return await invoke<string>('read_text_file', { path: `${dir}/${name}` });
      } catch {
        return null;
      }
    };
    const vocab = await readIf('_词库.csv');
    if (vocab) {
      vocabCsvText = vocab;
      vocabName = '_词库.csv（本地示例）';
    }
    const extraWl = await readIf('_词表.txt');
    if (extraWl) extraWordlistText = extraWl;
    const terms = await readIf('_术语表.txt');
    if (terms) termsText = terms;
    const proper = await readIf('_专名表.txt');
    if (proper) {
      properRows = proper.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    }
  } catch {
    /* 目录不可用则跳过 */
  }
}

/** 按文件名联动层级（含 A层/A版 → A；B版 → B；默认 M） */
function autoTierFromName(name: string): void {
  const sel = $('tier') as HTMLSelectElement;
  if (/A层|A版|A挑战/.test(name)) sel.value = 'A';
  else if (/B版|B层/.test(name)) sel.value = 'B';
  else sel.value = 'M';
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
  chatMsgs = [];       // 换章节清空对话（上下文以文件为准）
  aiHistory = [];
  suggestions = [];
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
    $('side-review').innerHTML = '<div class="side-empty">打开文件后：要点配额 / 终审门禁 / 标记清单</div>';
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
  const terms = new Set<string>([
    ...(termsText ?? '').split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#')),
    ...properRows.map((r) => r.toLowerCase()),
  ]);

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
  onGateHelp: (g: string, anchor: HTMLElement) => showGateHelp(g, anchor),
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
    s.report = runQc(s.md, buildLexiconNow(), {
      tier,
      fileName: s.fileName,
      chno: s.sourcePath ? chnoFromPath(s.sourcePath) : null,
      ...(properRows.length ? { propCheckList: properRows } : {}),
    });
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

function switchView(name: 'text' | 'report' | 'suggest'): void {
  const map = [['tab-text', 'pane-text'], ['tab-report', 'pane-report'], ['tab-suggest', 'pane-suggest']] as const;
  for (const [id, pane] of map) {
    $(id).classList.toggle('active', id === `tab-${name}`);
    $(pane).classList.toggle('active', pane === `pane-${name}`);
  }
}

/* ---------- 事件绑定 ---------- */

$('tab-text').addEventListener('click', () => switchView('text'));
$('tab-report').addEventListener('click', () => switchView('report'));
$('tab-suggest').addEventListener('click', () => switchView('suggest'));

/* ---------- 示例菜单 ---------- */

let demoMenuOpen = false;

async function openDemoMenu(): Promise<void> {
  const menu = $('demo-menu');
  let locals: string[] = [];
  try {
    locals = await invoke<string[]>('list_local_examples');
  } catch {
    /* 目录不可用 */
  }
  if (locals.length === 0) {
    loadBuiltinDemo();
    return;
  }
  const btn = $('btn-demo').getBoundingClientRect();
  menu.style.left = btn.left + 'px';
  menu.style.top = btn.bottom + 6 + 'px';
  menu.innerHTML = `
    <div class="demo-group">内置示例（随应用分发，CC0）</div>
    <div class="demo-item" data-demo="builtin">龟兔赛跑（含示例词库）</div>
    <div class="demo-group">本地示例（文稿/LayerText示例/，自动带词库与术语配置）</div>
    ${locals.map((p) => `<div class="demo-item" data-demo-path="${esc(p)}">${esc(p.slice(p.lastIndexOf('/') + 1))}</div>`).join('')}
    <div class="demo-tip">把章节 md 与 _词库.csv / _术语表.txt / _专名表.txt 放入该文件夹即可出现在这里</div>`;
  menu.classList.add('open');
  demoMenuOpen = true;
  menu.querySelectorAll('[data-demo]').forEach((el) =>
    el.addEventListener('click', () => {
      closeDemoMenu();
      loadBuiltinDemo();
    }),
  );
  menu.querySelectorAll('[data-demo-path]').forEach((el) =>
    el.addEventListener('click', async () => {
      closeDemoMenu();
      const path = (el as HTMLElement).dataset.demoPath!;
      try {
        await loadLocalExampleConfig();
        const md = await invoke<string>('read_text_file', { path });
        const name = path.slice(path.lastIndexOf('/') + 1);
        autoTierFromName(name);
        await addSession(md, name, path);
        setStatus('已载入本地示例：' + name + (vocabCsvText ? '（词库已自动加载）' : ''));
      } catch (e) {
        setStatus('载入失败：' + e, 'err');
      }
    }),
  );
}

function closeDemoMenu(): void {
  $('demo-menu').classList.remove('open');
  demoMenuOpen = false;
}

function loadBuiltinDemo(): void {
  if (!vocabCsvText) {
    vocabCsvText = exampleVocab;
    vocabName = '示例词库 sample_teaching_vocab.csv';
  }
  void addSession(exampleMd, 'aesop_tortoise_hare.md（示例）', null).then(() => {
    setStatus('已载入内置示例（含示例词库）。正文点词/拖选句子开始审校；「▶ 质检本章」看报告。');
  });
}

$('btn-demo').addEventListener('click', () => {
  if (demoMenuOpen) closeDemoMenu();
  else void openDemoMenu();
});
document.addEventListener('mousedown', (e) => {
  if (demoMenuOpen && !(e.target as HTMLElement).closest('#demo-menu') && !(e.target as HTMLElement).closest('#btn-demo')) {
    closeDemoMenu();
  }
});

async function openChapterFiles(): Promise<void> {
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
}

async function exportMarks(): Promise<void> {
  const s = activeSession();
  if (!s) { setStatus('请先载入文本', 'err'); return; }
  const path = await saveFileDialog({
    defaultPath: s.fileName.replace(/\.(md|txt|markdown)$/i, '') + '_审校标记.json',
    filters: [{ name: '审校标记 JSON', extensions: ['json'] }],
  });
  if (typeof path !== 'string') return;
  await invoke('write_text_file', { path, content: JSON.stringify(s.review, null, 1) });
  setStatus('标记已导出：' + path, 'saved');
}

async function importMarks(): Promise<void> {
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
}

$('btn-open').addEventListener('click', () => void openChapterFiles());
$('btn-run').addEventListener('click', () => void runQcCurrent());

/* 原生菜单事件分发 */
void listen<string>('menu-action', (ev) => {
  switch (ev.payload) {
    case 'file-open': void openChapterFiles(); break;
    case 'file-demo': demoMenuOpen ? closeDemoMenu() : void openDemoMenu(); break;
    case 'conf-vocab': void importVocabFile(); break;
    case 'conf-terms': void importTermsFile(); break;
    case 'conf-proper': void importProperFile(); break;
    case 'marks-export': void exportMarks(); break;
    case 'marks-import': void importMarks(); break;
    case 'qc-run': void runQcCurrent(); break;
    case 'view-text': switchView('text'); break;
    case 'view-report': switchView('report'); break;
    case 'ai-settings': showAiSettings(); break;
    case 'ai-suggest': void aiSuggest(); break;
  }
});

/* ================= AI 审核建议（AI 只出候选，教师握定稿权） ================= */

let suggestions: Suggestion[] = [];
/** 当前 AI 会话历史（同章节内"按指令调整"时携带；应用修订或切换会话后清空） */
let aiHistory: { role: 'user' | 'assistant'; content: string }[] = [];
const aiPop = $('ai-pop');

function showAiSettings(): void {
  aiPop.innerHTML = `
    <div class="pop-h">AI 设置（OpenAI 兼容接口）</div>
    <div class="fld"><label>API 地址（兼容 DeepSeek / 智谱 / Kimi / 通义等，填到 /v1）</label>
      <input id="ai-url" placeholder="https://api.openai.com/v1" /></div>
    <div class="fld"><label>模型名</label><input id="ai-model" placeholder="gpt-4o-mini" /></div>
    <div class="fld"><label>API Key（仅存本机钥匙串，不上传）</label><input id="ai-key" type="password" placeholder="sk-…" /></div>
    <div class="fld"><label>长期审校约定（每次请求自动附带，优先级最高——如"人名保留原文；第 3 段的名句不许改"）</label>
      <textarea id="ai-instructions" style="width:100%;height:56px;border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:12px;font-family:inherit;resize:vertical;"></textarea></div>
    <div class="row-btns">
      <button id="ai-save" class="primary">保存</button>
      <button id="ai-test">测试连接</button>
      <button id="ai-close">关闭</button>
    </div>
    <div class="test-out" id="ai-test-out"></div>
    <div class="hint-txt">说明：AI 只负责给出修订候选；每条候选都会经本地质检引擎复核（改写后是否仍命中句法黑名单/超长），最终是否采用由你在「修订建议」页勾选。全文数据不出本机，仅把标记相关句子发送给你配置的 API。</div>`;
  aiPop.classList.add('open');
  void (async () => {
    try {
      const [cfg, key] = await Promise.all([invoke<Record<string, string>>('load_api_config'), invoke<string>('load_api_key')]);
      ($('ai-url') as HTMLInputElement).value = cfg.baseUrl ?? '';
      ($('ai-model') as HTMLInputElement).value = cfg.model ?? '';
      ($('ai-key') as HTMLInputElement).value = key ?? '';
      ($('ai-instructions') as HTMLTextAreaElement).value = cfg.instructions ?? '';
    } catch { /* 留空 */ }
  })();
  $('ai-close').addEventListener('click', () => aiPop.classList.remove('open'));
  $('ai-save').addEventListener('click', async () => {
    await invoke('save_api_config', {
      baseUrl: ($('ai-url') as HTMLInputElement).value.trim(),
      model: ($('ai-model') as HTMLInputElement).value.trim(),
      instructions: ($('ai-instructions') as HTMLTextAreaElement).value.trim(),
    });
    const key = ($('ai-key') as HTMLInputElement).value.trim();
    if (key) await invoke('save_api_key', { key });
    $('ai-test-out').textContent = '✓ 已保存（Key 存入本机钥匙串）';
  });
  $('ai-test').addEventListener('click', async () => {
    const out = $('ai-test-out');
    out.textContent = '连接中…';
    try {
      const { content, usage } = await callChat(
        [{ role: 'system', content: '只回复两个字：正常' }, { role: 'user', content: 'ping' }], 8,
      );
      out.textContent = '✓ 连接成功：' + content.slice(0, 40) + ' ' + usage;
    } catch (e) {
      out.textContent = '✗ 连接失败：' + e;
    }
  });
}

document.addEventListener('mousedown', (e) => {
  if (aiPop.classList.contains('open') && !(e.target as HTMLElement).closest('#ai-pop')) aiPop.classList.remove('open');
});

async function callChat(messages: { role: string; content: string }[], maxTokens: number): Promise<{ content: string; usage: string }> {
  const cfg = await invoke<Record<string, string>>('load_api_config');
  const key = await invoke<string>('load_api_key');
  if (!key) throw new Error('未配置 API Key（菜单 LayerText → AI 设置）');
  const base = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = cfg.model || 'gpt-4o-mini';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  try {
    const resp = await tauriFetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, temperature: 0.3, max_tokens: maxTokens, messages }),
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data = (await resp.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const u = data.usage;
    const usage = u ? `（消耗 ${u.prompt_tokens ?? '?'} 入 + ${u.completion_tokens ?? '?'} 出 = ${u.total_tokens ?? '?'} tokens）` : '';
    return { content: data.choices?.[0]?.message?.content ?? '', usage };
  } finally {
    clearTimeout(timer);
  }
}

/** 组装 system 提示词（含用户的长期审校约定） */
async function buildSystemPrompt(): Promise<string> {
  const cfg = await invoke<Record<string, string>>('load_api_config');
  const custom = (cfg.instructions ?? '').trim();
  return AI_SYSTEM_PROMPT + (custom ? `\n\n6. 教师的长期审校约定（优先级最高）：\n${custom}` : '');
}

/** 内置提示词模板：词库边界 + 句法黑名单 + 句长上限 + 方法论约束 */
const AI_SYSTEM_PROMPT = `你是初中英语原著分层简化的审校助手，帮助教师按学生水平改写英文文本。严格遵守：
1. 词汇边界：替换目标词时优先使用中国《义务教育英语课程标准》三级（初中毕业要求，约1600词）范围内的词；专有名词与既定术语表词汇保持不变。
2. 句法黑名单（除直接引语内的原话）：被动语态→改主动；定语从句→拆成短句或用形容词前置；过去完成时→一般过去时并用 before/after 明示先后。
3. 句长上限：改写后的句子不超过指定词数上限；宁可拆成两句。
4. 保真：不改变情节、事实、人物与语气；好词保留/好句锚点类标记不要改写，直接返回 original 原文并在 basis 里说明建议保留。
5. 你只出候选：输出修订建议供教师勾选，不是最终稿。
输出格式：只输出一个 JSON 数组，不要任何其他文字。每个元素：
{"id":"标记ID","type":"标记类型","original":"原句原文（一字不改）","revised":"建议改写后的完整句子","basis":"依据（中文，一句话）","alternative":"可选的备选改写（可省略）"}`;

function buildAiUserPrompt(session: FileSession, tier: Tier): string {
  const body = splitChapter(session.md).body;
  const paras = extractParas(body);
  const maxLen = TIER_MAX_LEN[tier] ?? 16;
  const r = session.report;
  const gates = r?.gates ?? { passiveOk: tier !== 'A', relclOk: tier !== 'A' };
  const marks = session.review.marks.map((m) => {
    const sent = sentsOf(paras[m.pi] ?? '', false)[m.si] ?? '(未找到句子)';
    const label = m.level === 'word' ? `词标记：${m.word ?? ''}（${typeLabel(m.type)}${m.note ? '，备注：' + m.note : ''}）` : `句标记（${typeLabel(m.type)}${m.note ? '，备注：' + m.note : ''}）`;
    return `【${m.id}】${label}\n所在句：${sent}`;
  }).join('\n\n');
  return `层级：${tier}（句长上限 ${maxLen} 词/句；被动${gates.passiveOk ? '已解禁' : '禁用'}、定语从句${gates.relclOk ? '已解禁' : '禁用'}、过去完成一律改写）
${r ? `本章质检摘要：覆盖率 ${(r.coverage * 100).toFixed(1)}%，平均句长 ${r.avgLenNarrRaw.toFixed(1)} 词，被动 ${r.passive}、定从 ${r.relcl}、过去完成 ${r.pastperf}，超20词句 ${r.over20}` : ''}

教师标记清单（逐条给修订建议）：
${marks || '（无标记）'}`;
}

/** 估算 token（英文≈4字符/词符，中文≈1.6字） */
function estTokens(s: string): number {
  const cjk = (s.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const rest = s.length - cjk;
  return Math.round(cjk * 1.6 + rest / 3.5);
}

/**
 * 请求 AI 修订候选。
 * instruction 传入 = 会话式追问（携带 aiHistory，AI 知道上一轮建议过什么、你否决了什么）；
 * 不传 = 全新请求（上下文来自本地文件：标记清单+当前文本句子），并重建 aiHistory。
 */
async function aiSuggest(instruction?: string): Promise<void> {
  const s = activeSession();
  if (!s) { setStatus('请先载入文本', 'err'); return; }
  if (s.review.marks.length === 0 && !instruction) { setStatus('还没有标记——先在正文里点词/拖选句子做标记，AI 才知道往哪改', 'err'); return; }
  const key = await invoke<string>('load_api_key');
  if (!key) {
    setStatus('请先配置 AI（菜单 LayerText → AI 设置…）', 'err');
    showAiSettings();
    return;
  }
  const tier = (s.report?.tier ?? ($('tier') as HTMLSelectElement).value) as Tier;
  const btn = $('btn-ai');
  btn.textContent = '⏳ AI 请求中…';
  btn.disabled = true;
  try {
    const system = await buildSystemPrompt();
    let messages: { role: string; content: string }[];
    if (instruction && aiHistory.length > 0) {
      aiHistory.push({ role: 'user', content: instruction + '\n\n请基于我们之前的对话重新输出完整的 JSON 数组（含未改动条目，original 用当前正文原句）。' });
      messages = [{ role: 'system', content: system }, ...aiHistory];
    } else {
      const userMsg = buildAiUserPrompt(s, tier);
      aiHistory = [{ role: 'user', content: userMsg }];
      messages = [{ role: 'system', content: system }, { role: 'user', content: userMsg }];
    }
    const estIn = messages.reduce((n, m) => n + estTokens(m.content), 0);
    setStatus(`本次请求约 ${estIn} tokens 输入（只含标记相关句子，不发全章原文）…`);
    const { content, usage } = await callChat(messages, 4000);
    aiHistory.push({ role: 'assistant', content });
    const start = content.indexOf('[');
    const end = content.lastIndexOf(']');
    if (start < 0 || end <= start) throw new Error('AI 返回中未找到 JSON 数组');
    const raw = JSON.parse(content.slice(start, end + 1)) as { id: string; type?: string; original?: string; revised?: string; basis?: string; alternative?: string }[];
    const maxLen = TIER_MAX_LEN[tier] ?? 16;
    suggestions = raw
      .filter((x) => x.revised)
      .map((x) => {
        const risk = sentenceRisks(String(x.revised), maxLen);
        return {
          markId: String(x.id),
          type: x.type ?? '',
          original: String(x.original ?? ''),
          revised: String(x.revised),
          basis: x.basis ?? '',
          alternative: x.alternative,
          check: { passive: risk.passive, relcl: risk.relcl, pastperf: risk.pastperf, overlong: risk.overlong },
        };
      });
    renderSuggestions();
    switchView('suggest');
    setStatus(`AI 返回 ${suggestions.length} 条修订候选 ${usage}——采纳与否由你勾选`, 'saved');
  } catch (e) {
    setStatus('AI 请求失败：' + e, 'err');
  } finally {
    btn.textContent = '✨ AI 审核建议';
    btn.disabled = false;
  }
}

function checkLabel(c: Suggestion['check']): string {
  const bad: string[] = [];
  if (c.passive) bad.push('被动');
  if (c.relcl) bad.push('定从');
  if (c.pastperf) bad.push('过去完成');
  if (c.overlong) bad.push('超长');
  return bad.length ? `<span class="warn-badge">⚠ 仍含${bad.join('/')}</span>` : '<span class="ok-badge">✓ 复核通过</span>';
}

function renderSuggestions(): void {
  const pane = $('pane-suggest');
  if (suggestions.length === 0) {
    pane.innerHTML = '<div class="empty">暂无修订建议——点「✨ AI 审核建议」生成</div>';
    return;
  }
  pane.innerHTML = `
    <div class="sg-actions">
      <button id="sg-apply" class="primary">应用已勾选（0）→ 生成新版本 + 变更日志</button>
      <button id="sg-refresh">重新请求 AI</button>
      <span style="color:var(--muted);font-size:12px">默认全不勾；引擎复核 ⚠ 的条目请人工确认后再勾</span>
    </div>
    <table class="sgtable">
      <tr><th></th><th>标记</th><th class="orig">原句</th><th class="rev">AI 建议</th><th>引擎复核</th><th>依据</th></tr>
      ${suggestions.map((g, i) => `
        <tr>
          <td><input type="checkbox" data-sg="${i}" /></td>
          <td style="white-space:nowrap">${esc(g.type)}</td>
          <td class="orig" title="${esc(g.original)}">${esc(g.original.slice(0, 90))}${g.original.length > 90 ? '…' : ''}</td>
          <td class="rev" title="${esc(g.revised)}${g.alternative ? '&#10;备选：' + esc(g.alternative) : ''}">${esc(g.revised.slice(0, 90))}${g.revised.length > 90 ? '…' : ''}</td>
          <td>${checkLabel(g.check)}</td>
          <td>${esc(g.basis)}</td>
        </tr>`).join('')}
    </table>`;
  pane.querySelectorAll('[data-sg]').forEach((cb) =>
    cb.addEventListener('change', () => {
      const n = pane.querySelectorAll('[data-sg]:checked').length;
      ($('sg-apply') as HTMLElement).textContent = `应用已勾选（${n}）→ 生成新版本 + 变更日志`;
    }),
  );
  $('sg-refresh').addEventListener('click', () => void aiSuggest());
  $('sg-apply').addEventListener('click', () => void applySuggestions());
}

const RULE_BY_TYPE: Record<string, string> = {
  syntax: 'R03-R06', long: 'R07', ref: 'R05', cut: 'R01', stiff: 'R08',
  simpl: 'R02', zh: 'R02', oov: 'R02', hard: 'R02', factw: 'R00', others: 'R00', otherw: 'R00', fact: 'R00', goods: 'R11',
};

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

async function applySuggestions(): Promise<void> {
  const s = activeSession();
  if (!s) return;
  const checked = [...document.querySelectorAll<HTMLInputElement>('#pane-suggest [data-sg]:checked')].map((cb) => Number(cb.dataset.sg));
  if (checked.length === 0) { setStatus('请先勾选要采用的修订', 'err'); return; }
  let newMd = s.md;
  const appliedIds: string[] = [];
  const logRows: string[][] = [];
  const date = new Date().toLocaleDateString('sv-SE');
  const tier = (s.report?.tier ?? ($('tier') as HTMLSelectElement).value) as Tier;
  for (const i of checked) {
    const g = suggestions[i];
    const mark = s.review.marks.find((m) => m.id === g.markId);
    if (!mark) continue;
    const at = newMd.indexOf(g.original);
    if (at < 0) { logRows.push([`R?`, date, tier, `P${String(mark.pi + 1).padStart(2, '0')}`, `P${mark.pi + 1}-S${mark.si + 1}`, g.original, '(原句定位失败，未应用)', RULE_BY_TYPE[mark.type] ?? 'R00', g.basis, 'AI候选']); continue; }
    newMd = newMd.slice(0, at) + g.revised + newMd.slice(at + g.original.length);
    appliedIds.push(mark.id);
    logRows.push(['R1', date, tier, `P${String(mark.pi + 1).padStart(2, '0')}`, `P${mark.pi + 1}-S${mark.si + 1}`, g.original, g.revised, RULE_BY_TYPE[mark.type] ?? 'R00', g.basis, 'AI候选']);
  }
  if (!s.sourcePath) { setStatus('示例模式不支持应用修订——请打开真实章节文件', 'err'); return; }
  const dir = s.sourcePath.slice(0, s.sourcePath.lastIndexOf('/'));
  const base = s.fileName.replace(/\.(md|txt|markdown)$/i, '');
  const newPath = `${dir}/${base}_AI修订_${date}.md`;
  const logPath = `${dir}/变更日志_AI审核.csv`;
  try {
    await invoke('write_text_file', { path: newPath, content: newMd });
    let csv = '';
    try {
      csv = await invoke<string>('read_text_file', { path: logPath });
    } catch { csv = ''; }
    if (!csv.trim()) csv = CHANGELOG_HEADER.join(',') + '\n';
    csv += logRows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
    await invoke('write_text_file', { path: logPath, content: csv });
    // 移除已应用标记并落盘
    s.review.marks = s.review.marks.filter((m) => !appliedIds.includes(m.id));
    scheduleSave(s, () => undefined);
    aiHistory = [];    // 文本已变，旧建议对话作废
    // 新版本作为新 tab 打开
    await addSession(newMd, base + `_AI修订_${date}.md`, newPath);
    suggestions = suggestions.filter((g) => !appliedIds.includes(g.markId));
    renderSuggestions();
    setStatus(`已应用 ${appliedIds.length} 条修订：新版本 ${newPath}；变更日志 ${logPath}；对应标记已清除`, 'saved');
    void invoke('reveal_path', { path: newPath });
  } catch (e) {
    setStatus('应用失败：' + e, 'err');
  }
}

$('btn-ai').addEventListener('click', () => void aiSuggest());

/* ================= AI 助手（右侧对话 · 本应用即 harness：模型可调用本地 QC 工具） ================= */

interface ChatMsg {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}
let chatMsgs: ChatMsg[] = [];
let chatBusy = false;

const AI_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_marks',
      description: '列出本章当前全部审校标记（词/句、类型、备注、段落句索引）',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_chapter_stats',
      description: '对当前章节运行本地质检引擎，返回指标（覆盖率/生词率/句长/被动/定从/过去完成/超长句/OOV等）',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_sentence',
      description: '按段落号与句子号取正文原句及其句法风险检测（pi 从 0 起，si 从 0 起）',
      parameters: {
        type: 'object',
        properties: { pi: { type: 'integer' }, si: { type: 'integer' } },
        required: ['pi', 'si'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_text',
      description: '在当前章节正文中搜索包含指定英文词/短语的句子（按需查证，避免全文发送）',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_revision',
      description: '把一条修订候选提交到「修订建议」页（教师仍需逐条勾选确认才会应用）。original 必须与正文原句一字不差',
      parameters: {
        type: 'object',
        properties: {
          original: { type: 'string' }, revised: { type: 'string' },
          basis: { type: 'string' }, markId: { type: 'string' },
        },
        required: ['original', 'revised', 'basis'],
      },
    },
  },
];

async function chatStream(
  messages: { role: string; content: string; tool_calls?: unknown; tool_call_id?: string }[],
  onDelta: (t: string) => void,
): Promise<{ content: string; toolCalls: { id: string; name: string; arguments: string }[]; usage: string }> {
  const cfg = await invoke<Record<string, string>>('load_api_config');
  const key = await invoke<string>('load_api_key');
  if (!key) throw new Error('未配置 API Key（菜单 LayerText → AI 设置…）');
  const base = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = cfg.model || 'gpt-4o-mini';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000);
  try {
    const resp = await tauriFetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model, temperature: 0.3, max_tokens: 4000, messages, tools: AI_TOOLS,
        stream: true, stream_options: { include_usage: true },
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const reader = resp.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let content = '';
    let usage = '';
    const tc = new Map<number, { id: string; name: string; arguments: string }>();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const payload = s.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload) as {
            choices?: { delta?: { content?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          };
          const d = j.choices?.[0]?.delta;
          if (d?.content) { content += d.content; onDelta(d.content); }
          for (const c of d?.tool_calls ?? []) {
            const i = c.index ?? 0;
            const cur = tc.get(i) ?? { id: '', name: '', arguments: '' };
            if (c.id) cur.id = c.id;
            if (c.function?.name) cur.name += c.function.name;
            if (c.function?.arguments) cur.arguments += c.function.arguments;
            tc.set(i, cur);
          }
          if (j.usage) usage = `（本轮 ${j.usage.prompt_tokens ?? '?'} 入 + ${j.usage.completion_tokens ?? '?'} 出 tokens）`;
        } catch { /* 忽略半行 */ }
      }
    }
    return { content, toolCalls: [...tc.values()], usage };
  } finally {
    clearTimeout(timer);
  }
}

function executeTool(name: string, argsJson: string): string {
  const s = activeSession();
  if (!s) return '错误：当前未打开任何章节';
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(argsJson || '{}'); } catch { /* 空 */ }
  try {
    switch (name) {
      case 'list_marks':
        if (s.review.marks.length === 0) return '（无标记）';
        return s.review.marks
          .map((m) => `${m.id}｜${m.level === 'word' ? `词「${m.word}」` : `句`}｜${typeLabel(m.type)}｜P${m.pi + 1}-S${m.si + 1}${m.note ? '｜备注：' + m.note : ''}`)
          .join('\n');
      case 'get_chapter_stats': {
        const tier = (s.report?.tier ?? ($('tier') as HTMLSelectElement).value) as Tier;
        const r = runQc(s.md, buildLexiconNow(), { tier, fileName: s.fileName, chno: s.sourcePath ? chnoFromPath(s.sourcePath) : null });
        s.report = r;
        renderReportPane(s);
        return JSON.stringify({
          层级: r.tier, 段落数: r.paraCount, 句数: r.sentCount, 词符数: r.tokenCount,
          覆盖率: (r.coverage * 100).toFixed(1) + '%', 生词率: (r.newWordRate * 100).toFixed(1) + '%',
          平均句长: Number(r.avgLenNarrRaw.toFixed(1)), 最长句: r.maxLen, 超20词句数: r.over20,
          被动: r.passive, 定语从句: r.relcl, 过去完成: r.pastperf,
          待定词命中: r.pendingHits, OOV前20: [...new Set(r.oov)].slice(0, 20),
        });
      }
      case 'get_sentence': {
        const paras = extractParas(splitChapter(s.md).body);
        const sent = sentsOf(paras[Number(args.pi)] ?? '', false)[Number(args.si)];
        if (!sent) return `错误：P${Number(args.pi) + 1}-S${Number(args.si) + 1} 不存在`;
        const risk = sentenceRisks(sent);
        return JSON.stringify({ 句子: sent, 词数: sent.split(/\s+/).length, 被动: risk.passive, 定从: risk.relcl, 过去完成: risk.pastperf, 超长: risk.overlong });
      }
      case 'search_text': {
        const q = String(args.query ?? '').toLowerCase();
        if (!q) return '错误：query 为空';
        const hits: string[] = [];
        extractParas(splitChapter(s.md).body).forEach((p, pi) => {
          sentsOf(p, false).forEach((sent, si) => {
            if (sent.toLowerCase().includes(q) && hits.length < 8) {
              hits.push(`P${pi + 1}-S${si + 1}｜${sent}`);
            }
          });
        });
        return hits.length ? hits.join('\n') : `（未找到含 "${q}" 的句子）`;
      }
      case 'propose_revision': {
        const original = String(args.original ?? '');
        const revised = String(args.revised ?? '');
        if (!original || !revised) return '错误：original/revised 不能为空';
        if (!s.md.includes(original)) return '错误：original 与正文不匹配（须与正文原句一字不差），请先用 get_sentence/search_text 取原句';
        const tier = (s.report?.tier ?? ($('tier') as HTMLSelectElement).value) as Tier;
        const risk = sentenceRisks(revised, TIER_MAX_LEN[tier] ?? 16);
        suggestions.push({
          markId: String(args.markId ?? 'chat-' + Date.now().toString(36)),
          type: '对话建议', original, revised, basis: String(args.basis ?? ''),
          check: { passive: risk.passive, relcl: risk.relcl, pastperf: risk.pastperf, overlong: risk.overlong },
        });
        renderSuggestions();
        setStatus('AI 在对话中提交了 1 条修订候选（经引擎复核）——到「修订建议」页勾选确认', 'saved');
        return `已提交到修订建议页（引擎复核：${risk.passive || risk.relcl || risk.pastperf || risk.overlong ? '仍命中黑名单/超长，已标⚠' : '通过'}）。提醒教师勾选确认。`;
      }
      default:
        return `错误：未知工具 ${name}`;
    }
  } catch (e) {
    return '工具执行出错：' + (e as Error).message;
  }
}

function chatRender(): void {
  const log = $('chat-log');
  log.innerHTML =
    chatMsgs.length === 0
      ? '<div class="chat-empty">与 AI 实时交流——它能调用本地工具（跑质检/查句子/列标记/提修订候选），所有验证由本机 QC 引擎完成。</div>'
      : chatMsgs
          .map((m) => {
            if (m.role === 'user') return `<div class="chat-msg user"><div class="bubble">${esc(m.content)}</div></div>`;
            if (m.role === 'tool') return '';
            const toolsHtml = (m.tool_calls ?? [])
              .map((t) => `<div class="chat-tool">🔧 ${esc(t.function.name)}(${esc(t.function.arguments.slice(0, 60))}${t.function.arguments.length > 60 ? '…' : ''})</div>`)
              .join('');
            return `<div class="chat-msg assistant">${toolsHtml}<div class="bubble" ${m.content === '' ? 'id="chat-cur"' : ''}>${esc(m.content)}</div></div>`;
          })
          .join('');
  log.scrollTop = log.scrollHeight;
}

async function sendChat(): Promise<void> {
  if (chatBusy) return;
  const s = activeSession();
  if (!s) { setStatus('请先打开章节再与 AI 交流', 'err'); return; }
  const input = $('chat-input') as HTMLTextAreaElement;
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  const key = await invoke<string>('load_api_key');
  if (!key) { setStatus('请先配置 AI（菜单 LayerText → AI 设置…）', 'err'); showAiSettings(); return; }

  chatBusy = true;
  $('chat-send').disabled = true;
  chatMsgs.push({ role: 'user', content: text });
  chatRender();
  const statusEl = $('chat-status');
  let usageTotal = '';

  try {
    const system = (await buildSystemPrompt()) +
      `\n\n7. 你在一个审校应用中工作，可调用工具查证与验证（list_marks / get_chapter_stats / get_sentence / search_text / propose_revision）。改写建议必须先用工具核对原句，再用 propose_revision 提交；不要凭空引用正文。当前章节：${s.fileName}，标记 ${s.review.marks.length} 条。`;
    for (let round = 0; round < 8; round++) {
      const messages = [{ role: 'system', content: system }, ...chatMsgs];
      statusEl.textContent = round === 0 ? '思考中…' : `工具结果已回传，继续（第 ${round + 1} 轮）…`;
      const { content, toolCalls, usage } = await chatStream(messages, (delta) => {
        const cur = document.getElementById('chat-cur');
        if (cur) cur.textContent += delta;
        const log = $('chat-log');
        log.scrollTop = log.scrollHeight;
      });
      usageTotal = usage;
      chatMsgs.push({ role: 'assistant', content, tool_calls: toolCalls.length ? toolCalls.map((t) => ({ id: t.id, type: 'function' as const, function: { name: t.name, arguments: t.arguments } })) : undefined });
      if (toolCalls.length === 0) {
        chatRender();
        break;
      }
      chatRender(); // 先展示工具调用条
      for (const t of toolCalls) {
        const result = executeTool(t.name, t.arguments);
        chatMsgs.push({ role: 'tool', tool_call_id: t.id, content: result });
      }
    }
    statusEl.textContent = '就绪 ' + usageTotal;
  } catch (e) {
    statusEl.textContent = '出错：' + e;
  } finally {
    chatBusy = false;
    $('chat-send').disabled = false;
  }
}

$('chat-send').addEventListener('click', () => void sendChat());
$('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void sendChat();
});

/* 侧栏双页切换 */
function switchSide(name: 'review' | 'ai'): void {
  $('side-tab-review').classList.toggle('active', name === 'review');
  $('side-tab-ai').classList.toggle('active', name === 'ai');
  ($('side-review') as HTMLElement).style.display = name === 'review' ? '' : 'none';
  ($('side-ai') as HTMLElement).style.display = name === 'ai' ? 'flex' : 'none';
}
$('side-tab-review').addEventListener('click', () => switchSide('review'));
$('side-tab-ai').addEventListener('click', () => switchSide('ai'));

/* ---------- 门禁说明弹层 ---------- */

const gatePop = $('gate-pop');

function hideGatePop(): void {
  gatePop.classList.remove('open');
}

function showGateHelp(gate: string, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  const isQc = gate === 'QC 指标达标';
  let body = `<p>${esc(GATE_HELP[gate] ?? '')}</p>`;
  const s = activeSession();
  if (isQc) {
    const tier = (s?.report?.tier ?? ($('tier') as HTMLSelectElement).value) as Tier;
    const maxLen = TIER_MAX_LEN[tier] ?? 16;
    if (s?.report) {
      const r = s.report;
      const gates2 = r.gates;
      const row = (name: string, value: string, ref: string, warn = false) =>
        `<tr class="${warn ? 'warnrow' : ''}"><td>${name}</td><td>${value}</td><td>${ref}</td></tr>`;
      body += `
        <table class="gtable">
          <tr><th>指标</th><th>本章实际</th><th>参考</th></tr>
          ${row('词表覆盖率', (r.coverage * 100).toFixed(1) + '%', '越接近词库上限越好')}
          ${row('生词率（词型）', (r.newWordRate * 100).toFixed(1) + '%', '越低越好')}
          ${row('平均句长', r.avgLenNarrRaw.toFixed(1) + ' 词', `≤ ${maxLen} 词（${tier} 层）`, r.avgLenNarrRaw > maxLen)}
          ${row('单句最长', r.maxLen + ' 词', '≤ 20 词', r.maxLen > 20)}
          ${row('超 20 词句数', String(r.over20), '0（个别文学长句可人工放行）', r.over20 > 0)}
          ${row('被动式', String(r.passive), gates2.passiveOk ? '已解禁（第5章起）·建议人工复核' : '0', !gates2.passiveOk && r.passive > 0)}
          ${row('定语从句', String(r.relcl), gates2.relclOk ? '已解禁（第8章起）·建议人工复核' : '0', !gates2.relclOk && r.relcl > 0)}
          ${row('过去完成', String(r.pastperf), '0', r.pastperf > 0)}
          ${row('待定词命中', String(r.pendingHits), '逐个复核后定去留', r.pendingHits > 0)}
        </table>`;
    } else {
      body += `<p class="dim">本章尚未质检——先点「▶ 质检本章」，再回来核对。</p>`;
    }
    body += `<p class="dim">参考值源自原型项目三层设计；黄色行 = 超出参考，需你复核后决定。达标与否由你勾选确认（AI 只出数字，教师定稿）。</p>`;
  }
  gatePop.innerHTML = `<div class="pop-h">${esc(gate)}</div>${body}`;
  gatePop.classList.add('open');
  const popRect = gatePop.getBoundingClientRect();
  const px = Math.min(Math.max(8, rect.left - popRect.width - 8), window.innerWidth - popRect.width - 8);
  const py = Math.min(Math.max(8, rect.top), window.innerHeight - popRect.height - 8);
  gatePop.style.left = px + 'px';
  gatePop.style.top = py + 'px';
}

document.addEventListener('mousedown', (e) => {
  if (gatePop.classList.contains('open') && !(e.target as HTMLElement).closest('#gate-pop') && !(e.target as HTMLElement).closest('.qmark')) {
    hideGatePop();
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
