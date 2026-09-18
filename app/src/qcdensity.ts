/**
 * 终审门禁·注密度行（第三梯队项 10b/10d，2026-09-18）
 *
 * 为什么单独一个模块：`pure.ts` 撞上了 `max-lines: 1000`，而这段自成一体的门禁文案
 * 函数不值得把整个纯逻辑模块撑破（先例见 propagateui.ts）。
 *
 * 职责：把引擎 `annotationDensityOfChapter` 的输出翻译成 QC 核对表的一行——
 * 数值 + 警戒线 + **人话判读**（README 规划项「指标：数字+人话判读成对」的第一个落地）。
 * 警戒线取引擎 `ANNO_DENSITY_WARN`（8，v2.1 定值）——**警戒非硬闸**：
 * 超线只 ⚠ 点名最差段、不拦勾选、不判达标；教学决策留给教师。
 * 数值本身由引擎唯一计算，本模块只做文案。
 */

import { ANNO_DENSITY_WARN } from '../../src/core/acceptance.js';

export function qcDensityRow(d: { per100: number; worst: { d: number; at: string } }): { name: string; value: string; ref: string; warn: boolean } {
  const warn = d.per100 > ANNO_DENSITY_WARN;
  const 判读 = warn
    ? `超警戒线 ${ANNO_DENSITY_WARN}${d.worst.at ? `，最差段 ${d.worst.at}（${d.worst.d}）` : ''}——考虑把部分注释合并，或移进章末词卡`
    : `低于警戒线 ${ANNO_DENSITY_WARN}——支架密度健康`;
  return {
    name: '注密度',
    value: `${d.per100} 注/百词（${判读}）`,
    ref: `≤ ${ANNO_DENSITY_WARN}（警戒线，非硬闸；超线点名最差段，达标由你定）`,
    warn,
  };
}
