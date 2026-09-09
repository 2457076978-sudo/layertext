/**
 * 正文阅读器域（WP-F 拆分）：正文渲染（三态高亮/风险角标/段落书签）/ 标记动作（增删/徽标/侧栏挂接）/
 * 词·句·短语三面板（数字键标记/R 改写/E 手改/即改模式分流） —— 从 main.ts 整块迁出，行为零变化。
 */

import { S, esc } from './state.js';
import { $, setStatus, toast, pop, hidePop, placePop } from './uikit.js';
import { activeSession, buildLexiconNow, scheduleHeatRail, showGateHelp } from './main.js';
import { showSentenceEditor, applyZhAnnotations, applyWordSimplifications } from './pipew.js';
import { aiRewriteSentence } from './aiflow.js';
import {
  jumpTo,
  refreshBookmarksDom,
  refreshMarkDom,
  removeMarkDom,
  renderSidebar,
  restoreAllMarkDom,
  scheduleSave,
} from './review.js';
import { WORD_TYPES, SENT_TYPES, newMarkId, typeLabel, type FileSession, type Mark, type MarkLevel, type MarkType } from './types.js';
import { phraseSpan, toggleParaBookmark } from './pure.js';
import bundledCefr from '../../assets/wordlists/cefrj_levels.txt?raw';
import { parseCefrLevels, cefrOf, CEFR_DESC, type CefrLevel } from '../../src/core/cefr.js';
import { IRR } from '../../src/core/irregular.js';
import { cardGlossWords, extractParas, hit, hitOrigin, pendHit, sentsOf, splitChapter, tokenizeTxt } from '../../src/core/textpipe.js';
import { sentenceRisks } from '../../src/core/risks.js';

function badge(text: string): HTMLElement {
  const b = document.createElement('sup');
  b.className = 'badge';
  b.textContent = text;
  return b;
}

export function renderReader(session: FileSession): void {
  const reader = $('reader');
  let body: string;
  try {
    body = splitChapter(session.md).body;
  } catch (e) {
    reader.innerHTML = `<div class="empty">文件格式不符：${esc((e as Error).message)}<br/>需要包含 "## Chapter One" 章节标记与 [P01] 段落标记。<br/><span style="font-size:12px">不知道怎么弄？把书稿发我（开发者）帮你转格式</span></div>`;
    return;
  }
  const lex = buildLexiconNow();
  const card = splitChapter(session.md).card;
  S.currentKnown = new Set([...lex.known, ...IRR, ...cardGlossWords(card)]);
  const terms = new Set<string>([
    ...(S.termsText ?? '')
      .split('\n')
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l && !l.startsWith('#')),
    ...S.properRows.map((r) => r.toLowerCase()),
  ]);

  reader.replaceChildren();
  extractParas(body).forEach((p, pi) => {
    const div = document.createElement('div');
    div.className = 'para';
    div.dataset.pi = String(pi);
    const pid = document.createElement('span');
    pid.className = 'pid';
    const pidLabel = 'P' + String(pi + 1).padStart(2, '0');
    pid.textContent = pidLabel;
    pid.dataset.orig = pidLabel;
    pid.title = '双击收藏本段书签（★，目录面板可查看与跳转）';
    pid.addEventListener('dblclick', () => {
      const s = activeSession();
      if (!s) return;
      const firstSent = sentsOf(p, false)[0] ?? '';
      const r = toggleParaBookmark(s.review.bookmarks, pi, firstSent, Date.now());
      s.review.bookmarks = r.list;
      refreshBookmarksDom(s);
      scheduleSave(s, () => undefined);
      toast(r.added ? `已收藏段落书签 ${pidLabel}（双击段号可移除）` : `已移除段落书签 ${pidLabel}`);
    });
    div.appendChild(pid);
    sentsOf(p, false).forEach((sent, si) => {
      const s = document.createElement('span');
      s.className = 'sent';
      s.dataset.pi = String(pi);
      s.dataset.si = String(si);
      s.dataset.text = sent.slice(0, 60);
      const risk = sentenceRisks(sent);
      if (risk.overlong || risk.passive || risk.relcl || risk.pastperf) {
        s.classList.add('risk');
        if (risk.passive) s.appendChild(badge('被'));
        if (risk.relcl) s.appendChild(badge('从'));
        if (risk.pastperf) s.appendChild(badge('完'));
        if (risk.overlong) s.appendChild(badge('长'));
      }
      const toks = tokenizeTxt(sent);
      const rawWords = sent.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
      let rest = sent;
      for (let i = 0; i < rawWords.length; i++) {
        const raw = rawWords[i];
        const at = rest.indexOf(raw);
        if (at > 0) s.appendChild(document.createTextNode(rest.slice(0, at)));
        const w = document.createElement('span');
        const tok = toks[i] ?? raw.toLowerCase();
        const cls = terms.has(tok) ? 'term' : pendHit(tok, lex.pending) ? 'pending' : hit(tok, S.currentKnown) ? '' : 'oov';
        w.className = 'w' + (cls ? ' ' + cls : '');
        w.dataset.wi = String(i);
        w.dataset.tok = tok;
        w.dataset.state = cls || 'known';
        w.textContent = raw;
        const label = cls === 'oov' ? '词表外' : cls === 'pending' ? '待定词' : cls === 'term' ? '术语' : '已知';
        w.title = `${raw} · ${label}`;
        s.appendChild(w);
        rest = rest.slice(at + raw.length);
      }
      s.appendChild(document.createTextNode(rest));
      div.appendChild(s);
      div.appendChild(document.createTextNode(' '));
    });
    reader.appendChild(div);
  });
  restoreAllMarkDom(session);
  scheduleHeatRail();
}

