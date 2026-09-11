/**
 * App 侧的改写门禁接线（纯逻辑 + 可注入 IO）
 *
 * 来源：《LayerText 审查报告 v4_方向》第 1 条 ——
 *   「App 单句改写当前只调用 `buildSystemPrompt`，随后只运行 `checkRev`（`app/src/ai.ts:259-263`），
 *     没有词表、词典、专名和事实检查。**这是残余 P0。**」
 *
 * 本模块只做一件事：**把 App 手里那点素材凑成一份够用的策略切片**，
 * 然后交给引擎的 `checkRewrite`（与管线**同一个**判定）。它不判定、不改稿、不写盘。
 *
 * 成本与上下文分离（v4 方向）：
 *   · 管线：全量策略（3646 词词表 + 1223 条词典 + 专名 + 情节底线，约 19.6k tokens 开场）
 *   · App：只带本书专名（几十个）+ 本句命中的那几条释义 + 已注词账本（本地判定用，不进 prompt）
 * 学生词表**不进 prompt**——因为判定在本地做；模型不需要看见全表。
 *
 * IO 可注入（与 datapanel / risk 同一套路）：纯逻辑在 node 下直接测，不必启动 App。
 */

import { annotationLedgerOf, policySlice, type RewritePolicy } from '../../src/core/rewrite.js';
import { parseDictCsv } from '../../src/core/dictmerge.js';
import { IRR } from '../../src/core/irregular.js';

export interface GateIo {
  read(path: string): Promise<string>;
  listDir(dir: string): Promise<string[]>;
}

let gio: GateIo = {
  async read(path) {
    const mod = await import('@tauri-apps/api/core');
    return mod.invoke('read_text_file', { path });
  },
  async listDir(dir) {
    const mod = await import('@tauri-apps/api/core');
    return mod.invoke('list_dir', { path: dir });
  },
};

/** 测试/替换用 */
export function setGateIo(next: GateIo): void {
  gio = next;
}

/** 账本扫描的上限：别为了一句改写去读整本书 */
export const LEDGER_SCAN_LIMIT = { files: 24, bytes: 2_000_000 };

const dirOf = (p: string): string => p.replace(/\/[^/]*$/, '');
const nameOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

const looksLikeChapter = (f: string): boolean => /^原文_.*\.md$/.test(f);

/**
 * 恢复「全篇已注词」账本。
 *
 * 为什么必须跨文件：项目规则是「一个词**全篇**只注一次」。只看打开的这一章，
 * 第 5 章就会把第 1 章注过的词再注一遍，而系统一声不吭。
 *
 * 扫描范围（**有界**，且如实报告扫到哪儿）：
 *   ① 打开的这一章（调用方直接传文本，不重复读盘）
 *   ② 同目录的其它 `.md`
 *   ③ 上一级目录下各子目录里的 `.md`（Animal Farm 的产物是 `重制三版/第X章/原文_*.md`）
 * 超出上限就停下，并把"没扫完"写进 notes —— 不静默。
 */
