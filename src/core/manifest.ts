// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，本仓库已部署版权验证体系，细节不予公开（docs/版权与授权.md）。
/**
 * LayerText · 运行清单（manifest）+ 词表快照（LexiconSnapshot）
 *
 * 审查报告 §三 的原话：「只能重构一处，应先建『运行清单（manifest）+ 事件日志』层，
 * 统一书籍/版本/层级/教师/运行 ID、输入哈希、词表版本、模型版本、产物状态。
 * 引擎、管线、App 仍可保留，但都只能通过 manifest 解析路径；这样优先解决静默错配和复现问题。」
 *
 * 为什么"静默错配"值这么多笔墨：
 *   · 第二本书、第二位教师、同一书多层并行时，输出路径/会话日志/统一词典/标记文件
 *     可能互相覆盖——而脚本会**照常报告成功**；
 *   · 词表、专名表、词典原先在三个脚本里各读一份，口径漂移会重演 clover/squealer
 *     被注成"三叶草/告密者"那类事故（2026-09-10 已因集中一份而修好，但没有版本与哈希，
 *     换过词表之后的产物与旧报表仍然无法分辨）；
 *   · 论文里的数字必须能回答"这是哪一版词表、哪版提示词、哪版模型跑出来的"。
 *
 * 两个对象：
 *   ① LexiconSnapshot —— 一次生成、带版本与哈希；**所有阶段只读它**（报告 §三第①条）。
 *   ② RunManifest      —— 一次运行的全部身份信息 + 每个产物的状态与哈希 + 每步结果。
 *
 * 本模块是纯逻辑（哈希、造对象、比对漂移）。读写文件由调用方负责。
 */

import type { GateCategory } from './segmentgate.js';

/* ────────────────────── 哈希 ────────────────────── */

/** 内容哈希（截 16 位十六进制；够用且便于人眼看与写进文件名） */
export function contentHash(text: string): string {
  // 自实现的 FNV-1a 128 位变体：不引第三方、浏览器与 Node 结果一致（App 侧要用同一口径）
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
  }
  h2 = Math.imul(h2 ^ (h1 >>> 13), 0xc2b2ae35) >>> 0;
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 16);
}

export interface SourceRef {
  /** 逻辑名（词库 / 专名表 / 知识库 / 词典 / 原文 / 情节底线） */
  name: string;
  /** 绝对路径（清单里记全，便于事后定位） */
  path: string;
  hash: string;
  bytes: number;
}

export const refOf = (name: string, path: string, text: string): SourceRef => ({
  name,
  path,
  hash: contentHash(text),
  bytes: text.length,
});

/* ────────────────────── ① LexiconSnapshot ────────────────────── */

export const LEXICON_SCHEMA_VERSION = 1;

export interface LexiconSnapshotSource extends SourceRef {
  /** 该来源贡献了多少个词（让"口径漂移"一眼可见：权重变了没有） */
  count: number;
}

export interface LexiconSnapshot {
  schemaVersion: number;
  /** 版本 = 全部来源哈希的组合哈希。**换一个字节就换一个版本** */
  version: string;
  createdAt: string;
  sources: LexiconSnapshotSource[];
  counts: { known: number; pending: number; proper: number; dict: number; kb: number };
  /** 抽样指纹：出问题时能快速回答"是不是换了词表"，而不必比对整份文件 */
  sample: string[];
  /** 构建时的告警（来源缺失/为空等）——**不静默** */
  warnings: string[];
}

export interface BuildSnapshotInput {
  sources: LexiconSnapshotSource[];
  counts: LexiconSnapshot['counts'];
  /** 全部已知词（用于抽样指纹） */
  known: string[];
  sampleSize?: number;
  createdAt?: string;
}

