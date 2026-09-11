// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，本仓库已部署版权验证体系，细节不予公开（docs/版权与授权.md）。
/**
 * LayerText · 发布包与溯源（export / import / provenance）
 *
 * 来源：《LayerText 工程优化总计划》阶段 3 ——
 *   「Import/export 通过 manifest」「文件产物存对象目录，SQLite 存索引和事件」
 *   「学生数据仍只在本机工作区，**发布包默认不含画像、成绩和个人信息**」
 * 阶段 3 验收 ——
 *   「任意发布文件可查询『**由哪次运行、哪个模型、哪版词库生成，谁在何时做了哪条决定**』」
 *
 * ── 这一层为什么不能省 ──────────────────────────────────────────────────
 * `RunManifest` 里其实**已经有** runId / model / lexicon.version / createdAt
 * （`src/core/manifest.ts`），决定事件里也已经有 teacherId / timestamp / ruleIds。
 * 缺的不是数据，是**把这两本账合起来回答一个具体问题**的那一步：
 *   给定一个发布文件（或一段正文），它是哪一次运行、哪个模型、哪一版词库生成的，
 *   之后谁在什么时候对它做了哪一条决定。
 * 没有一个唯一的查询入口，每个人就会自己拼一遍，而那些拼法迟早会漂移。
 *
 * ── "发布包默认不含学生数据"要落成代码，不是落成一句承诺 ────────────────
 * 本模块用**白名单 + 黑名单 + 显式排除清单**三件事一起做：
 *   ① 白名单：只有列进 `PUBLISHABLE_KINDS` 的产物种类才可能进包；
 *   ② 黑名单：路径/文件名命中 `STUDENT_DATA_PATTERNS` 的一律排除
 *      （画像、成绩、分层、名单、学号、班级名册…）；
 *   ③ **排除项要列出来并说明原因**——静默丢弃和静默收录一样危险：
 *      前者让人以为包是完整的，后者才是数据事故。
 *
 * 纯逻辑：不读文件、不写文件。文件由调用方读进来（IO 在 `tools/` 与 App 两侧各不相同）。
 */

import { artifactIdOf, artifactLabelOf, contentHash, type ArtifactIdentity, type ArtifactKind, type RunArtifact, type RunManifest } from './manifest.js';
import type { DecisionEvent } from './decision.js';

export const BUNDLE_SCHEMA_VERSION = 1;

/* ────────────────────── 什么能进发布包 ────────────────────── */

/**
 * **可以给别人看的产物种类**（白名单）。
 *
 * 为什么是白名单而不是黑名单：黑名单的前提是"我知道所有不该出包的东西长什么样"，
 * 而学生数据的形式会变（今天叫 `分层_九3九4.json`，明天可能叫别的）。
 * 白名单的前提弱得多、也更站得住：**没被明确允许的，都不出去**。
 * 黑名单仍然保留（见 `STUDENT_DATA_PATTERNS`），它挡的是"白名单种类里混进了学生数据"
 * 这种更隐蔽的情形——比如某份台账里贴了班级成绩。
 */
export const PUBLISHABLE_KINDS: ArtifactKind[] = ['学生版', '正文', '报告', '台账', '风险队列', '清单', '其他'];

/**
 * **学生数据**的迹象。命中即排除，无论它的产物种类在白名单里多么无辜。
 *
 * 项目里有这些真实存在的东西（`docs/数据红线与使用者须知.md`）：
 *   分层正本（`分层_九3九4.json`）、班级画像、成绩、学号、名册。
 * 它们**只该留在本机工作区**，一旦跟着发布包出去，就是一起真实的数据事故。
 */
export const STUDENT_DATA_PATTERNS: { pattern: RegExp; what: string }[] = [
  { pattern: /画像/, what: '学生画像' },
  { pattern: /成绩|分数|得分|统练|月考|期中|期末/, what: '成绩数据' },
  /* 「分层」这个词本身是产品术语（分层读），不能见着就拦——`分层阅读说明.md` 是正经文档。
   * 要拦的是它**作为数据文件**的样子：后面跟分隔符、扩展名，或直接跟正本/名单这类词。 */
  { pattern: /分层(正本|名单|表)|分层[_\-.／/]/, what: '分层名单（按成绩给学生分档）' },
  { pattern: /学号|名册|名单|花名册/, what: '学生名单' },
  { pattern: /班级画像|个体画像|学习档案/, what: '个人学习档案' },
  { pattern: /\.xlsx?$/i, what: '电子表格（成绩/名册最常见的载体，默认不出包）' },
];

