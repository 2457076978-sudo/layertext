// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，本仓库已部署版权验证体系，细节不予公开（docs/版权与授权.md）。
/**
 * LayerText · 词表数据正本（LexiconData / LexiconStore）
 *
 * 《LayerText工程优化总计划.md》阶段 3 的原话：
 *   「把词表和词典读取结果冻结为带哈希的 LexiconSnapshot，传入所有阶段。
 *     旧 CSV/JSON 只做一次导入，不再作为新的事实源。」
 *
 * 上一版只做了前半句。`LexiconSnapshot` 记的是**来源的路径、哈希、词数与抽样**——
 * 那是一枚**审计指纹**：它能回答"词表换过没有"，但它**不含数据**。于是每个脚本
 * 开头仍然自己去读一遍 CSV（`loadLexicon` / `loadDict` / `loadKbGloss` / `loadProper`）。
 * 后果：多天跑同一本书时，有人第 3 天改了 `词库.csv`，第 4 天的脚本**照旧读新词表**，
 * 前三天按旧口径、第四天按新口径，中间**没有任何东西会说话**；`清单 --verify`
 * 要到全部跑完才报漂移——那时已经晚了，两套口径已经混在同一本书里。
 *
 * 本模块把"导入"从**指纹**升级成**正本**：`LexiconStore` 里装着**真正的词**——
 * 已知词集、待定词集、专名、逐来源词表、词典释义、知识库加注，外加版本与出处。
 * 导入一次，之后所有阶段读它；CSV 退出事实源的位置，只留下"被导入过的那一份"的身份。
 *
 * 三件刻意做成这样的事（不是顺手写成的）：
 *
 * ① **两个版本号，服务两件事。**
 *    · `version`：正本里**数据**的内容哈希。数据变一个字节它就变——文件名
 *      `LexiconData_<version>.json` 靠它区分，事后靠它回答"这是哪一版词表"。
 *    · `snapshotVersion`：与 `LexiconSnapshot` **同一算法、同一输入**算出来的版本。
 *      清单里一直记的是快照版本，这里保留它，是为了让既有运行的 `--verify`
 *      不因为这次改动凭空报一次"词表已变"——**假警报比没有警报更坏**
 *      （教师看到两条就会开始忽略整个队列）。两者覆盖的对象不同，故意不合并。
 *
 * ② **漂移不自己决定，也不静默降级。** 见 `decideLexiconSource`：有正本就用正本；
 *    正本与现场对不上就**拒绝**，把"哪个来源变了、差哪些词"写清楚再退出。
 *
 * ③ **本模块是纯逻辑，不碰文件系统**（与 `manifest.ts` / `dictmerge.ts` 同一条纪律：
 *    core 里的纯模块要能被 App 直接打包）。读写正本文件在
 *    `tools/af_pipeline/LayerText_AF词表与词典.mjs` 里，写用 `files.ts` 的
 *    `atomicWriteFileSync`——**半份词表正本正是这个项目要消灭的那种损坏**。
 */

import { buildLexiconSnapshot, contentHash, type LexiconSnapshot, type LexiconSnapshotSource, type SourceRef } from './manifest.js';

/* ────────────────────── 文件名与命令 ────────────────────── */

/** 正本结构版本。**读正本的一方必须先看它**：不同代的正本不许互相冒充 */
export const LEXICON_STORE_SCHEMA_VERSION = 1;

/** 正本文件（放 `<产物目录>/_运行/`，与 `LexiconSnapshot.json` 同处：都是"这次运行读了什么"的答案） */
export const LEXICON_STORE_FILE = 'LexiconData.json';

/** 按版本归档的正本文件。换了版本就多一份，旧的那份**不删**：论文里的数字要能回到它 */
export const storeFileNameFor = (version: string): string => `LexiconData_${version}.json`;

/** 漂移报告文件名。漂移要**记下来**，不是打印一次就没了 */
export const LEXICON_DRIFT_FILE = 'LexiconDrift.json';

