/**
 * 全书批处理域（WP-F 拆分）：「AI 简化本章」整章逐段改写 + 全书批处理（勾章队列/中断续跑/书级报告）
 * —— 从 main.ts 整块迁出，行为零变化。
 */

import { invoke } from '@tauri-apps/api/core';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { S, esc } from './state.js';
import { $, setStatus, toast } from './uikit.js';
import { activeSession } from './session.js';
import { docxToText } from './bookpure.js';
import { readTextSmart } from './fsx.js';
import { uibus } from './uibus.js';
import { buildLexiconNow, mergedSelection, reinforceWordsNow } from './lexicon.js';
import { showAiSettings } from './settings.js';
import { applyRewrite, loadBookConfig } from './bookio.js';
import { chnoFromPath, normalizeAndSplitChapters } from './pure.js';
import { buildBookReportMd, planBatchChapters, type BatchChapterItem, type BatchProgressFile, type BookReportRow } from './bookpure.js';
import { buildDraftSystemPrompt, callChat, saveConfig, simplifyMaxLen } from './ai.js';
import { runQc } from '../../src/core/qc.js';
import { hit, splitChapter } from '../../src/core/textpipe.js';
import { applyReworkPicks, classifyHangReason, pickReworkSegments, reworkGates } from '../../src/core/rework.js';

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
  const mode = S.appConfig.draftMode ?? 'full';
  draftPop.innerHTML = `
    <div class="pop-h">AI 简化本章 · 整章逐段改写</div>
    <p style="color:var(--muted);font-size:12px;line-height:1.7;margin:6px 0 10px">
      对「${esc(s.fileName)}」按<b>当前简化标准（句长上限 ${simplifyMaxLen()} 词，菜单 LayerText → 简化标准… 可调）</b>生成简化版（保留段落结构与全部情节），完成后自动质检、开新 tab——原稿不动，之后进入标记精修。</p>
    <div class="fld"><label>模式</label>
      <div style="display:flex;flex-direction:column;gap:4px;font-size:12px">
        <label style="display:flex;gap:6px;align-items:flex-start"><input type="radio" name="draft-mode" value="rework" style="margin-top:3px" ${mode === 'rework' ? 'checked' : ''}/>
          <span><b>回炉 · 只改红项段</b>（要更简的版本用这个）：本地先找出有未注生词或超长句的段，<b>只把这些段发 AI</b> 修订、过闸才采纳，其余段一字不动——避免整章重写引入新的生词。</span></label>
        <label style="display:flex;gap:6px;align-items:flex-start"><input type="radio" name="draft-mode" value="full" style="margin-top:3px" ${mode === 'full' ? 'checked' : ''}/>
          <span><b>整章重写</b>（首次简化用）：逐段全部改写。</span></label>
      </div></div>
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

/** 段词数（收缩率口径）：与 tokenize 同源正则 */
const segWords = (t: string): number => (t.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).length;

/** 回炉模式的注入位：chat（AI 调用）与 oovOf（未注生词判定）都可替换——node 测试注入假实现，
 *  生产路径用真 callChat 与 S.currentKnown 词库口径（红词的"什么是生词"由词库锚定，与正文着色同源）。 */
export interface SimplifyCoreOpts {
  mode?: 'full' | 'rework';
  chat?: typeof callChat;
  oovOf?: (segText: string) => string[];
}

/** 未注生词（App 口径）：词表外 token、注释过的词不算、<3 字母不算该注（ANNOTATABLE_MIN_LEN 同源） */
function reworkOovOf(segText: string): string[] {
  const ann = new Set([...segText.matchAll(/([A-Za-z][A-Za-z-]*)（[^）]*）/g)].map((m) => m[1].toLowerCase()));
  const out: string[] = [];
  for (const tok of segText.replace(/（[^）]*）/g, ' ').match(/[A-Za-z]+/g) ?? []) {
    const w = tok.toLowerCase();
    if (w.length < 3) continue;
    if (ann.has(w)) continue;
    if (!hit(w, S.currentKnown)) out.push(w);
  }
  return out;
}

export interface ReworkOutcome {
  redCount: number;
  fixed: number;
  hung: Array<{ id: string; cls: string; reason: string }>;
}

/** 整章逐段简化核心（「AI 简化本章」与全书批处理共用）：逐段调用、前文衔接、段标记补回、书级替换。
 *  同义转换守恒（提示词 v1.6 + 引擎侧双保险）：每段改完算词数收缩，>15% 自动带纠正指令重试一次（采纳更长的一版）。
 *  mode='rework'（2026-09-18 项 1）：先本地选红项段（未注生词/引语豁免后仍超长），**只把红项段发 AI**、
 *  过回炉四闸（红词必减/段长比/注释不丢/句长·引语豁免）才采纳，其余段一字不动——09-17 实验证明
 *  整章重生成会引入新低频词（干净名单重跑 3.73→4.35），"要更简的版本"必须走差量路线。 */
export async function simplifyChapterCore(
  md: string,
  instructions: string,
  onSeg: (i: number, total: number, segHead: string) => void,
  signal?: AbortSignal,
  opts?: SimplifyCoreOpts,
): Promise<{ md: string; outTokens: number; segCount: number; srcWords: number; outWords: number; retried: number; rework?: ReworkOutcome }> {
  if (opts?.mode === 'rework') return reworkChapterCore(md, instructions, onSeg, signal, opts);
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
  let srcTotal = 0;
  let outTotal = 0;
  let retried = 0;
  for (let i = 0; i < segs.length; i++) {
    onSeg(i, segs.length, segs[i].slice(0, 8).trim());
    const prevTail = out.length ? out[out.length - 1].slice(-500) : '（本章开头）';
    const srcW = segWords(segs[i]);
    srcTotal += srcW;
    const userMsg = `前文（已简化，供语气与指代衔接参考）：\n…${prevTail}\n\n请简化以下段落：\n${segs[i].trim()}`;
    const { content, usage } = await callChat(
      [
        { role: 'system', content: system },
        { role: 'user', content: userMsg },
      ],
      2500,
      signal,
      'AI 简化本章',
    );
    tokens += Number(usage.match(/(\d+) 出/)?.[1] ?? 0);
    const mark = segs[i].match(/\[P\d+\]/)![0];
    let revised = applyRewrite(cleanDraftSeg(content, mark));
    // 段级守恒双保险：提示词已要求 ±15%，仍缩水（源段≥20词才卡，短段波动大）→ 带纠正指令重试一次，采纳更长的一版
    if (srcW >= 20 && segWords(revised) < srcW * 0.85) {
      const { content: c2, usage: u2 } = await callChat(
        [
          { role: 'system', content: system },
          { role: 'user', content: userMsg },
          { role: 'assistant', content },
          {
            role: 'user',
            content: `你上一版只有 ${segWords(revised)} 词，比原文（${srcW} 词）短了 ${Math.round((1 - segWords(revised) / srcW) * 100)}%。同义转换不是压缩：请保留原文全部细节、修饰与氛围描写，只把词汇和句式换成学生能懂的说法，重写这一段，输出词数应与原文相当（±15% 内）。`,
          },
        ],
        2500,
        signal,
        'AI 简化本章',
      );
      tokens += Number(u2.match(/(\d+) 出/)?.[1] ?? 0);
      const revised2 = applyRewrite(cleanDraftSeg(c2, mark));
      if (segWords(revised2) > segWords(revised)) revised = revised2; // 采纳更长的一版（仍短也放行——守恒是软约束，教师定稿）
      retried++;
    }
    outTotal += segWords(revised);
    out.push(revised);
  }
  return { md: `${header}${chLine}\n\n${out.join('\n\n')}\n`, outTokens: tokens, segCount: segs.length, srcWords: srcTotal, outWords: outTotal, retried };
}

/** 回炉模式核心：红项段差量修订（其余段不进 AI、装配时原样保留）。 */
async function reworkChapterCore(
  md: string,
  instructions: string,
  onSeg: (i: number, total: number, segHead: string) => void,
  signal: AbortSignal | undefined,
  opts: SimplifyCoreOpts,
): Promise<{ md: string; outTokens: number; segCount: number; srcWords: number; outWords: number; retried: number; rework: ReworkOutcome }> {
  const chat = opts.chat ?? callChat;
  const oovOf = opts.oovOf ?? reworkOovOf;
  const maxLen = simplifyMaxLen();
  const pick = pickReworkSegments(md, oovOf, maxLen);
  const segWordsAll = (t: string): number => (t.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).length;
  const srcWords = pick.segs.reduce((n, s) => n + segWordsAll(s), 0);
  const outcome: ReworkOutcome = { redCount: pick.reds.length, fixed: 0, hung: [] };
  if (!pick.reds.length) {
    return { md, outTokens: 0, segCount: pick.segs.length, srcWords, outWords: srcWords, retried: 0, rework: outcome };
  }
  const system = await buildDraftSystemPrompt({
    tierRule: simplifyRule(),
    chnoNote: '',
    instructions:
      '你是段级修订器：只修点名的问题，其余一字不动。' +
      (instructions ? `\n- 教师方向指令（最高优先级）：${instructions}` : '') +
      (mergedSelection().active ? `\n- 班级定制目标（${mergedSelection().label}）：本篇句长上限取最严 ${mergedSelection().minLen} 词/句` : ''),
  });
  const accepted: Array<{ find: string; replace: string }> = [];
  let tokens = 0;
  let retried = 0;
  for (let i = 0; i < pick.reds.length; i++) {
    const r = pick.reds[i];
    onSeg(i, pick.reds.length, `[${r.id}]`);
    const baseUser =
      `只修这一段的问题，输出修订后的整段（保留 [${r.id}] 标记与已有 word（中文） 注释）：\n` +
      r.reasons.map((x) => `- ${x}`).join('\n') +
      `\n- 把未注生词换成词表内已学词（或删冗余）；不要引入新的生词\n- 段词数变化 ±30% 内；已有中文注释一处不丢；每句不超过 ${maxLen} 词\n\n段落：\n${r.text.trim()}`;
    let hungReason = '';
    let ok = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const { content, usage } = await chat(
        [
          { role: 'system', content: system },
          { role: 'user', content: attempt === 0 ? baseUser : `${baseUser}\n\n你上一版没过闸：${hungReason}。请重修这一段。` },
        ],
        2500,
        signal,
        'AI 简化本章·回炉',
      );
      tokens += Number(usage.match(/(\d+) 出/)?.[1] ?? 0);
      if (attempt > 0) retried++;
      const mark = r.text.match(/\[P\d+\]/)![0];
      const revised = applyRewrite(cleanDraftSeg(content, mark));
      const redAfter = oovOf(revised);
      const gate = reworkGates({ before: r.text, after: revised, maxLen, redBefore: r.oov.length, redAfter: redAfter.length });
      if (gate.pass) {
        const tailWs = r.text.match(/\s*$/)![0]; // 段尾空白（段间分隔）随替换保留，别把段落粘一起
        accepted.push({ find: r.text, replace: revised.trim() + tailWs });
        outcome.fixed++;
        ok = true;
        break;
      }
      hungReason = gate.failures.map((f) => f.message).join('；');
    }
    if (!ok) outcome.hung.push({ id: r.id, cls: classifyHangReason(`未过闸（${hungReason || '两次尝试均未过闸'}）`), reason: hungReason });
  }
  const applied = applyReworkPicks(md, accepted);
  if (applied.failed.length) {
    /* 替换锚失效如实说出口（不静默丢修订）；产物仍按已替换部分交付 */
    setStatus(`回炉装配：${applied.failed.length} 段替换锚失效（段原文定位不到），已保留原文——${applied.failed.join('、')}`, 'err');
  }
  const outWords = segWordsAll(applied.md);
  return { md: applied.md, outTokens: tokens, segCount: pick.segs.length, srcWords, outWords, retried, rework: outcome };
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
  const mode = (document.querySelector('input[name="draft-mode"]:checked') as HTMLInputElement | null)?.value === 'rework' ? 'rework' : 'full';
  if (S.appConfig.draftMode !== mode) {
    S.appConfig.draftMode = mode;
    void saveConfig(); /* 模式选择记住（下次打开默认上次的选择）；存不上不拦本次运行 */
  }

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
      srcWords,
      outWords,
      retried,
      rework,
    } = await simplifyChapterCore(
      s.md,
      instructions,
      (i, total, head) => {
        $('draft-step').textContent = mode === 'rework' ? `回炉：正在修第 ${i + 1}/${total} 个红项段（${head}…）` : `正在简化第 ${i + 1}/${total} 段（${head}…）`;
        ($('draft-bar') as HTMLElement).style.width = `${(i / total) * 100}%`;
      },
      S.draftAbort!.signal,
      { mode },
    );
    ($('draft-bar') as HTMLElement).style.width = '100%';
    $('draft-step').textContent = '简化完毕，正在保存并体检…';

    const date = new Date().toLocaleDateString('sv-SE');
    const clsTag = mergedSelection().active ? `_${mergedSelection().label.replace(/[/\\?%*:|"<>&]/g, '')}` : '';
    let outPath: string;
    if (s.sourcePath) {
      const dir = s.sourcePath.slice(0, s.sourcePath.lastIndexOf('/'));
      outPath = `${dir}/${s.fileName.replace(/\.(md|txt|markdown)$/i, '')}_${mode === 'rework' ? '回炉' : '简化'}_${date}${clsTag}.md`;
    } else {
      const dir = await invoke<string>('reports_dir');
      outPath = `${dir}/示例_简化_${date}.md`;
    }
    await invoke('write_text_file', { path: outPath, content: newMd });
    draftPop.classList.remove('open');
    await uibus.addSession(newMd, outPath.slice(outPath.lastIndexOf('/') + 1), outPath, { noAutoQc: true });
    await uibus.runQcCurrent();
    const shrink = srcWords ? Math.round((1 - outWords / srcWords) * 100) : 0;
    setStatus(
      rework
        ? `回炉完成：红项段 ${rework.redCount}（修好 ${rework.fixed}｜挂起 ${rework.hung.length}${
            rework.hung.length
              ? `——${rework.hung
                  .map((h) => `${h.id} ${h.cls}`)
                  .slice(0, 4)
                  .join('、')}${rework.hung.length > 4 ? ' 等' : ''}`
              : ''
          }），其余段一字不动；约 ${tokens} 出tokens）：${outPath}。挂起段保留原文，可在报告页看原因`
        : `简化版已生成（${segCount} 段，${srcWords}→${outWords} 词${shrink > 0 ? `，收缩 ${shrink}%` : shrink < 0 ? `，扩写 ${-shrink}%` : ''}${retried ? `，${retried} 段触发篇幅守恒重试` : ''}，约 ${tokens} 出tokens）：${outPath}。体检指标见报告页——继续用标记精修；要更简版本：再点一次并选「回炉」模式`,
      'saved',
    );
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

export async function readChapterRaw(path: string): Promise<string> {
  return path.toLowerCase().endsWith('.docx') ? docxToText(await invoke<string>('read_file_base64', { path })) : await readTextSmart(path);
}

async function pickBatchDir(): Promise<void> {
  const dir = await openFileDialog({ directory: true, title: '选择书稿文件夹' });
  if (typeof dir !== 'string') return;
  batchDir = dir;
  $('bt-dir-label').textContent = dir;
  // 本书配置自动生效（与打开单章同口径）
  if (await loadBookConfig(dir)) setStatus('已自动加载本书配置（词库/术语/约定/规则）——全书批处理将按本书规则执行', 'saved');
  let paths: string[];
  try {
    paths = await invoke<string[]>('list_dir', { dir });
  } catch (e) {
    /* 读不了 ≠ 里面没东西。以前两件事都落到下面那句"这个文件夹里没有可处理的章节文件"，
     * 于是教师会以为自己的书是空的、跑去翻文件夹，而真正的错因（路径/权限）一个字都没露。 */
    setStatus(`目录读不出来：${String(e)}——这不代表文件夹是空的，先确认路径与权限`, 'err');
    return;
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
    /* 有意兜底：没有进度文件＝这本书还没跑过批处理（读缺失文件本来就是报错的），按全新队列走。 */
  }
  batchItems = [];
  for (const p of paths) {
    const item = planBatchChapters([p], progress)[0];
    try {
      const { chapters } = normalizeAndSplitChapters(await readChapterRaw(p), item.name);
      item.segCount = chapters.reduce((n, ch) => n + (ch.md.match(/\[P\d+\]/g)?.length ?? 0), 0);
    } catch {
      /* 有意兜底：这里只是**列表预览**的段数估计，读不了就先空着——
       * 真有问题的章会在 runBatch 里整章失败并写明原因（那一步不吞错误）。 */
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
  } catch (e) {
    /* 进度写不上不影响本次跑，但**必须说**：教师中途取消或应用意外退出，
     * 回来时这段进度就没了、得从本章重来——那是要花 AI 额度的。
     * 每章都记一次盘，所以只在第一次失败时提示一次。 */
    if (!progressWarned) {
      progressWarned = true;
      toast(`批处理进度写不上盘：${String(e)}——中途取消/意外退出后无法接着跑，会从本章重来`, 'err');
    }
  }
}

/** 进度落盘失败只提示一次（每章一次＝状态行/弹窗会被灌满） */
let progressWarned = false;

/** 书级替换规则残留计数（机器核对，不靠 AI 自觉；与 rewriteCheck 同口径）。
 *  解析不出来时返回 `null` ＝**没核到**，不是 0。这一点很要紧：
 *  报告里"规则残留 0"的意思是"全书一遍都没漏"，这是拿去做交付判断的数；
 *  拿一个假的 0 去填，等于替一本根本没核过的书签了字。 */
function countRuleLeft(md: string): number | null {
  let left = 0;
  let body: string;
  try {
    body = splitChapter(md).body;
  } catch {
    /* 没核到 ≠ 核过且干净：返回 null（报告里渲染成"—（没核到）"），不再填 0 冒充"全书一遍没漏" */
    return null;
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
    /* 有意兜底：读不到旧进度＝这本没跑过（或上次跑完被删了），于是整队都是新的。 */
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
          srcWords,
          outWords,
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
          shrinkPct: srcWords ? Math.round((1 - outWords / srcWords) * 100) : undefined,
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
        ruleLeft: null, // 失败章：不是"残留 0 处"，是**没核到**（报告里渲染成 —）
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
  /* 2026-09-14：原先只判 !canceled——**有章节失败**时也照样删进度，而那正是最需要续跑的情形。 */
  const hasFailed = rows.some((r) => r.status === 'failed');
  if (!canceled && !hasFailed) {
    try {
      await invoke('remove_file', { path: `${batchDir}/${BATCH_PROGRESS_FILE}` });
    } catch {
      /* 有意兜底：删不掉的只是"已完成的进度记录"，留着也不误导——
       * 它记的都是 done，下次打开那几章默认不勾选（本来也确实做完了）。 */
    }
  }
  // 恢复对话框为可再次选择状态
  ($('bt-pick') as unknown as HTMLButtonElement).disabled = false;
  /* 2026-09-14 修（**跑完一次后「开始简化」永久灰死**）：这里原先只恢复 style.display，
   * 而进进度态时设过的 bt-start.disabled = true 与被隐藏的两个 fld **从来没复位**，
   * 唯一会重新启用的 refreshStart() 挂在勾选框 change 上、而容器正被隐藏着。 */
  const startBtn = $('bt-start') as unknown as HTMLButtonElement;
  const nChecked = $('bt-list').querySelectorAll('[data-bt]:checked').length;
  startBtn.disabled = nChecked === 0;
  startBtn.textContent = nChecked ? `开始简化（${nChecked} 章）` : '先在上方勾选章节';
  startBtn.style.display = '';
  ($('bt-list-fld') as HTMLElement).style.display = '';
  ($('bt-inst-fld') as HTMLElement).style.display = '';
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