/** 命中学生数据迹象时给出原因（给"排除清单"用；没命中返回 null） */
export function studentDataReason(path: string): string | null {
  for (const { pattern, what } of STUDENT_DATA_PATTERNS) {
    if (pattern.test(path)) return `疑似${what}（命中 ${String(pattern)}）——学生数据只留在本机工作区`;
  }
  return null;
}

/* ────────────────────── 包 ────────────────────── */

export interface BundleEntry {
  /** 包内相对路径 —— 一件产物**在包里的位置** */
  path: string;
  /** **产物身份**（`art-…`，见 `manifest.ts` 的「产物身份」一节）：这一件"是什么"。
   *  阶段 3 要 Run/Artifact/Decision/Teacher 四类实体有稳定 ID，它就是 Artifact 的那一个。
   *
   *  为什么包里既要路径又要身份：核对一份包是**按文件树**做的（缺件/多件/哈希），
   *  那件事只有路径能回答；而"缺的这一件是哪一件产物"只有身份能回答——
   *  路径本来就写在包里，可它说明的只是"它现在放在哪儿"。
   *  旧版本的包描述没有这个字段：读的时候按 `kind/层级/章节` 算得出来（`artifactIdOf`），
   *  所以它**是附加信息，不是兼容性断层**。
   */
  id?: string;
  kind: ArtifactKind | '决定日志' | '版本日志';
  tier?: string;
  chapter?: string;
  bytes: number;
  hash: string;
  /** 派生关系（学生版这类"从另一件产物减出来的"）——原样随清单登记进包。
   *  收件人据此回答"这份读物是从哪份工作稿、按哪版规则减出来的"（第七轮 P1-⑥）。 */
  derivedFrom?: RunArtifact['derivedFrom'];
}

export interface ExcludedEntry {
  path: string;
  /** 为什么没进包（**必须能读得懂**，这是"默认不含学生数据"唯一的证据） */
  reason: string;
}

/**
 * 发布包描述。**它是用来"验证收到了什么"的**，不是用来搬运内容的：
 * 内容由调用方自己搬，包描述负责回答"这份包该有哪些文件、每个文件的哈希是多少"。
 * 于是收件人拿到包之后可以逐件核对，而不是只能相信文件名。
 */
export interface PublishBundle {
  schemaVersion: number;
  /** 由哪次运行生成 */
  run: {
    runId: string;
    book: string;
    version: string;
    tiers: string[];
    chapters: number[];
    /** 未写完的章（清单显式声明过 partial 且本次发布**显式放行**了才写在这里）——
     *  收件人必须看得见"这份包里有还没写完的章"（第七轮 P2）。 */
    partialChapters?: number[];
    createdAt: string;
    layout: string;
  };
  /** 哪个模型、哪一版提示词 */
  model: { name: string; temperature: number; promptVersion: string };
  /** 哪版词库（内容哈希派生的版本 + 它的来源清单） */
  lexicon: { version: string; snapshotPath: string; warnings: string[] };
  /** 谁 */
  teacher: string;
  entries: BundleEntry[];
  /** 被排除的（含原因）。**空数组也要在**——"什么都没排除"和"没做排除"是两件事 */
  excluded: ExcludedEntry[];
  /** 决定日志与版本日志**条数**（内容不进包：它们含教师 ID 与逐条操作，属审计材料） */
  decisionCount: number;
  versionCount: number;
  createdAt: string;
}

/**
 * 发布前的最后一关：**没有这几样东西的产物不许发布**。
 *
 * 纪律第 4 条原文：「所有 AI 响应保存 prompt 版本、policy snapshot、模型和 traceId；
 * **没有这些字段的产物不可发布**。」
 *
 * 注意这半句是**强制**的，不是"建议补上"。一个不知道由哪个模型、哪版提示词、
 * 哪版词库生成的产物，发出去之后**没有任何办法**回答"这句话怎么变成现在这样的"——
 * 而它是要给学生读、给另一位老师用的东西。所以这里的选择是"不发"，
 * 而不是"发出去但在描述里留个空字段"。
 *
 * 为什么这一关放在发布包上，而不是放在每一次 AI 调用上：
 * 调用那一层已经在记（`会话改写.mjs` 的每条 `done`/`review` 记录带
 * `promptVersion` / `model` / `inputHash` / `traceId` / `lexiconVersion`）；
 * 而"能不能出去"是一个**发布**决定，落点就该是发布这一步。
 */
