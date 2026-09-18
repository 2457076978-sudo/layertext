// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，本仓库已部署版权验证体系，细节不予公开（docs/版权与授权.md）。
/**
 * LayerText · 段级回炉的公共原语（2026-09-18 第一梯队项 3）
 *
 * 存在的理由：回炉的四闸与挂起原因分类原先只活在 `tools/af_pipeline/LayerText_AF段级回炉.mjs`
 * 的函数体里——App（项 1）与 MCP（项 2）要复用同一把尺，按仓库口径「同一条判定只许有一份实现」，
 * 它们必须进 `src/core`。脚本、MCP、App 三处都从本模块取，不许各写一套。
 *
 * 引语豁免的口径沿用 segmentgate 的定案（2026-09-12）：句法工序被禁止拆直接引语，
 * 为改不了的句子否决整段在数学上无解；豁免是**过程责任**口径，不是测量口径——
 * 报表/风险队列照常计数，只有"要不要为这句打回修订"用它。
 */

import { stripDirectQuotes } from './segmentgate.js';

/** 挂起原因的机器分类（回炉台账汇总/下一轮排序用）。
 *  与脚本写入台账的 `class` 字段、旧台账纯文本 `reason` 双向兼容：新行直接带分类，
 *  旧行（2026-09-17 的格式）由 classifyHangReason 从 reason 文本里识别。 */
export type HangClass = '锁失败' | '未注超标' | '段长越界' | '句长超线' | '注释丢失' | '调用失败' | '未知';

/** 识别顺序即优先级：一条挂起可能同时报多类失败，按"最先卡住的闸"归类——
 *  锁闸在最前（回炉闸序：锁 → 红词 → 段长/注释/句长）。
 *
 *  两种台账格式都认：
 *  - v2（2026-09-18 起）：`未过闸（锁✗ 未注3>2 句长19>19）`——每闸一个词；
 *  - v1（2026-09-17 遗留）：`未过闸（红2→2 长115→102 注0→0 句max58）`——无条件罗列四个测量值，
 *    哪个真失败要靠数字判断：红 N→N(>0)=未减；句 max 超线（需调用方给该层上限）；
 *    段长比出 [0.75,1.25]（v1 阈值带，v2 的 [0.7,1.4] 失败全落在它外面之外的小带
 *    由 v2 自带的 class 字段兜底，不靠本文本分类）。判不出的如实归"未知"。 */
export function classifyHangReason(reason: string, ctx?: { sentLimit?: number }): HangClass {
  const r = String(reason ?? '');
  if (r.includes('调用失败')) return '调用失败';
  if (r.includes('未过锁闸') || r.includes('锁✗') || /缺\S*\s*数字/.test(r)) return '锁失败';
  const red = r.match(/红(\d+)→(\d+)/);
  if (/未注\d+>\d+/.test(r) || (red && Number(red[1]) > 0 && Number(red[2]) >= Number(red[1]))) return '未注超标';
  const sentMax = r.match(/句max(\d+)/);
  if (r.includes('句长') || (sentMax && ctx?.sentLimit !== undefined && Number(sentMax[1]) > ctx.sentLimit)) return '句长超线';
  const len = r.match(/长(\d+)→(\d+)/);
  if (len && Number(len[1]) > 0) {
    const ratio = Number(len[2]) / Number(len[1]);
    if (ratio < 0.75 || ratio > 1.25) return '段长越界';
  }
  if (r.includes('段长')) return '段长越界';
  const ann = r.match(/注(\d+)→(\d+)/);
  if ((ann && Number(ann[2]) < Number(ann[1])) || r.includes('注释')) return '注释丢失';
  return '未知';
}

/** 句长计数的口径说明（改之前先读）：
 *  - 中文注释 `word（中文）` 整体剔除后再数（注释不是正文负荷）；
 *  - 计数正则 `[A-Za-z]+`：don't 数 2 词。这与 `segmentgate.wordCount`（连字符/撇号连写）
 *    是**两种口径**，不是漂移——回炉的 `lim+2` 阈值是在本口径上标定的（2026-09-17 三层实跑），
 *    换口径等于悄悄挪闸门。两处口径都各自有测试锁着。 */
export function maxSentenceLen(text: string, opts?: { exemptQuotes?: boolean }): number {
  let t = String(text ?? '').replace(/（[^）]*）/g, ' ');
  if (opts?.exemptQuotes) t = stripDirectQuotes(t);
  const sents = t.split(/(?<=[.!?])\s+/);
  let max = 0;
  for (const s of sents) {
    const n = (s.toLowerCase().match(/[a-z]+/g) ?? []).length;
    if (n > max) max = n;
  }
  return max;
}
