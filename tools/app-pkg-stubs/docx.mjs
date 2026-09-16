export const __stub = 'docx 导入占位（node 测试链）：被真用即抛，见 README';
const boom = () => {
  throw new Error('docx.* 在 node 测试链是导入占位——勿在此测 docx 行为（tools/app-pkg-stubs/README.md）');
};
export const Document = boom,
  Packer = { toBuffer: boom },
  Paragraph = boom,
  TextRun = boom,
  HeadingLevel = {},
  Table = boom,
  TableRow = boom,
  TableCell = boom,
  WidthType = {};
