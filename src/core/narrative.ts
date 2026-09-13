/**
 * 叙事保真度测量（优化方向①+③ · 论文三件套"保真"维度的剧情级落地）
 *
 * 两个纯函数，向量由调用方注入（本地 MiniLM，零 LLM）：
 *  ① smithWatermanAlign —— 句向量局部对齐（Smith-Waterman，仿射不设、线性 gap）：
 *     输出原文叙事单元在简化版中的对齐关系 + 覆盖率 + 未对齐（=简化中找不到对应）清单。
 *     与 align.ts 的 Jaccard 路径互补：大幅改写（换说法）时 Jaccard 失效，向量仍能配对——
 *     两轨制：Jaccard 先行，向量兜底，本模块只做向量轨。
 *  ② paragraphSimilarities —— 段落级余弦（同段号配对），低分段打风险标。
 *
 * 阈值纪律：tau/gap/风险线全部由调用方传入——定标数据（AF 全书分布 P10）出来之前，
 * 这里不内置任何"拍脑袋"数字。
 */

/** 余弦相似度（向量已归一时即点积；这里不假设归一，完整算） */
export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

export interface SWAlignOptions {
  /** 配对判定线：cos ≥ tau 记为可匹配（低于它的格不进对齐） */
  tau: number;
  /** 线性 gap 罚分（相对满分 1 的比例，常用 0.2-0.4） */
  gap: number;
}

export interface SWAlignment {
  pairs: { baseIdx: number; simpIdx: number; score: number }[];
  /** 原文侧被对齐覆盖的句下标（叙事单元保住了的） */
  coveredBase: Set<number>;
  /** 未对齐原文句下标——简化版里找不到语义对应（丢句/丢事件的候选，交教师核对） */
  uncoveredBase: number[];
}

/** Smith-Waterman 局部对齐：H[i][j]=max(0, H[i-1][j-1]+s, H[i-1][j]-gap, H[i][j-1]-gap)。
 *  得分=cos 相似度本身（tau 以下格子记 0——不值得配）。回溯取所有正分红迹。 */
export function smithWatermanAlign(baseVecs: readonly (readonly number[])[], simpVecs: readonly (readonly number[])[], opts: SWAlignOptions): SWAlignment {
  const n = baseVecs.length;
  const m = simpVecs.length;
  const coveredBase = new Set<number>();
  const pairs: SWAlignment['pairs'] = [];
  if (!n || !m) return { pairs, coveredBase, uncoveredBase: [...Array(n).keys()] };

  // 预打分矩阵
  const S: number[][] = baseVecs.map((b) =>
    simpVecs.map((s) => {
      const c = cosine(b, s);
      return c >= opts.tau ? c : 0;
    }),
  );
  const H: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  let best = 0;
  let bi = 0;
  let bj = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const diag = H[i - 1]![j - 1]! + S[i - 1]![j - 1]!;
      const up = H[i - 1]![j]! - opts.gap;
      const left = H[i]![j - 1]! - opts.gap;
      const v = Math.max(0, diag, up, left);
      H[i]![j] = v;
      if (v > best) {
        best = v;
        bi = i;
        bj = j;
      }
    }
  }
  // 全局最优单迹回溯（简化文本与原文是"同一段故事的两次讲述"，最优迹即主对齐；
  // 多迹=多版本并读场景，本模块不假设）
  let i = bi;
  let j = bj;
  while (i > 0 && j > 0 && H[i]![j]! > 0) {
    const diag = H[i - 1]![j - 1]! + S[i - 1]![j - 1]!;
    const up = H[i - 1]![j]! - opts.gap;
    if (H[i]![j] === diag) {
      pairs.push({ baseIdx: i - 1, simpIdx: j - 1, score: S[i - 1]![j - 1]! });
      coveredBase.add(i - 1);
      i--;
      j--;
    } else if (H[i]![j] === up) i--;
    else j--; /* 剩余分支=向左（H[i][j-1]-gap） */
  }
  pairs.reverse();
  const uncoveredBase = [...Array(n).keys()].filter((k) => !coveredBase.has(k));
  return { pairs, coveredBase, uncoveredBase };
}

export interface ParagraphRisk {
  segId: string;
  score: number;
  risky: boolean;
}

/** 段落级相似度：同段号（[P##]）配对取 cos；低于风险线的段标 risky。
 *  段号在简化版缺失 = 整段风险（简化侧丢段），由调用方按段号差集补报。 */
export function paragraphSimilarities(baseBySeg: ReadonlyMap<string, readonly number[]>, simpBySeg: ReadonlyMap<string, readonly number[]>, riskLine: number): ParagraphRisk[] {
  const out: ParagraphRisk[] = [];
  for (const [segId, bv] of baseBySeg) {
    const sv = simpBySeg.get(segId);
    if (!sv) {
      out.push({ segId, score: Number.NaN, risky: true });
      continue;
    }
    const score = cosine(bv, sv);
    out.push({ segId, score, risky: score < riskLine });
  }
  return out;
}
