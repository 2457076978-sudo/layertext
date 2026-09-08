/**
 * 文件侧共享工具（Node fs 依赖；入口脚本 CLI/MCP 共用，纯逻辑模块 core/* 不引 fs）
 * 一行一词的词表读取 + 内置资产（课标词表/补录）路径查找——唯一实现，双入口共用。
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根（dist/core/files.js → 仓库根；脚本从任意 cwd 启动都能找到内置资产） */
function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** 一行一词读取：去空白、跳过 # 注释与空行（术语表/专名表/词表通用格式） */
export function readWordFile(p: string): string[] {
  return readFileSync(p, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

/** 找到第一个存在的内置资产路径（先 cwd 后仓库根；都不在返回 null，由调用方提示） */
export function findAssetPath(rel: string): string | null {
  const candidates = [join(process.cwd(), rel), join(repoRoot(), rel)];
  for (const c of candidates) {
    try {
      readFileSync(c, 'utf-8');
      return c;
    } catch {
      /* 尝试下一个候选位置 */
    }
  }
  return null;
}
