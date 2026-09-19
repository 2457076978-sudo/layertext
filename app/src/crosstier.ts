/**
 * 层间体检（功能四项 · 项 1，2026-09-19）：验收 v2 七维度尺子进 App。
 *
 * 做什么：把 bookscan 收上来的全书各层文本，逐章喂 `src/core/acceptance.ts` 的
 * `acceptanceV2`（唯一判定实现——词画卷先例，App 直接 runtime-import），把
 * 「三层难度排序 / 同段倒挂 / 句长梯度 / 注密度 / 结构 / 重复注」摆到教师面前。
 * 为什么值得做：层间倒挂肉眼抓不住（09-17 ch1 审阅才实锤 B 层倒挂），机器早会算，
 * 结果此前只在 CLI 报告里。
 *
 * 边界（规划定案 1）：
 *  · 语义维度需要源稿——没提供 sourceOf 时**显式"未算"**（hasSemantic=false、计数 null），
 *    不静默当零警报；单层/缺 A 或 B 的章点名进「未算」清单。
 *  · 判定维度零自算（纪律扫描锁）；判读只消费报告字段，不重算比值。
 */

import { acceptanceV2, segsOfMd, type AcceptanceV2Report } from '../../src/core/acceptance.js';
import type { BookScanResult } from './bookscan.js';

export interface CrossTierChapter {
  章: string;
  /** 参与判定的层与产物路径（倒挂段点行跳 B 层产物） */
  paths: { A: string; M?: string; B: string };
  rates: AcceptanceV2Report['rates'];
  rateOrderPass: boolean;
  倒挂段: Array<{ seg: string; bUnnoted: number; aUnnoted: number; words: string[]; bPath: string }>;
  句长: { avgA: number; avgB: number; ratio: number; pass: boolean };
  密度: AcceptanceV2Report['density'];
  结构数: number;
  /** null = 该章无源稿，语义维度未算（不是 0 条警报） */
  语义警报数: number | null;
  重复注数: number;
}

export interface CrossTierReport {
  chapters: CrossTierChapter[];
  /** 没进判定的章点名（单层/缺 A 或 B）——静默跳过是最坏的一种 */
  未算: Array<{ 章: string; 原因: string }>;
  /** 语义维度整体有没有算（没有 sourceOf 时为 false，卡片要说明） */
  hasSemantic: boolean;
  汇总: { 章数: number; 排序不成立章数: number; 倒挂段总数: number; 句长超线章数: number; 结构总数: number; 重复注总数: number; 语义警报总数: number | null };
}

export interface CrossTierOpts {
  known: Iterable<string>;
  proper?: Iterable<string>;
  /** 源稿（原文 md 文本）按章取；缺省=语义维度整体未算 */
  sourceOf?: (chapter: string) => string | null;
}

/** 纯装配：扫书结果 → 逐章验收 v2。A 与 B 两层齐才判（M 有则并入）；其余点名未算。 */
export function crossTierOf(scan: BookScanResult, opts: CrossTierOpts): CrossTierReport {
  const byChapter = new Map<string, Map<string, { text: string; path: string }>>();
  for (const row of scan.chapters) {
    if (!row.tier) continue;
    const m = byChapter.get(row.name) ?? new Map();
    m.set(row.tier, { text: row.text, path: row.path });
    byChapter.set(row.name, m);
  }
  const proper = [...(opts.proper ?? [])].map((p) => String(p).toLowerCase());
  const chapters: CrossTierChapter[] = [];
  const 未算: CrossTierReport['未算'] = [];
  for (const [name, tiers] of byChapter) {
    const a = tiers.get('A');
    const b = tiers.get('B');
    if (!a || !b) {
      未算.push({ 章: name, 原因: !a && !b ? '只有一层（无 A、B 层产物）——层间比较无从谈起' : `缺 ${a ? 'B' : 'A'} 层产物` });
      continue;
    }
    const m = tiers.get('M');
    const src = opts.sourceOf?.(name) ?? null;
    const r = acceptanceV2({
      tiers: { A: a.text, ...(m ? { M: m.text } : {}), B: b.text },
      ...(src ? { source: segsOfMd(src) } : {}),
      known: opts.known,
      proper,
    });
    chapters.push({
      章: name,
      paths: { A: a.path, ...(m ? { M: m.path } : {}), B: b.path },
      rates: r.rates,
      rateOrderPass: r.rateOrderPass,
      倒挂段: r.segInversions.map((x) => ({ ...x, bPath: b.path })),
      句长: r.sentGradient,
      密度: r.density,
      结构数: r.structure.length,
      语义警报数: opts.sourceOf ? r.semantic.length : null,
      重复注数: r.duplicateAnnos.length,
    });
  }
  const semanticChapters = chapters.filter((c) => c.语义警报数 !== null);
  return {
    chapters,
    未算,
    hasSemantic: Boolean(opts.sourceOf),
    汇总: {
      章数: chapters.length,
      排序不成立章数: chapters.filter((c) => !c.rateOrderPass).length,
      倒挂段总数: chapters.reduce((n, c) => n + c.倒挂段.length, 0),
      句长超线章数: chapters.filter((c) => !c.句长.pass).length,
      结构总数: chapters.reduce((n, c) => n + c.结构数, 0),
      重复注总数: chapters.reduce((n, c) => n + c.重复注数, 0),
      语义警报总数: chapters.length && !semanticChapters.length ? null : semanticChapters.reduce((n, c) => n + (c.语义警报数 ?? 0), 0),
    },
  };
}

