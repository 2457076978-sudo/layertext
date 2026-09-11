/**
 * 批改域（2026-09-10）：学生产出体检（引擎口径反转——超纲结构误用/超纲词/复现词产出命中，P0）、
 * 全班批改队列（一个文件夹=一个班，P1）、AI 批改候选（AI 只出候选、教师勾选定稿、批改稿导出，P2）。
 * 红线：学生文本全本地（AI 批改仅走教师自配的 key，同既有 AI 功能边界）；不进任何仓库。
 */

import { invoke } from '@tauri-apps/api/core';
import { open as openFileDialog, save as saveFileDialog } from '@tauri-apps/plugin-dialog';
import { S, esc } from './state.js';
import { setStatus, toast } from './uikit.js';
import { buildLexiconNow, reinforceWordsNow } from './lexicon.js';
import { chatUntilJson } from './main.js';
import { showAiSettings } from './settings.js';
import { readChapterRaw } from './batch.js';
import { buildGradingPrompt } from './ai.js';
import { runQc } from '../../src/core/qc.js';
import { extractParas, sentsOf, splitChapter, tokenizeTxt } from '../../src/core/textpipe.js';
import { sentenceRisks } from '../../src/core/risks.js';
import { GRADING_TYPE_LABEL, buildClassGradingMd, buildGradingSheetMd, classGradingCsv, normalizeAndSplitChapters, parseGradingItems, type ClassGradingRow, type GradingNote } from './pure.js';

/* ---------- 引擎分析（单份学生文本：归一化 → QC → 未学结构句清单 → 复现产出） ---------- */

interface Analysis {
  md: string;
  report: ReturnType<typeof runQc>;
  risks: { sent: string; badges: string[] }[];
  longSents: string[];
  wordCount: number;
  queue: string[] | undefined;
  used: string[];
  missing: string[];
  /** 难句清单没算出来时的原因——带着它走，报告与 AI 摘要才不会把"没算"说成"没有" */
  riskError?: string;
}

function vocabNote(): string {
  const q = reinforceWordsNow();
  return `课标1600（内置）${S.vocabCsvText ? ` + ${S.vocabName ?? '自定义词库'}` : ''}${S.termsText ? ' + 术语表' : ''}` + (q ? `；复现队列 ${q.length} 词` : '；复现队列未启用');
}

async function analyzeProduction(raw: string): Promise<Analysis> {
  const { chapters } = normalizeAndSplitChapters(raw, '学生产出');
  const md = chapters.map((c) => c.md).join('\n\n');
  const queue = reinforceWordsNow();
  const report = runQc(md, buildLexiconNow(), {
    tier: 'M',
    fileName: '学生产出',
    tierGates: { passiveFromCh: 0, relclFromCh: 0 },
    ...(queue ? { reinforceWords: queue } : {}),
  });
  const risks: { sent: string; badges: string[] }[] = [];
  const longSents: string[] = [];
  let riskError: string | undefined;
  try {
    extractParas(splitChapter(md).body).forEach((p) =>
      sentsOf(p, false).forEach((sent) => {
        const r = sentenceRisks(sent);
        const badges = [r.passive ? '被动' : '', r.relcl ? '定从' : '', r.pastperf ? '过去完成' : ''].filter(Boolean);
        if (badges.length) risks.push({ sent, badges });
        if (r.overlong) longSents.push(sent);
      }),
    );
  } catch (e) {
    /* 以前这里只写"尽力而为"，于是一份正文解析不了的学生文稿会**安安静静地**报出
     * "未学结构 0 句、超长句 0 句"——那读起来像"这学生没犯错"，其实是"我没算"。
     * 现在把这个区别带出函数：报告里点名、喂 AI 的摘要里也点名。 */
    riskError = String(e).slice(0, 80);
  }
  const used = queue ? (report.reinforceHitList ?? []) : [];
  const missing = queue ? queue.filter((w) => !used.includes(w)) : [];
  return { md, report, risks, longSents, wordCount: tokenizeTxt(md).length, queue, used, missing, riskError };
}