export interface PublishReadiness {
  ok: boolean;
  /** 缺了什么（空数组 = 齐备）。**列出来**，不要只说"不允许发布" */
  problems: string[];
}

export function publishReadiness(manifest: RunManifest): PublishReadiness {
  const problems: string[] = [];
  const need = (v: unknown, what: string): void => {
    if (typeof v !== 'string' || !v.trim()) problems.push(what);
  };
  need(manifest.runId, '运行 ID（runId）—— 没有它就答不了"这是哪次运行"');
  need(manifest.teacher, '教师（teacher）—— 没有它就答不了"谁做的决定"');
  need(manifest.model?.name, '模型名（model.name）');
  need(manifest.model?.promptVersion, '提示词版本（model.promptVersion）—— 模型换了说法会变，不记就复现不了');
  need(manifest.lexicon?.version, '词库版本（lexicon.version）—— 即 policy snapshot；词表变了判定就变了');
  need(manifest.lexicon?.snapshotPath, '词库快照路径（lexicon.snapshotPath）');
  if (!manifest.inputs?.length) problems.push('输入哈希（inputs）—— 没有它，"同样的输入"这句话无法验证');
  if (!manifest.artifacts?.length) problems.push('产物清单（artifacts）为空 —— 没有东西可发');
  return { ok: problems.length === 0, problems };
}

export interface BundleInput {
  manifest: RunManifest;
  /** 待入包的文件（路径相对产物目录 + 内容 + **产物身份**） */
  files: { path: string; id?: string; kind: ArtifactKind; tier?: string; chapter?: string; derivedFrom?: RunArtifact['derivedFrom']; text: string }[];
  /** 决定事件（只数条数，不进包内容） */
  events?: DecisionEvent[];
  /** 版本节点（只数条数） */
  versionNodes?: number;
  /** 未写完的章（调用方已确认放行）；进包描述让收件人看得见 */
  partialChapters?: number[];
  /** 生成时间（便于测试确定性） */
  now?: string;
}

/**
 * 造一个发布包描述。
 *
 * **只收录 `PUBLISHABLE_KINDS` 里的产物，且逐件过学生数据检查。**
 * 被排除的每一件都记进 `excluded` 并写清原因——静默丢弃让人以为包是完整的，
 * 而那正是"发布包默认不含学生数据"这句话最容易失效的地方。
 */
export function buildBundle(input: BundleInput): PublishBundle {
  /* ★ 先过关再打包。**抛**而不是"打个标记继续"：
   * 纪律第 4 条说的是"不可发布"，不是"可以发布但要标注"。 */
  const ready = publishReadiness(input.manifest);
  if (!ready.ok) {
    throw new Error(`产物缺少发布必需的字段，**不可发布**：\n  · ${ready.problems.join('\n  · ')}`);
  }
  const entries: BundleEntry[] = [];
  const excluded: ExcludedEntry[] = [];
  const allowed = new Set<string>(PUBLISHABLE_KINDS);

  for (const f of input.files) {
    const student = studentDataReason(f.path);
    if (student) {
      excluded.push({ path: f.path, reason: student });
      continue;
    }
    if (!allowed.has(f.kind)) {
      excluded.push({ path: f.path, reason: `产物种类「${f.kind}」不在发布白名单里（${PUBLISHABLE_KINDS.join('/')}）` });
      continue;
    }
    /* 没值的字段**不写上去**，而不是写成 undefined：
     * 包描述要能 JSON 存盘再读回来，而 `undefined` 过一趟 JSON 就没了——
     * 于是一份包"存盘前"和"读回来后"形状不同，任何 deepEqual 都会莫名其妙地失败。 */
    const entry: BundleEntry = { path: f.path, kind: f.kind, bytes: f.text.length, hash: contentHash(f.text) };
    /* 身份：条目自己带的优先（它来自清单里那条登记），没有就按 `kind/层级/章节` 算。
     * 两条路得到的是同一个值——身份是算出来的，不是发出来的。 */
    const id = f.id || artifactIdOf(f);
    if (id) entry.id = id;
    if (f.tier) entry.tier = f.tier;
    if (f.chapter) entry.chapter = f.chapter;
    if (f.derivedFrom) entry.derivedFrom = f.derivedFrom;
    entries.push(entry);
  }

  return {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    run: {
      runId: input.manifest.runId,
      book: input.manifest.book,
      version: input.manifest.version,
      tiers: [...input.manifest.tiers],
      chapters: [...input.manifest.chapters],
      /* undefined 键 JSON.stringify 会丢——只在真有 partial 章时才写（与 entries 的字段同一纪律） */
      ...(input.partialChapters?.length ? { partialChapters: [...input.partialChapters] } : {}),
      createdAt: input.manifest.createdAt,
      layout: input.manifest.layout,
    },
    model: { ...input.manifest.model },
    lexicon: {
      version: input.manifest.lexicon.version,
      snapshotPath: input.manifest.lexicon.snapshotPath,
      warnings: [...input.manifest.lexicon.warnings],
    },
    teacher: input.manifest.teacher,
    entries,
    excluded,
    decisionCount: input.events?.length ?? 0,
    versionCount: input.versionNodes ?? 0,
    createdAt: input.now ?? new Date().toISOString(),
  };
}

