/**
 * LayerText 分层读 · 审校工作台 v0.2
 * 多版本文件 tab → 三态高亮正文 → 点词/拖选句标记 → 侧栏（配额/门禁/清单）→ 标记自动落盘。
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open as openFileDialog, save as saveFileDialog } from '@tauri-apps/plugin-dialog';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import * as XLSX from 'xlsx';
import { unzipSync, strFromU8 } from 'fflate';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType } from 'docx';
import {
  applyRewriteTo,
  chnoFromPath,
  tagFromPath,
  csvCell,
  epubChapterMd,
  parseEpubChapters,
  mergeTargets,
  normalizeAndSplitChapters,
  parseAiJson,
  remapMarks,
  routeSelection,
  decodeAuto,
} from './pure.js';
import { renderModePill, switchView as switchViewDom, type ViewName } from './widgets.js';
import { S, esc } from './state.js';
import { $, setStatus, toast, pop, hidePop } from './uikit.js';
import { showSyncMarksDialog, syncPop, hideSyncPop } from './pipew.js';
import { aiSuggest, renderSuggestions, attachInlineSuggestions, logSuggestion, focusNextSuggestion, suggestionByEl, acceptSuggestion } from './aiflow.js';
import { showDraftPop, showBatchPop, closeDraftPop, closeBatchPop, batchPop } from './batch.js';
import { renderReportPane, renderDiff, renderAlignPane, renderBoardPane, renderDossierPane, renderRetroPane, exportDiagnostics, simulateError } from './report.js';
import { ensureClassGroups, toggleClsPanel, applyTheme, applyReaderLineHeight, applyReaderFont, stepTheme, stepReaderFont, toggleSettings, showStandardPop, showAiSettings, aiPop, tierPop } from './settings.js';
import { renderShelf, touchProgress, tocPanelEl, refreshToc, renderWorkspaceBar, backToShelf, toggleToc, closeToc, closeShelfCtxMenu, switchWorkspace, scheduleSaveLastSession, saveLastSession, loadWorkspaces } from './shelf.js';
import { renderReader, updateMarkBadge, sidebarHandlers, showWordPanel, showSentPanel, showPhrasePanel } from './reader.js';
import { restoreChat, chatRender, hideGatePop, gatePop } from './chat.js';
import {
  AI_PROVIDERS,
  aiErrHuman,
  callChat,
  loadConfig,
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
import { runQc, toLegacyReport } from '../../src/core/qc.js';
import { extractParas, sentsOf, splitChapter } from '../../src/core/textpipe.js';
import { renderSidebar, scheduleSave } from './review.js';
import {
  CHANGELOG_HEADER,
  GATES,
  newReviewState,
  type FileSession,
} from './types.js';

/* ---------- 全局状态 ---------- */

/** 专名表原始行（保留大小写与空格短语：既并入已知词，也作 ⑧ 专名一致性检查名单） */
/** 本地示例目录的附加词表（如原型项目的中考1600按词性分类表） */
/** 当前会话的合并已知词表（含词句卡），供词面板显示原形 */

/* ---------- 全局配置（~/.layertext.json：AI 设置 + 简化标准 + 首启动标记） ---------- */

