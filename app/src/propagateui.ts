/**
 * 跨层传播的 **App 侧接线**（`src/core/propagate.ts` 的调用方；2026-09-14 从 `pipew.ts` 拆出来）。
 *
 * 为什么单独一个模块：`pipew.ts` 撞上了 `max-lines: 1000`，而这段是自成一体的
 * "上级的词级决定 → 下级读者正文"。拆出来之后 `pipew.ts` 只负责"谁在什么时候调它"。
 *
 * 口径（Wayne 2026-09-14 拍板）：
 *   · **自动**——加注/去标注一落盘就同步到下级，不弹确认；
 *   · 只写同章目录下的 `原文_<下级层标签>_*.md`（同层多版本只取最新那个）；
 *   · **不留 `_原始备份.md`**：传播只插/剥 `词（中文）`，天然可逆——下级那个
 *     「去除中文标注」按钮才是真撤销路径，而且它也会往下传；
 *   · 变更日志照留：那不是撤销，是"这段现在这样是哪来的"；
 *   · 换词类不改下级正文，只留一张待办清单。
 */

import { invoke } from '@tauri-apps/api/core';
import { setStatus, toast } from './uikit.js';
import { baseName, csvCell } from './pure.js';
import { CHANGELOG_HEADER, type FileSession } from './types.js';
import { simplifyMaxLen } from './ai.js';
import { readTextChecked } from './fsx.js';
import { applyWordActionToText, DEFAULT_READER_TREE, descendantTierFiles, normalizeTree, tierTagOfFilename, type PropagationTarget, type ReaderTree } from '../../src/core/propagate.js';

/** 从书根到当前章目录，找一个能读出 调适项目_*.json 的地方拿 产物命名 / 读者层级。 */
async function propagationConfig(s: FileSession): Promise<{ naming: Record<string, string>; tree: ReaderTree } | null> {
  if (!s.sourcePath) return null;
  const { findProjectConfig } = await import('./datapanel.js');
  const dir = s.sourcePath.slice(0, s.sourcePath.lastIndexOf('/'));
  const found = await findProjectConfig(dir);
  if (!found) return null;
  const cfg = found.config as Record<string, unknown>;
  const naming = (cfg['产物命名'] ?? { A: 'A层85', M: 'M层75', B: 'B层60' }) as Record<string, string>;
  const tree = normalizeTree(cfg['读者层级'] ?? DEFAULT_READER_TREE);
  return { naming, tree };
}

