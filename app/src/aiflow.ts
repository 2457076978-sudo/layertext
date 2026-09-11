/**
 * AI 建议流域（WP-F 拆分）：按标记修改（分批）/建议采纳与直改/行内建议挂载/建议页/
 * 单句改写/键盘建议流（N/Enter/X）/建议台账 —— 从 main.ts 整块迁出，行为零变化。
 */

import { invoke } from '@tauri-apps/api/core';
import { S, esc } from './state.js';
import { $, setStatus, toast, pop, hidePop, showSummaryPop } from './uikit.js';
import { activeSession, flashApplied, persistEdit, chatUntilJson, switchView } from './main.js';
import { renderReader, sidebarHandlers, updateMarkBadge } from './reader.js';
import { renderSidebar, scheduleSave } from './review.js';
import { CHANGELOG_HEADER, typeLabel, type FileSession, type Mark, type Suggestion } from './types.js';
import { csvCell, estTokens, hasProseChinese, locateOriginal, normalizeZhNotes, pickSingleRewrite, remapWarns, resolveSuggestionTarget, stripMarkdownNoise, remapMarks, validSuggestionText } from './pure.js';
import { extractParas, sentsOf, splitChapter } from '../../src/core/textpipe.js';
import { checkRevisedText } from './pure.js';
import type { LedgerRow } from '../../src/core/adoption.js';
import { LEDGER_HEADER, toLedgerLine } from '../../src/core/adoption.js';
import { sentenceRisks } from '../../src/core/risks.js';
import { buildSystemPrompt, buildRewriteSentencePrompt, promptSetVersion, simplifyMaxLen } from './ai.js';
import { RULE_BY_TYPE, appendCsvLine } from './main.js';
import { showAiSettings } from './settings.js';
import { applyZhAnnotations, applyWordSimplifications } from './pipew.js';
import { buildAppPolicy } from './rewritegate.js';
import { checkRewrite } from '../../src/core/rewrite.js';
import { findProjectConfig } from './datapanel.js';

export /**
 * 请求 AI 修订候选。
 * instruction 传入 = 会话式追问（携带 S.aiHistory，AI 知道上一轮建议过什么、你否决了什么）；
 * 不传 = 全新请求（上下文来自本地文件：标记清单+当前文本句子），并重建 S.aiHistory。
 */
