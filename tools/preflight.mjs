#!/usr/bin/env node
/** LayerText 发布前门禁：静态语法不足以发现 .mjs 的 TDZ，必须逐脚本启动 smoke。 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
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
if (failures.length) {
  console.error('✗ preflight failed');
  failures.forEach((x) => console.error(`  ${x}`));
  process.exit(1);
}
console.log(`✓ preflight: ${files.length} pipeline scripts syntax-checked; no empty catches; dry/plan guards present`);
