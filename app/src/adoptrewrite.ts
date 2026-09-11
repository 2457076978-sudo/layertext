/**
 * App 侧「采纳一句改写」——走引擎里**唯一那个写正文的事务**
 *
 * 来源：《LayerText 工程优化总计划》阶段 1 ——
 *   「App 和管线继续共享 `RewriteRequest/RewriteResult`……风险组、**单句建议**和确定性补注
 *     全部走同一个 `applyChange` 事务；事务写入 draft version、decision event、audit row，
 *     失败显示可行动原因并保持原卡片。」
 *   验收：「新教师在没有读文档的情况下完成『打开项目 → 采纳一条建议 → 撤销 → 再发布一段』」
 *        「**任何门禁失败均不改变正文**」「所有发布段可由 `sourceVersion + traceId` 重放」
 * 以及 v4 报告点名的残余 P0：
 *   「App 单句改写当前只调用 `buildSystemPrompt`，随后只运行 `checkRev`，没有词表、词典、
 *     专名和事实检查。」
 *
 * ── 这里补的是哪一环 ────────────────────────────────────────────────────
 * `app/src/rewritegate.ts` 已经把门禁接上了（`checkRewrite` 判定候选句），
 * 但**判定发生的时刻**与**写正文发生的时刻**不是同一刻：判定在"生成候选"时，
 * 写入在教师按下「✓ 采纳」时。中间教师可能改了别处、别的窗口可能改了同一章。
 * 所以旧路径上有两个口子：
 *   ① 采纳时不复判——门禁说"过"的那一刻的判断被当成了永远成立；
 *   ② 采纳时直接 `persistEdit(s.md)` **整份覆盖**，没有 `baseVersion`、没有版本节点。
 * 本模块把这两件事一起封掉：**采纳 = 一次 `applyChange` 事务**，门禁作为它的闸，
 * `baseVersion` 作为它的并发校验。
 *
 * 纯逻辑 + 注入 IO：Node 下可直接测，不必启动 App（与 `app/src/risk.ts` 同一套路）。
 */

import { contentHash } from '../../src/core/manifest.js';
import { makeResolver, tierTagOf, type Layout } from '../../src/core/manifest.js';
import { parseVersionLog, currentVersionOf, applyChange, type ChangeGuard, type ChangeResult, type TxIo } from '../../src/core/version.js';
import { REWRITE_ACTION } from '../../src/core/riskaction.js';
import type { RewriteResult } from '../../src/core/rewrite.js';

/** 采纳一句改写要用到的一切。**没有 `baseVersion` 就没有写入**——这是刻意的。 */
export interface AdoptRewriteInput {
  /** 会话里当前的整份正文（可能还没落盘） */
  sessionText: string;
  /** 正文文件绝对路径。为空 = 这份稿还没落过盘，此时**拒绝采纳**并说明为什么 */
  sourcePath: string | null;
  /** 段落序号（0 起），来自 `resolveSuggestionTarget` 的 `pi` */
  pi: number;
  /** 原句（精确定位用；不是"大概这一句"） */
  original: string;
  /** 候选句 */
  revised: string;
  /** 决定主体的稳定 ID（标记 ID 或 `句子@P07`）。事件靠它回答"这条决定是关于什么的" */
  itemId: string;
  /** 门禁判定结果（`checkRewrite` 的返回值）。**null = 门禁没跑成，一律不写正文** */
  verdict: RewriteResult | null;
  /** 调适项目配置（`产物目录` / `调适工作区` / `书级.词典`） */
  config: Record<string, unknown> | null;
  teacherId: string;
  /** 层级标签（`A层85` 等）。App 侧早已停用分层，这里只用于定位产物 */
  tier: string;
  /** 产出该候选的提示词版本与模型（进事件，回答"这条是谁写的"） */
  promptVersion?: string;
}

