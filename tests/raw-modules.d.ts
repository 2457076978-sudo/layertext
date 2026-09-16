/** vite `?raw` 形态在根 tsc 的类型声明（node 测试链经 tools/raw-hook 加载同一字符串）。 */
declare module '*?raw' {
  const content: string;
  export default content;
}
