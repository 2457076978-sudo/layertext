/**
 * 词画卷视图（2026-09-18 项 3）：词面板「全书 N 处」入口 + 画卷弹层（章/段分组的出现处列表、
 * 三层对照行、词表外徽标、点击行跳该章文件）。
 *
 * 数据：bookscan 只读扫描 + core/concordance 建图，模块级缓存按书目录键控、60 秒过期 +
 * 弹层内「↻ 重扫」显式刷新——**画卷是视图不是正本**（设计定案 2），重算不落任何东西。
 */

import { S, esc } from './state.js';
import { $, setStatus } from './uikit.js';
import { uibus } from './uibus.js';
import { loadBookChapters } from './bookscan.js';
import { propagationConfig } from './propagateui.js';
import { attachOrigin, buildConcordance, type ConcordanceMark, type ConcordanceOccurrence } from '../../src/core/concordance.js';
import { concordanceEntryLine, concordanceRows } from './pure.js';
import type { FileSession } from './types.js';

const CONC_POP = 'conc-pop';
const CACHE_TTL_MS = 60_000;

interface ConcCache {
  key: string;
  at: number;
  conc: Map<string, ConcordanceOccurrence[]>;
  paths: Map<string, string>; // `${章}|${层}` → 文件路径（跳转用）
  coverage: string;
  chapterNames: string[];
  /** 词级标记的溯源（有 origin 的才算——"教师亲判传播而来"）；稳定 ID=词+章+层+段 */
  marks: ConcordanceMark[];
}

let cache: ConcCache | null = null;
let loading: Promise<ConcCache | null> | null = null;

async function buildFor(s: FileSession): Promise<ConcCache | null> {
  const cfg = await propagationConfig(s);
  const scan = await loadBookChapters(s, cfg?.naming ?? {});
  if (!scan.chapters.length) return null;
  const byChapter = new Map<string, Record<string, string>>();
  const paths = new Map<string, string>();
  for (const row of scan.chapters) {
    const t = byChapter.get(row.name) ?? {};
    t[row.tier || ''] = row.text;
    byChapter.set(row.name, t);
    paths.set(`${row.name}|${row.tier || ''}`, row.path);
  }
  const chapters = [...byChapter.keys()];
  const conc = buildConcordance(
    chapters.map((name) => ({ name, tiers: byChapter.get(name)! })),
    { known: S.currentKnown },
  );
  /* 溯源标记（2e）：段的稳定 ID 按 mark 的段索引 pi（0 基）映射 P##——与 App 归一化
   * 编号同源；对不上的（手工改过段序等）attachOrigin 自然匹配不上、省略不伪造，失效安全。 */
  const marks: ConcordanceMark[] = [];
  for (const row of scan.chapters) {
    for (const m of row.marks) {
      if (m.word && m.origin) marks.push({ word: m.word, chapter: row.name, tier: row.tier, segId: `P${String(m.pi + 1).padStart(2, '0')}`, origin: m.origin });
    }
  }
  const key = s.sourcePath?.slice(0, s.sourcePath.lastIndexOf('/')) ?? s.fileName;
  return { key, at: Date.now(), conc, paths, coverage: scan.coverage, chapterNames: chapters, marks };
}

