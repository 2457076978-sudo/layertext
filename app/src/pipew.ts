/**
 * 确定性管线域（WP-F 拆分）：加中文标注（词典+短语 AI 兜底）/ 词汇简化（映射+子集匹配+同词全换）/
 * 手动改这句（定稿权）/ 跨版本标记同步 / 词库编辑器 —— 从 main.ts 整块迁出，行为零变化。
 */

import { invoke } from '@tauri-apps/api/core';
import { S, esc } from './state.js';
import { $, setStatus, toast, hidePop, showSummaryPop } from './uikit.js';
import { switchSide } from './chat.js';
import { activeSession, renderAll, runQcCurrent, persistEdit, markPathFor, readTextSmart, chatUntilJson, flashApplied } from './main.js';
import { renderReader, sidebarHandlers, updateMarkBadge } from './reader.js';
import { scheduleHeatRail, applyMdSnapshot } from './edit.js';
import { restoreAllMarkDom, renderSidebar, scheduleSave } from './review.js';
import { CHANGELOG_HEADER, newMarkId, type FileSession, type Mark } from './types.js';
import { S as _S } from './state.js';
import {
  annotatedHeadOf,
  csvCell,
  stripWordAnnotations,
  findOriginalFlex,
  glossLookup,
  hasAnyChinese,
  marksSurvivingManualEdit,
  normalizeGlossMap,
  remapMarks,
  remapWarns,
  stripMarkdownNoise,
  morphMismatch,
  syncMarksToMd,
  type SyncPlan,
} from './pure.js';
import { extractParas, sentsOf, splitChapter } from '../../src/core/textpipe.js';
import { sentenceRisks } from '../../src/core/risks.js';
import { simplifyMaxLen } from './ai.js';

/** 「加中文标注」管线：AI 只出 词→中文 映射（一次小调用，零改写风险），
 *  原句逐字保留，机器在标记所在段对该词的词边界出现处插入 词（中文） */
