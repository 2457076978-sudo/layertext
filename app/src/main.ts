/**
 * LayerText 分层读 · 前端主逻辑（v0.1：导入 → 自动质检 → 三态高亮正文 + 报告）
 *
 * 界面为过渡形态：完整审校工作台（点词/划句标记、配额、门禁）将在其上迭代。
 */

import { invoke } from '@tauri-apps/api/core';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import bundledWordlist from '../../assets/wordlists/curriculum_2022_level3_1600.txt?raw';
import exampleMd from '../../examples/texts/aesop_tortoise_hare.md?raw';
import exampleVocab from '../../examples/vocab/sample_teaching_vocab.csv?raw';
import { buildLexicon, type Lexicon } from '../../src/core/lexicon.js';
import { runQc, toLegacyReport, type QcResult, type Tier } from '../../src/core/qc.js';
import { extractParas, hit, pendHit, sentsOf, splitChapter, tokenizeTxt } from '../../src/core/textpipe.js';
import { sentenceRisks } from '../../src/core/risks.js';

interface State {
  md: string;
  fileName: string;
  sourcePath: string | null; // null = 示例模式
  vocabCsvText: string | null;
  vocabName: string;
  termsText: string | null;
}

const state: State = {
  md: '',
  fileName: '',
  sourcePath: null,
  vocabCsvText: null,
  vocabName: '',
  termsText: null,
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const status = (msg: string) => ($('status').textContent = msg);

function setStatusSummary(): void {
  const parts: string[] = [];
  parts.push(state.fileName ? `文本：${state.fileName}` : '未载入文本');
  parts.push('词库：课标1600（内置）');
  if (state.vocabCsvText) parts.push(`+ ${state.vocabName}`);
  if (state.termsText) parts.push('+ 术语表');
  status(parts.join(' ｜ '));
}

async function readViaRust(path: string): Promise<string> {
  return invoke<string>('read_text_file', { path });
}

function buildCurrentLexicon(): Lexicon {
  return buildLexicon({
    vocabCsvTexts: state.vocabCsvText ? [state.vocabCsvText] : [],
    plainWordlistTexts: [bundledWordlist],
    terms: state.termsText
      ? state.termsText.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
      : [],
  });
}

function loadText(md: string, fileName: string, sourcePath: string | null): void {
  state.md = md;
  state.fileName = fileName;
  state.sourcePath = sourcePath;
  renderReader();
  setStatusSummary();
  status(status.length ? $('status').textContent ?? '' : '');
}

/* ---------- 正文渲染 ---------- */

function wordClass(tok: string, lex: Lexicon, terms: Set<string>): string {
  if (terms.has(tok)) return 'term';
  if (pendHit(tok, lex.pending)) return 'pending';
  if (hit(tok, lex.known)) return '';
  return 'oov';
}

function renderReader(): void {
  const reader = $('reader');
  if (!state.md) {
    reader.innerHTML = '<div class="empty">尚未载入文本<br/>点击上方「载入示例」或「打开章节文件…」</div>';
    return;
  }
  let body: string;
  try {
    body = splitChapter(state.md).body;
  } catch (e) {
    reader.innerHTML = `<div class="empty">文件格式不符：${(e as Error).message}<br/>需要包含 "## Chapter One" 章节标记与 [P01] 段落标记</div>`;
    return;
  }
  const lex = buildCurrentLexicon();
  const terms = new Set(
    (state.termsText ?? '')
      .split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#')),
  );
  const paras = extractParas(body);
  const frag = document.createDocumentFragment();
  paras.forEach((p, pi) => {
    const div = document.createElement('div');
    div.className = 'para';
    const pid = document.createElement('span');
    pid.className = 'pid';
    pid.textContent = 'P' + String(pi + 1).padStart(2, '0');
    div.appendChild(pid);
    for (const sent of sentsOf(p, false)) {
      const s = document.createElement('span');
      s.className = 'sent';
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
      // 按原句顺序重排：词间保留原文空格/标点
      let rest = sent;
      for (let i = 0; i < rawWords.length; i++) {
        const raw = rawWords[i];
        const at = rest.indexOf(raw);
        if (at > 0) s.appendChild(document.createTextNode(rest.slice(0, at)));
        const w = document.createElement('span');
        const cls = wordClass(toks[i] ?? raw.toLowerCase(), lex, terms);
        w.className = 'w' + (cls ? ' ' + cls : '');
        w.textContent = raw;
        const label = cls === 'oov' ? '词表外' : cls === 'pending' ? '待定词' : cls === 'term' ? '术语' : '已知';
        w.title = `${raw} · ${label}`;
        s.appendChild(w);
        rest = rest.slice(at + raw.length);
      }
      s.appendChild(document.createTextNode(rest));
      div.appendChild(s);
      div.appendChild(document.createTextNode(' '));
    }
    frag.appendChild(div);
  });
  reader.replaceChildren(frag);
}

function badge(text: string): HTMLElement {
  const b = document.createElement('sup');
  b.className = 'badge';
  b.textContent = text;
  return b;
}

/* ---------- 质检与报告 ---------- */

function tagFromPath(p: string): string {
  if (p.includes('A层')) return 'A';
  if (p.includes('v0.2')) return 'v02';
  return 'v01';
}

async function runQcAndReport(): Promise<void> {
  if (!state.md) { status('请先载入文本'); return; }
  const tier = ($('tier') as HTMLSelectElement).value as Tier;
  let result: QcResult;
  try {
    result = runQc(state.md, buildCurrentLexicon(), {
      tier,
      fileName: state.fileName || '示例文本',
    });
  } catch (e) {
    status('质检失败：' + (e as Error).message);
    return;
  }
  renderReport(result);

  // 报告自动落盘：示例模式 → 文稿"LayerText质检报告"目录；文件模式 → 源文件同目录
  let outPath: string;
  if (state.sourcePath) {
    const dir = state.sourcePath.slice(0, state.sourcePath.lastIndexOf('/'));
    outPath = `${dir}/质检报告_${tagFromPath(state.sourcePath)}.json`;
  } else {
    const dir = await invoke<string>('reports_dir');
    outPath = `${dir}/质检报告_示例.json`;
  }
  const report = toLegacyReport(result);
  try {
    await invoke('write_text_file', { path: outPath, content: JSON.stringify(report, null, 1) });
    renderReport(result, outPath);
    status(`质检完成，报告已自动保存：${outPath}`);
  } catch (e) {
    status(`质检完成，但报告落盘失败：${e}`);
  }
  switchTab('report');
}

function renderReport(result: QcResult, savedPath?: string): void {
  const pane = $('pane-report');
  const legacy = toLegacyReport(result) as Record<string, unknown>;
  const rows = Object.entries(legacy).filter(([k]) => k !== 'OOV词(去重)');
  const oov = (legacy['OOV词(去重)'] as string[]) ?? [];
  const gatesNote =
    result.tier === 'A'
      ? `A 层解禁：被动${result.gates.passiveOk ? '已解禁' : '未解禁（第5章起解禁）'} · 定从${result.gates.relclOk ? '已解禁' : '未解禁（第8章起解禁）'}`
      : 'B/M 层：三项句法黑名单全时段计数';
  const html = `
    ${savedPath ? `<div class="saved-path">报告已自动保存：${savedPath} <button id="btn-reveal">在访达中显示</button></div>` : ''}
    <table class="report">
      ${rows.map(([k, v]) => `<tr><th>${k}</th><td>${Array.isArray(v) ? v.length + ' 个' : String(v)}</td></tr>`).join('')}
      <tr><th>解禁门（A层）</th><td>${gatesNote}</td></tr>
    </table>
    <div style="font-weight:600;margin-bottom:8px">OOV 生词清单（去重 ${oov.length} 词）</div>
    <div class="oov-chips">${oov.map((w) => `<span class="chip">${w}</span>`).join('')}</div>
  `;
  pane.innerHTML = html;
  const reveal = document.getElementById('btn-reveal');
  if (reveal && savedPath) reveal.addEventListener('click', () => invoke('reveal_path', { path: savedPath }));
}

/* ---------- 事件绑定 ---------- */

function switchTab(name: 'text' | 'report'): void {
  for (const [id, pane] of [['tab-text', 'pane-text'], ['tab-report', 'pane-report']] as const) {
    $(id).classList.toggle('active', id === `tab-${name}`);
    $(pane).classList.toggle('active', pane === `pane-${name}`);
  }
}

$('tab-text').addEventListener('click', () => switchTab('text'));
$('tab-report').addEventListener('click', () => switchTab('report'));

$('btn-demo').addEventListener('click', () => {
  state.vocabCsvText = exampleVocab;
  state.vocabName = '示例词库 sample_teaching_vocab.csv';
  loadText(exampleMd, 'aesop_tortoise_hare.md（内置示例）', null);
  status('已载入内置示例（含示例词库）。点「▶ 开始质检」查看报告。');
});

$('btn-open').addEventListener('click', async () => {
  const path = await openFileDialog({
    multiple: false,
    filters: [{ name: '章节 Markdown / 文本', extensions: ['md', 'txt'] }],
  });
  if (typeof path !== 'string') return;
  try {
    const md = await readViaRust(path);
    loadText(md, path.slice(path.lastIndexOf('/') + 1), path);
    status('已载入 ' + state.fileName + '。点「▶ 开始质检」。');
  } catch (e) {
    status('读取失败：' + e);
  }
});

$('btn-vocab').addEventListener('click', async () => {
  const path = await openFileDialog({
    multiple: false,
    filters: [{ name: '词库 CSV', extensions: ['csv'] }],
  });
  if (typeof path !== 'string') return;
  try {
    state.vocabCsvText = await readViaRust(path);
    state.vocabName = path.slice(path.lastIndexOf('/') + 1);
    if (state.md) renderReader();
    setStatusSummary();
  } catch (e) {
    status('读取失败：' + e);
  }
});

$('btn-terms').addEventListener('click', async () => {
  const path = await openFileDialog({
    multiple: false,
    filters: [{ name: '术语表 TXT（一行一词）', extensions: ['txt'] }],
  });
  if (typeof path !== 'string') return;
  try {
    state.termsText = await readViaRust(path);
    if (state.md) renderReader();
    setStatusSummary();
  } catch (e) {
    status('读取失败：' + e);
  }
});

$('btn-run').addEventListener('click', () => void runQcAndReport());