/* ---------- 标记动作 ---------- */

export function addMark(session: FileSession, mark: Mark): Mark {
  session.review.marks.push(mark);
  refreshMarkDom(mark);
  scheduleHeatRail();
  renderSidebar(session, sidebarHandlers);
  updateMarkBadge();
  scheduleSave(session, (st, detail) => {
    if (st === 'dirty') setStatus('标记待保存…', 'dirty');
    else if (st === 'saved') setStatus('✓ 标记已自动保存：' + detail, 'saved');
    else setStatus('标记保存失败：' + detail, 'err');
  });
  return mark;
}

function removeMark(session: FileSession, m: Mark): void {
  session.review.marks = session.review.marks.filter((x) => x.id !== m.id);
  removeMarkDom(m);
  scheduleHeatRail();
  renderSidebar(session, sidebarHandlers);
  scheduleSave(session, () => undefined);
  updateMarkBadge();
}

/** 候选模式下「按标记修改」按钮的待处理徽标——标记≠修改（候选模式只入清单），
 *  攒了多少活必须一眼可见（交互标准 A1/A3：点了会发生什么/发生了什么） */
export function updateMarkBadge(): void {
  const btn = $('btn-ai');
  const s = activeSession();
  const n = s && S.appConfig.autoRewriteOnMark !== true ? s.review.marks.length : 0;
  let b = btn.querySelector<HTMLElement>('.pbadge');
  if (!n) {
    b?.remove();
    return;
  }
  if (!b) {
    b = document.createElement('span');
    b.className = 'pbadge';
    btn.appendChild(b);
  }
  b.textContent = String(n);
  b.title = `本章还有 ${n} 条标记未执行——点了「按标记修改」才会改（当前为候选模式；切即改模式则点标记立即生效）`;
}

export const sidebarHandlers = {
  onQuotaToggle: (i: number) => {
    const s = activeSession();
    if (!s) return;
    s.review.quota[i].done = !s.review.quota[i].done;
    renderSidebar(s, sidebarHandlers);
    scheduleSave(s, () => undefined);
  },
  onQuotaRemove: (i: number) => {
    const s = activeSession();
    if (!s) return;
    s.review.quota.splice(i, 1);
    renderSidebar(s, sidebarHandlers);
    scheduleSave(s, () => undefined);
  },
  onQuotaAdd: (text: string) => {
    const s = activeSession();
    if (!s) return;
    s.review.quota.push({ text, done: false });
    renderSidebar(s, sidebarHandlers);
    scheduleSave(s, () => undefined);
  },
  onGateToggle: (g: string) => {
    const s = activeSession();
    if (!s) return;
    s.review.gate[g] = !s.review.gate[g];
    renderSidebar(s, sidebarHandlers);
    scheduleSave(s, () => undefined);
  },
  onGateHelp: (g: string, anchor: HTMLElement) => showGateHelp(g, anchor),
  onMarkJump: (m: Mark) => jumpTo(m),
  onMarkRemove: (m: Mark) => {
    const s = activeSession();
    if (s) removeMark(s, m);
  },
};

/* ---------- 弹层面板 ---------- */