export function buildLexiconSnapshot(input: BuildSnapshotInput): LexiconSnapshot {
  const parts = [...input.sources].sort((a, b) => (a.name < b.name ? -1 : 1));
  const version = contentHash(parts.map((s) => `${s.name}:${s.hash}:${s.count}`).join('|'));
  const warnings: string[] = [];
  for (const s of parts) {
    if (!s.path) warnings.push(`来源「${s.name}」没有路径`);
    else if (s.bytes === 0) warnings.push(`来源「${s.name}」是空文件（${s.path}）`);
    else if (s.count === 0) warnings.push(`来源「${s.name}」一个词都没读到（${s.path}）`);
  }
  if (!input.counts.known) warnings.push('已知词集为空——词表口径基本失效，任何 OOV 判定都不可信');
  const size = input.sampleSize ?? 12;
  const sorted = [...new Set(input.known.map((w) => w.toLowerCase()))].sort();
  const step = sorted.length ? Math.max(1, Math.floor(sorted.length / size)) : 1;
  const sample = sorted.length ? Array.from({ length: Math.min(size, sorted.length) }, (_, i) => sorted[i * step]).filter(Boolean) : [];
  return {
    schemaVersion: LEXICON_SCHEMA_VERSION,
    version,
    createdAt: input.createdAt ?? new Date().toISOString(),
    sources: parts,
    counts: input.counts,
    sample,
    warnings,
  };
}

export interface DriftReport {
  ok: boolean;
  /** 人话的漂移清单：说清"哪个来源变了"，而不是笼统的"哈希不一致" */
  drift: string[];
}

/** 比对快照与当前来源：词表/专名表/词典被换过而产物还是旧的，就是**静默错配**。 */
export function verifyLexiconSnapshot(snap: LexiconSnapshot, current: SourceRef[]): DriftReport {
  const drift: string[] = [];
  const cur = new Map(current.map((s) => [s.name, s]));
  for (const s of snap.sources) {
    const c = cur.get(s.name);
    if (!c) {
      drift.push(`来源「${s.name}」已经不在项目里（产物仍是按它跑出来的）`);
      continue;
    }
    if (c.hash !== s.hash) drift.push(`来源「${s.name}」内容变了（${s.hash} → ${c.hash}）：${s.path}`);
  }
  for (const c of current) {
    if (!snap.sources.some((s) => s.name === c.name)) drift.push(`新增来源「${c.name}」不在快照里：${c.path}`);
  }
  return { ok: drift.length === 0, drift };
}

/* ────────────────────── ② RunManifest ────────────────────── */

export const MANIFEST_SCHEMA_VERSION = 1;

export type ArtifactKind = '正文' | '报告' | '台账' | '风险队列' | '清单' | '会话日志' | '其他';
export type ArtifactStatus = 'ok' | 'needs-review' | 'missing' | 'stale';

export interface RunArtifact {
  /** 相对"产物目录"的路径（清单本身可整体搬走而不失效） */
  path: string;
  kind: ArtifactKind;
  tier?: string;
  chapter?: string;
  status: ArtifactStatus;
  hash?: string;
  bytes?: number;
  updatedAt?: string;
  /** needs-review 时的原因（规则号），人一眼知道为什么不算完成 */
  reason?: string;
}

export interface ManifestOwner {
  runId: string;
  pid: number;
  host: string;
  startedAt: string;
}

export interface RunManifest {
  schemaVersion: number;
  /** 稳定运行 ID：书-版本-层-教师-输入哈希。同样的输入 = 同一次运行（可复现） */
  runId: string;
  book: string;
  /** 书籍版本（如 v1 / 重制三版）。同一本书多版本并行时靠它隔离 */
  version: string;
  tiers: string[];
  chapters: number[];
  /** 教师 ID：一百名学生场景下，教师审校资产与学生个性化产物必须分得开 */
  teacher: string;
  createdAt: string;
  updatedAt: string;
  owner: ManifestOwner;
  model: { name: string; temperature: number; promptVersion: string };
  /** 词表快照的版本与路径（所有阶段只读它） */
  lexicon: { version: string; snapshotPath: string; warnings: string[] };
  inputs: SourceRef[];
  artifacts: RunArtifact[];
  steps: { id: string; ok: boolean; sec: number; at: string; note?: string }[];
  warnings: { kind: string; message: string; at: string }[];
  /** 未完成（门禁未通过）的段数——清单的"能不能交付"由它决定 */
  pendingReview: number;
  /** 路径布局（报告 §三：「引擎、管线、App 仍可保留，但都只能通过 manifest 解析路径」）：
   *  · `legacy`（默认）= 沿用既有文件命名，教师已有的书与脚本一个字都不用改；
   *  · `run` = 产物按运行 ID 分目录，第二本书/第二位教师/同书多层并行时**不可能互相覆盖**。
   *  两种布局都只从 `resolvePath` 出来——脚本不再自己拼路径。 */
  layout: Layout;
}

/** 路径布局 */
export type Layout = 'legacy' | 'run';

