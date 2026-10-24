// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，本仓库已部署版权验证体系，细节不予公开（docs/版权与授权.md）。
/**
 * LayerText · 审查单（A 方案，2026-10-24 重写版）
 *
 * 定位（2026-10-05 拍板，原实现随 2026-10-09 迁移事故丢失，本文件按设计定案重写）：
 *   「老师的界面留在人侧越薄越好、机器全 MCP 化、中间靠清单+三键+台账契约咬合；App 审校台冻结」
 *
 * 两件纯函数：
 *   · buildReviewSheet —— 跑一遍 OOV 判定，产出**自包含 HTML 审查单**（手机优先）+ 清单正本 JSON；
 *   · reviewEventsFromDecisions —— 教师**决定 JSON → 校验 → DecisionEvent[]**（append-only 台账事件）。
 *
 * 三键契约（传播机制的三键警戒线，见 decision.ts/candidate.ts）：
 *   ① 补注 annotate —— 词保留，注中文释义（决定事件 = accept：释义是资产，可向下传播）；
 *   ② 换成X replace —— 全文换词（决定事件 = edit：只记待办，执行改文永远是 agent/人的事）；
 *   ③ 忽略 ignore   —— 本篇不再提示（决定事件 = false-positive：只在本层生效，不入词表）。
 *
 * 两条铁律：
 *   · **出处句高亮在 TS 侧预计算**成 pre/hit/post 三段——内嵌 JS 里复刻正则会炸模板字符串 `${}`
 *     （2026-10-05 定案），所以页面 JS 全程零正则、零模板字符串（字符串只用单双引号拼接）；
 *   · **只校验不执行改文**——ingest 只产事件，永不碰正文；改文由 agent 消费台账后另行执行。
 */

import { makeDecisionEvent, toDecisionLine, type DecisionEvent } from './decision.js';
import { IRR } from './irregular.js';
import type { Lexicon } from './lexicon.js';
import { contentHash } from './manifest.js';
import type { Tier } from './qc.js';
import { extractParas, hit, sentsOf, tokenizeTxt } from './textpipe.js';

export const REVIEW_SHEET_SCHEMA_VERSION = 1;
/** 审查单产出的决定事件统一挂的规则 ID（离线汇总器按它分组） */
export const REVIEW_RULE_ID = 'RS-OOV';

export type ReviewAction = 'annotate' | 'replace' | 'ignore';
export const REVIEW_ACTIONS: readonly ReviewAction[] = ['annotate', 'replace', 'ignore'] as const;
export const REVIEW_ACTION_LABEL: Record<ReviewAction, string> = {
  annotate: '补注',
  replace: '换成X',
  ignore: '忽略',
};

/** 出处句的三段式（高亮 TS 侧预计算的产物——页面 JS 拿到的就是切好的三段字符串） */
export interface ReviewSentenceSeg {
  pre: string;
  hit: string;
  post: string;
}

export interface ReviewItem {
  word: string;
  /** token 出现次数（重复强度） */
  count: number;
  /** 出处句（最多 maxSentences 条，含高亮三段） */
  sentences: ReviewSentenceSeg[];
  /** 机器候选（换词对资产/知识库给出）——**只预填**，教师可改可空 */
  candidate?: string;
}

/** 审查单正本（sheet.json）——ingest 校验与 HTML 重建共用这一份事实 */
export interface ReviewSheetManifest {
  schemaVersion: number;
  sheetId: string;
  sourceFile: string;
  /** 源文件内容哈希（决定事件挂它，回答"这份决定是对着哪一版做的"） */
  sourceVersion: string;
  tier: Tier;
  builtAt: string;
  oovWordCount: number;
  items: ReviewItem[];
}

export interface ReviewDecision {
  word: string;
  action: ReviewAction;
  /** annotate=中文释义；replace=替换词；ignore 留空 */
  value?: string;
}