function buildAiUserPrompt(session: FileSession, subset?: Mark[]): string {
  const body = splitChapter(session.md).body;
  const paras = extractParas(body);
  const maxLen = simplifyMaxLen();
  const r = session.report;
  const marks = (subset ?? session.review.marks)
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

/** 在正文中唯一定位原句（实现已抽至 pure.ts locateOriginal，此处按会话包装） */
export function locateSent(session: FileSession, original: string): { pi: number; si: number } | null {
  return locateOriginal(session.md, original);
}

/**
 * 把一条改写候选送进**与批量管线同一个**门禁。
 *
 * 成本策略（v4 方向："合并契约与门禁，分离上下文与成本"）：
 * App 不背 19.6k tokens 的全量开场，只组一份**局部切片**——
 * 本书专名 + 本句命中的那几条释义 + 已注词账本（账本只在本地判定用，不进 prompt）。
 * 缺什么由 `missingPolicy` 如实报出来，而不是假装查过。
 */
async function gateRewriteCandidate(revised: string, source: string) {
  const s = activeSession();
  if (!s) return null;
  try {
    const cfg = s.sourcePath ? (await findProjectConfig(s.sourcePath.replace(/\/[^/]*$/, '')))?.config ?? null : null;
    const { policy } = await buildAppPolicy({
      currentText: s.md,
      sourcePath: s.sourcePath ?? null,
      known: S.currentKnown,
      properNames: S.properRows,
      config: cfg,
      tier: '自定义',
      maxLen: simplifyMaxLen(),
      involved: [...new Set((source + ' ' + revised).match(/[A-Za-z][A-Za-z'-]*/g) ?? [])],
    });
    // promptSetVersion 是异步的（要读提示词文件）——先取出来，别把 Promise 塞进 traceId
    const promptVersion = await promptSetVersion();
    return checkRewrite(
      {
        source,
        intent: '单句改写',
        scope: 'sentence',
        tier: '自定义',
        bookVersion: s.sourcePath ?? 'unsaved',
        promptVersion,
      },
      policy,
      revised,
    );
  } catch {
    // 门禁自身出错**不允许**变成"放行"：宁可退回建议页让人看，也不静默写正文
    setStatus('⚠ 改写门禁未能运行（本地检查出错），本条只进建议页、不直写正文', 'err');
    return null;
  }
}

/** 改写文本复核（多句拆分逐句检测，超长=最长一句超限） */
export function checkRev(revised: string): Suggestion['check'] {
  return checkRevisedText(revised, simplifyMaxLen(), (sent, m) => {
    const r = sentenceRisks(sent, m);
    return { passive: r.passive, relcl: r.relcl, pastperf: r.pastperf, overlong: r.overlong };
  });
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

export async function aiSuggest(instruction?: string): Promise<void> {
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
    let raw: { id: string; type?: string; original?: string; revised?: string; basis?: string; alternative?: string }[] = [];
    let usage = '';
    if (instruction && S.aiHistory.length > 0) {
      S.aiHistory.push({ role: 'user', content: instruction + '\n\n请基于我们之前的对话重新输出完整的 JSON 数组（含未改动条目，original 用当前正文原句）。' });
      const messages = [{ role: 'system', content: system }, ...S.aiHistory];
      const estIn = messages.reduce((n, m) => n + estTokens(m.content), 0);
      setStatus(`本次请求约 ${estIn} tokens 输入（只含标记相关句子，不发全章原文）…`);
      const r1 = await chatUntilJson(messages, 6000, '审核建议');
      raw = r1.raw as typeof raw;
      usage = r1.usage;
    } else {
      const sentMarks = s.review.marks.filter((m) => m.type !== 'zh' && m.type !== 'anchor' && !(m.type === 'simpl' && m.level !== 'sent'));
      const BATCH = 10;
      if (sentMarks.length > BATCH) {
        // 大批量分批：单次 6000 token 输出上限曾被思考型模型占满截断——每批 10 条标记独立请求，进度可见
        const batches: Mark[][] = [];
        for (let i = 0; i < sentMarks.length; i += BATCH) batches.push(sentMarks.slice(i, i + BATCH));
        for (let bi = 0; bi < batches.length; bi++) {
          setStatus(`AI 批量修订：第 ${bi + 1}/${batches.length} 批（共 ${sentMarks.length} 条标记，分批防输出截断）…`);
          const userMsg = buildAiUserPrompt(s, batches[bi]);
          const rb = await chatUntilJson(
            [
              { role: 'system', content: system },
              { role: 'user', content: userMsg },
            ],
            6000,
            `审核建议 ${bi + 1}/${batches.length}`,
          );
          raw = raw.concat(rb.raw as typeof raw);
          usage = rb.usage;
        }
        S.aiHistory = [{ role: 'user', content: buildAiUserPrompt(s, sentMarks.slice(0, BATCH)) }];
      } else {
        const userMsg = buildAiUserPrompt(s);
        S.aiHistory = [{ role: 'user', content: userMsg }];
        const estIn = estTokens(system) + estTokens(userMsg);
        setStatus(`本次请求约 ${estIn} tokens 输入（只含标记相关句子，不发全章原文）…`);
        const r2 = await chatUntilJson(
          [
            { role: 'system', content: system },
            { role: 'user', content: userMsg },
          ],
          6000,
          '审核建议',
        );
        raw = r2.raw as typeof raw;
        usage = r2.usage;
      }
    }
    S.aiHistory.push({ role: 'assistant', content: JSON.stringify(raw) });
    // AI 边界 #21：revised/original 必须是单一非空字符串——数组（多条变体）/对象/空串一律拒收并明示
    let schemaRejected = 0;
    S.suggestions = raw
      .filter((x) => {
        if (!validSuggestionText(x.revised) || !validSuggestionText(x.original)) {
          schemaRejected++;
          return false;
        }
        return true;
      })
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
    if (schemaRejected > 0) {
      setStatus(`已拒收 ${schemaRejected} 条不合规建议（AI 返回了多条变体或非文本字段，schema 约定为单条）——其余正常处理，可点「重新请求 AI」重试`, 'err');
      toast(`已拒收 ${schemaRejected} 条不合规建议（多条变体/非文本）`, 'info');
    }
    if (S.appConfig.autoRewriteOnMark && S.suggestions.length > 0) {
      // 全局直改：能定位的建议直接生效（写工作稿+日志；⚠︎ 复核项计数提醒复查）；
      // 定位失败的自动落入「修订建议」页逐条待人工采纳——建议不因直改失败而丢失
      let warned = 0;
      let applied = 0;
      let cnBlocked = 0;
      // 组撤销：批量 N 条合并为一条基线快照（此前撤一批要点 N 次 ↩︎ 且 50 条栈会滚掉早期记录）
      const undoBaseline = s.md;
      const undoLen = s.undoStack?.length ?? 0;
      for (const g of [...S.suggestions]) {
        if (g.check.passive || g.check.relcl || g.check.pastperf || g.check.overlong) warned++;
        if (hasProseChinese(g.revised)) {
          cnBlocked++; // AI 输出了中文说明/翻译（如"（标注：…）"）——拒写正文，留在建议页人工看
          continue;
        }
        if (await acceptSuggestion(g, { scene: '自动直改', outcome: '直改' })) applied++;
      }
      if (applied > 1 && s.undoStack && s.undoStack.length > undoLen) {
        s.undoStack.length = undoLen;
        s.undoStack.push(undoBaseline);
        if (s.undoStack.length > 50) s.undoStack.shift();
      }
      const leftover = S.suggestions.length;
      if (leftover > 0) renderSuggestions();
      setStatus(`AI 直改完成：应用 ${applied} 条${warned ? ` · ⚠${warned} 条需复核` : ''} ${usage}`, 'saved');
      showSummaryPop(`
        <div class="pop-h">批量执行总结</div>
        <table class="gtable">
          <tr><td>已应用（写入正文）</td><td><b>${applied}</b> 条</td></tr>
          ${warned ? `<tr class="warnrow"><td>⚠ 引擎复核残留（黑名单/超长，已留痕建议复查）</td><td><b>${warned}</b> 条</td></tr>` : ''}
          ${cnBlocked ? `<tr class="warnrow"><td>拦下（含中文说明文字，未写正文）</td><td><b>${cnBlocked}</b> 条</td></tr>` : ''}
          ${leftover ? `<tr><td>未应用（定位失败等）→ 已放「修订建议」页</td><td><b>${leftover}</b> 条</td></tr>` : ''}
          <tr><td>token 用量</td><td>${esc(usage)}</td></tr>
        </table>
        <div class="pop-btns" style="margin-top:10px">
          ${leftover || cnBlocked ? '<button id="sum-suggest" class="primary">打开「修订建议」页</button>' : ''}
          <button id="sum-close">关闭</button>
        </div>`);
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

export async function acceptSuggestion(g: Suggestion, opts: { scene?: string; outcome?: '采纳' | '直改' } = {}): Promise<boolean> {
  const scene = opts.scene ?? '行内';
  const outcome = opts.outcome ?? '采纳';
  const s = activeSession();
  if (!s) return false;
  // AI 边界 #18：每条建议独立定位（同句多条互不依赖——第一条改完后第二条按自己 original 重新定位，
  // 失败落「修订建议」页，绝不写错位置），决策逻辑在 pure.resolveSuggestionTarget（有显式测试锁定）
  const target = resolveSuggestionTarget(s.md, { pi: g.pi, si: g.si, original: g.original });
  if (!target) {
    setStatus(`正文中找不到该原句，已跳过（留在「修订建议」页）：${g.original.slice(0, 24)}…`, 'err');
    return false;
  }
  g.pi = target.pi;
  g.si = target.si;
  g.original = target.original;
  g.revised = normalizeZhNotes(g.revised); // 生词注释统一全角紧贴（word（中文））
  s.md = s.md.slice(0, target.at) + g.revised + s.md.slice(target.at + g.original.length);

  // 标记对齐 + 对应标记清除 + 落盘
  const removed = s.review.marks.filter((m) => m.id === g.markId);
  s.review.marks = s.review.marks.filter((m) => m.id !== g.markId);
  // 词被本次改写替换掉的词标记一并完成（如 bleated→made soft sounds 后，bleated 标记不再残留成幽灵）
  s.review.marks = s.review.marks.filter((m) => !(m.level === 'word' && m.word && g.original.includes(m.word) && !g.revised.includes(m.word)));
  remapMarks(s.review.marks, s.md);
  s.review.warns = remapWarns(s.review.warns, s.md);
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
    const stillBad = [
      g.check.passive ? '被动' : '',
      g.check.relcl ? '定从' : '',
      g.check.pastperf ? '过去完成' : '',
      g.check.overlong ? `超长(${g.revised.split(/\s+/).filter(Boolean).length}词)` : '',
    ].filter(Boolean);
    if (stillBad.length) {
      const pos = `${g.pi ?? 0}:${g.si ?? 0}|`;
      s.review.warns = [...(s.review.warns ?? []).filter((x) => !x.startsWith(pos)), `${pos}${g.original.slice(0, 60)}|${stillBad.join('/')}`];
      toast(`⚠︎ 新句仍含${stillBad.join('/')}——正文已按建议写入，句旁已挂 ⚠︎ 角标（点角标消除；↩︎ 可撤销）`, 'info');
    }
    flashApplied(g.revised);
    return true;
  } catch (e) {
    setStatus('落盘失败：' + e, 'err');
    return false;
  }
}

export function renderSuggestions(): void {
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

/** 为 pending 建议挂行内（不唯一匹配的只进修订建议表） */
export function attachInlineSuggestions(): void {
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
  // 自解释（交互标准 A1/A4）：黄句+绿字必须自己说明"这是建议、还没改正文、怎么处理"——不靠猜
  (sentEl as HTMLElement).title = '黄色=这句有 AI 修改建议（正文还没改）——看下方绿字，点 ✓ 采纳或 ✗ 放弃';
  const bad = g.check.passive || g.check.relcl || g.check.pastperf || g.check.overlong;
  const div = document.createElement('span');
  div.className = 'inline-sug';
  div.dataset.markId = g.markId;
  div.innerHTML = `
    <span class="sug-tag">AI 修改建议（未改正文，等你确认）</span>
    <span class="rev-text">${esc(g.revised)}</span>
    ${bad ? `<span class="sug-warn">⚠︎ 引擎复核：仍含${[g.check.passive ? '被动' : '', g.check.relcl ? '定从' : '', g.check.pastperf ? '过去完成' : '', g.check.overlong ? '超长' : ''].filter(Boolean).join('/')}</span>` : ''}
    <span class="sug-basis">${esc(g.basis)}${g.alternative ? '｜备选：' + esc(g.alternative) : ''}</span>
    <button class="btn-ok" title="用上面的绿字替换黄句（写入正文+变更日志，首改前自动备份，↩︎ 可撤销）">✓ 采纳（写入正文，可撤销）</button>
    <button class="btn-no" title="不要这条建议，黄色消失，正文不动">✗ 放弃</button>`;
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

function checkLabel(c: Suggestion['check']): string {
  const bad: string[] = [];
  if (c.passive) bad.push('被动');
  if (c.relcl) bad.push('定从');
  if (c.pastperf) bad.push('过去完成');
  if (c.overlong) bad.push('超长');
  return bad.length ? `<span class="warn-badge">⚠︎ 仍含${bad.join('/')}</span>` : '<span class="ok-badge">✓ 复核通过</span>';
}

export async function aiRewriteSentence(pi: number, si: number, intent: string, autoMarkId?: string): Promise<void> {
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
    // AI 边界 #21：schema 约定单对象——AI 擅自返回多条变体让用户选＝拒收（此前静默取第一条）
    const picked = pickSingleRewrite(arrRaw, sent); // original 缺省回退到发出的原句
    if (!picked.ok) {
      const why = picked.reason === 'multi' ? 'AI 返回了多条变体（应为单条），已拒收' : picked.reason === 'empty' ? 'AI 未返回改写' : 'AI 返回的改写字段不是单一文本（多条变体/对象），已拒收';
      throw new Error(why + '——请重试');
    }
    const one = picked;
    const risk = checkRev(one.revised);
    /* ★ 改写门禁（《审查报告 v4_方向》残余 P0）：
     * 原先到这里就直接进正文了，而本地只查了句法黑名单——
     * 于是"改写引入了一个超纲词却没加注""把第 1 章注过的词又注了一遍"
     * "用了和统一词典不一致的释义"这三类不一致**可以静默写进书稿**。
     * 现在：同一套 gateSegment（与批量管线共用），不过就不许直写。 */
    const gate = await gateRewriteCandidate(one.revised, sent);
    const g: Suggestion = {
      markId: autoMarkId ?? 'rw-' + Date.now().toString(36),
      type: intent || '词改写',
      original: one.original ?? sent,
      revised: one.revised,
      basis: one.basis ?? '',
      alternative: one.alternative,
      status: 'pending',
      check: { passive: risk.passive, relcl: risk.relcl, pastperf: risk.pastperf, overlong: risk.overlong },
      gate: gate
        ? {
            status: gate.status,
            traceId: gate.traceId,
            reasons: gate.blockedReasons,
            missingPolicy: gate.missingPolicy,
            warns: gate.checks.warns.map((w) => `${w.ruleId} ${w.message}`),
          }
        : undefined,
    };
    // 未过门禁：即使是"标记即改写"（原本直写）也不许写正文，改走建议页让教师看原因
    if (gate?.status === 'blocked') {
      S.suggestions.push(g);
      hidePop();
      attachInlineSuggestions();
      setStatus(`⛔ 未过门禁，未写入正文：${gate.blockedReasons.join('；')}——已放进「修订建议」页`, 'err');
      return;
    }
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

/** AI 建议台账（W2 数据闭环）：每次建议被 采纳/拒绝/直改 落一行，复盘页与分析脚本据此聚合 */
export async function logSuggestion(s: FileSession, g: Suggestion, outcome: '采纳' | '拒绝' | '直改', scene: string, mark?: Mark): Promise<void> {
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

let sugFocusIdx = -1;

export function focusNextSuggestion(step: number): void {
  const all = [...document.querySelectorAll<HTMLElement>('#reader .inline-sug')];
  if (!all.length) {
    toast('当前没有待确认的建议（行内绿字块）');
    return;
  }
  all.forEach((el) => el.classList.remove('focused'));
  sugFocusIdx = (sugFocusIdx + step + all.length) % all.length;
  const el = all[sugFocusIdx]!;
  el.classList.add('focused');
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  toast(`建议 ${sugFocusIdx + 1}/${all.length} — Enter 采纳 · X 放弃 · N 下一条`);
}

export function suggestionByEl(el: HTMLElement): Suggestion | undefined {
  return S.suggestions.find((x) => String(x.markId) === el.dataset.markId);
}