export interface NewManifestInput {
  book: string;
  version: string;
  tiers: string[];
  chapters: number[];
  teacher: string;
  model: { name: string; temperature: number; promptVersion: string };
  lexicon: { version: string; snapshotPath: string; warnings?: string[] };
  inputs: SourceRef[];
  owner?: { pid?: number; host?: string };
  createdAt?: string;
  layout?: Layout;
}

/** 造一份新清单。runId 由身份信息 + 输入哈希决定，因此"同样输入 = 同一个 runId"。 */
export function newManifest(input: NewManifestInput): RunManifest {
  const idParts = [
    input.book,
    input.version,
    [...input.tiers].sort().join('+'),
    [...input.chapters].sort((a, b) => a - b).join('+'),
    input.teacher,
    input.model.promptVersion,
    input.lexicon.version,
    input.inputs.map((i) => `${i.name}:${i.hash}`).sort().join(','),
  ];
  const runId = `${slug(input.book)}-${slug(input.version)}-${input.tiers.join('') || 'ALL'}-${slug(input.teacher)}-${contentHash(idParts.join('|'))}`;
  const now = input.createdAt ?? new Date().toISOString();
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    runId,
    book: input.book,
    version: input.version,
    tiers: [...input.tiers],
    chapters: [...input.chapters],
    teacher: input.teacher,
    createdAt: now,
    updatedAt: now,
    owner: {
      runId,
      pid: input.owner?.pid ?? 0,
      host: input.owner?.host ?? '',
      startedAt: now,
    },
    model: { ...input.model },
    lexicon: { version: input.lexicon.version, snapshotPath: input.lexicon.snapshotPath, warnings: input.lexicon.warnings ?? [] },
    inputs: [...input.inputs],
    artifacts: [],
    steps: [],
    warnings: [],
    pendingReview: 0,
    layout: input.layout ?? 'legacy',
  };
}

const slug = (s: string): string => (s || 'x').replace(/[^\w\u4e00-\u9fff-]+/g, '').slice(0, 24) || 'x';

/** 登记/更新一个产物（同 path 覆盖，不重复堆积） */
export function upsertArtifact(m: RunManifest, a: RunArtifact): RunManifest {
  const i = m.artifacts.findIndex((x) => x.path === a.path);
  if (i >= 0) m.artifacts[i] = { ...m.artifacts[i], ...a };
  else m.artifacts.push(a);
  m.updatedAt = new Date().toISOString();
  return m;
}

/** 记一步结果（管线每步跑完调一次） */
export function recordStep(m: RunManifest, s: { id: string; ok: boolean; sec: number; note?: string }): RunManifest {
  m.steps.push({ ...s, at: new Date().toISOString() });
  m.updatedAt = new Date().toISOString();
  return m;
}

export interface ManifestProblem {
  kind: 'input-drift' | 'artifact-missing' | 'artifact-stale' | 'needs-review' | 'step-failed' | 'lexicon-drift' | 'warning';
  message: string;
  /** 严重度：blocked = 这份产物不能当完成品用 */
  severity: 'blocked' | 'warn';
}

export interface VerifyManifestInput {
  /** 当前各输入来源（用于比对清单里记的哈希） */
  inputs?: SourceRef[];
  /** 产物是否存在（调用方给，纯函数不碰文件系统） */
  exists: (relPath: string) => boolean;
  /** 产物当前内容哈希（可选；给了才能查"产物被改过"） */
  hashOf?: (relPath: string) => string;
  /** 当前词表快照与清单记的版本是否一致 */
  lexiconVersion?: string;
}

/**
 * 校验一份清单：**静默错配的探测网**。
 * blocked 级问题意味着"不能把它当成完成品"——这是报告 P0 同一条原则的延伸：
 * 不能让一份看起来成功的产物，实际是拿旧词表/旧提示词跑出来的。
 */
