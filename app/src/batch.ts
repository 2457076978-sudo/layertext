/**
 * 全书批处理域（WP-F 拆分）：「AI 简化本章」整章逐段改写 + 全书批处理（勾章队列/中断续跑/书级报告）
 * —— 从 main.ts 整块迁出，行为零变化。
 */

import { invoke } from '@tauri-apps/api/core';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { S, esc } from './state.js';
import { $, setStatus } from './uikit.js';
import {
  activeSession,
  addSession,
  docxToText,
  readTextSmart,
  runQcCurrent,
} from './main.js';
import { buildLexiconNow, mergedSelection, reinforceWordsNow } from './lexicon.js';
import { showAiSettings } from './settings.js';
import { applyRewrite, loadBookConfig } from './bookio.js';
import {
  chnoFromPath,
  normalizeAndSplitChapters,
} from './pure.js';
import { buildBookReportMd, planBatchChapters, type BatchChapterItem, type BatchProgressFile, type BookReportRow } from './bookpure.js';
import { buildDraftSystemPrompt, callChat, simplifyMaxLen } from './ai.js';
import { runQc } from '../../src/core/qc.js';
import { splitChapter } from '../../src/core/textpipe.js';

/* ================= AI 简化本章：整章逐段改写（两阶段工作流的第一阶段；更简版本=把结果再导入再简化） ================= */

const draftPop = $('draft-pop');

/** 简化规则行（注入每次简化请求；难度由教师词库锚定，标准只有句长上限一个数） */
function simplifyRule(): string {
  return `简化标准：平均句长 ≤${simplifyMaxLen()} 词；被动语态、定语从句禁用；过去完成时一律改写为一般过去时或 before/after 明示先后。`;
}

export function showDraftPop(): void {
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
export const batchPop = $('batch-pop');

let batchDir = '';
let batchItems: BatchChapterItem[] = [];
let batchAbort: AbortController | null = null;

export function showBatchPop(): void {
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

/* main.ts 全局 mousedown 外点收回调用的关闭函数（弹层关闭+中止队列，行为与原内联逻辑一致） */
export function closeDraftPop(): void {
  draftPop.classList.remove('open');
}

export function closeBatchPop(): void {
  batchAbort?.abort();
  batchPop.classList.remove('open');
}