/* ────────────────────── 导入时的核对 ────────────────────── */

export interface BundleProblem {
  kind: 'missing' | 'hash-mismatch' | 'extra' | 'student-data' | 'id-mismatch';
  path: string;
  /** 出问题的**是哪一件产物**（`art-…`）。夹带的文件没有身份——它本来就不在清单里 */
  id?: string;
  /** 人读的身份（`正文｜A层85｜第一章`），给报告与命令行用 */
  artifact?: string;
  message: string;
}

export interface BundleVerifyResult {
  ok: boolean;
  problems: BundleProblem[];
  /** 核对通过了几件 */
  checked: number;
}

/**
 * 出问题时说清"这是哪一件产物"。
 *
 * 路径相同不等于同一件东西（两次运行各写一份同名文件就是两条不同的账），
 * 反过来同一件产物换个路径仍然是它——所以核对时**按路径查文件树**（那是事实），
 * 报问题时**按身份说是哪一件**（那才是人能拿去做决定的信息）。
 * 退化身份（只有路径、没有 `kind`）时不重复一遍路径：那串路径就在同一行里写着。
 */
function artifactNote(e: ArtifactIdentity): string {
  const id = artifactIdOf(e);
  if (!id) return '';
  const label = artifactLabelOf(e);
  return label === e.path ? '' : `｜产物身份：${label}`;
}

/**
 * 收到包之后逐件核对：**该有的都在、内容哈希对得上、没有夹带学生数据**。
 *
 * 第三条是关键：如果包描述说排除了一件画像文件，而对方手里那份包里**有**它，
 * 或者对方把画像文件改了个名字塞进来，这里要能发现——
 * 否则"默认不含学生数据"就只是对本方成立，对收到的包不成立。
 *
 * 第四条是本轮加的：**包描述里的身份必须与它自己的字段自洽**（见 `id-mismatch`）。
 * 身份是算出来的，所以它要么没有、要么算得出同一个值；算不出同一个值，说明这份描述
 * 被人（或别的程序）改过，那它关于"这件产物是什么"的说法就一个字都不能信。
 * 没有这一条，一个手艺好的裁剪者可以把 A 层的正文标成 B 层的正文而核对照过。
 */
