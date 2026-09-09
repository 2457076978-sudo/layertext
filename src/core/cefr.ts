/**
 * CEFR 等级维度（显示用辅助）：词→A1..C2 等级查表与轻量词形回退。
 * 判定口径不受影响——课标 1600 + 教师词库仍是唯一锚（差异化的根，CEFR 只加"这个超纲词多难"的细粒度显示）。
 * 数据：assets/wordlists/cefrj_levels.txt（olp-en-cefrj，CC BY-SA 4.0，tools/convert_cefrj.py 可复现）
 */

export type CefrLevel = 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';

const ORDER: Record<CefrLevel, number> = { A1: 1, A2: 2, B1: 3, B2: 4, C1: 5, C2: 6 };

/** 解析 cefrj_levels.txt（一行"word A1"；# 注释跳过；坏行跳过） */
export function parseCefrLevels(text: string): Map<string, CefrLevel> {
  const m = new Map<string, CefrLevel>();
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const at = t.lastIndexOf(' ');
    const w = t.slice(0, at).trim().toLowerCase();
    const lv = t
      .slice(at + 1)
      .trim()
      .toUpperCase() as CefrLevel;
    if (w && ORDER[lv]) m.set(w, lv);
  }
  return m;
}

/** 词形回退候选（轻量版，与引擎 suffixCandidates 同思路：直接→去 s/es/ed/ing/er） */
function candidates(tok: string): string[] {
  const c = [tok];
  if (tok.endsWith('ies')) c.push(tok.slice(0, -3) + 'y');
  if (tok.endsWith('es')) c.push(tok.slice(0, -2));
  if (tok.endsWith('s')) c.push(tok.slice(0, -1));
  if (tok.endsWith('ed')) c.push(tok.slice(0, -2), tok.slice(0, -2) + 'e', tok.slice(0, -1));
  if (tok.endsWith('ing')) c.push(tok.slice(0, -3), tok.slice(0, -3) + 'e');
  if (tok.endsWith('er')) c.push(tok.slice(0, -1), tok.slice(0, -2));
  return c;
}

/** 查词的 CEFR 等级（词形还原回退；未收录返回 null——显示"CEFR-J 未收"） */
export function cefrOf(tok: string, levels: Map<string, CefrLevel>): CefrLevel | null {
  const t = tok.toLowerCase();
  const direct = levels.get(t);
  if (direct) return direct;
  for (const c of candidates(t)) if (levels.has(c)) return levels.get(c)!;
  return null;
}

export function cefrRank(lv: CefrLevel): number {
  return ORDER[lv];
}

/** 等级 → 中文描述（词面板显示用） */
export const CEFR_DESC: Record<CefrLevel, string> = {
  A1: '入门（课标内基本盘）',
  A2: '基础（课标内基本盘）',
  B1: '进阶（中考上限带）',
  B2: '高级（高中带）',
  C1: '高阶（大学带）',
  C2: '精通（大学+带）',
};