export function verifyManifest(m: RunManifest, cur: VerifyManifestInput): { ok: boolean; problems: ManifestProblem[] } {
  const problems: ManifestProblem[] = [];

  if (cur.lexiconVersion && cur.lexiconVersion !== m.lexicon.version) {
    problems.push({
      kind: 'lexicon-drift',
      severity: 'blocked',
      message: `词表快照已变更（${m.lexicon.version} → ${cur.lexiconVersion}）：本清单的产物是按旧词表跑出来的，OOV 判定与加注口径都可能已经不同`,
    });
  }
  for (const w of m.lexicon.warnings) problems.push({ kind: 'lexicon-drift', severity: 'warn', message: `词表快照告警：${w}` });

  if (cur.inputs) {
    const now = new Map(cur.inputs.map((s) => [s.name, s]));
    for (const s of m.inputs) {
      const c = now.get(s.name);
      if (!c) {
        problems.push({ kind: 'input-drift', severity: 'warn', message: `输入「${s.name}」这次没有提供，无法比对（上次：${s.path}）` });
        continue;
      }
      if (c.hash !== s.hash) {
        problems.push({
          kind: 'input-drift',
          severity: 'blocked',
          message: `输入「${s.name}」内容已变（${s.hash} → ${c.hash}）：产物是旧输入跑出来的，重跑前不要当作最新`,
        });
      }
    }
  }

  for (const a of m.artifacts) {
    if (!cur.exists(a.path)) {
      problems.push({ kind: 'artifact-missing', severity: 'blocked', message: `产物缺失：${a.path}（清单记的是 ${a.kind}）` });
      continue;
    }
    if (a.status === 'needs-review') {
      problems.push({ kind: 'needs-review', severity: 'blocked', message: `产物未过门禁：${a.path}${a.reason ? `（${a.reason}）` : ''}` });
    }
    if (cur.hashOf && a.hash) {
      const h = cur.hashOf(a.path);
      if (h && h !== a.hash) {
        problems.push({ kind: 'artifact-stale', severity: 'blocked', message: `产物在清单登记之后被改过：${a.path}（${a.hash} → ${h}）` });
      }
    }
  }

  if (m.pendingReview > 0) {
    problems.push({ kind: 'needs-review', severity: 'blocked', message: `本次运行还有 ${m.pendingReview} 段未通过门禁（见 _待复核/），不能当作完成品` });
  }
  // ★ 一件产物都没登记 = 这份校验**证明不了任何事**。
  //   实测踩到：只跑了 --new（建清单）没跑 --stamp（盖章），verify 会输出
  //   "✓ 清单一致：0 件产物……这次运行可以当作完成品引用"——一句彻头彻尾的假绿，
  //   正是本项目要根治的那类"静默成功"。空清单必须判 blocked。
  if (!m.artifacts.length) {
    problems.push({
      kind: 'artifact-missing',
      severity: 'blocked',
      message: '清单里没有任何产物登记——这份校验证明不了任何事（跑生成/管线时会自动盖章；手工建清单后请跑一次 --stamp）',
    });
  }
  for (const s of m.steps) {
    if (!s.ok) problems.push({ kind: 'step-failed', severity: 'blocked', message: `步骤「${s.id}」失败（${s.sec}s）` });
  }
  for (const w of m.warnings) problems.push({ kind: 'warning', severity: 'warn', message: `运行告警 ${w.kind}：${w.message}` });

  return { ok: !problems.some((p) => p.severity === 'blocked'), problems };
}

/** 并发写入探测：同一 runId 上还有另一个进程在跑 → 输出路径会互相覆盖（报告 §三第一个崩点） */
export function detectCollision(existing: RunManifest, incoming: RunManifest, isAlive: (pid: number) => boolean): string | null {
  if (existing.runId !== incoming.runId) return null;
  if (!existing.owner.pid) return null;
  if (existing.owner.host && incoming.owner.host && existing.owner.host !== incoming.owner.host) {
    return `同一运行 ID（${existing.runId}）已在主机 ${existing.owner.host} 上跑过——多机并行会互相覆盖输出，请给不同运行加 --run 标签`;
  }
  if (isAlive(existing.owner.pid)) {
    return `同一运行 ID（${existing.runId}）的进程 ${existing.owner.pid} 还在跑——并发写同一批产物会互相覆盖`;
  }
  return null;
}

/** 清单摘要：报告与界面上"这次到底跑成了什么"的一行答复 */
export interface ManifestSummary {
  runId: string;
  book: string;
  version: string;
  tiers: string[];
  teacher: string;
  artifactCount: number;
  byStatus: Record<ArtifactStatus, number>;
  pendingReview: number;
  failedSteps: string[];
  warningCount: number;
  deliverable: boolean;
  byCategory: Partial<Record<GateCategory, number>>;
}

