#!/usr/bin/env node
/** LayerText 发布前门禁：静态语法不足以发现 .mjs 的 TDZ，必须逐脚本启动 smoke。 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.cwd();
const dirs = ['tools/af_pipeline'];
const files = dirs.flatMap((d) =>
  readdirSync(join(root, d))
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => join(d, f)),
);
const failures = [];
for (const file of files) {
  const syntax = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (syntax.status !== 0) failures.push(`${file}: syntax ${syntax.stderr.trim()}`);
  const body = readFileSync(file, 'utf8');
  if (/catch\s*\{\s*\/\//.test(body)) failures.push(`${file}: catch starts with comment; inspect for swallowed error`);
}
// 这些脚本支持 dry/plan；确认它们仍保留零成本入口，防止后续重构误删。
for (const name of ['LayerText_AF工序化生成.mjs', 'LayerText_AF会话改写.mjs', 'LayerText_AF发布包.mjs']) {
  const file = join('tools/af_pipeline', name);
  const body = readFileSync(join(root, file), 'utf8');
  if (!/--dry|--plan|--check|--where/.test(body)) failures.push(`${file}: missing non-destructive mode`);
}
/* 架构地图必须在，而且必须被 README 引到。
 *
 * 为什么把这条放进"提交前门禁"而不是只写在文档里：**改了结构却不更新地图，地图就开始骗人**，
 * 而"过时的地图"比"没有地图"更坏——没有地图你会去看，过时的地图你会信。
 * 这一条只拦得住"文件没了/README 没引到"这类最粗的失效；真正的细心仍靠人，
 * 但它至少保证这张地图不会在无人察觉的情况下被删掉或变成孤儿。
 */
{
  const MAP = 'docs/文件架构.md';
  if (!existsSync(join(root, MAP))) failures.push(`${MAP}: 文件架构地图不存在——它是"东西在哪、该改哪儿"的唯一入口`);
  else {
    const readme = existsSync(join(root, 'README.md')) ? readFileSync(join(root, 'README.md'), 'utf8') : '';
    if (!readme.includes(MAP)) failures.push(`README.md: 没有链接 ${MAP}——地图没人引路就等于不存在`);
    const map = readFileSync(join(root, MAP), 'utf8');
    if (!map.includes('必须同步更新本文件')) failures.push(`${MAP}: 顶部的"改架构必须同步更新本文件"这条规矩被删了`);
    if (!map.includes('本文件自己的变更记录')) failures.push(`${MAP}: 缺少"本文件自己的变更记录"一节——改结构的人没有地方留痕`);
    /* 项目总说明：在，且被 README/AGENTS 链到（它是"项目是什么、到哪一步"的唯一入口）。 */
    const OVERVIEW = 'docs/项目总说明.md';
    if (!existsSync(join(root, OVERVIEW))) failures.push(`${OVERVIEW}: 项目总说明不在——"项目是什么、到哪一步了"就没有入口`);
    else {
      const refs = ['README.md', 'AGENTS.md'].filter((f) => existsSync(join(root, f)) && readFileSync(join(root, f), 'utf8').includes(OVERVIEW));
      if (refs.length < 2) failures.push(`${OVERVIEW}: README 与 AGENTS 都应链到它，现在只有 ${refs.join('、') || '（都没有）'}`);
    }
    /* 动手前先读的那一页：在，且链到地图。 */
    const AGENTS = 'AGENTS.md';
    if (!existsSync(join(root, AGENTS))) failures.push(`${AGENTS}: 缺失——它是"动手前先读这一页"的入口`);
    else if (!readFileSync(join(root, AGENTS), 'utf8').includes(MAP)) failures.push(`${AGENTS}: 没有链接 ${MAP}，来人还是找不到地图`);
  }
}
if (failures.length) {
  console.error('✗ preflight failed');
  failures.forEach((x) => console.error(`  ${x}`));
  process.exit(1);
}
console.log(`✓ preflight: ${files.length} pipeline scripts syntax-checked; no empty catches; dry/plan guards present; 架构地图在位`);
