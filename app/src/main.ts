/**
 * LayerText 分层读 · 审校工作台 v0.2
 * 多版本文件 tab → 三态高亮正文 → 点词/拖选句标记 → 侧栏（配额/门禁/清单）→ 标记自动落盘。
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getVersion } from '@tauri-apps/api/app';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open as openFileDialog, save as saveFileDialog } from '@tauri-apps/plugin-dialog';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import * as XLSX from 'xlsx';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType } from 'docx';
import {
  applyRewriteTo,
  buildBookReportMd,
  buildDiagSummary,
  buildVersionCards,
  checkRevisedText,
  chnoFromPath,
  tagFromPath,
  coverTitlePx,
  csvCell,
  estTokens,
  filterTargets,
  findOriginalFlex,
  hasProseChinese,
  normalizeZhNotes,
  locateOriginal,
  mergeQuotaTexts,
  alignSentencePairs,
  boardSummary,
  buildChapterDossierMd,
  dossierFileName,
  epubChapterMd,
  parseEpubChapters,
  filterShelfBooks,
  mergeTargets,
  normalizeAndSplitChapters,
  parseAiJson,
  parseWorkspaces,
  phraseSpan,
  pickSentMarkType,
  planBatchChapters,
  planCompaction,
  progressPct,
  remapMarks,
  marksSurvivingManualEdit,
  routeSelection,
  syncMarksToMd,
  type SyncPlan,
  shelfGroupsOf,
  stripMarkdownNoise,
  morphMismatch,
  toggleParaBookmark,
  workspaceChipName,
  decodeAuto,
  type BatchChapterItem,
  type BatchProgressFile,
  type BookReportRow,
  type ClassTarget,
  type DossierData,
  type QcSummaryLite,
} from './pure.js';
import { renderDiffPane, renderModePill, switchView as switchViewDom, type ViewName } from './widgets.js';
import { S, esc } from './state.js';
import {
  AI_PROVIDERS,
  aiErrHuman,
  buildAssistantPrompt,
  buildDraftSystemPrompt,
  buildPlotPointsPrompt,
  buildRewriteSentencePrompt,
  buildSystemPrompt,
  callChat,
  chatStream,
  loadConfig,
  promptSetVersion,
  reloadPrompts,
  saveConfig,
  setAiUi,
  simplifyMaxLen,
} from './ai.js';
import bundledWordlist from '../../assets/wordlists/curriculum_2022_level3_1600.txt?raw';
import bundledAmendment from '../../assets/wordlists/curriculum_2022_amendment.txt?raw';
import exampleMd from '../../examples/texts/aesop_tortoise_hare.md?raw';
import exampleVocab from '../../examples/vocab/sample_teaching_vocab.csv?raw';
import { parseCsv, parseReinforceText } from '../../src/core/lexicon.js';
import { buildLexicon, type Lexicon } from '../../src/core/lexicon.js';
import { IRR } from '../../src/core/irregular.js';
import { runQc, toLegacyReport } from '../../src/core/qc.js';
import { aggregate, diagnose, LEDGER_HEADER, parseLedger, toLedgerLine, type LedgerRow } from '../../src/core/adoption.js';
import { summarizeCost } from '../../src/core/aiops.js';
import { extractParas, hitOrigin, hit, pendHit, sentsOf, splitChapter, tokenizeTxt, cardGlossWords } from '../../src/core/textpipe.js';
import { sentenceRisks } from '../../src/core/risks.js';
import { jumpTo, jumpToBookmark, refreshBookmarksDom, refreshMarkDom, removeMarkDom, renderSidebar, restoreAllMarkDom, scheduleSave } from './review.js';
import {
  CHANGELOG_HEADER,
  GATES,
  GATE_HELP,
  SENT_TYPES,
  WORD_TYPES,
  newMarkId,
  newReviewState,
  typeLabel,
  type FileSession,
  type Mark,
  type MarkLevel,
  type MarkType,
  type Suggestion,
} from './types.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/* ---------- 全局状态 ---------- */

/** 专名表原始行（保留大小写与空格短语：既并入已知词，也作 ⑧ 专名一致性检查名单） */
/** 本地示例目录的附加词表（如原型项目的中考1600按词性分类表） */
/** 当前会话的合并已知词表（含词句卡），供词面板显示原形 */

/* ---------- 全局配置（~/.layertext.json：AI 设置 + 简化标准 + 首启动标记） ---------- */

/** 常见服务商预设（新手只需选服务商 + 贴 Key） */
function buildLexiconNow(): Lexicon {
  const sel = mergedSelection();
  return buildLexicon({
    vocabCsvTexts: S.vocabCsvText ? [S.vocabCsvText] : [],
    plainWordlistTexts: [bundledWordlist, bundledAmendment, ...(S.extraWordlistText ? [S.extraWordlistText] : []), ...(sel.active && sel.knownInter.length ? [sel.knownInter.join('\n')] : [])],
    terms: S.termsText
      ? S.termsText
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#'))
      : [],
    properNouns: S.properRows.map((r) => r.toLowerCase()),
  });
}

/** 班级多人定制：当前选择的合并口径（句长最严/已学词交集/到期词并集） */
function mergedSelection() {
  return mergeTargets(
    S.classTargets.filter((t) => S.selectedIds.includes(t.id)),
    simplifyMaxLen(),
  );
}

/** 已学词集（复现队列）：班级定制选择优先，其次示例/书目录 _已学词.csv|.txt；空则 undefined（报告保持旧 schema） */
function reinforceWordsNow(): string[] | undefined {
  const sel = mergedSelection();
  if (sel.active && sel.dueUnion.length > 0) return sel.dueUnion;
  if (!S.reinforceText) return undefined;
  const w = parseReinforceText(S.reinforceText);
  return w.length ? w : undefined;
}

/** 章号识别 chnoFromPath / CSV 转义 csvCell / 唯一定位 locateOriginal / 标记重排 remapMarks 已抽至 pure.ts（O4） */

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
  const words = rows.map((r) => (r[0] ?? '').split(/[\t;；,，]/)[0].trim()).filter((w) => /^[A-Za-z][A-Za-z'\- ]*[A-Za-z]$/.test(w));
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
    S.properRows = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
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
      S.properRows = proper
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
    }
    const reinforceCsv = await readIf('_已学词.csv');
    const reinforce = reinforceCsv ?? (await readIf('_已学词.txt'));
    if (reinforce && reinforce.trim()) {
      S.reinforceText = reinforce;
      S.reinforceName = reinforceCsv ? '_已学词.csv（本地）' : '_已学词.txt（本地）';
    }
  } catch {
    /* 目录不可用则跳过 */
  }
}

/* ---------- 班级多人定制（折叠多选栏，feature/reinforce） ---------- */

async function loadClassGroups(): Promise<void> {
  try {
    const dir = await invoke<string>('class_groups_dir');
    const files = (await invoke<string[]>('list_dir', { dir })).filter((f) => f.toLowerCase().endsWith('.json'));
    const targets: ClassTarget[] = [];
    for (const f of files) {
      try {
        const j = JSON.parse(await invoke<string>('read_text_file', { path: f })) as { targets?: ClassTarget[] };
        if (Array.isArray(j.targets)) targets.push(...j.targets);
      } catch {
        /* 单个文件损坏跳过 */
      }
    }
    S.classTargets = targets;
    S.selectedIds = S.selectedIds.filter((id) => targets.some((t) => t.id === id));
  } catch {
    S.classTargets = [];
  }
}

/** 分组就位保证：已加载直接返回；加载一次后记住（目录里确实没有分组文件也算"就位"，避免反复读盘）。
 *  需要重读盘的场景只有用户显式点「刷新分组文件」。 */
let classGroupsReady = false;
function ensureClassGroups(): Promise<void> {
  if (classGroupsReady) return Promise.resolve();
  classGroupsReady = true;
  return loadClassGroups();
}