export function verifyBundle(bundle: PublishBundle, received: { path: string; text: string }[]): BundleVerifyResult {
  const problems: BundleProblem[] = [];
  const got = new Map(received.map((r) => [r.path, r.text]));
  let checked = 0;

  for (const e of bundle.entries) {
    /* 身份：条目自带优先，没有就按字段算（旧版本的包描述没有 `id` 字段，
     * 于是"收到的包"与"新写的包"在这一点上完全一样——不靠升级才认得出来）。 */
    const id = e.id || artifactIdOf(e);
    /* 自洽性只在这一件说得出自己是什么（有 kind）时才查：
     * 说不出 `kind` 的登记项，身份本来就是它的路径，没有第二个来源可以对。 */
    if (e.id && e.kind && e.id !== artifactIdOf(e)) {
      problems.push({
        kind: 'id-mismatch',
        path: e.path,
        id: e.id,
        artifact: artifactLabelOf(e),
        message: `包描述里的产物身份与它自己的字段对不上（写的是 ${e.id}，按 ${artifactLabelOf(e)} 算出来是 ${artifactIdOf(e)}）——这份描述被改过，"这是哪一件产物"的说法不可信`,
      });
    }
    const note = artifactNote(e);
    const text = got.get(e.path);
    if (text === undefined) {
      problems.push({ kind: 'missing', path: e.path, id: id || undefined, artifact: artifactLabelOf(e), message: `包里缺这一件（清单说有 ${e.bytes} 字节）${note}` });
      continue;
    }
    const h = contentHash(text);
    if (h !== e.hash) {
      problems.push({ kind: 'hash-mismatch', path: e.path, id: id || undefined, artifact: artifactLabelOf(e), message: `内容与清单不符（清单 ${e.hash}，实得 ${h}）${note}` });
      continue;
    }
    checked++;
  }

  const declared = new Set(bundle.entries.map((e) => e.path));
  for (const r of received) {
    // 夹带学生数据：**换名字也要认出来**（按内容与文件名双重判断）
    const byName = studentDataReason(r.path);
    if (byName) {
      problems.push({ kind: 'student-data', path: r.path, message: `收到的包里有不该出包的东西：${byName}` });
      continue;
    }
    if (!declared.has(r.path)) {
      problems.push({ kind: 'extra', path: r.path, message: '清单里没有这一件（夹带或清单过期）' });
    }
  }

  return { ok: problems.length === 0, problems, checked };
}

/* ────────────────────── 溯源 ────────────────────── */

/** 一条决定的"是谁在何时做了什么"（人读一行） */
export interface ProvenanceRow {
  at: string;
  teacher: string;
  decision: string;
  ruleIds: string[];
  before: string;
  after: string;
  reason: string;
  /** 这条决定产生的版本（有的话） */
  version?: string;
  /** 这条是撤销某条（有的话） */
  undoOf?: string;
  /** 这一条是"系统没做成"的留痕，不是教师的判断 */
  failed: boolean;
}

/**
 * 溯源链：**任意发布文件** → 由哪次运行、哪个模型、哪版词库生成 + 之后谁做了哪条决定。
 *
 * 这是阶段 3 验收那句「任意发布文件可查询『由哪次运行、哪个模型、哪版词库生成，
 * 谁在何时做了哪条决定』」的落点。它回答的顺序刻意是"先讲这份文件是谁生成的，
 * 再讲它之后被改过什么"——因为教师真正会问的是
 * 「这句话怎么是现在这个样子」，而不是「系统里有哪些决定」。
 */
export interface Provenance {
  path: string;
  /** 它是**哪一件产物**（`art-…`）。查一份文件的出处时，先说清"这是什么东西"再说它怎么来的 */
  artifactId?: string;
  /** 找不到出处时如实说找不到，**不编一个** */
  found: boolean;
  runId?: string;
  book?: string;
  /** 哪个模型、哪一版提示词 */
  model?: string;
  promptVersion?: string;
  /** 哪版词库 */
  lexiconVersion?: string;
  /** 生成时间与当时的教师 */
  createdAt?: string;
  teacher?: string;
  /** 这份文件当前的内容是不是就是清单登记的那一版（被改过的话这里为 false） */
  hashMatches: boolean;
  /** 之后针对它（或其所在章）的决定，时间序 */
  decisions: ProvenanceRow[];
  /** 一句人读的话 */
  line: string;
}

/** 一条决定的展示名（`accept` → `采纳`），供溯源行使用 */
const DECISION_ZH: Record<string, string> = {
  accept: '采纳',
  reject: '退回重写',
  'false-positive': '标记误报',
  edit: '直改',
  rejected: '执行失败（未改稿）',
  undo: '撤销',
};

export function decisionRow(e: DecisionEvent): ProvenanceRow {
  return {
    at: e.timestamp,
    teacher: e.teacherId,
    decision: DECISION_ZH[e.decision] ?? e.decision,
    ruleIds: [...(e.ruleIds ?? [])],
    before: e.before,
    after: e.after,
    reason: e.reason,
    version: e.version,
    undoOf: e.undoOf,
    failed: e.decision === 'rejected',
  };
}

