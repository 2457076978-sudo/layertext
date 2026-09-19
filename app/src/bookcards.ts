/**
 * 数据面板的书级卡片接线（功能四项 · 项 1/项 3，2026-09-19）：层间体检 + 本周复现清单。
 * 为什么单独一个模块：`datapanel.ts` 撞上了 `max-lines: 1000`，而这两张卡的运行接线
 * 自成一体（先例见 propagateui.ts / qcdensity.ts）。
 *
 * 卡片 HTML 构造在 crosstier.ts / weekly.ts（纯函数）；本模块只做 IO 装配与事件接线。
 */

import { crossTierCardHtml, crossTierOf, type CrossTierReport } from './crosstier.js';
import { loadWeeklyQueue, weeklyCardHtml } from './weekly.js';
import { loadBookChaptersFromPath } from './bookscan.js';
import { setStatus } from './state.js';

/** 层间体检卡的接线：运行按钮 + 倒挂段行跳转（读 data-path 与 data-seg——段号进状态行，跳完看得见去了哪）。 */
function wireCrossTierCard(scope: HTMLElement, bookDir: string): void {
  scope.querySelector('#dp-crosstier-run')?.addEventListener('click', () => void runCrossTier(bookDir));
  scope.querySelectorAll<HTMLElement>('.dp-ct-inv').forEach((row) =>
    row.addEventListener(
      'click',
      () =>
        void (async () => {
          const path = row.dataset.path ?? '';
          const seg = row.dataset.seg ?? '';
          setStatus(`层间体检：跳到 ${path.slice(path.lastIndexOf('/') + 1)} 的 ${seg}——处理完这段倒挂可重新体检`, 'info');
          (await import('./uibus.js')).uibus.openPathIntoSession(path);
        })(),
    ),
  );
}

/** 层间体检（项 1）：扫书 → 逐章 acceptanceV2（crosstier 装配）→ 重画卡。
 *  known/proper 与词画卷报告同源（S.currentKnown / S.properRows）；源稿=章目录里的
 *  原文_规范化.md（有才算语义维度，没有=未算不是零）。 */
async function runCrossTier(bookDir: string): Promise<void> {
  const wrap = document.getElementById('dp-crosstier-wrap');
  if (!wrap) return;
  wrap.innerHTML = crossTierCardHtml(null, true);
  try {
    const { S } = await import('./state.js');
    const { readTextChecked } = await import('./fsx.js');
    const { findProjectConfig } = await import('./datapanel.js');
    const found = bookDir ? await findProjectConfig(bookDir) : null;
    const naming = ((found?.config as Record<string, unknown> | undefined)?.['产物命名'] ?? { A: 'A层85', M: 'M层75', B: 'B层60' }) as Record<string, string>;
    const scan = await loadBookChaptersFromPath(bookDir || null, naming);
    /* 源稿发现：AF 布局=章目录里 原文_规范化.md；平铺布局没有=语义维度未算（卡片写明） */
    const srcDirOf = new Map<string, string>();
    for (const row of scan.chapters) srcDirOf.set(row.name, row.path.slice(0, row.path.lastIndexOf('/')));
    const srcOf = new Map<string, string>();
    for (const [name, dir] of srcDirOf) {
      const r = await readTextChecked(`${dir}/原文_规范化.md`);
      if (r.kind === 'ok') srcOf.set(name, r.text);
    }
    const report: CrossTierReport = crossTierOf(scan, {
      known: S.currentKnown,
      proper: S.properRows ?? [],
      ...(srcOf.size ? { sourceOf: (ch: string) => srcOf.get(ch) ?? null } : {}),
    });
    wrap.innerHTML = crossTierCardHtml(report, false);
    wireCrossTierCard(wrap, bookDir);
    setStatus(
      report.汇总.倒挂段总数
        ? `层间体检：${report.汇总.倒挂段总数} 段倒挂（点行跳 B 层产物）——${report.汇总.章数} 章已体检`
        : `层间体检完成：${report.汇总.章数} 章${report.未算.length ? `（另有 ${report.未算.length} 章缺层未算）` : ''}`,
      report.汇总.倒挂段总数 ? 'info' : 'saved',
    );
  } catch (e) {
    wrap.innerHTML = crossTierCardHtml(null, false);
    wireCrossTierCard(wrap, bookDir);
    setStatus(`层间体检没跑成：${String(e).slice(0, 120)}`, 'err');
  }
}

/** 本周复现清单（项 3）：读最新复现队列 → FSRS weeklyDue → 重画卡（教师端 only）。 */
async function runWeekly(bookDir: string): Promise<void> {
  const wrap = document.getElementById('dp-weekly-wrap');
  if (!wrap) return;
  wrap.innerHTML = weeklyCardHtml(null, true);
  try {
    const w = await loadWeeklyQueue(bookDir || null);
    wrap.innerHTML = weeklyCardHtml(w, false);
    wrap.querySelector('#dp-weekly-run')?.addEventListener('click', () => void runWeekly(bookDir));
    setStatus(
      w.due.length ? `本周复现：${w.due.length} 词到期（出题将优先用它们）` : w.queuePath ? `本周没有到期词（队列 ${w.queue.length} 词）` : '这本书还没有复现队列——先在章内「导出生词卡」',
      w.due.length ? 'info' : 'saved',
    );
  } catch (e) {
    wrap.innerHTML = weeklyCardHtml(null, false);
    wrap.querySelector('#dp-weekly-run')?.addEventListener('click', () => void runWeekly(bookDir));
    setStatus(`本周清单没读成：${String(e).slice(0, 120)}`, 'err');
  }
}

/** 面板挂载入口：两张卡的事件接线（datapanel 渲染后调用一次）。 */
export function wireBookCards(el: HTMLElement, bookDir: string): void {
  el.querySelector('#dp-crosstier-run')?.addEventListener('click', () => void runCrossTier(bookDir));
  wireCrossTierCard(el, bookDir);
  el.querySelector('#dp-weekly-run')?.addEventListener('click', () => void runWeekly(bookDir));
}
