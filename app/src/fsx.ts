/**
 * 文件安全口径（2026-09-14 起）：
 *   1. **读三态**（`readTextChecked` / `classifyRead`）；
 *   2. **首改备份**（`planBackup` / `backupPathFor` / `makeFirstChangeBackup`）；
 *   3. **append-only 台账**（`csvAppendPlan` / `appendCsvLineWith` / `appendCsvLine`）。
 *
 * 为什么单独一个模块：`read_text_file` 只回一句错误字符串，前端分不出
 * "文件不存在"（正常——第一次用还没有 `_审校标记.json`、书还没有 `_LayerText项目.json`）
 * 与"文件在、但读不出来"（权限 / iCloud 占位 / 磁盘问题）。
 * 这两件事的**正确处理相反**：
 *   · 不存在 → 静默按"没有"处理（这是绝大多数正常路径）；
 *   · 读不出来 → **必须说出口，并且绝不能拿内存里的空数据写回去**。
 *
 * 在这之前，全仓十几处只能把这个区别写成"有意兜底：后端没给错误码分不出来"的注释，
 * 把风险自认下来——`_审校标记.json`、`AI会话.json`、`_本书配置.json` 三处都因此
 * 存在"损坏被当成空、然后整体覆盖"的数据丢失路径。Rust 侧 `describe_path`
 * 把"在不在"这件事问清楚了，这里就是它的前端口径。
 * 备份与台账两族策略 2026-09-16 起也收敛到这里：同一件事全仓只定义一次。
 *
 * 用法：
 * ```ts
 * const r = await readTextChecked(path);
 * if (r.kind === 'missing') { ...正常路径... }
 * else if (r.kind === 'unreadable') { setStatus(`...读不出来：${r.error}——本次不覆盖它`, 'err'); }
 * else { use(r.text) }
 * ```
 * 纯逻辑（`classifyRead` / `planBackup` / `csvAppendPlan`）单独抽出来，
 * 可以在 node 下直接测，不必启动 App。
 */

import { invoke } from '@tauri-apps/api/core';

export type ReadOutcome = { kind: 'ok'; text: string } | { kind: 'missing' } | { kind: 'unreadable'; error: string };

/** `describe_path` 的返回值：后端只回 `"exists"` / `"missing"` 两种，其余当读不了。 */
export type PathProbe = 'exists' | 'missing' | 'unreadable';

/**
 * 把"读文件失败" + "这个路径在不在"两个事实合成一个结论。
 *
 * 纯函数，便于单测。只有**确认不存在**才允许落到"没有"这一支；
 * 其余一切（文件确实在却读不出来、连 `describe_path` 都问不出来）都是 `unreadable`——
 * **宁可报"读不了"让教师看见，也不赌它其实不存在**。
 */
export function classifyRead(readError: string, probe: PathProbe): ReadOutcome {
  return probe === 'missing' ? { kind: 'missing' } : { kind: 'unreadable', error: readError };
}

/** 读一个文本文件，把"没有"与"读不了"分开。**不抛异常**——调用方按三态分支。 */
export async function readTextChecked(path: string): Promise<ReadOutcome> {
  let text: string;
  try {
    text = await invoke<string>('read_text_file', { path });
  } catch (e) {
    const readError = e instanceof Error ? e.message : String(e);
    let probe: PathProbe;
    try {
      const d = await invoke<string>('describe_path', { path });
      probe = d === 'missing' ? 'missing' : 'exists';
    } catch {
      /* 见下：有意兜底（不赌它不存在） */
      /* 有意兜底：连"在不在"都问不出来（例如目录本身不可访问）。这时**不赌它不存在**，
       * 落到 `unreadable`——调用方会把"读不了"说出口，而不是静默当成"没有这一项"。 */
      probe = 'unreadable';
    }
    return classifyRead(readError, probe);
  }
  return { kind: 'ok', text };
}

/**
 * 只在**读不到任何东西**时返回 `null`；"文件在但读不出来"会抛。
 * 给那些"读不到就跳过"合法、但"读不了"必须中断的调用方用。
 */
export async function readTextOrNull(path: string): Promise<string | null> {
  const r = await readTextChecked(path);
  if (r.kind === 'ok') return r.text;
  if (r.kind === 'missing') return null;
  throw new Error(r.error);
}

/* ────────────────────── 首改备份：三态策略只有这一份 ────────────────────── */

/**
 * 改稿前"留一份原始备份"的**决策**（纯函数，2026-09-16）。
 *
 * 为什么单独抽出来：这份三分支原先在仓里内联了三处（`persistEdit`、aiflow 的 adoptRewrite、
 * risk 面板的 backup 钩子），其中 risk 那处还是"读不到＝还没有"的**两态**写法——
 * 正是 `readTextChecked` 要封的"文件在但读不出来 → 拿当前正文把真原始版顶掉"。
 * 三处同一件事、两种口径，比一处写错更糟：修的人会以为已经修齐了。
 * 现在策略在这里定义一次、测一次，三处都调它。
 */
