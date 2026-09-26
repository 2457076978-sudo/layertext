/**
 * 债务总览卡（复盘方案 A6，2026-09-26）——数据面板③「我还要做什么」组
 *
 * 把散在台账/报告里的三类内容债（回炉挂起段 / 工序化隔离段 / 源残缺章）收进一张卡：
 * 数量 + 入口（点行 reveal 原始文件）+ 最后处理日期。
 *
 * 纪律（crosstier 同款）：**不自算**——回炉数字解析自 `回炉重测_*.md` 报告（重测逻辑
 * 在 CLI --recheck，App 只读结论）；隔离数解析自各章 `_待复核/工序化待人工_*.md`
 * 的表头；源体检直调 core 唯一实现 `probeChapterSource`（装配不自算）。
 * tests/debtcard.test.ts 扫描锁：禁止本模块出现闸门/验收的重新实现。
 */

import { probeChapterSource } from '../../src/core/sourceprobe.js';

export interface DebtRecheck {
  digested: number;
  still: number;
  missing: number;
  date: string;
  path: string;
}

export interface DebtQuarantine {
  total: number;
  byTier: Record<string, number>;
  files: number;
  date: string;
  firstPath: string;
}

export interface DebtState {
  recheck: DebtRecheck | null;
  quarantine: DebtQuarantine | null;
  sourceBad: Array<{ name: string; words: number; notes: string[]; path: string }>;
}

/** 解析回炉重测报告表头：「台账挂起去重 209 段：**已消化 94｜仍挂 114**｜产物缺失 1。」 */
export function parseRecheckHeader(md: string): { digested: number; still: number; missing: number } | null {
  /* 表头原样带 **加粗**：「**已消化 94｜仍挂 114**｜产物缺失 1」——星号在数字与竖线之间，正则要放行 */
  const m = md.match(/已消化\s*(\d+)｜仍挂\s*(\d+)\**｜产物缺失\s*(\d+)/);
  return m ? { digested: Number(m[1]), still: Number(m[2]), missing: Number(m[3]) } : null;
}

/** 解析待人工清单表头：「总段数 14｜自动完成 9｜隔离 5（事实疑点 0｜…）」 */
export function parseQuarantineHeader(md: string): number | null {
  const m = md.match(/隔离\s*(\d+)（/);
  return m ? Number(m[1]) : null;
}

export function debtCardHtml(st: DebtState | null, running: boolean): string {
  const head = `<div class="side-card-h" title="回炉挂起、工序化隔离、源残缺三类内容债的总览——数字来自台账与报告，本卡不自算">债务总览<span class="sp"></span><span class="dim" style="font-size:12px">还有什么没收口</span></div>`;
  if (running) return `<div class="side-card dp-debt">${head}<div class="dp-note">正在读台账与报告…</div></div>`;
  if (!st) return `<div class="side-card dp-debt">${head}<div class="dp-note">还没有可读的债务台账（没有回炉重测报告/待人工清单，或项目没配产物目录）。</div></div>`;
  const rows: string[] = [];
  if (st.recheck) {
    rows.push(
      `<div class="dp-row" data-dp-debt="recheck" style="cursor:pointer" title="点开回炉重测报告">${st.recheck.date}｜回炉仍挂 <b>${st.recheck.still}</b> 段（已消化 ${st.recheck.digested}${st.recheck.missing ? `｜产物缺失 ${st.recheck.missing}` : ''}）——重测于 ${st.recheck.date}，清单在报告里</div>`,
    );
  } else {
    rows.push('<div class="dp-row dim">回炉：还没有重测报告（跑一次 CLI --recheck 后这里出数）</div>');
  }
  if (st.quarantine && st.quarantine.total > 0) {
    const byTier = Object.entries(st.quarantine.byTier)
      .map(([t, n]) => `${t} ${n}`)
      .join('·');
    rows.push(
      `<div class="dp-row" data-dp-debt="quarantine" style="cursor:pointer" title="点开第一份待人工清单">${st.quarantine.date}｜工序化隔离 <b>${st.quarantine.total}</b> 段（${byTier}｜${st.quarantine.files} 份待人工清单）——二次重拆待拍板</div>`,
    );
  } else {
    rows.push('<div class="dp-row dim">工序化：各章 _待复核/ 里没有待人工清单（或都已清空）</div>');
  }
  if (st.sourceBad.length) {
    for (const c of st.sourceBad)
      rows.push(
        `<div class="dp-row" data-dp-debt="source" data-dp-src="${c.name}" style="cursor:pointer" title="点开该章原文">源残缺：<b>${c.name}</b>（${c.words} 词）——${c.notes.join('；')}——补源或 --partial-chapter 声明</div>`,
      );
  } else {
    rows.push('<div class="dp-row dim">源体检：各章原文完整（词数骤降/章末无收束/碎片残留均无嫌疑）</div>');
  }
  return `<div class="side-card dp-debt">${head}<div class="dp-note" style="line-height:1.9">${rows.join('')}</div></div>`;
}

