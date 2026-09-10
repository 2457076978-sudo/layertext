/**
 * 定向复习域（2026-09-10）：把学校作业/教材内容改写成定向复习材料——
 * 词汇置换到班级词库口径 + 队列词定向复现（组合拳"生成侧注入"落地）+ 目标语法点自然融入。
 * 复用「AI 简化本章」的逐段管线形态；勾选的目标结构在完成摘要里从"黑名单"翻转为"达成计数"。
 */

import { invoke } from '@tauri-apps/api/core';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { S, esc } from './state.js';
import { $, setStatus } from './uikit.js';
import { addSession, runQcCurrent } from './main.js';
import { readChapterRaw } from './batch.js';
import { showAiSettings } from './settings.js';
import { buildLexiconNow, reinforceWordsNow } from './lexicon.js';
import { buildRevSystemPrompt, callChat, simplifyMaxLen } from './ai.js';
import { splitChapter } from '../../src/core/textpipe.js';
import { runQc } from '../../src/core/qc.js';
import { normalizeAndSplitChapters } from './pure.js';

/** 初中常见语法点（engine 标记的三项可自动计数，其余教师过目） */
const GRAMMAR_POINTS: { key: string; label: string; engine?: 'passive' | 'relcl' | 'pastperf' }[] = [
  { key: 'present', label: '一般现在时' },
  { key: 'past', label: '一般过去时' },
  { key: 'progressive', label: '现在进行时' },
  { key: 'future', label: '一般将来时' },
  { key: 'present-perfect', label: '现在完成时' },
  { key: 'passive', label: '被动语态', engine: 'passive' },
  { key: 'comparative', label: '比较级/最高级' },
  { key: 'modal', label: '情态动词' },
  { key: 'object-clause', label: '宾语从句' },
  { key: 'relcl', label: '定语从句（挑战）', engine: 'relcl' },
];

function revPopEl(): HTMLElement {
  let el = document.getElementById('rev-pop');
  if (!el) {
    el = document.createElement('div');
    el.id = 'rev-pop';
    document.body.appendChild(el);
  }
  return el;
}

let revAbort: AbortController | null = null;