export type BackupPlan = { kind: 'write' } | { kind: 'skip' } | { kind: 'abort'; reason: string };

export function planBackup(bak: string, r: ReadOutcome): BackupPlan {
  if (r.kind === 'ok') return { kind: 'skip' };
  if (r.kind === 'missing') return { kind: 'write' };
  return {
    kind: 'abort',
    reason: `原始备份 ${bak} 读不出来（${r.error}）——为免把这份唯一的原始版覆盖掉，本次改动**没有执行**；请先确认该文件`,
  };
}

/** 原始备份的路径约定：同目录、`_原始备份.md` 后缀（三处调用点共用，不再各拼各的）。 */
export function backupPathFor(path: string): string {
  const dir = path.slice(0, path.lastIndexOf('/'));
  const base = path.slice(path.lastIndexOf('/') + 1).replace(/\.(md|txt|markdown)$/i, '');
  return `${dir}/${base}_原始备份.md`;
}

/**
 * 「首改前留一份原始备份」的 IO 实现（Tauri invoke 组合层，薄）。
 * 返回的函数可直接当 `RiskIo.backup` / `TxIo.backup` 注入：
 * 确实还没有备份才写；**已经有就不覆盖**（否则第二次改稿会把真正的原始版冲掉）；
 * 在但读不出来就抛错中止——宁可这次不改，不拿教师唯一的原始版去赌。
 */
export function makeFirstChangeBackup(): (path: string, content: string) => Promise<void> {
  return async (path, content) => {
    const bak = backupPathFor(path);
    const plan = planBackup(bak, await readTextChecked(bak));
    if (plan.kind === 'write') await invoke('write_text_file', { path: bak, content });
    else if (plan.kind === 'abort') throw new Error(plan.reason);
  };
}

/* ────────────────────── append-only CSV 台账 ────────────────────── */

/** 一次 CSV 追加的**决策**（纯函数）：建表头 / 追加一行 / 拒绝。 */
export type CsvAppendPlan = { kind: 'init'; content: string } | { kind: 'append'; content: string } | { kind: 'abort'; reason: string };

/**
 * 台账追加策略（2026-09-16）：
 * · 文件还没有（或还是空的）→ 连表头一起**新建**（`write`，原子写）；
 * · 已有内容 → 只把这一行**追加**进去（`append`，O_APPEND）——
 *   原先是"读旧全文→拼一行→写全文"，两次并发记台账后写覆盖先写、丢整行；
 * · 在但读不出来 → **中止**。原先是两态（读不到一律当"还没有"重建表头），
 *   这会把一份读不出来的旧台账整个覆盖掉——与首改备份同一个丢失路径。
 */
export function csvAppendPlan(path: string, existing: ReadOutcome, header: readonly string[], line: string): CsvAppendPlan {
  if (existing.kind === 'unreadable') {
    return { kind: 'abort', reason: `台账 ${path} 读不出来（${existing.error}）——为免覆盖旧账，本次没有写入` };
  }
  const hasContent = existing.kind === 'ok' && existing.text.trim().length > 0;
  return hasContent ? { kind: 'append', content: line } : { kind: 'init', content: header.join(',') + '\n' + line };
}

/** 供 `appendCsvLineWith` 注入的最小端口（测试给内存版；App 给 Tauri invoke）。 */
export interface CsvAppendIo {
  readChecked(path: string): Promise<ReadOutcome>;
  write(path: string, content: string): Promise<void>;
  append(path: string, line: string): Promise<void>;
}

/**
 * 追加一行 CSV（表头只在第一次出现）。**进程内串行**：
 * 同一进程里两次并发追加（例如连点两个"记一条"）排成一队，
 * "读旧→决定 init/append→写"这三步不会被另一队插进来——
 * 否则两次都看到"还没有台账"、各建一份表头，后写的把先写的整行盖掉。
 * 跨进程的并发由 `append`（O_APPEND）兜底。
 */
export function appendCsvLineWith(io: CsvAppendIo): (path: string, header: readonly string[], line: string) => Promise<void> {
  let chain: Promise<void> = Promise.resolve();
  return (path, header, line) => {
    const run = async (): Promise<void> => {
      const plan = csvAppendPlan(path, await io.readChecked(path), header, line);
      if (plan.kind === 'abort') throw new Error(plan.reason);
      await (plan.kind === 'init' ? io.write(path, plan.content) : io.append(path, plan.content));
    };
    chain = chain.then(run, run);
    return chain;
  };
}

/** App 用：Tauri 后端的原子读三态 + 原子写 + 原子追加（从 main.ts 迁来，行为见上）。 */
export const appendCsvLine = appendCsvLineWith({
  readChecked: readTextChecked,
  write: (p, c) => invoke<void>('write_text_file', { path: p, content: c }),
  append: (p, l) => invoke<void>('append_text_file', { path: p, content: l }),
});