async function ensureConc(s: FileSession, force = false): Promise<ConcCache | null> {
  const dir = s.sourcePath?.slice(0, s.sourcePath.lastIndexOf('/')) ?? s.fileName;
  if (!force && cache && cache.key === dir && Date.now() - cache.at < CACHE_TTL_MS) return cache;
  if (!force && loading) return loading;
  loading = buildFor(s)
    .then((c) => {
      if (c) cache = c;
      return c;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** 词面板打开时后台预热：就绪后把入口按钮文案补成「全书 N 处…」（面板已关就什么都不做）。 */
export async function primeConcordance(s: FileSession): Promise<void> {
  try {
    const c = await ensureConc(s);
    const btn = document.getElementById('wp-conc');
    if (!c || !btn) return;
    const tok = document.getElementById('pop')?.dataset.tok ?? ''; /* 词面板单例（uikit 的 #pop）存着当前词 */
    updateEntryLabel(btn, tok, c);
  } catch {
    /* 有意兜底：预热失败不弹错——教师点开画卷时才需要说出口（这里连面板都可能已关）。 */
  }
}

function updateEntryLabel(btn: HTMLElement, tok: string, c: ConcCache): void {
  const occs = c.conc.get(tok.toLowerCase()) ?? [];
  const line = concordanceEntryLine(
    occs.length,
    new Set(occs.map((o) => o.chapter)).size,
    occs.reduce<Record<string, number>>((m, o) => ((m[o.tier] = (m[o.tier] ?? 0) + 1), m), {}),
  );
  if (line) btn.textContent = `📖 ${line} ▸`;
}

/** 打开词画卷弹层（词面板「全书词画像」按钮的落点）。 */
export async function openConcordanceView(s: FileSession, word: string): Promise<void> {
  const pop = document.getElementById(CONC_POP);
  if (!pop) return;
  pop.classList.add('open');
  pop.innerHTML = '<div class="pop-h">📖 词画卷</div><div class="dim" style="padding:8px 12px">正在扫描本书…</div>';
  let c: ConcCache | null = null;
  try {
    c = await ensureConc(s);
  } catch (e) {
    setStatus(`词画卷建不起来：${String(e).slice(0, 120)}——书目录可能读不了`, 'err');
    pop.classList.remove('open');
    return;
  }
  if (!c) {
    pop.innerHTML = `<div class="pop-h">📖 词画卷</div><div class="dim" style="padding:8px 12px">这本书没扫到可读的章节文件（${esc(s.fileName)}）——画卷需要书稿文件在盘上</div><div class="row-btns" style="padding:8px 12px"><button id="conc-close">关闭</button></div>`;
    $('conc-close').addEventListener('click', () => pop.classList.remove('open'));
    return;
  }
  const w = word.toLowerCase();
  const occs = attachOrigin(c.conc.get(w) ?? [], c.marks); // 溯源附加（无匹配省略，不改图本体）
  const byTier = occs.reduce<Record<string, number>>((m, o) => ((m[o.tier] = (m[o.tier] ?? 0) + 1), m), {});
  const entry = concordanceEntryLine(occs.length, new Set(occs.map((o) => o.chapter)).size, byTier);
  const groups = concordanceRows(
    occs,
    ['A', 'M', 'B'].map((k) => ({ A: 'A层85', M: 'M层75', B: 'B层60' })[k] ?? ''),
  );
  const hl = (sentence: string, form: string): string =>
    esc(sentence).replace(new RegExp(`(^|[^A-Za-z'-])(${form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), (m, p1, p2) => `${p1}<b class="conc-hit">${p2}</b>`);
  const tierBadge = (t: string): string => `<span class="conc-tier">${esc(t || '原稿')}</span>`;
  pop.innerHTML = `
    <div class="pop-h">📖 词画卷 · ${esc(word)} ${occs.length ? `<span class="dim">${entry ?? `${occs.length} 处`}</span>` : ''}</div>
    <div class="dim conc-coverage">${esc(c.coverage)}</div>
    ${occs.length === 0 ? '<div class="dim conc-empty">全书没有这个词（或它是词表外形——试它的原形/其它词形）</div>' : ''}
    <div class="conc-list">
      ${groups
        .map(
          (g) => `
        <div class="conc-seg">
          <div class="conc-seg-h">${esc(g.chapter)} · ${esc(g.segId)}${g.compare ? ' <span class="dim">（同段多层对照）</span>' : ''}</div>
          ${g.rows
            .map(
              (r) => `
          <div class="conc-row${g.compare ? ' compare' : ''}" data-conc-path="${esc(c.paths.get(`${g.chapter}|${r.tier}`) ?? '')}" title="点击打开这一份">
            ${tierBadge(r.tier)}${r.annotated ? '<span class="ok-badge">已注</span>' : ''}${r.unmerged ? '<span class="warn">词表外</span>' : ''}${r.origin ? `<span class="conc-origin" title="此处的教师决定由「${esc(r.origin)}」传播而来（_审校标记.json 溯源）">↔ 亲判·${esc(r.origin)}</span>` : ''}
            <span class="conc-sent">${hl(r.sentence, r.wordForm)}</span>
          </div>`,
            )
            .join('')}
        </div>`,
        )
        .join('')}
    </div>
    <div class="row-btns conc-foot">
      <button id="conc-refresh" title="画卷是视图：重扫一遍拿最新正文（不写任何东西）">↻ 重扫</button>
      <button id="conc-close">关闭</button>
    </div>`;
  $('conc-close').addEventListener('click', () => pop.classList.remove('open'));
  $('conc-refresh').addEventListener('click', () => void openConcordanceView(s, word).then(() => ensureConc(s, true)));
  pop.querySelectorAll<HTMLElement>('[data-conc-path]').forEach((el) => {
    el.addEventListener('click', () => {
      const p = el.dataset.concPath;
      if (!p) return;
      void uibus.openPathIntoSession(p);
      pop.classList.remove('open');
    });
  });
}