function renderClsPanel(): void {
  let panel = document.getElementById('cls-panel') as HTMLElement | null;
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'cls-panel';
    panel.style.cssText =
      'position:fixed;top:44px;right:12px;z-index:300;width:340px;max-height:70vh;overflow:auto;background:#fff;border:1px solid #cfd8dc;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.16);padding:12px;font-size:13px;display:none';
    document.body.appendChild(panel);
  }
  const groups = S.classTargets.filter((t) => t.类型 === '组');
  const persons = S.classTargets.filter((t) => t.类型 === '人');
  if (S.classTargets.length === 0) {
    panel.innerHTML = `<div style="display:flex;justify-content:space-between"><b><svg class="ico"><use href="#i-users"/></svg>班级定制</b><button id="cls-close">×</button></div>
      <div class="dim" style="line-height:1.8;margin-top:6px">未找到分组文件。把画像导出的分组 JSON 放到：<br><code>~/Documents/LayerText配置/班级分组/</code><br>（班级画像目录运行 <code>python3 画像_分组导出.py</code> 自动生成），然后点「刷新」。</div>
      <button id="cls-reload" style="margin-top:8px"><svg class="ico"><use href="#i-refresh"/></svg>刷新</button>`;
  } else {
    const q = ((document.getElementById('cls-search') as HTMLInputElement | null)?.value ?? '').trim();
    const shown = filterTargets(persons, q);
    const sel = mergedSelection();
    const ck = (t: ClassTarget) =>
      `<label style="display:inline-block;margin:2px 6px;white-space:nowrap"><input type="checkbox" data-cls-id="${esc(t.id)}" ${S.selectedIds.includes(t.id) ? 'checked' : ''}/> ${esc(t.名称)}${t.句长上限 ? `<span class="dim">≤${t.句长上限}词</span>` : ''}</label>`;
    panel.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center"><b><svg class="ico"><use href="#i-users"/></svg>班级定制（${S.classTargets.length} 目标）</b>
        <span><button id="cls-clear" title="清空选择">清空</button> <button id="cls-close">×</button></span></div>
      <div style="margin:6px 0 2px"><b>分组</b></div>
      <div>${groups.map(ck).join('') || '<span class="dim">无</span>'}</div>
      <details ${q ? 'open' : ''} style="margin-top:6px"><summary style="cursor:pointer">个人（${persons.length}）${q ? '· 搜索中' : ''}</summary>
        <input id="cls-search" placeholder="搜索姓名…" style="width:96%;margin:6px 0" value="${esc(q)}"/>
        <div style="max-height:200px;overflow:auto;border:1px solid #eceff1;border-radius:4px;padding:4px">${shown.map(ck).join('') || '<span class="dim">无匹配</span>'}</div>
      </details>
      <div style="margin-top:8px;padding:6px 8px;background:${sel.active ? '#e8f5e9' : '#f5f5f5'};border-radius:4px;line-height:1.7">
        ${
          sel.active
            ? `已选 <b>${S.selectedIds.length}</b> 目标【${esc(sel.label)}】<br/>句长 ≤<b>${sel.minLen}</b> 词 ｜ 共同已学词 <b>${sel.knownInter.length}</b> ｜ 本篇复现队列 <b>${sel.dueUnion.length}</b> 词${sel.dueUnion.length ? '：' + esc(sel.dueUnion.slice(0, 6).join(', ')) + (sel.dueUnion.length > 6 ? '…' : '') : ''}<br/><span class="dim">对「质检本章 / 整章改写 / 全书批处理」生效；简化稿自动带目标标签</span>`
            : '未选择——质检与简化用全局词库口径。勾选目标后按“句长取最严、复现词取并集”执行。'
        }
      </div>
      <div style="margin-top:6px"><button id="cls-reload"><svg class="ico"><use href="#i-refresh"/></svg>刷新分组文件</button> <span class="dim">目录：~/Documents/LayerText配置/班级分组/</span></div>`;
    const search = document.getElementById('cls-search') as HTMLInputElement | null;
    search?.addEventListener('input', () => renderClsPanel());
    const keepFocus = q && search;
    if (keepFocus) {
      search.focus();
      search.setSelectionRange(search.value.length, search.value.length);
    }
  }
  const bind = (id: string, fn: () => void) => document.getElementById(id)?.addEventListener('click', fn);
  bind('cls-close', () => {
    panel!.style.display = 'none';
  });
  bind(
    'cls-reload',
    () =>
      void loadClassGroups().then(() => {
        classGroupsReady = true;
        renderClsPanel();
        fileSummary();
      }),
  );
  bind('cls-clear', () => {
    S.selectedIds = [];
    renderClsPanel();
    fileSummary();
  });
  panel.querySelectorAll<HTMLInputElement>('input[data-cls-id]').forEach((el) => {
    el.addEventListener('change', () => {
      const id = el.dataset.clsId!;
      if (el.checked) S.selectedIds.push(id);
      else S.selectedIds = S.selectedIds.filter((x) => x !== id);
      renderClsPanel();
      fileSummary();
    });
  });
}

function setStatus(msg: string, cls = ''): void {
  $('status').innerHTML = msg ? `<span class="${cls}">${esc(msg)}</span>` : '';
}

function activeSession(): FileSession | null {
  return S.activeIdx >= 0 ? S.sessions[S.activeIdx] : null;
}

/** 状态行只放"现在在哪"：文件名（班级口径生效时附带）。词库/复现等完整口径见 设置 弹层 */
function fileSummary(): void {
  const s = activeSession();
  const sel = mergedSelection();
  setStatus(s ? `${s.fileName}${sel.active ? ` ｜ 班级 ${sel.label}` : ''}` : '');
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

async function addSession(md: string, fileName: string, sourcePath: string | null, opts: { noAutoQc?: boolean } = {}): Promise<void> {
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
    await loadWorkspaces(dir); // 工作区：先章目录再书稿根（_工作区.json）
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
      review.bookmarks = Array.isArray(parsed.bookmarks) ? parsed.bookmarks : [];
    }
  } catch {
    /* 无历史标记，正常 */
  }
  S.sessions.push({ md, fileName, sourcePath, markPath, review, report: null, reportSavedPath: null, dirty: false });
  S.activeIdx = S.sessions.length - 1;
  touchProgress(sourcePath); // 阅读进度记账（无书根上下文则跳过）
  riskJumpIdx = -1; // 难句跳转索引随章复位
  if (tocPanelEl()?.classList.contains('open')) void refreshToc(); // 目录开着时同步高亮/书签区
  // 会话保持（学 harness）：切换文件不清空对话，注入上下文提示让 AI 知道当前章节
  if (S.chatMsgs.length > 0) {
    S.chatMsgs.push({ role: 'user', content: `（系统提示：教师已切换到「${fileName}」，后续操作与回答默认针对这一章）` });
    chatRender();
  }
  S.aiHistory = [];
  S.suggestions = [];
  renderAll();
  void pushRecent(fileName, sourcePath);
  // 初步诊断第一步：打开课文即自动体检（本地引擎，无需 AI、无需点击）
  if (!opts.noAutoQc) void runQcCurrent({ auto: true });
  // 换书提醒：本书文件夹无配套配置时提示（学生水平/词库可能需要切换）
  if (sourcePath && S.sessions.filter((x) => x.sourcePath && x.sourcePath.slice(0, x.sourcePath.lastIndexOf('/')) === sourcePath.slice(0, sourcePath.lastIndexOf('/'))).length === 1) {
    setStatus('本书尚未配专属词库——文件 → 导入自定义词库 后「保存为本书配置」', '');
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

/** 界面随上下文显隐：打开章节才出现章节工具（质检/按标记修改/撤销/查找/字号），书架态只留书架级界面 */
function syncChrome(): void {
  const s = activeSession();
  const hasChapter = !!s;
  document.body.classList.toggle('no-session', !hasChapter);
  for (const id of ['grp-chapter', 'grp-edit']) document.getElementById(id)!.style.display = hasChapter ? '' : 'none';
  $('tab-toc').style.display = s ? '' : 'none'; // 书架/版本页无章节概念，目录按钮收起
  // 看板/档案是书级视图，书架也能进；仅正文场景整行收起
  const activeTab = document.querySelector('.viewtabs button.active') as HTMLElement | null;
  const bookView = !!activeTab && activeTab.id !== 'tab-text';
  (document.querySelector('.viewtabs') as HTMLElement).style.display = !hasChapter && !bookView ? 'none' : 'flex';
}

function renderAll(): void {
  renderFileTabs();
  const s = activeSession();
  if (!s) {
    switchViewDom(document, 'text'); // 回正文窗格=书架首页（清掉残留的书级视图）
    void renderShelf(); // 首页=书架（示例+我的书；点书进入工作区）
    syncChrome();
    $('pane-report').innerHTML = '<div class="empty"><b>打开课文会自动体检</b><br/>生词率、句长、难句自动数好，报告页每条可勾选处理</div>';
    $('side-review').innerHTML =
      '<div class="side-empty">这里是你的审校 checklist：<br/>· 要点配额：本章必须保留的情节点，自己添加打勾<br/>· 终审门禁：四项全勾才算审完（点 ? 看每项查什么）<br/>· 标记清单：正文里做的标记都在这，点击跳回原文</div>';
    hidePop();
    fileSummary();
    return;
  }
  renderReader(s);
  attachInlineSuggestions();
  renderReportPane(s);
  renderSidebar(s, sidebarHandlers);
  syncChrome();
  fileSummary();
  updateMarkBadge();
}

function renderFileTabs(): void {
  const el = $('filetabs');
  el.style.display = S.sessions.length === 0 ? 'none' : 'flex'; // 无文件时整行收起，不占位
  if (S.sessions.length === 0) {
    el.innerHTML = '';
    // 工作区条一并收起（修复：关掉全部章节后 wstabs 残留在页面上）
    const wsBar = $('wstabs');
    wsBar.style.display = 'none';
    wsBar.innerHTML = '';
    return;
  }
  el.innerHTML = S.sessions
    .map((s, i) => `<span class="ftab ${i === S.activeIdx ? 'active' : ''}" data-ftab="${i}">${esc(s.fileName)}<span class="x" data-ftab-close="${i}" title="关闭">×</span></span>`)
    .join('');
  el.querySelectorAll('[data-ftab]').forEach((t) =>
    t.addEventListener('click', (e) => {
      const x = (e.target as HTMLElement).closest('[data-ftab-close]');
      if (x) return;
      const prev = activeSession();
      if (prev) prev.scrollTop = scrollNow();
      S.activeIdx = Number((t as HTMLElement).dataset.ftab);
      renderAll();
      const cur = activeSession();
      if (cur?.scrollTop)
        setTimeout(() => {
          const sc = scrollEl();
          if (sc) sc.scrollTop = cur.scrollTop!;
        }, 50);
    }),
  );
  el.querySelectorAll('[data-ftab-close]').forEach((x) => x.addEventListener('click', () => closeSession(Number((x as HTMLElement).dataset.ftabClose))));
  renderWorkspaceBar();
}

/** 改写文本复核（多句拆分逐句检测，超长=最长一句超限） */
function checkRev(revised: string): Suggestion['check'] {
  return checkRevisedText(revised, simplifyMaxLen(), (sent, m) => {
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

/** 请求直到解析出 JSON：若模型把整轮输出耗在思考上（无 [ 字符），自动追发"直接输出 JSON"再试一次 */
async function chatUntilJson(messages: { role: string; content: string }[], maxTokens: number, scene: string): Promise<{ raw: unknown[]; usage: string }> {
  const msgs = [...messages];
  for (let attempt = 0; attempt < 2; attempt++) {
    const { content, usage } = await callChat(msgs, maxTokens, undefined, scene);
    try {
      return { raw: parseAiJson(content), usage };
    } catch (e) {
      if (attempt === 1 || content.includes('[')) throw e;
      msgs.push({ role: 'user', content: '你刚才的整段回答都是思考过程，还没有输出结果。请现在直接输出完整的 JSON 数组：第一个字符必须是 [，不要再写任何思考、解释或代码块。' });
    }
  }
  throw new Error('unreachable');
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
    ...(S.termsText ?? '')
      .split('\n')
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l && !l.startsWith('#')),
    ...S.properRows.map((r) => r.toLowerCase()),
  ]);

  reader.replaceChildren();
  extractParas(body).forEach((p, pi) => {
    const div = document.createElement('div');
    div.className = 'para';
    div.dataset.pi = String(pi);
    const pid = document.createElement('span');
    pid.className = 'pid';
    const pidLabel = 'P' + String(pi + 1).padStart(2, '0');
    pid.textContent = pidLabel;
    pid.dataset.orig = pidLabel;
    pid.title = '双击收藏本段书签（★，目录面板可查看与跳转）';
    pid.addEventListener('dblclick', () => {
      const s = activeSession();
      if (!s) return;
      const firstSent = sentsOf(p, false)[0] ?? '';
      const r = toggleParaBookmark(s.review.bookmarks, pi, firstSent, Date.now());
      s.review.bookmarks = r.list;
      refreshBookmarksDom(s);
      scheduleSave(s, () => undefined);
      toast(r.added ? `已收藏段落书签 ${pidLabel}（双击段号可移除）` : `已移除段落书签 ${pidLabel}`);
    });
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
      const rawWords = sent.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
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
  scheduleHeatRail();
}

/* ---------- 标记动作 ---------- */

function addMark(session: FileSession, mark: Mark): Mark {
  session.review.marks.push(mark);
  refreshMarkDom(mark);
  scheduleHeatRail();
  renderSidebar(session, sidebarHandlers);
  updateMarkBadge();
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
  scheduleHeatRail();
  renderSidebar(session, sidebarHandlers);
  scheduleSave(session, () => undefined);
  updateMarkBadge();
}

/** 候选模式下「按标记修改」按钮的待处理徽标——标记≠修改（候选模式只入清单），
 *  攒了多少活必须一眼可见（交互标准 A1/A3：点了会发生什么/发生了什么） */
function updateMarkBadge(): void {
  const btn = $('btn-ai');
  const s = activeSession();
  const n = s && S.appConfig.autoRewriteOnMark !== true ? s.review.marks.length : 0;
  let b = btn.querySelector<HTMLElement>('.pbadge');
  if (!n) {
    b?.remove();
    return;
  }
  if (!b) {
    b = document.createElement('span');
    b.className = 'pbadge';
    btn.appendChild(b);
  }
  b.textContent = String(n);
  b.title = `本章还有 ${n} 条标记未执行——点了「按标记修改」才会改（当前为候选模式；切即改模式则点标记立即生效）`;
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

function marksAt(session: FileSession, level: MarkLevel, pi: number, si: number, wi?: number): Mark[] {
  return session.review.marks.filter((m) => m.level === level && m.pi === pi && m.si === si && (level === 'sent' || m.wi === wi));
}

function renderPopMarks(existing: Mark[]): void {
  const box = pop.querySelector('.pop-marks');
  if (!box) return;
  box.innerHTML = existing.length
    ? existing.map((m) => `<span class="mchip">${typeLabel(m.type)}${m.note ? ' ✎︎' : ''}<button class="x" data-pop-rm="${m.id}" title="删除该标记">×</button></span>`).join('')
    : '<span style="color:var(--muted);font-size:12px">尚无标记</span>';
  box.querySelectorAll('[data-pop-rm]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const m = S.popSession?.review.marks.find((x) => x.id === (btn as HTMLElement).dataset.popRm);
      if (m && S.popSession) {
        removeMark(S.popSession, m);
        refreshPop();
      }
    }),
  );
}

function refreshPop(): void {
  if (!S.popSession) return;
  const ctx = pop.dataset;
  const pi = Number(ctx.pi),
    si = Number(ctx.si),
    wi = ctx.wi === undefined ? undefined : Number(ctx.wi);
  const level = ctx.level as MarkLevel;
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
  const stateLabel =
    state === 'oov'
      ? '<span class="warn">词表外（红）</span>'
      : state === 'pending'
        ? '<span class="warn">待定词（橙）—暂计已知，风险另计</span>'
        : state === 'term'
          ? '术语（蓝）'
          : '<span class="ok">词表内</span>';
  pop.dataset.level = 'word';
  pop.dataset.pi = String(pi);
  pop.dataset.si = String(si);
  pop.dataset.wi = String(wi);
  pop.innerHTML = `
    <div class="pop-h">${esc(wEl.textContent ?? '')}</div>
    <div class="pop-info">词表状态：${stateLabel}${origin && origin !== tok ? `<br/>词形还原原形：${esc(origin)}` : ''}</div>
    <div class="pop-marks"></div>
    <div class="pop-btns"><button data-mk="__rewrite" class="primary" title="让 AI 按当前标记意图改写这一句（快捷键 R）"><svg class="ico"><use href="#i-sparkle"/></svg>AI 改写本句</button><button data-mk="__edit" title="亲手修改这一句（快捷键 E）——直接写入正文，可撤销，不经引擎复核（你是定稿人）">✎ 手动改这句</button>${WORD_TYPES.map((t, i) => `<button data-mk="${t.key}" title="标记为「${t.label}」${t.key === 'anchor' ? '——记录该词为本篇复现锚点（保留并计入复现，不改正文）' : S.appConfig.autoRewriteOnMark ? '——即改模式下点完立即执行（写原稿+日志）' : '——点「AI 改写本句」或批量时按此意图处理'}"><span class="kbd">${i + 1}</span>${t.label}</button>`).join('')}</div>
    <textarea id="pop-note" placeholder="备注（可选，随下一条标记保存）"></textarea>
    <div class="pop-tip">${S.appConfig.autoRewriteOnMark ? '当前为即改模式：点任一标记立即执行（如「加中文标注」插入注释、「词汇简化」换课标内简单词），改动写原稿并记日志，首改前自动备份' : '先标记意图再点「AI 改写本句」，改写会直接出现在正文中供采纳'}</div>`;
  bindTypeButtons(session, 'word', pi, si, wi);
  refreshPop();
  placePop(x, y);
}

function showSentPanel(session: FileSession, sentEl: HTMLElement, x: number, y: number, crossSentence: boolean): void {
  S.popSession = session;
  const pi = Number((sentEl as HTMLElement).dataset.pi);
  const si = Number((sentEl as HTMLElement).dataset.si);
  const text = sentsOf(extractParas(splitChapter(session.md).body)[pi], false)[si] ?? '';
  const wc = text.split(/\s+/).filter(Boolean).length;
  const risk = sentenceRisks(text);
  const riskBits = [risk.passive ? '被动' : '', risk.relcl ? '定从' : '', risk.pastperf ? '过去完成' : '', risk.overlong ? `超长(${wc}词)` : ''].filter(Boolean).join(' / ');
  pop.dataset.level = 'sent';
  pop.dataset.pi = String(pi);
  pop.dataset.si = String(si);
  delete pop.dataset.wi;
  pop.innerHTML = `
    <div class="pop-h">句子标记（P${String(pi + 1).padStart(2, '0')} · 第${si + 1}句 · ${wc} 词）</div>
    <div class="pop-info">${esc(text.slice(0, 80))}${text.length > 80 ? '…' : ''}<br/>自动检测：${riskBits ? `<span class="warn">${riskBits}</span>` : '<span class="ok">未命中黑名单句法</span>'}${crossSentence ? '<br/>⚠︎ 跨句选择，仅标记所选末句' : ''}</div>
    <div class="pop-marks"></div>
    <div class="pop-btns"><button data-mk="__edit" title="亲手修改这一句（快捷键 E）——直接写入正文，可撤销，不经引擎复核（你是定稿人）">✎ 手动改这句</button>${SENT_TYPES.map((t, i) => `<button data-mk="${t.key}"><span class="kbd">${i + 1}</span>${t.label}</button>`).join('')}</div>
    <textarea id="pop-note" placeholder="备注（可选，随下一条标记保存）"></textarea>`;
  bindTypeButtons(session, 'sent', pi, si);
  refreshPop();
  placePop(x, y);
}

/* ---------- 手动改这句（人工矫正兜底）：AI 改不好时教师亲手改；教师是定稿人，不经引擎复核 ---------- */

function showSentenceEditor(pi: number, si: number): void {
  const s = activeSession();
  if (!s) return;
  const sent = sentsOf(extractParas(splitChapter(s.md).body)[pi] ?? '', false)[si] ?? '';
  if (!sent) return;
  const r0 = pop.getBoundingClientRect();
  pop.dataset.level = 'edit';
  pop.innerHTML = `
    <div class="pop-h">手动改这句（P${String(pi + 1).padStart(2, '0')} · 第${si + 1}句 · 定稿权在你）</div>
    <div class="pop-info">改动直接写入正文（首改自动备份、↩︎ 可撤销、变更日志记"人工修订"），<b>不经引擎复核</b>。保存后会自动重新体检。</div>
    <textarea id="edit-sent" rows="4" style="width:100%;font-size:13px;line-height:1.7;border:1px solid var(--line);border-radius:8px;padding:6px 8px;box-sizing:border-box">${esc(sent.trim())}</textarea>
    <div class="pop-btns" style="margin-top:8px">
      <button id="edit-save" class="primary">保存修改（写入正文）</button>
      <button id="edit-cancel">取消</button>
    </div>`;
  placePop(r0.left, r0.top);
  const ta = pop.querySelector('#edit-sent') as HTMLTextAreaElement | null;
  ta?.focus();
  pop.querySelector('#edit-cancel')?.addEventListener('click', hidePop);
  pop.querySelector('#edit-save')?.addEventListener('click', () => void applyManualSentenceEdit(pi, si));
  ta?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void applyManualSentenceEdit(pi, si);
  });
}

async function applyManualSentenceEdit(pi: number, si: number): Promise<void> {
  const s = activeSession();
  if (!s) return;
  const ta = pop.querySelector('#edit-sent') as HTMLTextAreaElement | null;
  const revised = (ta?.value ?? '').replace(/\s+/g, ' ').trim();
  const sent = sentsOf(extractParas(splitChapter(s.md).body)[pi] ?? '', false)[si] ?? '';
  if (!ta || !revised) {
    toast('内容为空，未修改');
    return;
  }
  if (revised === sent.trim()) {
    hidePop();
    toast('没有变化，正文未动');
    return;
  }
  // 定位原句（与 AI 建议采纳同款：先唯一精确，再空白/连字符宽容匹配）
  let exact: string | null = null;
  const at0 = s.md.indexOf(sent);
  if (at0 >= 0 && s.md.indexOf(sent, at0 + 1) < 0) exact = sent;
  else {
    const flex = findOriginalFlex(s.md, sent);
    if (flex) exact = flex.exact;
  }
  if (!exact) {
    setStatus('正文中定位不到该句（可能刚被其他修改改过）——请重新打开这句再改', 'err');
    return;
  }
  const atExact = s.md.indexOf(exact);
  s.md = s.md.slice(0, atExact) + revised + s.md.slice(atExact + exact.length);
  // 标记存留：该句句级标记随人工修订完成；被改掉的词不再留幽灵标记；其余 remap 重定位
  s.review.marks = marksSurvivingManualEdit(s.review.marks, { pi, si }, exact, revised);
  remapMarks(s.review.marks, s.md);
  hidePop();
  const date = new Date().toLocaleDateString('sv-SE');
  const outDir = s.sourcePath ? s.sourcePath.slice(0, s.sourcePath.lastIndexOf('/')) : await invoke<string>('reports_dir');
  const logPath = `${outDir}/变更日志_AI审核.csv`;
  try {
    const savedTo = await persistEdit(s, s.md);
    let csv = '';
    try {
      csv = await invoke<string>('read_text_file', { path: logPath });
    } catch {
      /* 新建 */
    }
    if (!csv.trim()) csv = CHANGELOG_HEADER.join(',') + '\n';
    csv +=
      [
        'R1',
        date,
        `标准${simplifyMaxLen()}词`,
        `P${String(pi + 1).padStart(2, '0')}`,
        `P${pi + 1}-S${si + 1}`,
        exact.trim(),
        revised,
        'R15',
        '教师手动修订（定稿权，不经引擎复核）',
        '人工矫正-手动改句',
      ]
        .map(csvCell)
        .join(',') + '\n';
    await invoke('write_text_file', { path: logPath, content: csv });
    renderAll();
    flashApplied(revised);
    toast(`正文已改好并写入${savedTo === s.sourcePath ? '原稿' : '工作稿'}（↩︎ 可撤销，日志已记"人工修订"）`, 'ok');
  } catch (e) {
    setStatus('写入失败：' + e, 'err');
    return;
  }
  scheduleSave(s, () => undefined);
  void runQcCurrent({ auto: true }); // 改完自动重检，报告不滞后
}

/* 短语面板（三级粒度之短语级）：拖选短语 → 直线下划线标记，类型色沿用词级色板；
 * 选区即范围——弹层顶部显示选区原文，短语动作常驻；句动作不在此弹层（想标句就选整句） */
function showPhrasePanel(session: FileSession, sentEl: HTMLElement, range: Range, x: number, y: number): void {
  S.popSession = session;
  const pi = Number(sentEl.dataset.pi);
  const si = Number(sentEl.dataset.si);
  const wis = [...sentEl.querySelectorAll<HTMLElement>('.w')].filter((w) => range.intersectsNode(w)).map((w) => Number(w.dataset.wi));
  if (!wis.length) return;
  const wi = Math.min(...wis);
  const wl = Math.max(...wis) - wi + 1;
  const sent = sentsOf(extractParas(splitChapter(session.md).body)[pi] ?? '', false)[si] ?? '';
  const span = phraseSpan(sent, wi, wl);
  if (!span) return;
  const shown = span.text.length > 60 ? span.text.slice(0, 60) + '…' : span.text;
  pop.dataset.level = 'phrase';
  pop.dataset.pi = String(pi);
  pop.dataset.si = String(si);
  pop.dataset.wi = String(wi);
  pop.dataset.wl = String(wl);
  pop.innerHTML = `
    <div class="pop-h">短语标记（P${String(pi + 1).padStart(2, '0')} · 第${si + 1}句 · ${wl} 词）</div>
    <div class="pop-info">选区：${esc(shown)}<br/>选什么划什么——短语整体处理（词典释义 / 换简单说法 / 标记保留），句内其余文字不动</div>
    <div class="pop-marks"></div>
    <div class="pop-btns"><button data-mk="__rewrite" class="primary" title="让 AI 按当前标记意图改写这一句（快捷键 R）"><svg class="ico"><use href="#i-sparkle"/></svg>AI 改写本句</button><button data-mk="__edit" title="亲手修改这一句（快捷键 E）——直接写入正文，可撤销，不经引擎复核（你是定稿人）">✎ 手动改这句</button>${WORD_TYPES.map((t, i) => `<button data-mk="${t.key}" title="标记为「${t.label}」——${t.key === 'anchor' ? '记录整个短语为复现锚点（不改正文）' : `将对整个短语生效（下划线范围）${S.appConfig.autoRewriteOnMark ? '；即改模式下点完立即执行（写原稿+日志）' : ''}`}"><span class="kbd">${i + 1}</span>${t.label}</button>`).join('')}</div>
    <textarea id="pop-note" placeholder="备注（可选，随下一条标记保存）"></textarea>
    <div class="pop-tip">${S.appConfig.autoRewriteOnMark ? '当前为即改模式：点任一标记立即对整个短语执行，改动写原稿并记日志' : '选什么划什么——标记后可点「AI 改写本句」处理整个短语'}</div>`;
  bindTypeButtons(session, 'phrase', pi, si, wi, wl);
  refreshPop();
  placePop(x, y);
}

function bindTypeButtons(session: FileSession, level: MarkLevel, pi: number, si: number, wi?: number, wl?: number): void {
  pop.querySelectorAll('[data-mk]').forEach((b) =>
    b.addEventListener('click', () => {
      const type = (b as HTMLElement).dataset.mk as MarkType | '__rewrite' | '__edit';
      if ((type as string) === '__edit') {
        showSentenceEditor(pi, si);
        return;
      }
      if ((type as string) === '__rewrite') {
        const intent = [...marksAt(session, 'word', pi, si, wi), ...marksAt(session, 'phrase', pi, si, wi)].map((m) => typeLabel(m.type)).join('、') || '词汇简化';
        void aiRewriteSentence(pi, si, intent);
        return;
      }
      const note = (pop.querySelector('#pop-note') as HTMLTextAreaElement | null)?.value.trim() || undefined;
      if (marksAt(session, level, pi, si, wi).some((m) => m.type === type)) return; // 已有同类型标记
      const sentText = sentsOf(extractParas(splitChapter(session.md).body)[pi], false)[si] ?? '';
      const mark = addMark(session, {
        id: newMarkId(),
        level,
        pi,
        si,
        ...(level !== 'sent' ? { wi } : {}),
        ...(level === 'phrase' ? { wl: wl ?? 1, word: phraseSpan(sentText, wi ?? 0, wl ?? 1)?.text ?? '' } : level === 'word' ? { word: pop.querySelector('.pop-h')?.textContent ?? '' } : {}),
        text: sentText.slice(0, 40),
        type: type as MarkType,
        note,
        ts: Date.now(),
      });
      // 标记即改写：点完标记直接 AI 改写并生效，无需任何后续点击
      // 加中文标注例外——它是确定性操作，走词义映射+机器插入（原句逐字不动，不让 AI 改写句子）
      if (S.appConfig.autoRewriteOnMark) {
        hidePop();
        if (mark.type === 'anchor' && mark.word) {
          toast(`复现锚点已记录：${mark.word}（保留该词并计入本篇复现，正文不动）`, 'ok');
          return; // 记录型标记：句子没问题，不触发改写
        }
        if (mark.type === 'zh' && mark.word) void applyZhAnnotations(session, [mark]);
        else if (mark.type === 'simpl' && mark.word) void applyWordSimplifications(session, [mark]);
        else void aiRewriteSentence(pi, si, typeLabel(mark.type), mark.id);
        return;
      }
      const ta = pop.querySelector('#pop-note') as HTMLTextAreaElement | null;
      if (ta) ta.value = '';
      refreshPop();
      // 候选模式闭环：标记只是入了清单、正文还没改——必须当场说清"去哪执行"（用户问"点了 AI 没修改怎么办"的根修）
      const tip = pop.querySelector('.pop-tip');
      if (tip) tip.textContent = `已入标记清单（本章待执行 ${session.review.marks.length} 条，正文未改）——点工具栏「按标记修改」批量执行，或切右侧模式胶囊为即改模式`;
      updateMarkBadge();
    }),
  );
}

/* ---------- 质检 ---------- */

async function runQcCurrent(opts: { auto?: boolean } = {}): Promise<void> {
  const s = activeSession();
  if (!s) {
    setStatus('请先载入文本', 'err');
    return;
  }
  try {
    s.report = runQc(s.md, buildLexiconNow(), {
      tier: 'M', // 引擎口径固定 M（黑名单全禁）；句长参考用「简化标准」simplifyMaxLen()
      fileName: s.fileName,
      chno: s.sourcePath ? chnoFromPath(s.sourcePath) : null,
      tierGates: { passiveFromCh: 0, relclFromCh: 0 },
      ...(S.properRows.length ? { propCheckList: S.properRows } : {}),
      ...(reinforceWordsNow() ? { reinforceWords: reinforceWordsNow()! } : {}),
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
    if (opts.auto) {
      const r = s.report;
      toast(`自动体检完成：生词率 ${(r.newWordRate * 100).toFixed(1)}% · 难句 ${r.passive + r.relcl + r.pastperf + r.over20} 处`, 'ok');
    } else {
      toast('质检完成，报告已保存', 'ok');
    }
  } catch (e) {
    s.reportSavedPath = null;
    setStatus('质检完成，但报告落盘失败：' + e, 'err');
  }
  renderReportPane(s);
  if (!opts.auto) switchView('report');
}

/** 初步诊断：在正文里找某词（词形还原口径）第一次出现的位置 */
function locateWordFirst(session: FileSession, tok: string): { pi: number; si: number; wi: number; raw: string } | null {
  const paras = extractParas(splitChapter(session.md).body);
  for (let pi = 0; pi < paras.length; pi++) {
    const sents = sentsOf(paras[pi], false);
    for (let si = 0; si < sents.length; si++) {
      const sent = sents[si];
      const toks = tokenizeTxt(sent);
      const wi = toks.indexOf(tok);
      if (wi >= 0) {
        const raw = (sent.match(/[A-Za-z][A-Za-z'-]*/g) ?? [])[wi] ?? tok;
        return { pi, si, wi, raw };
      }
    }
  }
  return null;
}

interface RiskSentItem {
  sent: string;
  pi: number;
  si: number;
  badges: string[];
  type: 'syntax' | 'long';
}

/** 初步诊断：本章全部黑名单难句（与正文着色同一套检测） */
function riskSentenceList(s: FileSession): RiskSentItem[] {
  const out: RiskSentItem[] = [];
  extractParas(splitChapter(s.md).body).forEach((p, pi) =>
    sentsOf(p, false).forEach((sent, si) => {
      const risk = sentenceRisks(sent);
      const badges = [risk.passive ? '被' : '', risk.relcl ? '从' : '', risk.pastperf ? '完' : '', risk.overlong ? '长' : ''].filter(Boolean);
      if (badges.length) out.push({ sent, pi, si, badges, type: pickSentMarkType(risk) });
    }),
  );
  return out;
}

function renderReportPane(s: FileSession): void {
  const pane = $('pane-report');
  if (!s.report) {
    pane.innerHTML = '<div class="empty">尚未体检（打开课文会自动体检；换词库或改完文后点上方「重新质检」）</div>';
    return;
  }
  const legacy = toLegacyReport(s.report) as Record<string, unknown>;
  // 显示层口径（引擎 legacy 字段不动，只改呈现）："层级/章号"是引擎内部字段不再展示；
  // 指标名里的旧口径字样与硬编码 20 词按当前简化标准改写（O3 补漏）
  const rows = Object.entries(legacy).filter(([k, v]) => k !== 'OOV词(去重)' && k !== '层级' && !(k === '章号' && (v === null || String(v) === 'null')));
  const labelMap: Record<string, string> = {
    '①词表覆盖率(注释后口径=含A层术语)': '①词表覆盖率',
    '⑩复现词命中(队列/命中/词次)': '⑩复现词命中（队列/命中/词次）',
    复现命中词: '⑩复现命中词（已学词在本篇重现）',
  };
  const oov = [...new Set(s.report.oov)];
  const sel = mergedSelection();
  const gatesNote = `句法黑名单（被动/定从/过去完成）一律禁用；句长参考 = ${sel.active ? `班级定制【${sel.label}】最严 ${sel.minLen}` : `简化标准 ${simplifyMaxLen()}`} 词/句`;
  const risks = riskSentenceList(s);

  /* 生词清单：每个词两个动作——标记简化（进标记清单走 AI）/ 计入已学词（不再标红） */
  const oovRows = oov
    .slice(0, 80)
    .map((w) => {
      const marked = s.review.marks.some((m) => m.level === 'word' && (m.word ?? '').toLowerCase() === w);
      const learned = S.currentKnown.has(w);
      return `<tr>
      <td style="font-weight:600">${esc(w)}</td>
      <td>${marked ? '<span class="ok-badge">✓ 已标记简化</span>' : `<button data-oov-simpl="${esc(w)}">✓ 标记要简化</button>`}
          ${learned ? '<span class="ok-badge">✓ 已学</span>' : `<button data-oov-learn="${esc(w)}">✓ 学生已学过</button>`}</td>
    </tr>`;
    })
    .join('');

  /* 难句清单：每句一个动作——标记要改（进标记清单） */
  const riskRows = risks
    .slice(0, 40)
    .map((r) => {
      const marked = s.review.marks.some((m) => m.level === 'sent' && m.pi === r.pi && m.si === r.si);
      return `<tr>
      <td><span class="chip warn-chip">${r.badges.join('')}</span> <span class="dim">P${String(r.pi + 1).padStart(2, '0')}-S${r.si + 1}</span></td>
      <td title="${esc(r.sent)}">${esc(r.sent.slice(0, 70))}${r.sent.length > 70 ? '…' : ''}</td>
      <td>${marked ? '<span class="ok-badge">✓ 已标记</span>' : `<button data-risk-pi="${r.pi}" data-risk-si="${r.si}">✓ 标记要改</button>`}</td>
    </tr>`;
    })
    .join('');

  pane.innerHTML = `
    ${s.reportSavedPath ? `<div class="saved-path">报告已自动保存：${esc(s.reportSavedPath)} <button id="btn-reveal">在访达中显示</button></div>` : ''}
    <table class="report">
      ${rows.map(([k, v]) => `<tr><th>${esc(labelMap[k] ?? k)}</th><td>${Array.isArray(v) ? v.length + ' 个' : esc(String(v))}</td></tr>`).join('')}
      <tr><th>句法黑名单</th><td>${gatesNote}</td></tr>
      <tr><th>覆盖率参考带${sel.active && sel.coverageTarget ? `（本批目标 ≥${sel.coverageTarget}%）` : ''}</th><td class="dim">${sel.active && sel.coverageTarget ? `分层覆盖目标带 ≥${sel.coverageTarget}%（多目标取最严；个体化依据见 docs/文献对齐）` : '95% = 最低限度理解（Laufer 1989）；98% = 无辅助顺畅阅读（Hu & Nation 2000）——文献群体均值'}</td></tr>
    </table>

    <div class="diag-h">① 生词清单（去重 ${oov.length} 词）<span class="dim">——勾一个动一个：要简化的进标记清单，学生已学过的立即不再标红</span></div>
    ${
      oov.length
        ? `<table class="sgtable"><tr><th style="width:90px">词</th><th>处理（你说了算）</th></tr>${oovRows}</table>
    ${oov.length > 80 ? `<div class="dim" style="margin-bottom:10px">（只列前 80 词，处理或换词库后点「重新质检」看剩余）</div>` : ''}`
        : '<div class="dim" style="margin-bottom:10px">没有词表外生词——全部在词表内</div>'
    }

    <div class="diag-h">② 句法难句（${risks.length} 句：被=被动 从=定从 完=过去完成 长=超20词·引擎口径）<span class="dim">——勾"要改"的进标记清单，可批量交给 AI</span></div>
    ${
      risks.length
        ? `<table class="sgtable"><tr><th style="width:110px">风险</th><th>句子</th><th style="width:110px">处理</th></tr>${riskRows}</table>
    ${risks.length > 40 ? `<div class="dim" style="margin-bottom:10px">（只列前 40 句）</div>` : ''}`
        : '<div class="dim" style="margin-bottom:10px">没有命中黑名单的难句</div>'
    }

    <div class="diag-h">③ 情节要点（AI 摘候选 → 你勾选 → 进右侧"要点配额"）</div>
    <div style="margin-bottom:8px">
      <button id="diag-plot-btn" class="primary"><svg class="ico"><use href="#i-sparkle"/></svg>AI 摘情节要点</button>
      <span class="dim">让 AI 通读本章，摘出"简化时绝不能丢的情节点/伏笔"（5~8 条），你逐条勾选后进配额清单；没配 AI 也可以在右侧手动添加</span>
    </div>
    <div id="diag-plot-out"></div>`;
  document.getElementById('btn-reveal')?.addEventListener('click', () => {
    if (s.reportSavedPath) void invoke('reveal_path', { path: s.reportSavedPath });
  });

  pane.querySelectorAll('[data-oov-simpl]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const tok = (btn as HTMLElement).dataset.oovSimpl!;
      const loc = locateWordFirst(s, tok);
      if (!loc) {
        setStatus(`正文中没找到 "${tok}"（可能已修改，点「重新质检」）`, 'err');
        return;
      }
      const sent = sentsOf(extractParas(splitChapter(s.md).body)[loc.pi], false)[loc.si];
      addMark(s, {
        id: newMarkId(),
        level: 'word',
        pi: loc.pi,
        si: loc.si,
        wi: loc.wi,
        word: loc.raw,
        text: sent.slice(0, 40),
        type: 'simpl',
        note: '初步诊断：生词',
        ts: Date.now(),
      });
      renderReportPane(s);
      setStatus(`✓ 已标记简化「${loc.raw}」——处理完一批后点「AI 审核建议」批量改`, 'saved');
    }),
  );

  pane.querySelectorAll('[data-oov-learn]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const tok = (btn as HTMLElement).dataset.oovLearn!;
      S.vocabCsvText = (S.vocabCsvText ? S.vocabCsvText.replace(/\n+$/, '') + '\n' : '') + `${tok},单词,,,,,,`;
      S.currentKnown.add(tok);
      renderAll();
      setStatus(`✓「${tok}」已计入已学词，正文立即不再标红——文件 → 保存为本书配置 后全书每章生效`, 'saved');
    }),
  );

  pane.querySelectorAll('[data-risk-pi]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const pi = Number((btn as HTMLElement).dataset.riskPi);
      const si = Number((btn as HTMLElement).dataset.riskSi);
      const item = risks.find((r) => r.pi === pi && r.si === si);
      if (!item) return;
      addMark(s, {
        id: newMarkId(),
        level: 'sent',
        pi,
        si,
        text: item.sent.slice(0, 40),
        type: item.type,
        note: `初步诊断：${item.badges.join('/')}`,
        ts: Date.now(),
      });
      renderReportPane(s);
      setStatus(`✓ 已标记要改（P${pi + 1}-S${si + 1}，${item.badges.join('/')}）——可批量点「AI 审核建议」`, 'saved');
    }),
  );

  document.getElementById('diag-plot-btn')?.addEventListener('click', () => void aiPlotPoints(s));
}

/* ---------- 初步诊断③：AI 摘情节要点 → 教师勾选 → 预填要点配额 ---------- */

async function aiPlotPoints(s: FileSession): Promise<void> {
  const key = await invoke<string>('load_api_key');
  if (!key) {
    setStatus('摘情节要点需要先配置 AI（菜单 LayerText → AI 设置…）——没配 AI 也可在右侧"本章要点配额"手动添加', 'err');
    showAiSettings();
    return;
  }
  const out = $('diag-plot-out');
  const btn = $('diag-plot-btn') as unknown as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = '⏳ AI 阅读本章中…';
  try {
    const chapter = splitChapter(s.md).body.slice(0, 12000);
    const { raw } = await chatUntilJson([{ role: 'user', content: await buildPlotPointsPrompt(chapter) }], 1500, '情节要点');
    const items = (raw as unknown[])
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 1)
      .map((x) => x.trim())
      .slice(0, 10);
    if (items.length === 0) throw new Error('AI 未返回要点');
    out.innerHTML = `
      <div class="dim" style="margin:6px 0">AI 摘出 ${items.length} 条候选——<b>只把你勾的加入配额</b>，不勾的直接丢掉：</div>
      ${items.map((t, i) => `<label class="plot-row"><input type="checkbox" data-plot-idx="${i}" /> ${esc(t)}</label>`).join('')}
      <div class="row-btns" style="margin-top:8px"><button id="plot-accept" class="primary" disabled>先在上面勾选要保留的要点</button></div>`;
    const acceptBtn = $('plot-accept') as unknown as HTMLButtonElement;
    const refreshCnt = () => {
      const n = out.querySelectorAll('[data-plot-idx]:checked').length;
      acceptBtn.textContent = n ? `把勾选的 ${n} 条加入要点配额` : '先在上面勾选要保留的要点';
      acceptBtn.disabled = n === 0;
    };
    refreshCnt();
    out.querySelectorAll('[data-plot-idx]').forEach((cb) => cb.addEventListener('change', refreshCnt));
    acceptBtn.addEventListener('click', () => {
      const chosen = [...out.querySelectorAll('[data-plot-idx]:checked')].map((cb) => items[Number((cb as HTMLElement).dataset.plotIdx)]);
      const fresh = mergeQuotaTexts(
        s.review.quota.map((q) => q.text),
        chosen,
      );
      for (const t of fresh) s.review.quota.push({ text: t, done: false });
      scheduleSave(s, () => undefined);
      renderSidebar(s, sidebarHandlers);
      renderReportPane(s);
      setStatus(`✓ 已加入 ${fresh.length} 条要点（右侧"本章要点配额"打勾核对）${chosen.length - fresh.length ? `，${chosen.length - fresh.length} 条与已有重复自动跳过` : ''}`, 'saved');
    });
  } catch (e) {
    out.innerHTML = '';
    setStatus('AI 摘要点失败：' + e, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '<svg class="ico"><use href="#i-sparkle"/></svg>AI 摘情节要点';
  }
}

/* ---------- 视图切换（实现在 widgets.ts，可 DOM 级测试） ---------- */

function switchView(name: ViewName): void {
  switchViewDom(document, name);
  syncChrome();
}

/* ---------- 复盘（W2 数据闭环）：读 AI建议台账 → 采纳率聚合 ---------- */

const pct = (x: number | null): string => (x === null ? '—' : (x * 100).toFixed(0) + '%');

async function renderRetroPane(): Promise<void> {
  const pane = $('pane-retro');
  const s = activeSession();
  pane.innerHTML = '<div class="empty">读取台账…</div>';
  let csv: string;
  try {
    const outDir = s?.sourcePath ? s.sourcePath.slice(0, s.sourcePath.lastIndexOf('/')) : await invoke<string>('reports_dir');
    csv = await invoke<string>('read_text_file', { path: `${outDir}/AI建议台账.csv` });
  } catch {
    pane.innerHTML = `<div class="empty">还没有台账数据。<br/>你在正文里点 ✓ 采纳或 ✗ 放弃 AI 建议时，这里会自动积累记录（与变更日志同一文件夹）。<br/><span style="font-size:12px">想看跨书全量分析：菜单 帮助 → 打开本地示例文件夹 旁的《AI建议台账.csv》可用命令行工具聚合（见 docs/W2 交付报告）</span></div>`;
    return;
  }
  const rows = parseLedger(csv);
  if (rows.length === 0) {
    pane.innerHTML = '<div class="empty">台账还没有数据行——采纳/拒绝 AI 建议后自动积累。</div>';
    return;
  }
  const a = aggregate(rows);
  const o = a.overall;
  const card = (label: string, value: string, hint: string) =>
    `<div class="retro-card"><div class="retro-num">${value}</div><div class="retro-label">${label}</div><div class="retro-hint">${hint}</div></div>`;
  // 成本台账（W3）：全书累计在 reports_dir，按书名过滤出本书
  let costHtml = '';
  try {
    const repDir = await invoke<string>('reports_dir');
    const costCsv = await invoke<string>('read_text_file', { path: `${repDir}/AI成本台账.csv` });
    const dir = s?.sourcePath ? s.sourcePath.slice(0, s.sourcePath.lastIndexOf('/')) : '';
    const bookName = dir ? dir.slice(dir.lastIndexOf('/') + 1) : '';
    const cs = summarizeCost(costCsv, bookName || undefined);
    if (cs.calls > 0) {
      costHtml = card(
        '本书 AI 成本',
        `${cs.promptTokens + cs.completionTokens} tokens`,
        `${cs.calls} 次调用（入 ${cs.promptTokens} + 出 ${cs.completionTokens}）${cs.failoverCount ? `，备用切换 ${cs.failoverCount} 次` : ''}${cs.errCount ? `，失败 ${cs.errCount} 次` : ''}`,
      );
    }
  } catch {
    /* 无成本台账则不显示卡片 */
  }
  const groupRows = (list: typeof a.byMark) =>
    list
      .map(
        (g) => `<tr>
      <td>${esc(g.key)}</td><td>${g.total}</td><td>${g.accepted}</td><td>${g.rejected}</td><td>${g.autoApplied}</td>
      <td>${pct(g.explicitRate)}</td><td>${pct(g.checkWarnRatio)}</td></tr>`,
      )
      .join('');
  const cc = a.crossCheck;
  pane.innerHTML = `
    <div class="sg-actions">
      <b>复盘 · 本书 AI 建议采纳情况</b>
      <span style="color:var(--muted);font-size:12px">${rows.length} 条记录（${s?.sourcePath ? '本书文件夹' : '示例模式'}的 AI建议台账.csv）</span>
      <button id="retro-refresh">刷新</button>
    </div>
    <div class="retro-cards">
      ${card('累计建议', String(o.total), '台账自动记录每次 采纳/拒绝/直改')}
      ${card('明确采纳率', pct(o.explicitRate), `教师过目部分（采纳 ${o.accepted}/拒绝 ${o.rejected}）`)}
      ${card('总接受率', pct(o.overallRate), `含直改 ${o.autoApplied} 条（你开启的自动模式）`)}
      ${card('复核⚠︎被拒率', pct(cc.warnTotal ? cc.warnRejected / cc.warnTotal : null), `复核⚠︎ ${cc.warnTotal} 条中 ${cc.warnRejected} 条被拒；复核通过的为 ${pct(cc.okTotal ? cc.okRejected / cc.okTotal : null)}`)}
      ${costHtml}
    </div>
    <table class="sgtable">
      <tr><th>标记类型</th><th>建议数</th><th>采纳</th><th>拒绝</th><th>直改</th><th>明确采纳率</th><th>复核⚠︎比</th></tr>
      ${groupRows(a.byMark)}
    </table>
    ${
      a.topRejected.length
        ? `<table class="sgtable"><tr><th>最常被拒 Top${a.topRejected.length}</th><th>被拒次数</th><th>采纳</th><th>复核⚠︎比</th></tr>
      ${a.topRejected.map((g) => `<tr><td>${esc(g.key)}</td><td>${g.rejected}</td><td>${g.accepted}</td><td>${pct(g.checkWarnRatio)}</td></tr>`).join('')}</table>`
        : ''
    }
    ${
      a.byDate.length > 1
        ? `<table class="sgtable"><tr><th>日期</th><th>建议数</th><th>接受</th><th>拒绝</th><th>明确采纳率</th></tr>
      ${a.byDate.map((d) => `<tr><td>${esc(d.date)}</td><td>${d.total}</td><td>${d.accepted + d.autoApplied}</td><td>${d.rejected}</td><td>${pct(d.rate)}</td></tr>`).join('')}</table>`
        : ''
    }
    <div class="retro-verdict">
      <div style="font-weight:600;margin-bottom:6px">判读（自动生成）</div>
      ${diagnose(a)
        .map((d) => `<div>· ${esc(d)}</div>`)
        .join('')}
    </div>`;
  $('retro-refresh').addEventListener('click', () => void renderRetroPane());
}

/* ---------- 最近编辑 ---------- */

async function pushRecent(fileName: string, sourcePath: string | null): Promise<void> {
  if (!sourcePath) return;
  const list: string[] = [sourcePath, ...(S.appConfig.recentFiles ?? []).filter((x) => x !== sourcePath)].slice(0, 10);
  S.appConfig.recentFiles = list;
  await saveConfig();
}

/* ---------- AI 会话持久化（防抖落盘，重启可恢复） ---------- */

let chatSaveTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleChatSave(): void {
  clearTimeout(chatSaveTimer);
  chatSaveTimer = setTimeout(
    () =>
      void (async () => {
        try {
          const dir = await invoke<string>('reports_dir');
          await invoke('write_text_file', { path: `${dir}/AI会话.json`, content: JSON.stringify(S.chatMsgs, null, 1) });
        } catch {
          /* 尽力保存 */
        }
      })(),
    800,
  );
}

async function restoreChat(): Promise<void> {
  try {
    const dir = await invoke<string>('reports_dir');
    const saved = JSON.parse(await invoke<string>('read_text_file', { path: `${dir}/AI会话.json` }));
    if (Array.isArray(saved) && saved.length) {
      S.chatMsgs = saved;
      chatRender();
    }
  } catch {
    /* 无历史 */
  }
}

/* ---------- 诊断包与本地错误日志（W5：零遥测——只写本机，导出自愿） ---------- */

/** 前端未捕获错误 → 本地错误日志（轮转保留 5 份，见 main.rs append_log） */
function reportError(kind: string, e: unknown): void {
  const detail = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
  void invoke('append_log', { lines: `[${kind}] ${detail}\n` }).catch(() => undefined);
}

window.addEventListener('error', (ev) => reportError('window-error', ev.error ?? ev.message));
window.addEventListener('unhandledrejection', (ev) => reportError('unhandled-rejection', (ev as PromiseRejectionEvent).reason));

/** 导出诊断包 zip：配置摘要(不含文本) + 错误日志 + 成本台账（用户自愿发给别人定位问题用） */
async function exportDiagnostics(): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const savePath = await saveFileDialog({
    defaultPath: `LayerText诊断包_${date}.zip`,
    filters: [{ name: '诊断包 ZIP', extensions: ['zip'] }],
  });
  if (typeof savePath !== 'string') return;
  try {
    const version = await getVersion().catch(() => '未知');
    const summary = buildDiagSummary(S.appConfig, version, navigator.userAgent);
    const files: Record<string, Uint8Array> = { '诊断信息.json': strToU8(JSON.stringify(summary, null, 1)) };
    try {
      const log = await invoke<string>('read_error_log');
      if (log.trim()) files['错误日志.log'] = strToU8(log.slice(-128 * 1024)); // 最多带最近 128KB
    } catch {
      /* 无日志 */
    }
    try {
      const dir = await invoke<string>('reports_dir');
      const cost = await invoke<string>('read_text_file', { path: `${dir}/AI成本台账.csv` });
      if (cost.trim()) files['AI成本台账.csv'] = strToU8(cost.slice(-64 * 1024));
    } catch {
      /* 无台账 */
    }
    const zipped = zipSync(files, { level: 6 });
    const zbuf = zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer;
    await invoke('write_file_base64', { path: savePath, b64: bufToB64(zbuf) });
    setStatus(`诊断包已导出（${Object.keys(files).length} 个文件，不含任何书稿与学生文本）：${savePath}`, 'saved');
    void invoke('reveal_path', { path: savePath });
  } catch (e) {
    setStatus('诊断包导出失败：' + e, 'err');
  }
}

/** 自检：人为制造一条错误写入日志，验证"崩溃 → 诊断包还原现场"链路 */
function simulateError(): void {
  try {
    throw new Error('自检错误（人为制造，用于验证诊断包含错误日志）：如果诊断包里的 错误日志.log 看到这条，链路正常');
  } catch (e) {
    reportError('self-test', e);
  }
  setStatus('已写入一条测试错误——点「帮助 → 导出诊断包…」，打开 zip 里的 错误日志.log 应能看到这条记录', 'saved');
}

/* ---------- 事件绑定 ---------- */

$('tab-text').addEventListener('click', () => switchView('text'));
$('tab-report').addEventListener('click', () => switchView('report'));
$('tab-suggest').addEventListener('click', () => switchView('suggest'));
$('tab-diff').addEventListener('click', () => {
  renderDiff(0, Math.min(1, S.sessions.length - 1));
  switchView('diff');
});
$('tab-align').addEventListener('click', () => {
  renderAlignPane();
  switchView('align');
});
$('tab-board').addEventListener('click', () => {
  void renderBoardPane();
  switchView('board');
});
$('tab-dossier').addEventListener('click', () => {
  void renderDossierPane();
  switchView('dossier');
});
$('tab-retro').addEventListener('click', () => {
  void renderRetroPane();
  switchView('retro');
});

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
  const btn = $('btn-open').getBoundingClientRect();
  menu.style.left = btn.left + 'px';
  menu.style.top = btn.bottom + 6 + 'px';
  menu.innerHTML = `
    <div class="demo-group">内置示例（随应用分发，CC0）</div>
    <div class="demo-item" data-demo="builtin">龟兔赛跑（含示例词库）</div>
    <div class="demo-group">本地示例（文稿/LayerText示例/，自动带词库与术语配置）</div>
    ${locals.map((p) => `<div class="demo-item" data-demo-path="${esc(p)}">${esc(p.slice(p.lastIndexOf('/') + 1))}</div>`).join('')}
    <div class="demo-tip">把章节 md 与 _词库.csv / _术语表.txt / _专名表.txt / _已学词.csv（复现队列，可选）放入该文件夹即可出现在这里</div>`;
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
        void ensureClassGroups(); // 就位保证（幂等）
        const md = await invoke<string>('read_text_file', { path });
        const name = path.slice(path.lastIndexOf('/') + 1);
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
    setStatus('已载入内置示例（含示例词库）');
  });
}

document.addEventListener('mousedown', (e) => {
  if (S.demoMenuOpen && !(e.target as HTMLElement).closest('#demo-menu') && !(e.target as HTMLElement).closest('#btn-open')) {
    closeDemoMenu();
  }
});

/* ---------- 导入无障碍：任意 txt/docx 自动转章节格式 ---------- */

/** 纯文本/无标记文本 → 章节 md（按空行分段，自动编号 [P01]…） */

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

/** 读 txt/md：字节读入 + 自动编码探测（BOM → 严格 UTF-8 校验 → GB18030 兜底）。
 *  中文环境导出的 txt 常为 GBK/GB2312，直接按 UTF-8 读会报错或乱码——对新手这是"软件坏了"级事故 */
async function readTextSmart(path: string): Promise<string> {
  const b64 = await invoke<string>('read_file_base64', { path });
  return decodeAuto(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

async function openPathIntoSession(p: string): Promise<void> {
  const name = p.slice(p.lastIndexOf('/') + 1);
  if (p.toLowerCase().endsWith('.epub')) {
    // epub 整书导入：解析拆章，每章一个会话（原文件不动；想入库走「添加书稿文件夹」）
    const bin = Uint8Array.from(atob(await invoke<string>('read_file_base64', { path: p })), (c) => c.charCodeAt(0));
    const { bookTitle, chapters } = parseEpubChapters(bin);
    for (const ch of chapters) await addSession(epubChapterMd(bookTitle, ch), `${bookTitle} — ${ch.title}`, p, { noAutoQc: true });
    void runQcCurrent({ auto: true });
    setStatus(`已从 epub 导入《${bookTitle}》${chapters.length} 章（原文件未改动）`, 'saved');
    return;
  }
  const raw = p.toLowerCase().endsWith('.docx') ? docxToText(await invoke<string>('read_file_base64', { path: p })) : await readTextSmart(p);
  // 智能归一化：已合规直接用；多章标题拆多 tab；无章节结构的文本内存包装直接显示（原文件不动）
  const { chapters } = normalizeAndSplitChapters(raw, name);
  for (const ch of chapters) await addSession(ch.md, chapters.length > 1 ? ch.title : name, p);
}

async function openChapterFiles(): Promise<void> {
  const paths = await openFileDialog({
    multiple: true,
    filters: [{ name: '章节文件（Markdown / 文本 / Word / EPUB）', extensions: ['md', 'txt', 'markdown', 'docx', 'epub'] }],
  });
  if (!paths) return; // 用户取消选择
  const list: string[] = Array.isArray(paths) ? paths : [paths];
  for (const p of list) {
    try {
      await openPathIntoSession(p);
    } catch (e) {
      setStatus('读取失败：' + e, 'err');
    }
  }
}

/* ---------- 工作区（书目录 _工作区.json：3 层次=3 工作区，浏览器标签式切换） ---------- */

async function loadWorkspaces(dir: string): Promise<void> {
  for (const d of [dir, dir.slice(0, dir.lastIndexOf('/'))]) {
    // 先章目录，再书稿根目录
    try {
      const raw = await invoke<string>('read_text_file', { path: `${d}/_工作区.json` });
      const ws = parseWorkspaces(raw);
      if (ws.length > 0) {
        S.workspaces = ws;
        if (!S.activeWorkspace || !ws.some((w) => w.名 === S.activeWorkspace)) S.activeWorkspace = null;
        return;
      }
    } catch {
      /* 无配置则试上级 */
    }
  }
  S.workspaces = [];
  S.activeWorkspace = null;
}

async function activateWorkspace(name: string): Promise<void> {
  S.activeWorkspace = name;
  const w = S.workspaces.find((x) => x.名 === name);
  renderWorkspaceBar();
  if (w?.定制目标) {
    await ensureClassGroups(); // 绑定口径的前提：分组就位（幂等，未就位才读一次盘）
    if (S.activeWorkspace === name && S.classTargets.some((t) => t.id === w.定制目标)) {
      S.selectedIds = [w.定制目标];
      fileSummary();
      renderWorkspaceBar();
    } else if (S.activeWorkspace === name) {
      setStatus(`工作区【${name}】绑定的口径 ${w.定制目标} 在分组文件里没找到（<svg class="ico"><use href="#i-users"/></svg>班级定制里可查目录位置）`, 'dirty');
    }
  }
}

/** 切工作区的完整闭环（工作区条点击与 ⌘1-3 共用）：绑定口径 → 当前正文属于该版本则就地切换，否则翻开该版本第一章 */
function switchWorkspace(name: string): void {
  void activateWorkspace(name);
  const w = S.workspaces.find((x) => x.名 === name);
  if (!w) return;
  const cur = activeSession()?.sourcePath ?? null;
  const curInWs = cur !== null && w.文件.includes(cur);
  if (curInWs) {
    setStatus(`工作区已切换：${name}${w.定制目标 ? `（口径 ${w.定制目标}）` : ''}`, 'saved');
    return;
  }
  openPathIntoSession(w.文件[0])
    .then(() => setStatus(`已进入【${name}】${workspaceChipName(w.文件[0])}`, 'saved'))
    .catch((e) => setStatus('打开失败：' + e, 'err'));
}

/* ---------- 书架（首页：示例 + 我的书；点书 → 先选版本 → 再进工作区） ---------- */

interface ShelfBook {
  名: string;
  目录: string;
  副标题?: string;
  最近打开?: string;
  /** 分组（右键书卡指派；空=未分组。书多之前只做轻量指派，不做管理弹层） */
  分组?: string;
}

async function shelfPath(): Promise<string> {
  const dir = await invoke<string>('config_dir');
  return `${dir}/书架.json`;
}

async function loadShelf(): Promise<ShelfBook[]> {
  try {
    const raw = await invoke<string>('read_text_file', { path: await shelfPath() });
    const j = JSON.parse(raw) as { 书?: ShelfBook[] };
    return Array.isArray(j.书) ? j.书.filter((b) => b.名 && b.目录) : [];
  } catch {
    return [];
  }
}

async function saveShelf(books: ShelfBook[]): Promise<void> {
  await invoke('write_text_file', { path: await shelfPath(), content: JSON.stringify({ 说明: 'LayerText 书架——我的书注册表', 书: books }, null, 1) });
}

async function renderShelf(): Promise<void> {
  syncChrome(); // 书架=无章节上下文：进书架即收起章节级界面（不依赖调用方先走 renderAll）
  const el = $('reader');
  try {
    await renderShelfInner(el);
  } catch (e) {
    el.innerHTML = `<div class="empty"><b>书架加载失败</b><br/>${esc(String(e))}<br/><span style="font-size:12px">把这条错误发给开发者即可修复</span></div>`;
  }
}

function shelfColor(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h},45%,45%)`;
}

