/**
 * QC 指标的人话判读（功能四项 · 项 2，2026-09-19）——README 规划项「指标：数字+人话判读成对」整页落地。
 *
 * 规矩（规划定案 2）：**阈值锚点全部来自项目已定标的数据，零新造**——
 *  · 生词率档位目标：≤2% 顺畅 / 2-5% 可读 / 5-10% 吃力 / >10% 读不下去（两轮调适制定标）；
 *  · 句长：贵阳中考 11 年卷定标（P50≈9-10、P75≈14、干净年 P90 17-20 词）——
 *    LayerText_文档/句长定标_贵阳中考_2026-09-16.md；
 *  · 注密度：引擎 ANNO_DENSITY_WARN=8（v2.1，qcdensity.ts 消费）；
 *  · 加注覆盖率：95% 解释线 / 80% 事故线（回放层守卫既有口径）；
 *  · 覆盖率文献带：95% 最低限度理解（Laufer 1989）/ 98% 无辅助顺畅（Hu & Nation 2000）。
 * 判读不改指标本体、不做任何再计算（比值都来自报告现成字段）；全部纯函数（可单测）。
 */

import type { QcResult } from '../../src/core/qc.js';

const pct = (x: number): string => (x * 100).toFixed(1) + '%';

/** ① 词表覆盖率（注释后口径） */
export function readoutCoverage(c: number): string {
  if (c >= 0.98) return `覆盖 ${pct(c)}：98%+ = 无辅助顺畅阅读带（Hu & Nation 2000）——可以放手读`;
  if (c >= 0.95) return `覆盖 ${pct(c)}：95-98% = 最低限度理解带（Laufer 1989）——可读，但难词支架要跟上`;
  if (c >= 0.9) return `覆盖 ${pct(c)}：90-95% 偏紧——约每 10-20 词 1 个生词，基础层学生会卡，考虑先补词库`;
  return `覆盖 ${pct(c)}：不足 90%——生词密度过高，先补词库或降难度再交付`;
}

/** ② 生词率（词型）——两轮调适制档位目标 */
export function readoutNewWordRate(rate: number): string {
  const p = rate * 100;
  if (p <= 2) return `生词率 ${p.toFixed(1)}%：≤2% 顺畅档——学生可以自己读下去`;
  if (p <= 5) return `生词率 ${p.toFixed(1)}%：2-5% 可读档——大意能懂，关键词需要支架`;
  if (p <= 10) return `生词率 ${p.toFixed(1)}%：5-10% 吃力档——读得完但费劲，加注或再简化一档`;
  return `生词率 ${p.toFixed(1)}%：>10% 读不下去档——这版不适合直接给学生，重简化`;
}

/** ③ 平均句长——贵阳中考 11 年卷定标（P50≈9-10 / P75=14 / 干净年 P90 17-20） */
export function readoutAvgLen(len: number, maxLen: number): string {
  if (len > maxLen) return `均句长 ${len.toFixed(1)} 词：超当前简化标准（${maxLen}）——先拆长句再看中考带`;
  if (len <= 10) return `均句长 ${len.toFixed(1)} 词：中考卷主流水平（P50≈9-10）——与考试阅读同密度`;
  if (len <= 14) return `均句长 ${len.toFixed(1)} 词：中考 P75（14 词）以内——舒适`;
  if (len <= 20) return `均句长 ${len.toFixed(1)} 词：过 P75、仍在干净年 P90（17-20）带内——有点长，能接受`;
  return `均句长 ${len.toFixed(1)} 词：超出中考 P90——句子偏难，优先拆句`;
}

/** ④ 单句最长 */
export function readoutMaxLen(len: number, maxLen: number): string {
  return len > maxLen ? `最长句 ${len} 词超线（标准 ${maxLen}）——去「句法难句」逐句处理` : `最长句 ${len} 词在线内（标准 ${maxLen}）`;
}

/** ⑤ 超长句数 */
export function readoutOverCount(n: number): string {
  return n === 0 ? '无超长句' : `${n} 句超线——个别文学长句可人工放行，其余建议拆句`;
}

/** ⑥ 句法黑名单（被动/定语从句/过去完成）——初中教学进度一律禁用，判「违反标准」不给建议 */
export function readoutBannedItems(passive: number, relcl: number, pastperf: number): string {
  const n = passive + relcl + pastperf;
  if (n === 0) return '无禁用句法';
  const bits = [passive ? `被动×${passive}` : '', relcl ? `定从×${relcl}` : '', pastperf ? `过去完成×${pastperf}` : ''].filter(Boolean).join('、');
  return `${n} 处违反简化标准（${bits}）——一律禁用，逐条改写不是建议`;
}

/** ⑦ 待定词命中 */
export function readoutPending(n: number): string {
  return n === 0 ? '无待定词' : `${n} 个待定词等你逐个定去留——定完才进正本`;
}