/* ── 人话判读（纯函数；只消费报告字段，不重算任何比值）────────────────── */

/** 全书一句话判读：排序成立度 + 最大两根短板，说"哪一章哪一件事"，不说百分比术语。 */
export function crossTierVerdict(r: CrossTierReport): string {
  if (!r.chapters.length)
    return `这本书没有可做层间体检的章（${
      r.未算.length
        ? `扫到的章：${r.未算
            .slice(0, 2)
            .map((u) => u.章)
            .join('、')}${r.未算.length > 2 ? ' 等' : ''}都缺层`
        : '没扫到层产物'
    }）`;
  const bad: string[] = [];
  if (r.汇总.倒挂段总数 > 0) {
    const worst = [...r.chapters].sort((x, y) => y.倒挂段.length - x.倒挂段.length)[0]!;
    bad.push(`同段倒挂 ${r.汇总.倒挂段总数} 段（最多在 ${worst.章}：${worst.倒挂段.length} 段——B 层比 A 层还难）`);
  }
  if (r.汇总.排序不成立章数 > 0) bad.push(`${r.汇总.排序不成立章数} 章三层生词率顺序不对（B 应最易）`);
  if (r.汇总.句长超线章数 > 0) bad.push(`${r.汇总.句长超线章数} 章 B 层均句长超 A 层 15% 容差`);
  if (r.汇总.结构总数 > 0) bad.push(`结构问题 ${r.汇总.结构总数} 条`);
  if (bad.length === 0) return `${r.汇总.章数} 章全部通过：三层难度顺序成立、无同段倒挂、句长梯度在线——层间健康`;
  return `${r.汇总.章数} 章体检：${bad.slice(0, 3).join('；')}${bad.length > 3 ? ` 等 ${bad.length} 项` : ''}——点下方倒挂段可跳到 B 层产物逐段处理`;
}

/** 单章一行判读（章名 + 排序 + 梯度 + 密度并排，全部消费现成字段） */
export function crossTierChapterLine(c: CrossTierChapter): string {
  const rates = `生词率 A ${c.rates.A?.ratePct ?? '—'}% / M ${c.rates.M?.ratePct ?? '—'}% / B ${c.rates.B?.ratePct ?? '—'}%`;
  const order = c.rateOrderPass ? '顺序✓' : '顺序✗';
  const sent = c.句长.pass ? `句长 ${c.句长.avgA}→${c.句长.avgB}✓` : `句长 ${c.句长.avgA}→${c.句长.avgB}✗（${c.句长.ratio} 超 1.15）`;
  const dens = `注密度 ${c.密度.A?.per100 ?? '—'}/${c.密度.M?.per100 ?? '—'}/${c.密度.B?.per100 ?? '—'}`;
  return `${c.章}：${rates} ${order}｜${sent}｜${dens}`;
}

/* ── 卡片 HTML（字符串构造，测试可断言；跳转经 data-* 由 datapanel 接线）────────── */

const escHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function crossTierCardHtml(r: CrossTierReport | null, running: boolean): string {
  const head = `<div class="dp-card"><b>层间体检</b>（验收 v2：A/M/B 三层一起看）`;
  if (running) return `${head}<br><span class="dim">扫描中…</span></div>`;
  if (!r)
    return `${head}<br><span class="dim">同一本书有 A、B 两层产物时可体检：三层难度顺序 / 同段倒挂 / 句长梯度 / 注密度。</span><br><button id="dp-crosstier-run" style="font-size:var(--fs-xs);padding:2px 8px">体检这本书</button></div>`;
  const invRows = r.chapters
    .flatMap((c) =>
      c.倒挂段.map(
        (x) =>
          `<div class="dp-ct-inv" data-path="${escHtml(x.bPath)}" data-seg="${escHtml(x.seg)}" title="跳到 ${escHtml(x.bPath)} 的 ${escHtml(x.seg)}——B 层此段比 A 层难（未注 ${x.bUnnoted} > ${x.aUnnoted}）">${escHtml(c.章)} ${escHtml(x.seg)}：B 未注 ${x.bUnnoted} > A ${x.aUnnoted}${x.words.length ? `（${x.words.slice(0, 5).map(escHtml).join(' ')}${x.words.length > 5 ? '…' : ''}）` : ''} ▸</div>`,
      ),
    )
    .join('');
  return `${head}<br>
    <span>${escHtml(crossTierVerdict(r))}</span><br>
    ${r.chapters.map((c) => `<span class="dim" style="font-size:var(--fs-xs)">${escHtml(crossTierChapterLine(c))}${c.语义警报数 === null ? '｜语义：未算（无源稿）' : c.语义警报数 > 0 ? `｜语义警报 ${c.语义警报数}` : ''}</span><br>`).join('')}
    ${
      r.未算.length
        ? `<span class="dim" style="font-size:var(--fs-xs)">未算 ${r.未算.length} 章：${r.未算
            .slice(0, 3)
            .map((u) => `${escHtml(u.章)}（${escHtml(u.原因)}）`)
            .join('、')}${r.未算.length > 3 ? ' 等' : ''}</span><br>`
        : ''
    }
    ${invRows ? `<div style="max-height:140px;overflow:auto">${invRows}</div>` : ''}
    <span class="dim" style="font-size:var(--fs-xs)"><button id="dp-crosstier-run" style="font-size:var(--fs-xs);padding:2px 8px">重新体检</button>语义维度需章目录里有 原文_规范化.md；点倒挂段行跳 B 层产物。</span>
  </div>`;
}
