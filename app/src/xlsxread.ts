/**
 * xlsx 词表首列读取（A5 第二步：2026-09-26 去 npm xlsx 依赖）· 唯一实现
 *
 * 迁移评估（留档）：xlsx npm 包已停更（advisory 未修，官方迁自家 CDN）——
 * ①exceljs：维护活跃但 ~1MB 重依赖，只为读"第一个 sheet 的第一列"不划算；
 * ②SheetJS CDN 版：引入 CDN 供应链依赖，违背本仓"能本地确定性解决不引外源"的取向；
 * ③**自建（采纳）**：xlsx 本质=zip+XML，app 已依赖 fflate（解压），所需面极窄
 * （首 sheet 首列：sharedStrings/inlineStr/str/数字四种单元格），~70 行本地确定性实现。
 * 安全网=tests/xlsxread.test.ts：夹具字节→CSV 输出被旧实现（xlsx@0.18.5）冻结，
 * 换实现后一个字不改全绿才算迁移成功——数字格式化/过滤/序任一语义差都会红。
 */

import { unzipSync, strFromU8 } from 'fflate';

/** XML 实体解码（t 文本与共享字符串用） */
function xmlDecode(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 列引用字母 → 下标（A→0，B→1…）；非字母开头返回 -1 */
function colIndex(ref: string): number {
  const m = /^([A-Z]+)/.exec(ref);
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1]!) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 取 <tag …>…</tag> 的内文（不含属性里的干扰；贪心到下一个闭合标签） */
function innerAll(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  for (const m of xml.matchAll(re)) out.push(m[1]!);
  return out;
}

/** 第一个 sheet 的 XML（按 workbook 声明顺序，经 rels 映射到实际文件） */
function firstSheetXml(files: Record<string, Uint8Array>): string | null {
  const wb = files['xl/workbook.xml'] ? strFromU8(files['xl/workbook.xml']) : '';
  const first = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb) ?? /<sheet\b[^>]*\/?>/.exec(wb);
  if (first?.[1]) {
    const rels = files['xl/_rels/workbook.xml.rels'] ? strFromU8(files['xl/_rels/workbook.xml.rels']) : '';
    const rel = new RegExp(`<Relationship[^>]*\\bId="${first[1]}"[^>]*\\bTarget="([^"]+)"`).exec(rels) ?? new RegExp(`\\bTarget="([^"]+)"[^>]*\\bId="${first[1]}"`).exec(rels);
    if (rel?.[1]) {
      const path = rel[1]!.replace(/^\//, '').startsWith('xl/') ? rel[1]!.replace(/^\//, '') : `xl/${rel[1]!.replace(/^\//, '')}`;
      if (files[path]) return strFromU8(files[path]);
    }
  }
  /* 兜底：rels 解析不出就按最常见布局直接取 sheet1（锁兜着的形状） */
  return files['xl/worksheets/sheet1.xml'] ? strFromU8(files['xl/worksheets/sheet1.xml']) : null;
}

/** 共享字符串表：<si> 内的所有 <t> 拼接（富文本多 run 语义） */
function sharedStrings(files: Record<string, Uint8Array>): string[] {
  if (!files['xl/sharedStrings.xml']) return [];
  const sst = strFromU8(files['xl/sharedStrings.xml']);
  return innerAll(sst, 'si').map((si) => innerAll(si, 't').map(xmlDecode).join(''));
}

/** 单元格显示值（与 sheet_to_json raw:false 的窄口径对齐：数字按文本、布尔 TRUE/FALSE） */
function cellValue(cellXml: string, sst: string[]): string {
  const t = /\bt="([^"]+)"/.exec(cellXml)?.[1];
  if (t === 's') {
    const v = innerAll(cellXml, 'v')[0];
    return v === undefined ? '' : (sst[Number(xmlDecode(v))] ?? '');
  }
  if (t === 'inlineStr') return innerAll(cellXml, 't').map(xmlDecode).join('');
  if (t === 'b') return innerAll(cellXml, 'v')[0] === '1' ? 'TRUE' : 'FALSE';
  const v = innerAll(cellXml, 'v')[0];
  if (v === undefined) return '';
  const txt = xmlDecode(v);
  /* 数字：去掉科学计数法外的多余形态——与旧实现 General 格式化对齐（锁内形状=整数字符串） */
  if (t === undefined && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(txt)) {
    const n = Number(txt);
    return String(n);
  }
  return txt;
}

export function xlsxFirstColumnToCsv(bin: Uint8Array): string {
  const files = unzipSync(bin);
  const sheet = firstSheetXml(files);
  if (!sheet) return '';
  const sst = sharedStrings(files);
  const words: string[] = [];
  for (const row of innerAll(sheet, 'row')) {
    /* 行内取"A 列"那个单元格（row 顺序的第一个不一定是 A——列可跳空） */
    const cells = [...row.matchAll(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g)].map((m) => m[0]);
    const aCell = cells.find((c) => colIndex(/\br="([A-Z]+\d+)"/.exec(c)?.[1] ?? '') === 0);
    const w = (aCell === undefined ? '' : cellValue(aCell, sst)).trim();
    if (w && !w.startsWith('#')) words.push(w);
  }
  return words.map((w) => `${w},单词,,,,,,`).join('\n');
}
