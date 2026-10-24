// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，本仓库已部署版权验证体系，细节不予公开（docs/版权与授权.md）。
/**
 * LayerText · 教材已学词口径（进度换算，core 版）
 *
 * 原型是 tools/textbook_units.mjs 的 progress 命令（词库 build 在工具侧不变）；
 * MCP 工具 layer_textbook_vocab 需要同一套换算，按「同一条判定只许有一份实现」收口进 core。
 * 数据 BYOT：教材单元库 JSON 由调用方传入（build 命令生成；资产不进公开仓）。
 *
 * 口径（与 mjs 原型逐条一致，2026-09-10 的修复也在）：
 *   - 基础层（课标1600+补录）先入账，且明细里列行（否则"分项加起来 197、合计 1800"看着像算错）；
 *   - 进度之前的册：全册计入（含「（未标单元）」）；
 *   - 当前册：单元号 < 目标 → 计入；= 目标 → 计入（--half 取前半词、语法标"可能未讲完"）；未标单元 → **不计入**（本册未学完，无法判断来自哪个单元）。
 */

export const TEXTBOOK_BOOK_ORDER = ['七上', '七下', '八上', '八下', '九上', '九下'] as const;

const unitNum = (u: string): number => Number((u.match(/U(\d+)/i) ?? [])[1] ?? 999);
const normUnit = (u: string): string => {
  const m = u.match(/U(\d+)/i);
  return m ? `U${m[1]}` : u;
};

export interface TextbookUnitsData {
  base?: string[];
  books: Record<string, Record<string, { 词?: string[]; 语法?: string[] }>>;
}

export interface TextbookProgressInput {
  /** 教材单元库 JSON 解析后的对象（tools/textbook_units.mjs build 的产物） */
  data: TextbookUnitsData;
  /** 进度写法 "八下:U5"（八下 U5 已学完，含之前所有册与单元）；也认全角冒号 */
  at: string;
  /** --at 那个单元只学到一半（取前半数词） */
  half?: boolean;
}

export interface TextbookProgressResult {
  /** 进度口径自述（给 QC/生成提示词引用时的指纹） */
  口径: string;
  /** 已学词（基础层 + 进度内册/单元，小写去重排序） */
  learnedWords: string[];
  /** 已学语法点（半单元时带"（本单元学到一半…）"后缀） */
  grammars: string[];
  /** 分项明细（教师核对用：每一册/单元计了几词几语法） */
  detail: string[];
  /** 库里实际覆盖的册（缺口=六册里不在的） */
  coveredBooks: string[];
  missingBooks: string[];
}

export function textbookProgress(input: TextbookProgressInput): TextbookProgressResult {
  const [bookRaw, unitRaw] = String(input.at ?? '').split(/[:：]/);
  const book = (bookRaw ?? '').trim();
  const unit = normUnit((unitRaw ?? 'U1').trim());
  const data = input.data;
  if (!book || !data.books?.[book]) {
    throw new Error(`教材库中没有「${book || '（空）'}」，现有：${Object.keys(data.books ?? {}).join('/') || '（无）'}`);
  }
  const bIdx = TEXTBOOK_BOOK_ORDER.indexOf(book as (typeof TEXTBOOK_BOOK_ORDER)[number]);
  const learned = new Set<string>(data.base ?? []);
  const grammars: string[] = [];
  const detail: string[] = [];
  if ((data.base ?? []).length) detail.push(`课标基础层（含数词/星期/月份补录）${data.base!.length} 词`);

  for (const [b, us] of Object.entries(data.books)) {
    const bi = TEXTBOOK_BOOK_ORDER.indexOf(b as (typeof TEXTBOOK_BOOK_ORDER)[number]);
    if (bIdx >= 0 && bi >= 0 && bi < bIdx) {
      let n = 0;
      let g = 0;
      for (const c of Object.values(us)) {
        (c.词 ?? []).forEach((w) => learned.add(w));
        n += (c.词 ?? []).length;
        g += (c.语法 ?? []).length;
        grammars.push(...(c.语法 ?? []));
      }
      detail.push(`${b}（全册，含未标单元）${n} 词 / ${g} 语法`);
      continue;
    }
    if (b !== book) continue;
    let untagged = 0;
    for (const [u, c] of Object.entries(us).sort((x, y) => unitNum(x[0]) - unitNum(y[0]))) {
      const un = unitNum(u);
      if (un === 999) {
        untagged += (c.词 ?? []).length;
        continue;
      }
      if (un < unitNum(unit)) {
        (c.词 ?? []).forEach((w) => learned.add(w));
        grammars.push(...(c.语法 ?? []));
        detail.push(`${b} ${u} ${(c.词 ?? []).length} 词 / ${(c.语法 ?? []).length} 语法`);
      } else if (un === unitNum(unit)) {
        const words = c.词 ?? [];
        const take = input.half ? words.slice(0, Math.ceil(words.length / 2)) : words;
        take.forEach((w) => learned.add(w));
        if (!input.half) grammars.push(...(c.语法 ?? []));
        else grammars.push(...(c.语法 ?? []).map((g) => `${g}（本单元学到一半，语法可能未讲完）`));
        detail.push(`${b} ${u}${input.half ? '（半）' : ''} ${take.length}/${words.length} 词 / ${(c.语法 ?? []).length} 语法`);
      }
    }
    if (untagged) detail.push(`${b}（未标单元）${untagged} 词 —— 未计入（本册未学完，无法判断来自哪个单元）`);
  }

  const coveredBooks = Object.keys(data.books).filter((b) => (TEXTBOOK_BOOK_ORDER as readonly string[]).includes(b));
  return {
    口径: `教材已学词：${book}:${unit}${input.half ? '（半）' : ''}（基础层 ${data.base?.length ?? 0} + 进度内册/单元），共 ${learned.size} 词种`,
    learnedWords: [...learned].sort(),
    grammars,
    detail,
    coveredBooks,
    missingBooks: TEXTBOOK_BOOK_ORDER.filter((b) => !coveredBooks.includes(b)),
  };
}