/** 漂移的唯一修法。写进拒绝信息里，让人不必再去翻文档 */
export const REIMPORT_COMMAND = 'node tools/af_pipeline/LayerText_AF清单.mjs --reimport';

/** 词表读取方式：auto=有正本读正本（默认）；live=明知在漂移也按现场 CSV 跑；reimport=导入步骤专用 */
export type LexiconOverride = 'auto' | 'live' | 'reimport';

/* ────────────────────── 数据形状 ────────────────────── */

/**
 * 逐来源的词。**保持文件里的顺序**——顺序是行为的一部分：
 * 专名表的顺序会进提示词，改了顺序就换了提示词，换了提示词就换了产物。
 */
export interface LexiconWordlists {
  /** 内置课标 2022 三级 1600 表 */
  curriculum: string[];
  /** 内置补录（数词/序数词/星期/月份/国名…） */
  amendment: string[];
  /** 教材进度展开出来的"已学词"（未配置教材进度时为空） */
  textbook: string[];
  /** 项目词库 CSV 的首列（**含短语/句型**——它服务的是规则屈折展开，口径与 known 本来就不同） */
  vocab: string[];
  /** 本书专名表 */
  proper: string[];
}

/**
 * 正本里的**数据**部分。这一层是"词表"本身：把它交给任何人，他不需要任何 CSV 也能得到
 * 与导入当天完全相同的 OOV 判定。
 *
 * 已知词集与逐来源词表**并存、不互相推导**，是刻意的：
 *   · `known` 是 `buildLexicon` 的产物（只收 单词/课标词/待定词 三类 + 专名 + 内置表）；
 *   · `wordlists.vocab` 是词库 CSV 的**首列全部**（含 短语/句型），它服务的是
 *     `loadKnownForms` 的规则屈折展开——两侧口径历史上就不同，**不许在这里顺手统一**：
 *     统一它们 = 悄悄改掉"这个词算不算已学"，正是要防的那件事。
 */
export interface LexiconStoreData {
  /** 判定口径：已知词（升序、去重） */
  known: string[];
  /** 判定口径：待定词（升序、去重）。按定义包含于 known，自检会查 */
  pending: string[];
  /** 专名（**文件顺序**，与 `loadProper` 逐字一致） */
  proper: string[];
  wordlists: LexiconWordlists;
  /** 统一注释词典：word → 中文释义（文件顺序 = 后出现的覆盖先出现的，与 `loadDict` 一致） */
  dict: [string, string][];
  /** 教师知识库加注词：word → { 释义, 来源数 } */
  kb: [string, { zh: string; n: number }][];
}

/** 正本里**真有的条目数**。注意与快照的 counts 不同名同形：那份是 **CSV 行数**，别混 */
export interface LexiconCounts {
  known: number;
  pending: number;
  proper: number;
  dict: number;
  kb: number;
}

export interface LexiconStore {
  schemaVersion: number;
  /** 数据内容哈希（见文件头 ①） */
  version: string;
  /** 与 `LexiconSnapshot` 同算法的版本（清单记的是它） */
  snapshotVersion: string;
  createdAt: string;
  /**
   * 这份正本是**从哪些文件**导入的（含内置词表资产）。
   * 它不是"数据"，所以**不参与 version**：同一份词在文件里换个行序仍是同一份词表。
   * 但它决定"正本还算不算当天的正本"——漂移检查比的就是它。
   */
  inputs: SourceRef[];
  counts: LexiconCounts;
  data: LexiconStoreData;
  /** 导入时发现的自身问题（口径矛盾、版本对不上…）——**不静默** */
  warnings: string[];
}

/* ────────────────────── 造正本 ────────────────────── */