export interface AdoptPaths {
  outDir: string;
  workDir: string;
  layout: Layout;
  runId: string;
  versionPath: string;
  decisionPath: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** 从调适项目配置 + 清单指针解析出**全部**路径。App 侧不许自己拼目录（阶段 3 的硬约束）。 */
export async function adoptPathsFor(io: TxIo, input: { sourcePath: string; config: Record<string, unknown> | null; tier: string }): Promise<AdoptPaths | null> {
  const cfg = input.config ?? {};
  const outDir = str(cfg['产物目录']);
  const workDir = str(cfg['调适工作区']);
  if (!outDir || !workDir) return null;
  // 与面板/命令行同一条规则取运行身份；读不到就 legacy + 空 runId
  let layout: Layout = 'legacy';
  let runId = '';
  try {
    const ptr = JSON.parse(await io.read(`${outDir}/_运行/清单_最新.json`)) as { path?: string };
    if (ptr.path) {
      const m = JSON.parse(await io.read(ptr.path)) as { layout?: Layout; runId?: string };
      layout = m.layout ?? 'legacy';
      runId = m.runId ?? '';
    }
  } catch {
    /* 有意兜底：还没有清单＝老项目（legacy 布局）——这是正常路径，不是错误。 */
  }
  // 层级标签走**同一个**映射（定义在 src/core/manifest.ts）——
  // 自己再写一份 `A → A层85`，版本日志就会落到另一个文件里，两本账各说各话
  const R = makeResolver(layout, { out: outDir, work: workDir }, { runId, tier: tierTagOf(input.tier) });
  return { outDir, workDir, layout, runId, versionPath: R.version(), decisionPath: R.decision() };
}

/**
 * 门禁 → 事务闸。
 *
 * 三态在这里第一次被用在同一处：
 *   · 门禁没过（`blocked`）→ 闸不放行，**正文一个字符都不动**，只显示候选与原因；
 *   · 门禁没跑成（`null`）→ 同样不放行。**"检查出错"绝不允许变成"放行"**——
 *     旧代码在这条上是做对的（`app/src/aiflow.ts` 的 catch 分支），这里把它固化成断言。
 *   · 过了（`candidate`）→ 放行，事务接着管写入与记账。
 */
export function guardFromRewrite(v: RewriteResult | null): ChangeGuard {
  return () => {
    if (!v) {
      return { ok: false, reason: '改写门禁未能运行（本地检查出错）——本条不直写正文，只进建议页' };
    }
    if (v.status === 'blocked') {
      return { ok: false, reason: `未通过门禁：${v.blockedReasons.join('；') || '（门禁未给出原因）'}` };
    }
    return { ok: true };
  };
}

/** 段号：`pi`（0 起）→ `P07`。与 `segIdOf`/管线同一套编号规则。 */
export const segIdOfIndex = (pi: number): string => `P${String(pi + 1).padStart(2, '0')}`;

/** 结果 → 界面文案。失败永远是"可行动的"：说清楚发生了什么、正文有没有变。 */
export function adoptMessage(r: ChangeResult): { ok: boolean; text: string } {
  if (r.status === 'applied') return { ok: true, text: `✓ 已写入正文（版本 ${r.version}）｜${r.message}` };
  if (r.docTouched) {
    // 唯一一种正文可能已经变了的情形，必须说得比别的失败更响
    return { ok: false, text: `⚠ ${r.reason}。请立刻核对正文——这一处**没有**记为已采纳。` };
  }
  return { ok: false, text: `未写入正文：${r.reason}` };
}

/**
 * 采纳一句改写。
 *
 * 与旧路径（`acceptSuggestion` 里 `persistEdit(s.md)` 整份覆盖）的三处实质差别：
 *
 * ① **盘上的正文必须与会话里的一致**。不一致说明会话里有别处未保存的改动，
 *    或者别的窗口改过同一章；这时"按会话内容写回去"会顺手覆盖掉别人的改动。
 *    宁可让教师先保存，也不做一件说不清后果的事。
 * ② **门禁在写入这一刻复判**（`guardFromRewrite`）。判定与写入之间隔了多久没人知道。
 * ③ **写入带 `baseVersion`，并留下版本节点与决定事件**（两本账互为外键）。
 *    于是"这一段现在是什么样子、是怎么来的"可回答；`sourceVersion + traceId` 可重放。
 */
export async function adoptRewrite(io: TxIo, input: AdoptRewriteInput): Promise<ChangeResult> {
  const empty = { applied: 0, rejected: 0, rejectedItems: [] as { itemId: string; reason: string }[] };
  const reject = (reason: string, kind: 'not-found' | 'unsupported' | 'stale' = 'unsupported'): ChangeResult => ({
    status: 'rejected',
    reason,
    kind,
    docTouched: false,
    ...empty,
  });

  if (!input.sourcePath) {
    return reject('这份稿还没保存到文件——先「另存」一次再采纳，否则这条改动无法留下版本与追溯记录');
  }
  if (!input.original || !input.revised) return reject('候选句缺原文或候选，无法定位');
  if (input.original === input.revised) return reject('候选与原文一字不差，没有可写的东西');

  const paths = await adoptPathsFor(io, { sourcePath: input.sourcePath, config: input.config, tier: input.tier });
  if (!paths) {
    return reject('这本书还没有调适项目配置（缺 产物目录 / 调适工作区）——没有它就没有版本与追溯的去处');
  }

  let doc: string;
  try {
    doc = await io.read(input.sourcePath);
  } catch {
    return reject(`读不到正文（${input.sourcePath}）`, 'not-found');
  }

  /* ① 会话与盘上必须一致。不一致时**不写**：
   * 按会话内容覆盖会连带覆盖别人的改动，按盘上内容写又会丢掉会话里未保存的编辑——
   * 两条路都在做一个说不清后果的决定，所以不做。 */
  if (contentHash(doc) !== contentHash(input.sessionText)) {
    return reject('正文在编辑器里有未保存的改动（或已被别处改过）。先保存，再采纳这一条', 'stale');
  }

  /* 有意兜底：版本日志还没有＝这本书还没改过（缺失文件本来就是报错的），
   * baseVersion 于是按当前正文自身算；真与账本对不上时 applyChange 会拒绝并记 rejected。 */
  const nodes = parseVersionLog(await io.read(paths.versionPath).catch(() => '')).nodes;
  const segId = segIdOfIndex(input.pi);

  return await applyChange(
    io,
    {
      runId: paths.runId || `legacy-${input.tier}`,
      baseVersion: currentVersionOf(nodes, doc),
      target: {
        segId,
        chapter: chapterOf(doc),
        itemId: input.itemId,
        path: input.sourcePath,
        traceId: input.verdict?.traceId,
      },
      action: REWRITE_ACTION,
      from: input.original,
      to: input.revised,
      docPath: input.sourcePath,
      versionPath: paths.versionPath,
      decisionPath: paths.decisionPath,
      teacherId: input.teacherId,
      // 源版本用**正文内容哈希**，不是层级标签：层级标签回答不了"这条改动是对着哪一版底稿做的"
      sourceVersion: sourceVersionOf(doc, input.promptVersion),
      traceId: input.verdict?.traceId,
      decision: 'accept',
    },
    guardFromRewrite(input.verdict),
  );
}

/** 章节名（`## Chapter One` → `第一章` 这种没有，就退回首段标记所在的那一章名） */
export function chapterOf(doc: string): string {
  const m = /^##\s*Chapter\s+(\S+)/m.exec(doc);
  return m ? `Chapter ${m[1]}` : '';
}

/**
 * 产物版本标识：**正文的内容哈希**（可选带提示词版本）。
 *
 * 旧代码这里存的是层级标签（`A层85`），于是决定日志回答不了"这条改动是对着哪一版底稿做的"——
 * 一个季度后再看，`A层85` 指向的那份稿早被改过很多次了。
 */
export const sourceVersionOf = (doc: string, promptVersion?: string): string => (promptVersion ? `${contentHash(doc)}@${promptVersion}` : contentHash(doc));
