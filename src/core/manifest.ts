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

export type ArtifactKind = '学生版' | '正文' | '报告' | '台账' | '风险队列' | '清单' | '会话日志' | '其他';
export type ArtifactStatus = 'ok' | 'needs-review' | 'missing' | 'stale';

export interface RunArtifact {
  /** 相对"产物目录"的路径（清单本身可整体搬走而不失效） */
  path: string;
  /** **稳定产物身份**（见下文「产物身份」一节）。它回答的是"这件东西是**什么**"，
   *  而 `path` 回答的是"它**现在在哪儿**"——两者不是一回事，这正是本轮要分开的东西。
   *  旧清单没有这个字段（读的时候按 `kind/层级/章节` 算得出来，`--stamp` 时写进盘上）。 */
  id?: string;
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

/* ────────────────────── 产物身份：一件产物"是什么"，与它放在哪儿无关 ────────────────────── */

/**
 * 《LayerText 工程优化总计划》阶段 3 的第一句是「Run/Artifact/Decision/Teacher 四类实体
 * **有稳定 ID**」。Run（`runId`）与 Decision（`eventId`）已经各有一个，Artifact 一直空着：
 * `RunArtifact` 拿 `path` 当主键，于是**产物的身份就是它的位置**。
 *
 * 身份 = 位置会坏在三处，而且三处都是"不报错、结果错"：
 *   · 文件搬家/改名（换章节目录、换布局 `legacy` ↔ `run`）——同一件产物被当成两件，
 *     旧的那条登记从此对不上盘上任何文件，而谁也不会去删它；
 *   · 同一件产物被两次运行（两位教师）各写一份、路径还不一样——按路径比永远比不出来，
 *     于是"两位教师互相覆盖"这件事，在最该被看见的时候是看不见的（本轮要修的漏洞）；
 *   · 决定（`DecisionEvent`）与版本节点是挂在产物上的：产物一换身份，历史决定就成了孤儿。
 *
 * ── 选的是什么 ────────────────────────────────────────────────────────────
 * **逻辑身份：`种类（kind） + 层级（tier） + 章节（chapter）`**。
 * 也就是说"这本书 A 层第一章的正文"这件事物，无论它落在
 * `第一章/原文_A层85_2026-09-10.md` 还是 `_运行/<runId>/正文/第一章/原文_A层85_2026-09-11.md`，
 * 都是同一件产物、同一个 ID。
 *
 * ── 为什么不是另外三样 ────────────────────────────────────────────────────
 * · **不是内容哈希**：内容进了身份，就等于说"重写一遍就是另一件产物"。可是 `hash` 本来
 *   就是 `RunArtifact` 的一个字段，"这件被改过"由 `artifact-stale` 校验回答——
 *   "内容变了"已经有一个字段在记，不必再让它去改身份。由此得到的性质是刻意的：
 *   **同一件产物被两位教师改成两份内容时，身份相同、内容不同**——这不是缺陷，
 *   这正是要报出来的那件事（见 `detectArtifactCollisions` 的「分叉」）。
 * · **不是随机 UUID**：随机 ID 只在"登记的那一刻"唯一。两次运行各写同一件产物会拿到两个
 *   UUID，于是"两位教师写的是不是同一件东西"永远查不出来——正是要修的漏洞。
 *   它还要求身份必须被**持久化**：清单被手写一份、从别处拷一份，身份就没了。
 *   这里选的身份是**算出来的**（`artifactIdOf` 是纯函数），所以任何一份旧清单，读的时候
 *   都算得出它的产物身份（`withArtifactIds` 只是把算出来的结果写进盘上）。
 * · **不是路径**：路径是它在盘上的位置，位置会变；而且它已经作为 `path` 字段在那里了。
 *
 * ── 它不是什么（边界，写清楚免得被当成万能钥匙） ──────────────────────────
 * · **不含日期**：`台账_A层85_2026-09-10.md` 与 `台账_A层85_2026-09-11.md` 是同一件产物
 *   被两天各写了一份（会被报成「分叉」），不是两件不同产物。日期属于运行（`runId`/`updatedAt`）。
 * · **不含运行**：身份必须跨运行稳定，否则"两次运行写的是不是同一件东西"就无从谈起。
 * · **不含书**：身份在**一份产物目录内**唯一（每本书有自己的产物目录与 `_运行/`）。
 *   把两本书的清单混在一起比对，本来就是另一件事，不在 `detectArtifactCollisions` 的职责里。
 * · **拿不出 `kind` 的登记项没有逻辑身份**，退化为路径身份（`art@<path>`）：一件说不出
 *   自己是什么的东西，只有它的位置能指认它。这是旧登记项的退化情形，不是错误。
 * · 它**不取代 `path`**：登记（`upsertArtifact`）仍然按路径——登记记的是盘上的事实。
 *   文件搬到别处，登记会多出一条，但那两条的身份相同，撞名探测与发布包都认得出它们是同一件。
 *   反过来**不能**按身份去覆盖登记：待复核段落这类产物共用同一个粗身份（见下），
 *   按身份覆盖会让它们互相吃掉，一次运行只剩一条待复核记录——那比多一条登记坏得多。
 *
 * ── 已知的诚实边界 ────────────────────────────────────────────────────────
 * 逻辑身份只在"它认得出唯一一件"时才当身份用。同一份清单里两件产物共用一个身份
 * （例：某层若干条待复核段落都是 `其他 + 该层 + 无章节`），说明这个身份描述不了它们，
 * 于是退回路径比对（见 `identityKeysOf`）。宁可少报，不可误报：一条凭粗身份发出来的
 * 假撞名，会让人从此忽略这条检查——而它要拦的是真事故。
 */

/** 逻辑身份只认这几个字段：**没有 hash**（内容不进身份，理由见上） */
export interface ArtifactIdentity {
  /** 逻辑身份认不出来时的退化身份（`art@<path>`）；也是"这件东西在哪儿"的登记 */
  path?: string;
  kind?: string;
  tier?: string;
  chapter?: string;
}

/** 退化身份的前缀：一眼看得出"这条不是逻辑身份，而是位置" */
export const PATH_ID_PREFIX = 'art@';

/**
 * 算出一件产物的稳定身份。**纯函数：不看盘、不带状态、不依赖任何注册表**——
 * 同一件产物在任何时候、任何进程里都算出同一个 ID，这就是"稳定"的全部含义，
 * 也是旧清单不需要迁移的原因（读的时候算，写的时候落）。
 *
 * 种类、层级、章节三样都拿不出来（连路径都没有）时返回**空串 = 没有身份**。
 * 这里刻意不返回"空内容的哈希"：那会让两条互不相干的空白登记项算出同一个 ID，
 * 凭空造出一次撞名——报假警比不报更坏。
 */
export function artifactIdOf(a: ArtifactIdentity): string {
  const kind = (a.kind ?? '').trim();
  if (!kind) return a.path ? `${PATH_ID_PREFIX}${a.path}` : '';
  return `art-${contentHash(`${kind}\u0001${a.tier ?? ''}\u0001${a.chapter ?? ''}`).slice(0, 12)}`;
}

/** 人读的身份（`正文｜A层85｜第一章`）。报错信息里要说清"是哪一件"，
 *  而不是只给一串十六进制——那串十六进制除了用来比对，读不出任何东西。 */
export function artifactLabelOf(a: ArtifactIdentity): string {
  const kind = (a.kind ?? '').trim();
  if (!kind) return a.path ? a.path : '（无身份）';
  return [kind, a.tier || '—', a.chapter || '—'].join('｜');
}

/** 还没有身份的登记项（读的时候算得出来，但**盘上没写**）。
 *  用途只有一个：如实报告"这份清单还是旧形状"，以及 `--stamp` 时补齐。 */
export const artifactsMissingId = (m: RunManifest): RunArtifact[] => m.artifacts.filter((a) => !a.id);

/**
 * 把身份就地补进还没有身份的登记项（`--stamp` 走一遍，旧清单从此就是新形状）。
 * 与 `upsertArtifact` 同一风格：就地改 `m` 并返回它。
 * **只加 `id` 一个字段**，其它字段一个字都不动——自愈不许顺手改写别的账。
 */
export function withArtifactIds(m: RunManifest): RunManifest {
  for (let i = 0; i < m.artifacts.length; i++) {
    const a = m.artifacts[i]!;
    const id = a.id || artifactIdOf(a);
    if (id && id !== a.id) m.artifacts[i] = { ...a, id };
  }
  return m;
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
    input.inputs
      .map((i) => `${i.name}:${i.hash}`)
      .sort()
      .join(','),
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

/**
 * 登记/更新一个产物（同 path 覆盖，不重复堆积）。
 *
 * 主键仍然是**路径**——登记记的是"盘上现在有这个文件"，那是事实，不是身份。
 * 但登记的同时把身份算出来写进去（`--stamp` 因此天然就是旧清单的自愈点）：
 * 只算不写的话，下一次读这份清单的人还得再算一遍，而"清单里有没有身份"这件事
 * 就会永远停在一个说不清的状态上。
 */
export function upsertArtifact(m: RunManifest, a: RunArtifact): RunManifest {
  const i = m.artifacts.findIndex((x) => x.path === a.path);
  const merged = i >= 0 ? { ...m.artifacts[i], ...a } : { ...a };
  const id = merged.id || artifactIdOf(merged);
  const rec = id ? { ...merged, id } : merged;
  if (i >= 0) m.artifacts[i] = rec;
  else m.artifacts.push(rec);
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

export type Tier = 'A' | 'B' | 'M';

/**
 * 层级 → 产物命名里的层级标签。**唯一口径**。
 *
 * 这个映射原来在 7 个管线脚本和 App 面板里各抄了一份（`{A:'A层85', M:'M层75', B:'B层60'}`）。
 * 抄一份就意味着有一天会改到其中几份：那时"命令行写到 A、面板去 B 找"会表现成
 * "面板说没有队列"——一种查起来极费劲、现象又毫无线索的故障。
 * 它属于**产物命名约定**，所以和 `resolvePath` 放在一起，而不是散在各调用点。
 */
export const TIER_TAG: Record<string, string> = { A: 'A层85', M: 'M层75', B: 'B层60' };

/** 层级标签（`A` → `A层85`）。认不出来就原样返回——不编一个假的层级名。 */
export const tierTagOf = (tier: string): string => TIER_TAG[tier] ?? tier;

export type ArtifactPathKind =
  | '正文'
  /** **学生版**：教师工作稿减去内部内容之后的、能直接交给学生读的那一份。
   *  与 `正文` 分开是刻意的——它们**不是同一种东西**：正文是工作稿（带段标记 `[P##]`
   *  与内部制作说明），学生版是读物。混成一种名称，迟早有人把工作稿当成读物发出去。 */
  | '学生版'
  | '会话日志'
  | '待复核'
  | '完成标记'
  | '失败清单'
  | '风险队列'
  | '台账'
  | '复核报告'
  | '词典增量'
  | '决定日志'
  /** 正文版本节点日志（append-only JSONL）。与 `决定日志` 并列的第二本账：
   *  决定日志回答"谁做了什么决定"，版本日志回答"正文变成了哪一版、父版本是谁"。 */
  | '版本日志'
  /** 人读的**汇总报告**（三档汇总 / 台账总览 / 四格实验报告 / 重制汇总）。
   *  legacy 落在产物根目录（`三档汇总_<日期>.md`），run 落进运行私有目录。 */
  | '汇总报告'
  /** 落在 `_运行/` 下的**中间产物**（四格实验原始数据、入库提议）。
   *  与 `汇总报告` 分开，是因为它们的落点不同（一个在产物根、一个在 `_运行/`），
   *  合成一种会让其中一边的命名被改掉。 */
  | '运行中间产物'
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
  /** 产物名（`汇总报告` / `运行中间产物` 用，如 `三档汇总`、`四格实验_A层85`）。
   *  **不是所有产物都能用"层+章+日期"描述**：汇总报告跨层跨章，它只有一个名字。 */
  name?: string;
}

/** 运行私有目录：`<产物目录>/_运行/<runId>`。`run` 布局下每类产物都收在这儿。 */
export const privateDirOf = (outRoot: string, runId: string): string => `${outRoot}/_运行/${runId}`;

/** 会话/决定日志的文件名尾（层级 + 粒度 + 词表维度 + 后缀），两种布局共用同一套规则 */
const logTail = (req: PathRequest): string =>
  `${req.tier ?? ''}${req.scope && req.scope !== 'tier' && req.scope !== 'book' ? '_' + req.scope : ''}` + `${req.vocab && req.vocab !== 'full' ? '_' + req.vocab : ''}${req.suffix ?? ''}.jsonl`;

/**
 * **唯一的产物路径来源**。脚本不再自己拼字符串——拼字符串正是"文件命名约定与并发写入"
 * 那个规模崩点的成因：第二本书、第二位教师、同一书多层并行时，输出路径/会话日志/
 * 统一词典/标记文件会互相覆盖，而脚本照常报告成功。
 *
 * · `legacy` 布局**逐字符复现**既有命名——教师已有的书与下游脚本一个字都不用改；
 * · `run` 布局把每类产物收进运行私有目录，跨运行不可能撞名。
 */
export function resolvePath(layout: Layout, roots: { out: string; work: string }, runId: string, reqIn: PathRequest): string {
  const { out, work } = roots;
  /* 层级先过唯一口径（`tierTagOf`）——归一落在**请求**上而不是某个局部变量，
   * 因为函数内每条分支（含 `logTail`）都要用同一个值：写日志的一侧一直传标签（`A层85`），
   * 读的一侧却混着传裸层键（`A`）——同名请求解析出两个文件名，读的那个永远不存在
   * （发布包的决定条数恒为 0 就是这么来的，第七轮 P1-⑤）。在入口归一，
   * 调用方传哪种写法都解析到同一个文件，口径就不可能再分叉。 */
  const req: PathRequest = reqIn.tier ? { ...reqIn, tier: tierTagOf(reqIn.tier) } : reqIn;
  const tier = req.tier ?? '';
  const suffix = req.suffix ?? '';
  const date = req.date ?? '';

  // 会话日志、决定日志与版本日志在调适工作区（不是产物目录）：两种布局只差根目录
  if (req.kind === '会话日志' || req.kind === '决定日志' || req.kind === '版本日志') {
    const tail = logTail(req);
    const sub = req.kind === '决定日志' ? '决定' : req.kind === '版本日志' ? '版本' : '会话';
    if (layout === 'run') return `${privateDirOf(out, runId)}/${sub}/${tail}`;
    return `${work}/_${sub}/${tail}`;
  }

  if (layout === 'run') {
    const dir = privateDirOf(out, runId);
    switch (req.kind) {
      case '汇总报告':
        // 与 legacy **同名**，只换目录——不然"两种布局"就变成了"两套命名"，
        // 而两套命名的直接后果是下游按名字找文件时只对其中一种成立。
        return `${dir}/${req.name ?? '汇总'}${date ? `_${date}` : ''}${suffix}${req.ext ?? '.md'}`;
      case '运行中间产物':
        return `${dir}/${req.name ?? '中间产物'}${suffix}${req.ext ?? '.json'}`;
      case '正文':
        return `${dir}/正文/${req.chapter ?? ''}/原文_${tier}_${date}${suffix}.md`;
      case '学生版':
        return `${dir}/学生版/${req.chapter ?? ''}/学生版_${tier}_${date}${suffix}.md`;
      case '待复核':
        /* ★ 后缀必须参与落点。legacy 用**子目录**把试跑与正式分开
         * （`_待复核/A层85_试跑/` 与 `_待复核/A层85/`），run 布局原来把它丢了——
         * 于是同一个 runId 下的两次运行（**输入相同 ⇒ runId 相同**，正是"先试跑看看、
         * 再正式跑"这个最常见的用法）会把待复核段落写到**同一个路径**上，后一次覆盖前一次。
         *
         * 待复核目录装的是"门禁没过、被隔离出来"的段落——**它是那次失败唯一的记录**。
         * 被覆盖掉之后，教师看到的是"这次没有段落被隔离"，而实际上有。
         * 跑得通、退出码 0、结论错，正是本项目一直在治的那一类。
         *
         * 这里保留 legacy 的**语义**（后缀分目录）而不是把后缀拼进文件名：
         * 两种布局的差别应当只是"收进运行私有目录"，不是"换一套命名规则"。 */
        return `${dir}/待复核${suffix}/${req.chapter ?? ''}_${req.segId ?? '第N段'}.${req.ext ?? 'md'}`;
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
    /* 这两种是**新增**的 kind，它们逐字符复现的是各脚本原来手拼的字符串——
     * 迁移不许改动落点，否则"换了个写法"就变成了"换了个位置"。 */
    case '汇总报告':
      return `${out}/${req.name ?? '汇总'}${date ? `_${date}` : ''}${suffix}${req.ext ?? '.md'}`;
    case '运行中间产物':
      return `${out}/_运行/${req.name ?? '中间产物'}${suffix}${req.ext ?? '.json'}`;
    case '正文':
      return `${out}/${req.chapter ?? ''}/原文_${tier}_${date}${suffix}.md`;
    case '学生版':
      // 与正文同一个章节目录（教师的目录结构不变），只换文件名前缀——
      // "两种布局的差别只是收进运行私有目录"，这条纪律对新产品同样成立
      return `${out}/${req.chapter ?? ''}/学生版_${tier}_${date}${suffix}.md`;
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
  /** 版本日志（默认走调适工作区/_版本）。**正文改动的第二本账**，与决定日志配对 */
  version(extra?: Partial<PathRequest>): string;
  layout: Layout;
  runId: string;
}

/** 面向调用方的语法糖：一次给定身份，反复取路径。脚本里**只允许**通过它拿路径。 */
export function makeResolver(layout: Layout, roots: { out: string; work: string }, id: { runId: string; tier?: string; date?: string; suffix?: string }): PathResolver {
  const base: PathRequest = { kind: '正文', tier: id.tier, date: id.date, suffix: id.suffix };
  return {
    layout,
    runId: id.runId,
    any: (kind, extra) => resolvePath(layout, roots, id.runId, { ...base, kind, ...extra }),
    dir: (kind, extra) => dirOfPath(resolvePath(layout, roots, id.runId, { ...base, kind, ...extra })),
    session: (extra) => resolvePath(layout, roots, id.runId, { ...base, kind: '会话日志', ...extra }),
    decision: (extra) => resolvePath(layout, roots, id.runId, { ...base, kind: '决定日志', ...extra }),
    version: (extra) => resolvePath(layout, roots, id.runId, { ...base, kind: '版本日志', ...extra }),
  };
}

export interface ArtifactCollision {
  /** 撞在一起的**产物身份**（同一件产物，不是同一个位置） */
  id: string;
  /** 人读的身份（`正文｜A层85｜第一章`；退化身份时就是路径） */
  label: string;
  /** · `覆盖` = 两次运行写到了**同一个路径**：后者把前者盖掉了，最坏的一种；
   *  · `分叉` = 同一件逻辑产物落在**不同路径**：没有互相覆盖，但两份副本谁作数没人知道。
   *    旧口径只比路径，这一种一个字都不会报——而"两位教师各写一份"正是它。 */
  kind: '覆盖' | '分叉';
  /** 涉及这次撞名的运行（升序，可复现） */
  runs: string[];
  /** 这件产物被写到的全部路径（升序） */
  paths: string[];
  /** 被两次以上运行写过的那几个路径（非空 = 真的互相覆盖过） */
  overwritten: string[];
}

export interface CollisionReport {
  ok: boolean;
  /** 撞名的产物身份（空数组 = 没有撞名） */
  collisions: ArtifactCollision[];
}

/**
 * 一份清单内部：**身份只在它认得出唯一一件的时候才当身份**。
 *
 * 两件产物共用一个逻辑身份（真实例子：某层若干条待复核段落都是 `其他 + 该层 + 无章节`），
 * 说明这个身份描述不了它们——那就退回路径。这是有意的保守：撞名探测的价值全在"报了就是真的"，
 * 一条凭粗身份发出来的假撞名，会让人从此忽视这条检查，而它要拦的是真事故。
 */
function identityKeysOf(artifacts: ArtifactIdentity[]): string[] {
  const logical = artifacts.map((a) => artifactIdOf(a));
  const count = new Map<string, number>();
  for (const id of logical) if (id) count.set(id, (count.get(id) ?? 0) + 1);
  return logical.map((id, i) => {
    if (id && (count.get(id) ?? 0) === 1) return id;
    const p = artifacts[i]!.path;
    return p ? `${PATH_ID_PREFIX}${p}` : '';
  });
}

const sortedKeys = (s: Set<string>): string[] => [...s].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));

/**
 * 跨运行撞名探测：找出**同一件产物被两次以上运行写过**的那些。
 * 这是"第二本书/第二位教师/同书多层并行会互相覆盖"的**直接度量**——阶段 3 验收
 * 「两位教师同时对同一本书不同层级运行不会覆盖词典、日志或产物」靠它答卷。
 *
 * 按**身份**比，不按路径比（这是本轮改的东西）：
 *   · 同一件逻辑产物被两次运行写到两个不同路径（换了布局、换了日期、两位教师各写一份），
 *     旧口径只比路径，会**静静地漏掉**——而"两位教师各写一份"恰恰是最该被看见的；
 *   · 按身份比之后，撞名分两类报：`覆盖`（真被盖掉，最坏）与 `分叉`（两份副本，谁作数要人定）。
 *
 * 但**按路径的那半件事一件都不能丢**：身份认不出来时退回路径（见 `identityKeysOf`），
 * 若只按身份比，"同一个文件被两次运行写过"这件事就会漏。所以两条路都要走，
 * 并且**去重**——同一个路径靠身份已经报过的，不再重复报一次。
 */
export function detectArtifactCollisions(manifests: { runId: string; artifacts: ArtifactIdentity[] }[]): CollisionReport {
  /** 身份 → 这次撞名的全部参与者 */
  const groups = new Map<string, { label: string; runs: Set<string>; pathRuns: Map<string, Set<string>> }>();
  /** 路径 → 写过它的运行（身份认不出来时的兜底口径，也是旧口径） */
  const pathRuns = new Map<string, Set<string>>();
  const put = <T>(map: Map<string, Set<T>>, key: string, value: T): void => {
    const s = map.get(key) ?? new Set<T>();
    s.add(value);
    map.set(key, s);
  };

  for (const m of manifests) {
    const keys = identityKeysOf(m.artifacts);
    m.artifacts.forEach((a, i) => {
      const id = keys[i]!;
      // 没有身份的登记项不参与身份比对：凭空给它一个身份，就是凭空造一次撞名
      if (id) {
        const g = groups.get(id) ?? { label: artifactLabelOf(a), runs: new Set<string>(), pathRuns: new Map() };
        g.runs.add(m.runId);
        if (a.path) put(g.pathRuns, a.path, m.runId);
        groups.set(id, g);
      }
      if (a.path) put(pathRuns, a.path, m.runId);
    });
  }

  const collisions: ArtifactCollision[] = [];
  const reported = new Set<string>();
  for (const [id, g] of groups) {
    if (g.runs.size < 2) continue;
    const overwritten = [...g.pathRuns]
      .filter(([, runs]) => runs.size > 1)
      .map(([p]) => p)
      .sort();
    for (const p of overwritten) reported.add(p);
    collisions.push({
      id,
      label: g.label,
      kind: overwritten.length ? '覆盖' : '分叉',
      runs: sortedKeys(g.runs),
      paths: sortedKeys(new Set(g.pathRuns.keys())),
      overwritten,
    });
  }
  /* 兜底那一条口径：同一个路径被两次运行写过。旧口径唯一能报的就是它——
   * 身份退化、或被 `identityKeysOf` 退回路径时，只有这条路还拦得住"真被盖掉"。 */
  for (const [path, runs] of pathRuns) {
    if (runs.size < 2 || reported.has(path)) continue;
    collisions.push({ id: `${PATH_ID_PREFIX}${path}`, label: path, kind: '覆盖', runs: sortedKeys(runs), paths: [path], overwritten: [path] });
  }

  collisions.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { ok: collisions.length === 0, collisions };
}

/* ────────────────────── 运行身份：指针分片与选取 ────────────────────── */

/**
 * 运行身份（App 与命令行脚本共用同一个形状）。
 * **这是"这次产物该放哪儿、该去哪儿找"的唯一答案**，任何调用方都不许自己拼。
 */
export interface RunIdentity {
  layout: Layout;
  runId: string;
  teacher: string;
  tier?: string;
}

/** 一份清单指针文件的内容。**它描述一次运行**，不描述"当前"——这是关键区别。 */
export interface ManifestPointer {
  /** 指向的清单文件绝对路径 */
  path: string;
  runId: string;
  layout: Layout;
  teacher: string;
  tier?: string;
  updatedAt?: string;
}

/**
 * 文件名里安全的片段（教师名/层级标签都可能是中文，直接进文件名不难看也难查）。
 *
 * 把路径分隔符换成 `-` 是必须的（教师名来自环境变量，可能带 `/`）；
 * 顺手把 `..` 压掉、把首尾的 `.` `-` 去掉，是为了**文件名本身**也不带
 * "上一级目录"这种看起来危险的东西——`清单_..-..-etc-passwd_A层85.json`
 * 虽然拼不出路径穿越，但谁看到它都得停下来想一想，这本身就是成本。
 */
export const fileSafe = (s: string): string =>
  s
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '')
    .trim() || 'unknown';

/**
 * 指针文件名：**按 教师 + 层级 分片**。
 *
 * 原来只有一份全局的 `清单_最新.json`。两个人同时跑同一本书的不同层级时，
 * 后跑者把先跑者的身份覆盖掉，先跑者的进程接着去读到**对方的 runId**，
 * 于是把产物写进对方的运行私有目录、或者去对方目录里找产物找不到——
 * 而两边都报告成功。**连 `--layout run` 都挡不住**，因为它挡的是"路径撞名"，
 * 不是"身份被换掉"。分片之后，每个 (教师, 层级) 有自己的指针，谁也覆盖不了谁。
 */
export const pointerNameOf = (key: { teacher: string; tier?: string }): string => `清单_${fileSafe(key.teacher)}${key.tier ? `_${fileSafe(key.tier)}` : ''}.json`;

/** "最近一次运行"的索引文件名。**它只是索引**：
 *  给人看的"最近跑过哪一次"，不是任何程序的事实源（事实源是各次运行自己的那份指针）。 */
export const LATEST_POINTER_NAME = '清单_最新.json';

/** 身份是从哪儿来的（进日志与界面，让"我读到的是哪一次运行"可见） */
export type IdentitySource = '显式指定' | '按教师分片' | '最近一次' | '无清单（legacy）';

export interface IdentityChoice {
  identity: RunIdentity;
  source: IdentitySource;
  /** 用了别处的身份却说不出理由时，把可疑之处如实写出来——**它绝不静默** */
  warning?: string;
}

/** 分片指针"认得出来"的那个教师名：空串与 `unknown` 都表示"不知道是谁"，不参与比对 */
const knownTeacher = (t?: string): string => (t && t !== 'unknown' ? t : '');

/**
 * 选一个运行身份。纯函数——读盘由调用方做，这里只做判断。
 *
 * 规则（按可信度从高到低）：
 *   ① 显式指定 `--run <runId>` / `LAYERTEXT_RUN`：最可信，写在命令行上的东西不会有歧义；
 *   ② 按 (教师, 层级) 分片的那份指针：**并发场景下的正确答案**；
 *   ③ 全局"最近一次"：**只在它的教师与层级都跟我们对得上时才用**。
 *      对不上就说明我们可能拿到了别人的运行——这时宁可退回 legacy 并**响亮地说明**，
 *      也不去写别人的目录。（`unknown` 视为"不知道"，不参与比对：App 常常拿不到教师名，
 *      因为它不是"别人的运行"，只是"不知道自己是谁"。）
 *   ④ 什么都没有：legacy + 由身份信息拼出的 runId（单独跑某个脚本时的正常路径）。
 */
/** 造一个身份。`tier` 不知道就不写这个字段——写 `tier: undefined` 会让序列化结果里多一个空键，
 *  "有没有层级"这件事就变得要读两次才看得出来。 */
const identityOf = (layout: Layout, runId: string, teacher: string, tier?: string): RunIdentity => (tier ? { layout, runId, teacher, tier } : { layout, runId, teacher });

export function chooseIdentity(input: {
  want: { teacher?: string; tier?: string };
  explicitRunId?: string;
  scoped?: ManifestPointer | null;
  latest?: ManifestPointer | null;
  /** 没有清单时用的兜底运行 ID */
  fallbackRunId: string;
}): IdentityChoice {
  const { want } = input;
  const explicit = input.explicitRunId?.trim();
  if (explicit) {
    const hit = [input.scoped, input.latest].find((p) => p?.runId === explicit);
    if (hit) return { identity: identityOf(hit.layout, hit.runId, hit.teacher, hit.tier), source: '显式指定' };
    return {
      identity: identityOf('run', explicit, want.teacher ?? 'unknown', want.tier),
      source: '显式指定',
      warning: `清单里没有这次运行（${explicit}）——按它解析路径，产物会落到只有它自己的目录里`,
    };
  }
  if (input.scoped) {
    const p = input.scoped;
    return { identity: identityOf(p.layout, p.runId, p.teacher, p.tier ?? want.tier), source: '按教师分片' };
  }
  const latest = input.latest;
  if (latest) {
    const wt = knownTeacher(want.teacher);
    const mismatch: string[] = [];
    if (wt && knownTeacher(latest.teacher) && wt !== knownTeacher(latest.teacher)) {
      mismatch.push(`教师对不上（这份清单属于「${latest.teacher}」，而我是「${want.teacher}」）`);
    }
    if (want.tier && latest.tier && want.tier !== latest.tier) {
      mismatch.push(`层级对不上（这份清单是「${latest.tier}」，而我要「${want.tier}」）`);
    }
    if (mismatch.length) {
      return {
        identity: identityOf('legacy', input.fallbackRunId, want.teacher ?? 'unknown', want.tier),
        source: '无清单（legacy）',
        warning:
          `「清单_最新.json」指向的不是我这次运行：${mismatch.join('；')}。` +
          `已退回 legacy 布局（不去写别人的运行目录）。` +
          `并发跑同一本书时请显式指定身份：--run <runId> 或 LAYERTEXT_RUN=<runId>。`,
      };
    }
    return { identity: identityOf(latest.layout, latest.runId, latest.teacher, latest.tier ?? want.tier), source: '最近一次' };
  }
  return { identity: identityOf('legacy', input.fallbackRunId, want.teacher ?? 'unknown', want.tier), source: '无清单（legacy）' };
}

/** 指针里记的 `updatedAt` 比较用：解析不出来当 0（排序时沉底，不抛） */
const tsOf = (p: ManifestPointer): number => {
  const t = Date.parse(p.updatedAt ?? '');
  return Number.isFinite(t) ? t : 0;
};

/** 多份指针里"最近一次"（给 `清单_最新.json` 与报表用）。同一时刻按 runId 定序，保证可复现。 */
export const latestOf = (pointers: ManifestPointer[]): ManifestPointer | null => (pointers.length ? [...pointers].sort((a, b) => tsOf(b) - tsOf(a) || (a.runId < b.runId ? 1 : -1))[0]! : null);