export function showRevPop(): void {
  const queue = reinforceWordsNow();
  const p = revPopEl();
  p.innerHTML = `
    <div class="pop-h"><svg class="ico"><use href="#i-sparkle"/></svg>定向复习材料 · 作业/教材 → 复现注入 + 语法点</div>
    <p class="dim" style="font-size:12px;line-height:1.8;margin:4px 0 8px">
      把<b>学校作业 / 教材段落</b>粘进来（或选文件），改写成复习材料：词汇置换到班级词库口径（超纲词换已学词）、
      <b>队列词定向复现 8~12 个</b>、勾选的<b>目标语法点自然融入</b>。生成后进新 tab，可标记精修、导出 Word。
      词库口径：课标1600${S.vocabCsvText ? ` + ${esc(S.vocabName ?? '自定义词库')}` : ''}。</p>
    <div class="fld"><label>① 教学材料（粘贴，或选文件 txt/md/docx）</label>
      <textarea id="rev-text" rows="7" style="width:100%;font-size:13px;line-height:1.7;border:1px solid var(--line);border-radius:8px;padding:6px 8px;box-sizing:border-box" placeholder="粘贴教材段落 / 学校作业……"></textarea>
      <div class="row-btns" style="margin-top:4px"><button id="rev-file">选文件…</button><span class="dim" id="rev-file-name" style="align-self:center"></span></div></div>
    <div class="fld"><label>② 复习词表（自动带出复现队列${queue ? ` ${queue.length} 词` : '（未启用）'}；可补充，逗号或换行分隔）</label>
      <textarea id="rev-words" rows="2" style="width:100%;font-size:12px;border:1px solid var(--line);border-radius:8px;padding:4px 6px;box-sizing:border-box">${esc((queue ?? []).join(', '))}</textarea></div>
    <div class="fld"><label>③ 目标语法点（勾选=复习材料里要自然出现的结构；未勾的被动/定语从句照常避免）</label>
      <div style="display:flex;flex-wrap:wrap;gap:4px 10px;font-size:12px">
        ${GRAMMAR_POINTS.map((g) => `<label style="white-space:nowrap"><input type="checkbox" data-gr="${g.key}" style="width:auto" /> ${g.label}${g.engine ? '<span class="dim">（自动计数）</span>' : ''}</label>`).join('')}
      </div></div>
    <div class="fld"><label>④ 教师指令（可选，最高优先级）</label>
      <input id="rev-inst" placeholder="如：围绕 Unit 2 话题；控制在 200 词内；只复现带☆的词" style="width:100%" /></div>
    <div class="row-btns" style="margin-top:8px">
      <button id="rev-run" class="primary">生成复习材料</button>
      <button id="rev-cancel" style="display:none">取消</button>
      <button id="rev-close">关闭</button>
    </div>
    <div id="rev-progress" style="display:none">
      <div id="rev-step" class="dim" style="margin-top:8px"></div>
      <div class="bar"><i id="rev-bar"></i></div>
    </div>`;
  p.classList.add('open');
  p.querySelector('#rev-close')?.addEventListener('click', () => {
    revAbort?.abort();
    p.classList.remove('open');
  });
  p.querySelector('#rev-cancel')?.addEventListener('click', () => revAbort?.abort());
  p.querySelector('#rev-file')?.addEventListener('click', async () => {
    const path = await openFileDialog({ multiple: false, filters: [{ name: '教学材料', extensions: ['txt', 'md', 'markdown', 'docx'] }] });
    if (typeof path !== 'string' || !path) return;
    try {
      (p.querySelector('#rev-text') as HTMLTextAreaElement).value = await readChapterRaw(path);
      (p.querySelector('#rev-file-name') as HTMLElement).textContent = path.slice(path.lastIndexOf('/') + 1);
    } catch (e) {
      setStatus('读取失败：' + e, 'err');
    }
  });
  p.querySelector('#rev-run')?.addEventListener('click', () => void runRevMaterial());
}

function cleanRevSeg(text: string, fallbackMarker: string): string {
  let t = text.trim();
  t = t.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '');
  if (!t.includes('[P')) t = fallbackMarker + ' ' + t;
  return t.trim();
}