export async function propagateToLowerTiers(s: FileSession, actions: readonly { word: string; op: 'annotate' | 'unanno' | 'rewrite'; zh?: string }[]): Promise<void> {
  if (!actions.length) return;
  const cfg = await propagationConfig(s);
  if (!cfg) return; // 没有调适项目配置⇒不知道层级，跳过（不是错误：绝大多数书没有层级树）
  const fromTag = tierTagOfFilename(s.fileName, cfg.naming);
  if (!fromTag) return; // 当前这份不是分层产物（可能在原稿上工作）⇒没有"下级"可言
  const dir = s.sourcePath!.slice(0, s.sourcePath!.lastIndexOf('/'));
  let files: string[];
  try {
    files = await invoke<string[]>('list_dir', { dir });
  } catch (e) {
    setStatus(`列本章目录失败，跨层传播已跳过：${String(e)}`, 'err');
    return;
  }
  const targets = descendantTierFiles(cfg.tree, cfg.naming, fromTag, files);
  if (!targets.length) return;

  /* 一次加注可能带好几个词：**合并成一次扫描**（每个文件只读一次、只写一次）。
   * 逐词各跑一趟的话，11 章 × 3 层 × N 个词会把同一批文件反复读写。 */
  const plan: { target: PropagationTarget; text: string; hits: number }[] = [];
  /* 记进账、随后渲染出来（`appswallow` 认的就是这个形状）。 */
  const failedFiles: string[] = [];
  for (const t of targets) {
    const r = await readTextChecked(t.path);
    if (r.kind === 'unreadable') {
      failedFiles.push(`${baseName(t.path)}（读不出来：${r.error.slice(0, 60)}）`);
      continue;
    }
    if (r.kind === 'missing') continue; // 这一层还没出这一章，不是错误
    /* 换词类**不改下级正文**（跨层机器改写语境依赖强，是 `propagate.ts` 一开始就写明的策略）：
     * 只在下级留一张待办清单，交下级教师过目。 */
    const rewrites = actions.filter((a) => a.op === 'rewrite');
    if (rewrites.length) {
      try {
        const todoDir = `${dir}/_待复核`;
        const todoPath = `${todoDir}/层级传播_待办.md`;
        const rd2 = await readTextChecked(todoPath);
        if (rd2.kind === 'unreadable') throw new Error(rd2.error);
        const prev = rd2.kind === 'ok' ? rd2.text : '';
        const date0 = new Date().toLocaleDateString('sv-SE');
        let add = '';
        for (const a of rewrites) {
          const line = `- ${date0} 上级 ${fromTag} 将「${a.word}」换成了「${a.zh ?? '更简单说法'}」——请核对本层（${t.tag}）文本命中处\n`;
          if (!prev.includes(line) && !add.includes(line)) add += line;
        }
        if (add) await invoke('write_text_file', { path: todoPath, content: prev + add });
      } catch (e) {
        /* 有意兜底：待办写失败不拦主流程——它只是一张"请核对"的清单，
         * 而且失败原因会随下面那句状态行一起露出来。 */
        setStatus(`下级待办清单没写上：${String(e)}——这一层不会收到「${rewrites.map((a) => a.word).join('、')}」的核对提示`, 'err');
      }
    }

    let text = r.text;
    let hits = 0;
    for (const a of actions) {
      if (a.op === 'rewrite') continue; // 换词只记待办，见上
      const out = applyWordActionToText(text, a.word, a.op, a.zh);
      if (out.changed) {
        text = out.text;
        hits++;
      }
    }
    if (hits) plan.push({ target: t, text, hits });
  }
  if (!plan.length) {
    if (failedFiles.length) setStatus(`跨层传播没做成：${failedFiles.join('；')}`, 'err');
    else if (actions.some((a) => a.op === 'rewrite'))
      toast(
        `已在下级留下待办：${actions
          .filter((a) => a.op === 'rewrite')
          .map((a) => a.word)
          .join('、')}`,
        'ok',
      );
    return;
  }

  /* ---------- 自动写，不弹确认（Wayne 2026-09-14 拍板） ----------
   * 为什么这样是安全的：传播做的只有"插/剥 `词（中文）`"，**天然可逆**——
   * 下级文件里那个「✂ 去除中文标注」随时能拆掉，而且它现在**也会往下传**（见下）。
   * 所以这里不留 `_原始备份.md`：真正的撤销路径是那个按钮，不是备份文件。
   * 但**变更日志必须留**——那不是撤销，是"这段现在这样是哪来的"，台账与审校档案一直在读它。 */
  let wrote = 0;
  for (const p of plan) {
    try {
      await invoke('write_text_file', { path: p.target.path, content: p.text });
      wrote++;
    } catch (e) {
      failedFiles.push(`${baseName(p.target.path)}（${String(e)}）`);
    }
  }
  try {
    const logPath = `${dir}/变更日志_AI审核.csv`;
    let csv = '';
    const rd = await readTextChecked(logPath);
    if (rd.kind === 'ok') csv = rd.text;
    else if (rd.kind === 'unreadable') throw new Error(rd.error);
    if (!csv.trim()) csv = CHANGELOG_HEADER.join(',') + '\n';
    const date = new Date().toLocaleDateString('sv-SE');
    /* 只给**真写成功**的那些文件记账——写失败的不能留"已落实"的痕。 */
    for (const p of plan.filter((x) => !failedFiles.some((f) => f.startsWith(baseName(x.target.path))))) {
      const detail = actions
        .filter((a) => a.op !== 'rewrite')
        .map((a) => (a.op === 'annotate' ? `${a.word}（${a.zh}）` : a.word))
        .join('、');
      csv +=
        [
          'R1',
          date,
          `标准${simplifyMaxLen()}词`,
          p.target.tier,
          '',
          `跨层传播→${p.target.tag}`,
          `${p.hits} 处：${detail}`,
          'R18',
          `层级传播：上级 ${fromTag} 的词级决定自动落到本层（下级可用「去除中文标注」撤回）`,
          '跨层传播',
        ]
          .map(csvCell)
          .join(',') + '\n';
    }
    await invoke('write_text_file', { path: logPath, content: csv });
  } catch (e) {
    toast(`下级正文已改，但变更日志没写上：${String(e)}——这次传播不会出现在台账里`, 'err');
  }
  const tags = [...new Set(plan.map((p) => p.target.tag))].join('/');
  if (failedFiles.length) setStatus(`跨层传播：已写 ${wrote} 个文件；${failedFiles.length} 个失败（${failedFiles.slice(0, 3).join('、')}）`, 'err');
  else toast(`已自动同步到下级 ${tags}：${wrote} 个文件、${plan.reduce((n, p) => n + p.hits, 0)} 处`, 'ok');
}
