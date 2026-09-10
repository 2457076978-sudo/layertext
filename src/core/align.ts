// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，实现级指纹已在案（docs/维权.md）。
/**
 * 句级对齐与信号核对（App「逐句对照」与 MCP layer_align 共用的唯一实现）
 * 完全相同句做 LCS 锚点；锚点间隙按词集 Jaccard≥0.45 贪心配对（改写句）；
 * 配不上 = lost（基准有此处无）/ added（此处新增）；match 行附数字/专名丢失清单。
 */

export interface AlignSentRef {
  pi: number;
  si: number;
  text: string;
}

export interface AlignRow {
  kind: 'match' | 'lost' | 'added';
  base?: AlignSentRef;
  cur?: AlignSentRef;
  /** match 行：基准句里的数字/专名在当前句找不到的清单（"信息丢了"机器核对） */
  lostSignals?: string[];
}

/** 英文数字词 → 数字串（three→3），让数字词与阿拉伯数字能互认 */
const NUM_WORDS: Record<string, string> = {
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
  eleven: '11',
  twelve: '12',
  thirteen: '13',
  fourteen: '14',
  fifteen: '15',
  sixteen: '16',
  seventeen: '17',
  eighteen: '18',
  nineteen: '19',
  twenty: '20',
  thirty: '30',
  forty: '40',
  fifty: '50',
  hundred: '100',
  thousand: '1000',
  first: '1st',
  second: '2nd',
  third: '3rd',
  once: '1',
  twice: '2',
};

/** 常见句首词（小写）——句首大写不算专名，避免整章误报 */
const SENT_STARTERS = new Set([
  'the',
  'a',
  'an',
  'he',
  'she',
  'it',
  'they',
  'we',
  'you',
  'i',
  'but',
  'and',
  'or',
  'when',
  'while',
  'after',
  'before',
  'if',
  'then',
  'now',
  'there',
  'this',
  'that',
  'these',
  'those',
  'his',
  'her',
  'its',
  'their',
  'my',
  'your',
  'our',
  'so',
  'for',
  'at',
  'in',
  'on',
  'no',
  'yes',
  'all',
  'each',
  'every',
  'some',
  'many',
  'few',
  'both',
  'what',
  'who',
  'where',
  'why',
  'how',
  'as',
  'by',
  'from',
  'with',
  'to',
  'of',
  'up',
  'out',
  'about',
  'into',
  'over',
  'under',
  'not',
  'never',
  'always',
  'often',
  'sometimes',
  'soon',
  'later',
  'next',
  'last',
  'mr',
  'mrs',
  'miss',
  'dr',
  'one',
  'two',
  'three',
  'everyone',
  'everybody',
  'somebody',
  'nobody',
  'anyone',
  'another',
  'several',
  'most',
  'none',
  'today',
  'tomorrow',
  'yesterday',
  'long',
  'only',
  'very',
  'just',
  'still',
  'even',
  'perhaps',
  'maybe',
  'neither',
  'whether',
  'because',
  'since',
  'until',
  'though',
  'although',
  'here',
  'come',
  'look',
  'listen',
  'said',
  'asked',
  'one day',
  'suddenly',
  'at last',
]);

/** 句子指纹：小写、去标点、压空白——完全相同句的对齐锚点 */
function sentKey(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 内容词集（>2 字符），配对相似度用 */
function wordSet(t: string): Set<string> {
  return new Set(
    sentKey(t)
      .split(' ')
      .filter((w) => w.length > 2),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

/** 抽取句子的"事实信号"：数字（含英文数字词归一）+ 专名（句首外的大写词） */
export function signalsOf(t: string): string[] {
  const out: string[] = [];
  out.push(...(t.match(/\d+(?:\.\d+)?/g) ?? []));
  const words = t.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
  for (const w of words) {
    const lower = w.toLowerCase();
    if (NUM_WORDS[lower]) out.push(NUM_WORDS[lower]);
    // 大写词且不在常见句首词白名单 → 视为专名（Boxer 句首也可检出；The/They 排除）
    if (/^[A-Z]/.test(w) && !SENT_STARTERS.has(lower)) out.push(w);
  }
  return out;
}

/** 基准句有、当前句没有的信号（"信息丢了"的机器核对口径） */
export function lostSignals(baseText: string, curText: string): string[] {
  const cur = new Set(signalsOf(curText));
  return [...new Set(signalsOf(baseText).filter((x) => !cur.has(x)))];
}

/** 句级对齐：完全相同句做 LCS 锚点；锚点间隙按词集 Jaccard≥0.45 贪心配对（改写句），
 *  配不上=lost（基准有此处无）/ added（此处新增）。match 行附信号丢失清单。 */
export function alignSentencePairs(base: AlignSentRef[], cur: AlignSentRef[]): AlignRow[] {
  const bk = base.map((s) => sentKey(s.text));
  const ck = cur.map((s) => sentKey(s.text));
  const n = base.length;
  const m = cur.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = bk[i] === ck[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const anchors: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (bk[i] === ck[j]) {
      anchors.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  const rows: AlignRow[] = [];
  let bi = 0;
  let cj = 0;
  const emitGap = (bEnd: number, cEnd: number): void => {
    const bs: AlignSentRef[] = [];
    const cs: AlignSentRef[] = [];
    while (bi < bEnd) bs.push(base[bi++]);
    while (cj < cEnd) cs.push(cur[cj++]);
    const used = new Set<number>();
    for (const b of bs) {
      let best = -1;
      let bestSim = 0.45;
      cs.forEach((c, k) => {
        if (used.has(k)) return;
        const sim = jaccard(wordSet(b.text), wordSet(c.text));
        if (sim > bestSim) {
          bestSim = sim;
          best = k;
        }
      });
      if (best >= 0) {
        used.add(best);
        rows.push({ kind: 'match', base: b, cur: cs[best] });
      } else rows.push({ kind: 'lost', base: b });
    }
    cs.forEach((c, k) => {
      if (!used.has(k)) rows.push({ kind: 'added', cur: c });
    });
  };
  for (const [ai, aj] of anchors) {
    emitGap(ai, aj);
    rows.push({ kind: 'match', base: base[ai], cur: cur[aj] });
    bi = ai + 1;
    cj = aj + 1;
  }
  emitGap(n, m);
  for (const r of rows) {
    if (r.kind === 'match' && r.base && r.cur) {
      const lost = lostSignals(r.base.text, r.cur.text);
      if (lost.length) r.lostSignals = lost;
    }
  }
  return rows;
}
