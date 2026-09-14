/**
 * 一章的**产物目录**——同时认两种布局。
 *
 * 拆成独立模块的理由与 `keychain.mjs` / `chapterargs.mjs` 同：
 * `LayerText_AF词表与词典.mjs` 撞了 eslint 的 `max-lines` 1000 行门禁
 * （`skipComments`/`skipBlankLines` 都开着，注释救不了它），
 * 仓库里既有的结论是"prettier 会重展压缩行，拆模块是正解"。
 *
 * 存在的理由：有四个脚本直接写 `join(产物目录, 章名)`。这在 `legacy` 布局下是对的，
 * 但 `--layout run` 把产物收进了 `_运行/<runId>/正文/<章>/`——那四个脚本于是**找不到产物**：
 * `正本核对`每章都报"缺产物"并 exit 2（响，但错），
 * `补注候选` / `待确认队列` / `本地助手` 则读到空串、**静默产出空队列**
 * （这种最难查：它看起来像"本来就没有待办"）。
 *
 * 这里不去接整套 Resolver（那要四个脚本各自搬一套 run 身份初始化），只回答一个问题：
 * "这一章的产物在哪个目录"。优先运行私有目录（显式 `--run`/`LAYERTEXT_RUN` 最优先，
 * 否则取最近一次运行），最后回落 legacy——**回落保证老项目一个字都不用改**。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const RUN_ROOT = '_运行';

/** 运行私有目录名按时间倒序（最近的优先）。名字里带时间戳的排前面，其余按字典序兜底。 */
function runsNewestFirst(runRoot) {
  let runs;
  try {
    runs = readdirSync(runRoot);
  } catch {
    /* 有意兜底：`_运行` 读不了就当没有 run 布局，下面回落到 legacy——这不是错误 */
    return [];
  }
  return runs
    .filter((n) => {
      try {
        return statSync(join(runRoot, n)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort()
    .reverse();
}

/**
 * @param {string} outRoot 产物目录
 * @param {string} chapter 章名（`第一章`）
 * @param {string} [runId] 指定运行；不传则用 `LAYERTEXT_RUN`，再不然取最近一次运行
 * @returns {string} 该章产物所在目录（找不到任何候选时返回 legacy 路径，交由调用方按"缺产物"处理）
 */
export function chapterDirOf(outRoot, chapter, runId = process.env.LAYERTEXT_RUN) {
  const legacy = join(outRoot, chapter);
  const runRoot = join(outRoot, RUN_ROOT);
  const cands = [];
  if (runId) cands.push(join(runRoot, runId, '正文', chapter));
  for (const r of runsNewestFirst(runRoot)) cands.push(join(runRoot, r, '正文', chapter));
  cands.push(legacy);
  return cands.find((d) => existsSync(d)) ?? legacy;
}