/** 引擎体检摘要（喂给 AI 批改的 {{engine}}，只供参考） */
function engineSummary(a: Analysis): string {
  const oov = [...new Set(a.report.oov)];
  return [
    `词数 ${a.wordCount}，句数 ${a.report.sentCount}，平均句长 ${a.report.avgLenNarrRaw.toFixed(1)}，最长 ${a.report.maxLen} 词`,
    `未学结构：被动 ${a.report.passive} / 定语从句 ${a.report.relcl} / 过去完成 ${a.report.pastperf}；超长句 ${a.longSents.length}`,
    a.riskError ? `⚠ 逐句难句清单**没算出来**（${a.riskError}）——上面这行与"超长句"两项因此不可信，不要当成"学生没写"` : '',
    oov.length ? `超纲词（前 20）：${oov.slice(0, 20).join(', ')}` : '无超纲词',
    a.queue ? `复现词产出命中 ${a.used.length}/${a.queue.length}（用上：${a.used.slice(0, 12).join(', ') || '无'}）` : '复现队列未启用',
  ]
    .filter(Boolean)
    .join('；');
}

function productionReportMd(name: string, a: Analysis, date: string): string {
  const oov = [...new Set(a.report.oov)];
  const lines = [
    `# 学生产出体检 · ${name}`,
    '',
    `体检日期：${date} ｜ 词库口径：${vocabNote()}`,
    '',
    `**总览**：词数 ${a.wordCount} ｜ 句数 ${a.report.sentCount} ｜ 平均句长 ${a.report.avgLenNarrRaw.toFixed(1)} 词 ｜ 最长句 ${a.report.maxLen} 词`,
    '',
    ...(a.riskError ? [`> ⚠ 本文的**逐句难句清单没算出来**（${a.riskError}）：下面①④两节因此可能偏少——这是"我没算出来"，不是"学生没写"。`, ''] : []),
    `## ① 未学结构误用（${a.risks.length} 句——被动/定从/过去完成，学生未学；可能是超前学或背范文，教师判断）`,
    ...(a.risks.length ? a.risks.map((r) => `- [${r.badges.join('/')}] ${r.sent}`) : ['- 无']),
    '',
    `## ② 超纲词（${oov.length} 个——班级词库之外；是亮点还是超范围，教师判断）`,
    ...(oov.length ? [oov.join('、')] : ['- 无']),
    '',
    a.queue
      ? [`## ③ 复现词产出命中（${a.used.length}/${a.queue.length}）`, `用上：${a.used.join('、') || '无'}`, `未用：${a.missing.join('、') || '无'}`, '']
      : ['（复现队列未启用——书目录放 _已学词.csv 或班级定制勾选后，这里给出"读后写作是否用上队列词"）', ''],
    `## ④ 超长句（${a.longSents.length} 句，超 ${a.report.maxLen > 0 ? '' : ''}句长上限口径）`,
    ...(a.longSents.length ? a.longSents.map((s) => `- ${s}`) : ['- 无']),
    '',
    '> 口径：与阅读侧同一套本机引擎，语义反转——输入侧查"给学生读的文本难不难"，本表查"学生写出的文本超没超纲"。',
  ];
  return lines.flat().join('\n') + '\n';
}

/* ---------- 弹层 ---------- */

function gradePop(): HTMLElement {
  let el = document.getElementById('grade-pop');
  if (!el) {
    el = document.createElement('div');
    el.id = 'grade-pop';
    document.body.appendChild(el);
  }
  return el;
}

function openPop(html: string): HTMLElement {
  const p = gradePop();
  p.innerHTML = html;
  p.classList.add('open');
  return p;
}