/** 审查单导出的决定 JSON（页面"导出 JSON"按钮产出的形状） */
export interface ReviewDecisionsFile {
  schemaVersion: number;
  sheetId: string;
  sourceFile: string;
  sourceVersion: string;
  teacherId: string;
  decidedAt: string;
  decisions: ReviewDecision[];
}

export interface BuildReviewSheetOptions {
  tier?: Tier;
  fileName?: string;
  /** 额外已知词（复现队列等，与 qc 口径一致：并入已知不算 OOV） */
  extraKnown?: string[];
  /** 换词对资产（word→候选替换）；只预填，教师定稿 */
  candidates?: Map<string, string>;
  /** 每词最多出处句数（默认 3） */
  maxSentences?: number;
  /** 便于测试确定性 */
  builtAt?: string;
}

/** 段落双路提取：书稿带 [P##] 段标记走 extractParas；粘贴的裸文本按空行分段、去标题行。
 *  （不走 splitChapter——它对无章节标记的文本直接抛错，而审查单要能审任意英文文本。） */
export function parasForReview(md: string): string[] {
  if (/\[P\d+\]/.test(md)) return extractParas(md);
  return md
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith('#'));
}

/** 大小写不敏感的整词定位，返回首个命中的三段切分；未命中返回 null。
 *  正则只活在本函数（TS 侧）——这是"高亮预计算"的唯一实现处。 */
export function highlightSegments(sentence: string, word: string): ReviewSentenceSeg | null {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = sentence.match(new RegExp(`(?:^|[^A-Za-z0-9])(${esc})(?![A-Za-z0-9])`, 'i'));
  if (!m || m.index === undefined) return null;
  const start = m.index + m[0].indexOf(m[1]);
  return { pre: sentence.slice(0, start), hit: sentence.slice(start, start + m[1].length), post: sentence.slice(start + m[1].length) };
}

/** 造审查单正本：OOV 判定 + 出处句高亮 + 机器候选预填。纯函数，不碰文件。 */
export function buildReviewSheet(md: string, lex: Pick<Lexicon, 'known'>, opts: BuildReviewSheetOptions = {}): ReviewSheetManifest {
  // 已知集与 qc 同口径：词库 ∪ 不规则动词全表（was/had/went 不算超纲——
  // 冒烟实测漏并 IRR 时 was×7 霸榜首行，教师的审查单第一条就是误报）。
  const known = new Set([...lex.known, ...IRR, ...(opts.extraKnown ?? [])]);
  const paras = parasForReview(md);
  const allSents = paras.flatMap((p) => sentsOf(p, false));
  if (allSents.length === 0) throw new Error('未切分出任何句子（文本为空或只有标题？）');

  const toks = tokenizeTxt(allSents.join(' '));
  const oovToks = toks.filter((t) => !hit(t, known) && t.length > 1);

  // 词型聚合：出现次数 + 出处句（带 [P##] 的书稿与裸文本同一条路）
  const byWord = new Map<string, { count: number; sentences: ReviewSentenceSeg[] }>();
  for (const t of oovToks) {
    const w = t.toLowerCase();
    const cur = byWord.get(w) ?? { count: 0, sentences: [] };
    cur.count++;
    byWord.set(w, cur);
  }
  for (const w of byWord.keys()) {
    const cap = opts.maxSentences ?? 3;
    for (const s of allSents) {
      if (byWord.get(w)!.sentences.length >= cap) break;
      const seg = highlightSegments(s, w);
      if (seg) byWord.get(w)!.sentences.push(seg);
    }
  }

  const items: ReviewItem[] = [...byWord.entries()]
    .map(([word, v]) => ({
      word,
      count: v.count,
      sentences: v.sentences,
      ...(opts.candidates?.get(word) ? { candidate: opts.candidates.get(word) } : {}),
    }))
    .sort((a, b) => b.count - a.count || (a.word < b.word ? -1 : 1));

  const sourceVersion = contentHash(md);
  return {
    schemaVersion: REVIEW_SHEET_SCHEMA_VERSION,
    sheetId: `rs-${sourceVersion.slice(0, 12)}`,
    sourceFile: opts.fileName ?? '',
    sourceVersion,
    tier: opts.tier ?? 'M',
    builtAt: opts.builtAt ?? new Date().toISOString(),
    oovWordCount: items.length,
    items,
  };
}