export interface BuildStoreInput {
  data: LexiconStoreData;
  /** 导入时真正读过的全部文件（含内置资产）。漂移检查的基准 */
  inputs: SourceRef[];
  /** 快照口径的来源与行数：**只为对齐 `snapshotVersion`**（见文件头 ①） */
  snapshotSources: LexiconSnapshotSource[];
  snapshotCounts: LexiconSnapshot['counts'];
  createdAt?: string;
}

/**
 * 数据 → 版本。规范化只做**顺序无关**的处理是不够的：顺序也是数据（见 `LexiconWordlists`）。
 * 所以这里只固定**键的顺序**，数组一律按给定顺序序列化。
 */
export function storeVersionOf(data: LexiconStoreData): string {
  return contentHash(
    JSON.stringify({
      known: [...data.known],
      pending: [...data.pending],
      proper: [...data.proper],
      wordlists: {
        curriculum: [...data.wordlists.curriculum],
        amendment: [...data.wordlists.amendment],
        textbook: [...data.wordlists.textbook],
        vocab: [...data.wordlists.vocab],
        proper: [...data.wordlists.proper],
      },
      dict: data.dict.map(([w, zh]) => [w, zh]),
      kb: data.kb.map(([w, v]) => [w, v.zh, v.n]),
    }),
  );
}

export function countsOfStore(data: LexiconStoreData): LexiconCounts {
  return {
    known: data.known.length,
    pending: data.pending.length,
    proper: data.proper.length,
    dict: data.dict.length,
    kb: data.kb.length,
  };
}

/** 深拷贝 + 只留该留的字段：导入方多给的字段不许悄悄进正本（正本要能被原样比字节） */
function normalizeData(d: LexiconStoreData): LexiconStoreData {
  return {
    known: [...d.known],
    pending: [...d.pending],
    proper: [...d.proper],
    wordlists: {
      curriculum: [...d.wordlists.curriculum],
      amendment: [...d.wordlists.amendment],
      textbook: [...d.wordlists.textbook],
      vocab: [...d.wordlists.vocab],
      proper: [...d.wordlists.proper],
    },
    dict: d.dict.map(([w, zh]) => [String(w), String(zh)] as [string, string]),
    kb: d.kb.map(([w, v]) => [String(w), { zh: String(v.zh), n: Number(v.n) || 0 }] as [string, { zh: string; n: number }]),
  };
}

/**
 * 造一份正本。**这里不读文件**——文件由导入方读好交给它，
 * 这样"导入"这件事可以在测试里用几行合成数据完整跑通。
 *
 * `snapshotSources`/`snapshotCounts` 只是为了算出与 `LexiconSnapshot` 一致的
 * `snapshotVersion`；`known` 传空数组是因为它**只影响快照的抽样指纹**（版本只由
 * 来源的 名字:哈希:词数 决定），传进去反而会让两处的抽样口径打架。见文件头 ①。
 */
export function buildLexiconStore(input: BuildStoreInput): LexiconStore {
  const data = normalizeData(input.data);
  const snapshotVersion = buildLexiconSnapshot({
    sources: input.snapshotSources,
    counts: input.snapshotCounts,
    known: [],
    createdAt: input.createdAt,
  }).version;
  const inputs = [...input.inputs].sort((a, b) => (a.name < b.name ? -1 : 1));
  const store: LexiconStore = {
    schemaVersion: LEXICON_STORE_SCHEMA_VERSION,
    version: storeVersionOf(data),
    snapshotVersion,
    createdAt: input.createdAt ?? new Date().toISOString(),
    inputs,
    counts: countsOfStore(data),
    data,
    warnings: [],
  };
  const warnings = lexiconStoreSelfCheck(store);
  const dup = inputs.map((i) => i.name).filter((n, i, a) => a.indexOf(n) !== i);
  if (dup.length) warnings.push(`正本的出处里有同名来源（${[...new Set(dup)].join('、')}）——同名会让漂移检查把两个文件当成一个`);
  store.warnings = warnings;
  return store;
}