/** CEFR 等级行（显示用辅助维度；判定锚=课标1600+教师词库，CEFR 只加细粒度难度显示） */
let cefrMap: Map<string, CefrLevel> | null = null;
function cefrLine(tok: string): string {
  cefrMap ??= parseCefrLevels(bundledCefr);
  const lv = cefrOf(tok, cefrMap);
  return lv ? `CEFR：${lv}（${CEFR_DESC[lv]}）· CEFR-J 词表` : 'CEFR：未收（CEFR-J 词表无此词）';
}

function marksAt(session: FileSession, level: MarkLevel, pi: number, si: number, wi?: number): Mark[] {
  return session.review.marks.filter((m) => m.level === level && m.pi === pi && m.si === si && (level === 'sent' || m.wi === wi));
}

function renderPopMarks(existing: Mark[]): void {
  const box = pop.querySelector('.pop-marks');
  if (!box) return;
  box.innerHTML = existing.length
    ? existing.map((m) => `<span class="mchip">${typeLabel(m.type)}${m.note ? ' ✎︎' : ''}<button class="x" data-pop-rm="${m.id}" title="删除该标记">×</button></span>`).join('')
    : '<span style="color:var(--muted);font-size:12px">尚无标记</span>';
  box.querySelectorAll('[data-pop-rm]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const m = S.popSession?.review.marks.find((x) => x.id === (btn as HTMLElement).dataset.popRm);
      if (m && S.popSession) {
        removeMark(S.popSession, m);
        refreshPop();
      }
    }),
  );
}

function refreshPop(): void {
  if (!S.popSession) return;
  const ctx = pop.dataset;
  const pi = Number(ctx.pi),
    si = Number(ctx.si),
    wi = ctx.wi === undefined ? undefined : Number(ctx.wi);
  const level = ctx.level as MarkLevel;
  renderPopMarks(marksAt(S.popSession, level, pi, si, wi));
  // 类型按钮置灰已选项
  pop.querySelectorAll('[data-mk]').forEach((b) => {
    const t = (b as HTMLElement).dataset.mk!;
    const has = marksAt(S.popSession!, level, pi, si, wi).some((m) => m.type === t);
    (b as HTMLElement).style.opacity = has ? '.45' : '';
  });
}

export function showWordPanel(session: FileSession, wEl: HTMLElement, x: number, y: number): void {
  S.popSession = session;
  const sentHost = wEl.closest('.sent') as HTMLElement | null;
  const pi = Number(sentHost?.dataset.pi);
  const si = Number(sentHost?.dataset.si);
  const wi = Number(wEl.dataset.wi);
  const tok = wEl.dataset.tok!;
  const state = wEl.dataset.state;
  const origin = hitOrigin(tok, S.currentKnown);
  const stateLabel =
    state === 'oov'
      ? '<span class="warn">词表外（红）</span>'
      : state === 'pending'
        ? '<span class="warn">待定词（橙）—暂计已知，风险另计</span>'
        : state === 'term'
          ? '术语（蓝）'
          : '<span class="ok">词表内</span>';
  pop.dataset.level = 'word';
  pop.dataset.pi = String(pi);
  pop.dataset.si = String(si);
  pop.dataset.wi = String(wi);
  pop.innerHTML = `
    <div class="pop-h">${esc(wEl.textContent ?? '')}</div>
    <div class="pop-info">词表状态：${stateLabel}${origin && origin !== tok ? `<br/>词形还原原形：${esc(origin)}` : ''}<br/>${cefrLine(tok)}</div>
    <div class="pop-marks"></div>
    <div class="pop-btns"><button data-mk="__rewrite" class="primary" title="让 AI 按当前标记意图改写这一句（快捷键 R）"><svg class="ico"><use href="#i-sparkle"/></svg>AI 改写本句</button><button data-mk="__edit" title="亲手修改这一句（快捷键 E）——直接写入正文，可撤销，不经引擎复核（你是定稿人）">✎ 手动改这句</button>${WORD_TYPES.map((t, i) => `<button data-mk="${t.key}" title="标记为「${t.label}」${t.key === 'anchor' ? '——记录该词为本篇复现锚点（保留并计入复现，不改正文）' : S.appConfig.autoRewriteOnMark ? '——即改模式下点完立即执行（写原稿+日志）' : '——点「AI 改写本句」或批量时按此意图处理'}"><span class="kbd">${i + 1}</span>${t.label}</button>`).join('')}</div>
    <textarea id="pop-note" placeholder="备注（可选，随下一条标记保存）"></textarea>
    <div class="pop-tip">${S.appConfig.autoRewriteOnMark ? '当前为即改模式：点任一标记立即执行（如「加中文标注」插入注释、「词汇简化」换课标内简单词），改动写原稿并记日志，首改前自动备份' : '先标记意图再点「AI 改写本句」，改写会直接出现在正文中供采纳'}</div>`;
  bindTypeButtons(session, 'word', pi, si, wi);
  refreshPop();
  placePop(x, y);
}