export function showGradingPop(): void {
  const p = openPop(`
    <div class="pop-h"><svg class="ico"><use href="#i-wrench"/></svg>学生产出体检（批改 · 单份）</div>
    <p class="dim" style="font-size:12px;line-height:1.8;margin:4px 0 8px">
      把学生写的英语（作文/仿写/读后感）粘贴进来或选文件，用<b>与阅读侧同一套引擎、口径反转</b>体检：
      未学结构误用（被动/定从/过去完成）、超纲词、句长、<b>复现词产出命中</b>（队列词学生用上了几个）。
      词库口径：<b>${esc(vocabNote())}</b>。全部本地计算，学生文本不出本机（AI 批改候选需另行点击，走你配置的 AI）。</p>
    <div class="fld"><label>学生姓名（用于导出文件名）</label><input id="gr-name" placeholder="如 李明睿" style="width:180px" /></div>
    <div class="fld"><label>学生英文原文（直接粘贴）</label>
      <textarea id="gr-text" rows="8" style="width:100%;font-size:13px;line-height:1.7;border:1px solid var(--line);border-radius:8px;padding:6px 8px;box-sizing:border-box" placeholder="粘贴学生写的英文……"></textarea></div>
    <div class="row-btns" style="margin-top:8px">
      <button id="gr-file" class="primary">选文件…（txt/md/docx）</button>
      <button id="gr-run">体检</button>
      <button id="gr-close">关闭</button>
    </div>`);
  p.querySelector('#gr-close')?.addEventListener('click', () => p.classList.remove('open'));
  p.querySelector('#gr-file')?.addEventListener('click', async () => {
    const path = await openFileDialog({ multiple: false, filters: [{ name: '学生文稿', extensions: ['txt', 'md', 'markdown', 'docx'] }] });
    if (typeof path !== 'string' || !path) return;
    try {
      const raw = await readChapterRaw(path);
      (p.querySelector('#gr-text') as HTMLTextAreaElement).value = raw;
      const nameInput = p.querySelector('#gr-name') as HTMLInputElement;
      if (!nameInput.value) nameInput.value = path.slice(path.lastIndexOf('/') + 1).replace(/\.(txt|md|markdown|docx)$/i, '');
      setStatus('已读入学生文稿：' + path.slice(path.lastIndexOf('/') + 1), 'saved');
    } catch (e) {
      setStatus('读取失败：' + e, 'err');
    }
  });
  p.querySelector('#gr-run')?.addEventListener('click', () => void runSingle());
}

async function runSingle(): Promise<void> {
  const p = gradePop();
  const name = (p.querySelector('#gr-name') as HTMLInputElement)?.value.trim() || '未命名';
  const text = (p.querySelector('#gr-text') as HTMLTextAreaElement)?.value.trim() ?? '';
  if (!text) {
    setStatus('先粘贴学生原文（或选文件）', 'err');
    return;
  }
  const analysis = await analyzeProduction(text);
  renderSingleReport(name, text, analysis, []);
}