/** ⑪ 加注覆盖率——95% 解释线 / 80% 事故线（回放层守卫既有口径） */
export function readoutAnnoCoverage(c: number): string {
  const p = c * 100;
  if (p >= 95) return `加注覆盖率 ${p.toFixed(1)}%：≥95% 守卫线——该注的基本都注到了`;
  if (p >= 80) return `加注覆盖率 ${p.toFixed(1)}%：80-95% 之间有漏注——对照生词清单补齐`;
  return `加注覆盖率 ${p.toFixed(1)}%：低于 80% 是事故级（回放层红线）——立刻补注再交付`;
}

/** ⑩ 复现命中（无队列时不出场，调用方控制） */
export function readoutReinforce(hits: number, tokens: number): string {
  return hits > 0 ? `复现命中 ${hits} 词种/${tokens} 词次——已学词在本篇重现，支架在起作用` : '本篇没有复现队列词重现（队列词可安排进后续章节）';
}

/* ── 组装层 ──────────────────────────────────────────────────────────── */

/** 门禁弹层·QC 核对表（项 2b）：从 chat.ts 移入并逐行配判读；注密度行由调用方传入（qcdensity 唯一实现）。 */
export function gateTableHtml(r: QcResult, maxLen: number, densRow: { name: string; value: string; ref: string; warn: boolean } | null): string {
  const row = (name: string, value: string, ref: string, warn = false) => `<tr class="${warn ? 'warnrow' : ''}"><td>${name}</td><td>${value}</td><td>${ref}</td></tr>`;
  return `
    <table class="gtable">
      <tr><th>指标</th><th>本章实际（人话判读）</th><th>参考</th></tr>
      ${row('词表覆盖率', `${(r.coverage * 100).toFixed(1)}%`, readoutCoverage(r.coverage).split('：')[1] ?? '')}
      ${row('生词率（词型）', `${(r.newWordRate * 100).toFixed(1)}%`, readoutNewWordRate(r.newWordRate).split('：')[1] ?? '')}
      ${row('平均句长', `${r.avgLenNarrRaw.toFixed(1)} 词`, `${readoutAvgLen(r.avgLenNarrRaw, maxLen).split('：')[1] ?? ''}（≤ ${maxLen} 词，ⓘ 可调）`, r.avgLenNarrRaw > maxLen)}
      ${row('单句最长', `${r.maxLen} 词`, readoutMaxLen(r.maxLen, maxLen).split('：')[1] ?? '', r.maxLen > maxLen)}
      ${row(`超 ${maxLen} 词句数`, String(r.over20), readoutOverCount(r.over20), r.over20 > 0)}
      ${row('被动式', String(r.passive), readoutBannedItems(r.passive, 0, 0).split('——')[1] ?? '0（一律禁用）', r.passive > 0)}
      ${row('定语从句', String(r.relcl), '0（一律禁用，违反=逐条改写）', r.relcl > 0)}
      ${row('过去完成', String(r.pastperf), '0（一律禁用）', r.pastperf > 0)}
      ${row('待定词命中', String(r.pendingHits), readoutPending(r.pendingHits).split('——')[0] ?? '', r.pendingHits > 0)}
      ${densRow ? row(densRow.name, densRow.value, densRow.ref, densRow.warn) : ''}
    </table>`;
}

/** 质检报告页核心五行（项 2c）：生词率/平均句长/加注覆盖率/超长句/复现命中 */
export function reportReadouts(r: QcResult, maxLen: number): string[] {
  const lines = [readoutNewWordRate(r.newWordRate), readoutAvgLen(r.avgLenNarrRaw, maxLen), readoutAnnoCoverage(r.annotationCoverage), `超长句 ${r.over20} 句：${readoutOverCount(r.over20)}`];
  if (r.reinforceHits !== undefined) lines.push(readoutReinforce(r.reinforceHits, r.reinforceTokens ?? 0));
  return lines;
}

/** 书级汇总·一句话总结（项 2d）：达标=无超长且无禁用项（与汇总表两硬列同口径） */
export function bookSummaryLine(rows: Array<{ status: string; overlong: number; passive: number; relcl: number; pastperf: number }>): string {
  const done = rows.filter((r) => r.status === 'done');
  if (!done.length) return '一句话：还没有完成的章——先跑批处理或逐章简化。';
  const ok = done.filter((r) => r.overlong === 0 && r.passive + r.relcl + r.pastperf === 0).length;
  const overCh = done.filter((r) => r.overlong > 0).length;
  const banCh = done.filter((r) => r.passive + r.relcl + r.pastperf > 0).length;
  const bits = [overCh ? `超长句（${overCh} 章）` : '', banCh ? `禁用句法（${banCh} 章）` : ''].filter(Boolean).join('、');
  return `一句话：${done.length} 章完成、${ok} 章达标（无超长句、无禁用句法）${bits ? `；最常见短板=${bits}——下方"建议人工复查"逐章点名` : '——全书过关'}`;
}
