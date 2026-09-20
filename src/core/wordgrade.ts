/**
 * 学段读数维度（显示用辅助）：词→旋钮 E∈[1,5] 查表与词形回退。
 * 判定口径不受影响——课标 1600 + 教师词库仍是唯一锚；E 只加"这个超纲词多难"的量化着色，
 * 词表内但 E 高的词=词库可疑收录，词表外但 E 低的=疑似漏收，都是审校线索。
 * 数据：章节 md 同目录 `<基名>_学段读数.json`（判定器项目 scripts/scan_chapter_grades.py
 * 离线批量生成，本地 MLX v4 适配器，键为小写基础形）。文件缺失=未生成，静默降级；
 * 文件在但解析坏=点名不静默（同 _审校标记.json 的事故教训）。
 */

export type WordGrades = Map<string, number>;

export interface WordGradesFile {
  schemaVersion: number;
  generator: string;
  adapter: string;
  generated: string;
  words: Record<string, number>;
}

/** 解析 _学段读数.json；坏 JSON 返回 null（调用方点名） */
export function parseWordGrades(text: string): WordGrades | null {
  try {
    const parsed = JSON.parse(text) as WordGradesFile;
    if (!parsed || typeof parsed.words !== 'object' || parsed.words === null) return null;
    const m: WordGrades = new Map();
    for (const [w, e] of Object.entries(parsed.words)) {
      if (typeof e === 'number' && e >= 1 && e <= 5) m.set(w.toLowerCase(), e);
    }
    return m;
  } catch {
    return null;
  }
}

/** 词形回退候选（轻量版，与 cefr.ts 同思路：直接→去 s/es/ed/ing/er） */
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

/** 查词的学段读数（词形还原回退；未收录返回 null=显示"未收"） */
export function gradeOf(tok: string, grades: WordGrades): number | null {
  const t = tok.toLowerCase();
  const direct = grades.get(t);
  if (direct != null) return direct;
  for (const c of candidates(t)) {
    const v = grades.get(c);
    if (v != null) return v;
  }
  return null;
}

export type GradeBand = 'wg3' | 'wg4' | 'wg5';

/** E→着色档：骑线(3.0-3.5 橙) / 超纲(3.5-4.5 红) / 硬超纲(≥4.5 深红)；<3.0 不着色 */
export function gradeBand(e: number): GradeBand | null {
  if (e >= 4.5) return 'wg5';
  if (e >= 3.5) return 'wg4';
  if (e >= 3.0) return 'wg3';
  return null;
}

/** 档位中文描述（词面板与图例共用） */
export const GRADE_BAND_DESC: Record<GradeBand, string> = {
  wg3: '骑线（初中毕业线上下）',
  wg4: '超纲（高中带）',
  wg5: '硬超纲（大学毕业以上）',
};

/* ---------- 置信度（2026-09-20 门控三态）：within-1 概率质量，由 scan_chapter_grades.py 写入 conf ---------- */

export interface GradeConfGate {
  soft: number; // 低于此值 → 淡显（半透明）
  low: number; // 低于此值 → 灰虚线转人工
}

/** 默认门控阈值（RLCD 门控模式的本地版）。
 * 依 v6 实测分布校准（全书 19036 样本）：within-1 置信双峰——~75% 挤在 0.57-0.63、~5% 飙 0.96。
 * 中间淡显带不携带信息（0.60 vs 0.70 无差别），故 soft 阈值贴 low 使淡显实际不启用；
 * low=0.55 抓真正歧义的稀有尾部（约 3-5%），其余正常着色。 */
export const GRADE_CONF_GATE: GradeConfGate = { soft: 0.551, low: 0.55 };

export type WordConf = Map<string, number>;

/** 解析 _学段读数.json 的 conf 段（缺省文件=旧版无置信度，返回 null 走纯色带模式） */
export function parseWordConf(parsed: unknown): WordConf | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const conf = (parsed as { conf?: Record<string, unknown> }).conf;
  if (!conf || typeof conf !== 'object') return null;
  const m: WordConf = new Map();
  for (const [w, c] of Object.entries(conf)) {
    if (typeof c === 'number' && c >= 0 && c <= 1) m.set(w.toLowerCase(), c);
  }
  return m;
}

/** 查词的判定置信度（与 gradeOf 同款词形回退） */
export function confOf(tok: string, conf: WordConf): number | null {
  const t = tok.toLowerCase();
  const direct = conf.get(t);
  if (direct != null) return direct;
  for (const c of candidates(t)) {
    const v = conf.get(c);
    if (v != null) return v;
  }
  return null;
}

/** 置信度三态（与 CSS 类对应）：normal 强着色 / soft 淡显 / low 灰虚线转人工 */
export type ConfState = 'normal' | 'soft' | 'low';

export function confState(cf: number | null, gate: GradeConfGate = GRADE_CONF_GATE): ConfState {
  if (cf == null) return 'normal';
  if (cf < gate.low) return 'low';
  if (cf < gate.soft) return 'soft';
  return 'normal';
}