/** 读三类债务（只读既有文件；产物/原文目录来自项目配置）。 */
export async function readDebtState(
  project: { 原文目录?: string; 产物目录?: string },
  io: { listDir(dir: string, exts?: string[]): Promise<string[]>; read(p: string): Promise<string>; reveal(p: string): Promise<void> },
): Promise<DebtState> {
  const st: DebtState = { recheck: null, quarantine: null, sourceBad: [] };
  const out = project.产物目录;
  if (out) {
    /* 回炉重测报告：取字典序最新（文件名带日期） */
    try {
      const runs = (await io.listDir(`${out}/_运行`, ['md'])).filter((f) => /回炉重测_\d{4}-\d{2}-\d{2}\.md$/.test(f.split('/').pop() ?? ''));
      if (runs.length) {
        const path = runs.sort().at(-1)!;
        const head = (await io.read(path)).split('\n').slice(0, 5).join('\n');
        const parsed = parseRecheckHeader(head);
        if (parsed) st.recheck = { ...parsed, date: (path.match(/(\d{4}-\d{2}-\d{2})\.md$/) ?? [])[1] ?? '', path };
      }
    } catch {
      /* 有意兜底：_运行 不在=没有回炉历史，卡上如实说"还没有重测报告" */
    }
    /* 工序化隔离：各章 _待复核/工序化待人工_*.md 表头的"隔离 N"求和 */
    try {
      const chapters = await io.listDir(out, []);
      let total = 0;
      let files = 0;
      const byTier: Record<string, number> = {};
      let date = '';
      let firstPath = '';
      for (const ch of chapters.filter((c) => !c.split('/').pop()!.startsWith('_'))) {
        const list = (await io.listDir(`${ch}/_待复核`, ['md'])).filter((f) => /工序化待人工_.+\.md$/.test(f.split('/').pop() ?? ''));
        for (const f of list.sort()) {
          const head = (await io.read(f)).split('\n').slice(0, 3).join('\n');
          const n = parseQuarantineHeader(head);
          if (n === null) continue;
          total += n;
          files++;
          const tier = (f.match(/待人工_(.+层)\d*/) ?? [])[1] ?? (f.match(/待人工_([^_]+)_/) ?? [])[1] ?? '?';
          byTier[tier] = (byTier[tier] ?? 0) + n;
          const d = (f.match(/(\d{4}-\d{2}-\d{2})\.md$/) ?? [])[1] ?? '';
          if (d > date) date = d;
          if (!firstPath) firstPath = f;
        }
      }
      if (files) st.quarantine = { total, byTier, files, date, firstPath };
    } catch {
      /* 有意兜底：产物目录扫不了=隔离数不展示，不拦整卡 */
    }
  }
  /* 源体检：直调 core 唯一实现（装配不自算） */
  const src = project.原文目录;
  if (src) {
    try {
      const chapters = (await io.listDir(src, [])).filter((c) => !c.split('/').pop()!.startsWith('_'));
      const inputs: Array<{ name: string; text: string }> = [];
      const pathOf = new Map<string, string>();
      for (const ch of chapters) {
        const name = ch.split('/').pop()!;
        const file = `${ch}/原文_规范化.md`;
        const text = await io.read(file).catch(() => {
          /* 有意兜底：某章原文读不到=跳过该章（源体检按已读章算，缺章不拦整卡） */
          return '';
        });
        if (text) {
          inputs.push({ name, text });
          pathOf.set(name, file);
        }
      }
      for (const r of probeChapterSource(inputs)) if (!r.ok) st.sourceBad.push({ name: r.name, words: r.words, notes: r.suspects.map((s) => s.message), path: pathOf.get(r.name) ?? '' });
    } catch {
      /* 有意兜底：原文目录读不了=源体检行如实说不出，不拦整卡 */
    }
  }
  return st;
}
