/**
 * 文件侧共享工具（Node fs 依赖；入口脚本 CLI/MCP 共用，纯逻辑模块 core/* 不引 fs）
 * 另含**原子写**（`atomicWriteFileSync`）——管线脚本改正文一律走它。
 * 一行一词的词表读取 + 内置资产（课标词表/补录）路径查找——唯一实现，双入口共用。
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
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

/* ────────────────────── 原子写 ────────────────────── */

/**
 * **原子写**：先写同目录下的临时文件，再 `rename` 覆盖目标。
 *
 * 为什么不能直接 `writeFileSync`：它的语义是"打开 → 截断 → 写"，中间任何一刻失败
 * （进程被杀、磁盘满、机器断电）都会留下**半份文件**。对正文这种"教师唯一的一份稿"，
 * 半份文件比没有文件更糟——没有文件你知道丢了，半份文件看起来像改坏了，
 * 而它其实**已经被毁掉了**。
 *
 * `rename` 在同一文件系统内是原子的：读者要么看到旧内容、要么看到新内容，没有中间态。
 * 这也是本项目里"原子提交"那条纪律在**单个文件**上的落点（跨文件的真原子做不到，
 * 那一层由 `src/core/version.ts` 的版本节点 + 回滚来保证）。
 *
 * 两个容易写错的细节：
 *   · 临时文件必须与目标**同目录**——跨文件系统的 `rename` 会退化成 copy+unlink，就不原子了；
 *   · 临时文件名带 pid 与随机串——两个进程写同一个目标时不会互相踩对方的临时文件。
 */
export function atomicWriteFileSync(path: string, content: string): void {
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    // 目标目录可能还不存在（首次生成）——`rename` 不会替你建目录
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, content, 'utf-8');
    renameSync(tmp, path);
  } catch (e) {
    // 清掉半成品，但**不要让清理失败盖住真正的错误**
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 清不掉就算了，下面照原样抛 */
    }
    throw e;
  }
}
