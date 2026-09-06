#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 提取指定版本段落（Release 工作流用）。
 * 用法：node tools/extract_changelog.mjs 1.0.1
 * 规则：找 `## [1.0.1] ...` 标题，输出到下一个 `## ` 标题之前（不含"未发布"段）。
 * 找不到时输出空串并以码 1 退出（工作流里再转人话报错）。
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2];
if (!version) {
  console.error('用法: node tools/extract_changelog.mjs <版本号，如 1.0.1>');
  process.exit(2);
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const text = readFileSync(join(root, 'CHANGELOG.md'), 'utf-8');
const lines = text.split('\n');

let out = [];
let inSection = false;
for (const line of lines) {
  if (line.startsWith('## ')) {
    if (inSection) break;
    inSection = new RegExp(`^##\\s*\\[${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`).test(line);
    if (inSection) continue; // 标题行本身不输出（Release 正文带 tag 名）
  } else if (inSection) {
    out.push(line);
  }
}
out = out.join('\n').trim();
if (!out) process.exit(1);
console.log(out);
