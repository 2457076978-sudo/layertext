/**
 * 文件读取的**三态**封装（2026-09-14）。
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
 *
 * 用法：
 * ```ts
 * const r = await readTextChecked(path);
 * if (r.kind === 'missing') { ...正常路径... }
 * else if (r.kind === 'unreadable') { setStatus(`...读不出来：${r.error}——本次不覆盖它`, 'err'); }
 * else { use(r.text) }
 * ```
 * 纯逻辑（`classifyRead`）单独抽出来，可以在 node 下直接测，不必启动 App。
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
