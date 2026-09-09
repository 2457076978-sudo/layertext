/**
 * 报告视图域（WP-F 拆分）：质检报告/初步诊断台（生词难句清单+AI 摘情节要点）/ 复盘（台账聚合）/
 * 诊断包导出 / 版本对比 / 双栏逐句对照 / 书级审校看板 / 审校过程档案 —— 从 main.ts 整块迁出，行为零变化。
 */

import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { open as openFileDialog, save as saveFileDialog } from '@tauri-apps/plugin-dialog';
import { zipSync, strToU8 } from 'fflate';
import { S, esc } from './state.js';
import { $, setStatus } from './uikit.js';
import {
  activeSession,
  addMark,
  buildLexiconNow,
  bufToB64,
  chatUntilJson,
  docxToText,
  mergedSelection,
  openPathIntoSession,
  readTextSmart,
  renderAll,
  sidebarHandlers,
  tocChapters,
} from './main.js';
import { renderDiffPane } from './widgets.js';
import { scheduleSave, renderSidebar } from './review.js';
import { GATES, newMarkId, typeLabel, type FileSession } from './types.js';
import {
  alignSentencePairs,
  boardSummary,
  buildChapterDossierMd,
  buildDiagSummary,
  dossierFileName,
  mergeQuotaTexts,
  normalizeAndSplitChapters,
  pickSentMarkType,
  workspaceChipName,
  type DossierData,
  type QcSummaryLite,
} from './pure.js';
import { runQc, toLegacyReport } from '../../src/core/qc.js';
import { aggregate, diagnose, parseLedger, type LedgerRow } from '../../src/core/adoption.js';
import { summarizeCost } from '../../src/core/aiops.js';
import { showAiSettings } from './settings.js';
import { buildPlotPointsPrompt, simplifyMaxLen } from './ai.js';
import { extractParas, sentsOf, splitChapter, tokenizeTxt } from '../../src/core/textpipe.js';
import { sentenceRisks } from '../../src/core/risks.js';

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

export function renderReportPane(s: FileSession): void {
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

/* ---------- 复盘（W2 数据闭环）：读 AI建议台账 → 采纳率聚合 ---------- */

const pct = (x: number | null): string => (x === null ? '—' : (x * 100).toFixed(0) + '%');

export async function renderRetroPane(): Promise<void> {
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


/* ---------- 诊断包与本地错误日志（W5：零遥测——只写本机，导出自愿） ---------- */

/** 前端未捕获错误 → 本地错误日志（轮转保留 5 份，见 main.rs append_log） */
function reportError(kind: string, e: unknown): void {
  const detail = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
  void invoke('append_log', { lines: `[${kind}] ${detail}\n` }).catch(() => undefined);
}

window.addEventListener('error', (ev) => reportError('window-error', ev.error ?? ev.message));
window.addEventListener('unhandledrejection', (ev) => reportError('unhandled-rejection', (ev as PromiseRejectionEvent).reason));

/** 导出诊断包 zip：配置摘要(不含文本) + 错误日志 + 成本台账（用户自愿发给别人定位问题用） */
export async function exportDiagnostics(): Promise<void> {
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
export function simulateError(): void {
  try {
    throw new Error('自检错误（人为制造，用于验证诊断包含错误日志）：如果诊断包里的 错误日志.log 看到这条，链路正常');
  } catch (e) {
    reportError('self-test', e);
  }
  setStatus('已写入一条测试错误——点「帮助 → 导出诊断包…」，打开 zip 里的 错误日志.log 应能看到这条记录', 'saved');
}

/* ---------- 版本对比（渲染实现已抽至 widgets.ts renderDiffPane，可 DOM 级测试） ---------- */

export function renderDiff(lIdx: number, rIdx: number): void {
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

export function renderAlignPane(): void {
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

export async function renderBoardPane(): Promise<void> {
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

export async function renderDossierPane(): Promise<void> {
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