// ---------------------------------------------------------------------------
// HTML 渲染
// ---------------------------------------------------------------------------

const htmlEscape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** 内嵌页面 JS。**零正则、零模板字符串**（单双引号拼接）——2026-10-05 定案：
 *  在内嵌 JS 里复刻高亮正则会炸模板字符串 ${}；这里页面 JS 只做 DOM 操作与数据收集，
 *  高亮三段由 TS 侧预计算直接嵌进 HTML。 */
const PAGE_JS = [
  '(function () {',
  "  var sheet = document.getElementById('lt-sheet-data');",
  "  var sheetId = sheet.getAttribute('data-sheet-id');",
  "  var sourceFile = sheet.getAttribute('data-source-file');",
  "  var sourceVersion = sheet.getAttribute('data-source-version');",
  "  var draftKey = 'lt-sheet-draft-' + sheetId;",
  "  var teacherInput = document.getElementById('lt-teacher');",
  "  var cards = [].slice.call(document.querySelectorAll('.card'));",
  '  var focusIdx = -1;',
  '  var draft = {};',
  "  try { draft = JSON.parse(localStorage.getItem(draftKey) || '{}'); } catch (e) { draft = {}; }",
  '  function saveDraft() { localStorage.setItem(draftKey, JSON.stringify(draft)); updateProgress(); }',
  '  function updateProgress() {',
  '    var n = Object.keys(draft).length;',
  "    var el = document.getElementById('lt-progress');",
  "    el.textContent = '\\u5DF2\\u5224 ' + n + ' / ' + cards.length;",
  '  }',
  '  function applyDraft() {',
  '    cards.forEach(function (c) {',
  "      var w = c.getAttribute('data-word');",
  "      if (draft[w]) { setCard(c, draft[w].action, draft[w].value || ''); }",
  '    });',
  '    updateProgress();',
  '  }',
  '  function setCard(card, action, value) {',
  "    card.className = 'card decided-' + action;",
  "    var badge = card.querySelector('.badge');",
  "    badge.textContent = { annotate: '\\u2460\\u8865\\u6CE8', replace: '\\u2461\\u6362\\u6210', ignore: '\\u2462\\u5FFD\\u7565' }[action] + (value ? ': ' + value : '');",
  '  }',
  '  function decide(card, action) {',
  "    var w = card.getAttribute('data-word');",
  "    var input = card.querySelector('input');",
  "    var value = (input && (action === 'annotate' || action === 'replace')) ? input.value.trim() : '';",
  "    if ((action === 'annotate' || action === 'replace') && !value) {",
  "      input.className = 'missing';",
  "      setTimeout(function () { input.className = ''; }, 600);",
  '      input.focus();',
  '      return;',
  '    }',
  "    input.className = '';",
  '    draft[w] = { action: action, value: value };',
  '    setCard(card, action, value);',
  '    saveDraft();',
  '    focusCard(cards.indexOf(card) + 1);',
  '  }',
  '  function focusCard(i) {',
  '    if (i < 0 || i >= cards.length) return;',
  '    focusIdx = i;',
  "    cards[i].classList.add('focused');",
  "    cards.forEach(function (c, j) { if (j !== i) c.classList.remove('focused'); });",
  "    cards[i].scrollIntoView({ block: 'center', behavior: 'smooth' });",
  '  }',
  '  cards.forEach(function (card, i) {',
  "    var w = card.getAttribute('data-word');",
  "    var btns = card.querySelectorAll('button[data-action]');",
  '    [].forEach.call(btns, function (b) {',
  "      b.addEventListener('click', function () { decide(card, b.getAttribute('data-action')); });",
  '    });',
  "    card.addEventListener('click', function () { focusIdx = i; focusCard(i); });",
  '  });',
  "  document.getElementById('lt-clear-draft').addEventListener('click', function () {",
  '    draft = {};',
  '    localStorage.removeItem(draftKey);',
  "    cards.forEach(function (c) { c.className = 'card'; var b = c.querySelector('.badge'); b.textContent = ''; });",
  '    updateProgress();',
  '  });',
  "  document.getElementById('lt-export').addEventListener('click', function () {",
  '    var decisions = [];',
  '    cards.forEach(function (c) {',
  "      var w = c.getAttribute('data-word');",
  '      if (draft[w]) decisions.push({ word: w, action: draft[w].action, value: draft[w].value });',
  '    });',
  '    var payload = {',
  "      schemaVersion: Number(sheet.getAttribute('data-schema-version')),",
  '      sheetId: sheetId,',
  '      sourceFile: sourceFile,',
  '      sourceVersion: sourceVersion,',
  "      teacherId: teacherInput.value.trim() || '\\u6E58\\u5B50',",
  '      decidedAt: new Date().toISOString(),',
  '      decisions: decisions',
  '    };',
  "    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });",
  "    var a = document.createElement('a');",
  '    a.href = URL.createObjectURL(blob);',
  "    a.download = '\\u5BA1\\u67E5\\u51B3\\u5B9A_' + (sourceFile || sheetId) + '.json';",
  '    a.click();',
  '    URL.revokeObjectURL(a.href);',
  '  });',
  "  document.addEventListener('keydown', function (e) {",
  "    if (e.target.tagName === 'INPUT') return;",
  "    if (e.key === 'j' || e.key === 'J') focusCard(focusIdx + 1);",
  "    else if (e.key === 'k' || e.key === 'K') focusCard(focusIdx - 1);",
  "    else if (focusIdx >= 0 && (e.key === '1' || e.key === '2' || e.key === '3')) {",
  "      var map = { '1': 'annotate', '2': 'replace', '3': 'ignore' };",
  '      decide(cards[focusIdx], map[e.key]);',
  '    }',
  '  });',
  '  applyDraft();',
  '})();',
].join('\n');