async function runRevMaterial(): Promise<void> {
  const p = revPopEl();
  const raw = (p.querySelector('#rev-text') as HTMLTextAreaElement)?.value.trim() ?? '';
  if (!raw) {
    setStatus('先粘贴教学材料（或选文件）', 'err');
    return;
  }
  const key = await invoke<string>('load_api_key');
  if (!key) {
    setStatus('生成复习材料需要先配置 AI（菜单 LayerText → AI 设置…）', 'err');
    showAiSettings();
    return;
  }
  const words = [
    ...new Set(
      ((p.querySelector('#rev-words') as HTMLTextAreaElement)?.value ?? '')
        .split(/[,，\n、]+/)
        .map((w) => w.trim())
        .filter(Boolean),
    ),
  ];
  const grammar = GRAMMAR_POINTS.filter((g) => (p.querySelector(`[data-gr="${g.key}"]`) as HTMLInputElement | null)?.checked);
  const instructions = (p.querySelector('#rev-inst') as HTMLInputElement)?.value.trim() ?? '';

  // 归一化成章节格式（教材/作业常无 [P##] 标记——与导入同款包装）
  const { chapters } = normalizeAndSplitChapters(raw, '复习材料');
  const md = chapters.map((c) => c.md).join('\n\n');
  const chLine = md.match(/^## Chapter \w+.*$/m)?.[0] ?? '## Chapter One';
  const header = md.slice(0, md.indexOf(chLine)) || '';
  const segs = splitChapter(md).body.match(/\[P\d+\][\s\S]*?(?=\[P\d+\]|$)/g) ?? [];
  if (segs.length === 0) {
    setStatus('材料解析不出段落（粘贴后自动分段失败）——检查内容', 'err');
    return;
  }

  const system = await buildRevSystemPrompt({
    words: words.length ? words.join(', ') : '（无指定词——只按词库口径置换）',
    grammar: grammar.length ? grammar.map((g) => g.label).join('、') : '（无目标语法——常规难度即可）',
    instructions: instructions || '（无）',
    vocabRule: `班级词库口径：超出已学词表的词换成课标内/已学词；平均句长 ≤${simplifyMaxLen()} 词。`,
  });

  revAbort = new AbortController();
  const runBtn = p.querySelector('#rev-run') as HTMLButtonElement;
  runBtn.disabled = true;
  (p.querySelector('#rev-cancel') as HTMLElement).style.display = '';
  p.querySelector('#rev-progress')!.setAttribute('style', '');
  const out: string[] = [];
  let tokens = 0;
  try {
    for (let i = 0; i < segs.length; i++) {
      ($('rev-step') as HTMLElement).textContent = `正在改写第 ${i + 1}/${segs.length} 段（${segs[i].slice(0, 10).trim()}…）`;
      ($('rev-bar') as HTMLElement).style.width = `${(i / segs.length) * 100}%`;
      const prevTail = out.length ? out[out.length - 1].slice(-400) : '（材料开头）';
      const { content, usage } = await callChat(
        [
          { role: 'system', content: system },
          {
            role: 'user',
            content: `前文（已改写，供语气与指代衔接参考）：\n…${prevTail}\n\n请改写以下教学材料段落（保留段标记、定向复现与目标语法按总则执行）：\n${segs[i].trim()}`,
          },
        ],
        2500,
        revAbort.signal,
        '定向复习材料',
      );
      tokens += Number(usage.match(/(\d+) 出/)?.[1] ?? 0);
      out.push(cleanRevSeg(content, segs[i].match(/\[P\d+\]/)![0]));
    }
    ($('rev-bar') as HTMLElement).style.width = '100%';
    $('rev-step').textContent = '生成完毕，正在保存与体检…';

    const newMd = `${header}${chLine}\n\n${out.join('\n\n')}\n`;
    const date = new Date().toLocaleDateString('sv-SE');
    const srcName = ((p.querySelector('#rev-file-name') as HTMLElement)?.textContent || '材料').replace(/\.(txt|md|markdown|docx)$/i, '');
    const dir = await invoke<string>('reports_dir');
    const outPath = `${dir}/复习_${srcName}_${date}.md`;
    await invoke('write_text_file', { path: outPath, content: newMd });
    p.classList.remove('open');

    // 目标达成摘要：勾选的结构从黑名单翻转为计数（引擎三项）；其余语法点教师过目
    const report = runQc(newMd, buildLexiconNow(), { tier: 'M', fileName: '复习材料', ...(reinforceWordsNow() ? { reinforceWords: reinforceWordsNow()! } : {}) });
    const goalBits: string[] = [];
    for (const g of grammar) {
      if (g.engine === 'passive') goalBits.push(`被动 ✓${report.passive} 处`);
      if (g.engine === 'relcl') goalBits.push(`定从 ✓${report.relcl} 处`);
      if (g.engine === 'pastperf') goalBits.push(`过去完成 ✓${report.pastperf} 处`);
    }
    await addSession(newMd, outPath.slice(outPath.lastIndexOf('/') + 1), outPath, { noAutoQc: true });
    await runQcCurrent();
    setStatus(
      `复习材料已生成（${segs.length} 段，约 ${tokens} 出tokens）：${outPath}——体检见报告页` +
        (goalBits.length ? `；目标语法达成：${goalBits.join('、')}（报告页按通用口径仍标难句，以本提示为准）` : '；未勾选可引擎计数的目标语法（其余语法点请过目）'),
      'saved',
    );
    void invoke('reveal_path', { path: outPath });
  } catch (e) {
    $('rev-step').textContent = '✗ 中断：' + e;
  } finally {
    runBtn.disabled = false;
    (p.querySelector('#rev-cancel') as HTMLElement).style.display = 'none';
    revAbort = null;
  }
}