export function summarizeManifest(m: RunManifest): ManifestSummary {
  const byStatus = { ok: 0, 'needs-review': 0, missing: 0, stale: 0 } as Record<ArtifactStatus, number>;
  for (const a of m.artifacts) byStatus[a.status]++;
  const failedSteps = m.steps.filter((s) => !s.ok).map((s) => s.id);
  return {
    runId: m.runId,
    book: m.book,
    version: m.version,
    tiers: m.tiers,
    teacher: m.teacher,
    artifactCount: m.artifacts.length,
    byStatus,
    pendingReview: m.pendingReview,
    failedSteps,
    warningCount: m.warnings.length,
    deliverable: m.pendingReview === 0 && failedSteps.length === 0 && m.artifacts.every((a) => a.status === 'ok' || a.status === 'stale'),
    byCategory: {},
  };
}


/* ────────────────────── 路径解析：所有脚本唯一的产物路径来源 ────────────────────── */

export type ArtifactPathKind =
  | '正文'
  | '会话日志'
  | '待复核'
  | '完成标记'
  | '失败清单'
  | '风险队列'
  | '台账'
  | '复核报告'
  | '词典增量'
  | '决定日志'
  | '清单';

export interface PathRequest {
  kind: ArtifactPathKind;
  /** 层级标签（如 `A层85`） */
  tier?: string;
  /** 章节名（如 `第一章`） */
  chapter?: string;
  /** 会话粒度（tier/chapter/segment），进会话日志文件名 */
  scope?: string;
  /** 词汇注入维度（full/lite），进会话日志文件名 */
  vocab?: string;
  /** 日期（正文默认文件名用） */
  date?: string;
  /** 试跑后缀（`_试跑` / `_exp1`） */
  suffix?: string;
  /** 段号（`待复核` 用，如 `P07`） */
  segId?: string;
  /** 覆盖扩展名 */
  ext?: string;
}

/** 运行私有目录：`<产物目录>/_运行/<runId>`。`run` 布局下每类产物都收在这儿。 */
export const privateDirOf = (outRoot: string, runId: string): string => `${outRoot}/_运行/${runId}`;

/** 会话/决定日志的文件名尾（层级 + 粒度 + 词表维度 + 后缀），两种布局共用同一套规则 */
const logTail = (req: PathRequest): string =>
  `${req.tier ?? ''}${req.scope && req.scope !== 'tier' && req.scope !== 'book' ? '_' + req.scope : ''}` +
  `${req.vocab && req.vocab !== 'full' ? '_' + req.vocab : ''}${req.suffix ?? ''}.jsonl`;

/**
 * **唯一的产物路径来源**。脚本不再自己拼字符串——拼字符串正是"文件命名约定与并发写入"
 * 那个规模崩点的成因：第二本书、第二位教师、同一书多层并行时，输出路径/会话日志/
 * 统一词典/标记文件会互相覆盖，而脚本照常报告成功。
 *
 * · `legacy` 布局**逐字符复现**既有命名——教师已有的书与下游脚本一个字都不用改；
 * · `run` 布局把每类产物收进运行私有目录，跨运行不可能撞名。
 */
