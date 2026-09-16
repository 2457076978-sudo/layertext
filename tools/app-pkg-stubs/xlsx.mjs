export const __stub = 'xlsx 导入占位（node 测试链）：被真用即抛，见 README';
const boom = (n) => () => {
  throw new Error(`xlsx.${n} 在 node 测试链是导入占位——此路径未接真实现，勿在此测 xlsx 行为（tools/app-pkg-stubs/README.md）`);
};
export const read = boom('read');
export const utils = {
  sheet_to_json: boom('utils.sheet_to_json'),
  book_new: boom('utils.book_new'),
  json_to_sheet: boom('utils.json_to_sheet'),
  book_append_sheet: boom('utils.book_append_sheet'),
  writeFile: boom('utils.writeFile'),
};
