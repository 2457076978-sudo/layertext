/**
 * 资产类别化 + 读者层级树传播（Wayne 2026-09-13 拍板落地）
 *
 * 教师在**上级读者**确认的词级操作，按层级树自动传播到全部下级读者的文本：
 *   · annotate（加注/去标注/释义确认）→ 下级命中处**直接插/剥中文注释**（学生直接受益；
 *     可撤销——下级文件同款"去除标注"按钮随时可拆）；
 *   · rewrite（换词/简化）→ 只在应用层记录待办（下级正文不动：改写语境依赖强，机器
 *     跨层改写有风险，交下级读者文件的教师过目）；
 *   · review（句级/删除）→ 不传播（保持候选批准制）。
 *
 * 层级树放书的项目配置：`读者层级: { "A": ["M", "B"] }`（默认 A→[M,B]）。层级关系
 * 变更后由调用方全量重放（本模块提供 descendantsOf 与 applyWordAction 两个纯函数，
 * 文件枚举/写入由调用方做——引擎不做 IO）。
 *
 * **已接线**（2026-09-14 晚）：触发点是「加注中文」这个动作之后——
 * `app/src/pipew.ts` 的 `applyZhAnnotations` 跑完，会调 `offerPropagation()`：
 * 列出各下级层要改的文件与命中处数，**教师确认后**才写。
 * 两件当初待定的产品决定，现在定成这样：
 *   ① 触发点 = 「加注中文」之后**每次都问**（不自动写），「换词」类仍只待办、不动下级正文；
 *   ② 允许写哪些文件 = **只写同章目录下的 `原文_<下级层标签>_*.md`**（正文产物正本），
 *      备份/工作稿/标记文件都不在范围内；每次写之前留 `_原始备份.md` 并落变更日志。
 * 决策依据：Wayne 2026-09-14 明确"可以改正文，但每次都要教师确认"。
 */

/** 资产类别：决定传播策略 */
export type PropagationKind = 'annotate' | 'rewrite' | 'review';

/** 词面板操作 → 资产类别（传播策略）。
 *  zh/en=加注与英语释义、unanno=去除标注：标注类，自动插/剥；
 *  simpl=换词：只记录待办；句级（语法/删除等）不在词级传播范围。 */
export function propagationKindOf(op: 'zh' | 'en' | 'unanno' | 'simpl' | 'rewrite' | string): PropagationKind {
  if (op === 'zh' || op === 'en' || op === 'unanno') return 'annotate';
  if (op === 'simpl') return 'rewrite';
  return 'review';
}

/** 层级树：{ 上级: [直接下级...] }。缺省层=叶子。 */
export type ReaderTree = Readonly<Record<string, readonly string[]>>;

/** 默认树：A 上级，M/B 是它的下级（AF 项目现状；其他书可在项目配置覆盖） */
export const DEFAULT_READER_TREE: ReaderTree = { A: ['M', 'B'] };

/** 某层的全部下级（传递闭包，含环防护）。A→[M,B]、B→[C] 时 descendantsOf('A') = [M,B,C]。 */
export function descendantsOf(tree: ReaderTree, tier: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([tier]);
  const walk = (t: string): void => {
    for (const child of tree[t] ?? []) {
      if (seen.has(child)) continue; // 环防护
      seen.add(child);
      out.push(child);
      walk(child);
    }
  };
  walk(tier);
  return out;
}

/** 归一化树：非法形态（非对象/值为非字符串数组/自引用）回退默认树——配置损坏不炸传播 */
export function normalizeTree(raw: unknown): ReaderTree {
  if (!raw || typeof raw !== 'object') return DEFAULT_READER_TREE;
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k !== 'string' || !k.trim()) continue;
    if (!Array.isArray(v)) continue;
    const kids = v.filter((x): x is string => typeof x === 'string' && !!x.trim() && x !== k);
    if (kids.length) out[k.trim()] = kids;
  }
  return Object.keys(out).length ? out : DEFAULT_READER_TREE;
}

/** 词级动作对一段文本的**确定性**执行（引擎层纯函数；文件枚举/落盘由调用方做）。
 *  · 'annotate'：在该段首次出现处插 `word（zh）`——词边界、跳标题行、已带同注跳过（幂等）；
 *  · 'unanno'：剥掉该段全部 `word（…）`（保留英文原词，大小写按原文）；
 *  · 'rewrite'：规划层不碰文本（调用方记待办）。 */