function renderSingleReport(name: string, text: string, a: Analysis, notes: GradingNote[]): void {
  const oov = [...new Set(a.report.oov)];
  const p = openPop(`
    <div class="pop-h"><svg class="ico"><use href="#i-wrench"/></svg>体检报告 · ${esc(name)}</div>
    <div class="sg-actions" style="margin:4px 0 8px">
      <b>词数 ${a.wordCount} ｜ 句数 ${a.report.sentCount} ｜ 均长 ${a.report.avgLenNarrRaw.toFixed(1)} ｜ 最长 ${a.report.maxLen}</b>
      <span class="dim" style="font-size:12px">${esc(vocabNote())}</span>
    </div>
    <table class="gtable">
      <tr><td>未学结构误用（被动/定从/过去完成）</td><td><b>${a.risks.length}</b> 句${
        a.risks.length
          ? `<span class="dim">（${a.risks
              .slice(0, 3)
              .map((r) => r.sent.slice(0, 30) + '…')
              .join('｜')}）</span>`
          : ''
      }</td></tr>
      <tr><td>超纲词（班级词库之外）</td><td><b>${oov.length}</b> 个</td></tr>
      <tr><td>超长句</td><td><b>${a.longSents.length}</b> 句</td></tr>
      ${a.queue ? `<tr class="${a.used.length ? '' : 'warnrow'}"><td>复现词产出命中（读后写作用上队列词）</td><td><b>${a.used.length}/${a.queue.length}</b>${a.used.length ? `：${esc(a.used.slice(0, 10).join('、'))}` : '（一个都没用上）'}</td></tr>` : `<tr><td>复现词产出命中</td><td class="dim">队列未启用（书目录放 _已学词.csv 或班级定制勾选）</td></tr>`}
    </table>
    ${a.risks.length ? `<div style="margin-top:8px;font-size:12px;line-height:1.9"><b>① 未学结构句</b><br/>${a.risks.map((r) => `· [${r.badges.join('/')}] ${esc(r.sent)}`).join('<br/>')}</div>` : ''}
    ${oov.length ? `<div style="margin-top:6px;font-size:12px;line-height:1.9"><b>② 超纲词</b><br/>${esc(oov.join('、'))}</div>` : ''}
    ${a.queue ? `<div style="margin-top:6px;font-size:12px;line-height:1.9"><b>③ 复现词产出</b><br/>用上：${esc(a.used.join('、')) || '无'}<br/>未用：${esc(a.missing.slice(0, 30).join('、')) || '无'}</div>` : ''}
    ${notes.length ? renderCandidatesHtml(notes) : ''}
    <div class="row-btns" style="margin-top:10px">
      <button id="gr-export" class="primary">导出体检报告（md）</button>
      <button id="gr-ai">AI 批改建议（候选，不勾不生效）</button>
      ${notes.length ? '<button id="gr-sheet">导出批改稿（勾选条目）</button>' : ''}
      <button id="gr-back">返回修改</button>
      <button id="gr-close2">关闭</button>
    </div>`);
  p.querySelector('#gr-close2')?.addEventListener('click', () => p.classList.remove('open'));
  p.querySelector('#gr-back')?.addEventListener('click', () => {
    showGradingPop();
    const p2 = gradePop();
    (p2.querySelector('#gr-text') as HTMLTextAreaElement).value = text;
    (p2.querySelector('#gr-name') as HTMLInputElement).value = name;
  });
  p.querySelector('#gr-export')?.addEventListener('click', async () => {
    const date = new Date().toLocaleDateString('sv-SE');
    const savePath = await saveFileDialog({ defaultPath: `学生产出体检_${name}_${date}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (typeof savePath !== 'string') return;
    await invoke('write_text_file', { path: savePath, content: productionReportMd(name, a, date) });
    setStatus(`体检报告已导出：${savePath}`, 'saved');
    void invoke('reveal_path', { path: savePath });
  });
  p.querySelector('#gr-ai')?.addEventListener('click', () => void runAiGrading(name, text, a));
  p.querySelector('#gr-sheet')?.addEventListener('click', () => void exportSheet(name, text));
}

function renderCandidatesHtml(notes: GradingNote[]): string {
  return `
    <div style="margin-top:8px;font-size:12px;line-height:1.9">
      <b>AI 批改候选（默认全不勾——勾选的才进批改稿）</b>
      ${notes
        .map(
          (n, i) => `<label style="display:block;margin:3px 0;padding:4px 6px;border:1px solid var(--line);border-radius:6px">
        <input type="checkbox" data-note="${i}" style="width:auto;margin-right:6px" />
        <span class="chip">${GRADING_TYPE_LABEL[n.type]}</span> ${n.original ? `<span class="dim">${esc(n.original.slice(0, 50))}</span>：` : ''}${esc(n.note)}${n.suggestion ? ` <b>建议：${esc(n.suggestion)}</b>` : ''}
      </label>`,
        )
        .join('')}
    </div>`;
}

async function runAiGrading(name: string, text: string, a: Analysis): Promise<void> {
  const key = await invoke<string>('load_api_key');
  if (!key) {
    setStatus('AI 批改需要先配置 AI（菜单 LayerText → AI 设置…）', 'err');
    showAiSettings();
    return;
  }
  setStatus('AI 批改候选生成中（只出候选，勾选的才进批改稿）…');
  try {
    const { raw } = await chatUntilJson([{ role: 'user', content: await buildGradingPrompt({ student: name, vocabNote: vocabNote(), engine: engineSummary(a), text }) }], 3000, 'AI 批改');
    const { ok, rejected } = parseGradingItems(raw, text);
    if (rejected > 0) toast(`已拒收 ${rejected} 条不合规批改（类型不明/原文定位不到/无批语）`, 'info');
    if (ok.length === 0) {
      setStatus('AI 未返回可用批改候选——可再点一次重试', 'err');
      return;
    }
    aiNotes = ok;
    renderSingleReport(name, text, a, ok);
    setStatus(`AI 批改候选 ${ok.length} 条已列出${rejected ? `（另拒收 ${rejected} 条）` : ''}——勾选后点「导出批改稿」`, 'saved');
  } catch (e) {
    setStatus('AI 批改失败：' + e, 'err');
  }
}

let aiNotes: GradingNote[] = [];

async function exportSheet(name: string, text: string): Promise<void> {
  const p = gradePop();
  const picked = [...p.querySelectorAll<HTMLInputElement>('[data-note]:checked')].map((cb) => aiNotes[Number(cb.dataset.note)]).filter(Boolean);
  if (picked.length === 0) {
    setStatus('先勾选要进批改稿的条目（默认全不勾）', 'err');
    return;
  }
  const date = new Date().toLocaleDateString('sv-SE');
  const savePath = await saveFileDialog({ defaultPath: `批改稿_${name}_${date}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] });
  if (typeof savePath !== 'string') return;
  await invoke('write_text_file', { path: savePath, content: buildGradingSheetMd(name, text, picked, { date, vocabNote: vocabNote() }) });
  setStatus(`批改稿已导出（${picked.length} 条批注）：${savePath}`, 'saved');
  void invoke('reveal_path', { path: savePath });
}

/* ---------- 全班批改队列（P1：一个文件夹=一个班，一份文件=一个学生） ---------- */

export async function showClassGradingPop(): Promise<void> {
  const p = openPop(`
    <div class="pop-h"><svg class="ico"><use href="#i-users"/></svg>全班批改队列</div>
    <p class="dim" style="font-size:12px;line-height:1.8;margin:4px 0 8px">
      选一个文件夹（<b>一份文件=一个学生</b>，文件名=学生名，支持 txt/md/docx）——逐份本地体检（超纲结构/超纲词/句长/复现产出命中），
      出班级汇总表；点击行看单生明细。词库口径：<b>${esc(vocabNote())}</b>。不上传、不入库。</p>
    <div class="row-btns">
      <button id="cg-pick" class="primary">选择班级文件夹…</button>
      <button id="cg-close">关闭</button>
    </div>
    <div id="cg-out" style="margin-top:8px"></div>`);
  p.querySelector('#cg-close')?.addEventListener('click', () => p.classList.remove('open'));
  p.querySelector('#cg-pick')?.addEventListener('click', () => void pickClassDir());
}

async function pickClassDir(): Promise<void> {
  const dir = await openFileDialog({ directory: true, title: '选择班级文件夹（一份文件=一个学生）' });
  if (typeof dir !== 'string') return;
  let paths: string[];
  try {
    paths = (await invoke<string[]>('list_dir', { dir })).filter((f) => /\.(txt|md|markdown|docx)$/i.test(f) && !/(^|\/)_/.test(f) && !/生词卡|复现队列|批改汇总/.test(f));
  } catch (e) {
    /* 读不了 ≠ 里面没有东西。以前两种情况都会走到下面那句"没有学生文稿"，
     * 于是教师会去翻文件夹找自己"忘了放"的作文，而真正的错因一个字都没露。 */
    setStatus(`学生文稿目录读不出来：${String(e)}——这不代表文件夹是空的，先确认路径与权限`, 'err');
    return;
  }
  if (paths.length === 0) {
    setStatus('这个文件夹里没有学生文稿（txt/md/docx；_ 开头配置与已生成的批改产物不算）', 'err');
    return;
  }
  const out = gradePop().querySelector('#cg-out') as HTMLElement;
  out.innerHTML = `<div class="dim">正在体检 ${paths.length} 份……</div>`;
  const rows: ClassGradingRow[] = [];
  const details = new Map<string, Analysis>();
  for (const f of paths) {
    const name = f.slice(f.lastIndexOf('/') + 1).replace(/\.(txt|md|markdown|docx)$/i, '');
    try {
      const a = await analyzeProduction(await readChapterRaw(f));
      details.set(name, a);
      rows.push({
        name,
        words: a.wordCount,
        sents: a.report.sentCount,
        avgLen: a.report.avgLenNarrRaw,
        structure: a.risks.length,
        longSents: a.longSents.length,
        oovWords: new Set(a.report.oov).size,
        used: a.used.length,
        queue: a.queue?.length ?? 0,
        ...(a.riskError ? { error: `难句清单没算出来（${a.riskError}）——"未学结构/长句"两列偏低` } : {}),
      });
    } catch (e) {
      /* 读不到/解不了的学生文稿**不许混进正常行**：以前这里填一排 0，
       * 在表里与"学生交了个空文件"长得一模一样，教师据此去批评学生会很难解释。 */
      rows.push({ name, words: 0, sents: 0, avgLen: 0, structure: 0, longSents: 0, oovWords: 0, used: 0, queue: 0, failed: true, error: `没能读进来/算出来：${String(e).slice(0, 80)}` });
    }
  }
  const q = reinforceWordsNow();
  out.innerHTML = `
    <div class="dim" style="margin-bottom:6px">完成 ${rows.length} 份（点击行看单生明细）</div>
    <table class="sgtable">
      <tr><th>学生</th><th>词数</th><th>句数</th><th>均长</th><th>未学结构</th><th>长句</th><th>超纲词</th><th>复现命中</th></tr>
      ${rows
        .map(
          (r) => `<tr class="board-row" data-cg="${esc(r.name)}" style="cursor:pointer">
        <td>${esc(r.name)}</td><td>${r.words || '—'}</td><td>${r.sents || '—'}</td><td>${r.avgLen ? r.avgLen.toFixed(1) : '—'}</td>
        <td>${r.structure}</td><td>${r.longSents}</td><td>${r.oovWords}</td><td>${r.queue ? `${r.used}/${r.queue}` : '—'}</td></tr>`,
        )
        .join('')}
    </table>
    <div class="row-btns" style="margin-top:8px">
      <button id="cg-export" class="primary">导出班级批改汇总（md+csv 到该文件夹）</button>
    </div>`;
  out.querySelectorAll<HTMLElement>('[data-cg]').forEach((tr) =>
    tr.addEventListener('click', () => {
      const name = tr.dataset.cg!;
      const a = details.get(name);
      if (!a) return;
      renderSingleReport(name, '', a, []);
    }),
  );
  out.querySelector('#cg-export')?.addEventListener('click', async () => {
    const date = new Date().toLocaleDateString('sv-SE');
    const md = buildClassGradingMd(rows, { date, folder: dir, vocabNote: vocabNote() });
    const csv = classGradingCsv(rows);
    try {
      await invoke('write_text_file', { path: `${dir}/班级批改汇总_${date}.md`, content: md });
      await invoke('write_text_file', { path: `${dir}/班级批改汇总_${date}.csv`, content: csv });
      setStatus(`班级批改汇总已导出（${rows.length} 人${q ? `，复现队列 ${q.length} 词` : ''}）：${dir}/班级批改汇总_${date}.md`, 'saved');
      void invoke('reveal_path', { path: `${dir}/班级批改汇总_${date}.md` });
    } catch (e) {
      setStatus('汇总导出失败：' + e, 'err');
    }
  });
}
