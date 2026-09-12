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
