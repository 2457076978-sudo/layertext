/**
 * xlsx / docx 的**类型层**桩（2026-09-16，CI 修复）：
 * 根测试链（wordsimpl 等动态 import app 模块）把 lexicon.ts(xlsx)、bookio.ts(docx)
 * 拉进根 tsc 编译图——干净环境（CI npm ci）没有这两个包，TS2307。
 * 运行时它们由 tools/raw-hook-impl.mjs 别名到 tools/app-pkg-stubs/（被真用即抛），
 * 类型层由此声明兜底；两包带已知未修 advisory，不装进根依赖（见 app-pkg-stubs/README）。
 */
declare module 'xlsx' {
  export const read: (...args: unknown[]) => unknown;
  export const utils: Record<string, (...args: unknown[]) => unknown>;
}
declare module 'docx' {
  export const Document: new (...args: unknown[]) => unknown;
  export const Packer: Record<string, (...args: unknown[]) => unknown>;
  export const Paragraph: new (...args: unknown[]) => unknown;
  export const TextRun: new (...args: unknown[]) => unknown;
  export const HeadingLevel: Record<string, string>;
  export const Table: new (...args: unknown[]) => unknown;
  export const TableRow: new (...args: unknown[]) => unknown;
  export const TableCell: new (...args: unknown[]) => unknown;
  export const WidthType: Record<string, string>;
}