export function showSentPanel(session: FileSession, sentEl: HTMLElement, x: number, y: number, crossSentence: boolean): void {
  S.popSession = session;
  const pi = Number((sentEl as HTMLElement).dataset.pi);
  const si = Number((sentEl as HTMLElement).dataset.si);
  const text = sentsOf(extractParas(splitChapter(session.md).body)[pi], false)[si] ?? '';
  const wc = text.split(/\s+/).filter(Boolean).length;
  const risk = sentenceRisks(text);
  const riskBits = [risk.passive ? '被动' : '', risk.relcl ? '定从' : '', risk.pastperf ? '过去完成' : '', risk.overlong ? `超长(${wc}词)` : ''].filter(Boolean).join(' / ');
  pop.dataset.level = 'sent';
  pop.dataset.pi = String(pi);
  pop.dataset.si = String(si);
  delete pop.dataset.wi;
  pop.innerHTML = `
    <div class="pop-h">句子标记（P${String(pi + 1).padStart(2, '0')} · 第${si + 1}句 · ${wc} 词）</div>
    <div class="pop-info">${esc(text.slice(0, 80))}${text.length > 80 ? '…' : ''}<br/>自动检测：${riskBits ? `<span class="warn">${riskBits}</span>` : '<span class="ok">未命中黑名单句法</span>'}${crossSentence ? '<br/>⚠︎ 跨句选择，仅标记所选末句' : ''}</div>
    <div class="pop-marks"></div>
    <div class="pop-btns"><button data-mk="__edit" title="亲手修改这一句（快捷键 E）——直接写入正文，可撤销，不经引擎复核（你是定稿人）">✎ 手动改这句</button>${SENT_TYPES.map((t, i) => `<button data-mk="${t.key}"><span class="kbd">${i + 1}</span>${t.label}</button>`).join('')}</div>
    <textarea id="pop-note" placeholder="备注（可选，随下一条标记保存）"></textarea>`;
  bindTypeButtons(session, 'sent', pi, si);
  refreshPop();
  placePop(x, y);
}

/* ---------- 手动改这句（人工矫正兜底）：AI 改不好时教师亲手改；教师是定稿人，不经引擎复核 ---------- */

/* 短语面板（三级粒度之短语级）：拖选短语 → 直线下划线标记，类型色沿用词级色板；
 * 选区即范围——弹层顶部显示选区原文，短语动作常驻；句动作不在此弹层（想标句就选整句） */
export function showPhrasePanel(session: FileSession, sentEl: HTMLElement, range: Range, x: number, y: number): void {
  S.popSession = session;
  const pi = Number(sentEl.dataset.pi);
  const si = Number(sentEl.dataset.si);
  const wis = [...sentEl.querySelectorAll<HTMLElement>('.w')].filter((w) => range.intersectsNode(w)).map((w) => Number(w.dataset.wi));
  if (!wis.length) return;
  const wi = Math.min(...wis);
  const wl = Math.max(...wis) - wi + 1;
  const sent = sentsOf(extractParas(splitChapter(session.md).body)[pi] ?? '', false)[si] ?? '';
  const span = phraseSpan(sent, wi, wl);
  if (!span) return;
  const shown = span.text.length > 60 ? span.text.slice(0, 60) + '…' : span.text;
  pop.dataset.level = 'phrase';
  pop.dataset.pi = String(pi);
  pop.dataset.si = String(si);
  pop.dataset.wi = String(wi);
  pop.dataset.wl = String(wl);
  pop.innerHTML = `
    <div class="pop-h">短语标记（P${String(pi + 1).padStart(2, '0')} · 第${si + 1}句 · ${wl} 词）</div>
    <div class="pop-info">选区：${esc(shown)}<br/>选什么划什么——短语整体处理（词典释义 / 换简单说法 / 标记保留），句内其余文字不动</div>
    <div class="pop-marks"></div>
    <div class="pop-btns"><button data-mk="__rewrite" class="primary" title="让 AI 按当前标记意图改写这一句（快捷键 R）"><svg class="ico"><use href="#i-sparkle"/></svg>AI 改写本句</button><button data-mk="__edit" title="亲手修改这一句（快捷键 E）——直接写入正文，可撤销，不经引擎复核（你是定稿人）">✎ 手动改这句</button>${WORD_TYPES.map((t, i) => `<button data-mk="${t.key}" title="标记为「${t.label}」——${t.key === 'anchor' ? '记录整个短语为复现锚点（不改正文）' : `将对整个短语生效（下划线范围）${S.appConfig.autoRewriteOnMark ? '；即改模式下点完立即执行（写原稿+日志）' : ''}`}"><span class="kbd">${i + 1}</span>${t.label}</button>`).join('')}</div>
    <textarea id="pop-note" placeholder="备注（可选，随下一条标记保存）"></textarea>
    <div class="pop-tip">${S.appConfig.autoRewriteOnMark ? '当前为即改模式：点任一标记立即对整个短语执行，改动写原稿并记日志' : '选什么划什么——标记后可点「AI 改写本句」处理整个短语'}</div>`;
  bindTypeButtons(session, 'phrase', pi, si, wi, wl);
  refreshPop();
  placePop(x, y);
}