/** 逐词问题最多说几条：一条拒绝信息里列 300 个词，等于没列 */
const MAX_LISTED = 5;
/** 只给样本（数量已经在句子里说过了） */
const sampleOf = (words: string[], limit = MAX_LISTED): string => (words.length <= limit ? words.join('、') : `${words.slice(0, limit).join('、')}…`);
/** 给样本 + 总数 */
const listOf = (words: string[], limit = MAX_LISTED): string => (words.length <= limit ? words.join('、') : `${sampleOf(words, limit)}（共 ${words.length} 个）`);
const bullet = (lines: string[]): string[] => lines.map((l) => `  · ${l}`);

/**
 * 正本自检：**这份正本自己是不是自洽的**。
 * 它防的是"手改过的正本"和"写坏的正本"——数据与版本对不上、待定词不在已知集里，
 * 这类矛盾一旦被放过，下游就会拿一份自相矛盾的词表去判 OOV，而且永远查不出来。
 */
export function lexiconStoreSelfCheck(store: LexiconStore): string[] {
  const p: string[] = [];
  if (store.schemaVersion !== LEXICON_STORE_SCHEMA_VERSION) {
    p.push(`正本 schemaVersion 是 ${store.schemaVersion}，本引擎认的是 ${LEXICON_STORE_SCHEMA_VERSION}——正本与引擎不是同一代，不能拿它做判定`);
  }
  const d = store.data as LexiconStoreData | undefined;
  if (!d || typeof d !== 'object') return [...p, '正本没有 data 段'];
  const arrays: [string, unknown][] = [
    ['known', d.known],
    ['pending', d.pending],
    ['proper', d.proper],
    ['dict', d.dict],
    ['kb', d.kb],
  ];
  for (const [name, v] of arrays) if (!Array.isArray(v)) p.push(`正本的 data.${name} 不是数组`);
  if (!d.wordlists || typeof d.wordlists !== 'object') p.push('正本没有 wordlists 段');
  if (p.length) return p;

  const known = new Set(d.known);
  const missingPending = d.pending.filter((w) => !known.has(w));
  if (missingPending.length) p.push(`待定词不在已知词集里（${listOf(missingPending)}）：待定词按定义计入已知，这份正本自相矛盾`);
  const missingProper = d.proper.filter((w) => !known.has(w));
  if (missingProper.length) p.push(`专名不在已知词集里（${listOf(missingProper)}）：专名按定义计入已知`);
  if (!known.size) p.push('已知词集为空——词表口径基本失效，任何 OOV 判定都不可信');

  const recomputed = storeVersionOf(d);
  if (store.version !== recomputed) {
    p.push(`正本内容与它自己的版本号对不上（记的是 ${store.version}，按内容算出来是 ${recomputed}）——这份正本被手改过，或者写坏了`);
  }
  const c = countsOfStore(d);
  const bad = (Object.keys(c) as (keyof LexiconCounts)[]).filter((k) => store.counts?.[k] !== c[k]);
  if (bad.length) p.push(`正本记的条目数与 data 里的实际数对不上（${bad.join('、')}）`);
  return p;
}

/* ────────────────────── 漂移 ────────────────────── */

export interface StoreDrift {
  ok: boolean;
  /** 人话的漂移清单：说清"哪个来源变了"，而不是笼统的"哈希不一致" */
  drift: string[];
  added: string[];
  changed: string[];
  removed: string[];
}

/**
 * 正本 vs 现场：**导入之后 CSV 有没有再被动过**。
 *
 * 与 `verifyLexiconSnapshot` 的区别不是重复劳动：那一个比的是"这本书声明的来源"
 * （含情节底线这类与词义无关的输入），这一个比的是"正本真正读过的那几份文件"，
 * 而且连**路径**一起比——专名表被换成另一个文件、内容恰好一样，也是换了一份事实源。
 */