export async function applyZhAnnotations(s: FileSession, marks: Mark[]): Promise<number> {
  const words = [...new Set(marks.map((m) => m.word!).filter(Boolean))];
  const gloss: Record<string, string> = {};
  // 纯本地词典（系统牛津英汉，零网络零 AI）；未收录的词不加注、标记保留给教师自行处理
  let missed: string[] = [];
  try {
    const local = await invoke<(string | null)[]>('dict_lookup_zh', { words });
    missed = [];
    words.forEach((w, i) => {
      if (local[i]) gloss[w] = local[i]!;
      else missed.push(w);
    });
  } catch (e) {
    setStatus('本地词典不可用：' + e, 'err');
    return 0;
  }
  // 短语兜底（09-09 Wayne 授权）：多词短语（如 Seven Commandments）词典无整词条——AI 只出 短语→纯中文(2-6字) 映射，
  // 机器插入、原句不动（同确定性管线思想）。单词仍纯词典零 AI（此前拍板不动）。
  const missedPhrases = missed.filter((w) => /\s/.test(w.trim()));
  let aiNoted = 0;
  if (missedPhrases.length) {
    setStatus(`词典未收 ${missed.length} 个（其中短语 ${missedPhrases.length} 个走 AI 注释兜底）…`);
    try {
      const { raw: praw } = await chatUntilJson(
        [
          {
            role: 'system',
            content:
              '你是短语注释器。给每个英文短语一个准确的中文注释：2-6 个汉字，不含英文、不含拼音、不含标点（如 Seven Commandments→七诫）。只输出一个 JSON 对象 {"短语":"中文"}，键与输入完全一致，不要数组不要解释。',
          },
          { role: 'user', content: missedPhrases.join('\n') },
        ],
        1500,
        '短语注释',
      );
      const pg = normalizeGlossMap(praw);
      for (const w of missedPhrases) {
        const zh = pg[w] ?? pg[w.toLowerCase()] ?? pg[w.replace(/\s+/g, ' ')];
        if (zh && /^[\u4e00-\u9fff]{2,6}$/.test(zh)) {
          gloss[w] = zh;
          aiNoted++;
        }
      }
    } catch {
      /* 有意兜底：这条是"短语走一次额外 AI 注释"的支线，失败就退回原来那条路——
       * 那条路**会把结果说出来**（下面那句"词典未收录 N 个词…（未加注，可在正文手写）"）。 */
    }
  }
  const stillMissed = missed.filter((w) => !gloss[w] && !gloss[w.toLowerCase()] && !gloss[w.replace(/\s+/g, ' ')]);
  if (stillMissed.length)
    setStatus(
      `词典未收录 ${stillMissed.length} 个词：${stillMissed.slice(0, 5).join('、')}${stillMissed.length > 5 ? '…' : ''}（未加注，可在正文手写）${aiNoted ? `；另有 ${aiNoted} 个短语已由 AI 注释兜底（纯中文校验过）` : ''}`,
      'dirty',
    );
  const paras = extractParas(splitChapter(s.md).body);
  const done: string[] = [];
  const corrPairs: { word: string; type: 'zh'; result: string }[] = [];
  for (const m of marks) {
    const w = m.word!;
    const zh = gloss[w] ?? gloss[w.toLowerCase()] ?? gloss[w.replace(/\s+/g, ' ')];
    if (!zh) continue;
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${esc}\\b`, 'i');
    let at = -1;
    let matched = '';
    const para = paras[m.pi] ?? '';
    const hit = re.exec(para);
    if (hit) {
      const pAt = s.md.indexOf(para);
      if (pAt >= 0) {
        at = pAt + hit.index;
        matched = s.md.slice(at, at + hit[0].length);
      }
    }
    if (at < 0) {
      const h2 = re.exec(s.md);
      if (h2) {
        at = h2.index;
        matched = h2[0];
      }
    }
    if (at < 0) continue;
    const after = s.md.slice(at + matched.length, at + matched.length + 1);
    if (after === '（') continue; // 已带注释，跳过
    s.md = s.md.slice(0, at + matched.length) + `（${zh}）` + s.md.slice(at + matched.length);
    s.review.marks = s.review.marks.filter((x) => x.id !== m.id);
    remapMarks(s.review.marks, s.md);
    s.review.warns = remapWarns(s.review.warns, s.md);
    done.push(`${matched}（${zh}）`);
    corrPairs.push({ word: matched, type: 'zh', result: zh });
  }
  if (!done.length) {
    setStatus('没有可插入的中文标注（词已不在正文中或释义缺失）', 'err');
    return 0;
  }
  scheduleSave(s, () => undefined);
  renderReader(s);
  renderSidebar(s, sidebarHandlers);
  updateMarkBadge();
  const date = new Date().toLocaleDateString('sv-SE');
  const outDir = s.sourcePath ? s.sourcePath.slice(0, s.sourcePath.lastIndexOf('/')) : await invoke<string>('reports_dir');
  const logPath = `${outDir}/变更日志_AI审核.csv`;
  try {
    let csv = '';
    try {
      csv = await invoke<string>('read_text_file', { path: logPath });
    } catch {
      /* 有意兜底：变更日志还不存在＝这张表第一次写（读缺失文件本来就是报错的），下面补表头。 */
    }
    if (!csv.trim()) csv = CHANGELOG_HEADER.join(',') + '\n';
    for (const d of done) csv += ['R1', date, `标准${simplifyMaxLen()}词`, '', '', d, d, 'R13', '加中文标注（机器插入，原句不动）', 'AI直改-加注'].map(csvCell).join(',') + '\n';
    await invoke('write_text_file', { path: logPath, content: csv });
  } catch (e) {
    /* 正文**已经改了**（状态行与 toast 都说了"已换词/已加注"），只是变更日志这一行没落上。
     * 那不是"少一条记录"，是这次改动在审计链里根本不存在——必须再见一次光。 */
    toast(`正文已改，但变更日志没写上：${String(e)}——这次改动不会出现在台账/档案里`, 'err');
  }
  flashApplied(done[done.length - 1]);
  setStatus(`已加中文标注 ${done.length} 处（原句未动）：${done.slice(0, 6).join('、')}${done.length > 6 ? '…' : ''}`, 'saved');
  toast(`已加中文标注 ${done.length} 处（原句未动）`, 'ok');
  void propagateCorrection(s, corrPairs);
  return done.length;
}

/** 「词汇简化」管线：词级操作不重构句子——AI 只出 原词→简单词 映射（课标1600内、
 *  保词性与语境形态），机器在该词的词边界处替换，句子其余部分逐字不动 */
export async function applyWordSimplifications(s: FileSession, marks: Mark[]): Promise<void> {
  const uniq = [...new Map(marks.map((m) => [m.word!, m])).values()];
  setStatus(`正在为 ${uniq.length} 个词找课标内简单词（不重构句子）…`);
  const paras = extractParas(splitChapter(s.md).body);
  const gloss: Record<string, string> = {};
  try {
    const { raw } = await chatUntilJson(
      [
        {
          role: 'system',
          content:
            '你是词汇简化器。把每个超纲英文词换成中国《义务教育英语课程标准》三级（约1600词）内的同义简单词：保持词性一致，按所在句的语境给正确形态（时态/单复数）。只输出一个 JSON 对象，键=原词（与输入完全一致），值=简单词，例如 {"cynical": "bitter", "abandoned": "left alone"}。不要输出数组，不要解释文字。',
        },
        { role: 'user', content: uniq.map((m) => `${m.word}\n${(paras[m.pi] ?? '').slice(0, 120)}`).join('\n\n') },
      ],
      2000,
      '词汇简化',
    );
    // #22 根修：parseAiJson 恒返数组（单对象被包一层），Object.assign 只会得到 {0:{…}}——
    // 曾致 AI 给出的简单词全部丢失、每个词都被误判"换不出"而降级加注
    Object.assign(gloss, normalizeGlossMap(raw));
  } catch (e) {
    setStatus('词汇简化获取失败：' + e, 'err');
    return;
  }
  // AI 边界防线：映射值剥 Markdown 记号（#16）；含任何汉字＝AI 把"简单词"答成中文，拒用（#24，曾漏 ≥4 字防线）
  for (const k of Object.keys(gloss)) {
    const v = stripMarkdownNoise(String(gloss[k] ?? ''));
    if (!v || hasAnyChinese(v)) delete gloss[k];
    else gloss[k] = v;
  }
  const done: string[] = [];
  const morphWarn: string[] = [];
  const corrPairs2: { word: string; type: 'simpl'; result: string }[] = [];
  for (const m of uniq) {
    const w = m.word!;
    // #23：AI 常把短语键答成子词（"Seven Commandments"→键只给 "Commandments"）——
    // 子集匹配：键词 ⊆ 标记词 且剩余词全已知 → 值替换整个短语（the Seven Commandments→the rules 成立）
    const found = glossLookup(gloss, w, S.currentKnown);
    const simple = found?.simple;
    if (!simple || simple.toLowerCase() === w.toLowerCase()) continue;
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 换词语义=同词全部出现处都换（注释才是只标首现——教学惯例各异）；段内收集全部命中，段定位失败退全章首现
    const para = paras[m.pi] ?? '';
    let base = -1;
    const hits: { at: number; matched: string }[] = [];
    const reG = new RegExp(`\\b${esc}\\b`, 'gi');
    let mm: RegExpExecArray | null;
    while ((mm = reG.exec(para)) !== null) hits.push({ at: mm.index, matched: mm[0] });
    if (hits.length) base = s.md.indexOf(para);
    if (base < 0) {
      const h2 = new RegExp(`\\b${esc}\\b`, 'i').exec(s.md);
      if (h2) {
        hits.length = 0;
        hits.push({ at: h2.index, matched: h2[0] });
        base = 0;
      }
    }
    if (!hits.length || base < 0) continue;
    let repl = simple;
    let n = 0;
    let firstReplaced = '';
    // 倒序替换（防位移）；已带中文注释的出现处跳过（教师已处理，别让注释悬空）
    for (let i = hits.length - 1; i >= 0; i--) {
      const at = base + hits[i].at;
      const matched = hits[i].matched;
      if (s.md.slice(at + matched.length, at + matched.length + 1) === '（') continue;
      let r = repl;
      if (/^[A-Z]/.test(matched)) r = r.charAt(0).toUpperCase() + r.slice(1); // 保首字母大写形态
      if (morphMismatch(matched, r)) morphWarn.push(`${matched}→${r}`); // AI 边界 #17：词尾形态类不一致，提示复核不拦截
      s.md = s.md.slice(0, at) + r + s.md.slice(at + matched.length);
      if (!firstReplaced) {
        repl = r;
        firstReplaced = matched;
      }
      n++;
    }
    if (n === 0) continue;
    const matched0 = firstReplaced;
    s.review.marks = s.review.marks.filter((x) => x.id !== m.id);
    s.review.marks = s.review.marks.filter((x) => !(x.level !== 'sent' && x.word && x.word.toLowerCase() === w.toLowerCase())); // 同词（词/短语级）其余标记一并完成
    remapMarks(s.review.marks, s.md);
    s.review.warns = remapWarns(s.review.warns, s.md);
    done.push(`${matched0}→${repl}${n > 1 ? `（共${n}处）` : ''}${found?.via === 'subset' ? '（整短语）' : ''}`);
    corrPairs2.push({ word: w, type: 'simpl', result: repl });
  }
  // 整体思想：目标是学生读得懂——换不出更简单的词，就自动降级加中文标注
  const restMarks = marks.filter((m) => s.review.marks.some((x) => x.id === m.id));
  let noted = 0;
  if (restMarks.length) noted = await applyZhAnnotations(s, restMarks);
  if (!done.length && !noted) {
    setStatus('既没有更简单的词、也没能加注（词已不在正文中？）', 'err');
    return;
  }
  scheduleSave(s, () => undefined);
  renderReader(s);
  renderSidebar(s, sidebarHandlers);
  updateMarkBadge();
  const date = new Date().toLocaleDateString('sv-SE');
  const outDir = s.sourcePath ? s.sourcePath.slice(0, s.sourcePath.lastIndexOf('/')) : await invoke<string>('reports_dir');
  const logPath = `${outDir}/变更日志_AI审核.csv`;
  try {
    let csv = '';
    try {
      csv = await invoke<string>('read_text_file', { path: logPath });
    } catch {
      /* 有意兜底：变更日志还不存在＝这张表第一次写（读缺失文件本来就是报错的），下面补表头。 */
    }
    if (!csv.trim()) csv = CHANGELOG_HEADER.join(',') + '\n';
    for (const d of done)
      csv += ['R1', date, `标准${simplifyMaxLen()}词`, '', '', d.split('→')[0], d.split('→')[1], 'R14', '词汇简化（机器词级替换，句子不动）', 'AI直改-换词'].map(csvCell).join(',') + '\n';
    await invoke('write_text_file', { path: logPath, content: csv });
  } catch (e) {
    /* 正文**已经改了**（状态行与 toast 都说了"已换词/已加注"），只是变更日志这一行没落上。
     * 那不是"少一条记录"，是这次改动在审计链里根本不存在——必须再见一次光。 */
    toast(`正文已改，但变更日志没写上：${String(e)}——这次改动不会出现在台账/档案里`, 'err');
  }
  if (done.length) flashApplied(done[done.length - 1].split('→')[1]);
  // 总结面板：换词/降级加注/词形待复核全量明细（此前只有状态行截断前 3 条，长清单看不全）
  showSummaryPop(`
    <div class="pop-h">词汇简化总结</div>
    <table class="gtable">
      <tr><td>已换（写入正文，句子未动）</td><td><b>${done.length}</b> 个</td></tr>
      ${noted ? `<tr><td>换不出更简单词 → 降级加中文标注</td><td><b>${noted}</b> 个</td></tr>` : ''}
      ${morphWarn.length ? `<tr class="warnrow"><td>⚠︎ 词形可能与语境不符（AI 边界 #17：词尾 ed/ing/s/原形类不一致，建议复核）</td><td><b>${morphWarn.length}</b> 处</td></tr>` : ''}
    </table>
    ${done.length ? `<div style="margin-top:8px;font-size:12px;line-height:1.9"><b>换词明细</b><br/>${done.map((d) => '· ' + esc(d)).join('<br/>')}</div>` : ''}
    ${morphWarn.length ? `<div class="dim" style="margin-top:6px;font-size:12px;line-height:1.9">⚠︎ 词形待复核：<br/>${morphWarn.map((d) => '· ' + esc(d)).join('<br/>')}</div>` : ''}
    <div id="sum-prop" class="dim" style="margin-top:6px;font-size:12px;line-height:1.8">⇄ 正在传播到同章其他版本…</div>
    <div class="pop-btns" style="margin-top:10px"><button id="sum-close">关闭</button></div>`);
  setStatus(`已换 ${done.length} 个词（句子未动）${noted ? `；${noted} 个降级加注` : ''}${morphWarn.length ? `；⚠︎ ${morphWarn.length} 处词形待复核（明细见右下总结面板）` : ''}`, 'saved');
  // 传播结果回填总结面板（感知原则：后台自动行为必须在可回看的面板留一行，不允许只有一闪 toast）
  void propagateCorrection(s, corrPairs2).then((msg) => {
    const el = document.getElementById('sum-prop');
    if (el) el.innerHTML = msg ?? '⇄ 无新增传播（本目录无其他版本，或低层已有同词待办）';
  });
}

/** 编辑页即时指标（输入防抖 250ms）：黑名单/超长在保存前就看得见——保存仍按教师定稿写入，仅提示不拦截 */
let editLiveTimer: ReturnType<typeof setTimeout> | null = null;
function renderEditLive(): void {
  const ta = document.getElementById('edit-sent') as HTMLTextAreaElement | null;
  const live = document.getElementById('edit-live');
  if (!ta || !live) return;
  const revised = ta.value.replace(/\s+/g, ' ').trim();
  if (!revised) {
    live.innerHTML = '<span class="warn-badge2">内容为空（保存会提示，不会写入）</span>';
    return;
  }
  const risk = sentenceRisks(revised, simplifyMaxLen());
  const words = revised.split(/\s+/).filter(Boolean).length;
  const bad = [risk.passive ? '被动' : '', risk.relcl ? '定从' : '', risk.pastperf ? '过去完成' : '', risk.overlong ? `超长(${words}词)` : ''].filter(Boolean);
  live.innerHTML = bad.length
    ? `<span class="warn-badge2">⚠ 新句含 ${bad.join(' / ')}</span> <span class="dim">——保存仍按你的定稿写入，此处仅提示</span>`
    : `<span class="ok-badge2">✓ 黑名单干净（${words} 词，上限 ${simplifyMaxLen()}）</span>`;
}

/** 编辑页恢复空态说明（保存/完成后回到这里） */
function resetEditPane(): void {
  document.getElementById('side-edit')!.innerHTML = '<div class="side-empty">句子编辑工作台：正文里点句 → 「✎ 手动改这句」（或按 E 键），这里显示原句上下文＋大编辑框＋改后即时指标</div>';
}

/** 手动改这句（侧栏编辑工作台）：原句+前后文灰显 + 大编辑框 + 即时指标；定稿权在教师 */
export function showSentenceEditor(pi: number, si: number): void {
  const s = activeSession();
  if (!s) return;
  const sents = sentsOf(extractParas(splitChapter(s.md).body)[pi] ?? '', false);
  const sent = sents[si] ?? '';
  if (!sent) return;
  hidePop(); // E 键从标记弹层进来：弹层让位给侧栏工作台
  switchSide('edit');
  const side = document.getElementById('side-edit')!;
  side.innerHTML = `
    <div class="pop-h" style="margin-bottom:6px">手动改这句 <span class="dim" style="font-weight:400">P${String(pi + 1).padStart(2, '0')} · 第${si + 1}句 · 定稿权在你</span></div>
    <div class="pop-info" style="font-size:12px;line-height:1.7">改动直接写入正文（首改自动备份、↩︎ 可撤销、变更日志记"人工修订"），<b>不经引擎复核</b>。保存后自动重新体检。</div>
    <div class="edit-ctx">${esc((sents[si - 1] ?? '').trim())}
      <div class="cur">${esc(sent.trim())}</div>
      ${esc((sents[si + 1] ?? '').trim())}
    </div>
    <textarea id="edit-sent" placeholder="在这里改这一句…">${esc(sent.trim())}</textarea>
    <div class="edit-live" id="edit-live"></div>
    <div class="pop-btns">
      <button id="edit-save" class="primary">保存修改（⌘↵ 写入正文）</button>
      <button id="edit-cancel">完成</button>
    </div>`;
  const ta = side.querySelector('#edit-sent') as HTMLTextAreaElement | null;
  renderEditLive();
  ta?.focus();
  ta?.setSelectionRange(ta.value.length, ta.value.length);
  ta?.addEventListener('input', () => {
    if (editLiveTimer) clearTimeout(editLiveTimer);
    editLiveTimer = setTimeout(renderEditLive, 250);
  });
  ta?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void applyManualSentenceEdit(pi, si);
  });
  side.querySelector('#edit-cancel')?.addEventListener('click', () => {
    switchSide('review');
    resetEditPane();
  });
  side.querySelector('#edit-save')?.addEventListener('click', () => void applyManualSentenceEdit(pi, si));
}

async function applyManualSentenceEdit(pi: number, si: number): Promise<void> {
  const s = activeSession();
  if (!s) return;
  const ta = document.getElementById('edit-sent') as HTMLTextAreaElement | null;
  const revised = (ta?.value ?? '').replace(/\s+/g, ' ').trim();
  const sent = sentsOf(extractParas(splitChapter(s.md).body)[pi] ?? '', false)[si] ?? '';
  if (!ta || !revised) {
    toast('内容为空，未修改');
    return;
  }
  if (revised === sent.trim()) {
    switchSide('review');
    resetEditPane();
    toast('没有变化，正文未动');
    return;
  }
  // 定位原句（与 AI 建议采纳同款：先唯一精确，再空白/连字符宽容匹配）
  let exact: string | null = null;
  const at0 = s.md.indexOf(sent);
  if (at0 >= 0 && s.md.indexOf(sent, at0 + 1) < 0) exact = sent;
  else {
    const flex = findOriginalFlex(s.md, sent);
    if (flex) exact = flex.exact;
  }
  if (!exact) {
    setStatus('正文中定位不到该句（可能刚被其他修改改过）——请重新打开这句再改', 'err');
    return;
  }
  const atExact = s.md.indexOf(exact);
  s.md = s.md.slice(0, atExact) + revised + s.md.slice(atExact + exact.length);
  // 标记存留：该句句级标记随人工修订完成；被改掉的词不再留幽灵标记；其余 remap 重定位
  s.review.marks = marksSurvivingManualEdit(s.review.marks, { pi, si }, exact, revised);
  s.review.warns = (s.review.warns ?? []).filter((x) => !x.startsWith(`${pi}:${si}|`)); // 教师亲手改过=复核完成
  remapMarks(s.review.marks, s.md);
  s.review.warns = remapWarns(s.review.warns, s.md);
  switchSide('review');
  resetEditPane();
  const date = new Date().toLocaleDateString('sv-SE');
  const outDir = s.sourcePath ? s.sourcePath.slice(0, s.sourcePath.lastIndexOf('/')) : await invoke<string>('reports_dir');
  const logPath = `${outDir}/变更日志_AI审核.csv`;
  try {
    const savedTo = await persistEdit(s, s.md);
    let csv = '';
    try {
      csv = await invoke<string>('read_text_file', { path: logPath });
    } catch {
      /* 有意兜底：变更日志还不存在＝这张表第一次写（读缺失文件本来就是报错的），下面补表头。 */
    }
    if (!csv.trim()) csv = CHANGELOG_HEADER.join(',') + '\n';
    csv +=
      [
        'R1',
        date,
        `标准${simplifyMaxLen()}词`,
        `P${String(pi + 1).padStart(2, '0')}`,
        `P${pi + 1}-S${si + 1}`,
        exact.trim(),
        revised,
        'R15',
        '教师手动修订（定稿权，不经引擎复核）',
        '人工矫正-手动改句',
      ]
        .map(csvCell)
        .join(',') + '\n';
    await invoke('write_text_file', { path: logPath, content: csv });
    renderAll();
    flashApplied(revised);
    toast(`正文已改好并写入${savedTo === s.sourcePath ? '原稿' : '工作稿'}（↩︎ 可撤销，日志已记"人工修订"）`, 'ok');
  } catch (e) {
    setStatus('写入失败：' + e, 'err');
    return;
  }
  scheduleSave(s, () => undefined);
  {
    const risk = sentenceRisks(revised, simplifyMaxLen());
    const stillBad = [risk.passive ? '被动' : '', risk.relcl ? '定从' : '', risk.pastperf ? '过去完成' : '', risk.overlong ? `超长(${revised.split(/\s+/).filter(Boolean).length}词)` : ''].filter(
      Boolean,
    );
    if (stillBad.length) toast(`⚠ 你改的新句仍含${stillBad.join('/')}——正文已按你的定稿写入，此处仅提示不拦截`, 'info');
  }
  void runQcCurrent({ auto: true }); // 改完自动重检，报告不滞后
}

export const syncPop = $('sync-pop');

export function hideSyncPop(): void {
  syncPop.classList.remove('open');
}

interface SyncTargetPlan {
  name: string;
  path: string;
  plan: SyncPlan;
}

/** 写入同步计划：已打开会话即时刷新，未打开直接写 _审校标记.json；返回（写盘数, 刷新数） */
export async function applySyncPlans(plans: SyncTargetPlan[]): Promise<{ wrote: number; refreshed: number }> {
  let wrote = 0;
  let refreshed = 0;
  for (const p of plans) {
    if (!p.plan.totalCreated) continue;
    const created = p.plan.items.flatMap((i) => i.created);
    const sess = S.sessions.find((x) => x.sourcePath === p.path);
    if (sess) {
      sess.review.marks.push(...created);
      sess.review.updatedAt = Date.now();
      scheduleSave(sess, () => undefined);
      if (S.sessions[S.activeIdx] === sess) {
        renderSidebar(sess, sidebarHandlers);
        restoreAllMarkDom(sess);
        scheduleHeatRail();
        updateMarkBadge();
      }
      refreshed++;
    } else {
      const markPath = await markPathFor(p.path, p.name);
      const base = { file: p.name, marks: [] as Mark[], quota: [], gate: {}, bookmarks: [], updatedAt: Date.now() };
      let review = base;
      try {
        review = { ...base, ...(JSON.parse(await invoke<string>('read_text_file', { path: markPath })) as typeof base) };
      } catch {
        /* 有意兜底：目标还没有标记文件＝第一次往这个版本同步（缺失文件本来就是报错的），
         * 于是从空基准开始建。 */
      }
      review.marks = [...(review.marks ?? []), ...created];
      review.updatedAt = Date.now();
      await invoke('write_text_file', { path: markPath, content: JSON.stringify(review, null, 1) });
      wrote++;
    }
  }
  return { wrote, refreshed };
}

/** 同目录其他版本 md 文件（同 showSyncMarksDialog 的过滤口径，供传播复用） */
/** 上一次列举"同目录其他版本"失败的原因（成功则为 null）——
 *  它一路走到面板上那句"无新增传播"里，不然读目录失败会被说成"本来就没有别的版本"。 */
let listError: string | null = null;

export async function siblingVersionFiles(sourcePath: string): Promise<{ name: string; path: string }[]> {
  listError = null;
  const dir = sourcePath.slice(0, sourcePath.lastIndexOf('/'));
  let names: string[];
  try {
    names = await invoke<string[]>('list_dir', { dir });
  } catch (e) {
    /* 有意兜底：读不到目录＝这份"可传播版本"列表是空的。空列表与"这本就一章"最后会撞成
     * 同一句话（面板上的"无新增传播"），所以把原因留给 propagateCorrection 去说清楚。 */
    listError = String(e);
    return [];
  }
  return names
    .filter((n) => /\.md$/i.test(n) && `${dir}/${n}` !== sourcePath)
    .filter((n) => !/质检报告|审校档案|全书简化|基准|AI修订|分层初稿|工作稿|原始备份|词句卡/.test(n))
    .map((n) => ({ name: n, path: `${dir}/${n}` }));
}

/**
 * 校正成果跨版本传播（Wayne 09-10："高层次的人工校正改动会更新影响低层次的词库，但仅限于此"）：
 * 高层版本词级校正（换词/加注）定案后，自动把同词同类型标记建到同目录低层版本（幂等，origin=来源版本名），
 * 并沉淀书级 `_校正知识.csv`——**只建标记（待办）+知识留痕，低层正文一律不动**；
 * 低层打开后按自己的口径执行（或忽略）。
 * 返回感知文案（回填总结面板 #sum-prop，"做得好要看得见"）；无传播返回 null。
 */
async function propagateCorrection(s: FileSession, done: { word: string; type: 'simpl' | 'zh'; result: string }[]): Promise<string | null> {
  if (!s.sourcePath || !done.length) return null;
  try {
    const targets = await siblingVersionFiles(s.sourcePath);
    /* 空列表有两种可能，**不能混成一句**：真的没有别的版本，还是目录根本没读进来 */
    if (!targets.length) return listError ? `⇄ 没能传播：同目录其他版本读不到（${listError.slice(0, 80)}）——本版校正已生效，低层版本没收到待办` : null;
    const date = new Date().toLocaleDateString('sv-SE');
    const srcName = s.fileName.replace(/\.md$/i, '');
    // ① 知识沉淀（书目录 _校正知识.csv）
    const dir = s.sourcePath.slice(0, s.sourcePath.lastIndexOf('/'));
    const kPath = `${dir}/_校正知识.csv`;
    let kcsv = '';
    try {
      kcsv = await invoke<string>('read_text_file', { path: kPath });
    } catch {
      /* 有意兜底：`_校正知识.csv` 还不存在＝这本书第一次做校正传播，下面补表头。 */
    }
    if (!kcsv.trim()) kcsv = '版本,日期,词,处理,结果,传播到\n';
    // ② 每个版本建标记（幂等：已有同词同类型跳过）；origin 让低层侧栏 ⇄ 徽章/看板传播列可感知
    const plans: SyncTargetPlan[] = [];
    for (const tg of targets) {
      let md = '';
      let existing: Mark[] = [];
      try {
        md = await readTextSmart(tg.path);
        const saved = await invoke<string>('read_text_file', { path: await markPathFor(tg.path, tg.name) });
        const parsed = JSON.parse(saved) as { marks?: Mark[] };
        if (Array.isArray(parsed.marks)) existing = parsed.marks;
      } catch {
        /* 有意兜底：目标版本还没有标记文件＝它还没审过（缺失文件本来就是报错的），从空集合开始。 */
      }
      const srcMarks: Mark[] = done.map((d) => ({ id: 'k' + d.word + d.type, level: 'word', pi: 0, si: 0, wi: 0, word: d.word, text: '', type: d.type, origin: srcName, ts: Date.now() }));
      const plan = syncMarksToMd(srcMarks, md, existing, newMarkId);
      if (plan.totalCreated > 0) plans.push({ name: tg.name, path: tg.path, plan });
      kcsv += [srcName, date, done.map((d) => d.word).join('、'), done[0]!.type === 'simpl' ? '换词' : '加注', done.map((d) => d.result).join('、'), tg.name].map(csvCell).join(',') + '\n';
    }
    await invoke('write_text_file', { path: kPath, content: kcsv });
    if (!plans.length) return null;
    const r = await applySyncPlans(plans);
    const msg = `⇄ 高层校正已传播到低层版本：${plans.map((p) => `${p.name.replace(/\.md$/i, '')} 建 ${p.plan.totalCreated} 条待办（⇄ 标识，正文不动）`).join('；')}——知识已沉淀 _校正知识.csv（${r.wrote + r.refreshed} 个文件）`;
    toast(`高层次校正已传播：${plans.map((p) => `${p.name.replace(/\.md$/i, '')} 建 ${p.plan.totalCreated} 条标记`).join('、')}（仅标记，正文不动）`, 'ok');
    setStatus(`校正知识已沉淀到 _校正知识.csv 并传播到低层版本待办（${r.wrote + r.refreshed} 个文件）`, 'saved');
    return msg;
  } catch (e) {
    /* 传播失败**不等于"没有传播"**。本版校正已经生效，低层版本却没收到待办；
     * 以前这里返回 null，而调用方的 null 分支写的是"无新增传播（本目录无其他版本…）"——
     * 教师读到的变成"本来就没事"，实际是"这件事没做成"。 */
    return `⇄ 传播失败：${String(e).slice(0, 80)}——本版校正已生效，但低层版本**没有**收到待办，可稍后重试`;
  }
}

/** 同步弹层：先给后果预告（每个版本建多少/跳过多少及原因），确认才写盘——正文不动，只同步"待办" */
export async function showSyncMarksDialog(): Promise<void> {
  const s = activeSession();
  if (!s?.sourcePath) {
    setStatus('示例模式没有版本文件——从书架打开章节后使用', 'err');
    return;
  }
  // 手动同步的标记同样带 origin（来源=当前版）——低层侧栏 ⇄ 徽章/看板传播列与自动传播同口径可感知
  const srcName = s.fileName.replace(/\.md$/i, '');
  const syncable = s.review.marks.filter((m) => m.level !== 'sent' && m.word).map((m) => ({ ...m, origin: m.origin ?? srcName }));
  if (!syncable.length) {
    setStatus('本章还没有词/短语级标记（句级不跨版本同步——三版本句结构不同，句对不上）', 'err');
    return;
  }
  const dir = s.sourcePath.slice(0, s.sourcePath.lastIndexOf('/'));
  let names: string[];
  try {
    names = await invoke<string[]>('list_dir', { dir });
  } catch (e) {
    setStatus('读取章节目录失败：' + e, 'err');
    return;
  }
  const targets = names.filter((n) => /\.md$/i.test(n) && `${dir}/${n}` !== s.sourcePath).filter((n) => !/质检报告|审校档案|全书简化|基准|AI修订|分层初稿|工作稿|原始备份|词句卡/.test(n));
  const plans: SyncTargetPlan[] = [];
  const skippedTargets: string[] = [];
  for (const n of targets) {
    const path = `${dir}/${n}`;
    try {
      const md = await readTextSmart(path);
      let existing: Mark[] = [];
      try {
        const saved = await invoke<string>('read_text_file', { path: await markPathFor(path, n) });
        const parsed = JSON.parse(saved) as { marks?: Mark[] };
        if (Array.isArray(parsed.marks)) existing = parsed.marks;
      } catch {
        /* 有意兜底：这个版本还没有标记文件＝它还没审过（缺失文件本来就是报错的），从空集合开始。 */
      }
      plans.push({ name: n, path, plan: syncMarksToMd(syncable, md, existing, newMarkId) });
    } catch (e) {
      /* 跳过的版本要**点名**：不点名的话，下面"将新建 N 条"读起来像"所有版本都同步到了"，
       * 而实际有一个版本连读都没读到——教师会以为它已经领到待办了。 */
      skippedTargets.push(`${n}（${String(e).slice(0, 40)}）`);
    }
  }
  if (!plans.length) {
    setStatus('同目录没找到可用的其他版本文件——同章多版本放同一文件夹即可同步', 'err');
    return;
  }
  const totalCreated = plans.reduce((n, p) => n + p.plan.totalCreated, 0);
  syncPop.innerHTML = `
    <div class="pop-h">同步本章标记到其他版本</div>
    <p>把当前版本（${esc(s.fileName)}）的 <b>${syncable.length} 条词/短语级标记</b> 同步到同目录其他版本——审校意图共用，各版本按自己的口径执行。句级标记不同步（三版本句结构不同）。</p>
    <table class="gtable">
      <tr><th>版本文件</th><th>将新建</th><th>跳过·已标过</th><th>跳过·目标无此词</th></tr>
      ${plans
        .map(
          (p) =>
            `<tr><td>${esc(p.name)}</td><td>${p.plan.totalCreated}</td><td>${p.plan.items.filter((i) => i.skipped === 'duplicate').length}</td><td>${p.plan.items.filter((i) => i.skipped === 'not-found').length}</td></tr>`,
        )
        .join('')}
    </table>
    <p class="dim">目标无此词 = 更简版本已把该词换掉或删掉（等于已处理），属正常；已标过 = 不重复建（幂等）。只同步标记待办，不改任何正文。</p>
    ${skippedTargets.length ? `<p class="warn-badge2">⚠ ${skippedTargets.length} 个版本文件读不了，本弹层没把它们算进去：${esc(skippedTargets.join('；'))}</p>` : ''}
    <div class="pop-btns" style="margin-top:10px">
      <button id="sync-go" class="primary">同步 ${totalCreated} 条标记</button>
      <button id="sync-cancel">取消</button>
    </div>`;
  syncPop.classList.add('open');
  const r = syncPop.getBoundingClientRect();
  syncPop.style.left = Math.max(8, (window.innerWidth - r.width) / 2) + 'px';
  syncPop.style.top = Math.max(8, (window.innerHeight - r.height) / 2) + 'px';
  $('sync-cancel').addEventListener('click', hideSyncPop);
  $('sync-go').addEventListener('click', async () => {
    const r2 = await applySyncPlans(plans);
    hideSyncPop();
    toast(`已同步：${r2.wrote} 个版本文件写入、${r2.refreshed} 个已打开版本即时刷新`, 'ok');
    setStatus(`标记已同步（正文未动）——在各版本打开后点「按标记修改」按该版本口径执行`, 'saved');
  });
}

export function showVocabEditor(): void {
  let popEl = document.getElementById('vocab-pop');
  if (popEl) {
    popEl.remove();
    return; // 再点一次=关
  }
  popEl = document.createElement('div');
  popEl.id = 'vocab-pop';
  document.body.appendChild(popEl);
  // 原始行整行保留（含备注列），只按首列词做增删
  let rows: string[] = (S.vocabCsvText ?? '')
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim() && !l.startsWith('#'));
  let q = '';
  const wordOf = (line: string): string =>
    line
      .split(/[,;\t]/)[0]!
      .trim()
      .toLowerCase();
  const render = (): void => {
    const filtered = rows.filter((l) => !q || wordOf(l).includes(q));
    const chips =
      filtered
        .slice(0, 300)
        .map((l) => `<span class="mchip">${esc(l.split(/[,;\t]/)[0]!.trim())}<button class="x" data-vr="${rows.indexOf(l)}" title="删除该词条">×</button></span>`)
        .join('') || '<span class="dim">（无匹配词条）</span>';
    popEl!.innerHTML = `
      <div class="pop-h">编辑教师词库 <span class="dim" style="font-weight:400;font-size:12px">（内置课标 1600 不在此层，不动）</span></div>
      <div class="pop-info">当前 ${rows.length} 条（增删即时保存生效）${q ? ` · 搜索命中 ${filtered.length}` : ''}。保存到书目录 <b>_词库.csv</b> 并立即生效（重新着色+重跑体检）。</div>
      <div style="display:flex;gap:6px;margin:8px 0">
        <input id="vq" placeholder="搜词条…" value="${esc(q)}" style="flex:1" />
        <input id="vadd" placeholder="添加词条（回车或点＋）…" style="flex:1" />
        <button id="vadd-btn">＋</button>
      </div>
      <div class="pop-marks" style="max-height:260px;overflow-y:auto;display:flex;flex-wrap:wrap;gap:4px">${chips}</div>
      <div class="pop-btns" style="margin-top:10px">
        <button id="vsave" class="primary">完成</button>
        <button id="vclose">取消</button>
      </div>`;
    popEl!.querySelector('#vq')?.addEventListener('input', (ev) => {
      q = (ev.target as HTMLInputElement).value.trim().toLowerCase();
      render();
      (popEl!.querySelector('#vq') as HTMLInputElement).focus();
    });
    popEl!.querySelector('#vadd')?.addEventListener('keydown', (ev) => {
      if ((ev as KeyboardEvent).key === 'Enter') add();
    });
    /** 增删即时保存（Wayne"自动保存？"）：silent=不关弹层（编辑中每次变更即写盘生效） */
    const saveVocab = (silent = false): Promise<void> =>
      (async () => {
        const s = activeSession();
        const text = rows.join('\n') + '\n';
        const dir = s?.sourcePath ? s.sourcePath.slice(0, s.sourcePath.lastIndexOf('/')) : await invoke<string>('examples_dir');
        const path = `${dir}/_词库.csv`;
        try {
          await invoke('write_text_file', { path, content: text });
          S.vocabCsvText = text;
          S.vocabName = '_词库.csv';
          renderAll(); // 重新着色（renderReader 会按新词库重算三态）
          if (!silent) {
            popEl!.remove();
            void runQcCurrent({ auto: true });
            toast(`词库已保存并生效：${rows.length} 条 → ${path}`, 'ok');
          }
        } catch (e) {
          setStatus('词库保存失败：' + e, 'err');
        }
      })();

    const add = (): void => {
      const inp = popEl!.querySelector('#vadd') as HTMLInputElement | null;
      const w = inp?.value.trim().toLowerCase() ?? '';
      if (!w) return;
      if (rows.some((l) => wordOf(l) === w)) {
        toast(`「${w}」已在词库中`);
        return;
      }
      rows.push(w);
      inp!.value = '';
      render();
      void saveVocab(true);
    };
    popEl!.querySelector('#vadd-btn')?.addEventListener('click', add);
    popEl!.querySelectorAll('[data-vr]').forEach((b) =>
      b.addEventListener('click', () => {
        rows = rows.filter((_, i) => i !== Number((b as HTMLElement).dataset.vr));
        render();
        void saveVocab(true);
      }),
    );
    popEl!.querySelector('#vclose')?.addEventListener('click', () => popEl!.remove());
    popEl!.querySelector('#vsave')?.addEventListener('click', () => void saveVocab(false));
  };
  render();
  (popEl.querySelector('#vq') as HTMLInputElement | null)?.focus();
}

/* ---------- 去除中文标注·记已会（词面板按钮；本地正则剥离 + 词库登记，零模型） ---------- */

export async function removeZhAnnotation(s: FileSession, word: string): Promise<void> {
  const head = annotatedHeadOf(s.md, word); /* 点中片段 → 完整注释词头（great-looking（好看的）里点 looking 也要整词处理） */
  const { md, count } = stripWordAnnotations(s.md, head);
  if (!count) {
    toast(`没找到「${head}」的中文标注`);
    return;
  }
  await applyMdSnapshot(s, md, `已去除「${head}」的 ${count} 处中文标注`);
  hidePop();
  const date = new Date().toLocaleDateString('sv-SE');
  /* 变更日志 R16（与 R14 换词 / R15 手动修订同表同口径） */
  const outDir = s.sourcePath ? s.sourcePath.slice(0, s.sourcePath.lastIndexOf('/')) : await invoke<string>('reports_dir');
  const logPath = `${outDir}/变更日志_AI审核.csv`;
  try {
    let csv = '';
    try {
      csv = await invoke<string>('read_text_file', { path: logPath });
    } catch {
      /* 日志还不存在＝这张表第一次写（读缺失文件本来就是报错的），下面补表头。 */
    }
    if (!csv.trim()) csv = CHANGELOG_HEADER.join(',') + '\n';
    csv += ['R1', date, `标准${simplifyMaxLen()}词`, '', '', `${head}（…）`, head, 'R16', '去除中文标注（教师认定已会，本地剥离不过模型）', '人工矫正-去标注'].map(csvCell).join(',') + '\n';
    await invoke('write_text_file', { path: logPath, content: csv });
  } catch {
    /* 留痕失败不拦正文修改（applyMdSnapshot 已保存正文） */
  }
  /* 词库正本登记：从章节目录向上发现项目配置，upsert 一行「单词」进词库 CSV
   * （AF 场景=知识文件/已知词汇库，管线下次生成直接生效）。面板没打开也能写。 */
  let canonical = false;
  try {
    const { findProjectConfig, loadAll, upsertRow, save, DATA_KINDS, panelState } = await import('./datapanel.js');
    const kind = DATA_KINDS.find((k) => k.id === 'vocab')!;
    const dir = s.sourcePath ? s.sourcePath.replace(/\/[^/]*$/, '') : '';
    const hit = dir ? await findProjectConfig(dir) : null;
    if (hit) {
      if (!panelState.tables[kind.id]?.text) await loadAll([kind], hit.config);
      const cur = panelState.tables[kind.id]?.text ?? '';
      const res = cur ? upsertRow(kind, cur, { 词: head, 类型: '单词', 来源册: '教师确认', 备注: `${date} 去除标注时登记` }) : { text: cur, error: '词库表未载入' };
      if (!res.error) {
        const r = await save(kind, hit.config, res.text, `去除标注登记：${head}`, { logDir: hit.dir });
        canonical = r.ok;
      }
    }
  } catch {
    /* 项目未配/写正本失败：只落会话词表，不阻断（toast 里说清） */
  }
  /* 会话立即生效：S.vocabCsvText 追加该词并重跑质检——该词当场不再红 */
  const base = S.vocabCsvText?.trim() ? S.vocabCsvText : '词,类型,词性,释义,来源册,来源单元,音标,备注\n';
  S.vocabCsvText = `${base.replace(/\n$/, '')}\n${head},单词,,,教师确认,,,${date} 去除标注时登记\n`;
  await runQcCurrent({ auto: true });
  toast(`已去除「${head}」×${count} 处标注，${canonical ? '词库正本+会话均已登记' : '本会话词库已登记'}（↩︎ 可撤销；下次生成不再注它）`, 'ok');
}