/**
 * 查一份发布文件的出处。
 *
 * @param bundle   发布包描述（有它才知道是哪次运行）
 * @param manifest 运行清单（有它才知道模型与词库版本）
 * @param events   决定事件（有它才知道谁改过）
 * @param q        要查的文件：相对路径（进清单）或章节名（看这一章的决定）
 */
export function provenanceOf(input: {
  path: string;
  currentText?: string;
  bundle?: PublishBundle | null;
  manifest?: RunManifest | null;
  events?: DecisionEvent[];
  /** 只算与这份文件有关的决定（按章过滤）；不给就取全部 */
  chapter?: string;
}): Provenance {
  const m = input.manifest ?? null;
  const b = input.bundle ?? null;
  const entry = b?.entries.find((e) => e.path === input.path) ?? m?.artifacts.find((a) => a.path === input.path);

  const runId = b?.run.runId ?? m?.runId;
  const model = m?.model.name ?? b?.model.name;
  const promptVersion = m?.model.promptVersion ?? b?.model.promptVersion;
  const lexiconVersion = m?.lexicon.version ?? b?.lexicon.version;
  const teacher = m?.teacher ?? b?.teacher;

  /* 哈希核对只在这一件**登记过**且我们拿得到当前内容时做。
   * 拿不到就说"没核对"，而不是说"对得上"——后者是编的。 */
  const declaredHash = 'hash' in (entry ?? {}) ? (entry as { hash?: string }).hash : undefined;
  const hashMatches = !!(declaredHash && input.currentText !== undefined && contentHash(input.currentText) === declaredHash);

  const all = input.events ?? [];
  const rows = all
    .filter((e) => (input.chapter ? e.chapter === input.chapter : true))
    .sort((a, b2) => (a.timestamp < b2.timestamp ? -1 : a.timestamp > b2.timestamp ? 1 : 0))
    .map(decisionRow);

  const found = !!(entry || rows.length);
  /* 说得出身份就带上：决定是挂在**产物**上的，不是挂在路径上的——
   * 一份文件被搬到别处之后，"这句话怎么变成现在这样的"要能顺着身份接回去。 */
  const artifactId = entry ? artifactIdOf(entry) || undefined : undefined;
  const bits: string[] = [];
  if (found) {
    bits.push(`${input.path}`);
    if (entry) {
      const label = artifactLabelOf(entry);
      if (label !== input.path) bits.push(`产物 ${label}`);
    }
    if (runId) bits.push(`由运行 ${runId} 生成`);
    if (model) bits.push(`模型 ${model}${promptVersion ? `（提示词 ${promptVersion}）` : ''}`);
    if (lexiconVersion) bits.push(`词库 ${lexiconVersion}`);
    if (teacher) bits.push(`教师 ${teacher}`);
    if (m?.createdAt) bits.push(m.createdAt);
    if (declaredHash) bits.push(hashMatches ? '内容与清单一致' : input.currentText === undefined ? '（当前内容未提供，未核对哈希）' : '⚠ 内容已与清单不符（被改过）');
    bits.push(rows.length ? `之后有 ${rows.length} 条决定` : '之后没有任何决定');
  } else {
    bits.push(`${input.path}：清单与决定日志里都查不到它——**不编一个出处**，如实说查不到`);
  }

  return {
    path: input.path,
    artifactId,
    found,
    runId,
    book: m?.book ?? b?.run.book,
    model,
    promptVersion,
    lexiconVersion,
    createdAt: m?.createdAt ?? b?.run.createdAt,
    teacher,
    hashMatches,
    decisions: rows,
    line: bits.join('｜'),
  };
}

/**
 * 把溯源渲染成一段人读的报告（进复核报告与发布说明）。
 * `failed` 的行标出来：**"系统没做成"不是教师的判断**，混在一起看会误读教师的行为。
 */
export function renderProvenance(p: Provenance): string[] {
  const L = [p.line, ''];
  if (!p.decisions.length) return L;
  L.push('| 时间 | 教师 | 决定 | 规则 | 改动 | 说明 |', '|---|---|---|---|---|---|');
  for (const d of p.decisions) {
    const change = d.before || d.after ? `${d.before || '—'} → ${d.after || '—'}` : '（不改正文）';
    L.push(`| ${d.at} | ${d.teacher} | ${d.failed ? `⚠ ${d.decision}` : d.decision} | ${d.ruleIds.join('/') || '—'} | ${change} | ${d.reason} |`);
  }
  return L;
}
