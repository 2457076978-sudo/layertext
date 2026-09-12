/**
 * LayerText 分层读 · 审校工作台 v0.2
 * 多版本文件 tab → 三态高亮正文 → 点词/拖选句标记 → 侧栏（配额/门禁/清单）→ 标记自动落盘。
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open as openFileDialog, save as saveFileDialog } from '@tauri-apps/plugin-dialog';
import { unzipSync, strFromU8 } from 'fflate';
import { chnoFromPath, tagFromPath, normalizeAndSplitChapters, parseAiJson, routeSelection, decodeAuto } from './pure.js';
import { parseEpubChapters, epubChapterMd } from './bookpure.js';
import { renderModePill, switchView as switchViewDom, bindViewTabs, type ViewName } from './widgets.js';
import { findProjectConfig, io as panelIo, renderDataPane } from './datapanel.js';
import { teacherIdOf } from '../../src/core/teachers.js';
import { renderRiskPane, setRiskIo, TAGS as RISK_TAGS } from './risk.js';
import { S, esc } from './state.js';
import { $, setStatus, toast, pop, hidePop } from './uikit.js';
import { showSyncMarksDialog, syncPop, hideSyncPop } from './pipew.js';
import { aiSuggest, renderSuggestions, attachInlineSuggestions, logSuggestion, focusNextSuggestion, suggestionByEl, acceptSuggestion } from './aiflow.js';
import { showDraftPop, showBatchPop, closeDraftPop, closeBatchPop, batchPop } from './batch.js';
import { renderReportPane, renderDiff, renderAlignPane, renderBoardPane, renderDossierPane, renderRetroPane, exportDiagnostics, simulateError } from './report.js';
import {
  ensureClassGroups,
  toggleClsPanel,
  applyTheme,
  applyReaderLineHeight,
  applyReaderFont,
  stepTheme,
  stepReaderFont,
  toggleSettings,
  showStandardPop,
  showAiSettings,
  aiPop,
  tierPop,
  showWelcome,
  tourShow,
} from './settings.js';
import {
  renderShelf,
  touchProgress,
  tocPanelEl,
  refreshToc,
  renderWorkspaceBar,
  backToShelf,
  toggleToc,
  closeToc,
  closeShelfCtxMenu,
  switchWorkspace,
  scheduleSaveLastSession,
  saveLastSession,
  loadWorkspaces,
  alignWorkspaceToSession,
} from './shelf.js';
import { renderReader, updateMarkBadge, sidebarHandlers, showWordPanel, showSentPanel, showPhrasePanel } from './reader.js';
import { restoreChat, chatRender, hideGatePop, gatePop } from './chat.js';
import { saveBookConfig, loadBookConfig, exportDocx, exportTts, showRewritePop, showAnkiExport } from './bookio.js';
import { showGradingPop, showClassGradingPop } from './grading.js';
import { showRevPop } from './reviewgen.js';
import { scrollEl, scrollNow, doUndo, doRedo, openFind, closeFind, runFind, jumpFind, replaceAllFind, jumpNextRisk, popHotkey, resetRiskJump } from './edit.js';
import { buildLexiconNow, mergedSelection, reinforceWordsNow, importVocabFile, importTermsFile, importProperFile, loadLocalExampleConfig } from './lexicon.js';
import { callChat, loadConfig, saveConfig, setAiUi } from './ai.js';
import exampleMd from '../../examples/texts/aesop_tortoise_hare.md?raw';
import exampleVocab from '../../examples/vocab/sample_teaching_vocab.csv?raw';
import { runQc, toLegacyReport } from '../../src/core/qc.js';
import { extractParas, sentsOf, splitChapter } from '../../src/core/textpipe.js';
import { renderSidebar, scheduleSave } from './review.js';
import { GATES, newReviewState, type FileSession } from './types.js';

/* ---------- 全局状态 ---------- */