const PAGE_CSS = [
  "body { font-family: -apple-system, 'PingFang SC', sans-serif; margin: 0 auto; max-width: 640px; padding: 12px 12px 96px; color: #1a1a1a; background: #fafafa; }",
  'h1 { font-size: 18px; margin: 8px 0 4px; }',
  '.meta { font-size: 12px; color: #666; margin-bottom: 12px; }',
  '.card { border: 1px solid #ddd; border-radius: 12px; padding: 12px; margin: 10px 0; background: #fff; }',
  '.card.focused { border-color: #4a90d9; box-shadow: 0 0 0 2px rgba(74,144,217,.25); }',
  '.word { font-size: 20px; font-weight: 600; }',
  '.count { font-size: 12px; color: #888; margin-left: 6px; }',
  '.badge { display: inline-block; font-size: 12px; color: #2a6e2a; margin-left: 8px; min-height: 16px; }',
  '.card.decided-ignore .badge { color: #999; }',
  '.card.decided-replace .badge { color: #a05a00; }',
  '.sent { font-size: 14px; line-height: 1.6; color: #444; margin: 6px 0; }',
  '.sent mark { background: #ffe08a; padding: 0 2px; border-radius: 3px; }',
  '.row { display: flex; gap: 8px; margin-top: 8px; }',
  '.row input { flex: 1; font-size: 15px; padding: 8px 10px; border: 1px solid #ccc; border-radius: 8px; }',
  '.row input.missing { border-color: #d93025; background: #fce8e6; }',
  'button { font-size: 15px; padding: 8px 0; border: none; border-radius: 8px; flex: 1; }',
  "button[data-action='annotate'] { background: #e6f4ea; color: #137333; }",
  "button[data-action='replace'] { background: #fef7e0; color: #a05a00; }",
  "button[data-action='ignore'] { background: #f1f3f4; color: #5f6368; }",
  '.footer { position: fixed; left: 0; right: 0; bottom: 0; background: #fff; border-top: 1px solid #ddd; padding: 10px 12px; display: flex; gap: 8px; align-items: center; max-width: 640px; margin: 0 auto; }',
  '.footer #lt-progress { font-size: 13px; color: #444; min-width: 64px; }',
  '.footer button { background: #1a73e8; color: #fff; }',
  '.footer #lt-clear-draft { background: #f1f3f4; color: #5f6368; flex: 0 0 88px; }',
  '.teacher { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; font-size: 13px; }',
  '.teacher input { font-size: 14px; padding: 6px 8px; border: 1px solid #ccc; border-radius: 8px; width: 120px; }',
].join('\n');

