/**
 * LayerText · zipf 词频先验（调研〇-3 第一级"疑似漏收"分诊）
 *
 * 数据：assets/wordfreq/en_zipf.tsv（rspeer/wordfreq 导出，zipf ≥ 3.0 的英文词，
 *       行 = word \t zipf×100 整数；构建期由 tools/export_zipf.py 生成，运行时纯离线）
 * 红线：只做候选标注，不参与 hit() 判定——"学过没有"的判定锚永远是词库表。
 *       高频未收 → 提示教师核对（勾选才入库）；表内查无（低频）→ 真·生词，教学优先。
 */

import { suffixCandidates } from './textpipe.js';

/** word → zipf×100（472 = zipf 4.72） */
export type ZipfTable = ReadonlyMap<string, number>;

/** 解析 en_zipf.tsv（宽容格式：空行与缺数值行跳过） */
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

/** 词形家族 zipf：与 hit() 同一套候选序（原形直查 → 剥后缀候选逐一回查），取首个命中 */
export function zipfOf(tok: string, t: ZipfTable): number | null {
  for (const c of suffixCandidates(tok)) {
    const z = t.get(c);
    if (z !== undefined) return z / 100;
  }
  return null;
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
  /** 家族最优命中；null = 低频（表未收录，< 3.0） */
  zipf: number | null;
  triage: OovTriage;
  label: string;
}

/** OOV 分诊三档（教研语言） */
export function triageOov(word: string, t: ZipfTable): OovTriageInfo {
  const z = zipfOf(word, t);
  if (z !== null && z >= SUSPECT_ZIPF)
    return { word, zipf: z, triage: 'suspect', label: '疑似漏收（高频未收）' };
  if (z !== null && z >= MID_ZIPF) return { word, zipf: z, triage: 'mid', label: '中频' };
  return { word, zipf: null, triage: 'rare', label: '低频·真生词' };
}