/** 专名表原始行（保留大小写与空格短语：既并入已知词，也作 ⑧ 专名一致性检查名单） */
/** 本地示例目录的附加词表（如原型项目的中考1600按词性分类表） */
/** 当前会话的合并已知词表（含词句卡），供词面板显示原形 */

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
    /* 有意兜底：这一章还没审过＝没有标记文件，是常态（`read_text_file` 对缺失文件是报错的）。 */
  }
  S.sessions.push({ md, fileName, sourcePath, markPath, review, report: null, reportSavedPath: null, dirty: false });
  S.activeIdx = S.sessions.length - 1;
  touchProgress(sourcePath); // 阅读进度记账（无书根上下文则跳过）
  resetRiskJump(); // 难句跳转索引随章复位
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
  // 传播感知：本版若有高层校正传播来的待办（origin 标识），打开时一次性明示——"做得好要看得见"
  const propCnt = review.marks.filter((m) => m.origin).length;
  if (propCnt) setTimeout(() => toast(`本版有 ${propCnt} 条校正待办自高层版本传播来（侧栏标记 ⇄ 标识，正文未动）`, 'info'), 800);
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
  const bookView = curView !== 'text';
  (document.querySelector('.viewtabs') as HTMLElement).style.display = !hasChapter && !bookView ? 'none' : 'flex';
}