export function resolvePath(layout: Layout, roots: { out: string; work: string }, runId: string, req: PathRequest): string {
  const { out, work } = roots;
  const tier = req.tier ?? '';
  const suffix = req.suffix ?? '';
  const date = req.date ?? '';

  // 会话日志与决定日志在调适工作区（不是产物目录）：两种布局只差根目录
  if (req.kind === '会话日志' || req.kind === '决定日志') {
    const tail = logTail(req);
    if (layout === 'run') return `${privateDirOf(out, runId)}/${req.kind === '决定日志' ? '决定' : '会话'}/${tail}`;
    return req.kind === '决定日志' ? `${work}/_决定/${tail}` : `${work}/_会话/${tail}`;
  }

  if (layout === 'run') {
    const dir = privateDirOf(out, runId);
    switch (req.kind) {
      case '正文':
        return `${dir}/正文/${req.chapter ?? ''}/原文_${tier}_${date}${suffix}.md`;
      case '待复核':
        return `${dir}/待复核/${req.chapter ?? ''}_${req.segId ?? '第N段'}.${req.ext ?? 'md'}`;
      case '完成标记':
        return `${dir}/完成.json`;
      case '失败清单':
        return `${dir}/待复核清单.json`;
      case '风险队列':
        return `${dir}/风险队列${suffix}.json`;
      case '台账':
        return `${dir}/台账_${tier}_${date}${suffix}.md`;
      case '复核报告':
        return `${dir}/复核_${tier}_${date}${suffix}.md`;
      case '词典增量':
        return `${dir}/词典增量.json`;
      case '清单':
        return `${out}/_运行/清单_${runId}.json`;
      default:
        return `${dir}/${req.kind}${suffix}`;
    }
  }

  // legacy：与既有命名完全一致（这是"不破坏教师已有工作流"的硬约束）
  switch (req.kind) {
    case '正文':
      return `${out}/${req.chapter ?? ''}/原文_${tier}_${date}${suffix}.md`;
    case '待复核':
      return `${out}/_待复核/${tier}${suffix}/${req.chapter ?? ''}_${req.segId ?? '第N段'}.${req.ext ?? 'md'}`;
    case '完成标记':
      return `${out}/_运行/${tier}${suffix}.完成.json`;
    case '失败清单':
      return `${out}/_运行/${tier}${suffix}.待复核.json`;
    case '风险队列':
      return `${out}/_运行/风险队列_${tier}${suffix}${req.ext ?? '.json'}`;
    case '台账':
      return `${out}/台账_${tier}_${date}${suffix}.md`;
    case '复核报告':
      return `${out}/复核_${tier}_${date}${suffix}.md`;
    case '词典增量':
      return `${out}/_运行/${tier}${suffix}.词典增量.json`;
    case '清单':
      return `${out}/_运行/清单_${runId}.json`;
    default:
      return `${out}/_运行/${tier}${suffix}${req.ext ?? '.json'}`;
  }
}

/** 取所在目录（不给文件名，只给目录），供"写一类产物到一个目录"的场景用 */
export const dirOfPath = (filePath: string): string => filePath.replace(/\/[^/]*$/, '');

export interface PathResolver {
  /** 按类型取路径（如 `r.any('正文', { chapter: '第一章' })`） */
  any(kind: ArtifactPathKind, extra?: Partial<PathRequest>): string;
  /** 取该类产物的目录 */
  dir(kind: ArtifactPathKind, extra?: Partial<PathRequest>): string;
  /** 会话日志（默认走调适工作区/_会话） */
  session(extra?: Partial<PathRequest>): string;
  /** 决定日志（默认走调适工作区/_决定） */
  decision(extra?: Partial<PathRequest>): string;
  layout: Layout;
  runId: string;
}

/** 面向调用方的语法糖：一次给定身份，反复取路径。脚本里**只允许**通过它拿路径。 */
export function makeResolver(
  layout: Layout,
  roots: { out: string; work: string },
  id: { runId: string; tier?: string; date?: string; suffix?: string },
): PathResolver {
  const base: PathRequest = { kind: '正文', tier: id.tier, date: id.date, suffix: id.suffix };
  return {
    layout,
    runId: id.runId,
    any: (kind, extra) => resolvePath(layout, roots, id.runId, { ...base, kind, ...extra }),
    dir: (kind, extra) => dirOfPath(resolvePath(layout, roots, id.runId, { ...base, kind, ...extra })),
    session: (extra) => resolvePath(layout, roots, id.runId, { ...base, kind: '会话日志', ...extra }),
    decision: (extra) => resolvePath(layout, roots, id.runId, { ...base, kind: '决定日志', ...extra }),
  };
}

export interface CollisionReport {
  ok: boolean;
  /** 撞名的产物路径与涉及它的运行 */
  collisions: { path: string; runs: string[] }[];
}

/**
 * 跨运行撞名探测：把多份清单登记过的产物路径并起来，找出被两次以上运行写过的那些。
 * 这是"第二本书/第二位教师/同书多层并行会互相覆盖"的**直接度量**——
 * legacy 布局下它必然报出撞名，run 布局下必然为空。
 */
export function detectArtifactCollisions(manifests: { runId: string; artifacts: { path: string }[] }[]): CollisionReport {
  const owners = new Map<string, Set<string>>();
  for (const m of manifests) for (const a of m.artifacts) {
    if (!owners.has(a.path)) owners.set(a.path, new Set());
    owners.get(a.path)!.add(m.runId);
  }
  const collisions = [...owners]
    .filter(([, runs]) => runs.size > 1)
    .map(([path, runs]) => ({ path, runs: [...runs].sort() }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  return { ok: collisions.length === 0, collisions };
}
