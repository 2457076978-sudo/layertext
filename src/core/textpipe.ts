/**
 * LayerText · 文本管线：章节解析、分句、分词、词形还原命中判定
 *
 * 逐行移植自原型 qc_chapter.py（sents_of / hit / _pend_hit），语义保持一致：
 *  - 连字符/破折号/引用符在分句前替换为空格（"well-known" → well known 两词）
 *  - 句边界 = [.!?"] 后跟空格（零宽切分，与 Python re.split 行为一致）
 *  - 词形还原：token 先查词表/不规则名词表，再反向剥后缀（s/es/ies→y/ed/ing，
 *    含双写辅音 stopped→stop、去 e 型 fired→fire）
 */

import { IRR_NOUN } from './irregular.js';

export interface ChapterParts {
  /** 正文区（## Chapter 标记后、## 词句卡 之前） */
  body: string;
  /** 词句卡区（## 词句卡 之后；无则为空串） */
  card: string;
}

/** 提取正文区与词句卡区（要求 md 含 "## Chapter X" 标记，格式与原型一致） */
export function splitChapter(md: string): ChapterParts {
  const hm = md.match(/## Chapter \w+/);
  if (!hm) throw new Error('未找到 "## Chapter" 章节标记（格式：## Chapter One）');
  const after = md.slice((hm.index ?? 0) + hm[0].length);
  return {
    body: after.split('## 词句卡')[0],
    card: md.split('## 词句卡')[1] ?? '',
  };
}

/** 按 [P01] 段落标记切段（标记前的头部文本不计入段落） */
export function extractParas(body: string): string[] {
  const marks = [...body.matchAll(/\[P\d+\]/g)];
  return marks.map((m, i) => {
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < marks.length ? (marks[i + 1].index ?? body.length) : body.length;
    return body.slice(start, end);
  });
}

/** 分句（song=true 时歌词按行→句切分；否则按 [.!?"] + 空格切分） */
export function sentsOf(text: string, song: boolean): string[] {
  const t = text.replace(/[>—-]+/g, ' ');
  let parts: string[];
  if (song) {
    parts = t
      .split('\n')
      .filter((p) => /[A-Za-z]{2,}/.test(p))
      .flatMap((p) => p.split(/(?<=[.!?])\s+/));
  } else {
    const norm = t.split(/\s+/).filter(Boolean).join(' ');
    parts = norm.split(/(?<=[.!?"] )/);
  }
  return parts.filter((p) => /[A-Za-z]{2,}/.test(p));
}

/** 词符化：提取英文词 → 小写 → 去首尾 ' / - → 去所有格 's */
export function tokenizeTxt(txt: string): string[] {
  const raw = txt.match(/[A-Za-z][A-Za-z'\-]*/g) ?? [];
  return raw
    .map((t) =>
      t
        .toLowerCase()
        .replace(/^['-]+/, '')
        .replace(/['-]+$/, '')
        .replace(/'s$/, ''),
    )
    .filter((t) => t.length > 0);
}

/** 词表命中判定（词形还原：直接命中 → 不规则名词 → 反向剥后缀候选逐一回查） */
export function hit(tok: string, known: Set<string>): boolean {
  if (known.has(tok)) return true;
  const sing = IRR_NOUN[tok];
  if (sing !== undefined && known.has(sing)) return true;
  const cands: string[] = [tok];
  if (tok.endsWith('s')) cands.push(tok.slice(0, -1));
  if (tok.endsWith('es')) cands.push(tok.slice(0, -2));
  if (tok.endsWith('ies')) cands.push(tok.slice(0, -3) + 'y');
  if (tok.endsWith('ed')) cands.push(tok.slice(0, -1), tok.slice(0, -2), tok.slice(0, -2) + 'e');
  if (tok.endsWith('d') && !tok.endsWith('ed')) cands.push(tok.slice(0, -1));
  if (tok.endsWith('ing')) cands.push(tok.slice(0, -3), tok.slice(0, -3) + 'e');
  if (tok.endsWith('ied')) cands.push(tok.slice(0, -3) + 'y');
  if (tok.endsWith('ier')) cands.push(tok.slice(0, -3) + 'y');
  if (tok.endsWith('ed') && tok.length > 5 && tok[tok.length - 3] === tok[tok.length - 4]) cands.push(tok.slice(0, -3));
  if (tok.endsWith('er')) cands.push(tok.slice(0, -1), tok.slice(0, -2));
  if (tok.endsWith('est')) cands.push(tok.slice(0, -3), tok.slice(0, -2));
  return cands.some((c) => known.has(c));
}

/** 待定词 token 命中（缩窄后缀集，保守口径） */
export function pendHit(tok: string, pending: Set<string>): boolean {
  const c = [tok];
  if (tok.endsWith('s')) c.push(tok.slice(0, -1));
  if (tok.endsWith('es')) c.push(tok.slice(0, -2));
  if (tok.endsWith('ed')) c.push(tok.slice(0, -1), tok.slice(0, -2), tok.slice(0, -2) + 'e');
  if (tok.endsWith('ing')) c.push(tok.slice(0, -3), tok.slice(0, -3) + 'e');
  return c.some((x) => pending.has(x));
}