export function verifyLexiconStore(store: LexiconStore, live: SourceRef[]): StoreDrift {
  const drift: string[] = [];
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  const byName = new Map(live.map((s) => [s.name, s]));
  for (const s of store.inputs) {
    const c = byName.get(s.name);
    if (!c) {
      removed.push(s.name);
      drift.push(`来源「${s.name}」已经不在项目里了（正本导入于 ${store.createdAt}，当时读的是 ${s.path}）`);
      continue;
    }
    if (c.path !== s.path) {
      changed.push(s.name);
      drift.push(`来源「${s.name}」换成了另一个文件：${s.path} → ${c.path}`);
      continue;
    }
    if (c.hash !== s.hash) {
      changed.push(s.name);
      drift.push(`来源「${s.name}」内容变了（${s.hash} → ${c.hash}）：${s.path}`);
    }
  }
  for (const c of live) {
    if (!store.inputs.some((s) => s.name === c.name)) {
      added.push(c.name);
      drift.push(`新增来源「${c.name}」不在正本里：${c.path}`);
    }
  }
  return { ok: drift.length === 0, drift, added, changed, removed };
}

/* ────────────────────── 词义差异（要不要改 OOV 判定） ────────────────────── */

export interface WordSetDiff {
  same: boolean;
  /** 正本说"已知"、现场说"生词"的词：用正本跑，这些词**不加注**；用现场跑会被加注 */
  onlyInStore: string[];
  /** 现场说"已知"、正本说"生词"的词：用正本跑，这些词**会被加注** */
  onlyInLive: string[];
  storeSize: number;
  liveSize: number;
}

/**
 * 「同一个词，两边算不算已知」的逐词差异。
 *
 * 为什么值得单独算这一个指标：来源变一个字节**未必**改变任何判定（改个错别字、
 * 加一行注释都会变哈希）。反过来，来源改一点点也可能翻掉几十个词的判定。
 * 只报"哈希不一致"会让前一种情况白挨一次拒绝，后一种情况说不清代价。
 */
export function diffWordSets(storeKnown: Iterable<string>, liveKnown: Iterable<string>): WordSetDiff {
  const a = new Set(storeKnown);
  const b = new Set(liveKnown);
  const onlyInStore = [...a].filter((w) => !b.has(w)).sort();
  const onlyInLive = [...b].filter((w) => !a.has(w)).sort();
  return { same: onlyInStore.length === 0 && onlyInLive.length === 0, onlyInStore, onlyInLive, storeSize: a.size, liveSize: b.size };
}

/** 把逐词差异写成一句话（供拒绝信息与漂移报告共用，**只写一份**） */
export function describeWordDiff(d: WordSetDiff, limit = MAX_LISTED): string {
  if (d.same) return `已知词口径未变：正本与现场都是 ${d.storeSize} 个词，逐词相同（这次变化只动了文件本身，没动任何词的判定）`;
  const parts = [`已知词口径变了：正本 ${d.storeSize} 个、现场 ${d.liveSize} 个`];
  if (d.onlyInLive.length) parts.push(`现场多出 ${d.onlyInLive.length} 个（用正本跑，这些词不会被加注）：${sampleOf(d.onlyInLive, limit)}`);
  if (d.onlyInStore.length) parts.push(`正本多出 ${d.onlyInStore.length} 个（用现场跑，这些词会被加注）：${sampleOf(d.onlyInStore, limit)}`);
  return parts.join('；');
}

/* ────────────────────── 序列化 ────────────────────── */

export function serializeLexiconStore(store: LexiconStore): string {
  return JSON.stringify(store, null, 2) + '\n';
}

export type StoreParse = { ok: true; store: LexiconStore } | { ok: false; error: string };

/**
 * 读一串文本 → 正本。**坏正本一律返回错误，绝不返回一个"空正本"**：
 * 空的已知词集会让每个词都变成生词，而脚本会照常报告成功——
 * 这是本项目最不能接受的那种失败（"看起来跑通了，其实口径没了"）。
 */
