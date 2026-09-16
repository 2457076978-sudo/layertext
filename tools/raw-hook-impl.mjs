/** node 测试的 `?raw` 加载钩子（2026-09-16）：app 模块用 vite 专属 `import x from '...?raw'`
 *  内置词表/词频资产；node 不认这个形态。本钩子把它解析为真实文件并导出同一字符串——
 *  生产代码与 vite 构建零改动，仅测试链（npm test 经 --import 挂载）生效。 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const PKG_STUBS = new Set(['xlsx', 'docx']); // 导入占位：见 tools/app-pkg-stubs/README.md

export async function resolve(specifier, context, next) {
  if (PKG_STUBS.has(specifier) && context.parentURL?.includes('/dist/app/')) {
    return { shortCircuit: true, url: new URL(`./app-pkg-stubs/${specifier}.mjs`, import.meta.url).href, format: 'module' };
  }
  if (specifier.endsWith('?raw')) {
    const bare = specifier.slice(0, -4);
    /* dist 布局会把 app/src 的 ../../ 相对深度漂一层（dist/app/src/x.js ../../assets → dist/assets）。
     * 回退：按源码位置（app/src/）再解析一次。 */
    try {
      const r = await next(bare, context);
      return { ...r, shortCircuit: true, url: `${r.url}?raw` };
    } catch (e) {
      if (context.parentURL?.includes('/dist/app/src/')) {
        const r2 = await next(bare, { ...context, parentURL: context.parentURL.replace('/dist/app/src/', '/app/src/') });
        return { ...r2, shortCircuit: true, url: `${r2.url}?raw` };
      }
      throw e;
    }
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.endsWith('?raw')) {
    const path = fileURLToPath(url.slice(0, -4));
    const src = await readFile(path, 'utf8');
    return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(src)}` };
  }
  return next(url, context);
}