/** 封面图：书目录里的 cover/封面.{jpg,jpeg,png,webp}——找到即用；没有就用书名文字封面 */
async function coverDataUrl(dir: string): Promise<string | null> {
  try {
    const imgs = await invoke<string[]>('list_cover_images', { dir });
    if (!imgs.length) return null;
    const p = imgs[0].toLowerCase();
    const mime = p.endsWith('.png') ? 'png' : p.endsWith('.webp') ? 'webp' : 'jpeg';
    const b64 = await invoke<string>('read_file_base64', { path: imgs[0] });
    return `data:image/${mime};base64,${b64}`;
  } catch {
    return null;
  }
}

/** 书封 HTML：有图全幅显示（书名落底部渐变条），无图用色块+居中书名（字号按书名长度自适应，极端长名换行4行内可见） */
function coverHtml(名: string, img: string | null, boxW = 150): string {
  const style = img ? `background-image:url(${img})` : `background:${shelfColor(名)}`;
  return `<div class="shelf-cover${img ? ' has-img' : ''}" style="${style}">
    <div class="cover-title" style="font-size:${coverTitlePx(名, boxW)}px">${esc(名)}</div>
  </div>`;
}

/** 阅读进度记账：打开过的章节去重累计 + 最近章/时间；total 缺失时补记全书章数 */
function touchProgress(path: string | null): void {
  if (path === null || S.currentBookDir === null) return;
  const all = (S.appConfig.progress ??= {});
  const rec = (all[S.currentBookDir] ??= { chapters: [] });
  if (!rec.chapters.includes(path)) rec.chapters.push(path);
  rec.lastChapter = path;
  rec.lastAt = new Date().toLocaleDateString('sv-SE');
}

async function renderShelfInner(el: HTMLElement): Promise<void> {
  const books = await loadShelf();
  const covers = new Map<string, string | null>();
  await Promise.all(books.map(async (b) => covers.set(b.目录, await coverDataUrl(b.目录))));
  renderShelfChrome(el, books);
  renderShelfGrid(el, books, covers);
  bindShelfChrome(el, books, covers);
}

/** 书架页骨架（继续上次 / 标题 / 工具行 / 分组条 / 正文容器 / 脚注）——进书架渲染一次 */
function renderShelfChrome(el: HTMLElement, books: ShelfBook[]): void {
  const groups = shelfGroupsOf(books);
  const ls = S.appConfig.lastSession;
  el.innerHTML = `
    <div class="shelf">
      ${ls?.files?.length ? `<div class="shelf-resume" id="shelf-resume"><svg class="ico"><use href="#i-play"/></svg>继续上次编辑：${esc(ls.workspace ? ls.workspace + ' · ' : '')}${esc(ls.files[Math.min(ls.activeIdx, ls.files.length - 1)]?.path.split('/').pop() ?? '')} <span class="dim">（${esc(ls.savedAt)}）</span></div>` : ''}
      <div class="shelf-h"><svg class="ico"><use href="#i-books"/></svg>我的书架</div>
      <div class="shelf-tools">
        <input type="search" id="shelf-q" placeholder="搜索书名 / 分组…" value="${esc(S.shelfQ)}"/>
        <span class="viewseg">
          <button id="view-grid" title="书封视图——挑书"><svg class="ico"><use href="#i-grid"/></svg>书封</button>
          <button id="view-list" title="清单视图——管审校进度"><svg class="ico"><use href="#i-list"/></svg>进度</button>
        </span>
        <span class="dim" id="shelf-count" style="font-size:11px"></span>
      </div>
      ${
        groups.length
          ? `<div class="shelf-groups" id="shelf-groups">
        <span class="gchip" data-group="">全部</span>
        <span class="gchip" data-group="__none__">未分组</span>
        ${groups.map((g) => `<span class="gchip" data-group="${esc(g)}">${esc(g)}</span>`).join('')}
      </div>`
          : ''
      }
      <div id="shelf-body"></div>
    </div>`;
}

/** 书卡正文区（网格=挑书 / 列表=管审校进度）。搜索、分组、切视图只更新这里——搜索框不动，输入焦点天然保持 */
function renderShelfGrid(el: HTMLElement, books: ShelfBook[], covers: Map<string, string | null>): void {
  const view = S.appConfig.shelfView ?? 'grid';
  const shown = filterShelfBooks(books, { q: S.shelfQ, group: S.shelfGroup });
  const prog = S.appConfig.progress ?? {};
  const pctOf = (b: ShelfBook): number => {
    const r = prog[b.目录];
    return r ? progressPct(r.chapters.length, r.total) : 0;
  };
  const timeOf = (b: ShelfBook): string => prog[b.目录]?.lastAt ?? b.最近打开 ?? '';
  const progHtml = (b: ShelfBook): string => {
    const pct = pctOf(b);
    return `<div class="shelf-progress" title="审校进度：${pct}%"><i style="width:${pct}%"></i></div><div class="shelf-progress-pct">${pct ? `已审 ${pct}%` : '未开始'}</div>`;
  };
  const coverStyle = (b: ShelfBook): string => {
    const img = covers.get(b.目录);
    return img ? `background-image:url(${img})` : `background:${shelfColor(b.名)}`;
  };
  const badgeHtml = (b: ShelfBook): string => (b.分组?.trim() ? `<span class="shelf-badge">${esc(b.分组.trim())}</span>` : '');

  const gridCards = shown
    .map(
      (b) => `<div class="shelf-card" data-shelf="${esc(b.目录)}" title="打开《${esc(b.名)}》${b.分组 ? ' · 分组 ' + esc(b.分组) : '（右键可设分组）'}">
    <div class="shelf-cover${covers.get(b.目录) ? ' has-img' : ''}" style="${coverStyle(b)}"><div class="cover-title" style="font-size:${coverTitlePx(b.名)}px">${esc(b.名)}</div></div>
    <div class="shelf-info">
      <div class="shelf-sub">${esc(b.副标题 ?? '')}</div>
      ${timeOf(b) ? `<div class="shelf-meta">${esc('最近 ' + timeOf(b))}</div>` : ''}
      ${progHtml(b)}
    </div>
  </div>`,
    )
    .join('');
  const rowCards = shown
    .map(
      (b) => `<div class="shelf-row" data-shelf="${esc(b.目录)}" title="打开《${esc(b.名)}》（右键可设分组）">
      <div class="row-cover" style="${coverStyle(b)}"></div>
      <div class="row-main">
        <div class="row-name">${esc(b.名)}${badgeHtml(b)}</div>
        <div class="row-sub">${esc(b.副标题 ?? '')}</div>
      </div>
      <div class="row-progress">${progHtml(b)}</div>
      <div class="row-time">${esc(timeOf(b))}</div>
    </div>`,
    )
    .join('');
  const emptyHint = '没有匹配的书——换个搜索词，或点分组「全部」';
  const body = el.querySelector<HTMLElement>('#shelf-body');
  if (!body) return;
  body.innerHTML =
    view === 'list'
      ? `<div class="shelf-grid list">${rowCards || `<div class="dim" style="padding:20px 4px">${emptyHint}</div>`}
        <div class="shelf-row add-row" id="shelf-add">＋ 添加书稿文件夹</div></div>`
      : `<div class="shelf-grid">
        <div class="shelf-card demo" id="shelf-demo" title="打开内置示例">
          <div class="shelf-cover" style="background:${shelfColor('龟兔赛跑')}"><div class="cover-title" style="font-size:${coverTitlePx('龟兔赛跑')}px">龟兔赛跑</div></div>
          <div class="shelf-info"><div class="shelf-sub">内置示例 · 含示例词库</div></div>
        </div>
        ${gridCards || `<div class="dim" style="grid-column:1/-1;padding:16px 4px">${emptyHint}</div>`}
        <div class="shelf-card add" id="shelf-add" title="把一个书稿文件夹注册到书架（目录里放 cover.jpg 作书封，_词库.csv / _工作区.json 自动生效）">
          <div class="shelf-cover">＋</div>
          <div class="shelf-info"><div class="shelf-sub">添加书稿文件夹</div></div>
        </div>
      </div>`;
  const count = el.querySelector<HTMLElement>('#shelf-count');
  if (count) count.textContent = `${shown.length === books.length ? `${books.length} 本` : `${shown.length}/${books.length} 本`}`;
  for (const id of ['view-grid', 'view-list']) {
    const btn = document.getElementById(id);
    if (btn) btn.classList.toggle('cur', (id === 'view-grid') === (view === 'grid'));
  }
  // 分组条当前项高亮（搜索不改分组，随分组点击同步）
  el.querySelectorAll<HTMLElement>('[data-group]').forEach((chip) => {
    const g = chip.dataset.group ?? '';
    const active = S.shelfGroup === null ? g === '' : S.shelfGroup === '' ? g === '__none__' : g === S.shelfGroup;
    chip.classList.toggle('cur', active);
  });
  bindShelfCards(el, books);
}

/** 骨架上的固定交互：继续上次 / 示例 / 添加 / 搜索 / 视图 / 分组条 */
function bindShelfChrome(el: HTMLElement, books: ShelfBook[], covers: Map<string, string | null>): void {
  document.getElementById('shelf-resume')?.addEventListener('click', () => void resumeLastSession());
  document.getElementById('shelf-demo')?.addEventListener('click', () => loadBuiltinDemo());
  document.getElementById('shelf-add')?.addEventListener('click', () => void addBookToShelf());
  const q = document.getElementById('shelf-q') as HTMLInputElement | null;
  q?.addEventListener('input', () => {
    S.shelfQ = q.value;
    renderShelfGrid(el, books, covers); // 局部刷新正文区，搜索框与焦点原地不动
  });
  document.getElementById('view-grid')?.addEventListener('click', () => setShelfView('grid', el, books, covers));
  document.getElementById('view-list')?.addEventListener('click', () => setShelfView('list', el, books, covers));
  el.querySelectorAll<HTMLElement>('[data-group]').forEach((chip) =>
    chip.addEventListener('click', () => {
      const g = chip.dataset.group ?? '';
      S.shelfGroup = g === '' ? null : g === '__none__' ? '' : g;
      renderShelfGrid(el, books, covers);
    }),
  );
}

/** 书卡交互（data-shelf=书目录，目录是书的唯一主键——过滤与重渲染后依旧指向同一本） */
function bindShelfCards(el: HTMLElement, books: ShelfBook[]): void {
  el.querySelectorAll<HTMLElement>('[data-shelf]').forEach((card) => {
    const b = books.find((x) => x.目录 === card.dataset.shelf);
    if (!b) return;
    card.addEventListener('click', () => void openBook(b));
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showShelfCtxMenu(b, books, e.clientX, e.clientY);
    });
  });
}

/** 视图切换（持久化）：网格=挑书，列表=管进度——只重绘正文区 */
function setShelfView(v: 'grid' | 'list', el: HTMLElement, books: ShelfBook[], covers: Map<string, string | null>): void {
  S.appConfig.shelfView = v;
  void saveConfig();
  renderShelfGrid(el, books, covers);
}

/** 书卡右键轻量分组菜单：指派到现有分组 / 新建（书多之前保持轻量；保存后整页刷新让分组条同步） */
function showShelfCtxMenu(b: ShelfBook, books: ShelfBook[], x: number, y: number): void {
  closeShelfCtxMenu();
  const menu = document.createElement('div');
  menu.className = 'shelf-ctxmenu';
  menu.id = 'shelf-ctxmenu';
  const curGroup = b.分组?.trim() ?? '';
  const groups = shelfGroupsOf(books);
  menu.innerHTML =
    `<div class="ci ${curGroup === '' ? 'cur' : ''}" data-g="">未分组</div>` +
    groups.map((g) => `<div class="ci ${curGroup === g ? 'cur' : ''}" data-g="${esc(g)}">${esc(g)}</div>`).join('') +
    `<div class="sep"></div><input id="ctx-new-group" placeholder="新建分组名，回车确认"/>`;
  menu.style.left = Math.min(x, window.innerWidth - 190) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 180) + 'px';
  document.body.appendChild(menu);
  const pick = async (g: string): Promise<void> => {
    closeShelfCtxMenu();
    const name = g.trim();
    const fresh = await loadShelf();
    const target = fresh.find((x) => x.目录 === b.目录);
    if (!target) return;
    target.分组 = name || undefined; // undefined 不入 JSON，等于未分组
    await saveShelf(fresh);
    await renderShelf();
    setStatus(name ? `《${b.名}》已移入分组「${name}」` : `《${b.名}》已设为未分组`, 'saved');
  };
  menu.querySelectorAll<HTMLElement>('[data-g]').forEach((ci) => ci.addEventListener('click', () => void pick(ci.dataset.g ?? '')));
  const inp = menu.querySelector('#ctx-new-group') as HTMLInputElement | null;
  inp?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && inp.value.trim()) void pick(inp.value);
  });
  setTimeout(() => document.addEventListener('mousedown', closeShelfCtxMenu, { once: true }), 0);
}

function closeShelfCtxMenu(): void {
  document.getElementById('shelf-ctxmenu')?.remove();
}

async function addBookToShelf(): Promise<void> {
  const dir = await openFileDialog({ directory: true });
  if (typeof dir !== 'string' || !dir) return;
  try {
    const files = (await invoke<string[]>('list_dir', { dir })).filter((f) => /\.(md|txt|docx)$/i.test(f));
    let wsCount = 0,
      chCount = files.length;
    try {
      const ws = parseWorkspaces(await invoke<string>('read_text_file', { path: `${dir}/_工作区.json` }));
      wsCount = ws.length;
      chCount = ws.reduce((n, w) => n + w.文件.length, 0);
    } catch {
      /* 无工作区配置也可注册 */
    }
    if (chCount === 0) {
      setStatus('该文件夹没有可打开的章节文件（.md/.txt/.docx）', 'err');
      return;
    }
    const books = await loadShelf();
    if (books.some((b) => b.目录 === dir)) {
      setStatus('这本书已在书架上', 'saved');
      return;
    }
    const 名 = dir.slice(dir.lastIndexOf('/') + 1) || dir;
    books.push({ 名, 目录: dir, 副标题: wsCount ? `${wsCount} 个版本 · ${chCount} 章` : `${chCount} 个文件`, 最近打开: new Date().toLocaleDateString('sv-SE') });
    await saveShelf(books);
    await renderShelf();
    setStatus(`已加入书架：${名}（${wsCount ? wsCount + ' 个版本' : chCount + ' 个文件'}）——点书选版本`, 'saved');
  } catch (e) {
    setStatus('添加失败：' + e, 'err');
  }
}

/** 点书：加载配置与工作区 → 停在版本选择页（不直接进第一个工作区） */
async function openBook(b: ShelfBook): Promise<void> {
  try {
    await loadBookConfig(b.目录);
    await loadWorkspaces(b.目录);
    S.currentBookDir = b.目录; // 进度记账锚定书根
    // 全书章数（进度百分比分母）：有工作区按版本文件总数计，单卷书按目录章文件数计
    const total = S.workspaces.length > 0 ? S.workspaces.reduce((n, w) => n + w.文件.length, 0) : (await invoke<string[]>('list_dir', { dir: b.目录 })).filter((f) => /\.(md|txt)$/i.test(f)).length;
    const rec = ((S.appConfig.progress ??= {})[b.目录] ??= { chapters: [] });
    if (total > 0) rec.total = total;
    const books = await loadShelf();
    const i = books.findIndex((x) => x.目录 === b.目录);
    if (i >= 0) {
      books[i].最近打开 = new Date().toLocaleDateString('sv-SE');
      await saveShelf(books);
    }
    S.appConfig.lastSession = { bookDir: b.目录, workspace: undefined, files: [], activeIdx: 0, savedAt: new Date().toLocaleString('zh-CN') };
    void saveConfig();
    renderBookVersions(b);
  } catch (e) {
    setStatus('打开书失败：' + e, 'err');
  }
}

