// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，本仓库已部署版权验证体系，细节不予公开（docs/版权与授权.md）。
/**
 * LayerText · 待确认队列：把三路确定性结论合成**教师只需要点的一张表**
 *
 * ## 为什么要有它
 *
 * 到 2026-09-13 为止，机器能算出来的"该看的地方"散在三处，各有各的格式、各有各的口径：
 *
 * | 来源 | 规模（Animal Farm 全书） | 判据 | 归谁看 |
 * |---|---|---|---|
 * | 未支持难词（生成管线自己报的缺口） | 875 处 | 词在学生已知词库外、又没拿到注释支持 | 补注/换写/说明保留 |
 * | 正本核对（教师词典/知识库命中却消失） | 4049 处 | **教师自己定过的词**在产物里没了 | 保留加注/确认替换 |
 * | 引擎客观项（句长/OOV/中文残留） | 每章若干 | 判定线 | 改稿 |
 *
 * 教师在 App 里要的是**一张表**：每条给"词 · 出处句 · 候选 · 两个键"，而不是三份 JSON。
 * 本模块做纯逻辑的归一与合并；读盘、取句子、写文件由管线脚本负责。
 *
 * ## 两条纪律
 *
 * 1. **层的写法必须统一**：补注队列用 `A层85`，正本核对用 `A`——不归一就会出现
 *    "同一个词在两份队列里算两件事"，教师点两遍、台账记两条，而人以为只点了一次。
 * 2. **已决定的条目合并时要留住**：队列会重算（管线可以随时重跑），
 *    但教师点过的决定不能因为"重算"就消失——按稳定 ID 把 `status` 带过来。
 */

export type PendingKind = 'annotate' | 'restore';
/** `dict` = 教师词典正本已有释义；`model` = 本地模型带句填的候选；`canon` = 来自正本核对（词本身是正本词） */
export type PendingSource = 'dict' | 'model' | 'canon';

export interface PendingItem {
  /** 稳定 ID：层|章|段|词|种类——重算队列时靠它把教师的决定带过来 */
  id: string;
  kind: PendingKind;
  chapter: string;
  /** 统一写成 tag 形（A层85 / M层75 / B层60） */
  tier: string;
  para: string;
  word: string;
  /** 给教师看的中文（补注=候选释义；restore=教师正本里的释义） */
  gloss: string;
  /** 出处句——**必须带句**：裸问词义只会拿到第一义项（perches=鲈鱼那次事故） */
  sentence: string;
  /** 一句话说明它为什么出现在这里 */
  why: string;
  source: PendingSource;
  /** 知识库里的 ★加注词（判据最硬的一档） */
  star?: boolean;
  status?: string;
  decidedAt?: string;
  /** ② 换写：教师**直接指定**的替换词（留空＝交管线自己找课标内的简单词） */
  replacement?: string;
}

export interface PendingFragment {
  word: string;
  chapter: string;
  tier: string;
  para: string;
  why: string;
}

export interface PendingQueue {
  tier: string;
  items: PendingItem[];
  fragments: PendingFragment[];
  updatedAt: string;
}

const TAG: Record<string, string> = { A: 'A层85', M: 'M层75', B: 'B层60' };

/** 层写法归一：`A` → `A层85`；已经是 tag 的原样返回；认不出就原样（**不猜**）。 */
export function normalizeTier(t: string): string {
  const s = String(t ?? '').trim();
  if (TAG[s]) return TAG[s]!;
  if (/^(A层85|M层75|B层60)$/.test(s)) return s;
  const m = s.match(/^([AMB])层/);
  return m ? (TAG[m[1]!] ?? s) : s;
}

/**
 * 稳定 ID：**不含 kind**。
 *
 * 同一个词在同一段里被两路口径同时点到（既在"未支持难词"里，又命中"正本词消失"）是完全可能的
 * ——词库与词典是两个集合。ID 里带 kind 就会变成两张卡、教师点两遍、台账记两条，
 * 而他自己以为只处理了一处。合成一张、按**更强的判据**呈现（正本 > 补注），两个理由都留着。
 */
export function pendingIdOf(p: { tier: string; chapter: string; para: string; word: string }): string {
  const s = [normalizeTier(p.tier), p.chapter, p.para, p.word.toLowerCase()].join('\u0001');
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
  }
  h2 = Math.imul(h2 ^ (h1 >>> 13), 0xc2b2ae35) >>> 0;
  return `pq-${(h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 12)}`;
}