export async function loadLedger(input: {
  currentText: string;
  sourcePath?: string | null;
}): Promise<{ words: Set<string>; notes: string[] }> {
  const words = annotationLedgerOf(input.currentText);
  const notes: string[] = [];
  let read = 1; // 当前章已算
  let bytes = input.currentText.length;

  const src = input.sourcePath;
  if (!src) {
    notes.push('不知道文件路径，已注词账本只覆盖当前这一章（跨章重复注可能漏判）');
    return { words, notes };
  }
  const dir = dirOf(src);
  const parent = dirOf(dir);

  const tryDir = async (d: string): Promise<void> => {
    let files: string[];
    try {
      files = await gio.listDir(d);
    } catch {
      return;
    }
    for (const f of files) {
      if (read >= LEDGER_SCAN_LIMIT.files || bytes >= LEDGER_SCAN_LIMIT.bytes) return;
      if (!looksLikeChapter(f)) continue;
      const full = `${d}/${f}`;
      if (full === src) continue;
      try {
        const t = await gio.read(full);
        for (const w of annotationLedgerOf(t)) words.add(w);
        read++;
        bytes += t.length;
      } catch {
        /* 读不到就跳过——但下面的 notes 会把"没扫完"说出来 */
      }
    }
  };

  await tryDir(dir);
  // 上一级下的各章目录（产物常见的两级结构）
  try {
    const ups = await gio.listDir(parent);
    for (const sub of ups) {
      if (read >= LEDGER_SCAN_LIMIT.files || bytes >= LEDGER_SCAN_LIMIT.bytes) break;
      await tryDir(`${parent}/${sub}`);
    }
  } catch {
    /* 没有上一级可扫 */
  }

  if (read >= LEDGER_SCAN_LIMIT.files || bytes >= LEDGER_SCAN_LIMIT.bytes) {
    notes.push(`已注词账本扫到上限（${read} 个文件 / ${Math.round(bytes / 1024)}KB）——跨章重复注可能漏判`);
  } else {
    notes.push(`已注词账本：扫了 ${read} 个文件、${words.size} 个词`);
  }
  return { words, notes };
}

/** 从调适项目配置里读统一词典（同词同义的正本）。读不到就返回空 Map —— 判定端会如实报"未带词典"。 */
export async function loadBookDict(config: Record<string, unknown> | null): Promise<Map<string, string>> {
  const book = (config?.['书级'] ?? {}) as Record<string, unknown>;
  const path = typeof book['词典'] === 'string' ? (book['词典'] as string) : '';
  if (!path) return new Map();
  try {
    const map = new Map<string, string>();
    for (const e of parseDictCsv(await gio.read(path))) map.set(e.word, e.zh);
    return map;
  } catch {
    return new Map();
  }
}

export interface AppPolicyInput {
  /** 打开的这一章正文（含 [P##] 与已有注释） */
  currentText: string;
  sourcePath?: string | null;
  /** `S.currentKnown`（词表 ∪ 不规则形 ∪ 词句卡）——与引擎同一口径 */
  known: Iterable<string>;
  /** `S.properRows`（本书专名） */
  properNames: string[];
  /** 调适项目配置（用于定位统一词典）；没有就传 null */
  config: Record<string, unknown> | null;
  tier: string;
  maxLen: number;
  /** 本句（含候选）里出现的词，用来把词典裁成局部切片 */
  involved: string[];
}

/** 组装 App 的策略切片。**缺什么就缺什么**——`RewriteResult.missingPolicy` 会把它说出来。 */
export async function buildAppPolicy(input: AppPolicyInput): Promise<{ policy: RewritePolicy; notes: string[] }> {
  const ledger = await loadLedger({ currentText: input.currentText, sourcePath: input.sourcePath });
  const dict = await loadBookDict(input.config);
  const policy = policySlice({
    tier: input.tier,
    maxLen: input.maxLen,
    // 与 reader 的 S.currentKnown 对齐：词表 ∪ 不规则形（App 早就把 IRR 并进去，判定必须跟上）
    known: [...input.known, ...Object.keys(IRR)],
    properNames: input.properNames,
    annotated: ledger.words,
    dict,
    involved: input.involved,
  });
  const notes = [...ledger.notes];
  if (!dict.size) notes.push('没读到统一词典（同词同义查不了）——检查 调适项目_*.json 的 书级.词典');
  return { policy, notes };
}

/** 界面用的一句话：这次候选是在什么约束下判的 */
export function gateBadge(r: { status: string; missingPolicy: string[] }): { cls: string; text: string } {
  if (r.status === 'blocked') return { cls: 'gate-blocked', text: '⛔ 未过门禁' };
  if (r.missingPolicy.length) return { cls: 'gate-partial', text: '⚠ 部分约束未带' };
  return { cls: 'gate-ok', text: '✓ 已过门禁' };
}

export const fileNameOf = nameOf;