export function parseLexiconStore(text: string): StoreParse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `不是合法 JSON（${e instanceof Error ? e.message : String(e)}）——正本可能只写了一半` };
  }
  const s = raw as Partial<LexiconStore>;
  if (!s || typeof s !== 'object') return { ok: false, error: '顶层不是对象' };
  if (typeof s.version !== 'string' || !s.version) return { ok: false, error: '没有 version' };
  if (!s.data || typeof s.data !== 'object') return { ok: false, error: '没有 data 段（只有指纹、没有数据的东西不是正本）' };
  if (typeof s.createdAt !== 'string') return { ok: false, error: '没有 createdAt' };
  if (!Array.isArray(s.inputs)) return { ok: false, error: '没有 inputs（正本必须自报"从哪些文件导入"）' };
  const store = s as LexiconStore;
  const problems = lexiconStoreSelfCheck(store);
  if (problems.length) return { ok: false, error: problems.join('；') };
  return { ok: true, store };
}

/* ────────────────────── 该读正本还是读 CSV ────────────────────── */

export type LexiconSourceMode =
  /** **legacy**：没有正本（或显式要求直读）→ 沿用既有行为，直读现场 CSV */
  | 'legacy'
  /** 有正本、自检通过、与现场一致 → 读正本 */
  | 'store'
  /** 有正本但自检不通过（被手改/写坏/不同代）→ **拒绝**，不许退回直读 */
  | 'broken'
  /** 有正本但与现场对不上 → **拒绝**，不许用旧正本、也不许悄悄改读 CSV */
  | 'drift'
  /** 导入步骤专用：按现场读，允许漂移存在，但必须把漂移说出来 */
  | 'reimport';

export interface DecideStoreInput {
  /** 读到的正本；没有正本传 null */
  store: LexiconStore | null;
  /** 正本存在却读不出来时的原因。**绝不当成"没有正本"** */
  broken?: string | null;
  /** 现场来源的哈希。有正本时必须给——不给就是"无法证明它还是当天那份" */
  live?: SourceRef[] | null;
  override?: LexiconOverride;
  storePath?: string;
}

export interface LexiconSourceDecision {
  mode: LexiconSourceMode;
  store: LexiconStore | null;
  drift: StoreDrift | null;
  /** 必须原样打印给人看的句子。**调用方不许吞** */
  notices: string[];
  /** 非空表示"不许开工"：原样抛出去。里面已经写好怎么修 */
  refusal: string;
}

/**
 * 决定这次读什么。**这是"漂移必须先响"的唯一落点。**
 *
 * 为什么选"拒绝"，而不是"自动重导入"或"大声警告后照旧读旧的"：
 *
 *   · **自动重导入**：它会在没人看着的时候**换掉判定口径**。同一个词上一章被注、
 *     下一章不被注，而两次运行都报成功——这正是这个项目反复要吃一次的亏。
 *     重导入要花几秒、要人看一眼差了什么，这几秒必须由人付。
 *   · **警告后读旧正本**：警告会被淹没在几百行输出里，而后果是静默的：
 *     产物按旧口径生成，没人知道。
 *   · **警告后读 CSV**：这就是改造之前的行为本身，等于这次改造什么也没做。
 *   · **拒绝**：代价是"得跑一条命令"，收益是**永远不会有两套口径混在同一本书里**。
 *     拒绝的同时必须给出修法与逐词代价（`describeWordDiff`），否则拒绝就只是挡路。
 *
 * 唯一的例外是**显式**的逃生门：`LAYERTEXT_LEXICON=live`。它照样把"你正在绕过正本"
 * 打印出来（`notices`），但不再拦——因为有人已经明确表示他知道自己在干什么。
 */