export function renderAll(): void {
  renderFileTabs();
  const s = activeSession();
  if (!s) {
    switchView('text'); // 回正文窗格=书架首页（清掉残留的书级视图；经唯一入口同步 curView）
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
  alignWorkspaceToSession(); // 正文属于哪个工作区，目录/班级口径就跟着哪个（切标签/恢复会话后重新对齐）
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
    .map(
      (s, i) =>
        `<span class="ftab ${i === S.activeIdx ? 'active' : ''}" data-ftab="${i}"><span class="ftab-label" title="${esc(s.sourcePath ?? s.fileName)}">${esc(
          (s.sourcePath
            ?.split('/')
            .slice(0, -1)
            .reverse()
            .find((part) => /^第.+章$/.test(part)) ?? '') +
            ' · ' +
            s.fileName.replace(/_\d{4}-\d{2}-\d{2}/g, '').replace(/\.md$/i, ''),
        )}</span><span class="x" data-ftab-close="${i}" title="关闭">×</span></span>`,
    )
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

/* ---------- 视图切换（实现在 widgets.ts，可 DOM 级测试）——唯一入口：钩子（懒渲染）+ 切换 + chrome 同步 ---------- */

/** 进入各视图的懒渲染钩子（原分散在 8 个 tab 绑定里，收敛到唯一入口） */
const VIEW_HOOKS: Partial<Record<ViewName, () => void>> = {
  diff: () => renderDiff(0, Math.min(1, S.sessions.length - 1)),
  align: () => renderAlignPane(),
  board: () => void renderBoardPane(),
  dossier: () => void renderDossierPane(),
  retro: () => void renderRetroPane(),
  /* 这两个页签点下去要 await 一段读盘渲染。以前失败被 `.catch(() => undefined)` 吃掉，
   * 于是就成了计划里点名的那种症状：**点了没反应、卡片还在**——教师点「数据」，
   * 屏幕什么都不变，也没有任何人告诉他为什么。 */
  data: () => void renderDataPane(S.currentBookDir ?? '').catch((e) => setStatus('数据面板没能打开：' + e, 'err')),
  // 风险队列：只看机器点名的地方（审查报告 §一：按段顺序呈现是流程缺陷）
  risk: () => void openRiskPane().catch((e) => setStatus('风险队列没能打开：' + e, 'err')),
};

/** 风险队列页：从当前书定位调适项目 → 解析产物目录/调适工作区 → 渲染队列。
 *  三个决定键只写事件日志（不可变），不改书稿——改书稿仍走正文里的标记/建议。 */
let riskTier = 'A';
export function setRiskTier(t: string): void {
  riskTier = t;
}
async function openRiskPane(): Promise<void> {
  const dir = S.currentBookDir;
  if (!dir) return;
  const found = await findProjectConfig(dir);
  const cfg = (found?.config ?? {}) as Record<string, unknown>;
  const outDir = typeof cfg['产物目录'] === 'string' ? cfg['产物目录'] : '';
  const workDir = typeof cfg['调适工作区'] === 'string' ? cfg['调适工作区'] : '';
  if (!outDir || !workDir) {
    $('pane-risk').innerHTML =
      '<div class="empty"><b>这本书还没有调适项目配置</b><br/>风险队列靠 <code>调适项目_*.json</code> 定位产物目录与调适工作区。<br/><span style="font-size:12px">写法见 docs/快速开始.md 第 2 节</span></div>';
    return;
  }
  // 与 datapanel 共用同一套 IO（Tauri 下是 read_text_file/write_text_file）——
  // 各写一套 IO 的话，测试替身与真机行为会分叉
  setRiskIo({
    read: (p) => panelIo.read(p),
    write: (p, c) => panelIo.write(p, c),
    listDir: (d) => panelIo.listDir(d),
    /* 改稿前备份：不可逆的操作不该没有退路。与 persistEdit 同一约定——
     * 首改前留一份"原始备份"，已经有就不覆盖（否则第二次改稿会把真正的原始版冲掉）。 */
    backup: async (p, c) => {
      const dir = p.slice(0, p.lastIndexOf('/'));
      const bak = `${dir}/${p.slice(p.lastIndexOf('/') + 1).replace(/\.(md|txt|markdown)$/i, '')}_原始备份.md`;
      try {
        await invoke<string>('read_text_file', { path: bak });
      } catch {
        /* 有意兜底：读不到＝还没有备份（"首改前留一份"就是这个 catch 的用途）。
         * 风险写明：后端没给错误码，"不存在"与"存在但读不出来"在这里分不出，
         * 后一种情况下这一写会覆盖原始备份——所以备份**只在这里写**，不做每次覆盖。 */
        await invoke('write_text_file', { path: bak, content: c });
      }
    },
    /* 账本用**追加**而不是"读全文→拼一行→写全文"：后者在两个人同时记一条时
     * 会把对方的整份内容覆盖掉——丢的是一整条决定或一整版记录，而且毫无迹象。
     * `O_APPEND` 让"一行一次写"成为原子的。 */
    append: (p, line) => invoke('append_text_file', { path: p, content: line }).then(() => undefined),
  });
  const dictPath = typeof (cfg['书级'] as Record<string, unknown> | undefined)?.['词典'] === 'string' ? ((cfg['书级'] as Record<string, unknown>)['词典'] as string) : undefined;
  await renderRiskPane({
    dom: document as unknown as Parameters<typeof renderRiskPane>[0]['dom'],
    tier: riskTier,
    paths: { outDir, workDir, sourceVersion: RISK_TAGS[riskTier] ?? riskTier, dictPath },
    /* 教师身份**归一化之后再进面板**：面板把它写进每一条决定事件，
     * 而 `Wayne` 与 `wayne` 若各写各的，"谁在何时做了哪条决定"就被拼写切成两半——
     * 与清单/指针那边用的是同一个 `teacherIdOf`（身份是**算出来的**，不靠自觉）。 */
    teacherId: teacherIdOf((S.appConfig as { teacherId?: string }).teacherId ?? 'unknown'),
  });
}

let curView: ViewName = 'text';

export function switchView(name: ViewName): void {
  curView = name;
  VIEW_HOOKS[name]?.();
  switchViewDom(document, name);
  syncChrome();
}

export function currentView(): ViewName {
  return curView;
}

/* ---------- 事件绑定 ---------- */

bindViewTabs(document, switchView);

/* ---------- 示例菜单 ---------- */

async function openDemoMenu(): Promise<void> {
  const menu = $('demo-menu');
  let locals: string[] = [];
  try {
    locals = await invoke<string[]>('list_local_examples');
  } catch {
    /* 有意兜底：本地示例目录可能根本不存在（教师还没放文稿），
     * 那就退回内置示例——他点的是"打开示例"，仍然得到一样能用的东西。 */
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
// 工作台支持从 Finder 直接拖入文本/Markdown/EPUB；只在放下时读取，不触碰源文件。
let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  if (e.dataTransfer?.types.includes('Files')) {
    dragDepth++;
    document.body.classList.add('drag-active');
  }
});
document.addEventListener('dragleave', (e) => {
  if (e.dataTransfer?.types.includes('Files') && --dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove('drag-active');
  }
});
document.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
});
document.addEventListener('drop', (e) => {
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('drag-active');
  const paths = [...e.dataTransfer.files].map((f) => (f as File & { path?: string }).path).filter((p): p is string => !!p);
  if (paths.length) void Promise.all(paths.map((p) => openPathIntoSession(p))).catch((err) => setStatus('拖入文件失败：' + err, 'err'));
});
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
    case 'rev-material':
      showRevPop();
      break;
    case 'grade-one':
      showGradingPop();
      break;
    case 'grade-class':
      void showClassGradingPop();
      break;
    case 'anki-cards':
      void showAnkiExport();
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
  paraphrase: 'R00',
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
    /* 有意兜底：台账还不存在＝第一次写（读缺失文件本来就是报错的），下面补表头。 */
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
      /* 有意兜底：读不到＝还没有备份，写一份（这是"首次改动前留原始版"的正常路径）。
       * 风险写明：若备份其实存在、只是读不出来，这一写会把真原始版换成当前的 s.md；
       * 后端没给错误码分不出来，只能接受，并靠"有备份就不覆盖"把概率压到最小。 */
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
  // 主题/排版先于一切渲染：书架出现前屏幕保持中性装载态，不闪默认浅色（#reader 初始骨架=书架装载中）
  applyTheme();
  applyReaderFont();
  applyReaderLineHeight();
  await renderShelf(); // 首页=书架（示例+我的书；原"最近编辑"空状态升级为书架）
  if (!S.appConfig.firstRunSeen) showWelcome();
  void restoreChat(); // 右栏 AI 会话后台恢复，不挡书架首屏
  setInterval(() => void saveLastSession(), 20000); // 兜底：上次会话自动保存
})();

