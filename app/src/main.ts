/**
 * LayerText 分层读 · 审校工作台 v0.2
 * 多版本文件 tab → 三态高亮正文 → 点词/拖选句标记 → 侧栏（配额/门禁/清单）→ 标记自动落盘。
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open as openFileDialog, save as saveFileDialog } from '@tauri-apps/plugin-dialog';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import * as XLSX from 'xlsx';
import { unzipSync, strFromU8 } from 'fflate';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType } from 'docx';
import { applyRewriteTo, checkRevisedText, normalizeAndSplitChapters, parseAiJson } from './pure.js';
import { S, setStatus as uiSetStatus, esc } from './state.js';
import { AI_PROVIDERS, AI_SYSTEM_PROMPT, aiErrHuman, buildSystemPrompt, callChat, chatStream, loadConfig, saveConfig, setAiUi, tierMaxLen, tierPlan } from './ai.js';
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
  CHANGELOG_HEADER, DEFAULT_TIER_PLANS, GATES, GATE_HELP, SENT_TYPES, WORD_TYPES,
  newMarkId, newReviewState, typeLabel,
  type FileSession, type Mark, type MarkType, type Suggestion, type TierPlan,
} from './types.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/* ---------- 全局状态 ---------- */

/** 专名表原始行（保留大小写与空格短语：既并入已知词，也作 ⑧ 专名一致性检查名单） */
/** 本地示例目录的附加词表（如原型项目的中考1600按词性分类表） */
/** 当前会话的合并已知词表（含词句卡），供词面板显示原形 */

/* ---------- 全局配置（~/.layertext.json：AI 设置 + 分层方案 + 首启动标记） ---------- */


