/**
 * LayerText · 词库装载与合并
 *
 * 实现「课标词 ∪ 教材已学词 ∪ 术语表」合并与三态标注：
 *   known  —— 已知（词表内）
 *   pending —— 待定（类型=待定词；暂计入已知，风险量由 QC 指标⑨单独计量）
 *   词表外 —— 即 known/pending 均未命中（OOV，红色）
 *
 * 自定义词表 CSV 格式与原型一致：
 *   词,类型,词性,释义,来源册,来源单元,音标,备注
 *   类型 ∈ { 单词, 课标词, 待定词, 术语, … }（仅前三类计入 known）
 */

export interface LexiconSources {
  /** 自定义词库 CSV 原文（可多份，如教材已学词） */
  vocabCsvTexts?: string[];
  /** 纯文本词表（一行一词；兼容「1. word」编号格式；# 注释行跳过） */
  plainWordlistTexts?: string[];
  /** 术语表（书级词汇，直接计入已知） */
  terms?: string[];
  /** 专名表（计入已知，并供 ⑧ 专名一致性检查） */
  properNouns?: string[];
}

export interface Lexicon {
  known: Set<string>;
  pending: Set<string>;
}

/** 简易 CSV 解析（处理 "" 转义与 BOM，引号包裹的字段去引号——与 pandas 读取语义一致） */
export function parseCsv(text: string): string[][] {
  const t = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inQ) {
      if (c === '"') {
        if (t[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') {
      row.push(cur);
      cur = '';
    } else if (c === '\n') {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
    } else if (c === '\r') {
      /* skip */
    } else cur += c;
  }
  if (cur.length > 0 || row.length > 0) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

/** 词表行首词提取：兼容「1. word」编号格式与纯文本格式（与 Python 参照版一致） */
export function firstWordOfLine(line: string): string | null {
  let m = line.match(/^\d+\.\s+([A-Za-z][A-Za-z'-]*)/);
  if (m) return m[1];
  m = line.match(/^\s*([A-Za-z][A-Za-z'-]*)/);
  return m ? m[1] : null;
}

export function loadVocabCsvText(text: string, known: Set<string>, pending: Set<string>): void {
  const rows = parseCsv(text);
  if (rows.length === 0) return;
  const header = rows[0].map((h) => h.trim());
  const iW = header.indexOf('词');
  const iT = header.indexOf('类型');
  for (const r of rows.slice(1)) {
    const w = (r[iW] ?? '').toLowerCase();
    const t = (r[iT] ?? '').trim();
    if (!w) continue;
    if (t === '单词' || t === '课标词' || t === '待定词') {
      known.add(w);
      if (t === '待定词') pending.add(w);
    }
  }
}

export function loadPlainWordlistText(text: string, known: Set<string>): void {
  for (const line of text.split('\n')) {
    const w = firstWordOfLine(line);
    if (w) known.add(w.toLowerCase());
  }
}

/** 合并构建词库（不含 IRR——IRR 在 qc 引擎内并入，保持与 Python 版次序一致） */
export function buildLexicon(src: LexiconSources): Lexicon {
  const known = new Set<string>();
  const pending = new Set<string>();
  for (const t of src.vocabCsvTexts ?? []) loadVocabCsvText(t, known, pending);
  for (const t of src.plainWordlistTexts ?? []) loadPlainWordlistText(t, known);
  for (const w of src.terms ?? []) known.add(w.toLowerCase());
  for (const w of src.properNouns ?? []) known.add(w.toLowerCase());
  return { known, pending };
}

/** 测试/CLI 便捷构造 */
export function lexiconFromWords(knownWords: string[], pendingWords: string[] = []): Lexicon {
  return {
    known: new Set(knownWords.map((w) => w.toLowerCase())),
    pending: new Set(pendingWords.map((w) => w.toLowerCase())),
  };
}

/**
 * 已学词（复现队列）装载：宽容格式解析（feature/reinforce）
 * 支持三种行格式，逐行独立判断：
 *   - 纯文本一行一词（# 注释行跳过）
 *   - 「1. word」编号格式
 *   - CSV/TSV 首列（自动剥表头「词 / word」）
 * 多词短语（含空格，如 bring about）整词保留；统一小写去重。
 */
export function parseReinforceText(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let line of text.replace(/^\uFEFF/, '').split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.includes(',')) line = line.split(',')[0].trim();
    if (line.includes('\t')) line = line.split('\t')[0].trim();
    line = line.replace(/^\d+[.、)]\s*/, '');
    if (!line || line === '词' || line.toLowerCase() === 'word' || line.toLowerCase() === 'words') continue;
    if (!/^[A-Za-z][A-Za-z'\- ]*$/.test(line)) continue;
    const w = line.toLowerCase();
    if (!seen.has(w)) {
      seen.add(w);
      out.push(w);
    }
  }
  return out;
}