function bindTypeButtons(session: FileSession, level: MarkLevel, pi: number, si: number, wi?: number, wl?: number): void {
  pop.querySelectorAll('[data-mk]').forEach((b) =>
    b.addEventListener('click', () => {
      const type = (b as HTMLElement).dataset.mk as MarkType | '__rewrite' | '__edit';
      if ((type as string) === '__edit') {
        showSentenceEditor(pi, si);
        return;
      }
      if ((type as string) === '__rewrite') {
        const intent = [...marksAt(session, 'word', pi, si, wi), ...marksAt(session, 'phrase', pi, si, wi)].map((m) => typeLabel(m.type)).join('、') || '词汇简化';
        void aiRewriteSentence(pi, si, intent);
        return;
      }
      const note = (pop.querySelector('#pop-note') as HTMLTextAreaElement | null)?.value.trim() || undefined;
      if (marksAt(session, level, pi, si, wi).some((m) => m.type === type)) return; // 已有同类型标记
      const sentText = sentsOf(extractParas(splitChapter(session.md).body)[pi], false)[si] ?? '';
      const mark = addMark(session, {
        id: newMarkId(),
        level,
        pi,
        si,
        ...(level !== 'sent' ? { wi } : {}),
        ...(level === 'phrase' ? { wl: wl ?? 1, word: phraseSpan(sentText, wi ?? 0, wl ?? 1)?.text ?? '' } : level === 'word' ? { word: pop.querySelector('.pop-h')?.textContent ?? '' } : {}),
        text: sentText.slice(0, 40),
        type: type as MarkType,
        note,
        ts: Date.now(),
      });
      // 标记即改写：点完标记直接 AI 改写并生效，无需任何后续点击
      // 加中文标注例外——它是确定性操作，走词义映射+机器插入（原句逐字不动，不让 AI 改写句子）
      if (S.appConfig.autoRewriteOnMark) {
        hidePop();
        if (mark.type === 'anchor' && mark.word) {
          toast(`复现锚点已记录：${mark.word}（保留该词并计入本篇复现，正文不动）`, 'ok');
          return; // 记录型标记：句子没问题，不触发改写
        }
        if (mark.type === 'zh' && mark.word) void applyZhAnnotations(session, [mark]);
        else if (mark.type === 'simpl' && mark.word) void applyWordSimplifications(session, [mark]);
        else void aiRewriteSentence(pi, si, typeLabel(mark.type), mark.id);
        return;
      }
      const ta = pop.querySelector('#pop-note') as HTMLTextAreaElement | null;
      if (ta) ta.value = '';
      refreshPop();
      // 候选模式闭环：标记只是入了清单、正文还没改——必须当场说清"去哪执行"（用户问"点了 AI 没修改怎么办"的根修）
      const tip = pop.querySelector('.pop-tip');
      if (tip) tip.textContent = `已入标记清单（本章待执行 ${session.review.marks.length} 条，正文未改）——点工具栏「按标记修改」批量执行，或切右侧模式胶囊为即改模式`;
      updateMarkBadge();
    }),
  );
}
