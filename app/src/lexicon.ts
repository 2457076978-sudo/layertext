/**
 * 词库域（WP-F 拆分）：合并已知词表构建（课标1600+修订+教师词库+术语+专名+词句卡）/
 * 班级定制合并口径（句长最严/已学交集/到期并集）/ 复现队列 / 词表宽容导入（CSV/xlsx/txt）/
 * 本地示例配置自动加载 —— 从 main.ts 整块迁出，行为零变化。
 */

import { invoke } from '@tauri-apps/api/core';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import * as XLSX from 'xlsx';
import { S } from './state.js';
import { renderAll } from './main.js';
import { setStatus } from './uikit.js';
import { mergeTargets } from './pure.js';
import { parseCsv, parseReinforceText, buildLexicon, type Lexicon } from '../../src/core/lexicon.js';
import bundledWordlist from '../../assets/wordlists/curriculum_2022_level3_1600.txt?raw';
import bundledAmendment from '../../assets/wordlists/curriculum_2022_amendment.txt?raw';
import { simplifyMaxLen } from './ai.js';

/* ---------- 全局配置（~/.layertext.json：AI 设置 + 简化标准 + 首启动标记） ---------- */

/** 常见服务商预设（新手只需选服务商 + 贴 Key） */
export function buildLexiconNow(): Lexicon {
  const sel = mergedSelection();
  return buildLexicon({
    vocabCsvTexts: S.vocabCsvText ? [S.vocabCsvText] : [],
    plainWordlistTexts: [bundledWordlist, bundledAmendment, ...(S.extraWordlistText ? [S.extraWordlistText] : []), ...(sel.active && sel.knownInter.length ? [sel.knownInter.join('\n')] : [])],
    terms: S.termsText
      ? S.termsText
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#'))
      : [],
    properNouns: S.properRows.map((r) => r.toLowerCase()),
  });
}

/** 班级多人定制：当前选择的合并口径（句长最严/已学词交集/到期词并集） */
export function mergedSelection() {
  return mergeTargets(
    S.classTargets.filter((t) => S.selectedIds.includes(t.id)),
    simplifyMaxLen(),
  );
}

/** 已学词集（复现队列）：班级定制选择优先，其次示例/书目录 _已学词.csv|.txt；空则 undefined（报告保持旧 schema） */
export function reinforceWordsNow(): string[] | undefined {
  const sel = mergedSelection();
  if (sel.active && sel.dueUnion.length > 0) return sel.dueUnion;
  if (!S.reinforceText) return undefined;
  const w = parseReinforceText(S.reinforceText);
  return w.length ? w : undefined;
}

/** 章号识别 chnoFromPath / CSV 转义 csvCell / 唯一定位 locateOriginal / 标记重排 remapMarks 已抽至 pure.ts（O4） */

/* ---------- 词表导入：宽容格式 ---------- */

/** 把任意格式的词表文件读成标准词库 CSV 文本。
 *  支持：①标准 CSV（表头含"词/word/单词"列）②无表头 CSV/TSV（每行首字段为词）
 *       ③TXT 一行一词 ④Excel .xlsx/.xls（第一列）。
 *  非标准来源的词一律按"单词"类型计入已知。 */
async function readVocabAsCsv(path: string): Promise<string> {
  const lower = path.toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    const b64 = await invoke<string>('read_file_base64', { path });
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const wb = XLSX.read(bin, { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const words = (XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false }) as unknown as string[][])
      .map((row) => (row?.[0] ?? '').toString().trim())
      .filter((w) => w && !w.startsWith('#'));
    return words.map((w) => `${w},单词,,,,,,`).join('\n');
  }
  const text = await invoke<string>('read_text_file', { path });
  const rows = parseCsv(text.replace(/^\uFEFF/, ''));
  if (rows.length === 0) return '';
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const hasWordCol = header.some((h) => h === '词' || h === 'word' || h === '单词' || h === '词汇');
  if (hasWordCol) return text; // 标准格式，直接使用
  // 无表头：每行取首字段（兼容 CSV/TSV/分号/纯文本），按"单词"类型导入
  const words = rows.map((r) => (r[0] ?? '').split(/[\t;；,，]/)[0].trim()).filter((w) => /^[A-Za-z][A-Za-z'\- ]*[A-Za-z]$/.test(w));
  return words.map((w) => `${w},单词,,,,,,`).join('\n');
}

export async function importVocabFile(): Promise<void> {
  const path = await openFileDialog({
    multiple: false,
    filters: [{ name: '词表（CSV / TXT / Excel）', extensions: ['csv', 'txt', 'tsv', 'xlsx', 'xls'] }],
  });
  if (typeof path !== 'string') return;
  try {
    S.vocabCsvText = await readVocabAsCsv(path);
    S.vocabName = path.slice(path.lastIndexOf('/') + 1);
    renderAll();
    setStatus(`已导入词库：${S.vocabName}（${S.vocabCsvText.split('\n').filter(Boolean).length} 行）`, 'saved');
  } catch (e) {
    setStatus('词库读取失败：' + e, 'err');
  }
}

export async function importTermsFile(): Promise<void> {
  const path = await openFileDialog({ multiple: false, filters: [{ name: '术语表 TXT（一行一词）', extensions: ['txt'] }] });
  if (typeof path !== 'string') return;
  try {
    S.termsText = await invoke<string>('read_text_file', { path });
    renderAll();
    setStatus('已导入术语表：' + path.slice(path.lastIndexOf('/') + 1), 'saved');
  } catch (e) {
    setStatus('读取失败：' + e, 'err');
  }
}

export async function importProperFile(): Promise<void> {
  const path = await openFileDialog({ multiple: false, filters: [{ name: '专名表 TXT（一行一名，可含空格短语）', extensions: ['txt'] }] });
  if (typeof path !== 'string') return;
  try {
    const text = await invoke<string>('read_text_file', { path });
    S.properRows = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    renderAll();
    setStatus(`已导入专名表：${S.properRows.length} 个（⑧专名一致性检查同步启用）`, 'saved');
  } catch (e) {
    setStatus('读取失败：' + e, 'err');
  }
}

/** 从本地示例目录自动加载配套词库/术语表/专名表（_ 开头文件） */
export async function loadLocalExampleConfig(): Promise<void> {
  try {
    const dir = await invoke<string>('examples_dir');
    const readIf = async (name: string): Promise<string | null> => {
      try {
        return await invoke<string>('read_text_file', { path: `${dir}/${name}` });
      } catch {
        return null;
      }
    };
    const vocab = await readIf('_词库.csv');
    if (vocab) {
      S.vocabCsvText = vocab;
      S.vocabName = '_词库.csv（本地示例）';
    }
    const extraWl = await readIf('_词表.txt');
    if (extraWl) S.extraWordlistText = extraWl;
    const terms = await readIf('_术语表.txt');
    if (terms) S.termsText = terms;
    const proper = await readIf('_专名表.txt');
    if (proper) {
      S.properRows = proper
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
    }
    const reinforceCsv = await readIf('_已学词.csv');
    const reinforce = reinforceCsv ?? (await readIf('_已学词.txt'));
    if (reinforce && reinforce.trim()) {
      S.reinforceText = reinforce;
      S.reinforceName = reinforceCsv ? '_已学词.csv（本地）' : '_已学词.txt（本地）';
    }
  } catch {
    /* 目录不可用则跳过 */
  }
}