/* ================= 简化标准（句长上限，唯一可调项） · 本书配置 · 首启动欢迎 ================= */

document.addEventListener('mousedown', (e) => {
  if (tierPop.classList.contains('open') && !(e.target as HTMLElement).closest('#tier-pop')) tierPop.classList.remove('open');
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
  // 选区句子一律取 Range 文档序（start/end 与拖选方向无关）：从右往左拖时 anchor/focus 反转，
  // 曾致框选后一句、面板却锚到前一句（Wayne 09-10 实测抓出）
  const range = sel.getRangeAt(0);
  const sentOf = (n: Node | null): HTMLElement | null => ((n?.nodeType === 3 ? n.parentElement : (n as HTMLElement | null))?.closest('.sent') as HTMLElement | null) ?? null;
  const startSent = sentOf(range.startContainer);
  const endSent = sentOf(range.endContainer);
  const s = activeSession();
  if (!endSent || !s) return;
  const sentEl = endSent;
  const rect = range.getBoundingClientRect();
  if (startSent !== endSent) {
    showSentPanel(s, sentEl, rect.left, rect.bottom + 6, true); // 跨句选择，仅标记所选末句（文档序末句，与拖选方向无关）
    return;
  }
  const pi = Number(sentEl.dataset.pi);
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

$('btn-ai').addEventListener('click', () => void aiSuggest());

document.addEventListener('mousedown', (e) => {
  if (gatePop.classList.contains('open') && !(e.target as HTMLElement).closest('#gate-pop') && !(e.target as HTMLElement).closest('.qmark')) {
    hideGatePop();
  }
  if (syncPop.classList.contains('open') && !(e.target as HTMLElement).closest('#sync-pop')) hideSyncPop();
  const ap = document.getElementById('anki-pop');
  if (ap?.classList.contains('open') && !(e.target as HTMLElement).closest('#anki-pop')) ap.classList.remove('open');
  const rp = document.getElementById('rev-pop');
  if (rp?.classList.contains('open') && !(e.target as HTMLElement).closest('#rev-pop') && !(e.target as HTMLElement).closest('#rev-run')) rp.classList.remove('open');
  const gp = document.getElementById('grade-pop');
  if (gp?.classList.contains('open') && !(e.target as HTMLElement).closest('#grade-pop')) gp.classList.remove('open');
});
