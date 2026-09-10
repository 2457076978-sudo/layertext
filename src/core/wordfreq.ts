// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，本仓库已部署版权验证体系，细节不予公开（docs/版权与授权.md）。
/**
 * LayerText · 词频/习得年龄先验（调研〇-3 第一级"疑似漏收"分诊）
 *
 * 数据：assets/wordfreq/en_zipf.tsv（rspeer/wordfreq 导出，zipf ≥ 3.0 的英文词）
 *     + assets/wordfreq/en_aoa.tsv（Kuperman 2012 常模 31k 实词，AoA=母语者习得年龄）
 *       两表同构（word \t 整数；构建期 tools/export_zipf.py / export_aoa.py 生成，运行时纯离线）
 * 红线：只做候选标注，不参与 hit() 判定——"学过没有"的判定锚永远是词库表。
 *       高频未收 → 提示教师核对（勾选才入库）；表内查无（低频）→ 真·生词，教学优先。
 */

import { suffixCandidates } from './textpipe.js';

/** word → zipf×100（472 = zipf 4.72）；AoA 表同构（73 = 7.3 岁），复用此类型 */
export type ZipfTable = ReadonlyMap<string, number>;

/** 解析 en_zipf.tsv / en_aoa.tsv（同构格式：word \t 整数；宽容：空行与缺数值行跳过） */
export function parseZipfTable(text: string): ZipfTable {
  const m = new Map<string, number>();
  for (const line of text.split('\n')) {
    const i = line.indexOf('\t');
    if (i <= 0) continue;
    const z = Number(line.slice(i + 1).trim());
    if (Number.isFinite(z) && z > 0) m.set(line.slice(0, i).trim(), Math.round(z));
  }
  return m;
}

/** 词形家族查表（与 hit() 同一套候选序：原形直查 → 剥后缀候选逐一回查），取首个命中。
 *  先验层补一条 ing 双写剥除（running→run）：suffixCandidates 仅 ed 分支处理双写辅音，
 *  而词典式 AoA 常模只收原形——此候选只作用于先验查询，hit() 判定口径不动。 */
function lookupInt(tok: string, t: ZipfTable): number | null {
  for (const c of suffixCandidates(tok)) {
    const z = t.get(c);
    if (z !== undefined) return z;
  }
  if (/ing$/.test(tok) && tok.length > 5 && tok[tok.length - 4] === tok[tok.length - 5]) {
    const z = t.get(tok.slice(0, -4));
    if (z !== undefined) return z;
  }
  return null;
}

/** 词形家族 zipf（值 = zipf 原值） */
export function zipfOf(tok: string, t: ZipfTable): number | null {
  const z = lookupInt(tok, t);
  return z === null ? null : z / 100;
}

/** 词形家族 AoA（母语者习得年龄；running→run 家族兜底；null = 常模外） */
export function aoaOf(tok: string, t: ZipfTable): number | null {
  const a = lookupInt(tok, t);
  return a === null ? null : a / 10;
}

export type OovTriage = 'suspect' | 'mid' | 'rare';

/** 分诊档位序（疑似漏收 → 中频 → 低频；报告排序用） */
export const TRIAGE_RANK: Record<OovTriage, number> = { suspect: 0, mid: 1, rare: 2 };

/** ≥ 4.0 = 高频带（bike 4.5 / onto 4.8 / government 5.6 档）：未收即疑似漏收 */
export const SUSPECT_ZIPF = 4.0;
/** 表携带下限：3.0 ≤ zipf < 4.0 为中频带；表内查无即低频 */
export const MID_ZIPF = 3.0;

export interface OovTriageInfo {
  word: string;
  /** 家族最优命中；null = 低频（zipf 表未收录，< 3.0） */
  zipf: number | null;
  /** 母语者习得年龄（Kuperman 2012 常模）；null = 常模外或未提供表 */
  aoa: number | null;
  triage: OovTriage;
  label: string;
}

/** OOV 分诊三档（教研语言）。双信号降噪（Wayne 拍板）：提供 AoA 表时，zipf≥4 还须 AoA 在常模内
 *  才亮"疑似漏收"——zipf≥4 但常模查无（harry 类专名/衍生词）降级"高频·常模外"待核，压假阳性；
 *  未提供 AoA 表时维持单信号口径（向后兼容）。 */
export function triageOov(word: string, t: ZipfTable, aoaTable?: ZipfTable): OovTriageInfo {
  const z = zipfOf(word, t);
  const aoa = aoaTable ? aoaOf(word, aoaTable) : null;
  if (z !== null && z >= SUSPECT_ZIPF) {
    if (!aoaTable) return { word, zipf: z, aoa: null, triage: 'suspect', label: '疑似漏收（高频未收）' };
    return aoa !== null
      ? { word, zipf: z, aoa, triage: 'suspect', label: `疑似漏收（高频 · 母语者约${aoa.toFixed(1)}岁习得）` }
      : { word, zipf: z, aoa: null, triage: 'mid', label: '高频 · 常模外（多为专名/衍生词，按需核对）' };
  }
  if (z !== null && z >= MID_ZIPF) return { word, zipf: z, aoa, triage: 'mid', label: '中频' };
  return { word, zipf: null, aoa, triage: 'rare', label: '低频·真生词' };
}
