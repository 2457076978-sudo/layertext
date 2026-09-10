/**
 * AI 助手域（WP-F 拆分）：右侧对话（SSE 流式+工具循环≤8轮）/ 本地 QC 工具协议 / 对话历史自动压缩 /
 * 会话防抖落盘恢复 / 终审门禁说明弹层 —— 从 main.ts 整块迁出，行为零变化。
 */

import { invoke } from '@tauri-apps/api/core';
import { S, esc } from './state.js';
import { $, setStatus } from './uikit.js';
import { activeSession } from './main.js';
import { buildLexiconNow } from './lexicon.js';
import { renderReportPane } from './report.js';
import { showAiSettings } from './settings.js';
import { acceptSuggestion, attachInlineSuggestions, checkRev, locateSent, renderSuggestions } from './aiflow.js';
import { runQc } from '../../src/core/qc.js';
import { extractParas, hit, sentsOf, splitChapter, tokenizeTxt } from '../../src/core/textpipe.js';
import { sentenceRisks } from '../../src/core/risks.js';
import { buildAssistantPrompt, buildSystemPrompt, callChat, chatStream, simplifyMaxLen } from './ai.js';
import { chnoFromPath, estTokens, findOriginalFlex, planCompaction } from './pure.js';
import { GATE_HELP, typeLabel, type Suggestion } from './types.js';

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

export async function restoreChat(): Promise<void> {
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

export function chatRender(): void {
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

/* 侧栏三页切换（审校 / 编辑 / AI 助手）——编辑页由 showSentenceEditor 在打开句子时自动切入 */
export function switchSide(name: 'review' | 'edit' | 'ai'): void {
  $('side-tab-review').classList.toggle('active', name === 'review');
  $('side-tab-edit').classList.toggle('active', name === 'edit');
  $('side-tab-ai').classList.toggle('active', name === 'ai');
  ($('side-review') as HTMLElement).style.display = name === 'review' ? '' : 'none';
  ($('side-edit') as HTMLElement).style.display = name === 'edit' ? '' : 'none';
  ($('side-ai') as HTMLElement).style.display = name === 'ai' ? 'flex' : 'none';
}
$('side-tab-review').addEventListener('click', () => switchSide('review'));
$('side-tab-edit').addEventListener('click', () => switchSide('edit'));
$('side-tab-ai').addEventListener('click', () => switchSide('ai'));

/* ---------- 门禁说明弹层 ---------- */

export const gatePop = $('gate-pop');

export function hideGatePop(): void {
  gatePop.classList.remove('open');
}

export function showGateHelp(gate: string, anchor: HTMLElement): void {
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