/** 补注候选队列的一项 → 待确认项（管线 `LayerText_AF补注候选.mjs` 的产物）。 */
export function fromAnnotateItem(it: { word: string; chapter: string; tier: string; para: string; sentence: string; gloss: string; source: string; status?: string; decidedAt?: string }): PendingItem {
  const tier = normalizeTier(it.tier);
  const src: PendingSource = it.source === 'dict' ? 'dict' : it.source === 'model' ? 'model' : 'dict';
  return {
    id: pendingIdOf({ tier, chapter: it.chapter, para: it.para, word: it.word }),
    kind: 'annotate',
    chapter: it.chapter,
    tier,
    para: it.para,
    word: it.word,
    gloss: it.gloss,
    sentence: it.sentence,
    why: src === 'dict' ? '这个词在学生已知词库外，教师词典里已有释义' : '这个词在学生已知词库外，引擎给不出注释支持',
    source: src,
    status: it.status,
    decidedAt: it.decidedAt,
  };
}

/** 正本核对的一行 → 待确认项（管线 `LayerText_AF正本核对.mjs` 的 `rows`）。 */
export function fromCanonRow(r: { tier: string; chapter: string; para: string; word: string; zh: string; star?: boolean }, sentenceOf: (word: string, para: string) => string): PendingItem {
  const tier = normalizeTier(r.tier);
  return {
    id: pendingIdOf({ tier, chapter: r.chapter, para: r.para, word: r.word }),
    kind: 'restore',
    chapter: r.chapter,
    tier,
    para: r.para,
    word: r.word,
    gloss: r.zh,
    sentence: sentenceOf(r.word, r.para),
    why: r.star ? '教师知识库标了★加注词，产物里却找不到它了' : '教师词典登记过这个词，产物里却找不到它了',
    source: 'canon',
    star: Boolean(r.star),
  };
}

/**
 * 合并两路 → 一条队列。
 *
 * - 去重按**稳定 ID**（层|章|段|词|种类）；同 ID 保留先来的（补注优先——它带模型候选与出处句）
 * - `previous` 里已决定的条目：把 `status`/`decidedAt` 带回来（**重算队列不许抹掉教师的决定**）
 * - 排序：★加注词 → 正本 → 补注；同档按章、段——教师从上往下扫，先看判据最硬的
 */
export function mergePending(annotate: readonly PendingItem[], restore: readonly PendingItem[], previous?: readonly PendingItem[]): PendingItem[] {
  const byId = new Map<string, PendingItem>();
  for (const it of [...restore, ...annotate]) {
    if (!byId.has(it.id)) byId.set(it.id, it);
    else {
      const kept = byId.get(it.id)!;
      /* 同一条（同层章段词）两种口径都命中：合并成一条，标注双来源——教师只该点一次 */
      byId.set(it.id, { ...kept, star: kept.star || it.star, why: kept.why.includes('｜') ? kept.why : `${kept.why}｜${it.why}` });
    }
  }
  const decided = new Map((previous ?? []).filter((p) => p.status).map((p) => [p.id, p]));
  const out = [...byId.values()].map((it) => {
    const prev = decided.get(it.id);
    return prev ? { ...it, status: prev.status, decidedAt: prev.decidedAt } : it;
  });
  const rank = (x: PendingItem) => (x.star ? 0 : x.kind === 'restore' ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b) || a.chapter.localeCompare(b.chapter, 'zh') || a.para.localeCompare(b.para) || a.word.localeCompare(b.word));
}

/** 待处理的条数（已决定的不算）——面板顶上那行数字就是它。 */
export const pendingCountOf = (items: readonly PendingItem[], chapter?: string): number => items.filter((i) => !i.status && (!chapter || i.chapter === chapter)).length;

/* ────────────────────────── 教师指定的替换词 ────────────────────────── */

/** 标记备注里"教师指定替换"的固定写法（`annotate.ts` 写、`pipew.ts` 读，两边必须一致）。 */
export const SPECIFIED_REPLACEMENT_PREFIX = '教师指定替换：';

/**
 * 从备注里解析出教师**亲手指定**的替换词。
 *
 * 为什么必须有这个解析：教师在「待确认」里点 ② 并填了词，意思是"就换这个"。
 * 但 App 原有的「词汇简化」流程是把所有标记词**再问一次 AI**——
 * 结果是教师填的词被静默丢掉、AI 换一个别的。**人定的东西不能被机器覆盖**，
 * 这是项目一贯的口径（"协议计数以实效为准"、"教师判断是最高优先级资产"）。
 *
 * 返回 null = 这条备注里没有指定替换（交回 AI 或管线去定）。
 */
export function parseSpecifiedReplacement(note?: string): { word: string; replacement: string } | null {
  if (!note) return null;
  const m = note.match(/教师指定替换：\s*(.+?)\s*→\s*(.+?)\s*$/);
  if (!m) return null;
  const word = m[1]!.trim();
  const replacement = m[2]!.trim();
  if (!word || !replacement) return null;
  return { word, replacement };
}