/** 版本选择页（两级导航第二步）：一本书的各版本卡片；点了版本才进工作区 */
function renderBookVersions(b: ShelfBook): void {
  syncChrome(); // 版本页=书级页面：章节工具与视图行按无会话上下文收起
  const el = $('reader');
  const cards = buildVersionCards(S.workspaces);
  void coverDataUrl(b.目录).then((img) => {
    const mini = document.getElementById('ver-cover');
    if (mini) mini.innerHTML = coverHtml(b.名, img, 96);
  });
  el.innerHTML = `
    <div class="ver-sel">
      <div class="ver-back" id="ver-back">← 返回书架</div>
      <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
        <div id="ver-cover" style="width: 96px; flex-shrink: 0"></div>
        <div class="ver-h">《${esc(b.名)}》<span class="dim">选一个版本进入</span></div>
      </div>
      ${
        cards.length
          ? `<div class="ver-grid">
        ${cards
          .map(
            (c) => `<div class="ver-card" data-ver="${c.idx}" title="进入【${esc(c.名)}】工作区">
          <div class="ver-name">${esc(c.名)}</div>
          <div class="ver-desc">${esc(c.desc)}</div>
          <div class="ver-first">从「${esc(c.first)}」开始</div>
          <div class="ver-go">进入工作区 →</div>
        </div>`,
          )
          .join('')}
      </div>`
          : `<div class="dim" style="margin-top:14px;line-height:1.9">这本书还没有分层配置（_工作区.json）。<br/>· 直接读：上方「打开文件…」选书稿文件夹里的章节 md 即可（${esc(b.副标题 ?? '')}）。<br/>· 要分 B/M/A 三个版本：在书稿根目录建 _工作区.json（可以让右侧 AI 助手帮你生成，说"帮我写 _工作区.json"即可）。</div>`
      }
    </div>`;
  document.getElementById('ver-back')?.addEventListener('click', () => backToShelf());
  el.querySelectorAll('[data-ver]').forEach((card) =>
    card.addEventListener('click', () => {
      const w = S.workspaces[Number((card as HTMLElement).dataset.ver)];
      if (w) switchWorkspace(w.名); // 绑定口径 + 翻开该版本第一章的完整闭环
    }),
  );
}

/** 点版本：绑定口径 → 翻开该版本第一章 */
/** 回书架：关掉全部章节会话（标记与正文改动早已自动落盘），工作区条一并收起 */
function backToShelf(): void {
  saveLastSession();
  S.sessions = [];
  S.activeIdx = -1;
  S.workspaces = [];
  S.activeWorkspace = null;
  S.currentBookDir = null;
  closeToc();
  hidePop();
  renderAll();
}

/* ---------- 目录侧滑面板（章节 + 审校状态徽标 + 本章书签；审校台的目录，不是小说目录） ---------- */

function tocPanelEl(): HTMLElement | null {
  return document.getElementById('toc-panel');
}

function ensureTocDom(): { mask: HTMLElement; panel: HTMLElement } {
  let mask = document.getElementById('toc-mask');
  let panel = tocPanelEl();
  if (!mask) {
    mask = document.createElement('div');
    mask.id = 'toc-mask';
    mask.addEventListener('mousedown', () => closeToc());
    document.body.appendChild(mask);
  }
  if (!panel) {
    panel = document.createElement('aside');
    panel.id = 'toc-panel';
    panel.innerHTML = `
      <div class="toc-h"><svg class="ico"><use href="#i-list"/></svg>目录<span class="dim" id="toc-sub"></span><button id="toc-close" title="关闭（Esc）">×</button></div>
      <div class="toc-list" id="toc-list"></div>
      <div class="toc-bm-h" id="toc-bm-h" style="display:none"><svg class="ico sm"><use href="#i-bookmark"/></svg>本章书签 <span class="cnt" id="toc-bm-cnt"></span><span class="dim" style="font-weight:400;font-size:10.5px">— 双击正文段号收藏</span></div>
      <div class="toc-bm" id="toc-bm"></div>`;
    document.body.appendChild(panel);
    panel.querySelector('#toc-close')?.addEventListener('click', () => closeToc());
  }
  return { mask, panel: panel! };
}

function toggleToc(): void {
  const panel = tocPanelEl();
  if (panel?.classList.contains('open')) {
    closeToc();
    return;
  }
  const s = activeSession();
  if (!s) {
    toast('先打开一章，目录跟着书走');
    return;
  }
  const { mask, panel: p } = ensureTocDom();
  p.classList.add('open');
  mask.classList.add('open');
  void refreshToc();
}

function closeToc(): void {
  tocPanelEl()?.classList.remove('open');
  document.getElementById('toc-mask')?.classList.remove('open');
}

/** 目录章节数据源：当前工作区文件 → 书目录单章 md → 已打开会话（单文件模式） */
async function tocChapters(): Promise<string[]> {
  const active = S.workspaces.find((w) => w.名 === S.activeWorkspace);
  if (active) return active.文件;
  if (S.currentBookDir) {
    try {
      const fs = await invoke<string[]>('list_dir', { dir: S.currentBookDir });
      return fs.filter((f) => /\.(md|txt)$/i.test(f));
    } catch {
      return [];
    }
  }
  return S.sessions.map((x) => x.sourcePath).filter((x): x is string => !!x);
}

async function refreshToc(): Promise<void> {
  const panel = tocPanelEl();
  if (!panel) return;
  const s = activeSession();
  const cur = s?.sourcePath ?? null;
  const chapters = await tocChapters();
  document.getElementById('toc-sub')!.textContent =
    `${S.currentBookDir ? (S.currentBookDir.split('/').pop() ?? '') : '本次打开'}${S.activeWorkspace ? ' · ' + S.activeWorkspace : ''} · ${chapters.length} 章`;
  const list = document.getElementById('toc-list')!;
  if (!chapters.length) {
    list.innerHTML = `<div class="toc-bm-empty">当前没有书上下文（单章模式）——从书架点书进入后，这里列全书章节并显示各章审校状态。</div>`;
  } else {
    list.innerHTML = chapters
      .map(
        (f) =>
          `<div class="toc-item ${f === cur ? 'cur' : ''}" data-tocf="${esc(f)}" title="${esc(f)}"><span class="t" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(workspaceChipName(f))}</span><span class="toc-badge" data-badge="${esc(f)}">…</span></div>`,
      )
      .join('');
    list.querySelectorAll('[data-tocf]').forEach((item) =>
      item.addEventListener('click', () => {
        const f = (item as HTMLElement).dataset.tocf!;
        closeToc();
        openPathIntoSession(f)
          .then(() => setStatus(`已打开：${workspaceChipName(f)}（工作区【${S.activeWorkspace ?? '—'}】口径）`, 'saved'))
          .catch((e) => setStatus('打开失败：' + e, 'err'));
      }),
    );
    // 各章审校状态：批量读 _审校标记.json，标记数进徽标（读不到=未标记；路径含特殊字符，用 dataset 匹配不用属性选择器）
    const badgeOf = (f: string): HTMLElement | null => [...list.querySelectorAll<HTMLElement>('[data-badge]')].find((b) => b.dataset.badge === f) ?? null;
    for (const f of chapters) {
      if (f === cur) {
        const b = badgeOf(f);
        if (b) b.textContent = s ? `${s.review.marks.length} 标记` : '当前';
        continue;
      }
      void (async () => {
        let label = '未标记';
        try {
          const base = f.slice(f.lastIndexOf('/') + 1).replace(/\.(md|txt|markdown|docx)$/i, '');
          const mp = `${f.slice(0, f.lastIndexOf('/'))}/${base}_审校标记.json`;
          const j = JSON.parse(await invoke<string>('read_text_file', { path: mp })) as { marks?: unknown[] };
          const n = Array.isArray(j.marks) ? j.marks.length : 0;
          if (n) label = `${n} 标记`;
        } catch {
          /* 无标记文件 */
        }
        const b = badgeOf(f);
        if (b) b.textContent = label;
      })();
    }
  }
  // 本章书签区
  const bmBox = document.getElementById('toc-bm');
  const bmH = document.getElementById('toc-bm-h');
  const bms = s?.review.bookmarks ?? [];
  bmH!.style.display = 'flex';
  document.getElementById('toc-bm-cnt')!.textContent = String(bms.length);
  bmBox!.innerHTML = bms.length
    ? bms
        .map((b) => `<div class="toc-bm-item" data-bm="${b.pi}"><span class="p">★P${String(b.pi + 1).padStart(2, '0')}</span><span class="t" title="${esc(b.text)}">${esc(b.text)}</span></div>`)
        .join('')
    : `<div class="toc-bm-empty">本章还没有书签——正文中双击段落号（P01/P02…）即可收藏，回头从这里一键跳回。</div>`;
  bmBox!.querySelectorAll('[data-bm]').forEach((item) =>
    item.addEventListener('click', () => {
      jumpToBookmark(Number((item as HTMLElement).dataset.bm));
    }),
  );
}

/* ---------- 阅读体验：主题（白/灰/深色）与行距 ---------- */

const THEMES: { key: 'light' | 'gray' | 'dark'; label: string; icon: string }[] = [
  { key: 'light', label: '白', icon: 'i-sun' },
  { key: 'gray', label: '灰', icon: 'i-contrast' },
  { key: 'dark', label: '深色', icon: 'i-moon' },
];

function applyTheme(): void {
  const t = S.appConfig.theme ?? 'light';
  document.documentElement.dataset.theme = t;
  const btn = document.getElementById('btn-theme');
  if (btn) {
    btn.innerHTML = `<svg class="ico"><use href="#${THEMES.find((x) => x.key === t)?.icon ?? 'i-sun'}"/></svg>`;
    btn.title = `主题：${THEMES.map((x) => (x.key === t ? `【${x.label}】` : x.label)).join('/')}，点击切换`;
  }
}

function stepTheme(): void {
  const cur = S.appConfig.theme ?? 'light';
  const next = THEMES[(THEMES.findIndex((x) => x.key === cur) + 1) % THEMES.length].key;
  S.appConfig.theme = next;
  applyTheme();
  void saveConfig();
  toast(`主题：${THEMES.find((x) => x.key === next)!.label}`);
}

const LINE_HEIGHTS = [1.7, 1.9, 2.1];

function applyReaderLineHeight(): void {
  document.documentElement.style.setProperty('--read-lh', String(S.appConfig.lineHeight ?? 2.1));
}

function setReaderLineHeight(v: number): void {
  S.appConfig.lineHeight = v;
  applyReaderLineHeight();
  void saveConfig();
  toast(`行距 ${v}`);
}

function renderWorkspaceBar(): void {
  const el = document.getElementById('wstabs') as HTMLElement | null;
  if (!el) return;
  if (S.workspaces.length === 0) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  const active = S.workspaces.find((w) => w.名 === S.activeWorkspace);
  const cur = activeSession()?.sourcePath ?? null;
  el.style.display = 'flex';
  el.innerHTML =
    S.workspaces
      .map((w) => `<span class="ftab ws ${w.名 === S.activeWorkspace ? 'active' : ''}" data-ws="${esc(w.名)}" title="${w.定制目标 ? `绑定定制口径 ${w.定制目标}` : ''}">${esc(w.名)}</span>`)
      .join('') +
    (active
      ? `<span class="ws-files">${active.文件.map((f) => `<span class="wschip ${f === cur ? 'cur' : ''}" data-wsfile="${esc(f)}" title="${esc(f)}">${esc(workspaceChipName(f))}</span>`).join('')}</span>`
      : '');
  el.querySelectorAll('[data-ws]').forEach((t) => t.addEventListener('click', () => switchWorkspace((t as HTMLElement).dataset.ws!)));
  el.querySelectorAll('[data-wsfile]').forEach((c) =>
    c.addEventListener('click', () => {
      const f = (c as HTMLElement).dataset.wsfile!;
      openPathIntoSession(f)
        .then(() => setStatus(`已打开：${workspaceChipName(f)}（工作区【${S.activeWorkspace}】口径）`, 'saved'))
        .catch((e) => setStatus('打开失败：' + e, 'err'));
    }),
  );
}

async function exportMarks(): Promise<void> {
  const s = activeSession();
  if (!s) {
    setStatus('请先载入文本', 'err');
    return;
  }
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
  if (!s) {
    setStatus('请先载入文本', 'err');
    return;
  }
  const path = await openFileDialog({ multiple: false, filters: [{ name: '审校标记 JSON', extensions: ['json'] }] });
  if (typeof path !== 'string') return;
  try {
    const parsed = JSON.parse(await invoke<string>('read_text_file', { path }));
    if (!Array.isArray(parsed?.marks)) throw new Error('不是有效的标记文件');
    const ids = new Set(s.review.marks.map((m) => m.id));
    let added = 0;
    for (const m of parsed.marks)
      if (!ids.has(m.id)) {
        s.review.marks.push(m);
        added++;
      }
    s.review.quota = [...s.review.quota, ...(parsed.quota ?? []).filter((q: { text: string }) => !s.review.quota.some((x) => x.text === q.text))];
    for (const g of GATES) if (parsed.gate?.[g] !== undefined) s.review.gate[g] = parsed.gate[g];
    renderAll();
    scheduleSave(s, () => undefined);
    setStatus(`已导入 ${added} 条标记（同 ID 去重合并）`, 'saved');
  } catch (e) {
    setStatus('导入失败：' + e, 'err');
  }
}

$('btn-home').addEventListener('click', () => backToShelf());

/* 自绘窗控（无边框窗口）：三个 9px 小圆点，随 header 布局流，不遮挡任何内容 */
$('win-close').addEventListener('click', () => void getCurrentWindow().close());
$('win-min').addEventListener('click', () => void getCurrentWindow().minimize());
$('win-max').addEventListener('click', () => void getCurrentWindow().toggleMaximize());
document.querySelector('header')?.addEventListener('dblclick', (e) => {
  if ((e.target as HTMLElement).closest('button, input, select, .mode-pill')) return;
  void getCurrentWindow().toggleMaximize(); // macOS 惯例：标题栏双击缩放
});
$('btn-theme').addEventListener('click', stepTheme);
$('tab-toc').addEventListener('click', toggleToc);
$('btn-open').addEventListener('click', () => void openChapterFiles());
$('btn-run').addEventListener('click', () => void runQcCurrent());
$('btn-undo').addEventListener('click', () => void doUndo());
$('btn-redo').addEventListener('click', () => void doRedo());
$('btn-find').addEventListener('click', openFind);
$('btn-font-minus').addEventListener('click', () => stepReaderFont(-1));
$('btn-font-plus').addEventListener('click', () => stepReaderFont(1));
$('btn-settings').addEventListener('click', toggleSettings);
$('find-prev').addEventListener('click', () => jumpFind(-1));
$('find-next').addEventListener('click', () => jumpFind(1));
$('find-replace-all').addEventListener('click', () => void replaceAllFind());
$('find-close').addEventListener('click', closeFind);
$('find-input').addEventListener('input', runFind);
/** 班级多人定制面板：工具栏不再常驻，入口在 质检 菜单 与 设置 弹层 */
function toggleClsPanel(): void {
  const p = document.getElementById('cls-panel') as HTMLElement | null;
  if (!p) return;
  const show = p.style.display === 'none' || !p.style.display;
  renderClsPanel();
  p.style.display = show ? 'block' : 'none';
}

/* 弹层外点收回：点在弹层与触发控件之外即收起（设置/班级定制/整章改写）——弹层不该挂着不下去 */
document.addEventListener('mousedown', (e) => {
  const t = e.target as HTMLElement;
  const outside = (sel: string) => !t.closest(sel);
  if (outside('#settings-pop') && outside('#btn-settings')) {
    const p = document.getElementById('settings-pop');
    if (p?.style.display === 'block') p.style.display = 'none';
  }
  if (outside('#cls-panel')) {
    const p = document.getElementById('cls-panel');
    if (p?.style.display === 'block') p.style.display = 'none';
  }
  if (outside('#draft-pop') && draftPop.classList.contains('open')) draftPop.classList.remove('open');
});

/* 原生菜单事件分发 */
void listen<string>('menu-action', (ev) => {
  switch (ev.payload) {
    case 'file-open':
      void openChapterFiles();
      break;
    case 'file-demo':
      if (S.demoMenuOpen) closeDemoMenu();
      else void openDemoMenu();
      break;
    case 'conf-vocab':
      void importVocabFile();
      break;
    case 'conf-terms':
      void importTermsFile();
      break;
    case 'conf-proper':
      void importProperFile();
      break;
    case 'marks-export':
      void exportMarks();
      break;
    case 'marks-import':
      void importMarks();
      break;
    case 'qc-run':
      void runQcCurrent();
      break;
    case 'cls':
      toggleClsPanel();
      break;
    case 'sync-marks':
      void showSyncMarksDialog();
      break;
    case 'view-text':
      switchView('text');
      break;
    case 'view-report':
      switchView('report');
      break;
    case 'view-retro':
      void renderRetroPane();
      switchView('retro');
      break;
    case 'ai-settings':
      showAiSettings();
      break;
    case 'ai-suggest':
      void aiSuggest();
      break;
    case 'draft':
      showDraftPop();
      break;
    case 'batch':
      showBatchPop();
      break;
    case 'tier-plan':
      showStandardPop();
      break;
    case 'book-config':
      void saveBookConfig();
      break;
    case 'rewrite-rules':
      showRewritePop();
      break;
    case 'help-key':
      void invoke('open_help_window', { which: 'key' });
      break;
    case 'export-diag':
      void exportDiagnostics();
      break;
    case 'diag-test':
      simulateError();
      break;
    case 'export-docx':
      void exportDocx();
      break;
    case 'export-tts':
      void exportTts();
      break;
    case 'view-diff':
      if (S.sessions.length < 2) setStatus('版本对比需要先打开两个版本（如原文与简化版）', 'err');
      else {
        renderDiff(0, 1);
        switchView('diff');
      }
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
    <div class="fld"><label style="display:flex;align-items:flex-start;gap:6px"><input type="checkbox" id="ai-lowthink" style="width:auto;margin-top:3px" checked /> <span><b>关闭思考</b>（推荐）：直接关闭模型的深度思考（thinking=disabled）——改写任务不需要，关了更快更省更稳</span></label></div>
    <div class="fld"><label>备用供应商（可选）：主服务商连不上/报错时按顺序自动切换。Key 留空 = 复用上面第 ④ 步的主 Key（适合同服务商多模型）</label>
      <div id="ai-fb-rows"></div>
      <button id="ai-fb-add" style="font-size:12px">＋ 添加备用</button></div>
    <div class="row-btns">
      <button id="ai-save" class="primary">保存</button>
      <button id="ai-test">测试连接（填完 ①-④ 就点这个）</button>
      <button id="ai-close">关闭</button>
    </div>
    <div class="test-out" id="ai-test-out"></div>
    <div class="hint-txt">这是什么？AI 功能（改写建议 / AI 简化本章 / AI 助手对话）需要连接一个 AI 服务。上面四步配好后，AI 只负责"给建议"，每条建议都会先经本机质检引擎复核，最后由你点头才生效。不知道 Key 从哪来？点菜单 帮助 → 如何获取 AI 的 Key。<br/>每次 AI 调用（用了哪家/花了多少 tokens）自动记入成本台账，复盘页可查。</div>`;
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

  /* 备用供应商行（failover）：名称/地址/模型/Key(空=复用主Key) */
  const fbRows = $('ai-fb-rows')!;
  const addFbRow = (name = '', url = '', model = '', key = '') => {
    const div = document.createElement('div');
    div.className = 'rw-row';
    div.innerHTML = `<input class="fb-name" value="${esc(name)}" placeholder="名称(如 智谱备用)" style="max-width:90px" />
      <input class="fb-url" value="${esc(url)}" placeholder="API 地址 /v1" />
      <input class="fb-model" value="${esc(model)}" placeholder="模型名" style="max-width:110px" />
      <input class="fb-key" type="password" value="${esc(key)}" placeholder="Key(空=用主Key)" style="max-width:110px" />
      <button class="x">×</button>`;
    div.querySelector('.x')!.addEventListener('click', () => div.remove());
    fbRows.appendChild(div);
  };
  const collectFb = () =>
    [...fbRows.querySelectorAll('.rw-row')]
      .map((r) => ({
        name: (r.querySelector('.fb-name') as HTMLInputElement).value.trim(),
        baseUrl: (r.querySelector('.fb-url') as HTMLInputElement).value.trim().replace(/\/+$/, ''),
        model: (r.querySelector('.fb-model') as HTMLInputElement).value.trim(),
        key: (r.querySelector('.fb-key') as HTMLInputElement).value.trim(),
      }))
      .filter((r) => r.baseUrl && r.model);
  $('ai-fb-add').addEventListener('click', () => addFbRow());
  for (const f of S.appConfig.failover ?? []) addFbRow(f.name ?? '', f.baseUrl ?? '', f.model ?? '');

  void (async () => {
    await loadConfig();
    const key = await invoke<string>('load_api_key');
    const matched = AI_PROVIDERS.findIndex((p) => p.url && p.url === S.appConfig.baseUrl);
    ($('ai-provider') as HTMLSelectElement).value = String(matched >= 0 ? matched : AI_PROVIDERS.length - 1);
    urlEl.value = S.appConfig.baseUrl ?? '';
    if (matched >= 0) applyProvider(matched);
    else {
      modelSel.style.display = 'none';
      modelEl.style.display = '';
      modelEl.value = S.appConfig.model ?? '';
    }
    cur.value = key ?? '';
    ($('ai-instructions') as HTMLTextAreaElement).value = S.appConfig.instructions ?? '';
    ($('ai-auto') as HTMLInputElement).checked = S.appConfig.autoRewriteOnMark ?? false;
    ($('ai-trust') as HTMLInputElement).checked = S.appConfig.trustEdit ?? false;
    ($('ai-inplace') as HTMLInputElement).checked = S.appConfig.inPlaceEdit ?? true;
    ($('ai-lowthink') as HTMLInputElement).checked = S.appConfig.lowThinking !== false;
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
      updateModePill();
      S.appConfig.trustEdit = ($('ai-trust') as HTMLInputElement).checked;
      S.appConfig.inPlaceEdit = ($('ai-inplace') as HTMLInputElement).checked;
      S.appConfig.lowThinking = ($('ai-lowthink') as HTMLInputElement).checked;
      const fbs = collectFb();
      S.appConfig.failover = fbs.length ? fbs.map((f) => ({ name: f.name, baseUrl: f.baseUrl, model: f.model })) : undefined;
      await saveConfig();
      const k = cur.value.trim();
      if (k) await invoke('save_api_key', { key: k });
      for (let i = 0; i < fbs.length; i++) {
        if (fbs[i].key) await invoke('save_api_key', { key: fbs[i].key, account: 'fb' + i });
      }
      reloadPrompts();
      out.textContent = fbs.length ? `✓ 已保存（Key 存入本机钥匙串；备用供应商 ${fbs.length} 个，主服务商失败时按序自动切换）` : '✓ 已保存（Key 存入本机钥匙串）';
    } catch (e) {
      out.textContent = '✗ 保存失败：' + e;
    }
  });
  $('ai-test').addEventListener('click', async () => {
    const out = $('ai-test-out');
    const url = (urlEl.value.trim() || '').replace(/\/+$/, '');
    const model = currentModel();
    const key = cur.value.trim();
    if (!key) {
      out.textContent = '第 ④ 步还没填 Key（一串 sk- 开头的字符）';
      return;
    }
    if (!url || !model) {
      out.textContent = '第 ① 步先选服务商，地址和模型会自动填好';
      return;
    }
    out.textContent = '连接中…';
    try {
      const resp = await tauriFetch(`${url}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: '只回复两个字：正常' }] }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 120)}`);
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
/** 估算 token 的 estTokens 已抽至 pure.ts（对话压缩与请求预估共用口径） */

/**
 * 请求 AI 修订候选。
 * instruction 传入 = 会话式追问（携带 S.aiHistory，AI 知道上一轮建议过什么、你否决了什么）；
 * 不传 = 全新请求（上下文来自本地文件：标记清单+当前文本句子），并重建 S.aiHistory。
 */
function buildAiUserPrompt(session: FileSession): string {
  const body = splitChapter(session.md).body;
  const paras = extractParas(body);
  const maxLen = simplifyMaxLen();
  const r = session.report;
  const marks = session.review.marks
    .filter((m) => m.type !== 'zh' && m.type !== 'anchor' && !(m.type === 'simpl' && m.level !== 'sent')) // 加注/换词走确定性管线、复现锚点是记录型——都不进句子改写
    .map((m) => {
      const sent = sentsOf(paras[m.pi] ?? '', false)[m.si] ?? '(未找到句子)';
      const label =
        m.level === 'word'
          ? `词标记：${m.word ?? ''}（${typeLabel(m.type)}${m.note ? '，备注：' + m.note : ''}）`
          : m.level === 'phrase'
            ? `短语标记：${m.word ?? ''}（${typeLabel(m.type)}${m.note ? '，备注：' + m.note : ''}）`
            : `句标记（${typeLabel(m.type)}${m.note ? '，备注：' + m.note : ''}）`;
      return `【${m.id}】${label}\n所在句：${sent}`;
    })
    .join('\n\n');
  return `简化标准：句长上限 ${maxLen} 词/句；被动语态、定语从句禁用，过去完成时一律改写
${r ? `本章质检摘要：覆盖率 ${(r.coverage * 100).toFixed(1)}%，平均句长 ${r.avgLenNarrRaw.toFixed(1)} 词，被动 ${r.passive}、定从 ${r.relcl}、过去完成 ${r.pastperf}，超20词句 ${r.over20}` : ''}

教师标记清单（逐条给修订建议）：
${marks || '（无标记）'}`;
}

/** 「加中文标注」管线：AI 只出 词→中文 映射（一次小调用，零改写风险），
 *  原句逐字保留，机器在标记所在段对该词的词边界出现处插入 词（中文） */
async function applyZhAnnotations(s: FileSession, marks: Mark[]): Promise<number> {
  const words = [...new Set(marks.map((m) => m.word!).filter(Boolean))];
  const gloss: Record<string, string> = {};
  // 纯本地词典（系统牛津英汉，零网络零 AI）；未收录的词不加注、标记保留给教师自行处理
  let missed: string[] = [];
  try {
    const local = await invoke<(string | null)[]>('dict_lookup_zh', { words });
    missed = [];
    words.forEach((w, i) => {
      if (local[i]) gloss[w] = local[i]!;
      else missed.push(w);
    });
  } catch (e) {
    setStatus('本地词典不可用：' + e, 'err');
    return 0;
  }
  if (missed.length) setStatus(`词典未收录 ${missed.length} 个词：${missed.slice(0, 5).join('、')}${missed.length > 5 ? '…' : ''}（未加注，可在正文手写）`, 'dirty');
  const paras = extractParas(splitChapter(s.md).body);
  const done: string[] = [];
  for (const m of marks) {
    const w = m.word!;
    const zh = gloss[w] ?? gloss[w.toLowerCase()] ?? gloss[w.replace(/\s+/g, ' ')];
    if (!zh) continue;
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${esc}\\b`, 'i');
    let at = -1;
    let matched = '';
    const para = paras[m.pi] ?? '';
    const hit = re.exec(para);
    if (hit) {
      const pAt = s.md.indexOf(para);
      if (pAt >= 0) {
        at = pAt + hit.index;
        matched = s.md.slice(at, at + hit[0].length);
      }
    }
    if (at < 0) {
      const h2 = re.exec(s.md);
      if (h2) {
        at = h2.index;
        matched = h2[0];
      }
    }
    if (at < 0) continue;
    const after = s.md.slice(at + matched.length, at + matched.length + 1);
    if (after === '（') continue; // 已带注释，跳过
    s.md = s.md.slice(0, at + matched.length) + `（${zh}）` + s.md.slice(at + matched.length);
    s.review.marks = s.review.marks.filter((x) => x.id !== m.id);
    remapMarks(s.review.marks, s.md);
    done.push(`${matched}（${zh}）`);
  }
  if (!done.length) {
    setStatus('没有可插入的中文标注（词已不在正文中或释义缺失）', 'err');
    return 0;
  }
  scheduleSave(s, () => undefined);
  renderReader(s);
  renderSidebar(s, sidebarHandlers);
  updateMarkBadge();
  const date = new Date().toLocaleDateString('sv-SE');
  const outDir = s.sourcePath ? s.sourcePath.slice(0, s.sourcePath.lastIndexOf('/')) : await invoke<string>('reports_dir');
  const logPath = `${outDir}/变更日志_AI审核.csv`;
  try {
    let csv = '';
    try {
      csv = await invoke<string>('read_text_file', { path: logPath });
    } catch {
      /* 新建 */
    }
    if (!csv.trim()) csv = CHANGELOG_HEADER.join(',') + '\n';
    for (const d of done) csv += ['R1', date, `标准${simplifyMaxLen()}词`, '', '', d, d, 'R13', '加中文标注（机器插入，原句不动）', 'AI直改-加注'].map(csvCell).join(',') + '\n';
    await invoke('write_text_file', { path: logPath, content: csv });
  } catch {
    /* 日志失败不阻塞 */
  }
  flashApplied(done[done.length - 1]);
  setStatus(`已加中文标注 ${done.length} 处（原句未动）：${done.slice(0, 6).join('、')}${done.length > 6 ? '…' : ''}`, 'saved');
  toast(`已加中文标注 ${done.length} 处（原句未动）`, 'ok');
  return done.length;
}