/** 渲染自包含 HTML（无外链 JS/CSS、离线可用、手机优先）。 */
export function buildReviewSheetHtml(sheet: ReviewSheetManifest, teacherId = ''): string {
  const cards = sheet.items
    .map((it) => {
      const sents = it.sentences.map((s) => `<p class="sent">${htmlEscape(s.pre)}<mark>${htmlEscape(s.hit)}</mark>${htmlEscape(s.post)}</p>`).join('');
      const input = `<input type="text" value="${htmlEscape(it.candidate ?? '')}" placeholder="替换词 / 中文释义" autocomplete="off">`;
      return [
        `<div class="card" data-word="${htmlEscape(it.word)}">`,
        `  <span class="word">${htmlEscape(it.word)}</span><span class="count">×${it.count}</span><span class="badge"></span>`,
        sents,
        `  <div class="row">${input}</div>`,
        `  <div class="row">`,
        `    <button data-action="annotate">① 补注</button>`,
        `    <button data-action="replace">② 换成X</button>`,
        `    <button data-action="ignore">③ 忽略</button>`,
        `  </div>`,
        `</div>`,
      ].join('\n');
    })
    .join('\n');

  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>审查单 · ${htmlEscape(sheet.sourceFile || sheet.sheetId)}</title>`,
    `<style>${PAGE_CSS}</style>`,
    '</head>',
    '<body>',
    `<h1>超纲词审查单</h1>`,
    `<div class="meta">${htmlEscape(sheet.sourceFile || '(未命名)')} · ${sheet.oovWordCount} 词 · ${htmlEscape(sheet.tier)} 层口径 · ${htmlEscape(sheet.builtAt.slice(0, 10))}</div>`,
    `<div class="teacher">教师 <input id="lt-teacher" type="text" value="${htmlEscape(teacherId)}" placeholder="署名"></div>`,
    `<div id="lt-sheet-data" style="display:none" data-schema-version="${sheet.schemaVersion}" data-sheet-id="${htmlEscape(sheet.sheetId)}" data-source-file="${htmlEscape(sheet.sourceFile)}" data-source-version="${htmlEscape(sheet.sourceVersion)}"></div>`,
    cards,
    '<div class="footer">',
    '  <span id="lt-progress">已判 0 / 0</span>',
    '  <button id="lt-export">导出决定 JSON</button>',
    '  <button id="lt-clear-draft">清空草稿</button>',
    '</div>',
    `<script>\n${PAGE_JS}\n</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 决定 → 事件（ingest 的纯逻辑核）
// ---------------------------------------------------------------------------

export class ReviewValidationError extends Error {}

export interface IngestResult {
  events: DecisionEvent[];
  /** 已在台账里的同 eventId 事件数（幂等跳过） */
  skipped: number;
  /** 清单里有、但决定里没判的词（下轮审查单还要带着） */
  pendingWords: string[];
}

/**
 * 决定 JSON → 校验 → DecisionEvent[]。**只校验不执行改文**。
 *
 * 校验失败抛 ReviewValidationError（台账一个字都不落——半份决定进台账比没有更危险）；
 * 通过则返回事件（含 JSONL 行生成由调用方用 toDecisionLine 完成）。
 * 幂等：eventId = f(itemId, decision, teacherId, timestamp)，同一个人同一毫秒对同一词的
 * 同一决定永远同 ID——existingEvents 里已有的直接跳过并计数。
 */
export function reviewEventsFromDecisions(decisions: ReviewDecisionsFile, sheet: ReviewSheetManifest, existingEvents: readonly DecisionEvent[] = []): IngestResult {
  if (decisions.schemaVersion !== REVIEW_SHEET_SCHEMA_VERSION) throw new ReviewValidationError(`决定文件 schemaVersion=${decisions.schemaVersion}，审查单只认 ${REVIEW_SHEET_SCHEMA_VERSION}`);
  if (decisions.sheetId !== sheet.sheetId) throw new ReviewValidationError(`sheetId 对不上：决定文件 ${decisions.sheetId} ≠ 清单 ${sheet.sheetId}——这份决定不是对着这张审查单做的`);
  if (decisions.sourceVersion !== sheet.sourceVersion)
    throw new ReviewValidationError(`sourceVersion 对不上：源文件改过之后旧决定不能入库（决定 ${decisions.sourceVersion} ≠ 清单 ${sheet.sourceVersion}）——请重审新版本`);
  if (!decisions.teacherId?.trim()) throw new ReviewValidationError('teacherId 不能为空——多教师并行时无法审计');

  const items = new Map(sheet.items.map((it) => [it.word, it]));
  const seen = new Set<string>();
  for (const d of decisions.decisions ?? []) {
    const w = (d.word ?? '').toLowerCase();
    if (!items.has(w)) throw new ReviewValidationError(`「${d.word}」不在审查单清单里——清单与决定必须同源`);
    if (seen.has(w)) throw new ReviewValidationError(`「${d.word}」出现了两次——一词一票，改主意用撤销不用重投`);
    seen.add(w);
    if (!REVIEW_ACTIONS.includes(d.action)) throw new ReviewValidationError(`「${w}」的动作 ${String(d.action)} 不在 ${REVIEW_ACTIONS.join('/')}`);
    const value = (d.value ?? '').trim();
    if (d.action === 'replace' && !value) throw new ReviewValidationError(`「${w}」选了换成X但没有替换词`);
    if (d.action === 'replace' && value.toLowerCase() === w) throw new ReviewValidationError(`「${w}」替换成它自己——这是无效决定`);
    if (d.action === 'annotate' && !value) throw new ReviewValidationError(`「${w}」选了补注但没有释义`);
  }

  const existing = new Set(existingEvents.map((e) => e.eventId));
  const events: DecisionEvent[] = [];
  let skipped = 0;
  for (const d of decisions.decisions ?? []) {
    const w = d.word.toLowerCase();
    const it = items.get(w)!;
    const first = it.sentences[0];
    const before = first ? first.pre + first.hit + first.post : w;
    // 三键 → 决定种类的映射（与传播机制咬合）：
    //   补注=accept（释义资产可传播） / 换成X=edit（只记待办） / 忽略=false-positive（本层不再提示）
    const decision = d.action === 'annotate' ? 'accept' : d.action === 'replace' ? 'edit' : 'false-positive';
    const after = d.action === 'annotate' ? `${w}（${d.value!.trim()}）` : d.action === 'replace' ? d.value!.trim() : before;
    const e = makeDecisionEvent({
      itemId: `${sheet.sheetId}:${w}`,
      decision,
      before,
      after,
      reason: `审查单·${REVIEW_ACTION_LABEL[d.action]}`,
      ruleIds: [REVIEW_RULE_ID],
      teacherId: decisions.teacherId.trim(),
      timestamp: decisions.decidedAt || undefined,
      sourceVersion: sheet.sourceVersion,
      tier: sheet.tier,
      subject: { kind: 'word', value: w },
    });
    if (existing.has(e.eventId)) {
      skipped++;
      continue;
    }
    events.push(e);
  }
  return { events, skipped, pendingWords: sheet.items.map((i) => i.word).filter((w) => !seen.has(w)) };
}

/** 台账追加行（一行一条，append-only 正本）。 */
export const reviewEventLines = (r: IngestResult): string => r.events.map(toDecisionLine).join('');