export function decideLexiconSource(input: DecideStoreInput): LexiconSourceDecision {
  const override = input.override ?? 'auto';
  const where = input.storePath ? `（${input.storePath}）` : '';
  const reimportHint = `重新导入一次：${REIMPORT_COMMAND}`;

  if (override === 'live') {
    return {
      mode: 'legacy',
      store: null,
      drift: null,
      notices: [
        `LAYERTEXT_LEXICON=live：**绕过词表正本**，本次按现场 CSV 直读` +
          (input.store ? `（正本 ${input.store.version} 导入于 ${input.store.createdAt}，本次**没有读它**）` : '（本来也没有正本）') +
          `。这一次的产物与正本口径是否一致，由你负责。`,
      ],
      refusal: '',
    };
  }

  if (input.broken) {
    return {
      mode: 'broken',
      store: null,
      drift: null,
      notices: [`✗ 词表正本读不出来：${input.broken}`],
      refusal:
        `词表正本存在但读不出来/自检不过${where}：${input.broken}\n` +
        `  **不会退回直读 CSV**——那等于在没有任何人知道的情况下换掉一整套判定口径。\n` +
        `  修：\n    · 重新导入（会写出一份自洽的新正本）：${REIMPORT_COMMAND}\n` +
        `    · 确认这份正本不该存在（比如从别处拷来的），删掉它——那时会回到"首次导入之前"的既有行为`,
    };
  }

  if (!input.store) {
    return {
      mode: 'legacy',
      store: null,
      drift: null,
      notices: [
        `没有词表正本（${input.storePath ?? LEXICON_STORE_FILE} 不存在）——本次走的是**首次导入之前**的既有行为：直读现场 CSV。` +
          `跑一次 \`${REIMPORT_COMMAND}\` 就能把词表冻结成正本，之后改 CSV 会被当场拦下。`,
      ],
      refusal: '',
    };
  }

  const live = input.live ?? null;
  if (!live) {
    return {
      mode: 'drift',
      store: input.store,
      drift: null,
      notices: [`✗ 有词表正本${where}，但这次没有提供现场来源，无法证明它仍然对应当前的 CSV`],
      refusal: `有词表正本${where}，但无法把它与现场 CSV 比一遍——**不采用**。\n` + `  一份无法证明与现场一致的词表，读了就是在赌；赌输的代价是两套口径混进同一本书。\n` + `  修：${reimportHint}`,
    };
  }

  const drift = verifyLexiconStore(input.store, live);

  if (override === 'reimport') {
    return {
      mode: 'reimport',
      store: input.store,
      drift,
      notices: [`LAYERTEXT_LEXICON=reimport：这是**导入步骤**，按现场 CSV 读` + (drift.ok ? '（现场与正本一致）' : `，并把下面这些差异写进新正本：`), ...(drift.ok ? [] : bullet(drift.drift))],
      refusal: '',
    };
  }

  if (drift.ok) {
    const c = input.store.counts;
    return {
      mode: 'store',
      store: input.store,
      drift,
      notices: [
        `词表正本 ${input.store.version}（已知 ${c.known} 词、待定 ${c.pending}、专名 ${c.proper}、词典 ${c.dict} 条、知识库 ${c.kb} 条；导入于 ${input.store.createdAt}）` +
          `——现场 CSV 与正本一致，本次读正本。`,
      ],
      refusal: '',
    };
  }

  return {
    mode: 'drift',
    store: input.store,
    drift,
    notices: [`✗ 词表正本已过期${where}（正本 ${input.store.version}，导入于 ${input.store.createdAt}）：`, ...bullet(drift.drift)],
    refusal:
      `词表正本与现场对不上${where}——**不采用**。\n` +
      `  既不用旧正本（那是拿旧口径跑新词表），也不会改读 CSV（那正是改造前的老毛病：改词表没人知道）。\n` +
      bullet(drift.drift).join('\n') +
      `\n  后果很具体：同一次多天运行里，前后产物的 OOV 判定会来自两份不同的词表，而两边都报告成功。\n` +
      `  修：${reimportHint}\n` +
      `      或者明知在漂移仍按现场 CSV 跑：LAYERTEXT_LEXICON=live <原命令>（会在日志里留痕，产物口径自负）`,
  };
}