/** 「词汇简化」管线：词级操作不重构句子——AI 只出 原词→简单词 映射（课标1600内、
 *  保词性与语境形态），机器在该词的词边界处替换，句子其余部分逐字不动 */
async function applyWordSimplifications(s: FileSession, marks: Mark[]): Promise<void> {
  const uniq = [...new Map(marks.map((m) => [m.word!, m])).values()];
  setStatus(`正在为 ${uniq.length} 个词找课标内简单词（不重构句子）…`);
  const paras = extractParas(splitChapter(s.md).body);
  const gloss: Record<string, string> = {};
  try {
    const { raw } = await chatUntilJson(
      [
        {
          role: 'system',
          content:
            '你是词汇简化器。把每个超纲英文词换成中国《义务教育英语课程标准》三级（约1600词）内的同义简单词：保持词性一致，按所在句的语境给正确形态（时态/单复数）。只输出一个 JSON 对象（{"原词":"简单词"}），不要任何其他文字。',
        },
        { role: 'user', content: uniq.map((m) => `${m.word}\n${(paras[m.pi] ?? '').slice(0, 120)}`).join('\n\n') },
      ],
      2000,
      '词汇简化',
    );
    Object.assign(gloss, raw as unknown as Record<string, string>);
  } catch (e) {
    setStatus('词汇简化获取失败：' + e, 'err');
    return;
  }
  // AI 边界防线：映射值剥 Markdown 记号（#16），空值/中文说明直接丢弃（#9 同源）
  for (const k of Object.keys(gloss)) {
    const v = stripMarkdownNoise(String(gloss[k] ?? ''));
    if (!v || hasProseChinese(v)) delete gloss[k];
    else gloss[k] = v;
  }
  const done: string[] = [];
  const morphWarn: string[] = [];
  for (const m of uniq) {
    const w = m.word!;
    const simple = gloss[w] ?? gloss[w.toLowerCase()] ?? gloss[w.replace(/\s+/g, ' ')];
    if (!simple || simple.toLowerCase() === w.toLowerCase()) continue;
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${esc}\\b`, 'i');
    const para = paras[m.pi] ?? '';
    const hit = re.exec(para);
    let at = -1;
    let matched = '';
    if (hit) {
      const pAt = s.md.indexOf(para);
      if (pAt >= 0) {
        at = pAt + hit.index;
        matched = s.md.slice(at, at + hit[0].length);
      }
    }
    if (at < 0) {
      const h2 = re.exec(s.md);
      if (h2) {
        at = h2.index;
        matched = h2[0];
      }
    }
    if (at < 0) continue;
    let repl = simple;
    if (/^[A-Z]/.test(matched)) repl = repl.charAt(0).toUpperCase() + repl.slice(1); // 保首字母大写形态
    if (morphMismatch(matched, repl)) morphWarn.push(`${matched}→${repl}`); // AI 边界 #17：词尾形态类不一致，提示复核不拦截
    s.md = s.md.slice(0, at) + repl + s.md.slice(at + matched.length);
    s.review.marks = s.review.marks.filter((x) => x.id !== m.id);
    s.review.marks = s.review.marks.filter((x) => !(x.level !== 'sent' && x.word && x.word.toLowerCase() === w.toLowerCase())); // 同词（词/短语级）其余标记一并完成
    remapMarks(s.review.marks, s.md);
    done.push(`${matched}→${repl}`);
  }
  // 整体思想：目标是学生读得懂——换不出更简单的词，就自动降级加中文标注
  const restMarks = marks.filter((m) => s.review.marks.some((x) => x.id === m.id));
  let noted = 0;
  if (restMarks.length) noted = await applyZhAnnotations(s, restMarks);
  if (!done.length && !noted) {
    setStatus('既没有更简单的词、也没能加注（词已不在正文中？）', 'err');
    return;
  }
  scheduleSave(s, () => undefined);
  renderReader(s);
  renderSidebar(s, sidebarHandlers);
  updateMarkBadge();
  const date = new Date().toLocaleDateString('sv-SE');
  const outDir = s.sourcePath ? s.sourcePath.slice(0, s.sourcePath.lastIndexOf('/')) : await invoke<string>('reports_dir');
  const logPath = `${outDir}/变更日志_AI审核.csv`;
  try {
    let csv = '';
    try {
      csv = await invoke<string>('read_text_file', { path: logPath });
    } catch {
      /* 新建 */
    }
    if (!csv.trim()) csv = CHANGELOG_HEADER.join(',') + '\n';
    for (const d of done)
      csv += ['R1', date, `标准${simplifyMaxLen()}词`, '', '', d.split('→')[0], d.split('→')[1], 'R14', '词汇简化（机器词级替换，句子不动）', 'AI直改-换词'].map(csvCell).join(',') + '\n';
    await invoke('write_text_file', { path: logPath, content: csv });
  } catch {
    /* 日志失败不阻塞 */
  }
  if (done.length) flashApplied(done[done.length - 1].split('→')[1]);
  const summary =
    `已换 ${done.length} 个词（句子未动）：${done.slice(0, 6).join('、')}${done.length > 6 ? '…' : ''}${noted ? `；换不出的 ${noted} 个已改为加中文标注` : ''}` +
    (morphWarn.length ? `；⚠ ${morphWarn.length} 处词形可能与语境不符（${morphWarn.slice(0, 3).join('、')}），建议复核` : '');
  setStatus(summary, 'saved');
  toast(morphWarn.length ? `已换 ${done.length} 个词；⚠ ${morphWarn.length} 处词形建议复核（详见状态行）` : `已换 ${done.length} 个词（句子未动）`, morphWarn.length ? 'info' : 'ok');
}

async function aiSuggest(instruction?: string): Promise<void> {
  const s = activeSession();
  if (!s) {
    setStatus('请先载入文本', 'err');
    return;
  }
  // 幽灵标记卫生（词/短语级）：词已在之前修订中消失的标记不再发给 AI（曾诱导 AI 凭原著旧句作答、定位失败）
  const ghosts = s.review.marks.filter((m) => m.level !== 'sent' && m.word && !s.md.includes(m.word));
  if (ghosts.length) {
    s.review.marks = s.review.marks.filter((m) => !ghosts.includes(m));
    renderSidebar(s, sidebarHandlers);
    toast(`已清除 ${ghosts.length} 条过期标记（词已在之前修订中处理）：${ghosts.map((m) => m.word).join('、')}`, 'info');
  }
  if (s.review.marks.length === 0 && !instruction) {
    setStatus('还没有标记——先在正文里点词/拖选句子做标记，AI 才知道往哪改', 'err');
    return;
  }
  const key = await invoke<string>('load_api_key');
  if (!key) {
    setStatus('请先配置 AI（菜单 LayerText → AI 设置…）', 'err');
    showAiSettings();
    return;
  }
  const btn = $('btn-ai') as unknown as HTMLButtonElement;
  btn.textContent = '⏳ AI 请求中…';
  btn.disabled = true;
  try {
    // 「加中文标注」是确定性操作，不走句子改写管线（曾致 AI 顺手简化整句）：
    // AI 只出 词→中文 映射，原句逐字保留、机器插入（词（中文））——词级与短语级共用（短语=系统词典短语查询）
    const zhMarks = s.review.marks.filter((m) => m.type === 'zh' && m.word);
    if (zhMarks.length) await applyZhAnnotations(s, zhMarks);
    const simplWordMarks = s.review.marks.filter((m) => m.type === 'simpl' && m.level !== 'sent' && m.word);
    if (simplWordMarks.length) await applyWordSimplifications(s, simplWordMarks);
    if ((zhMarks.length || simplWordMarks.length) && s.review.marks.length === 0 && !instruction) {
      btn.textContent = '按标记修改';
      btn.disabled = false;
      updateMarkBadge();
      return;
    }
    const system = await buildSystemPrompt();
    let messages: { role: string; content: string }[];
    if (instruction && S.aiHistory.length > 0) {
      S.aiHistory.push({ role: 'user', content: instruction + '\n\n请基于我们之前的对话重新输出完整的 JSON 数组（含未改动条目，original 用当前正文原句）。' });
      messages = [{ role: 'system', content: system }, ...S.aiHistory];
    } else {
      const userMsg = buildAiUserPrompt(s);
      S.aiHistory = [{ role: 'user', content: userMsg }];
      messages = [
        { role: 'system', content: system },
        { role: 'user', content: userMsg },
      ];
    }
    const estIn = messages.reduce((n, m) => n + estTokens(m.content), 0);
    setStatus(`本次请求约 ${estIn} tokens 输入（只含标记相关句子，不发全章原文）…`);
    const { raw: rawUnknown, usage } = await chatUntilJson(messages, 6000, '审核建议');
    const raw = rawUnknown as { id: string; type?: string; original?: string; revised?: string; basis?: string; alternative?: string }[];
    S.aiHistory.push({ role: 'assistant', content: JSON.stringify(raw) });
    S.suggestions = raw
      .filter((x) => x.revised)
      .map((x) => {
        // AI 边界 #16：AI 偶在 revised/original 里混 Markdown 记号（**加粗**等）——归一化剥离后再进管线（形态枚举表）
        const risk = checkRev(stripMarkdownNoise(String(x.revised)));
        return {
          markId: String(x.id),
          type: x.type ?? '',
          original: stripMarkdownNoise(String(x.original ?? '')),
          revised: stripMarkdownNoise(String(x.revised)),
          basis: x.basis ?? '',
          alternative: x.alternative ? stripMarkdownNoise(x.alternative) : undefined,
          check: { passive: risk.passive, relcl: risk.relcl, pastperf: risk.pastperf, overlong: risk.overlong },
        };
      });
    if (S.appConfig.autoRewriteOnMark && S.suggestions.length > 0) {
      // 全局直改：能定位的建议直接生效（写工作稿+日志；⚠︎ 复核项计数提醒复查）；
      // 定位失败的自动落入「修订建议」页逐条待人工采纳——建议不因直改失败而丢失
      let warned = 0;
      let applied = 0;
      let cnBlocked = 0;
      for (const g of [...S.suggestions]) {
        if (g.check.passive || g.check.relcl || g.check.pastperf || g.check.overlong) warned++;
        if (hasProseChinese(g.revised)) {
          cnBlocked++; // AI 输出了中文说明/翻译（如"（标注：…）"）——拒写正文，留在建议页人工看
          continue;
        }
        if (await acceptSuggestion(g, { scene: '自动直改', outcome: '直改' })) applied++;
      }
      const leftover = S.suggestions.length;
      if (leftover > 0) renderSuggestions();
      setStatus(
        `AI 直改完成：自动应用 ${applied} 条${warned ? `，其中 ${warned} 条引擎复核⚠︎（黑名单/超长残留），已留痕变更日志，建议复查` : ''}${cnBlocked ? `；拦下 ${cnBlocked} 条含中文说明文字的建议（见「修订建议」页）` : ''}${leftover ? `；未应用的 ${leftover} 条已放入「修订建议」页` : ''} ${usage}`,
        'saved',
      );
      return;
    }
    renderSuggestions();
    attachInlineSuggestions();
    switchView('suggest');
    setStatus(`AI 返回 ${S.suggestions.length} 条修订候选 ${usage}——建议已标到正文里，点 ✓ 采纳 / ✗ 放弃`, 'saved');
  } catch (e) {
    const hint = String(e).includes('未找到 JSON') ? '（模型思考太长占满输出上限——建议 AI 设置里换非思考型模型，或减少一次标记的数量分批出）' : '';
    setStatus('AI 请求失败：' + e + hint, 'err');
  } finally {
    btn.textContent = '<svg class="ico"><use href="#i-sparkle"/></svg>AI 审核建议';
    btn.disabled = false;
    updateMarkBadge();
  }
}

function checkLabel(c: Suggestion['check']): string {
  const bad: string[] = [];
  if (c.passive) bad.push('被动');
  if (c.relcl) bad.push('定从');
  if (c.pastperf) bad.push('过去完成');
  if (c.overlong) bad.push('超长');
  return bad.length ? `<span class="warn-badge">⚠︎ 仍含${bad.join('/')}</span>` : '<span class="ok-badge">✓ 复核通过</span>';
}

function renderSuggestions(): void {
  const pane = $('pane-suggest');
  if (S.suggestions.length === 0) {
    pane.innerHTML = '<div class="empty">暂无修订建议——点「AI 审核建议」生成</div>';
    return;
  }
  pane.innerHTML = `
    <div class="sg-actions">
      <button id="sg-apply" class="primary">应用已勾选（0）→ 生成新版本 + 变更日志</button>
      <button id="sg-refresh">重新请求 AI</button>
      <span style="color:var(--muted);font-size:12px">默认全不勾；引擎复核 ⚠︎ 的条目请人工确认后再勾</span>
    </div>
    <table class="sgtable">
      <tr><th></th><th>标记</th><th class="orig">原句</th><th class="rev">AI 建议</th><th>引擎复核</th><th>依据</th></tr>
      ${S.suggestions
        .map(
          (g, i) => `
        <tr>
          <td><input type="checkbox" data-sg="${i}" /></td>
          <td style="white-space:nowrap">${esc(g.type)}</td>
          <td class="orig" title="${esc(g.original)}">${esc(g.original.slice(0, 90))}${g.original.length > 90 ? '…' : ''}</td>
          <td class="rev" title="${esc(g.revised)}${g.alternative ? '&#10;备选：' + esc(g.alternative) : ''}">${esc(g.revised.slice(0, 90))}${g.revised.length > 90 ? '…' : ''}</td>
          <td>${checkLabel(g.check)}</td>
          <td>${esc(g.basis)}</td>
        </tr>`,
        )
        .join('')}
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
  syntax: 'R03-R06',
  long: 'R07',
  ref: 'R05',
  cut: 'R01',
  stiff: 'R08',
  simpl: 'R02',
  zh: 'R02',
  oov: 'R02',
  hard: 'R02',
  factw: 'R00',
  others: 'R00',
  otherw: 'R00',
  fact: 'R00',
  goods: 'R11',
};

/** 读旧追加一行 CSV（无文件则连表头新建；台账与变更日志共用） */
async function appendCsvLine(path: string, header: readonly string[], line: string): Promise<void> {
  let csv = '';
  try {
    csv = await invoke<string>('read_text_file', { path });
  } catch {
    /* 新建 */
  }
  if (!csv.trim()) csv = header.join(',') + '\n';
  await invoke('write_text_file', { path, content: csv + line });
}

/** AI 建议台账（W2 数据闭环）：每次建议被 采纳/拒绝/直改 落一行，复盘页与分析脚本据此聚合 */
async function logSuggestion(s: FileSession, g: Suggestion, outcome: '采纳' | '拒绝' | '直改', scene: string, mark?: Mark): Promise<void> {
  try {
    const outDir = s.sourcePath ? s.sourcePath.slice(0, s.sourcePath.lastIndexOf('/')) : await invoke<string>('reports_dir');
    const bad = g.check.passive || g.check.relcl || g.check.pastperf || g.check.overlong;
    let host = S.appConfig.baseUrl ?? '';
    try {
      host = new URL(host).host;
    } catch {
      if (host) host = '自定义';
    }
    // 欠账#8：failover 切过供应商时记实际那家（与成本台账同一命名），不再误记主服务商
    const providerUsed = S.lastProvider?.name ?? host;
    const modelUsed = S.lastProvider?.model ?? S.appConfig.model ?? '';
    const dir = s.sourcePath ? s.sourcePath.slice(0, s.sourcePath.lastIndexOf('/')) : '';
    const row: LedgerRow = {
      ts: new Date().toLocaleString('sv-SE'),
      book: dir ? dir.slice(dir.lastIndexOf('/') + 1) : s.fileName,
      chapter: s.fileName,
      tier: `标准${simplifyMaxLen()}词`,
      scene,
      markType: g.type || (mark ? typeLabel(mark.type) : ''),
      rule: mark ? (RULE_BY_TYPE[mark.type] ?? 'R00') : 'R00',
      outcome,
      check: bad ? '⚠︎' : '通过',
      provider: providerUsed,
      model: modelUsed,
      promptVer: await promptSetVersion(),
      original: g.original,
      revised: g.revised,
      basis: g.basis,
      rejectReason: outcome === '拒绝' ? '（点✗放弃，未填原因）' : '',
    };
    await appendCsvLine(`${outDir}/AI建议台账.csv`, LEDGER_HEADER, toLedgerLine(row));
  } catch {
    /* 台账尽力而为，不影响主流程 */
  }
}

/** 批量应用（修订建议页）：统一走 acceptSuggestion（工作稿+变更日志），不再另生成 AI修订 文件 */
async function applySuggestions(): Promise<void> {
  const s = activeSession();
  if (!s) return;
  const checked = [...document.querySelectorAll<HTMLInputElement>('#pane-suggest [data-sg]:checked')].map((cb) => Number(cb.dataset.sg));
  if (checked.length === 0) {
    setStatus('请先勾选要采用的修订（或在正文里直接点 ✓）', 'err');
    return;
  }
  for (const i of checked.sort((a, b) => b - a)) {
    const g = S.suggestions[i];
    if (g && g.pi !== undefined) await acceptSuggestion(g, { scene: '批量' });
  }
}

/* ---------- 行内修订对照（左栏所见即所得） ---------- */

/** 在正文中唯一定位原句（实现已抽至 pure.ts locateOriginal，此处按会话包装） */
function locateSent(session: FileSession, original: string): { pi: number; si: number } | null {
  return locateOriginal(session.md, original);
}

/** 为 pending 建议挂行内（不唯一匹配的只进修订建议表） */
function attachInlineSuggestions(): void {
  const s = activeSession();
  if (!s) return;
  for (const g of S.suggestions) {
    if (g.status && g.status !== 'pending') continue;
    g.status = 'pending';
    if (g.pi === undefined) {
      const loc = locateSent(s, g.original);
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
    ${bad ? `<span class="sug-warn">⚠︎ 引擎复核：仍含${[g.check.passive ? '被动' : '', g.check.relcl ? '定从' : '', g.check.pastperf ? '过去完成' : '', g.check.overlong ? '超长' : ''].filter(Boolean).join('/')}</span>` : ''}
    <span class="sug-basis">${esc(g.basis)}${g.alternative ? '｜备选：' + esc(g.alternative) : ''}</span>
    <button class="btn-ok">✓ 采纳（正文立即更新，改动记入工作稿）</button>
    <button class="btn-no">✗ 放弃</button>`;
  div.querySelector('.btn-ok')!.addEventListener('click', () => void acceptSuggestion(g));
  div.querySelector('.btn-no')!.addEventListener('click', () => {
    g.status = 'rejected';
    div.remove();
    sentEl.classList.remove('sug-pending');
    S.suggestions = S.suggestions.filter((x) => x !== g);
    const s = activeSession();
    if (s) void logSuggestion(s, g, '拒绝', '行内');
    renderSuggestions();
  });
  sentEl.after(div);
}

/** 保存正文改动：默认直接写原稿文件（首次前自动备份原始版）；关闭"直接修改原稿"则写工作稿 */
async function persistEdit(s: FileSession, newMd: string): Promise<string> {
  if (newMd !== s.md) {
    // 文件级撤销栈（≤50 快照；重做栈清空）
    (s.undoStack ??= []).push(s.md);
    if (s.undoStack.length > 50) s.undoStack.shift();
    s.redoStack = [];
  }
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

/* 标记重排 remapMarks(marks, md) 已抽至 pure.ts（O4，行为不变） */

async function acceptSuggestion(g: Suggestion, opts: { scene?: string; outcome?: '采纳' | '直改' } = {}): Promise<boolean> {
  const scene = opts.scene ?? '行内';
  const outcome = opts.outcome ?? '采纳';
  const s = activeSession();
  if (!s) return false;
  // 句级坐标（日志定位与漂移重挂）：尽力而为，拿不到不阻塞——替换成败由下面的宽容匹配决定
  if (g.pi === undefined || g.si === undefined) {
    const loc = locateSent(s, g.original);
    if (loc) {
      g.pi = loc.pi;
      g.si = loc.si;
    }
  } else {
    const paras = extractParas(splitChapter(s.md).body);
    const cur = sentsOf(paras[g.pi] ?? '', false)[g.si];
    if (cur !== g.original) {
      const loc = locateSent(s, g.original);
      if (loc) {
        g.pi = loc.pi;
        g.si = loc.si;
      }
    }
  }
  let at = s.md.indexOf(g.original);
  if (at < 0) {
    const flex = findOriginalFlex(s.md, g.original); // 空白/连字符差异容忍
    if (flex) {
      at = flex.start;
      g.original = flex.exact;
    }
  }
  if (at < 0) {
    setStatus(`正文中找不到该原句，已跳过：${g.original.slice(0, 24)}…`, 'err');
    return false;
  }
  g.revised = normalizeZhNotes(g.revised); // 生词注释统一全角紧贴（word（中文））
  s.md = s.md.slice(0, at) + g.revised + s.md.slice(at + g.original.length);

  // 标记对齐 + 对应标记清除 + 落盘
  const removed = s.review.marks.filter((m) => m.id === g.markId);
  s.review.marks = s.review.marks.filter((m) => m.id !== g.markId);
  // 词被本次改写替换掉的词标记一并完成（如 bleated→made soft sounds 后，bleated 标记不再残留成幽灵）
  s.review.marks = s.review.marks.filter((m) => !(m.level === 'word' && m.word && g.original.includes(m.word) && !g.revised.includes(m.word)));
  remapMarks(s.review.marks, s.md);
  g.status = 'accepted';
  S.suggestions = S.suggestions.filter((x) => x !== g);

  const date = new Date().toLocaleDateString('sv-SE');
  const outDir = s.sourcePath ? s.sourcePath.slice(0, s.sourcePath.lastIndexOf('/')) : await invoke<string>('reports_dir');
  const logPath = `${outDir}/变更日志_AI审核.csv`;
  try {
    const savedTo = await persistEdit(s, s.md);
    let csv = '';
    try {
      csv = await invoke<string>('read_text_file', { path: logPath });
    } catch {
      /* 新建 */
    }
    if (!csv.trim()) csv = CHANGELOG_HEADER.join(',') + '\n';
    csv +=
      [
        'R1',
        date,
        `标准${simplifyMaxLen()}词`,
        `P${String((g.pi ?? 0) + 1).padStart(2, '0')}`,
        `P${(g.pi ?? 0) + 1}-S${(g.si ?? 0) + 1}`,
        g.original,
        g.revised,
        RULE_BY_TYPE[removed[0]?.type ?? ''] ?? 'R00',
        g.basis,
        'AI候选-行内采纳',
      ]
        .map(csvCell)
        .join(',') + '\n';
    await invoke('write_text_file', { path: logPath, content: csv });
    await logSuggestion(s, g, outcome, scene, removed[0]);
    scheduleSave(s, () => undefined);
    renderReader(s);
    attachInlineSuggestions();
    renderSidebar(s, sidebarHandlers);
    renderSuggestions();
    setStatus(`✓ 正文已改好并写入原稿文件${savedTo === s.sourcePath ? '（首改前已备份原始版）' : ''}；变更日志同步留痕、可回溯`, 'saved');
    flashApplied(g.revised);
    return true;
  } catch (e) {
    setStatus('落盘失败：' + e, 'err');
    return false;
  }
}

/* ---------- 词面板：AI 改写本句 ---------- */

async function aiRewriteSentence(pi: number, si: number, intent: string, autoMarkId?: string): Promise<void> {
  const s = activeSession();
  if (!s) return;
  const key = await invoke<string>('load_api_key');
  if (!key) {
    showAiSettings();
    return;
  }
  const paras = extractParas(splitChapter(s.md).body);
  const sent = sentsOf(paras[pi] ?? '', false)[si];
  if (!sent) return;
  const system = await buildSystemPrompt();
  const btn = pop.querySelector('[data-mk="__rewrite"]') as HTMLElement | null;
  if (btn) {
    btn.textContent = '⏳ 改写中…';
    (btn as HTMLButtonElement).disabled = true;
  }
  try {
    const { raw: arrRaw } = await chatUntilJson(
      [
        { role: 'system', content: system },
        {
          role: 'user',
          content: await buildRewriteSentencePrompt({ maxLen: simplifyMaxLen(), intent, sent }),
        },
      ],
      4000,
      '逐句改写',
    );
    const arr = arrRaw as { original?: string; revised?: string; basis?: string; alternative?: string }[];
    const one = arr[0];
    if (!one?.revised) throw new Error('AI 未返回改写');
    const risk = checkRev(String(one.revised));
    const g: Suggestion = {
      markId: autoMarkId ?? 'rw-' + Date.now().toString(36),
      type: intent || '词改写',
      original: String(one.original ?? sent),
      revised: String(one.revised),
      basis: one.basis ?? '',
      alternative: one.alternative,
      status: 'pending',
      check: { passive: risk.passive, relcl: risk.relcl, pastperf: risk.pastperf, overlong: risk.overlong },
    };
    if (autoMarkId) {
      hidePop();
      await acceptSuggestion(g, { scene: '标记即改写', outcome: '直改' });
      return;
    }
    S.suggestions.push(g);
    hidePop();
    attachInlineSuggestions();
    setStatus('AI 已给出本句改写——正文黄色区域内点 ✓ 采纳或 ✗ 放弃', 'saved');
  } catch (e) {
    const hint = String(e).includes('未找到 JSON') ? '（原因：你的模型把"思考过程"写进了回答，占满了输出上限还没写到 JSON——AI 设置里换非思考型模型如 deepseek-chat 最省心）' : '';
    setStatus('AI 改写失败：' + e + hint, 'err');
  } finally {
    if (btn) {
      btn.textContent = '<svg class="ico"><use href="#i-sparkle"/></svg>AI 改写本句';
      (btn as HTMLButtonElement).disabled = false;
    }
  }
}

$('btn-ai').addEventListener('click', () => void aiSuggest());

/* ================= AI 简化本章：整章逐段改写（两阶段工作流的第一阶段；更简版本=把结果再导入再简化） ================= */

const draftPop = $('draft-pop');

/** 简化规则行（注入每次简化请求；难度由教师词库锚定，标准只有句长上限一个数） */
function simplifyRule(): string {
  return `简化标准：平均句长 ≤${simplifyMaxLen()} 词；被动语态、定语从句禁用；过去完成时一律改写为一般过去时或 before/after 明示先后。`;
}

function showDraftPop(): void {
  const s = activeSession();
  if (!s) {
    setStatus('请先打开要简化的章节原文', 'err');
    return;
  }
  draftPop.innerHTML = `
    <div class="pop-h">AI 简化本章 · 整章逐段改写</div>
    <p style="color:var(--muted);font-size:12px;line-height:1.7;margin:6px 0 10px">
      对「${esc(s.fileName)}」按<b>当前简化标准（句长上限 ${simplifyMaxLen()} 词，菜单 LayerText → 简化标准… 可调）</b>逐段生成简化版（保留段落结构与全部情节），完成后自动质检、开新 tab——原稿不动，之后进入标记精修。<br/>
      需要<b>更简的版本</b>？把生成的简化版再导入、再点一次这里即可（词库不变，句子更短更浅）。</p>
    <div class="fld"><label>方向指令（写你的整体要求，AI 全程遵守）</label>
      <textarea id="draft-instructions" placeholder="例如：面向九年级；歌篇原样保留不改写；人名保留原文；第 3 段 Major 的演讲要压缩到一半"></textarea></div>
    <div class="row-btns">
      <button id="draft-start" class="primary">开始简化</button>
      <button id="draft-cancel" style="display:none">取消</button>
      <button id="draft-close">关闭</button>
    </div>
    <div id="draft-progress" style="display:none">
      <div id="draft-step"></div>
      <div class="bar"><i id="draft-bar"></i></div>
    </div>`;
  draftPop.classList.add('open');
  $('draft-close').addEventListener('click', () => {
    S.draftAbort?.abort();
    draftPop.classList.remove('open');
  });
  $('draft-cancel').addEventListener('click', () => {
    S.draftAbort?.abort();
  });
  $('draft-start').addEventListener('click', () => void generateDraft());
}

function cleanDraftSeg(text: string, fallbackMarker: string): string {
  let t = text.trim();
  t = t.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '');
  if (!t.includes('[P')) t = fallbackMarker + ' ' + t; // AI 丢了段标记则补回
  return t.trim();
}

/** 整章逐段简化核心（「AI 简化本章」与全书批处理共用）：逐段调用、前文衔接、段标记补回、书级替换 */
async function simplifyChapterCore(
  md: string,
  instructions: string,
  onSeg: (i: number, total: number, segHead: string) => void,
  signal?: AbortSignal,
): Promise<{ md: string; outTokens: number; segCount: number }> {
  const chLine = md.match(/^## Chapter \w+.*$/m)?.[0] ?? '## Chapter One';
  const header = md.slice(0, md.indexOf(chLine)) || '';
  const body = splitChapter(md).body;
  const segs = body.match(/\[P\d+\][\s\S]*?(?=\[P\d+\]|$)/g) ?? [];
  if (segs.length === 0) throw new Error('未找到 [P##] 段落，无法简化（打开时已自动转格式的文本都有）');
  const system = await buildDraftSystemPrompt({
    tierRule: simplifyRule(),
    chnoNote: '',
    instructions:
      (instructions ? `- 教师方向指令（最高优先级）：${instructions}` : '') +
      (mergedSelection().active ? `\n- 班级定制目标（${mergedSelection().label}）：本篇句长上限取最严 ${mergedSelection().minLen} 词/句` : '') +
      (reinforceWordsNow()
        ? `\n- 复现词约束：以下学生已学词请择 8-12 个在本章自然复现（教师指令：尽量多复现）（词形可按语境变化，融入情节，不硬塞不改故事）：${reinforceWordsNow()!.slice(0, 12).join(' / ')}`
        : ''),
  });
  const out: string[] = [];
  let tokens = 0;
  for (let i = 0; i < segs.length; i++) {
    onSeg(i, segs.length, segs[i].slice(0, 8).trim());
    const prevTail = out.length ? out[out.length - 1].slice(-500) : '（本章开头）';
    const { content, usage } = await callChat(
      [
        { role: 'system', content: system },
        {
          role: 'user',
          content: `前文（已简化，供语气与指代衔接参考）：\n…${prevTail}\n\n请简化以下段落：\n${segs[i].trim()}`,
        },
      ],
      2500,
      signal,
      'AI 简化本章',
    );
    tokens += Number(usage.match(/(\d+) 出/)?.[1] ?? 0);
    out.push(applyRewrite(cleanDraftSeg(content, segs[i].match(/\[P\d+\]/)![0])));
  }
  return { md: `${header}${chLine}\n\n${out.join('\n\n')}\n`, outTokens: tokens, segCount: segs.length };
}

async function generateDraft(): Promise<void> {
  const s = activeSession();
  if (!s) return;
  const key = await invoke<string>('load_api_key');
  if (!key) {
    showAiSettings();
    return;
  }
  const instructions = ($('draft-instructions') as HTMLTextAreaElement).value.trim();

  S.draftAbort = new AbortController();
  const startBtn = $('draft-start') as HTMLButtonElement;
  startBtn.disabled = true;
  ($('draft-cancel') as HTMLElement).style.display = '';
  $('draft-progress').style.display = '';
  try {
    const {
      md: newMd,
      outTokens: tokens,
      segCount,
    } = await simplifyChapterCore(
      s.md,
      instructions,
      (i, total, head) => {
        $('draft-step').textContent = `正在简化第 ${i + 1}/${total} 段（${head}…）`;
        ($('draft-bar') as HTMLElement).style.width = `${(i / total) * 100}%`;
      },
      S.draftAbort!.signal,
    );
    ($('draft-bar') as HTMLElement).style.width = '100%';
    $('draft-step').textContent = '简化完毕，正在保存并体检…';

    const date = new Date().toLocaleDateString('sv-SE');
    const clsTag = mergedSelection().active ? `_${mergedSelection().label.replace(/[/\\?%*:|"<>&]/g, '')}` : '';
    let outPath: string;
    if (s.sourcePath) {
      const dir = s.sourcePath.slice(0, s.sourcePath.lastIndexOf('/'));
      outPath = `${dir}/${s.fileName.replace(/\.(md|txt|markdown)$/i, '')}_简化_${date}${clsTag}.md`;
    } else {
      const dir = await invoke<string>('reports_dir');
      outPath = `${dir}/示例_简化_${date}.md`;
    }
    await invoke('write_text_file', { path: outPath, content: newMd });
    draftPop.classList.remove('open');
    await addSession(newMd, outPath.slice(outPath.lastIndexOf('/') + 1), outPath, { noAutoQc: true });
    await runQcCurrent();
    setStatus(`简化版已生成（${segCount} 段，约 ${tokens} 出tokens）：${outPath}。体检指标见报告页——继续用标记精修；要更简版本：打开它再简化一次`, 'saved');
    void invoke('reveal_path', { path: outPath });
  } catch (e) {
    $('draft-step').textContent = '✗ 中断：' + e;
  } finally {
    startBtn.disabled = false;
    ($('draft-cancel') as HTMLElement).style.display = 'none';
    S.draftAbort = null;
  }
}

/* ================= O2 全书批处理：勾选多章 → 队列「AI 简化 + 体检 + 规则校验」→ 书级汇总报告 ================= */

const BATCH_PROGRESS_FILE = '_全书批处理进度.json';
const batchPop = $('batch-pop');

let batchDir = '';
let batchItems: BatchChapterItem[] = [];
let batchAbort: AbortController | null = null;

function showBatchPop(): void {
  batchDir = '';
  batchItems = [];
  batchPop.innerHTML = `
    <div class="pop-h"><svg class="ico"><use href="#i-books"/></svg>全书简化 · 批处理队列</div>
    <p class="dim" style="margin:4px 0 10px;line-height:1.8">对整本书逐章执行「AI 简化 + 自动体检 + 书级规则校验」。每章产物与单章操作完全相同（<b>xxx_简化_日期.md</b>，原稿不动），全部跑完生成<b>《全书简化报告_日期.md》</b>横向对比各章指标。<b>中断可续跑</b>：已完成的章下次自动跳过；单章失败不拖垮后面的章。</p>
    <div class="fld"><label>① 书稿文件夹（一本书一个文件夹；词库/规则随《_LayerText项目.json》自动生效）</label>
      <div class="row-btns"><button id="bt-pick" class="primary">选择书稿文件夹…</button><span class="dim" id="bt-dir-label" style="align-self:center;word-break:break-all"></span></div></div>
    <div class="fld" id="bt-list-fld" style="display:none"><label>② 章节清单（勾选要跑的）</label>
      <div style="max-height:200px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:6px" id="bt-list"></div></div>
    <div class="fld" id="bt-inst-fld" style="display:none"><label>③ 方向指令（全部章共用，可留空）</label>
      <textarea id="bt-instructions" placeholder="例如：面向九年级；人名保留原文；歌篇原样保留不改写"></textarea></div>
    <div class="row-btns" id="bt-actions" style="display:none">
      <button id="bt-start" class="primary">开始简化</button>
      <button id="bt-cancel" style="display:none">取消队列（已完成的章保留）</button>
      <button id="bt-close">关闭</button>
    </div>
    <div id="bt-progress" style="display:none">
      <div id="bt-step" class="dim" style="margin-top:10px"></div>
      <div class="bar"><i id="bt-bar"></i></div>
    </div>`;
  batchPop.classList.add('open');
  $('bt-close').addEventListener('click', () => {
    batchAbort?.abort();
    batchPop.classList.remove('open');
  });
  $('bt-pick').addEventListener('click', () => void pickBatchDir());
  $('bt-start').addEventListener('click', () => void runBatch());
  $('bt-cancel').addEventListener('click', () => {
    batchAbort?.abort();
  });
}

async function readChapterRaw(path: string): Promise<string> {
  return path.toLowerCase().endsWith('.docx') ? docxToText(await invoke<string>('read_file_base64', { path })) : await readTextSmart(path);
}

async function pickBatchDir(): Promise<void> {
  const dir = await openFileDialog({ directory: true, title: '选择书稿文件夹' });
  if (typeof dir !== 'string') return;
  batchDir = dir;
  $('bt-dir-label').textContent = dir;
  // 本书配置自动生效（与打开单章同口径）
  if (await loadBookConfig(dir)) setStatus('已自动加载本书配置（词库/术语/约定/规则）——全书批处理将按本书规则执行', 'saved');
  let paths: string[] = [];
  try {
    paths = await invoke<string[]>('list_dir', { dir });
  } catch {
    /* 目录不可读 */
  }
  if (paths.length === 0) {
    $('bt-list-fld').style.display = '';
    $('bt-list').innerHTML = '<div class="dim" style="padding:6px">这个文件夹里没有可处理的章节文件（.md/.txt/.docx；_ 开头配置与已生成的简化/工作稿产物不算）</div>';
    $('bt-inst-fld').style.display = 'none';
    $('bt-actions').style.display = 'none';
    return;
  }
  let progress: BatchProgressFile | null = null;
  try {
    progress = JSON.parse(await invoke<string>('read_text_file', { path: `${dir}/${BATCH_PROGRESS_FILE}` })) as BatchProgressFile;
  } catch {
    /* 无进度文件 */
  }
  batchItems = [];
  for (const p of paths) {
    const item = planBatchChapters([p], progress)[0];
    try {
      const { chapters } = normalizeAndSplitChapters(await readChapterRaw(p), item.name);
      item.segCount = chapters.reduce((n, ch) => n + (ch.md.match(/\[P\d+\]/g)?.length ?? 0), 0);
    } catch {
      /* 读不了的章段数显示为空 */
    }
    batchItems.push(item);
  }
  renderBatchList(progress);
}

function renderBatchList(progress: BatchProgressFile | null): void {
  const box = $('bt-list');
  box.innerHTML = batchItems
    .map(
      (it, i) => `
    <label style="display:flex;align-items:center;gap:6px;padding:3px 4px;font-size:12px">
      <input type="checkbox" data-bt="${i}" ${it.done ? '' : 'checked'} />
      <span style="flex:1;word-break:break-all">${esc(it.name)}</span>
      <span class="dim" style="white-space:nowrap">${it.segCount ? it.segCount + ' 段' : ''}</span>
      ${it.done ? '<span class="ok-badge" style="white-space:nowrap">✓ 上次已完成（跳过）</span>' : ''}
    </label>`,
    )
    .join('');
  if (progress && batchItems.some((x) => x.done)) {
    box.insertAdjacentHTML(
      'afterbegin',
      `<div class="dim" style="padding:2px 4px 6px">检测到上次批处理进度：已完成的章默认不勾选——续跑只跑剩下的；想重跑某一章，勾上它即可（产物会覆盖当天同名文件）</div>`,
    );
  }
  $('bt-list-fld').style.display = '';
  $('bt-inst-fld').style.display = '';
  $('bt-actions').style.display = '';
  const instructionsEl = $('bt-instructions') as HTMLTextAreaElement;
  if (progress?.instructions) instructionsEl.value = progress.instructions;
  const refreshStart = () => {
    const n = box.querySelectorAll('[data-bt]:checked').length;
    ($('bt-start') as unknown as HTMLButtonElement).textContent = n ? `开始简化（${n} 章）` : '先在上方勾选章节';
    ($('bt-start') as unknown as HTMLButtonElement).disabled = n === 0;
  };
  box.querySelectorAll('[data-bt]').forEach((cb) => cb.addEventListener('change', refreshStart));
  refreshStart();
}

async function saveBatchProgress(progress: BatchProgressFile): Promise<void> {
  try {
    await invoke('write_text_file', { path: `${batchDir}/${BATCH_PROGRESS_FILE}`, content: JSON.stringify(progress, null, 1) });
  } catch {
    /* 进度尽力而为 */
  }
}

/** 书级替换规则残留计数（机器核对，不靠 AI 自觉；与 rewriteCheck 同口径） */
function countRuleLeft(md: string): number {
  let left = 0;
  let body: string;
  try {
    body = splitChapter(md).body;
  } catch {
    return 0;
  }
  for (const r of S.rewriteRules.replacements) {
    if (!r.from) continue;
    left += (body.match(new RegExp(`\\b${r.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')) ?? []).length;
  }
  return left;
}

async function runBatch(): Promise<void> {
  const runIdx = [...document.querySelectorAll<HTMLInputElement>('#bt-list [data-bt]:checked')].map((cb) => Number(cb.dataset.bt));
  const runItems = runIdx.map((i) => batchItems[i]).filter(Boolean);
  if (runItems.length === 0) return;
  const key = await invoke<string>('load_api_key');
  if (!key) {
    setStatus('全书简化需要先配置 AI（菜单 LayerText → AI 设置…）', 'err');
    showAiSettings();
    return;
  }

  const date = new Date().toLocaleDateString('sv-SE');
  const instructions = ($('bt-instructions') as HTMLTextAreaElement).value.trim();
  const progress: BatchProgressFile = { date, instructions, status: {} };
  try {
    const old = JSON.parse(await invoke<string>('read_text_file', { path: `${batchDir}/${BATCH_PROGRESS_FILE}` })) as BatchProgressFile;
    for (const [k, v] of Object.entries(old.status ?? {})) if (v === 'done') progress.status[k] = 'done';
  } catch {
    /* 全新队列 */
  }

  batchAbort = new AbortController();
  const rows: BookReportRow[] = [];
  const totalSegsAll = runItems.reduce((n, it) => n + it.segCount, 0);
  let doneSegsAll = 0;
  // 进入进度态
  $('bt-list-fld').style.display = 'none';
  $('bt-inst-fld').style.display = 'none';
  ($('bt-pick') as unknown as HTMLButtonElement).disabled = true;
  ($('bt-start') as unknown as HTMLButtonElement).disabled = true;
  ($('bt-start') as unknown as HTMLButtonElement).style.display = 'none';
  ($('bt-cancel') as HTMLElement).style.display = '';
  $('bt-progress').style.display = '';

  const setStep = (t: string) => {
    $('bt-step').textContent = t;
  };
  let canceled = false;

  for (let ci = 0; ci < runItems.length; ci++) {
    const item = runItems[ci];
    setStep(`第 ${ci + 1}/${runItems.length} 章：${item.name} · 读取中…`);
    const tFile = Date.now();
    try {
      const { chapters } = normalizeAndSplitChapters(await readChapterRaw(item.path), item.name);
      for (let chi = 0; chi < chapters.length; chi++) {
        const ch = chapters[chi];
        const tCh = Date.now();
        const base = item.name.replace(/\.(md|txt|markdown|docx)$/i, '');
        const outName = `${chapters.length > 1 ? `${base}_${chi + 1}` : base}_简化_${date}${mergedSelection().active ? `_${mergedSelection().label.replace(/[/\\?%*:|"<>&]/g, '')}` : ''}.md`;
        const {
          md: newMd,
          outTokens: tk,
          segCount,
        } = await simplifyChapterCore(
          ch.md,
          instructions,
          (i, total) => {
            doneSegsAll = Math.min(doneSegsAll + 1, totalSegsAll);
            setStep(`第 ${ci + 1}/${runItems.length} 章 · ${ch.title}：正在简化第 ${i + 1}/${total} 段（全书进度 ${doneSegsAll}/${totalSegsAll} 段）`);
            ($('bt-bar') as HTMLElement).style.width = `${totalSegsAll ? (doneSegsAll / totalSegsAll) * 100 : 0}%`;
          },
          batchAbort!.signal,
        );
        await invoke('write_text_file', { path: `${batchDir}/${outName}`, content: newMd });
        const report = runQc(newMd, buildLexiconNow(), {
          tier: 'M',
          fileName: outName,
          chno: chnoFromPath(item.path),
          tierGates: { passiveFromCh: 0, relclFromCh: 0 },
          ...(S.properRows.length ? { propCheckList: S.properRows } : {}),
          ...(reinforceWordsNow() ? { reinforceWords: reinforceWordsNow()! } : {}),
        });
        rows.push({
          chapter: chapters.length > 1 ? `${item.name} · ${chi + 1}` : item.name,
          output: outName,
          segCount,
          oovRate: (report.newWordRate * 100).toFixed(1) + '%',
          avgLen: report.avgLenNarrRaw.toFixed(1),
          maxLen: report.maxLen,
          passive: report.passive,
          relcl: report.relcl,
          pastperf: report.pastperf,
          overlong: report.over20,
          ruleLeft: countRuleLeft(newMd),
          elapsedMs: Date.now() - tCh,
          outTokens: tk,
          status: 'done',
        });
      }
      progress.status[item.path] = 'done';
      await saveBatchProgress(progress);
      setStep(`✓ ${item.name} 完成（${((Date.now() - tFile) / 1000).toFixed(0)} 秒）`);
    } catch (e) {
      if (batchAbort?.signal.aborted) {
        canceled = true;
        break;
      }
      progress.status[item.path] = 'failed';
      rows.push({
        chapter: item.name,
        output: '',
        segCount: item.segCount,
        oovRate: '',
        avgLen: '',
        maxLen: 0,
        passive: 0,
        relcl: 0,
        pastperf: 0,
        overlong: 0,
        ruleLeft: 0,
        elapsedMs: Date.now() - tFile,
        outTokens: 0,
        status: 'failed',
        error: String(e).slice(0, 160),
      });
      await saveBatchProgress(progress);
      setStep(`✗ ${item.name} 失败：${String(e).slice(0, 80)}——继续下一章`);
    }
  }

  // 收尾：写书级报告；全部成功则清进度文件（队列已完结），有失败/中断则保留供续跑
  const doneCount = rows.filter((r) => r.status === 'done').length;
  if (rows.length > 0) {
    const reportPath = `${batchDir}/全书简化报告_${date}.md`;
    try {
      await invoke('write_text_file', {
        path: reportPath,
        content: buildBookReportMd(rows, {
          book: batchDir.slice(batchDir.lastIndexOf('/') + 1),
          date,
          maxLen: simplifyMaxLen(),
          instructions,
          provider: S.lastProvider?.name,
        }),
      });
      if (canceled) {
        setStatus(`全书批处理已取消：本次完成 ${doneCount}/${runItems.length} 章。产物已保留，书级报告：${reportPath}——重新打开本对话框选同一文件夹可续跑`, 'saved');
      } else {
        setStatus(
          `全书批处理完成：成功 ${doneCount}/${runItems.length} 章。书级汇总报告：${reportPath}${rows.some((r) => r.status === 'failed') ? '（有失败章节，报告里列了原因，可单独重跑）' : ''}`,
          'saved',
        );
        void invoke('reveal_path', { path: reportPath });
      }
    } catch (e) {
      setStatus('书级报告写入失败：' + e, 'err');
    }
  }
  if (!canceled) {
    try {
      await invoke('remove_file', { path: `${batchDir}/${BATCH_PROGRESS_FILE}` });
    } catch {
      /* 删除失败不影响结果 */
    }
  }
  // 恢复对话框为可再次选择状态
  ($('bt-pick') as unknown as HTMLButtonElement).disabled = false;
  ($('bt-start') as unknown as HTMLButtonElement).style.display = '';
  ($('bt-cancel') as HTMLElement).style.display = 'none';
  $('bt-progress').style.display = 'none';
  batchAbort = null;
}

document.addEventListener('mousedown', (e) => {
  if (batchPop.classList.contains('open') && !(e.target as HTMLElement).closest('#batch-pop')) {
    batchAbort?.abort();
    batchPop.classList.remove('open');
  }
});

/* ---------- 修改模式胶囊：一眼可见、一键切换（即改=立即生效 / 候选=点✓生效） ---------- */
function updateModePill(): void {
  renderModePill($('mode-pill'), S.appConfig.autoRewriteOnMark === true);
}
$('mode-pill').addEventListener('click', async () => {
  S.appConfig.autoRewriteOnMark = !(S.appConfig.autoRewriteOnMark === true);
  await saveConfig();
  updateModePill();
  updateMarkBadge();
  setStatus(S.appConfig.autoRewriteOnMark ? '已切换【即改模式】：点标记/AI建议将立即生效（写原稿+变更日志，首次修改前自动备份）' : '已切换【候选模式】：AI 只出建议，你点 ✓ 才生效', 'saved');
});
updateModePill();

/* ---------- 启动序列：配置 → 首启动欢迎 ---------- */
setAiUi({ onStatus: (s) => setStatus(s, 'dirty') });

/* ================= UX 补齐（2026-09-08 Wayne：文本软件该有的东西） ================= */

function toast(msg: string, kind: 'ok' | 'err' | 'info' = 'info'): void {
  let box = document.getElementById('toast-box');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast-box';
    document.body.appendChild(box);
  }
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(
    () => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 400);
    },
    kind === 'err' ? 6000 : 2600,
  );
}
window.addEventListener('error', (e) => toast('脚本错误：' + e.message, 'err'));
window.addEventListener('unhandledrejection', (e) => toast('异步错误：' + ((e.reason as Error)?.message ?? String(e.reason)), 'err'));

function scrollEl(): HTMLElement | null {
  for (const sel of ['#reader', '.content', 'main']) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el && el.scrollHeight > el.clientHeight) return el;
  }
  return document.querySelector<HTMLElement>('#reader');
}
function scrollNow(): number {
  return scrollEl()?.scrollTop ?? 0;
}

/* ---- 会话恢复：回到上次编辑 ---- */
let lastSessionTimer: ReturnType<typeof setTimeout> | null = null;
function saveLastSession(): void {
  if (S.sessions.length === 0) return;
  const cur = activeSession();
  if (cur) cur.scrollTop = scrollNow();
  const dir = S.sessions.find((x) => x.sourcePath)?.sourcePath;
  S.appConfig.lastSession = {
    bookDir: dir ? dir.slice(0, dir.lastIndexOf('/')) : undefined,
    workspace: S.activeWorkspace ?? undefined,
    files: S.sessions.filter((x) => x.sourcePath).map((x) => ({ path: x.sourcePath!, scroll: x.scrollTop ?? 0 })),
    activeIdx: S.activeIdx,
    savedAt: new Date().toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
  };
  void saveConfig();
}
function scheduleSaveLastSession(): void {
  if (lastSessionTimer) clearTimeout(lastSessionTimer);
  lastSessionTimer = setTimeout(saveLastSession, 1500);
}
async function resumeLastSession(): Promise<void> {
  const ls = S.appConfig.lastSession;
  if (!ls?.files?.length) {
    toast('没有上次的编辑记录');
    return;
  }
  S.currentBookDir = ls.bookDir ?? null; // 进度记账锚定回书根
  let opened = 0;
  for (const f of ls.files) {
    try {
      await openPathIntoSession(f.path);
      opened++;
    } catch {
      /* 文件可能被移走，跳过 */
    }
  }
  if (opened === 0) {
    S.currentBookDir = null; // 文件全部失效：还原书根锚定，回书架重新选书
    toast('上次的文件都打不开了（可能被移动）', 'err');
    return;
  }
  if (ls.workspace && S.workspaces.some((w) => w.名 === ls.workspace)) switchWorkspace(ls.workspace);
  const idx = Math.min(ls.activeIdx, S.sessions.length - 1);
  S.activeIdx = idx;
  const s = activeSession();
  if (s && (ls.files[idx]?.scroll ?? 0) > 0) {
    setTimeout(() => {
      const el = scrollEl();
      if (el) el.scrollTop = ls.files[idx].scroll;
    }, 60);
  }
  renderAll();
  toast(`已回到上次：${ls.workspace ? ls.workspace + ' · ' : ''}${s?.fileName ?? ''}（${ls.savedAt}）`, 'ok');
}

/* ---- 撤销 / 重做 ---- */
async function applyMdSnapshot(s: FileSession, md: string, label: string): Promise<void> {
  await persistEdit(s, md);
  s.md = md;
  remapMarks(s.review.marks, s.md); // 正文变了标记跟着重对齐（撤销/查找替换曾是欠账：标记错位不修）
  scheduleSave(s, () => undefined);
  renderAll();
  setStatus(label + '（文件已同步保存）', 'saved');
  scheduleSaveLastSession();
}
async function doUndo(): Promise<void> {
  const s = activeSession();
  if (!s?.undoStack?.length) {
    toast('没有可撤销的更改');
    return;
  }
  const prev = s.undoStack.pop()!;
  (s.redoStack ??= []).push(s.md);
  await applyMdSnapshot(s, prev, '↩︎ 已撤销');
}
async function doRedo(): Promise<void> {
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
function openFind(): void {
  const bar = document.getElementById('findbar');
  if (!bar) return;
  bar.style.display = 'flex';
  const inp = document.getElementById('find-input') as HTMLInputElement | null;
  inp?.focus();
  inp?.select();
  runFind();
}
function closeFind(): void {
  const bar = document.getElementById('findbar');
  if (bar) bar.style.display = 'none';
  document.querySelectorAll('.flash-hit').forEach((el) => el.classList.remove('flash-hit'));
}
function runFind(): void {
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
function jumpFind(dir: 1 | -1): void {
  if (findHits.length === 0) return;
  findPos = (findPos + dir + findHits.length) % findHits.length;
  const el = findHits[findPos];
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.add('flash-hit');
  const cnt = document.getElementById('find-count');
  if (cnt) cnt.textContent = `${findPos + 1}/${findHits.length} 句`;
}
async function replaceAllFind(): Promise<void> {
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

/* ---- 阅读字号 ---- */
/** 正文字号：写 CSS 变量 --read-fs（正文/行内建议统一跟随；英文正文默认 17——x-height 小，须大于界面字级） */
function applyReaderFont(): void {
  document.documentElement.style.setProperty('--read-fs', String(S.appConfig.readerFont ?? 17) + 'px');
}
function stepReaderFont(d: number): void {
  const n = Math.min(26, Math.max(13, (S.appConfig.readerFont ?? 17) + d));
  S.appConfig.readerFont = n;
  applyReaderFont();
  scheduleHeatRail();
  void saveConfig();
  toast('字号 ' + n + 'px');
}

/* ---- 设置弹层 ---- */
function toggleSettings(): void {
  let pop = document.getElementById('settings-pop');
  if (pop) {
    const show = pop.style.display === 'none';
    pop.style.display = show ? 'block' : 'none';
    if (show) renderSettings();
    return;
  }
  pop = document.createElement('div');
  pop.id = 'settings-pop';
  pop.style.display = 'block';
  document.body.appendChild(pop);
  renderSettings();
}
function renderSettings(): void {
  const pop = document.getElementById('settings-pop');
  if (!pop) return;
  const sel = mergedSelection();
  const rw = reinforceWordsNow();
  const row = (label: string, ctrl: string) => `<div class="set-row"><span>${label}</span>${ctrl}</div>`;
  pop.innerHTML = `<div class="pop-h"><svg class="ico"><use href="#i-settings"/></svg>设置 <span class="dim" style="font-weight:400;font-size:12px">（改完即存）</span></div>
    ${row('阅读字号', `<button id="set-fm">A－</button> <b id="set-fv">${S.appConfig.readerFont ?? 17}</b>px <button id="set-fp">A＋</button>`)}
    ${row('行间距', `<span class="seg">${LINE_HEIGHTS.map((h) => `<button class="${(S.appConfig.lineHeight ?? 2.1) === h ? 'cur' : ''}" data-lh="${h}">${h}</button>`).join('')}</span>`)}
    ${row('主题', `<span class="seg">${THEMES.map((t) => `<button class="${(S.appConfig.theme ?? 'light') === t.key ? 'cur' : ''}" data-theme="${t.key}">${t.label}</button>`).join('')}</span>`)}
    ${row('句长上限（简化标准）', `<button id="set-len">调整（${simplifyMaxLen()} 词）</button>`)}
    ${row('直接修改原稿（首改自动备份）', `<input type="checkbox" id="set-inplace" ${(S.appConfig.inPlaceEdit ?? true) ? 'checked' : ''}/>`)}
    ${row('AI 改写直接生效', `<input type="checkbox" id="set-autorew" ${S.appConfig.autoRewriteOnMark ? 'checked' : ''}/>`)}
    ${row('词库', `<span class="dim">课标1600（内置）${S.vocabCsvText ? ` + ${esc(S.vocabName ?? '自定义词库')}` : ''}${S.termsText ? ' + 术语表' : ''}</span>`)}
    ${row('复现队列', `<span class="dim">${rw ? `${esc(S.reinforceName ?? '已学词')} · ${rw.length} 词 · ⑩指标与简化注入已启用` : '未启用（班级定制勾选后自动生效）'}</span>`)}
    ${row('班级定制口径', `<button id="set-cls">${sel.active ? `【${esc(sel.label)}】句长≤${sel.minLen} · 更换` : '选择班级…'}</button>`)}
    <div class="dim" style="margin-top:8px">LayerText v1.1 · 词库以书目录 _词库.csv 为准</div>`;
  pop.querySelectorAll<HTMLElement>('[data-lh]').forEach((b) =>
    b.addEventListener('click', () => {
      setReaderLineHeight(Number(b.dataset.lh));
      renderSettings();
    }),
  );
  pop.querySelectorAll<HTMLElement>('[data-theme]').forEach((b) =>
    b.addEventListener('click', () => {
      S.appConfig.theme = b.dataset.theme as 'light' | 'gray' | 'dark';
      applyTheme();
      void saveConfig();
      renderSettings();
    }),
  );
  document.getElementById('set-fm')?.addEventListener('click', () => {
    stepReaderFont(-1);
    renderSettings();
  });
  document.getElementById('set-fp')?.addEventListener('click', () => {
    stepReaderFont(1);
    renderSettings();
  });
  document.getElementById('set-len')?.addEventListener('click', () => {
    showStandardPop();
  });
  document.getElementById('set-cls')?.addEventListener('click', () => {
    toggleClsPanel();
  });
  document.getElementById('set-inplace')?.addEventListener('change', (e) => {
    S.appConfig.inPlaceEdit = (e.target as HTMLInputElement).checked;
    void saveConfig();
    toast('已保存');
  });
  document.getElementById('set-autorew')?.addEventListener('change', (e) => {
    S.appConfig.autoRewriteOnMark = (e.target as HTMLInputElement).checked;
    void saveConfig();
    toast('已保存');
  });
}

/* ================= 键盘审校流（跳难句 / 数字键标记 / 切工作区）与难句热力轨 ================= */

/** F8 / ⌘G：跳到下一处风险句（被/从/完/长），循环滚动 + 闪烁 + 计数 */
let riskJumpIdx = -1;
function jumpNextRisk(dir: 1 | -1): void {
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

/** 标记弹层开着时：数字键 1-9 = 选第 N 类标记，R = AI 改写本句，E = 手动改这句（note 输入框聚焦时不拦截） */
function popHotkey(k: string): boolean {
  if (!pop.classList.contains('open')) return false;
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) return false; // 正在写备注，别抢键
  const btns = [...pop.querySelectorAll<HTMLElement>('[data-mk]')];
  let hit: HTMLElement | null = null;
  if (k === 'r' || k === 'R') hit = pop.querySelector<HTMLElement>('[data-mk="__rewrite"]');
  else if (k === 'e' || k === 'E') hit = pop.querySelector<HTMLElement>('[data-mk="__edit"]');
  else if (/^[1-9]$/.test(k)) hit = btns.filter((b) => !b.dataset.mk!.startsWith('__'))[Number(k) - 1] ?? null;
  if (!hit) return false;
  hit.click();
  return true;
}

/* ---------- 正文右侧热力轨：风险句红点 / 标记蓝点 / 叠加紫点，点圆点直达 ---------- */

let heatRaf = 0;
function scheduleHeatRail(): void {
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
  const dot = (el: HTMLElement, cls: string, title: string): void => {
    const d = document.createElement('div');
    d.className = 'heat-dot ' + cls;
    const y = ((contentY(el, pane) - readerTop) / total) * H;
    d.style.top = Math.max(0, Math.min(H - 6, y)) + 'px';
    d.title = title;
    d.addEventListener('click', () => {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
    });
    rail!.appendChild(d);
  };
  // 风险句红点
  const riskEls = [...document.querySelectorAll<HTMLElement>('#reader .sent.risk')];
  const riskSet = new Set(riskEls);
  for (const el of riskEls) dot(el, 'risk', (el.textContent ?? '').slice(0, 50));
  // 标记蓝点（与风险句同句 → 紫点）
  const sentByKey = new Map<string, HTMLElement>();
  document.querySelectorAll<HTMLElement>('#reader .sent').forEach((el) => sentByKey.set(`${el.dataset.pi}:${el.dataset.si}`, el));
  for (const m of s.review.marks) {
    const el = sentByKey.get(`${m.pi}:${m.si}`);
    if (!el) continue;
    dot(el, riskSet.has(el) ? 'both' : 'mark', (m.level === 'word' ? '词' : m.level === 'phrase' ? '短语' : '句') + '标记：' + (m.word ?? m.text ?? '').slice(0, 30));
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

/* ---- 全局快捷键 ---- */
document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  // 键盘审校流：弹层数字键选标记 > ⌘数字切工作区 > F8/⌘G 跳难句（⇧⌘G 上一个）
  if (!mod && popHotkey(e.key)) {
    e.preventDefault();
    return;
  }
  if (mod && /^[1-9]$/.test(e.key)) {
    const w = S.workspaces[Number(e.key) - 1];
    if (w) {
      e.preventDefault();
      switchWorkspace(w.名);
    }
    return;
  }
  if (e.key === 'F8') {
    e.preventDefault();
    jumpNextRisk(1);
    return;
  }
  if (mod && (e.key === 'g' || e.key === 'G')) {
    e.preventDefault();
    if ((document.getElementById('findbar')?.style.display ?? 'none') !== 'none')
      jumpFind(1); // 查找条开着：⌘G=下一个命中
    else jumpNextRisk(e.shiftKey ? -1 : 1);
    return;
  }
  if (mod && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault();
    openFind();
  } else if (e.key === 'Escape') {
    closeFind();
    closeToc();
    closeShelfCtxMenu();
  } else if (mod && e.altKey && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault();
    void (e.shiftKey ? doRedo() : doUndo());
  } else if (mod && (e.key === '=' || e.key === '+')) {
    e.preventDefault();
    stepReaderFont(1);
  } else if (mod && e.key === '-') {
    e.preventDefault();
    stepReaderFont(-1);
  } else if (e.key === 'Enter' && document.activeElement?.id === 'find-input') {
    e.preventDefault();
    jumpFind(1);
  }
});
document.addEventListener('scroll', () => scheduleSaveLastSession(), true);

void (async () => {
  await loadConfig();
  if (!S.appConfig.firstRunSeen) showWelcome();
  await restoreChat();
  applyReaderFont();
  applyReaderLineHeight();
  applyTheme();
  await renderShelf(); // 首页=书架（示例+我的书；原"最近编辑"空状态升级为书架）
  setInterval(() => void saveLastSession(), 20000); // 兜底：上次会话自动保存
})();

/* ================= 简化标准（句长上限，唯一可调项） · 本书配置 · 首启动欢迎 ================= */

const tierPop = $('tier-pop');

function showStandardPop(): void {
  tierPop.innerHTML = `
    <div class="pop-h">简化标准 —— 句长上限</div>
    <p class="dim" style="margin:4px 0 10px;line-height:1.8">
      本工具不预设难度层：简化到什么程度由<b>你的词库</b>决定（学生学过什么词，就简化到词库内）。
      句长上限是唯一的硬标准，影响：体检参考值、AI 改写与整章简化。<br/>
      需要<b>更简的版本</b>？不用选"更低的层"——把简化结果再导入、再简化一遍就行，句子会更短更浅。</p>
    <div class="fld" style="display:flex;align-items:center;gap:8px">
      <label style="margin:0">句长上限</label>
      <input type="number" id="std-maxlen" value="${simplifyMaxLen()}" min="8" max="30" style="width:64px" /> 词/句
      <span class="dim">（默认 16；学生基础弱可降到 12~14）</span>
    </div>
    <div class="row-btns">
      <button id="std-save" class="primary">保存</button>
      <button id="std-reset">恢复默认（16 词）</button>
      <button id="std-close">关闭</button>
    </div>`;
  tierPop.classList.add('open');
  $('std-close').addEventListener('click', () => tierPop.classList.remove('open'));
  const apply = async (v: number | undefined) => {
    S.appConfig.simplify = v === undefined ? undefined : { maxLen: v };
    await saveConfig();
    tierPop.classList.remove('open');
    const s = activeSession();
    if (s) renderAll();
    setStatus(v === undefined ? '简化标准已恢复默认（16 词/句）' : `简化标准已保存：句长上限 ${v} 词/句`, 'saved');
  };
  $('std-reset').addEventListener('click', () => void apply(undefined));
  $('std-save').addEventListener('click', () => {
    const v = Number(($('std-maxlen') as HTMLInputElement).value);
    void apply(v >= 8 && v <= 30 ? v : undefined);
  });
}
document.addEventListener('mousedown', (e) => {
  if (tierPop.classList.contains('open') && !(e.target as HTMLElement).closest('#tier-pop')) tierPop.classList.remove('open');
});

/* ---------- 本书配置：词库/术语/专名/约定 随书稿文件夹保存与自动加载 ---------- */

const BOOK_CONFIG = '_LayerText项目.json';

async function saveBookConfig(): Promise<void> {
  const s = activeSession();
  if (!s?.sourcePath) {
    setStatus('先打开本书的一个章节文件，配置会保存在它旁边', 'err');
    return;
  }
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
    if (cfg.vocabCsv) {
      S.vocabCsvText = cfg.vocabCsv;
      S.vocabName = cfg.vocabName ?? '本书词库';
    }
    if (cfg.terms) S.termsText = cfg.terms;
    S.properRows = cfg.proper ?? [];
    if (cfg.instructions) S.appConfig.instructions = cfg.instructions;
    if (cfg.rewrite)
      S.rewriteRules = { replacements: cfg.rewrite.replacements ?? [], viewpoint: cfg.rewrite.viewpoint ?? 'keep', viewpointName: cfg.rewrite.viewpointName ?? '', extra: cfg.rewrite.extra ?? '' };
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
  if (!s) {
    setStatus('请先打开要导出的章节', 'err');
    return;
  }
  try {
    const body = splitChapter(s.md).body;
    const card = splitChapter(s.md).card;
    const paras = extractParas(body);
    const children: (Paragraph | Table)[] = [new Paragraph({ text: s.fileName.replace(/\.(md|txt|markdown)$/i, ''), heading: HeadingLevel.HEADING_1 })];
    for (let i = 0; i < paras.length; i++) {
      const text = applyRewrite(sentsOf(paras[i], false).join(' ').replace(/\s+/g, ' ').trim());
      if (text) children.push(new Paragraph({ children: [new TextRun({ text, size: 22, font: 'Georgia' })], spacing: { after: 100, line: 300, lineRule: 'auto' } }));
    }
    const rows = card.split('\n').filter((l) => l.trim().startsWith('|') && !/^\|[\s:-]+\|$/.test(l.trim()));
    if (rows.length >= 2) {
      children.push(new Paragraph({ text: '词句卡', heading: HeadingLevel.HEADING_2, pageBreakBefore: true }));
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: rows.map((r) => {
            const cells = r
              .trim()
              .replace(/^\|+|\|+$/g, '')
              .split('|')
              .map((c) => c.trim());
            return new TableRow({
              children: cells.map((c) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: c, size: 20 })] })] })),
            });
          }),
        }),
      );
    }
    const doc = new Document({
      sections: [
        {
          children,
          properties: {
            // 紧凑默认版式：A4 上下 1.5cm 左右 1.8cm，正文 11pt、1.25 倍行距、段后 5pt——打印省纸，屏读不挤
            page: { margin: { top: 850, bottom: 850, left: 1021, right: 1021 } },
          },
        },
      ],
    });
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
  if (!s) {
    setStatus('请先打开章节', 'err');
    return;
  }
  try {
    const text = applyRewrite(
      extractParas(splitChapter(s.md).body)
        .map((p) => sentsOf(p, false).join(' '))
        .join('\n')
        .replace(/\[[P\d\s]*?\]/g, '')
        .trim(),
    );
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

/* ---------- 版本对比（渲染实现已抽至 widgets.ts renderDiffPane，可 DOM 级测试） ---------- */

function renderDiff(lIdx: number, rIdx: number): void {
  renderDiffPane($('pane-diff'), S.sessions, lIdx, rIdx, (l, r) => renderDiff(l, r));
}

/* ---------- 双栏逐句对照（基准版 vs 当前章：行对行 + 信号丢失机器核对） ---------- */

/** 把章节 md 展开为句序列（带段落/句子索引，与正文标记同坐标系） */
function chapterSents(md: string): { pi: number; si: number; text: string }[] {
  try {
    return extractParas(splitChapter(md).body).flatMap((p, pi) => sentsOf(p, false).map((text, si) => ({ pi, si, text })));
  } catch {
    return [];
  }
}

function renderAlignPane(): void {
  const pane = $('pane-align');
  const s = activeSession();
  if (!s) {
    pane.innerHTML = '<div class="empty">先打开当前章，再回来选基准版本对照</div>';
    return;
  }
  const others = S.sessions.filter((x) => x !== s);
  const base = S.alignBase;
  const baseSents = base ? chapterSents(base.md) : [];
  const curSents = chapterSents(s.md);
  const rows = base && baseSents.length && curSents.length ? alignSentencePairs(baseSents, curSents) : [];
  const lost = rows.filter((r) => r.kind === 'lost').length;
  const added = rows.filter((r) => r.kind === 'added').length;
  const sigN = rows.reduce((n, r) => n + (r.lostSignals?.length ?? 0), 0);

  const rowsHtml = rows
    .map((r) => {
      const pos = (x?: { pi: number; si: number }) => `<span class="al-pos">P${String((x?.pi ?? 0) + 1).padStart(2, '0')}·${String((x?.si ?? 0) + 1).padStart(2, '0')}</span>`;
      if (r.kind === 'match') {
        return `<div class="align-pair">
          <div class="al-side base">${pos(r.base)}${esc(r.base?.text ?? '')}</div>
          <div class="al-side cur${r.lostSignals ? ' warn' : ''}">${pos(r.cur)}${esc(r.cur?.text ?? '')}${r.lostSignals ? `<span class="al-sig">⚠︎ 基准有此处无：${esc(r.lostSignals.join('、'))}</span>` : ''}</div>
        </div>`;
      }
      if (r.kind === 'lost') {
        return `<div class="align-pair">
          <div class="al-side lost">${pos(r.base)}${esc(r.base?.text ?? '')}<span class="al-sig">⚠︎ 当前章没有对应句（疑似丢信息）</span></div>
          <div class="al-side none">（无对应句）</div>
        </div>`;
      }
      return `<div class="align-pair">
        <div class="al-side none">（无对应句）</div>
        <div class="al-side added">${pos(r.cur)}${esc(r.cur?.text ?? '')}<span class="al-sig">＋ 当前章新增（对照基准）</span></div>
      </div>`;
    })
    .join('');

  pane.innerHTML = `
    <div class="align-bar">
      <b><svg class="ico"><use href="#i-columns"/></svg>逐句对照</b>
      <span class="dim" style="font-size:12px">基准</span>
      <select id="align-base">
        ${others.length ? others.map((x, i) => `<option value="s${i}">${esc(x.fileName)}（已打开）</option>`).join('') : ''}
        <option value="file">选文件…（默认定位当前章目录）</option>
        ${base ? `<option value="clear">✕ 关闭对照</option>` : ''}
      </select>
      ${rows.length ? `<span class="align-stats">对齐 ${rows.length} 句 · <span style="color:var(--oov)">疑似丢句 ${lost}</span> · <span style="color:#b45309">信号缺失 ${sigN} 处</span> · 新增 ${added}</span>` : ''}
    </div>
    ${rows.length ? `<div class="align-grid">${rowsHtml}</div>` : `<div class="empty">${base ? '基准或当前章解析不出句子（需要章节标记格式）' : others.length ? '从上面选一个已打开的版本做基准（建议先打开原文那一章），或选文件' : '先再打开一个版本（如原文）做基准——「打开文件…」选原文章节，然后回来这里下拉选它；或直接「选文件…」'}</div>`}`;
  const sel = pane.querySelector('#align-base') as HTMLSelectElement | null;
  sel?.addEventListener('change', async () => {
    const v = sel.value;
    if (v === 'clear') {
      S.alignBase = null;
      renderAlignPane();
      return;
    }
    if (v === 'file') {
      const path = await openFileDialog({
        multiple: false,
        defaultPath: s.sourcePath ?? undefined,
        filters: [{ name: '基准章节（Markdown / 文本 / Word）', extensions: ['md', 'txt', 'markdown', 'docx'] }],
      });
      if (typeof path !== 'string' || !path) {
        renderAlignPane();
        return;
      }
      try {
        const raw = path.toLowerCase().endsWith('.docx') ? docxToText(await invoke<string>('read_file_base64', { path })) : await readTextSmart(path);
        const { chapters } = normalizeAndSplitChapters(raw, path.slice(path.lastIndexOf('/') + 1));
        S.alignBase = { name: path.slice(path.lastIndexOf('/') + 1), md: chapters[0]?.md ?? raw, path };
        setStatus(`对照基准已设：${S.alignBase.name}`, 'saved');
      } catch (e) {
        setStatus('基准文件读取失败：' + e, 'err');
      }
      renderAlignPane();
      return;
    }
    if (v.startsWith('s')) {
      const other = others[Number(v.slice(1))];
      if (other) {
        S.alignBase = { name: other.fileName, md: other.md, path: other.sourcePath };
        renderAlignPane();
      }
    }
  });
}

/* ================= 书级审校看板（一张表看懂还剩多少活） ================= */

/** 读一章的审校标记 JSON（无文件返回 null——未审不报错） */
async function readReviewJson(chapterPath: string): Promise<{ marks?: unknown[]; bookmarks?: unknown[]; gate?: Record<string, boolean> } | null> {
  try {
    const base = chapterPath.slice(chapterPath.lastIndexOf('/') + 1).replace(/\.(md|txt|markdown|docx)$/i, '');
    const j = JSON.parse(await invoke<string>('read_text_file', { path: `${chapterPath.slice(0, chapterPath.lastIndexOf('/'))}/${base}_审校标记.json` }));
    return j as { marks?: unknown[]; bookmarks?: unknown[]; gate?: Record<string, boolean> };
  } catch {
    return null;
  }
}

/** 本章台账行（宽松匹配：章名互相包含或路径包含） */
function ledgerOf(ledger: LedgerRow[], 章: string, path: string): LedgerRow[] {
  return ledger.filter((r) => r.chapter && (章.includes(r.chapter) || r.chapter.includes(章) || path.includes(r.chapter)));
}

async function renderBoardPane(): Promise<void> {
  const pane = $('pane-board');
  const s = activeSession();
  const chapters = await tocChapters();
  if (chapters.length === 0) {
    pane.innerHTML = '<div class="empty">从书架进入一本书，这里显示全书审校看板</div>';
    return;
  }
  const ledger = await readLedger();
  const cur = s?.sourcePath ?? null;
  const rows: { path: string; 章: string; 门禁勾选: number; 门禁总数: number; 标记数: number; 书签数: number; 生词率: number | null; 建议数: number; 采纳数: number; 当前: boolean }[] = [];
  for (const f of chapters) {
    const r = await readReviewJson(f);
    const gates = r?.gate ? Object.values(r.gate).filter(Boolean).length : 0;
    let rate: number | null = null;
    if (f === cur && s?.report) rate = s.report.newWordRate;
    else {
      try {
        rate = runQc(await invoke<string>('read_text_file', { path: f }), buildLexiconNow(), { tier: 'M', fileName: '' }).newWordRate;
      } catch {
        /* 文件读不了留空 */
      }
    }
    const mine = ledgerOf(ledger, workspaceChipName(f), f);
    rows.push({
      path: f,
      章: workspaceChipName(f),
      门禁勾选: gates,
      门禁总数: GATES.length,
      标记数: r?.marks?.length ?? 0,
      书签数: r?.bookmarks?.length ?? 0,
      生词率: rate,
      建议数: mine.length,
      采纳数: mine.filter((x) => x.outcome === '采纳' || x.outcome === '直改').length,
      当前: f === cur,
    });
  }
  const sum = boardSummary(rows);
  pane.innerHTML = `
    <div class="retro-cards">
      <div class="retro-card"><div class="retro-num">${esc(sum.过门禁)}</div><div class="retro-label">终审门禁通过</div><div class="retro-hint">四项全勾才算过</div></div>
      <div class="retro-card"><div class="retro-num">${esc(sum.平均生词率)}</div><div class="retro-label">平均生词率</div><div class="retro-hint">全书各章当前稿</div></div>
      <div class="retro-card"><div class="retro-num">${sum.总标记}</div><div class="retro-label">未结标记总数</div><div class="retro-hint">正文点词/划句所做</div></div>
      <div class="retro-card"><div class="retro-num">${esc(sum.采纳率)}</div><div class="retro-label">AI 建议采纳率</div><div class="retro-hint">台账统计（采纳+直改）</div></div>
    </div>
    <table class="sgtable">
      <tr><th>章</th><th>门禁</th><th>标记</th><th>书签</th><th>生词率</th><th>建议（采纳）</th></tr>
      ${rows
        .map(
          (r) => `<tr class="board-row" data-bpath="${esc(r.path)}" style="cursor:pointer;${r.当前 ? 'outline:1px solid var(--accent);outline-offset:-1px' : ''}">
        <td>${esc(r.章)}${r.当前 ? ' <span class="shelf-badge">当前</span>' : ''}</td>
        <td>${r.门禁勾选 === r.门禁总数 && r.门禁总数 > 0 ? '<span style="color:#16a34a">✓ 通过</span>' : `${r.门禁勾选}/${r.门禁总数}`}</td>
        <td>${r.标记数}</td>
        <td>${r.书签数}</td>
        <td>${r.生词率 === null ? '—' : (r.生词率 * 100).toFixed(1) + '%'}</td>
        <td>${r.建议数 ? `${r.建议数}（${r.采纳数}）` : '—'}</td>
      </tr>`,
        )
        .join('')}
    </table>`;
  pane.querySelectorAll<HTMLElement>('[data-bpath]').forEach((tr) =>
    tr.addEventListener('click', () => {
      const f = tr.dataset.bpath!;
      openPathIntoSession(f)
        .then(() => setStatus(`已打开：${workspaceChipName(f)}`, 'saved'))
        .catch((e) => setStatus('打开失败：' + e, 'err'));
    }),
  );
}

/** 书目录台账（AI建议台账.csv；无则空表） */
async function readLedger(): Promise<LedgerRow[]> {
  if (!S.currentBookDir) return [];
  try {
    return parseLedger(await invoke<string>('read_text_file', { path: `${S.currentBookDir}/AI建议台账.csv` }));
  } catch {
    return [];
  }
}

/* ================= 审校过程档案（论文素材自动成卷） ================= */

/** 当前章档案数据（基准=对照页所选 alignBase；无基准跳过对照节） */
async function buildCurrentDossier(): Promise<DossierData | null> {
  const s = activeSession();
  if (!s?.sourcePath) return null;
  const qcLite = (md: string): QcSummaryLite => {
    const r = runQc(md, buildLexiconNow(), { tier: 'M', fileName: s.fileName });
    return { newWordRate: r.newWordRate, avgLen: r.avgLenNarrRaw, sentCount: r.sentCount, passive: r.passive, relcl: r.relcl, pastperf: r.pastperf, oovCount: new Set(r.oov).size };
  };
  const ledger = (await readLedger()).filter((x) => x.chapter && (s.fileName.includes(x.chapter) || x.chapter.includes(workspaceChipName(s.sourcePath!)) || s.sourcePath!.includes(x.chapter)));
  const byType = new Map<string, number>();
  for (const m of s.review.marks) byType.set(typeLabel(m.type), (byType.get(typeLabel(m.type)) ?? 0) + 1);
  const data: DossierData = {
    书名: S.currentBookDir?.split('/').pop() ?? '未命名书',
    章名: workspaceChipName(s.sourcePath),
    版本: S.activeWorkspace ?? '',
    生成时间: new Date().toLocaleString('zh-CN'),
    句长上限: simplifyMaxLen(),
    当前摘要: qcLite(s.md),
    台账: ledger.map((x) => ({ ts: x.ts, markType: x.markType, outcome: x.outcome, original: x.original, revised: x.revised, basis: x.basis })),
    标记: [...byType.entries()].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n),
    门禁: Object.fromEntries(GATES.map((g) => [g, s.review.gate[g] === true])),
  };
  if (S.alignBase) {
    const baseSents = chapterSents(S.alignBase.md);
    const curSents = chapterSents(s.md);
    if (baseSents.length && curSents.length) {
      const rows = alignSentencePairs(baseSents, curSents);
      data.基准摘要 = qcLite(S.alignBase.md);
      data.对照 = {
        对齐: rows.filter((r) => r.kind === 'match').length,
        丢句: rows
          .filter((r) => r.kind === 'lost')
          .map((r) => ({ pos: `P${String((r.base?.pi ?? 0) + 1).padStart(2, '0')}·${String((r.base?.si ?? 0) + 1).padStart(2, '0')}`, base: r.base?.text ?? '', lost: r.lostSignals ?? [] })),
        信号缺失: rows
          .filter((r) => r.kind === 'match' && r.lostSignals?.length)
          .map((r) => ({ pos: `P${String((r.cur?.pi ?? 0) + 1).padStart(2, '0')}·${String((r.cur?.si ?? 0) + 1).padStart(2, '0')}`, cur: r.cur?.text ?? '', lost: r.lostSignals ?? [] })),
        新增: rows.filter((r) => r.kind === 'added').map((r) => r.cur?.text ?? ''),
      };
    }
  }
  return data;
}

async function renderDossierPane(): Promise<void> {
  const pane = $('pane-dossier');
  const s = activeSession();
  if (!s) {
    pane.innerHTML = '<div class="empty">先打开一章，这里汇总它的审校过程并导出档案</div>';
    return;
  }
  const d = await buildCurrentDossier();
  if (!d) {
    pane.innerHTML = '<div class="empty">当前为示例章节（无书目录上下文），档案只对书稿章节生成</div>';
    return;
  }
  const pct = (v: number): string => (v * 100).toFixed(1) + '%';
  const hasBase = d.基准摘要 !== undefined;
  pane.innerHTML = `
    <div class="align-bar">
      <b><svg class="ico"><use href="#i-doc"/></svg>审校档案</b>
      <span class="dim" style="font-size:12px">${esc(d.书名)} · ${esc(d.章名)}${d.版本 ? ' · ' + esc(d.版本) : ''}${hasBase ? ' · 基准已选（对照与指标含基准列）' : ' · <span style="color:var(--pending)">未选基准：去「逐句对照」选一个基准版本，档案会多出指标对照与丢句明细</span>'}</span>
      <span style="flex:1"></span>
      <button id="dos-export-ch" class="primary"><svg class="ico"><use href="#i-doc"/></svg>导出本章档案</button>
      <button id="dos-export-book"><svg class="ico"><use href="#i-books"/></svg>导出全书档案</button>
    </div>
    <table class="sgtable">
      <tr><th>指标</th>${hasBase ? '<th>基准版</th>' : ''}<th>当前版</th></tr>
      <tr><td>② 生词率</td>${hasBase ? `<td>${pct(d.基准摘要!.newWordRate)}</td>` : ''}<td>${pct(d.当前摘要.newWordRate)}</td></tr>
      <tr><td>③ 平均句长</td>${hasBase ? `<td>${d.基准摘要!.avgLen.toFixed(1)}</td>` : ''}<td>${d.当前摘要.avgLen.toFixed(1)}</td></tr>
      <tr><td>⑤ 被动句</td>${hasBase ? `<td>${d.基准摘要!.passive}</td>` : ''}<td>${d.当前摘要.passive}</td></tr>
      <tr><td>⑥ 定语从句</td>${hasBase ? `<td>${d.基准摘要!.relcl}</td>` : ''}<td>${d.当前摘要.relcl}</td></tr>
      <tr><td>⑦ 过去完成</td>${hasBase ? `<td>${d.基准摘要!.pastperf}</td>` : ''}<td>${d.当前摘要.pastperf}</td></tr>
    </table>
    ${d.对照 ? `<p class="dim" style="margin:10px 0 4px;font-size:12.5px">逐句对照：对齐 ${d.对照.对齐} 句 · <span style="color:var(--oov)">疑似丢句 ${d.对照.丢句.length}</span> · <span style="color:#b45309">信号缺失 ${d.对照.信号缺失.length} 处</span> · 新增 ${d.对照.新增.length}（明细见导出的 md）</p>` : ''}
    <p class="dim" style="margin:6px 0;font-size:12.5px">决策记录（台账）：${d.台账.length} 条${d.台账.length ? '（采纳 ' + d.台账.filter((x) => x.outcome === '采纳' || x.outcome === '直改').length + '）' : ''} ｜ 标记 ${d.标记.reduce((n, x) => n + x.n, 0)} 处 ｜ 门禁 ${Object.values(d.门禁).filter(Boolean).length}/${GATES.length}</p>`;
  pane.querySelector('#dos-export-ch')?.addEventListener('click', () => void exportChapterDossier(d));
  pane.querySelector('#dos-export-book')?.addEventListener('click', () => void exportBookDossier());
}

async function exportChapterDossier(d: DossierData): Promise<void> {
  if (!S.currentBookDir) return;
  try {
    const dir = `${S.currentBookDir}/审校档案`;
    const path = `${dir}/${dossierFileName(d.章名, new Date().toLocaleDateString('sv-SE'))}`;
    await invoke('write_text_file', { path, content: buildChapterDossierMd(d) });
    void invoke('reveal_path', { path });
    setStatus(`本章档案已导出：${path}`, 'saved');
  } catch (e) {
    setStatus('档案导出失败：' + e, 'err');
  }
}

/** 全书档案：各章（指标+台账+标记+门禁）串卷 + 头部汇总（对照节仅章档案有，全书不逐章对齐） */
async function exportBookDossier(): Promise<void> {
  if (!S.currentBookDir) return;
  try {
    const chapters = await tocChapters();
    if (chapters.length === 0) {
      setStatus('没有书上下文，无法生成全书档案', 'err');
      return;
    }
    const ledger = await readLedger();
    const parts: string[] = [];
    const boardRows: { path: string; 章: string; 门禁勾选: number; 门禁总数: number; 标记数: number; 书签数: number; 生词率: number | null; 建议数: number; 采纳数: number; 当前: boolean }[] = [];
    for (const f of chapters) {
      const md = await invoke<string>('read_text_file', { path: f });
      const r = runQc(md, buildLexiconNow(), { tier: 'M', fileName: f.slice(f.lastIndexOf('/') + 1) });
      const rv = await readReviewJson(f);
      const mine = ledgerOf(ledger, workspaceChipName(f), f);
      boardRows.push({
        path: f,
        章: workspaceChipName(f),
        门禁勾选: Object.values(rv?.gate ?? {}).filter(Boolean).length,
        门禁总数: GATES.length,
        标记数: rv?.marks?.length ?? 0,
        书签数: rv?.bookmarks?.length ?? 0,
        生词率: r.newWordRate,
        建议数: mine.length,
        采纳数: mine.filter((x) => x.outcome === '采纳' || x.outcome === '直改').length,
        当前: f === activeSession()?.sourcePath,
      });
      const byType = new Map<string, number>();
      for (const m of (rv?.marks as { type: string }[]) ?? []) byType.set(m.type, (byType.get(m.type) ?? 0) + 1);
      parts.push(
        buildChapterDossierMd({
          书名: S.currentBookDir!.split('/').pop() ?? '',
          章名: workspaceChipName(f),
          版本: S.activeWorkspace ?? '',
          生成时间: new Date().toLocaleString('zh-CN'),
          句长上限: simplifyMaxLen(),
          当前摘要: { newWordRate: r.newWordRate, avgLen: r.avgLenNarrRaw, sentCount: r.sentCount, passive: r.passive, relcl: r.relcl, pastperf: r.pastperf, oovCount: new Set(r.oov).size },
          台账: mine.map((x) => ({ ts: x.ts, markType: x.markType, outcome: x.outcome, original: x.original, revised: x.revised, basis: x.basis })),
          标记: [...byType.entries()].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n),
          门禁: Object.fromEntries(GATES.map((g) => [g, (rv?.gate?.[g] ?? false) === true])),
        }),
      );
    }
    const sum = boardSummary(boardRows);
    const head = `# 审校档案 · 全书 ·《${S.currentBookDir.split('/').pop() ?? ''}》\n\n生成：${new Date().toLocaleString('zh-CN')} ｜ 工具：LayerText 分层读\n\n**全书汇总**：终审门禁通过 ${sum.过门禁} 章 ｜ 平均生词率 ${sum.平均生词率} ｜ 标记 ${sum.总标记} 处 ｜ AI 建议采纳率 ${sum.采纳率}\n\n---\n\n`;
    const path = `${S.currentBookDir}/审校档案/审校档案_全书_${new Date().toLocaleDateString('sv-SE')}.md`;
    await invoke('write_text_file', { path, content: head + parts.join('\n\n---\n\n') });
    void invoke('reveal_path', { path });
    setStatus(`全书档案已导出（${chapters.length} 章）：${path}`, 'saved');
  } catch (e) {
    setStatus('全书档案导出失败：' + e, 'err');
  }
}

/* ---------- 新手导览（coach marks） ---------- */

const TOUR = [
  { sel: '#btn-open', title: '① 打开课文', text: '点「打开…」选你的书稿（Word 也可以，会自动转换）；菜单 文件 → 载入示例 可先看演示。打开后会<b>自动体检</b>。' },
  { sel: '#btn-run', title: '② 看体检结果', text: '体检报告里生词、难句一条条列着，<b>每条都能勾选处理</b>：生词勾"要简化/已学过"，难句勾"要改"。换了词库点这里重新算。' },
  { sel: '#reader', title: '③ 边读边标', text: '红色下划线是生词、淡红底是难句。点一个词、或拖选一句话，就能做标记。' },
  { sel: '#sidebar', title: '④ 收尾把关', text: '右侧是审校清单：要点配额（可让 AI 摘情节要点）、终审门禁、标记清单。四项门禁全勾，这一章就算审完。' },
];

function tourShow(i: number): void {
  S.tourIdx = i;
  const tip = $('tour-pop');
  if (i < 0 || i >= TOUR.length) {
    tip.classList.remove('open');
    $('tour-hl').style.display = 'none';
    void (async () => {
      S.appConfig.tourSeen = true;
      await saveConfig();
    })();
    return;
  }
  const step = TOUR[i];
  const el = document.querySelector(step.sel) as HTMLElement | null;
  if (!el) {
    tourShow(i + 1);
    return;
  }
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
  let body: string;
  try {
    body = splitChapter(s.md).body;
  } catch {
    return '正文解析失败';
  }
  for (const r of S.rewriteRules.replacements) {
    if (!r.from) continue;
    const esc = r.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const left = (body.match(new RegExp(`\\b${esc}\\b`, 'g')) ?? []).length;
    const used = (body.match(new RegExp(`\\b${r.to.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')) ?? []).length;
    out.push(left === 0 ? `✓ "${r.from}" → "${r.to}"：无残留（新词出现 ${used} 次）` : `✗ "${r.from}" 仍有 ${left} 处未替换（新词 "${r.to}" 出现 ${used} 次）——可点下方"对当前章节执行替换"由机器补齐`);
  }
  if (S.rewriteRules.viewpoint === 'first') {
    const he = (body.match(/\b(he|his|him|she|her)\b/gi) ?? []).length;
    const I = (body.match(/\b(I|my|me)\b/g) ?? []).length;
    out.push(`视角（第一人称）：第三人称代词 ${he} 处 / 第一人称 ${I} 处${he > I * 2 ? ' ⚠︎ 第一人称占比偏低，建议用「整章改写」按规则重写' : ''}`);
  }
  return out.length ? out.join('\n') : '尚未设置规则';
}

function saveRewriteToBook(): void {
  void (async () => {
    const s = activeSession();
    if (!s?.sourcePath) {
      setStatus('规则随本书保存——先打开本书章节', 'err');
      return;
    }
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
    S.rewriteRules.replacements = [...rewritePop.querySelectorAll('.rw-row')]
      .map((r) => ({
        from: (r.querySelector('.rw-from') as HTMLInputElement).value.trim(),
        to: (r.querySelector('.rw-to') as HTMLInputElement).value.trim(),
      }))
      .filter((r) => r.from);
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
  $('rw-save').addEventListener('click', () => {
    collect();
    saveRewriteToBook();
  });
  $('rw-check').addEventListener('click', () => {
    collect();
    $('rw-out').textContent = rewriteCheck();
  });
  $('rw-apply').addEventListener('click', () => {
    collect();
    const s = activeSession();
    if (!s) return;
    const before = s.md;
    s.md = applyRewrite(s.md);
    if (s.md === before) {
      $('rw-out').textContent = '无可替换内容（或原词已清零）';
      return;
    }
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
      <div class="pop-h" style="font-size:17px">欢迎使用 LayerText 分层读</div>
      <p style="margin:8px 0 4px;line-height:1.8">这是帮你把英文原著<strong>简化成学生能读的版本</strong>的工具（简化到什么程度由你的词库决定）。先花一分钟完成初始设置：</p>
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
      <p class="dim">AI 负责"帮改写"：整章改写、按标记修改、对话助手。没 Key？点菜单 帮助 → 如何获取 AI 的 Key（教程 2 分钟）。也可以现在跳过，以后在菜单 LayerText → AI 设置 配。</p>
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
      if (!key) {
        out.textContent = '还没填 Key——填了再保存，或点"跳过"';
        return;
      }
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
      setStatus('设置完成！从书架选一本书，或点「打开…」开始', 'saved');
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
      description:
        '【直接编辑】仅当教师开启信任模式且明确要求"直接改"时使用：核对原句后直接替换正文（自动落工作稿与变更日志，原稿不动）。original 需与正文原句一致（空格差异可容忍，句末标点必须带上）',
      parameters: {
        type: 'object',
        properties: {
          original: { type: 'string' },
          revised: { type: 'string' },
          basis: { type: 'string' },
          markId: { type: 'string' },
        },
        required: ['original', 'revised', 'basis'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_revision',
      description: '把一条修订候选提交到「修订建议」页（教师仍需逐条勾选确认才会应用）。original 需与正文原句一致（空格差异可容忍，句末标点必须带上）',
      parameters: {
        type: 'object',
        properties: {
          original: { type: 'string' },
          revised: { type: 'string' },
          basis: { type: 'string' },
          markId: { type: 'string' },
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
  try {
    args = JSON.parse(argsJson || '{}');
  } catch {
    /* 空 */
  }
  try {
    switch (name) {
      case 'list_marks':
        if (s.review.marks.length === 0) return '（无标记）';
        return s.review.marks.map((m) => `${m.id}｜${m.level === 'word' ? `词「${m.word}」` : `句`}｜${typeLabel(m.type)}｜P${m.pi + 1}-S${m.si + 1}${m.note ? '｜备注：' + m.note : ''}`).join('\n');
      case 'get_chapter_stats': {
        const r = runQc(s.md, buildLexiconNow(), { tier: 'M', fileName: s.fileName, chno: s.sourcePath ? chnoFromPath(s.sourcePath) : null });
        s.report = r;
        renderReportPane(s);
        return JSON.stringify({
          句长上限标准: simplifyMaxLen(),
          段落数: r.paraCount,
          句数: r.sentCount,
          词符数: r.tokenCount,
          覆盖率: (r.coverage * 100).toFixed(1) + '%',
          生词率: (r.newWordRate * 100).toFixed(1) + '%',
          平均句长: Number(r.avgLenNarrRaw.toFixed(1)),
          最长句: r.maxLen,
          超20词句数: r.over20,
          被动: r.passive,
          定语从句: r.relcl,
          过去完成: r.pastperf,
          待定词命中: r.pendingHits,
          OOV前20: [...new Set(r.oov)].slice(0, 20),
        });
      }
      case 'get_sentence': {
        const paras = extractParas(splitChapter(s.md).body);
        const sent = sentsOf(paras[Number(args.pi)] ?? '', false)[Number(args.si)];
        if (!sent) return `错误：P${Number(args.pi) + 1}-S${Number(args.si) + 1} 不存在`;
        const risk = sentenceRisks(sent, simplifyMaxLen());
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
        let original = String(args.original ?? '');
        const revised = String(args.revised ?? '');
        const basis = String(args.basis ?? '');
        if (!original || !revised) return '错误：original/revised 不能为空';
        const flex = findOriginalFlex(s.md, original);
        if (!flex) return '错误：original 与正文不匹配——先用 search_text / get_sentence 取原句逐字复制（句末标点要带上）';
        original = flex.exact; // 以正文原文为准：容忍 AI 多打/漏打空格（欠账#2）
        const risk = checkRev(revised);
        const loc = locateSent(s, original);
        const g: Suggestion = {
          markId: String(args.markId ?? 'edit-' + Date.now().toString(36)),
          type: '直接编辑',
          original,
          revised,
          basis,
          status: 'pending',
          check: { passive: risk.passive, relcl: risk.relcl, pastperf: risk.pastperf, overlong: risk.overlong },
          ...(loc ? { pi: loc.pi, si: loc.si } : {}),
        };
        S.suggestions.push(g);
        renderSuggestions();
        await acceptSuggestion(g, { scene: '助手直改', outcome: '直改' });
        return `已直接应用并写入工作稿（引擎复核：${risk.passive || risk.relcl || risk.pastperf || risk.overlong ? '仍命中黑名单/超长，建议教师复核' : '通过'}）。正文已实时更新。`;
      }
      case 'propose_revision': {
        let original = String(args.original ?? '');
        const revised = String(args.revised ?? '');
        if (!original || !revised) return '错误：original/revised 不能为空';
        const flex = findOriginalFlex(s.md, original);
        if (!flex) return '错误：original 与正文不匹配（须与正文原句一致，句末标点要带上），请先用 get_sentence/search_text 取原句';
        original = flex.exact; // 空白差异容忍（欠账#2）：以正文原文为准，避免 AI 因空格反复重试
        const risk = checkRev(revised);
        S.suggestions.push({
          markId: String(args.markId ?? 'chat-' + Date.now().toString(36)),
          type: '对话建议',
          original,
          revised,
          basis: String(args.basis ?? ''),
          check: { passive: risk.passive, relcl: risk.relcl, pastperf: risk.pastperf, overlong: risk.overlong },
        });
        renderSuggestions();
        attachInlineSuggestions();
        setStatus('AI 在对话中提交了 1 条修订候选（经引擎复核）——正文黄色区域点 ✓ 采纳', 'saved');
        return `已提交到修订建议页（引擎复核：${risk.passive || risk.relcl || risk.pastperf || risk.overlong ? '仍命中黑名单/超长，已标⚠︎' : '通过'}）。提醒教师勾选确认。`;
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
              .map(
                (t) =>
                  `<div class="chat-tool"><svg class="ico sm"><use href="#i-wrench"/></svg>${esc(t.function.name)}(${esc(t.function.arguments.slice(0, 60))}${t.function.arguments.length > 60 ? '…' : ''})</div>`,
              )
              .join('');
            return `<div class="chat-msg assistant">${toolsHtml}<div class="bubble" ${m.content === '' ? 'id="chat-cur"' : ''}>${esc(m.content)}</div></div>`;
          })
          .join('');
  log.scrollTop = log.scrollHeight;
}

async function sendChat(): Promise<void> {
  if (S.chatBusy) return;
  const s = activeSession();
  if (!s) {
    setStatus('请先打开章节再与 AI 交流', 'err');
    return;
  }
  const input = $('chat-input') as HTMLTextAreaElement;
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  const key = await invoke<string>('load_api_key');
  if (!key) {
    setStatus('请先配置 AI（菜单 LayerText → AI 设置…）', 'err');
    showAiSettings();
    return;
  }

  S.chatBusy = true;
  ($('chat-send') as unknown as HTMLButtonElement).disabled = true;
  S.chatMsgs.push({ role: 'user', content: text });
  chatRender();
  const statusEl = $('chat-status');
  let usageTotal = '';

  try {
    const system =
      (await buildSystemPrompt()) +
      (await buildAssistantPrompt({
        submitRule: S.appConfig.trustEdit
          ? '信任模式已开启——教师说"直接改/改吧"时用 apply_edit 直接应用（自动落工作稿与变更日志，原稿不动）；教师说"给建议/看看"时仍用 propose_revision'
          : '教师未开启信任模式，一律用 propose_revision 提交候选，由教师在界面点 ✓ 采纳',
        fileName: s.fileName,
        markCount: s.review.marks.length,
      }));
    for (let round = 0; round < 8; round++) {
      const messages = [{ role: 'system', content: system }, ...S.chatMsgs];
      statusEl.textContent = round === 0 ? '思考中…' : `工具结果已回传，继续（第 ${round + 1} 轮）…`;
      const { content, reasoning, toolCalls, usage } = await chatStream(messages, AI_TOOLS, (delta) => {
        const cur = document.getElementById('chat-cur');
        if (cur) cur.textContent += delta;
        const log = $('chat-log');
        log.scrollTop = log.scrollHeight;
      });
      usageTotal = usage;
      S.chatMsgs.push({
        role: 'assistant',
        content,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        tool_calls: toolCalls.length ? toolCalls.map((t) => ({ id: t.id, type: 'function' as const, function: { name: t.name, arguments: t.arguments } })) : undefined,
      });
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
    void maybeCompactChat();
  } catch (e) {
    statusEl.textContent = '出错：' + e;
  } finally {
    S.chatBusy = false;
    ($('chat-send') as unknown as HTMLButtonElement).disabled = false;
  }
}

$('chat-send').addEventListener('click', () => void sendChat());
$('chat-clear').addEventListener('click', () => {
  S.chatMsgs = [];
  chatRender();
  scheduleChatSave();
  setStatus('AI 对话已清空', '');
});
$('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void sendChat();
});

/* ---------- 对话历史自动压缩（欠账#1：长对话越滚越贵越慢；超限后旧轮摘要化，要点不丢） ---------- */

async function maybeCompactChat(): Promise<void> {
  const plan = planCompaction(S.chatMsgs);
  if (!plan.need || S.chatBusy) return;
  const snapLen = S.chatMsgs.length;
  try {
    const transcript = S.chatMsgs
      .slice(0, plan.keptFrom)
      .filter((m) => m.role !== 'tool')
      .map((m) => `${m.role === 'user' ? '教师' : 'AI'}：${m.content.slice(0, 500)}`)
      .join('\n');
    const { content } = await callChat(
      [
        {
          role: 'system',
          content:
            '你是审校对话记录压缩器。把下面的对话历史压缩成要点摘要，必须保留：教师的每个核心要求、已经做过的修改（哪句改成了什么）、教师否决过什么、关键结论与未完成事项。用中文列点，300 字以内，不要寒暄。',
        },
        { role: 'user', content: transcript },
      ],
      700,
      undefined,
      '对话压缩',
    );
    if (S.chatBusy || S.chatMsgs.length !== snapLen) return; // 压缩期间教师又发话，放弃本次（下次再压）
    const userTurns = S.chatMsgs.slice(0, plan.keptFrom).filter((m) => m.role === 'user').length;
    S.chatMsgs = [{ role: 'user', content: `（系统提示：此前 ${userTurns} 轮对话较长，已自动压缩为以下摘要，请基于摘要继续回答：\n${content.trim()}）` }, ...S.chatMsgs.slice(plan.keptFrom)];
    chatRender();
    scheduleChatSave();
    const estAfter = plan.estTail + estTokens(content) + 80;
    setStatus(`✓ 对话历史已自动压缩：约 ${plan.estBefore} → ${estAfter} tokens（旧轮要点保留在摘要里，不影响回答质量）`, 'saved');
  } catch {
    /* 压缩失败不影响使用，留待下次 */
  }
}

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
    const maxLen = simplifyMaxLen();
    if (s?.report) {
      const r = s.report;
      const row = (name: string, value: string, ref: string, warn = false) => `<tr class="${warn ? 'warnrow' : ''}"><td>${name}</td><td>${value}</td><td>${ref}</td></tr>`;
      body += `
        <table class="gtable">
          <tr><th>指标</th><th>本章实际</th><th>参考</th></tr>
          ${row('词表覆盖率', (r.coverage * 100).toFixed(1) + '%', '越接近词库上限越好')}
          ${row('生词率（词型）', (r.newWordRate * 100).toFixed(1) + '%', '越低越好')}
          ${row('平均句长', r.avgLenNarrRaw.toFixed(1) + ' 词', `≤ ${maxLen} 词（简化标准，ⓘ 可调）`, r.avgLenNarrRaw > maxLen)}
          ${row('单句最长', r.maxLen + ' 词', `≤ ${maxLen} 词`, r.maxLen > maxLen)}
          ${row(`超 ${maxLen} 词句数`, String(r.over20), '0（个别文学长句可人工放行）', r.over20 > 0)}
          ${row('被动式', String(r.passive), '0（一律禁用）', r.passive > 0)}
          ${row('定语从句', String(r.relcl), '0（一律禁用）', r.relcl > 0)}
          ${row('过去完成', String(r.pastperf), '0', r.pastperf > 0)}
          ${row('待定词命中', String(r.pendingHits), '逐个复核后定去留', r.pendingHits > 0)}
        </table>`;
    } else {
      body += `<p class="dim">本章尚未体检——打开课文会自动体检，或点「重新质检」。</p>`;
    }
    body += `<p class="dim">参考值即当前简化标准（句长上限 ⓘ 可调）；黄色行 = 超出参考，需你复核后决定。达标与否由你勾选确认（AI 只出数字，教师定稿）。</p>`;
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
  if (syncPop.classList.contains('open') && !(e.target as HTMLElement).closest('#sync-pop')) hideSyncPop();
});

/* ---------- 跨版本标记同步：同章多版本文件（同目录其他 md），词/短语级审校意图广播 ---------- */

const syncPop = $('sync-pop');

function hideSyncPop(): void {
  syncPop.classList.remove('open');
}

interface SyncTargetPlan {
  name: string;
  path: string;
  plan: SyncPlan;
}

/** 同步弹层：先给后果预告（每个版本建多少/跳过多少及原因），确认才写盘——正文不动，只同步"待办" */
async function showSyncMarksDialog(): Promise<void> {
  const s = activeSession();
  if (!s?.sourcePath) {
    setStatus('示例模式没有版本文件——从书架打开章节后使用', 'err');
    return;
  }
  const syncable = s.review.marks.filter((m) => m.level !== 'sent' && m.word);
  if (!syncable.length) {
    setStatus('本章还没有词/短语级标记（句级不跨版本同步——三版本句结构不同，句对不上）', 'err');
    return;
  }
  const dir = s.sourcePath.slice(0, s.sourcePath.lastIndexOf('/'));
  let names: string[];
  try {
    names = await invoke<string[]>('list_dir', { dir });
  } catch (e) {
    setStatus('读取章节目录失败：' + e, 'err');
    return;
  }
  const targets = names.filter((n) => /\.md$/i.test(n) && `${dir}/${n}` !== s.sourcePath).filter((n) => !/质检报告|审校档案|全书简化|基准|AI修订|分层初稿|工作稿|原始备份|词句卡/.test(n));
  const plans: SyncTargetPlan[] = [];
  for (const n of targets) {
    const path = `${dir}/${n}`;
    try {
      const md = await readTextSmart(path);
      let existing: Mark[] = [];
      try {
        const saved = await invoke<string>('read_text_file', { path: await markPathFor(path, n) });
        const parsed = JSON.parse(saved) as { marks?: Mark[] };
        if (Array.isArray(parsed.marks)) existing = parsed.marks;
      } catch {
        /* 目标还没有标记文件 */
      }
      plans.push({ name: n, path, plan: syncMarksToMd(syncable, md, existing, newMarkId) });
    } catch {
      /* 目标文件读不了就跳过 */
    }
  }
  if (!plans.length) {
    setStatus('同目录没找到可用的其他版本文件——同章多版本放同一文件夹即可同步', 'err');
    return;
  }
  const totalCreated = plans.reduce((n, p) => n + p.plan.totalCreated, 0);
  syncPop.innerHTML = `
    <div class="pop-h">同步本章标记到其他版本</div>
    <p>把当前版本（${esc(s.fileName)}）的 <b>${syncable.length} 条词/短语级标记</b> 同步到同目录其他版本——审校意图共用，各版本按自己的口径执行。句级标记不同步（三版本句结构不同）。</p>
    <table class="gtable">
      <tr><th>版本文件</th><th>将新建</th><th>跳过·已标过</th><th>跳过·目标无此词</th></tr>
      ${plans
        .map(
          (p) =>
            `<tr><td>${esc(p.name)}</td><td>${p.plan.totalCreated}</td><td>${p.plan.items.filter((i) => i.skipped === 'duplicate').length}</td><td>${p.plan.items.filter((i) => i.skipped === 'not-found').length}</td></tr>`,
        )
        .join('')}
    </table>
    <p class="dim">目标无此词 = 更简版本已把该词换掉或删掉（等于已处理），属正常；已标过 = 不重复建（幂等）。只同步标记待办，不改任何正文。</p>
    <div class="pop-btns" style="margin-top:10px">
      <button id="sync-go" class="primary">同步 ${totalCreated} 条标记</button>
      <button id="sync-cancel">取消</button>
    </div>`;
  syncPop.classList.add('open');
  const r = syncPop.getBoundingClientRect();
  syncPop.style.left = Math.max(8, (window.innerWidth - r.width) / 2) + 'px';
  syncPop.style.top = Math.max(8, (window.innerHeight - r.height) / 2) + 'px';
  $('sync-cancel').addEventListener('click', hideSyncPop);
  $('sync-go').addEventListener('click', async () => {
    let wrote = 0;
    let refreshed = 0;
    for (const p of plans) {
      if (!p.plan.totalCreated) continue;
      const created = p.plan.items.flatMap((i) => i.created);
      const sess = S.sessions.find((x) => x.sourcePath === p.path);
      if (sess) {
        sess.review.marks.push(...created);
        sess.review.updatedAt = Date.now();
        scheduleSave(sess, () => undefined);
        if (S.sessions[S.activeIdx] === sess) {
          renderSidebar(sess, sidebarHandlers);
          restoreAllMarkDom(sess);
          scheduleHeatRail();
          updateMarkBadge();
        }
        refreshed++;
      } else {
        const markPath = await markPathFor(p.path, p.name);
        const base = { file: p.name, marks: [] as Mark[], quota: [], gate: {}, bookmarks: [], updatedAt: Date.now() };
        let review = base;
        try {
          review = { ...base, ...(JSON.parse(await invoke<string>('read_text_file', { path: markPath })) as typeof base) };
        } catch {
          /* 新建标记文件 */
        }
        review.marks = [...(review.marks ?? []), ...created];
        review.updatedAt = Date.now();
        await invoke('write_text_file', { path: markPath, content: JSON.stringify(review, null, 1) });
        wrote++;
      }
    }
    hideSyncPop();
    toast(`已同步：${wrote} 个版本文件写入、${refreshed} 个已打开版本即时刷新`, 'ok');
    setStatus(`标记已同步（正文未动）——在各版本打开后点「按标记修改」按该版本口径执行`, 'saved');
  });
}

/* 正文词点击 → 词面板 */
$('reader').addEventListener('click', (e) => {
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return; // 拖选场景交给句面板
  const wEl = (e.target as HTMLElement).closest('.w');
  const s = activeSession();
  if (!wEl || !s) return;
  showWordPanel(s, wEl as HTMLElement, e.clientX + 8, e.clientY + 12);
});

/* 拖选 → 路由（选区即范围，无隐式判定）：跨句/整句=句面板；句内 ≥2 词=短语面板；单词=词面板 */
document.addEventListener('mouseup', (e) => {
  if ((e.target as HTMLElement).closest('#pop') || (e.target as HTMLElement).closest('#sidebar')) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return;
  const node = sel.focusNode;
  const host = node?.nodeType === 3 ? node.parentElement : (node as HTMLElement | null);
  const sentEl = host?.closest('.sent');
  const s = activeSession();
  if (!sentEl || !s) return;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  const anchorSent = (sel.anchorNode?.nodeType === 3 ? sel.anchorNode.parentElement : (sel.anchorNode as HTMLElement | null))?.closest('.sent');
  if (anchorSent !== sentEl) {
    showSentPanel(s, sentEl as HTMLElement, rect.left, rect.bottom + 6, true); // 跨句选择，仅标记所选末句
    return;
  }
  const pi = Number((sentEl as HTMLElement).dataset.pi);
  const si = Number((sentEl as HTMLElement).dataset.si);
  const sentText = sentsOf(extractParas(splitChapter(s.md).body)[pi] ?? '', false)[si] ?? '';
  const route = routeSelection(sel.toString(), sentText);
  if (route === 'sent') {
    showSentPanel(s, sentEl as HTMLElement, rect.left, rect.bottom + 6, false);
    return;
  }
  if (route === 'phrase') {
    showPhrasePanel(s, sentEl as HTMLElement, sel.getRangeAt(0), rect.left, rect.bottom + 6);
    return;
  }
  // 单词拖选 → 词面板（定位到选区内第一个词；选到纯标点等无词场景忽略）
  const wEl = [...(sentEl as HTMLElement).querySelectorAll<HTMLElement>('.w')].find((w) => sel.getRangeAt(0).intersectsNode(w));
  if (wEl) showWordPanel(s, wEl, rect.left, rect.bottom + 6);
});

/* 点击空白关闭面板 */
document.addEventListener('mousedown', (e) => {
  if ((e.target as HTMLElement).closest('#pop')) return;
  if (pop.classList.contains('open')) hidePop();
});