export function applyWordActionToText(text: string, word: string, action: 'annotate' | 'unanno', zh?: string): { text: string; changed: boolean } {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (action === 'unanno') {
    const re = new RegExp(`\\b${esc}（[^）]*）`, 'gi');
    let changed = false;
    const out = text.replace(re, (m) => {
      changed = true;
      return m.slice(0, m.indexOf('（'));
    });
    return { text: out, changed };
  }
  // annotate：跳过标题行；该词在文本任何处已带 word（…）注释=幂等跳过（一词只注一次）
  if (!zh) return { text, changed: false };
  if (new RegExp(`\\b${esc}（[^）]*）`, 'i').test(text)) return { text, changed: false };
  const re = new RegExp(`(?<![\\u4e00-\\u9fff)）])\\b${esc}\\b(?![\\u4e00-\\u9fff（])`, 'i');
  const lines = text.split('\n');
  for (let li = 0; li < lines.length; li++) {
    if (/^#/.test(lines[li]!)) continue;
    const m = lines[li]!.match(re);
    if (m) {
      lines[li] = lines[li]!.replace(re, `${m[0]}（${zh}）`);
      return { text: lines.join('\n'), changed: true };
    }
  }
  return { text, changed: false };
}

/** 从文件名认层标签（产物命名如 A层85/M层75/B层60）。
 *  返回匹配到的 tag（如 'A层85'）；认不出返回 null。 */
export function tierTagOfFilename(filename: string, naming: Readonly<Record<string, string>>): string | null {
  for (const tag of Object.values(naming)) {
    if (tag && filename.includes(tag)) return tag;
  }
  return null;
}

/** tag（'A层85'）→ 层键（'A'） */
export function tierKeyOfTag(tag: string, naming: Readonly<Record<string, string>>): string | null {
  for (const [key, t] of Object.entries(naming)) {
    if (t === tag) return key;
  }
  return null;
}

/** 一个待传播的目标文件：层键、层标签、完整路径。 */
export interface PropagationTarget {
  tier: string;
  tag: string;
  path: string;
}

/**
 * 从"当前这一层的文件"出发，挑出**它全部下级层**的同章文件（纯函数；不读不写）。
 *
 * 用途：上级教师确认的词级操作要传播到下级读者文本，传播对象就是这些文件。
 * 判定全部用同一套命名表（项目配置的 `产物命名`），不在这里另写一套 `A层85` 字面量——
 * 换一本书、换一套命名依然成立。
 *
 * 返回顺序按 `descendantsOf` 的层级顺序，便于界面按"先 M 后 B"列出来给教师看。
 */
export function descendantTierFiles(tree: ReaderTree, naming: Readonly<Record<string, string>>, fromTag: string, files: readonly string[]): PropagationTarget[] {
  const fromTier = tierKeyOfTag(fromTag, naming);
  if (!fromTier) return [];
  const wanted = new Map<string, string>(); // tier → tag
  for (const tier of descendantsOf(tree, fromTier)) {
    const tag = naming[tier];
    if (tag) wanted.set(tier, tag);
  }
  if (!wanted.size) return [];
  const out: PropagationTarget[] = [];
  for (const path of files) {
    /* 只认"正文产物"：`原文_<tag>_…md`。
     * 用 `原文_` 前缀而不是"文件名里含 tag"——后者会把碰巧带同名字段的文件也卷进来。 */
    if (!/(^|\/)原文_/.test(path)) continue;
    if (!/\.(md|txt)$/i.test(path)) continue;
    /* 还要排掉同目录下的**派生物**：`_工作稿.md`（app 写的工作副本）与 `_原始备份.md`
     * （首改前留的原始版）。它们与正本同层、文件名里同样带层标签，只有后缀不同——
     * 传播把它们一起改了，等于**污染备份、并把工作稿当成第二份正本**。
     * 这条由 `tests/propagate.test.ts` 钉住（第一版就是被它当场抓出来的）。 */
    if (/_(工作稿|原始备份)\.(md|txt)$/i.test(path)) continue;
    const tag = tierTagOfFilename(path, naming);
    if (!tag) continue;
    const tier = tierKeyOfTag(tag, naming);
    if (!tier || !wanted.has(tier)) continue;
    if (out.some((t) => t.path === path)) continue;
    out.push({ tier, tag, path });
  }
  const order = [...wanted.keys()];
  out.sort((a, b) => order.indexOf(a.tier) - order.indexOf(b.tier) || a.path.localeCompare(b.path));
  return out;
}
