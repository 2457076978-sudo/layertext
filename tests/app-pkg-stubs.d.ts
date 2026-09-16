/**
 * xlsx / docx 的**类型层**桩（2026-09-16，CI 修复）：
 * 根测试链（wordsimpl 等动态 import app 模块）把 lexicon.ts(xlsx)、bookio.ts(docx)
 * 拉进根 tsc 编译图——干净环境（CI npm ci）没有这两个包，TS2307。
 * 运行时它们由 tools/raw-hook-impl.mjs 别名到 tools/app-pkg-stubs/（被真用即抛），
 * 类型层由此声明兜底；两包带已知未修 advisory，不装进根依赖（见 app-pkg-stubs/README）。
 * 用 class 声明：bookio 把 Paragraph/Table 同时用作**值与类型**，const 导出撑不住。
 */
declare module 'xlsx' {
  export interface WorkBook {
    Sheets: Record<string, unknown>;
    SheetNames: string[];
  }
  export function read(data: unknown, opts?: Record<string, unknown>): WorkBook;
  export const utils: {
    sheet_to_json<T = unknown>(sheet: unknown, opts?: Record<string, unknown>): T[];
  } & Record<string, (...args: unknown[]) => unknown>;
}
declare module 'docx' {
  export class Document {
    constructor(...args: unknown[]);
  }
  export class Paragraph {
    constructor(...args: unknown[]);
  }
  export class TextRun {
    constructor(...args: unknown[]);
  }
  export class Table {
    constructor(...args: unknown[]);
  }
  export class TableRow {
    constructor(...args: unknown[]);
  }
  export class TableCell {
    constructor(...args: unknown[]);
  }
  export const Packer: { toBuffer: (doc: unknown) => Promise<Buffer> } & Record<string, (...args: unknown[]) => unknown>;
  export const HeadingLevel: Record<string, string>;
  export const WidthType: Record<string, string>;
}