/** 常见服务商预设（新手只需选服务商 + 贴 Key） */
export function buildLexiconNow(): Lexicon {
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
export function mergedSelection() {
  return mergeTargets(
    S.classTargets.filter((t) => S.selectedIds.includes(t.id)),
    simplifyMaxLen(),
  );
}

/** 已学词集（复现队列）：班级定制选择优先，其次示例/书目录 _已学词.csv|.txt；空则 undefined（报告保持旧 schema） */
export function reinforceWordsNow(): string[] | undefined {
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

export function activeSession(): FileSession | null {
  return S.activeIdx >= 0 ? S.sessions[S.activeIdx] : null;
}

/** 状态行只放"现在在哪"：文件名（班级口径生效时附带）。词库/复现等完整口径见 设置 弹层 */
export function fileSummary(): void {
  const s = activeSession();
  const sel = mergedSelection();
  setStatus(s ? `${s.fileName}${sel.active ? ` ｜ 班级 ${sel.label}` : ''}` : '');
}

/* ---------- 会话管理 ---------- */

export async function markPathFor(sourcePath: string | null, fileName: string): Promise<string> {
  if (sourcePath) {
    const dir = sourcePath.slice(0, sourcePath.lastIndexOf('/'));
    const base = fileName.replace(/\.(md|txt|markdown)$/i, '');
    return `${dir}/${base}_审校标记.json`;
  }
  const dir = await invoke<string>('reports_dir');
  return `${dir}/示例_审校标记.json`;
}

export async function addSession(md: string, fileName: string, sourcePath: string | null, opts: { noAutoQc?: boolean } = {}): Promise<void> {
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
export function syncChrome(): void {
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

export function renderAll(): void {
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

/** 改写生效的视觉反馈：新句子绿色高亮一闪 */
export function flashApplied(revised: string): void {
  const key = revised.slice(0, 30);
  const el = [...document.querySelectorAll('#reader .sent')].find((x) => (x.textContent ?? '').includes(key));
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('just-applied');
  void (el as HTMLElement).offsetWidth;
  el.classList.add('just-applied');
}

/** 请求直到解析出 JSON：若模型把整轮输出耗在思考上（无 [ 字符），自动追发"直接输出 JSON"再试一次 */
export async function chatUntilJson(messages: { role: string; content: string }[], maxTokens: number, scene: string): Promise<{ raw: unknown[]; usage: string }> {
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

/* ---------- 质检 ---------- */

export async function runQcCurrent(opts: { auto?: boolean } = {}): Promise<void> {
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


/* ---------- 最近编辑 ---------- */

async function pushRecent(fileName: string, sourcePath: string | null): Promise<void> {
  if (!sourcePath) return;
  const list: string[] = [sourcePath, ...(S.appConfig.recentFiles ?? []).filter((x) => x !== sourcePath)].slice(0, 10);
  S.appConfig.recentFiles = list;
  await saveConfig();
}

/* ---------- 视图切换（实现在 widgets.ts，可 DOM 级测试） ---------- */

export function switchView(name: ViewName): void {
  switchViewDom(document, name);
  syncChrome();
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

export function loadBuiltinDemo(): void {
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
export function docxToText(b64: string): string {
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
export async function readTextSmart(path: string): Promise<string> {
  const b64 = await invoke<string>('read_file_base64', { path });
  return decodeAuto(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

export async function openPathIntoSession(p: string): Promise<void> {
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
  if (outside('#draft-pop')) closeDraftPop();
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

document.addEventListener('mousedown', (e) => {
  if (aiPop.classList.contains('open') && !(e.target as HTMLElement).closest('#ai-pop')) aiPop.classList.remove('open');
});

/** 组装 system 提示词（含用户的长期审校约定 + 书级改写规则） */
/** 内置提示词模板：词库边界 + 句法黑名单 + 句长上限 + 方法论约束 */
/** 估算 token 的 estTokens 已抽至 pure.ts（对话压缩与请求预估共用口径） */

export const RULE_BY_TYPE: Record<string, string> = {
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
export async function appendCsvLine(path: string, header: readonly string[], line: string): Promise<void> {
  let csv = '';
  try {
    csv = await invoke<string>('read_text_file', { path });
  } catch {
    /* 新建 */
  }
  if (!csv.trim()) csv = header.join(',') + '\n';
  await invoke('write_text_file', { path, content: csv + line });
}

/* ---------- 行内修订对照（左栏所见即所得） ---------- */

/** 保存正文改动：默认直接写原稿文件（首次前自动备份原始版）；关闭"直接修改原稿"则写工作稿 */
export async function persistEdit(s: FileSession, newMd: string): Promise<string> {
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

/* ---------- 词面板：AI 改写本句 ---------- */

$('btn-ai').addEventListener('click', () => void aiSuggest());

document.addEventListener('mousedown', (e) => {
  if (batchPop.classList.contains('open') && !(e.target as HTMLElement).closest('#batch-pop')) closeBatchPop();
});

/* ---------- 修改模式胶囊：一眼可见、一键切换（即改=立即生效 / 候选=点✓生效） ---------- */
export function updateModePill(): void {
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

/* ---------- 学生视角预览：隐藏全部审校视觉，只看学生将读到的正文（含生词注释） ---------- */
$('btn-student').addEventListener('click', () => {
  const on = document.body.classList.toggle('student-view');
  toast(on ? '学生视角：已隐藏标记/风险/建议/段号——这是学生将读到的样子（生词注释保留）' : '已回到审校视角', 'info');
});

/* ---------- 启动序列：配置 → 首启动欢迎 ---------- */
setAiUi({ onStatus: (s) => setStatus(s, 'dirty') });

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

/* ---- 词库编辑器：教师词库词条 App 内增删（内置课标不动；保存到书目录 _词库.csv 即时生效） ---- */

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

/* ---- 建议键盘流：N 下一条 / Enter 采纳 / X 放弃（逐条过建议不碰鼠标） ---- */

/* uikit 解耦桥：总结面板"打开修订建议页"（uikit 不反向依赖 main） */
window.addEventListener('layertext:open-suggest', () => switchView('suggest'));

/* ---- 全局快捷键 ---- */
document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  // 键盘审校流：弹层数字键选标记 > ⌘数字切工作区 > F8/⌘G 跳难句（⇧⌘G 上一个）> N/Enter/X 建议流
  if (!mod && popHotkey(e.key)) {
    e.preventDefault();
    return;
  }
  if (!mod && !pop.classList.contains('open')) {
    const ae = document.activeElement;
    const typing = ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT');
    if (!typing && S.suggestions.length > 0) {
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        focusNextSuggestion(1);
        return;
      }
      const focused = document.querySelector<HTMLElement>('.inline-sug.focused');
      if (focused) {
        const g = suggestionByEl(focused);
        if (e.key === 'Enter' && g) {
          e.preventDefault();
          void (async () => {
            if (await acceptSuggestion(g, { scene: '键盘', outcome: '采纳' })) focusNextSuggestion(1);
          })();
          return;
        }
        if ((e.key === 'x' || e.key === 'X') && g) {
          e.preventDefault();
          g.status = 'rejected';
          focused.previousElementSibling?.classList.remove('sug-pending');
          focused.remove();
          S.suggestions = S.suggestions.filter((x) => x !== g);
          const s = activeSession();
          if (s) void logSuggestion(s, g, '拒绝', '键盘');
          renderSuggestions();
          focusNextSuggestion(1);
          return;
        }
      }
    }
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

export async function loadBookConfig(dir: string): Promise<boolean> {
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

export function bufToB64(buf: ArrayBuffer): string {
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

export function applyRewrite(text: string): string {
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

document.addEventListener('mousedown', (e) => {
  if (gatePop.classList.contains('open') && !(e.target as HTMLElement).closest('#gate-pop') && !(e.target as HTMLElement).closest('.qmark')) {
    hideGatePop();
  }
  if (syncPop.classList.contains('open') && !(e.target as HTMLElement).closest('#sync-pop')) hideSyncPop();
});

/* ---------- 跨版本标记同步：同章多版本文件（同目录其他 md），词/短语级审校意图广播 ---------- */

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