/** 常见服务商预设（新手只需选服务商 + 贴 Key） */
function buildLexiconNow(): Lexicon {
  return buildLexicon({
    vocabCsvTexts: S.vocabCsvText ? [S.vocabCsvText] : [],
    plainWordlistTexts: S.extraWordlistText ? [bundledWordlist, S.extraWordlistText] : [bundledWordlist],
    terms: S.termsText ? S.termsText.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')) : [],
    properNouns: S.properRows.map((r) => r.toLowerCase()),
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
    S.vocabCsvText = await readVocabAsCsv(path);
    S.vocabName = path.slice(path.lastIndexOf('/') + 1);
    renderAll();
    setStatus(`已导入词库：${S.vocabName}（${S.vocabCsvText.split('\n').filter(Boolean).length} 行）`, 'saved');
  } catch (e) {
    setStatus('词库读取失败：' + e, 'err');
  }
}

async function importTermsFile(): Promise<void> {
  const path = await openFileDialog({ multiple: false, filters: [{ name: '术语表 TXT（一行一词）', extensions: ['txt'] }] });
  if (typeof path !== 'string') return;
  try {
    S.termsText = await invoke<string>('read_text_file', { path });
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
    S.properRows = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    renderAll();
    setStatus(`已导入专名表：${S.properRows.length} 个（⑧专名一致性检查同步启用）`, 'saved');
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
      S.vocabCsvText = vocab;
      S.vocabName = '_词库.csv（本地示例）';
    }
    const extraWl = await readIf('_词表.txt');
    if (extraWl) S.extraWordlistText = extraWl;
    const terms = await readIf('_术语表.txt');
    if (terms) S.termsText = terms;
    const proper = await readIf('_专名表.txt');
    if (proper) {
      S.properRows = proper.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
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

function activeSession(): FileSession | null {
  return S.activeIdx >= 0 ? S.sessions[S.activeIdx] : null;
}

function fileSummary(): void {
  const s = activeSession();
  const parts: string[] = [];
  parts.push(s ? `当前：${s.fileName}` : '未载入文本');
  parts.push('词库：课标1600（内置）');
  if (S.vocabCsvText) parts.push(`+ ${S.vocabName}`);
  if (S.termsText) parts.push('+ 术语表');
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
  const same = S.sessions.findIndex((s) => s.sourcePath === sourcePath && s.fileName === fileName);
  if (same >= 0) {
    S.activeIdx = same;
    renderAll();
    return;
  }
  // 本书配置：同文件夹的 _LayerText项目.json 自动生效（新用户第一次配好，之后每章自动带）
  if (sourcePath) {
    const dir = sourcePath.slice(0, sourcePath.lastIndexOf('/'));
    if (await loadBookConfig(dir)) setStatus('已自动加载本书配置（词库/术语/约定）', 'saved');
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
  S.sessions.push({ md, fileName, sourcePath, markPath, review, report: null, reportSavedPath: null, dirty: false });
  S.activeIdx = S.sessions.length - 1;
  // 会话保持（学 harness）：切换文件不清空对话，注入上下文提示让 AI 知道当前章节
  if (S.chatMsgs.length > 0) {
    S.chatMsgs.push({ role: 'user', content: `（系统提示：教师已切换到「${fileName}」，后续操作与回答默认针对这一章）` });
    chatRender();
  }
  S.aiHistory = [];
  S.suggestions = [];
  renderAll();
  void pushRecent(fileName, sourcePath);
  // 换书提醒：本书文件夹无配套配置时提示（学生水平/词库可能需要切换）
  if (sourcePath && S.sessions.filter((x) => x.sourcePath && x.sourcePath.slice(0, x.sourcePath.lastIndexOf('/')) === sourcePath.slice(0, sourcePath.lastIndexOf('/'))).length === 1) {
    setStatus(`已打开「${fileName}」。注意：这本书还没有专属词库配置（学生水平诊断依据）——若当前词库是别的书的，请 文件 → 导入自定义词库 后「保存为本书配置」`, '');
  }
  // 首次载入文件 → 自动进入四步导览
  if (!S.appConfig.tourSeen && S.sessions.length === 1) setTimeout(() => tourShow(0), 600);
}

function closeSession(i: number): void {
  S.sessions.splice(i, 1);
  S.activeIdx = Math.min(S.activeIdx, S.sessions.length - 1);
  renderAll();
}

/* ---------- 渲染 ---------- */

function renderAll(): void {
  renderFileTabs();
  const s = activeSession();
  if (!s) {
    $('reader').innerHTML = '<div class="empty"><b>第一步：打开一篇课文</b><br/>点上方「载入示例」先看演示，或「打开章节文件…」选你的书稿</div>';
    $('pane-report').innerHTML = '<div class="empty"><b>第二步：点上方「▶ 质检本章」</b><br/>软件会自动数出这篇课文的生词率、句长、难句</div>';
    $('side-review').innerHTML = '<div class="side-empty">这里是你的审校 checklist：<br/>· 要点配额：本章必须保留的情节点，自己添加打勾<br/>· 终审门禁：四项全勾才算审完（点 ? 看每项查什么）<br/>· 标记清单：正文里做的标记都在这，点击跳回原文</div>';
    hidePop();
    fileSummary();
    return;
  }
  renderReader(s);
  attachInlineSuggestions();
  renderReportPane(s);
  renderSidebar(s, sidebarHandlers);
  fileSummary();
}

function renderFileTabs(): void {
  const el = $('filetabs');
  if (S.sessions.length === 0) {
    el.innerHTML = '<span class="hint">可同时打开同一文本的多个难度版本（B/M/A 各一个文件）并排切换</span>';
    return;
  }
  el.innerHTML = S.sessions
    .map(
      (s, i) =>
        `<span class="ftab ${i === S.activeIdx ? 'active' : ''}" data-ftab="${i}">${esc(s.fileName)}<span class="x" data-ftab-close="${i}" title="关闭">×</span></span>`,
    )
    .join('');
  el.querySelectorAll('[data-ftab]').forEach((t) =>
    t.addEventListener('click', (e) => {
      const x = (e.target as HTMLElement).closest('[data-ftab-close]');
      if (x) return;
      S.activeIdx = Number((t as HTMLElement).dataset.ftab);
      renderAll();
    }),
  );
  el.querySelectorAll('[data-ftab-close]').forEach((x) =>
    x.addEventListener('click', () => closeSession(Number((x as HTMLElement).dataset.ftabClose))),
  );
}

/** 改写文本复核（多句拆分逐句检测，超长=最长一句超限） */
function checkRev(revised: string, tier: string): Suggestion['check'] {
  return checkRevisedText(revised, tierMaxLen(tier), (sent, m) => {
    const r = sentenceRisks(sent, m);
    return { passive: r.passive, relcl: r.relcl, pastperf: r.pastperf, overlong: r.overlong };
  });
}

/** 改写生效的视觉反馈：新句子绿色高亮一闪 */
function flashApplied(revised: string): void {
  const key = revised.slice(0, 30);
  const el = [...document.querySelectorAll('#reader .sent')].find((x) => (x.textContent ?? '').includes(key));
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('just-applied');
  void (el as HTMLElement).offsetWidth;
  el.classList.add('just-applied');
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
    reader.innerHTML = `<div class="empty">文件格式不符：${esc((e as Error).message)}<br/>需要包含 "## Chapter One" 章节标记与 [P01] 段落标记。<br/><span style="font-size:12px">不知道怎么弄？把书稿发我（开发者）帮你转格式</span></div>`;
    return;
  }
  const lex = buildLexiconNow();
  const card = splitChapter(session.md).card;
  S.currentKnown = new Set([...lex.known, ...IRR, ...cardGlossWords(card)]);
  const terms = new Set<string>([
    ...(S.termsText ?? '').split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#')),
    ...S.properRows.map((r) => r.toLowerCase()),
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
        const cls = terms.has(tok) ? 'term' : pendHit(tok, lex.pending) ? 'pending' : hit(tok, S.currentKnown) ? '' : 'oov';
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

function addMark(session: FileSession, mark: Mark): Mark {
  session.review.marks.push(mark);
  refreshMarkDom(mark);
  renderSidebar(session, sidebarHandlers);
  scheduleSave(session, (st, detail) => {
    if (st === 'dirty') setStatus('标记待保存…', 'dirty');
    else if (st === 'saved') setStatus('✓ 标记已自动保存：' + detail, 'saved');
    else setStatus('标记保存失败：' + detail, 'err');
  });
  return mark;
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

function hidePop(): void {
  pop.classList.remove('open');
  S.popSession = null;
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
      const m = S.popSession?.review.marks.find((x) => x.id === (btn as HTMLElement).dataset.popRm);
      if (m && S.popSession) {
        removeMark(S.popSession, m);
        refreshPop('sent-or-word');
      }
    }),
  );
}

function refreshPop(_why: string): void {
  if (!S.popSession) return;
  const ctx = pop.dataset;
  const pi = Number(ctx.pi), si = Number(ctx.si), wi = ctx.wi === undefined ? undefined : Number(ctx.wi);
  const level = ctx.level as 'word' | 'sent';
  renderPopMarks(marksAt(S.popSession, level, pi, si, wi));
  // 类型按钮置灰已选项
  pop.querySelectorAll('[data-mk]').forEach((b) => {
    const t = (b as HTMLElement).dataset.mk!;
    const has = marksAt(S.popSession!, level, pi, si, wi).some((m) => m.type === t);
    (b as HTMLElement).style.opacity = has ? '.45' : '';
  });
}

function showWordPanel(session: FileSession, wEl: HTMLElement, x: number, y: number): void {
  S.popSession = session;
  const sentHost = wEl.closest('.sent') as HTMLElement | null;
  const pi = Number(sentHost?.dataset.pi);
  const si = Number(sentHost?.dataset.si);
  const wi = Number(wEl.dataset.wi);
  const tok = wEl.dataset.tok!;
  const state = wEl.dataset.state;
  const origin = hitOrigin(tok, S.currentKnown);
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
    <div class="pop-btns"><button data-mk="__rewrite" class="primary" title="让 AI 按当前标记意图改写这一句，改写结果直接显示在正文里">✨ AI 改写本句</button>${WORD_TYPES.map((t) => `<button data-mk="${t.key}">${t.label}</button>`).join('')}</div>
    <textarea id="pop-note" placeholder="备注（可选，随下一条标记保存）"></textarea>
    <div class="pop-tip">先标记意图再点「AI 改写本句」，改写会直接出现在正文中供采纳</div>`;
  bindTypeButtons(session, 'word', pi, si, wi);
  refreshPop('open');
  placePop(x, y);
}

function showSentPanel(session: FileSession, sentEl: HTMLElement, x: number, y: number, crossSentence: boolean): void {
  S.popSession = session;
  const pi = Number((sentEl as HTMLElement).dataset.pi);
  const si = Number((sentEl as HTMLElement).dataset.si);
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
      const type = (b as HTMLElement).dataset.mk as MarkType | '__rewrite';
      if ((type as string) === '__rewrite') {
        const intent = marksAt(session, 'word', pi, si, wi).map((m) => typeLabel(m.type)).join('、') || '词汇简化';
        void aiRewriteSentence(pi, si, intent);
        return;
      }
      const note = (pop.querySelector('#pop-note') as HTMLTextAreaElement | null)?.value.trim() || undefined;
      if (marksAt(session, level, pi, si, wi).some((m) => m.type === type)) return; // 已有同类型标记
      const sentText = sentsOf(extractParas(splitChapter(session.md).body)[pi], false)[si] ?? '';
      const mark = addMark(session, {
        id: newMarkId(), level, pi, si, ...(level === 'word' ? { wi } : {}),
        ...(level === 'word' ? { word: pop.querySelector('.pop-h')?.textContent ?? '', text: sentText.slice(0, 40) } : { text: sentText.slice(0, 40) }),
        type: type as MarkType, note, ts: Date.now(),
      });
      // 标记即改写：点完标记直接 AI 改写并生效，无需任何后续点击
      if (S.appConfig.autoRewriteOnMark) {
        hidePop();
        void aiRewriteSentence(pi, si, typeLabel(mark.type), mark.id);
        return;
      }
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
      tierGates: { passiveFromCh: tierPlan(tier).passiveFromCh, relclFromCh: tierPlan(tier).relclFromCh },
      ...(S.properRows.length ? { propCheckList: S.properRows } : {}),
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

function switchView(name: 'text' | 'report' | 'suggest' | 'diff'): void {
  const map = [['tab-text', 'pane-text'], ['tab-report', 'pane-report'], ['tab-suggest', 'pane-suggest'], ['tab-diff', 'pane-diff']] as const;
  for (const [id, pane] of map) {
    $(id).classList.toggle('active', id === `tab-${name}`);
    $(pane).classList.toggle('active', pane === `pane-${name}`);
  }
}

/* ---------- 最近编辑 ---------- */

async function pushRecent(fileName: string, sourcePath: string | null): Promise<void> {
  if (!sourcePath) return;
  const list: string[] = [sourcePath, ...(S.appConfig.recentFiles ?? []).filter((x) => x !== sourcePath)].slice(0, 10);
  S.appConfig.recentFiles = list;
  await saveConfig();
}

async function renderRecentInEmpty(): Promise<void> {
  const reader = $('reader');
  if (!reader.querySelector('.empty') || !S.appConfig.recentFiles?.length) return;
  const div = document.createElement('div');
  div.style.cssText = 'margin-top:18px;text-align:center';
  div.innerHTML = `<div style="font-weight:600;margin-bottom:8px">最近编辑</div>` +
    S.appConfig.recentFiles.map((p) =>
      `<div class="recent-item" data-path="${esc(p)}" style="cursor:pointer;padding:5px 10px;border-radius:8px;display:inline-block;margin:3px;background:#f8fafc;border:1px solid var(--line);font-size:12px">${esc(p.slice(p.lastIndexOf('/') + 1))}</div>`).join('');
  reader.appendChild(div);
  div.querySelectorAll('.recent-item').forEach((el) =>
    el.addEventListener('click', async () => {
      const path = (el as HTMLElement).dataset.path!;
      try {
        const raw = path.toLowerCase().endsWith('.docx')
          ? docxToText(await invoke<string>('read_file_base64', { path }))
          : await invoke<string>('read_text_file', { path });
        const { chapters } = normalizeAndSplitChapters(raw, path.slice(path.lastIndexOf('/') + 1));
        for (const ch of chapters) await addSession(ch.md, chapters.length > 1 ? ch.title : path.slice(path.lastIndexOf('/') + 1), path);
      } catch (e) { setStatus('打开失败：' + e, 'err'); }
    }));
}

/* ---------- AI 会话持久化（防抖落盘，重启可恢复） ---------- */

let chatSaveTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleChatSave(): void {
  clearTimeout(chatSaveTimer);
  chatSaveTimer = setTimeout(() => void (async () => {
    try {
      const dir = await invoke<string>('reports_dir');
      await invoke('write_text_file', { path: `${dir}/AI会话.json`, content: JSON.stringify(S.chatMsgs, null, 1) });
    } catch { /* 尽力保存 */ }
  })(), 800);
}

async function restoreChat(): Promise<void> {
  try {
    const dir = await invoke<string>('reports_dir');
    const saved = JSON.parse(await invoke<string>('read_text_file', { path: `${dir}/AI会话.json` }));
    if (Array.isArray(saved) && saved.length) { S.chatMsgs = saved; chatRender(); }
  } catch { /* 无历史 */ }
}

/* ---------- 事件绑定 ---------- */

$('tab-text').addEventListener('click', () => switchView('text'));
$('tab-report').addEventListener('click', () => switchView('report'));
$('tab-suggest').addEventListener('click', () => switchView('suggest'));
$('tab-diff').addEventListener('click', () => { renderDiff(0, Math.min(1, S.sessions.length - 1)); switchView('diff'); });

/* ---------- 示例菜单 ---------- */


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
  S.demoMenuOpen = true;
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
        setStatus('已载入本地示例：' + name + (S.vocabCsvText ? '（词库已自动加载）' : ''));
      } catch (e) {
        setStatus('载入失败：' + e, 'err');
      }
    }),
  );
}

function closeDemoMenu(): void {
  $('demo-menu').classList.remove('open');
  S.demoMenuOpen = false;
}

function loadBuiltinDemo(): void {
  if (!S.vocabCsvText) {
    S.vocabCsvText = exampleVocab;
    S.vocabName = '示例词库 sample_teaching_vocab.csv';
  }
  void addSession(exampleMd, 'aesop_tortoise_hare.md（示例）', null).then(() => {
    setStatus('已载入内置示例（含示例词库）。正文点词/拖选句子开始审校；「▶ 质检本章」看报告。');
  });
}

$('btn-demo').addEventListener('click', () => {
  if (S.demoMenuOpen) closeDemoMenu();
  else void openDemoMenu();
});
document.addEventListener('mousedown', (e) => {
  if (S.demoMenuOpen && !(e.target as HTMLElement).closest('#demo-menu') && !(e.target as HTMLElement).closest('#btn-demo')) {
    closeDemoMenu();
  }
});

/* ---------- 导入无障碍：任意 txt/docx 自动转章节格式 ---------- */

/** 纯文本/无标记文本 → 章节 md（按空行分段，自动编号 [P01]…） */
function normalizeToChapter(raw: string, fileName: string): string {
  const title = fileName.replace(/\.(md|txt|markdown|docx|doc)$/i, '');
  const paras = raw
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter((p) => /[A-Za-z]/.test(p));
  return `# ${title}\n\n## Chapter One\n\n${paras.map((p, i) => `[P${String(i + 1).padStart(2, '0')}] ${p}`).join('\n\n')}\n`;
}

/** docx → 文本（fflate 解压 + w:t 抽取，段落保序） */
function docxToText(b64: string): string {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const files = unzipSync(bin, { filter: (f) => f.name === 'word/document.xml' });
  const xml = strFromU8(files['word/document.xml']!);
  const paras = xml
    .split(/<\/w:p>/)
    .map((p) => (p.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, '')).join(''))
    .map((s) => s.trim())
    .filter(Boolean);
  return paras.join('\n\n');
}

async function openChapterFiles(): Promise<void> {
  const paths = await openFileDialog({
    multiple: true,
    filters: [{ name: '章节文件（Markdown / 文本 / Word）', extensions: ['md', 'txt', 'markdown', 'docx'] }],
  });
  const list = Array.isArray(paths) ? paths : paths ? [paths] : [];
  for (const p of list) {
    try {
      const name = p.slice(p.lastIndexOf('/') + 1);
      const raw = p.toLowerCase().endsWith('.docx')
        ? docxToText(await invoke<string>('read_file_base64', { path: p }))
        : await invoke<string>('read_text_file', { path: p });
      // 智能归一化：已合规直接用；多章标题拆多 tab；无章节结构的文本内存包装直接显示（原文件不动）
      const { chapters } = normalizeAndSplitChapters(raw, name);
      for (const ch of chapters) await addSession(ch.md, chapters.length > 1 ? ch.title : name, p);
      if (chapters.length > 1) setStatus(`识别到 ${chapters.length} 个章节，已分标签页打开`, 'saved');
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
    case 'file-demo': S.demoMenuOpen ? closeDemoMenu() : void openDemoMenu(); break;
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
    case 'draft': showDraftPop(); break;
    case 'tier-plan': showTierPlanPop(); break;
    case 'book-config': void saveBookConfig(); break;
    case 'rewrite-rules': showRewritePop(); break;
    case 'help-key': void invoke('open_help_window', { which: 'key' }); break;
    case 'export-docx': void exportDocx(); break;
    case 'export-tts': void exportTts(); break;
    case 'view-diff':
      if (S.sessions.length < 2) setStatus('版本对比需要先打开两个版本（如原文与分层初稿）', 'err');
      else { renderDiff(0, 1); switchView('diff'); }
      break;
  }
});

/* ================= AI 审核建议（AI 只出候选，教师握定稿权） ================= */

/** 当前 AI 会话历史（同章节内"按指令调整"时携带；应用修订或切换会话后清空） */
const aiPop = $('ai-pop');

function showAiSettings(): void {
  aiPop.innerHTML = `
    <div class="pop-h">AI 设置（第一次配置，照着做即可）</div>
    <div class="fld"><label>① 选择 AI 服务商（选一个你有账号的）</label>
      <select id="ai-provider">${AI_PROVIDERS.map((p, i) => `<option value="${i}">${p.name}</option>`).join('')}</select></div>
    <div class="fld"><label>② API 地址（选服务商后自动填好，一般不用改）</label>
      <input id="ai-url" placeholder="https://api.deepseek.com/v1" /></div>
    <div class="fld"><label>③ 模型（选服务商后自动推荐）</label>
      <select id="ai-model-sel"></select><input id="ai-model" placeholder="模型名" style="display:none" /></div>
    <div class="fld"><label>④ API Key（一串密钥，形如 sk-…；只存这台电脑，不会发给别人）</label>
      <input id="ai-key" type="password" placeholder="粘贴你的 Key" />
      <div class="key-tip" id="ai-key-tip" style="color:var(--muted);font-size:11px;margin-top:3px"></div></div>
    <div class="fld"><label>长期审校约定（可选；写上你每次都要 AI 遵守的要求，如"人名保留原文"）</label>
      <textarea id="ai-instructions" style="width:100%;height:50px;border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:12px;font-family:inherit;resize:vertical;"></textarea></div>
    <div class="fld"><label style="display:flex;align-items:flex-start;gap:6px"><input type="checkbox" id="ai-auto" style="width:auto;margin-top:3px" /> <span><b>AI 改写直接生效</b>（全局）：点标记、批量「✨AI审核建议」、逐句改写的全部结果<b>自动应用</b>，无需再点 ✓，改写的句子会绿色高亮一闪变成新句。关闭则改为候选模式（正文行内 ✓/✗）</span></label></div>
    <div class="fld"><label style="display:flex;align-items:flex-start;gap:6px"><input type="checkbox" id="ai-trust" style="width:auto;margin-top:3px" /> <span><b>信任模式</b>：允许 AI 助手在对话中直接修改正文（你说"直接改"即生效）</span></label></div>
    <div class="fld"><label style="display:flex;align-items:flex-start;gap:6px"><input type="checkbox" id="ai-inplace" style="width:auto;margin-top:3px" checked /> <span><b>直接修改原稿文件</b>（推荐）：改动直接写进书稿本身，不另存工作稿——<b>首次修改前自动备份</b>原始版（xxx_原始备份.md），随时可整体还原。关闭则另存工作稿、原稿不动</span></label></div>
    <div class="row-btns">
      <button id="ai-save" class="primary">保存</button>
      <button id="ai-test">测试连接（填完 ①-④ 就点这个）</button>
      <button id="ai-close">关闭</button>
    </div>
    <div class="test-out" id="ai-test-out"></div>
    <div class="hint-txt">这是什么？AI 功能（改写建议 / 分层初稿 / AI 助手对话）需要连接一个 AI 服务。上面四步配好后，AI 只负责"给建议"，每条建议都会先经本机质检引擎复核，最后由你点头才生效。不知道 Key 从哪来？点菜单 帮助 → 如何获取 AI 的 Key。</div>`;
  aiPop.classList.add('open');

  const urlEl = $('ai-url') as HTMLInputElement;
  const modelSel = $('ai-model-sel') as HTMLSelectElement;
  const modelEl = $('ai-model') as HTMLInputElement;

  const applyProvider = (i: number) => {
    const p = AI_PROVIDERS[i];
    if (p.url) urlEl.value = p.url;
    $('ai-key-tip').textContent = 'Key 从哪来：' + p.keyTip;
    if (p.models.length) {
      modelSel.style.display = '';
      modelEl.style.display = 'none';
      modelSel.innerHTML = p.models.map((m) => `<option ${m === S.appConfig.model ? 'selected' : ''}>${m}</option>`).join('');
    } else {
      modelSel.style.display = 'none';
      modelEl.style.display = '';
    }
  };
  $('ai-provider').addEventListener('change', () => applyProvider(Number(($('ai-provider') as HTMLSelectElement).value)));
  const cur = $('ai-key') as HTMLInputElement;

  void (async () => {
    await loadConfig();
    const key = await invoke<string>('load_api_key');
    const matched = AI_PROVIDERS.findIndex((p) => p.url && p.url === S.appConfig.baseUrl);
    ($('ai-provider') as HTMLSelectElement).value = String(matched >= 0 ? matched : AI_PROVIDERS.length - 1);
    urlEl.value = S.appConfig.baseUrl ?? '';
    if (matched >= 0) applyProvider(matched);
    else { modelSel.style.display = 'none'; modelEl.style.display = ''; modelEl.value = S.appConfig.model ?? ''; }
    cur.value = key ?? '';
    ($('ai-instructions') as HTMLTextAreaElement).value = S.appConfig.instructions ?? '';
    ($('ai-auto') as HTMLInputElement).checked = S.appConfig.autoRewriteOnMark ?? false;
    ($('ai-trust') as HTMLInputElement).checked = S.appConfig.trustEdit ?? false;
    ($('ai-inplace') as HTMLInputElement).checked = S.appConfig.inPlaceEdit ?? true;
  })();

  const currentModel = () => (modelSel.style.display !== 'none' ? modelSel.value : modelEl.value.trim());

  $('ai-close').addEventListener('click', () => aiPop.classList.remove('open'));
  $('ai-save').addEventListener('click', async () => {
    const out = $('ai-test-out');
    try {
      S.appConfig.baseUrl = urlEl.value.trim();
      S.appConfig.model = currentModel();
      S.appConfig.instructions = ($('ai-instructions') as HTMLTextAreaElement).value.trim();
      S.appConfig.autoRewriteOnMark = ($('ai-auto') as HTMLInputElement).checked;
      S.appConfig.trustEdit = ($('ai-trust') as HTMLInputElement).checked;
      S.appConfig.inPlaceEdit = ($('ai-inplace') as HTMLInputElement).checked;
      await saveConfig();
      const k = cur.value.trim();
      if (k) await invoke('save_api_key', { key: k });
      out.textContent = '✓ 已保存（Key 存入本机钥匙串）';
    } catch (e) {
      out.textContent = '✗ 保存失败：' + e;
    }
  });
  $('ai-test').addEventListener('click', async () => {
    const out = $('ai-test-out');
    const url = (urlEl.value.trim() || '').replace(/\/+$/, '');
    const model = currentModel();
    const key = cur.value.trim();
    if (!key) { out.textContent = '第 ④ 步还没填 Key（一串 sk- 开头的字符）'; return; }
    if (!url || !model) { out.textContent = '第 ① 步先选服务商，地址和模型会自动填好'; return; }
    out.textContent = '连接中…';
    try {
      const resp = await tauriFetch(`${url}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: '只回复两个字：正常' }] }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 120)}`);
      const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
      out.textContent = '✓ 连接成功——点「保存」就配好了';
    } catch (e) {
      out.textContent = '✗ ' + aiErrHuman(e);
    }
  });
}

document.addEventListener('mousedown', (e) => {
  if (aiPop.classList.contains('open') && !(e.target as HTMLElement).closest('#ai-pop')) aiPop.classList.remove('open');
});

/** 组装 system 提示词（含用户的长期审校约定 + 书级改写规则） */
/** 内置提示词模板：词库边界 + 句法黑名单 + 句长上限 + 方法论约束 */
/** 估算 token（英文≈4字符/词符，中文≈1.6字） */
function estTokens(s: string): number {
  const cjk = (s.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const rest = s.length - cjk;
  return Math.round(cjk * 1.6 + rest / 3.5);
}

/**
 * 请求 AI 修订候选。
 * instruction 传入 = 会话式追问（携带 S.aiHistory，AI 知道上一轮建议过什么、你否决了什么）；
 * 不传 = 全新请求（上下文来自本地文件：标记清单+当前文本句子），并重建 S.aiHistory。
 */
function buildAiUserPrompt(session: FileSession, tier: Tier): string {
  const body = splitChapter(session.md).body;
  const paras = extractParas(body);
  const maxLen = tierMaxLen(tier);
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
  const btn = $('btn-ai') as unknown as HTMLButtonElement;
  btn.textContent = '⏳ AI 请求中…';
  btn.disabled = true;
  try {
    const system = await buildSystemPrompt();
    let messages: { role: string; content: string }[];
    if (instruction && S.aiHistory.length > 0) {
      S.aiHistory.push({ role: 'user', content: instruction + '\n\n请基于我们之前的对话重新输出完整的 JSON 数组（含未改动条目，original 用当前正文原句）。' });
      messages = [{ role: 'system', content: system }, ...S.aiHistory];
    } else {
      const userMsg = buildAiUserPrompt(s, tier);
      S.aiHistory = [{ role: 'user', content: userMsg }];
      messages = [{ role: 'system', content: system }, { role: 'user', content: userMsg }];
    }
    const estIn = messages.reduce((n, m) => n + estTokens(m.content), 0);
    setStatus(`本次请求约 ${estIn} tokens 输入（只含标记相关句子，不发全章原文）…`);
    const { content, usage } = await callChat(messages, 4000);
    S.aiHistory.push({ role: 'assistant', content });
    const raw = parseAiJson(content) as { id: string; type?: string; original?: string; revised?: string; basis?: string; alternative?: string }[];
    const maxLen = tierMaxLen(tier);
    S.suggestions = raw
      .filter((x) => x.revised)
      .map((x) => {
        const risk = checkRev(String(x.revised), tier);
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
    if (S.appConfig.autoRewriteOnMark && S.suggestions.length > 0) {
      // 全局直改：所有建议自动生效（写工作稿+日志；⚠ 复核项计数提醒复查）
      let warned = 0;
      let applied = 0;
      for (const g of [...S.suggestions]) {
        if (g.check.passive || g.check.relcl || g.check.pastperf || g.check.overlong) warned++;
        if (g.pi !== undefined) { await acceptSuggestion(g); applied++; }
      }
      setStatus(`AI 直改完成：自动应用 ${applied} 条${warned ? `，其中 ${warned} 条引擎复核⚠（黑名单/超长残留），已留痕变更日志，建议复查` : ''} ${usage}`, 'saved');
      return;
    }
    renderSuggestions();
    attachInlineSuggestions();
    switchView('suggest');
    setStatus(`AI 返回 ${S.suggestions.length} 条修订候选 ${usage}——建议已标到正文里，点 ✓ 采纳 / ✗ 放弃`, 'saved');
  } catch (e) {
    const hint = String(e).includes('未找到 JSON')
      ? '（模型思考太长占满输出上限——建议 AI 设置里换非思考型模型，或减少一次标记的数量分批出）'
      : '';
    setStatus('AI 请求失败：' + e + hint, 'err');
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
  if (S.suggestions.length === 0) {
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
      ${S.suggestions.map((g, i) => `
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
      ($('sg-apply') as HTMLElement as unknown as HTMLButtonElement).textContent = `应用已勾选（${n}）→ 生成新版本 + 变更日志`;
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

/** 批量应用（修订建议页）：统一走 acceptSuggestion（工作稿+变更日志），不再另生成 AI修订 文件 */
async function applySuggestions(): Promise<void> {
  const s = activeSession();
  if (!s) return;
  const checked = [...document.querySelectorAll<HTMLInputElement>('#pane-suggest [data-sg]:checked')].map((cb) => Number(cb.dataset.sg));
  if (checked.length === 0) { setStatus('请先勾选要采用的修订（或在正文里直接点 ✓）', 'err'); return; }
  for (const i of checked.sort((a, b) => b - a)) {
    const g = S.suggestions[i];
    if (g && g.pi !== undefined) await acceptSuggestion(g);
  }
}

/* ---------- 行内修订对照（左栏所见即所得） ---------- */

/** 在正文中唯一定位原句；多处或未找到返回 null */
function locateOriginal(session: FileSession, original: string): { pi: number; si: number } | null {
  const paras = extractParas(splitChapter(session.md).body);
  const hits: { pi: number; si: number }[] = [];
  paras.forEach((p, pi) =>
    sentsOf(p, false).forEach((sent, si) => {
      if (sent === original) hits.push({ pi, si });
    }),
  );
  return hits.length === 1 ? hits[0] : null;
}

/** 为 pending 建议挂行内（不唯一匹配的只进修订建议表） */
function attachInlineSuggestions(): void {
  const s = activeSession();
  if (!s) return;
  for (const g of S.suggestions) {
    if (g.status && g.status !== 'pending') continue;
    g.status = 'pending';
    if (g.pi === undefined) {
      const loc = locateOriginal(s, g.original);
      if (!loc) continue;
      g.pi = loc.pi;
      g.si = loc.si;
    }
    renderInlineOne(s, g);
  }
}

function renderInlineOne(session: FileSession, g: Suggestion): void {
  if (g.pi === undefined || g.si === undefined) return;
  const sentEl = document.querySelector(`.sent[data-pi="${g.pi}"][data-si="${g.si}"]`);
  if (!sentEl || sentEl.nextElementSibling?.classList.contains('inline-sug')) return;
  sentEl.classList.add('sug-pending');
  const bad = g.check.passive || g.check.relcl || g.check.pastperf || g.check.overlong;
  const div = document.createElement('span');
  div.className = 'inline-sug';
  div.dataset.markId = g.markId;
  div.innerHTML = `
    <span class="rev-text">${esc(g.revised)}</span>
    ${bad ? `<span class="sug-warn">⚠ 引擎复核：仍含${[g.check.passive ? '被动' : '', g.check.relcl ? '定从' : '', g.check.pastperf ? '过去完成' : '', g.check.overlong ? '超长' : ''].filter(Boolean).join('/')}</span>` : ''}
    <span class="sug-basis">${esc(g.basis)}${g.alternative ? '｜备选：' + esc(g.alternative) : ''}</span>
    <button class="btn-ok">✓ 采纳（正文立即更新，改动记入工作稿）</button>
    <button class="btn-no">✗ 放弃</button>`;
  div.querySelector('.btn-ok')!.addEventListener('click', () => void acceptSuggestion(g));
  div.querySelector('.btn-no')!.addEventListener('click', () => {
    g.status = 'rejected';
    div.remove();
    sentEl.classList.remove('sug-pending');
    S.suggestions = S.suggestions.filter((x) => x !== g);
    renderSuggestions();
  });
  sentEl.after(div);
}

/** 保存正文改动：默认直接写原稿文件（首次前自动备份原始版）；关闭"直接修改原稿"则写工作稿 */
async function persistEdit(s: FileSession, newMd: string): Promise<string> {
  if (s.sourcePath && (S.appConfig.inPlaceEdit ?? true)) {
    const dir = s.sourcePath.slice(0, s.sourcePath.lastIndexOf('/'));
    const base = s.fileName.replace(/\.(md|txt|markdown)$/i, '');
    const backup = `${dir}/${base}_原始备份.md`;
    try {
      await invoke<string>('read_text_file', { path: backup });
    } catch {
      await invoke('write_text_file', { path: backup, content: s.md });
    }
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

/** 文本变化后，按句子前缀把现有标记重新对齐（防替换/拆句后错位） */
function remapMarks(session: FileSession): void {
  const paras = extractParas(splitChapter(session.md).body);
  const sents = paras.map((p) => sentsOf(p, false));
  for (const m of session.review.marks) {
    const prefix = (m.text ?? '').slice(0, 12);
    if (!prefix) continue; // 旧数据无句前缀，保留原索引
    const cur = sents[m.pi]?.[m.si];
    let ok = cur && cur.startsWith(prefix);
    if (!ok) {
      const hits: [number, number][] = [];
      sents.forEach((ss, pi) => ss.forEach((sent, si) => { if (sent.startsWith(prefix)) hits.push([pi, si]); }));
      if (hits.length === 1) {
        m.pi = hits[0][0];
        m.si = hits[0][1];
        ok = true;
      }
    }
    if (ok && m.level === 'word' && m.word) {
      const sent = sents[m.pi]?.[m.si] ?? '';
      const toks = tokenizeTxt(sent);
      const raws = sent.match(/[A-Za-z][A-Za-z'\-]*/g) ?? [];
      const wi = raws.findIndex((w, i) => (toks[i] ?? w.toLowerCase()) === m.word!.toLowerCase());
      if (wi >= 0) m.wi = wi;
    }
  }
}

async function acceptSuggestion(g: Suggestion): Promise<void> {
  const s = activeSession();
  if (!s || g.pi === undefined || g.si === undefined) return;
  const paras = extractParas(splitChapter(s.md).body);
  const cur = sentsOf(paras[g.pi] ?? '', false)[g.si];
  if (cur !== g.original) {
    const loc = locateOriginal(s, g.original);
    if (!loc) { setStatus('原句已变化且无法唯一定位，请重新请求建议', 'err'); return; }
    g.pi = loc.pi; g.si = loc.si;
  }
  const at = s.md.indexOf(g.original);
  if (at < 0) { setStatus('正文中找不到该原句', 'err'); return; }
  s.md = s.md.slice(0, at) + g.revised + s.md.slice(at + g.original.length);

  // 标记对齐 + 对应标记清除 + 落盘
  const removed = s.review.marks.filter((m) => m.id === g.markId);
  s.review.marks = s.review.marks.filter((m) => m.id !== g.markId);
  remapMarks(s);
  g.status = 'accepted';
  S.suggestions = S.suggestions.filter((x) => x !== g);

  const date = new Date().toLocaleDateString('sv-SE');
  const tier = (s.report?.tier ?? ($('tier') as HTMLSelectElement).value) as Tier;
  const outDir = s.sourcePath ? s.sourcePath.slice(0, s.sourcePath.lastIndexOf('/')) : await invoke<string>('reports_dir');
  const logPath = `${outDir}/变更日志_AI审核.csv`;
  try {
    const savedTo = await persistEdit(s, s.md);
    let csv = '';
    try { csv = await invoke<string>('read_text_file', { path: logPath }); } catch { /* 新建 */ }
    if (!csv.trim()) csv = CHANGELOG_HEADER.join(',') + '\n';
    csv += [
      'R1', date, tier,
      `P${String((g.pi ?? 0) + 1).padStart(2, '0')}`,
      `P${(g.pi ?? 0) + 1}-S${(g.si ?? 0) + 1}`,
      g.original, g.revised,
      RULE_BY_TYPE[removed[0]?.type ?? ''] ?? 'R00',
      g.basis, 'AI候选-行内采纳',
    ].map(csvCell).join(',') + '\n';
    await invoke('write_text_file', { path: logPath, content: csv });
    scheduleSave(s, () => undefined);
    renderReader(s);
    attachInlineSuggestions();
    renderSidebar(s, sidebarHandlers);
    renderSuggestions();
    setStatus(`✓ 已采纳并写入 ${savedTo}${savedTo === s.sourcePath ? '（原稿，首改前已备份原始版）' : ''}；变更已记入日志`, 'saved');
    flashApplied(g.revised);
  } catch (e) {
    setStatus('落盘失败：' + e, 'err');
  }
}

/* ---------- 词面板：AI 改写本句 ---------- */

async function aiRewriteSentence(pi: number, si: number, intent: string, autoMarkId?: string): Promise<void> {
  const s = activeSession();
  if (!s) return;
  const key = await invoke<string>('load_api_key');
  if (!key) { showAiSettings(); return; }
  const paras = extractParas(splitChapter(s.md).body);
  const sent = sentsOf(paras[pi] ?? '', false)[si];
  if (!sent) return;
  const tier = (s.report?.tier ?? ($('tier') as HTMLSelectElement).value) as Tier;
  const system = await buildSystemPrompt();
  const btn = pop.querySelector('[data-mk="__rewrite"]') as HTMLElement | null;
  if (btn) { btn.textContent = '⏳ 改写中…'; (btn as HTMLButtonElement).disabled = true; }
  try {
    const { content, usage } = await callChat([
      { role: 'system', content: system },
      {
        role: 'user',
        content: `层级：${tier}（句长上限 ${tierMaxLen(tier)} 词）\n教师意图：${intent}\n请改写下面这句。输出要求：回答的第一个字符必须是 [，只输出一个 JSON 数组（形如 [{"original":"…","revised":"…","basis":"…"}]），不要思考过程、不要解释、不要代码块。original 必须与原句一字不差：\n${sent}`,
      },
    ], 4000);
    const arr = parseAiJson(content) as { original?: string; revised?: string; basis?: string; alternative?: string }[];
    const one = arr[0];
    if (!one?.revised) throw new Error('AI 未返回改写');
    const risk = checkRev(String(one.revised), tier);
    const g: Suggestion = {
      markId: autoMarkId ?? 'rw-' + Date.now().toString(36), type: intent || '词改写',
      original: String(one.original ?? sent), revised: String(one.revised),
      basis: one.basis ?? '', alternative: one.alternative, status: 'pending',
      check: { passive: risk.passive, relcl: risk.relcl, pastperf: risk.pastperf, overlong: risk.overlong },
    };
    if (autoMarkId) {
      hidePop();
      await acceptSuggestion(g);
      return;
    }
    S.suggestions.push(g);
    hidePop();
    attachInlineSuggestions();
    setStatus('AI 已给出本句改写——正文黄色区域内点 ✓ 采纳或 ✗ 放弃', 'saved');
  } catch (e) {
    const hint = String(e).includes('未找到 JSON')
      ? '（原因：你的模型把"思考过程"写进了回答，占满了输出上限还没写到 JSON——AI 设置里换非思考型模型如 deepseek-chat 最省心）'
      : '';
    setStatus('AI 改写失败：' + e + hint, 'err');
  } finally {
    if (btn) { btn.textContent = '✨ AI 改写本句'; (btn as HTMLButtonElement).disabled = false; }
  }
}

$('btn-ai').addEventListener('click', () => void aiSuggest());

/* ================= 分层初稿：首次导入按方向整章大改（两阶段工作流的第一阶段） ================= */

const draftPop = $('draft-pop');

const TIER_DRAFT_RULES: Record<string, string> = {};
function tierRule(tier: string): string {
  if (!TIER_DRAFT_RULES[tier]) {
    const p = tierPlan(tier);
    TIER_DRAFT_RULES[tier] = `${p.name} 层：平均句长 ≤${p.maxLen} 词；${p.desc}；${
      p.passiveFromCh ? `被动语态第 ${p.passiveFromCh} 章起解禁（之前禁用）` : '被动语态禁用'
    }；${p.relclFromCh ? `定语从句第 ${p.relclFromCh} 章起解禁（之前禁用）` : '定语从句禁用'}；过去完成时一律改写为一般过去时或 before/after 明示。`;
  }
  return TIER_DRAFT_RULES[tier];
}

function showDraftPop(): void {
  const s = activeSession();
  if (!s) { setStatus('请先打开要简化的章节原文', 'err'); return; }
  draftPop.innerHTML = `
    <div class="pop-h">分层初稿 · 整章按方向大改</div>
    <p style="color:var(--muted);font-size:12px;line-height:1.7;margin:6px 0 10px">
      对「${esc(s.fileName)}」按所选层级逐段生成简化初稿（保留段落结构与全部情节），完成后自动质检、开新 tab——原稿不动，之后进入标记精修流程。</p>
    <div class="fld"><label>层级（取当前工具栏选择，可在上方切换）</label><div id="draft-tier" style="font-weight:600"></div></div>
    <div class="fld"><label>方向指令（写你的整体要求，AI 全程遵守）</label>
      <textarea id="draft-instructions" placeholder="例如：面向九年级；歌篇原样保留不改写；人名保留原文；第 3 段 Major 的演讲要压缩到一半"></textarea></div>
    <div class="row-btns">
      <button id="draft-start" class="primary">开始生成</button>
      <button id="draft-cancel" style="display:none">取消</button>
      <button id="draft-close">关闭</button>
    </div>
    <div id="draft-progress" style="display:none">
      <div id="draft-step"></div>
      <div class="bar"><i id="draft-bar"></i></div>
    </div>`;
  draftPop.classList.add('open');
  const t = ($('tier') as HTMLSelectElement).value as Tier;
  $('draft-tier').textContent = t + ' 层';
  $('draft-close').addEventListener('click', () => { S.draftAbort?.abort(); draftPop.classList.remove('open'); });
  $('draft-cancel').addEventListener('click', () => { S.draftAbort?.abort(); });
  $('draft-start').addEventListener('click', () => void generateDraft());
}

function cleanDraftSeg(text: string, fallbackMarker: string): string {
  let t = text.trim();
  t = t.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '');
  if (!t.includes('[P')) t = fallbackMarker + ' ' + t; // AI 丢了段标记则补回
  return t.trim();
}

async function generateDraft(): Promise<void> {
  const s = activeSession();
  if (!s) return;
  const key = await invoke<string>('load_api_key');
  if (!key) { showAiSettings(); return; }
  const tier = (s.report?.tier ?? ($('tier') as HTMLSelectElement).value) as Tier;
  const instructions = ($('draft-instructions') as HTMLTextAreaElement).value.trim();
  const chno = s.sourcePath ? chnoFromPath(s.sourcePath) : null;

  const md = s.md;
  const chLine = md.match(/^## Chapter \w+.*$/m)?.[0] ?? '## Chapter One';
  const header = md.slice(0, md.indexOf(chLine)) || '';
  const body = splitChapter(md).body;
  const segs = body.match(/\[P\d+\][\s\S]*?(?=\[P\d+\]|$)/g) ?? [];
  if (segs.length === 0) { setStatus('未找到 [P##] 段落，无法生成初稿', 'err'); return; }

  S.draftAbort = new AbortController();
  const startBtn = $('draft-start') as HTMLButtonElement;
  startBtn.disabled = true;
  ($('draft-cancel') as HTMLElement).style.display = '';
  $('draft-progress').style.display = '';
  let tokens = 0;
  try {
    const system = `${await buildSystemPrompt()}

你的任务：把英文原著章节逐段改写成分层简化版。规则：
- ${TIER_DRAFT_RULES[tier] ?? TIER_DRAFT_RULES.M}${chno ? `（本章章号 ${chno}）` : ''}
- 直接引语只降词不降句式：人物原话的句法结构保留，只把超纲词换成词表内近义词（用引号原样保留引语）。
- 情节零丢失：每个情节点、人物动作、因果、伏笔都必须保留；这是底线。
- 输出：保持输入段落的 [P##] 标记原样开头，直接输出该段简化文本，不要任何解释、标题或代码块。
${instructions ? `\n教师方向指令（最高优先级）：${instructions}` : ''}`;
    const out: string[] = [];
    for (let i = 0; i < segs.length; i++) {
      $('draft-step').textContent = `正在简化第 ${i + 1}/${segs.length} 段（${segs[i].slice(0, 8).trim()}…）`;
      ($('draft-bar') as HTMLElement).style.width = `${(i / segs.length) * 100}%`;
      const prevTail = out.length ? out[out.length - 1].slice(-500) : '（本章开头）';
      const { content, usage } = await callChat([
        { role: 'system', content: system },
        {
          role: 'user',
          content: `前文（已简化，供语气与指代衔接参考）：\n…${prevTail}\n\n请简化以下段落：\n${segs[i].trim()}`,
        },
      ], 2500, S.draftAbort!.signal);
      tokens += Number(usage.match(/(\d+) 出/)?.[1] ?? 0);
      out.push(applyRewrite(cleanDraftSeg(content, segs[i].match(/\[P\d+\]/)![0])));
    }
    ($('draft-bar') as HTMLElement).style.width = '100%';
    $('draft-step').textContent = '生成完毕，正在保存并质检…';

    const date = new Date().toLocaleDateString('sv-SE');
    const newMd = `${header}${chLine}\n\n${out.join('\n\n')}\n`;
    let outPath: string;
    if (s.sourcePath) {
      const dir = s.sourcePath.slice(0, s.sourcePath.lastIndexOf('/'));
      outPath = `${dir}/${s.fileName.replace(/\.(md|txt|markdown)$/i, '')}_分层初稿_${tier}_${date}.md`;
    } else {
      const dir = await invoke<string>('reports_dir');
      outPath = `${dir}/示例_分层初稿_${tier}_${date}.md`;
    }
    await invoke('write_text_file', { path: outPath, content: newMd });
    draftPop.classList.remove('open');
    await addSession(newMd, outPath.slice(outPath.lastIndexOf('/') + 1), outPath);
    await runQcCurrent();
    setStatus(`分层初稿已生成（${tier} 层，${segs.length} 段，约 ${tokens} 出tokens）：${outPath}。质检指标见报告页——继续用标记精修`, 'saved');
    void invoke('reveal_path', { path: outPath });
  } catch (e) {
    $('draft-step').textContent = '✗ 中断：' + e;
  } finally {
    startBtn.disabled = false;
    ($('draft-cancel') as HTMLElement).style.display = 'none';
    S.draftAbort = null;
  }
}

$('btn-draft').addEventListener('click', showDraftPop);
$('tier-q').addEventListener('click', (e) => { e.stopPropagation(); showTierPlanPop(); });

/* ---------- 启动序列：配置 → 首启动欢迎 ---------- */
setAiUi({ onStatus: (s) => setStatus(s, 'dirty') });

void (async () => {
  await loadConfig();
  if (!S.appConfig.firstRunSeen) showWelcome();
  await restoreChat();
  await renderRecentInEmpty();
})();

/* ================= 分层方案（B/M/A 标准可调） · 本书配置 · 首启动欢迎 ================= */

const tierPop = $('tier-pop');

function showTierPlanPop(): void {
  const rows = (['B', 'M', 'A'] as const).map((t) => {
    const p = tierPlan(t);
    return `
    <div class="tier-row" data-tier="${t}">
      <div class="tier-name">${p.name}<span class="dim">${t}</span></div>
      <div class="tier-fields">
        <label>句长上限 <input type="number" data-f="maxLen" value="${p.maxLen}" min="8" max="30" style="width:56px" /> 词</label>
        <label>被动解禁 <input type="number" data-f="passiveFromCh" value="${p.passiveFromCh}" min="0" max="30" style="width:56px" /> 章起（0=全书禁用）</label>
        <label>定从解禁 <input type="number" data-f="relclFromCh" value="${p.relclFromCh}" min="0" max="30" style="width:56px" /> 章起（0=全书禁用）</label>
        <input type="text" data-f="desc" value="${esc(p.desc)}" style="flex:1" />
      </div>
    </div>`;
  }).join('');
  tierPop.innerHTML = `
    <div class="pop-h">分层方案 —— 三个难度层的标准</div>
    <p class="dim" style="margin:4px 0 10px">B=支架（最易）/ M=中梯 / A=挑战（最难）。默认值来自教学进度的通用设定；你的学生你最了解，改成适合他们的标准。改动影响：质检参考值、AI 改写规则、分层初稿。</p>
    ${rows}
    <div class="row-btns">
      <button id="tier-save" class="primary">保存</button>
      <button id="tier-reset">恢复默认</button>
      <button id="tier-close">关闭</button>
    </div>`;
  tierPop.classList.add('open');
  $('tier-close').addEventListener('click', () => tierPop.classList.remove('open'));
  $('tier-reset').addEventListener('click', async () => { S.appConfig.tiers = undefined; await saveConfig(); tierPop.classList.remove('open'); setStatus('分层方案已恢复默认', 'saved'); });
  $('tier-save').addEventListener('click', async () => {
    const tiers: Record<string, TierPlan> = {};
    for (const row of tierPop.querySelectorAll('.tier-row')) {
      const t = (row as HTMLElement).dataset.tier!;
      const base = DEFAULT_TIER_PLANS[t];
      tiers[t] = {
        name: base.name,
        desc: (row.querySelector('[data-f="desc"]') as HTMLInputElement).value.trim() || base.desc,
        maxLen: Number((row.querySelector('[data-f="maxLen"]') as HTMLInputElement).value) || base.maxLen,
        passiveFromCh: Number((row.querySelector('[data-f="passiveFromCh"]') as HTMLInputElement).value) || 0,
        relclFromCh: Number((row.querySelector('[data-f="relclFromCh"]') as HTMLInputElement).value) || 0,
      };
    }
    S.appConfig.tiers = tiers;
    for (const k of Object.keys(TIER_DRAFT_RULES)) delete TIER_DRAFT_RULES[k];
    await saveConfig();
    tierPop.classList.remove('open');
    const s = activeSession();
    if (s) renderAll();
    setStatus('分层方案已保存', 'saved');
  });
}
document.addEventListener('mousedown', (e) => {
  if (tierPop.classList.contains('open') && !(e.target as HTMLElement).closest('#tier-pop') && !(e.target as HTMLElement).closest('#tier-q')) tierPop.classList.remove('open');
});

/* ---------- 本书配置：词库/术语/专名/约定 随书稿文件夹保存与自动加载 ---------- */

const BOOK_CONFIG = '_LayerText项目.json';

async function saveBookConfig(): Promise<void> {
  const s = activeSession();
  if (!s?.sourcePath) { setStatus('先打开本书的一个章节文件，配置会保存在它旁边', 'err'); return; }
  const dir = s.sourcePath.slice(0, s.sourcePath.lastIndexOf('/'));
  const cfg = {
    说明: 'LayerText 本书配置——放在书稿文件夹里，打开同文件夹任何章节自动生效',
    vocabCsv: S.vocabCsvText ?? null,
    vocabName: S.vocabName,
    terms: S.termsText ?? null,
    proper: S.properRows.length ? S.properRows : null,
    instructions: S.appConfig.instructions ?? null,
    rewrite: S.rewriteRules.replacements.length || S.rewriteRules.viewpoint !== 'keep' || S.rewriteRules.extra ? S.rewriteRules : null,
    savedAt: new Date().toLocaleString('zh-CN'),
  };
  try {
    await invoke('write_text_file', { path: `${dir}/${BOOK_CONFIG}`, content: JSON.stringify(cfg, null, 1) });
    setStatus(`已保存为本书配置：${dir}/${BOOK_CONFIG}——这本书后续章节打开即自动带上词库与约定`, 'saved');
    void invoke('reveal_path', { path: `${dir}/${BOOK_CONFIG}` });
  } catch (e) {
    setStatus('保存失败：' + e, 'err');
  }
}

async function loadBookConfig(dir: string): Promise<boolean> {
  try {
    const raw = await invoke<string>('read_text_file', { path: `${dir}/${BOOK_CONFIG}` });
    const cfg = JSON.parse(raw) as { vocabCsv?: string | null; vocabName?: string; terms?: string | null; proper?: string[] | null; instructions?: string | null; rewrite?: typeof S.rewriteRules };
    if (cfg.vocabCsv) { S.vocabCsvText = cfg.vocabCsv; S.vocabName = cfg.vocabName ?? '本书词库'; }
    if (cfg.terms) S.termsText = cfg.terms;
    S.properRows = cfg.proper ?? [];
    if (cfg.instructions) S.appConfig.instructions = cfg.instructions;
    if (cfg.rewrite) S.rewriteRules = { replacements: cfg.rewrite.replacements ?? [], viewpoint: cfg.rewrite.viewpoint ?? 'keep', viewpointName: cfg.rewrite.viewpointName ?? '', extra: cfg.rewrite.extra ?? '' };
    return Boolean(cfg.vocabCsv || cfg.terms || cfg.proper?.length || cfg.rewrite);
  } catch {
    return false;
  }
}

/* ---------- 导出 Word（学生用，含章末词句卡） ---------- */

function bufToB64(buf: ArrayBuffer): string {
  const bin = new Uint8Array(buf);
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bin.length; i += CHUNK) s += String.fromCharCode(...bin.subarray(i, i + CHUNK));
  return btoa(s);
}

async function exportDocx(): Promise<void> {
  const s = activeSession();
  if (!s) { setStatus('请先打开要导出的章节', 'err'); return; }
  try {
    const body = splitChapter(s.md).body;
    const card = splitChapter(s.md).card;
    const paras = extractParas(body);
    const children: (Paragraph | Table)[] = [
      new Paragraph({ text: s.fileName.replace(/\.(md|txt|markdown)$/i, ''), heading: HeadingLevel.HEADING_1 }),
    ];
    for (let i = 0; i < paras.length; i++) {
      const text = applyRewrite(sentsOf(paras[i], false).join(' ').replace(/\s+/g, ' ').trim());
      if (text) children.push(new Paragraph({ children: [new TextRun({ text, size: 24, font: 'Georgia' })], spacing: { after: 160 } }));
    }
    const rows = card.split('\n').filter((l) => l.trim().startsWith('|') && !/^\|[\s:-]+\|$/.test(l.trim()));
    if (rows.length >= 2) {
      children.push(new Paragraph({ text: '词句卡', heading: HeadingLevel.HEADING_2, pageBreakBefore: true }));
      children.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: rows.map((r) => {
          const cells = r.trim().replace(/^\|+|\|+$/g, '').split('|').map((c) => c.trim());
          return new TableRow({
            children: cells.map((c) => new TableCell({ children: [new Paragraph(c)] })),
          });
        }),
      }));
    }
    const doc = new Document({ sections: [{ children }] });
    const buf = await Packer.toBuffer(doc);
    const out = s.sourcePath
      ? s.sourcePath.slice(0, s.sourcePath.lastIndexOf('/')) + '/' + s.fileName.replace(/\.(md|txt|markdown)$/i, '') + '.docx'
      : (await invoke<string>('reports_dir')) + '/示例导出.docx';
    await invoke('write_file_base64', { path: out, b64: bufToB64((buf.buffer as ArrayBuffer).slice(buf.byteOffset, buf.byteOffset + buf.byteLength)) });
    setStatus('已导出 Word 版：' + out, 'saved');
    void invoke('reveal_path', { path: out });
  } catch (e) {
    setStatus('导出失败：' + e, 'err');
  }
}

/* ---------- 朗读音频导出（macOS 系统语音） ---------- */

async function exportTts(): Promise<void> {
  const s = activeSession();
  if (!s) { setStatus('请先打开章节', 'err'); return; }
  try {
    const text = applyRewrite(extractParas(splitChapter(s.md).body)
      .map((p) => sentsOf(p, false).join(' '))
      .join('\n')
      .replace(/\[[P\d\s]*?\]/g, '')
      .trim());
    if (!text) throw new Error('正文为空');
    const base = s.sourcePath ? s.sourcePath.slice(0, s.sourcePath.lastIndexOf('/')) + '/' + s.fileName.replace(/\.(md|txt|markdown)$/i, '') : (await invoke<string>('reports_dir')) + '/示例朗读';
    const out = base + '.aiff';
    setStatus('正在生成朗读音频（几分钟文本约需几十秒）…');
    await invoke('export_tts', { text, path: out, voice: 'Samantha' });
    setStatus('已导出朗读音频：' + out, 'saved');
    void invoke('reveal_path', { path: out });
  } catch (e) {
    setStatus('导出失败：' + e, 'err');
  }
}

/* ---------- 版本对比 ---------- */

function renderDiff(lIdx: number, rIdx: number): void {
  const pane = $('pane-diff');
  const L = S.sessions[lIdx];
  const R = S.sessions[rIdx];
  if (!L || !R) { pane.innerHTML = '<div class="empty">先打开两个版本文件（如原文与分层初稿）</div>'; return; }
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
      <select id="diff-l">${S.sessions.map((x, i) => `<option value="${i}" ${i === lIdx ? 'selected' : ''}>${esc(x.fileName)}</option>`).join('')}</select>
      <span>↔</span>
      <select id="diff-r">${S.sessions.map((x, i) => `<option value="${i}" ${i === rIdx ? 'selected' : ''}>${esc(x.fileName)}</option>`).join('')}</select>
      <span style="color:var(--muted);font-size:12px">段落一致 ${same}/${n}（红=仅左侧版本，绿=仅右侧版本/已修改）</span>
    </div>
    <table class="sgtable">
      <tr><th>段</th><th style="width:44%">${esc(L.fileName)}</th><th style="width:44%">${esc(R.fileName)}</th></tr>
      ${rows}
    </table>`;
  $('diff-l').addEventListener('change', () => renderDiff(Number(($('diff-l') as HTMLSelectElement).value), rIdx));
  $('diff-r').addEventListener('change', () => renderDiff(lIdx, Number(($('diff-r') as HTMLSelectElement).value)));
}

/* ---------- 新手导览（coach marks） ---------- */

const TOUR = [
  { sel: '#btn-demo', title: '① 打开课文', text: '点「载入示例」看演示，或「打开章节文件」选你自己的书（Word 文件也可以，会自动转换）。' },
  { sel: '#btn-run', title: '② 一键体检', text: '点「▶ 质检本章」：软件自动数生词率、句长、难句，生成体检报告。' },
  { sel: '#reader', title: '③ 边读边标', text: '红色下划线是生词、淡红底是难句。点一个词、或拖选一句话，就能做标记。' },
  { sel: '#sidebar', title: '④ 收尾把关', text: '右侧是审校清单：要点配额、终审门禁、标记清单。四项门禁全勾，这一章就算审完。' },
];

function tourShow(i: number): void {
  S.tourIdx = i;
  const tip = $('tour-pop');
  if (i < 0 || i >= TOUR.length) {
    tip.classList.remove('open');
    $('tour-hl').style.display = 'none';
    void (async () => { S.appConfig.tourSeen = true; await saveConfig(); })();
    return;
  }
  const step = TOUR[i];
  const el = document.querySelector(step.sel) as HTMLElement | null;
  if (!el) { tourShow(i + 1); return; }
  const r = el.getBoundingClientRect();
  const hl = $('tour-hl');
  hl.style.cssText = `display:block;left:${r.left - 6}px;top:${r.top - 6}px;width:${r.width + 12}px;height:${r.height + 12}px`;
  tip.innerHTML = `<div class="pop-h">${step.title}</div><p style="line-height:1.8">${step.text}</p>
    <div class="row-btns"><button id="tour-next" class="primary">${i === TOUR.length - 1 ? '完成' : '下一步'}</button><button id="tour-skip">跳过导览</button></div>`;
  tip.classList.add('open');
  const tr = tip.getBoundingClientRect();
  tip.style.left = Math.min(Math.max(8, r.left), window.innerWidth - tr.width - 12) + 'px';
  tip.style.top = (r.bottom + 10 + tr.height > window.innerHeight ? Math.max(8, r.top - tr.height - 10) : r.bottom + 10) + 'px';
  $('tour-next').addEventListener('click', () => tourShow(i + 1));
  $('tour-skip').addEventListener('click', () => tourShow(-1));
}

/* ---------- 书级改写规则：确定性替换（机器做，零遗漏） + 视角与全局规则（注入 AI） ---------- */

interface RewriteRule { from: string; to: string; }

const rewritePop = $('rewrite-pop');

function applyRewrite(text: string): string {
  return applyRewriteTo(text, S.rewriteRules.replacements);
}

/** 规则文本（注入每次 AI 请求） */
/** 校验：替换残留与视角代词密度（机器核对，不靠 AI 自觉） */
function rewriteCheck(): string {
  const s = activeSession();
  if (!s) return '先打开章节';
  const out: string[] = [];
  let body = '';
  try { body = splitChapter(s.md).body; } catch { return '正文解析失败'; }
  for (const r of S.rewriteRules.replacements) {
    if (!r.from) continue;
    const esc = r.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const left = (body.match(new RegExp(`\\b${esc}\\b`, 'g')) ?? []).length;
    const used = (body.match(new RegExp(`\\b${r.to.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')) ?? []).length;
    out.push(left === 0
      ? `✓ "${r.from}" → "${r.to}"：无残留（新词出现 ${used} 次）`
      : `✗ "${r.from}" 仍有 ${left} 处未替换（新词 "${r.to}" 出现 ${used} 次）——可点下方"对当前章节执行替换"由机器补齐`);
  }
  if (S.rewriteRules.viewpoint === 'first') {
    const he = (body.match(/\b(he|his|him|she|her)\b/gi) ?? []).length;
    const I = (body.match(/\b(I|my|me)\b/g) ?? []).length;
    out.push(`视角（第一人称）：第三人称代词 ${he} 处 / 第一人称 ${I} 处${he > I * 2 ? ' ⚠ 第一人称占比偏低，建议用「分层初稿」按规则重写' : ''}`);
  }
  return out.length ? out.join('\n') : '尚未设置规则';
}

function saveRewriteToBook(): void {
  void (async () => {
    const s = activeSession();
    if (!s?.sourcePath) { setStatus('规则随本书保存——先打开本书章节', 'err'); return; }
    const dir = s.sourcePath.slice(0, s.sourcePath.lastIndexOf('/'));
    try {
      const raw = await invoke<string>('read_text_file', { path: `${dir}/${BOOK_CONFIG}` });
      const cfg = JSON.parse(raw) as Record<string, unknown>;
      cfg.rewrite = S.rewriteRules;
      cfg.savedAt = new Date().toLocaleString('zh-CN');
      await invoke('write_text_file', { path: `${dir}/${BOOK_CONFIG}`, content: JSON.stringify(cfg, null, 1) });
      setStatus('书级改写规则已保存（随本书配置，每章自动生效）', 'saved');
    } catch {
      setStatus('保存失败：请先执行过「保存为本书配置」', 'err');
    }
  })();
}

function showRewritePop(): void {
  rewritePop.innerHTML = `
    <div class="pop-h">书级改写规则 —— 全书一致的大改动</div>
    <p class="dim" style="margin:4px 0 8px">两类规则：<b>人名/词汇替换</b>由机器确定性执行（不会漏）；<b>叙事视角与全局要求</b>注入每次 AI 请求并自动校验。规则随本书保存，每章生效。</p>
    <div id="rw-rows"></div>
    <button id="rw-add" style="font-size:12px">＋ 添加替换（如 Napoleon → 大猪拿破仑 / Jim → I）</button>
    <div class="fld" style="margin-top:10px"><label>叙事视角</label>
      <select id="rw-view">
        <option value="keep">保持原叙事（默认）</option>
        <option value="first">全书改为第一人称"I"叙述</option>
      </select>
      <input id="rw-name" placeholder="主角名（第一人称时的叙述者，如 Napoleon）" style="margin-top:6px" /></div>
    <div class="fld"><label>其他全局要求（注入每次 AI 请求）</label>
      <textarea id="rw-extra" style="width:100%;height:48px;border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:12px;font-family:inherit;resize:vertical;" placeholder="如：所有对话保留原话不改写；年代背景改为当代中国校园"></textarea></div>
    <div class="row-btns">
      <button id="rw-save" class="primary">保存规则（随本书）</button>
      <button id="rw-check">检查当前章节</button>
      <button id="rw-apply">对当前章节执行替换</button>
      <button id="rw-close">关闭</button>
    </div>
    <pre id="rw-out" style="white-space:pre-wrap;font-size:12px;color:var(--muted);margin-top:8px;max-height:160px;overflow:auto"></pre>`;
  rewritePop.classList.add('open');

  const rows = () => rewritePop.querySelector('#rw-rows')!;
  const addRow = (from = '', to = '') => {
    const div = document.createElement('div');
    div.className = 'rw-row';
    div.innerHTML = `<input class="rw-from" value="${esc(from)}" placeholder="原文词" /> → <input class="rw-to" value="${esc(to)}" placeholder="替换为" /><button class="x">×</button>`;
    div.querySelector('.x')!.addEventListener('click', () => div.remove());
    rows().appendChild(div);
  };
  const collect = () => {
    S.rewriteRules.replacements = [...rewritePop.querySelectorAll('.rw-row')].map((r) => ({
      from: (r.querySelector('.rw-from') as HTMLInputElement).value.trim(),
      to: (r.querySelector('.rw-to') as HTMLInputElement).value.trim(),
    })).filter((r) => r.from);
    S.rewriteRules.viewpoint = ($('rw-view') as HTMLSelectElement).value as 'keep' | 'first';
    S.rewriteRules.viewpointName = ($('rw-name') as HTMLInputElement).value.trim();
    S.rewriteRules.extra = ($('rw-extra') as HTMLTextAreaElement).value.trim();
  };
  for (const r of S.rewriteRules.replacements) addRow(r.from, r.to);
  if (!S.rewriteRules.replacements.length) addRow();
  ($('rw-view') as HTMLSelectElement).value = S.rewriteRules.viewpoint;
  ($('rw-name') as HTMLInputElement).value = S.rewriteRules.viewpointName;
  ($('rw-extra') as HTMLTextAreaElement).value = S.rewriteRules.extra;

  $('rw-add').addEventListener('click', () => addRow());
  $('rw-close').addEventListener('click', () => rewritePop.classList.remove('open'));
  $('rw-save').addEventListener('click', () => { collect(); saveRewriteToBook(); });
  $('rw-check').addEventListener('click', () => { collect(); $('rw-out').textContent = rewriteCheck(); });
  $('rw-apply').addEventListener('click', () => {
    collect();
    const s = activeSession();
    if (!s) return;
    const before = s.md;
    s.md = applyRewrite(s.md);
    if (s.md === before) { $('rw-out').textContent = '无可替换内容（或原词已清零）'; return; }
    void (async () => {
      try {
        const savedTo = await persistEdit(s, s.md);
        renderReader(s);
        attachInlineSuggestions();
        renderSidebar(s, sidebarHandlers);
        $('rw-out').textContent = rewriteCheck();
        setStatus(`替换已执行并写入 ${savedTo}${savedTo === s.sourcePath ? '（已自动备份原始版）' : ''}`, 'saved');
      } catch (e) {
        setStatus('写入失败：' + e, 'err');
      }
    })();
  });
}
document.addEventListener('mousedown', (e) => {
  if (rewritePop.classList.contains('open') && !(e.target as HTMLElement).closest('#rewrite-pop')) rewritePop.classList.remove('open');
});

/* ---------- 首启动欢迎（三步式：欢迎 → 配 AI → 语言 → 导览） ---------- */

function showWelcome(): void {
  const wp = $('welcome-pop');
  wp.classList.add('open');
  const stepWelcome = () => {
    wp.innerHTML = `
      <div class="pop-h" style="font-size:17px">欢迎使用 LayerText 分层读 🎉</div>
      <p style="margin:8px 0 4px;line-height:1.8">这是帮你把英文原著<strong>简化成不同难度的版本</strong>给学生读的工具。先花一分钟完成初始设置：</p>
      <div class="w-steps">
        <div class="w-step"><b>① 连接 AI</b>（可跳过，不连也能用质检与标记）</div>
        <div class="w-step"><b>② 确认语言</b>（界面语言与要简化的文本语言）</div>
        <div class="w-step"><b>③ 开始使用</b>（打开课文后自动进入四步导览）</div>
      </div>
      <div class="row-btns">
        <button id="w-next" class="primary">开始设置</button>
        <button id="w-later">跳过，直接用</button>
      </div>`;
    $('w-next').addEventListener('click', stepAi);
    $('w-later').addEventListener('click', () => void closeWelcome());
  };

  const stepAi = () => {
    wp.innerHTML = `
      <div class="pop-h">① 连接 AI（第 1/2 步）</div>
      <p class="dim">AI 负责"帮改写"：分层初稿、逐句改写建议、对话助手。没 Key？点菜单 帮助 → 如何获取 AI 的 Key（教程 2 分钟）。也可以现在跳过，以后在菜单 LayerText → AI 设置 配。</p>
      <div class="fld" style="margin-top:8px"><label style="display:block;color:var(--muted);font-size:12px;margin-bottom:4px">选择服务商</label>
        <select id="w-provider">${AI_PROVIDERS.map((p, i) => `<option value="${i}">${p.name}</option>`).join('')}</select></div>
      <div class="fld"><label style="display:block;color:var(--muted);font-size:12px;margin-bottom:4px">API Key（sk-…，只存本机）</label>
        <input id="w-key" type="password" placeholder="粘贴你的 Key" style="width:100%" /></div>
      <div class="row-btns">
        <button id="w-save" class="primary">保存并下一步</button>
        <button id="w-skip">暂不配置，跳过</button>
      </div>
      <div class="dim" id="w-out" style="margin-top:6px;min-height:16px"></div>`;
    const applyProvider = (i: number) => {
      const p = AI_PROVIDERS[i];
      (wp.querySelector('#w-out') as HTMLElement).dataset.url = p.url;
      (wp.querySelector('#w-out') as HTMLElement).dataset.tip = p.keyTip;
    };
    applyProvider(0);
    $('w-provider').addEventListener('change', () => applyProvider(Number(($('w-provider') as HTMLSelectElement).value)));
    $('w-skip').addEventListener('click', stepLang);
    $('w-save').addEventListener('click', async () => {
      const out = $('w-out') as HTMLElement;
      const p = AI_PROVIDERS[Number(($('w-provider') as HTMLSelectElement).value)];
      const key = ($('w-key') as HTMLInputElement).value.trim();
      if (!key) { out.textContent = '还没填 Key——填了再保存，或点"跳过"'; return; }
      out.textContent = '连接中…';
      try {
        const resp = await tauriFetch(`${p.url}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({ model: p.models[0] ?? 'gpt-4o-mini', max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        S.appConfig.baseUrl = p.url;
        S.appConfig.model = p.models[0] ?? 'gpt-4o-mini';
        await saveConfig();
        await invoke('save_api_key', { key });
        out.textContent = '✓ 连接成功，已保存';
        setTimeout(stepLang, 600);
      } catch (e) {
        out.textContent = '✗ ' + aiErrHuman(e) + '（可跳过稍后再配）';
      }
    });
  };

  const stepLang = () => {
    wp.innerHTML = `
      <div class="pop-h">② 语言确认（第 2/2 步）</div>
      <div class="fld" style="margin-top:8px"><label style="display:block;color:var(--muted);font-size:12px;margin-bottom:4px">软件界面语言</label>
        <select id="w-ui-lang"><option selected>中文</option><option disabled>English（即将支持）</option></select></div>
      <div class="fld"><label style="display:block;color:var(--muted);font-size:12px;margin-bottom:4px">要简化的文本语言</label>
        <select id="w-text-lang"><option selected>英语（当前版本支持）</option><option disabled>其他语言（即将支持）</option></select>
        <div class="dim" style="margin-top:4px">词库与句法质检引擎基于中国课标英语词汇开发，当前针对英语文本。</div></div>
      <div class="row-btns">
        <button id="w-finish" class="primary">完成，开始使用</button>
      </div>`;
    $('w-finish').addEventListener('click', () => {
      void closeWelcome();
      setStatus('设置完成！点「载入示例」看演示，或「打开章节文件」开始你的书——首次载入后会有四步导览', 'saved');
    });
  };

  stepWelcome();
}
async function closeWelcome(): Promise<void> {
  $('welcome-pop').classList.remove('open');
  S.appConfig.firstRunSeen = true;
  await saveConfig();
}

$('btn-ai').addEventListener('click', () => void aiSuggest());

/* ================= AI 助手（右侧对话 · 本应用即 harness：模型可调用本地 QC 工具） ================= */

interface ChatMsg {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

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
      description: '取正文原句及其句法风险（编号从 0 起：pi=第几段-1，si=第几句-1。search_text 结果每行自带可直接使用的 get_sentence 参数，请直接复制，不要自行换算）',
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
      description: '在正文中搜索含关键词的句子；每行结果自带 get_sentence 的现成参数（pi/si），直接复制使用，禁止自行换算编号',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_edit',
      description: '【直接编辑】仅当教师开启信任模式且明确要求"直接改"时使用：核对原句后直接替换正文（自动落工作稿与变更日志，原稿不动）。original 必须与正文一字不差',
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

async function executeTool(name: string, argsJson: string): Promise<string> {
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
        const risk = sentenceRisks(sent, tierMaxLen(($('tier') as HTMLSelectElement).value));
        const oovWords = tokenizeTxt(sent).filter((t) => !hit(t, S.currentKnown) && t.length > 1);
        return JSON.stringify({ 原句: sent, 词数: sent.split(/\s+/).length, 被动: risk.passive, 定从: risk.relcl, 过去完成: risk.pastperf, 超长: risk.overlong, 句内词表外词: [...new Set(oovWords)] });
      }
      case 'search_text': {
        const q = String(args.query ?? '').toLowerCase();
        if (!q) return '错误：query 为空';
        const hits: string[] = [];
        extractParas(splitChapter(s.md).body).forEach((p, pi) => {
          sentsOf(p, false).forEach((sent, si) => {
            if (sent.toLowerCase().includes(q) && hits.length < 8) {
              hits.push(`get_sentence 参数 pi=${pi},si=${si}｜显示编号 P${pi + 1}-S${si + 1}｜${sent}`);
            }
          });
        });
        return hits.length ? hits.join('\n') : `（未找到含 "${q}" 的句子）`;
      }
      case 'apply_edit': {
        if (!S.appConfig.trustEdit) return '错误：教师未开启信任模式（AI 设置 → 允许 AI 直接编辑）。请改用 propose_revision 提交候选。';
        const original = String(args.original ?? '');
        const revised = String(args.revised ?? '');
        const basis = String(args.basis ?? '');
        if (!original || !revised) return '错误：original/revised 不能为空';
        if (!s.md.includes(original)) return '错误：original 与正文不匹配——先用 search_text / get_sentence 取原句逐字复制';
        const tier = (s.report?.tier ?? ($('tier') as HTMLSelectElement).value) as Tier;
        const risk = checkRev(revised, tier);
        const loc = locateOriginal(s, original);
        const g: Suggestion = {
          markId: String(args.markId ?? 'edit-' + Date.now().toString(36)), type: '直接编辑',
          original, revised, basis, status: 'pending',
          check: { passive: risk.passive, relcl: risk.relcl, pastperf: risk.pastperf, overlong: risk.overlong },
          ...(loc ? { pi: loc.pi, si: loc.si } : {}),
        };
        S.suggestions.push(g);
        renderSuggestions();
        await acceptSuggestion(g);
        return `已直接应用并写入工作稿（引擎复核：${risk.passive || risk.relcl || risk.pastperf || risk.overlong ? '仍命中黑名单/超长，建议教师复核' : '通过'}）。正文已实时更新。`;
      }
      case 'propose_revision': {
        const original = String(args.original ?? '');
        const revised = String(args.revised ?? '');
        if (!original || !revised) return '错误：original/revised 不能为空';
        if (!s.md.includes(original)) return '错误：original 与正文不匹配（须与正文原句一字不差），请先用 get_sentence/search_text 取原句';
        const tier = (s.report?.tier ?? ($('tier') as HTMLSelectElement).value) as Tier;
        const risk = checkRev(revised, tier);
        S.suggestions.push({
          markId: String(args.markId ?? 'chat-' + Date.now().toString(36)),
          type: '对话建议', original, revised, basis: String(args.basis ?? ''),
          check: { passive: risk.passive, relcl: risk.relcl, pastperf: risk.pastperf, overlong: risk.overlong },
        });
        renderSuggestions();
        attachInlineSuggestions();
        setStatus('AI 在对话中提交了 1 条修订候选（经引擎复核）——正文黄色区域点 ✓ 采纳', 'saved');
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
    S.chatMsgs.length === 0
      ? '<div class="chat-empty">与 AI 实时交流——它能调用本地工具（跑质检/查句子/列标记/提修订候选），所有验证由本机 QC 引擎完成。</div>'
      : S.chatMsgs
          .map((m) => {
            if (m.role === 'user') return `<div class="chat-msg user"><div class="bubble">${esc(m.content)}</div></div>`;
            if (m.role === 'tool') return '';
            const toolsHtml = ((m.tool_calls as { function: { name: string; arguments: string } }[] | undefined) ?? [])
              .map((t) => `<div class="chat-tool">🔧 ${esc(t.function.name)}(${esc(t.function.arguments.slice(0, 60))}${t.function.arguments.length > 60 ? '…' : ''})</div>`)
              .join('');
            return `<div class="chat-msg assistant">${toolsHtml}<div class="bubble" ${m.content === '' ? 'id="chat-cur"' : ''}>${esc(m.content)}</div></div>`;
          })
          .join('');
  log.scrollTop = log.scrollHeight;
}

async function sendChat(): Promise<void> {
  if (S.chatBusy) return;
  const s = activeSession();
  if (!s) { setStatus('请先打开章节再与 AI 交流', 'err'); return; }
  const input = $('chat-input') as HTMLTextAreaElement;
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  const key = await invoke<string>('load_api_key');
  if (!key) { setStatus('请先配置 AI（菜单 LayerText → AI 设置…）', 'err'); showAiSettings(); return; }

  S.chatBusy = true;
  ($('chat-send') as unknown as HTMLButtonElement).disabled = true;
  S.chatMsgs.push({ role: 'user', content: text });
  chatRender();
  const statusEl = $('chat-status');
  let usageTotal = '';

  try {
    const system = (await buildSystemPrompt()) +
      `\n\n7. 你的身份与固定工作方式（不要每次重新发明流程）：
- 你是分层简化审校引擎，不是聊天机器人：动作优先、回答简短，禁止长篇解释。
- 编号规则：get_sentence 的 pi/si 从 0 起（pi=段号-1，si=句号-1）；search_text 每行结果自带现成的 get_sentence 参数，直接复制使用，禁止自行换算。
- 修订类请求的标准流程（≤4 次工具调用完成）：search_text 定位 → get_sentence 取原句（original 必须逐字复制其"原句"字段）→ 按层级与书级规则改写 → 提交。
- 提交方式：${S.appConfig.trustEdit ? '信任模式已开启——教师说"直接改/改吧"时用 apply_edit 直接应用（自动落工作稿与变更日志，原稿不动）；教师说"给建议/看看"时仍用 propose_revision' : '教师未开启信任模式，一律用 propose_revision 提交候选，由教师在界面点 ✓ 采纳'}。
- 不要重复调用已知信息的工具；不要在一轮里既 apply 又 propose。
当前章节：${s.fileName}，标记 ${s.review.marks.length} 条。`;
    for (let round = 0; round < 8; round++) {
      const messages = [{ role: 'system', content: system }, ...S.chatMsgs];
      statusEl.textContent = round === 0 ? '思考中…' : `工具结果已回传，继续（第 ${round + 1} 轮）…`;
      const { content, toolCalls, usage } = await chatStream(messages, AI_TOOLS, (delta) => {
        const cur = document.getElementById('chat-cur');
        if (cur) cur.textContent += delta;
        const log = $('chat-log');
        log.scrollTop = log.scrollHeight;
      });
      usageTotal = usage;
      S.chatMsgs.push({ role: 'assistant', content, tool_calls: toolCalls.length ? toolCalls.map((t) => ({ id: t.id, type: 'function' as const, function: { name: t.name, arguments: t.arguments } })) : undefined });
      if (toolCalls.length === 0) {
        chatRender();
        break;
      }
      chatRender(); // 先展示工具调用条
      for (const t of toolCalls) {
        const result = await executeTool(t.name, t.arguments);
        S.chatMsgs.push({ role: 'tool', tool_call_id: t.id, content: result });
      }
    }
    statusEl.textContent = `就绪 ${usageTotal} · 对话 ${S.chatMsgs.filter((m) => m.role === 'user').length} 轮（已自动保存）`;
    scheduleChatSave();
  } catch (e) {
    statusEl.textContent = '出错：' + e;
  } finally {
    S.chatBusy = false;
    ($('chat-send') as unknown as HTMLButtonElement).disabled = false;
  }
}

$('chat-send').addEventListener('click', () => void sendChat());
$('chat-clear').addEventListener('click', () => { S.chatMsgs = []; chatRender(); scheduleChatSave(); setStatus('AI 对话已清空', ''); });
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
    const maxLen = tierMaxLen(tier);
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
          ${row('被动式', String(r.passive), gates2.passiveOk ? `已解禁（第${tierPlan('A').passiveFromCh}章起）·建议人工复核` : '0', !gates2.passiveOk && r.passive > 0)}
          ${row('定语从句', String(r.relcl), gates2.relclOk ? `已解禁（第${tierPlan('A').relclFromCh}章起）·建议人工复核` : '0', !gates2.relclOk && r.relcl > 0)}
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

