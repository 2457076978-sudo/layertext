// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，本仓库已部署版权验证体系，细节不予公开（docs/版权与授权.md）。
/**
 * LayerText · 校准台账：教师人工校准的**不可变事件** + 跨版本重放
 *
 * ## 为什么要有它（2026-09-13 查出来的真事故）
 *
 * `_审校标记.json` 是**按文件名**落盘的（`app/src/main.ts: markPathFor` = `目录/<文件名去扩展>_审校标记.json`），
 * 而管线每重新生成一版产物就换一个文件名。后果就是教师感觉到的那个现象——
 * **"我点了确认，下次进来校准怎么没了"**：
 *
 * ```
 * 原文_A层85_2026-09-10_审校标记.json           1 条（pellets / 词汇简化，教师 09-10 点的）
 * 原文_A层85_2026-09-12_工序化_审校标记.json     0 条（教师后来打开的是这一版，读的是它自己那张空表）
 * ```
 *
 * 校准没丢，它躺在**旧文件名**名下；新文件读不到，于是"像"丢了。
 * 全书只有第一章留下过标记文件，其余九章一个都没有——同一个根因的另一面。
 *
 * ## 分工（与 `decision.ts` 同一条哲学：事件是正本，视图可重建）
 *
 * | 东西 | 角色 | 挂在什么上 | 换版本 |
 * |---|---|---|---|
 * | `_审校标记.json` | **视图**（供 App 快速渲染） | 文件名 | 失效，可重建 |
 * | `_运行/校准台账.jsonl` | **正本**（append-only） | 书+章+层+词/句锚 | **重放得回来** |
 *
 * `decision.ts` 管的是"风险队列上的采纳/退回"，本模块管的是"审校工作台上的词/句级校准"——
 * 两者都是不可变事件，都不写正本词库，入库那一步永远留给教师。
 *
 * ## 来源要分得开
 *
 * `source: 'human' | 'ai'`——教师点的（`human`）与模型提的候选（`ai`）必须一眼分得开：
 * 论文里"人工校准"是可审计的教师判断，模型候选只是建议。混在一起，
 * 事后没人能回答"这条到底是人定的还是机器提的"。
 *
 * 本模块只做纯逻辑：造事件、解析、折叠、在**当前**文本里重新定位。它从不改正文、不写词库。
 */

import { splitChapter, extractParas, sentsOf, tokenizeTxt } from './textpipe.js';

export const CALIBRATION_SCHEMA_VERSION = 1;

export type CalibrationAction = 'add' | 'remove';
/** `human` = 教师在 App 里点的确认；`ai` = 模型提的候选（采纳后另记一条 human）。 */
export type CalibrationSource = 'human' | 'ai';
export type CalibrationLevel = 'word' | 'phrase' | 'sent';

/** 校准的归属范围：**不含文件名**——文件名正是当初把校准弄丢的那个锚。 */
export interface CalibrationScope {
  book: string;
  chapter: string;
  tier: string;
}

export interface CalibrationEvent extends CalibrationScope {
  schemaVersion: number;
  /** 稳定事件 ID（同 (教师, 时间, 锚, 动作) 恒等）——重复导入不会造出两条账。 */
  id: string;
  ts: string;
  teacher: string;
  level: CalibrationLevel;
  /** 词级/短语级锚：词面（小写）。跨版本重放主要靠它。 */
  word?: string;
  /** 句级锚：句子前 60 字（跨版本句结构会变，只作漂移校验，不作硬锚）。 */
  text?: string;
  type: string;
  note?: string;
  action: CalibrationAction;
  source: CalibrationSource;
  /**
   * `mark` = 这条决定**要变成一条标记**（落在正文/标记清单里，如加注、换词）；
   * `decision` = **只是决定，不是标记**（如「忽略」：不改、不注，只留审计与"别再问我"）。
   *
   * 教师 2026-09-13 实战踩出来的：把「忽略」也写成标记后，它会被 AI 审核建议流程当成待办，
   * 拿着"这个词忽略"去问一次 AI、产出一条空建议、再被引擎复核报 `⚠︎ 仍含超长`。
   * **一条"什么都不做"的决定，不该产生一条要处理的待办。**
   */
  kind?: 'mark' | 'decision';
  /**
   * 这次决定**要不要往下层传播**（教师 2026-09-13 明确的口径）。
   *
   * 沿用项目既有的层级传播三类：`annotate`（加注/去标注——操作即资产，直接落实到下级文本）、
   * `rewrite`（换词——只写下级待办，不直接改下级）、`none`（**不传播**）。
   * 「忽略」这类决定是 `none`：**只在做决定的那一层生效**，不许往下走——
   * 上级觉得"这个词不用管"，不等于下级也觉得不用管（三层的学生词库本来就不同）。
   */
  propagation?: 'none' | 'annotate' | 'rewrite';
  /** 哪一版上做的——**只作溯源，不作锚**（这就是本次修复的核心）。 */
  file?: string;
  /** 由哪个版本传播而来（沿用 `Mark.origin` 口径）。 */
  origin?: string;
}

export interface MakeCalibrationInput extends Omit<CalibrationEvent, 'schemaVersion' | 'ts' | 'id'> {
  ts?: string;
  id?: string;
}

/** 稳定 ID：FNV 双散列（与 `decision.ts: eventIdOf` 同款，避免再引一套哈希）。 */
export function calibrationIdOf(input: { teacher: string; ts: string; level: string; anchor: string; type: string; action: string }): string {
  const s = [input.teacher, input.ts, input.level, input.anchor.toLowerCase(), input.type, input.action].join('\u0001');
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
  }
  h2 = Math.imul(h2 ^ (h1 >>> 13), 0xc2b2ae35) >>> 0;
  return `cal-${(h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 12)}`;
}

/** 造一条校准事件。时间戳只在缺省时生成（测试可传固定值，保证确定性）。 */
export function makeCalibrationEvent(input: MakeCalibrationInput): CalibrationEvent {
  if (!input.teacher) throw new Error('校准事件必须有 teacher——多教师并行时没有它就等于没记');
  if (!input.book || !input.chapter || !input.tier) throw new Error('校准事件必须有 书/章/层——否则换版本无法归属（这正是本次修复要解决的问题）');
  const anchor = (input.word ?? input.text ?? '').trim();
  if (!anchor) throw new Error('校准事件必须有 word 或 text 锚——没有锚的事件无法重放到新版本');
  const ts = input.ts ?? new Date().toISOString();
  return {
    schemaVersion: CALIBRATION_SCHEMA_VERSION,
    ...input,
    ts,
    id: input.id ?? calibrationIdOf({ teacher: input.teacher, ts, level: input.level, anchor, type: input.type, action: input.action }),
  };
}

export const toCalibrationLine = (e: CalibrationEvent): string => JSON.stringify(e) + '\n';

export interface ParseCalibrationResult {
  events: CalibrationEvent[];
  /** 坏行：解析不了或版本不认识——**不静默丢**，调用方必须报出来（沿用项目既有纪律）。 */
  bad: { line: number; reason: string }[];
}

export function parseCalibrationLog(text: string): ParseCalibrationResult {
  const events: CalibrationEvent[] = [];
  const bad: { line: number; reason: string }[] = [];
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (!raw) continue;
    let o: unknown;
    try {
      o = JSON.parse(raw);
    } catch {
      bad.push({ line: i + 1, reason: 'JSON 解析失败' });
      continue;
    }
    const e = o as Partial<CalibrationEvent>;
    if (!e || typeof e !== 'object') {
      bad.push({ line: i + 1, reason: '不是对象' });
      continue;
    }
    if (!e.teacher || !e.level || !e.type || !e.action || !(e.word ?? e.text)) {
      bad.push({ line: i + 1, reason: '缺关键字段（teacher/level/type/action/锚）' });
      continue;
    }
    if (e.schemaVersion !== CALIBRATION_SCHEMA_VERSION) {
      bad.push({ line: i + 1, reason: `schemaVersion=${String(e.schemaVersion)} 不认识` });
      continue;
    }
    /* 缺省补齐放在展开**之后**：老账里没有 source/书章层字段也要读得回来，
     * 但**不覆盖**账上已有的值（TS2783 那条报错就是展开顺序写反了）。 */
    const parsed = e as CalibrationEvent;
    events.push({
      ...parsed,
      source: parsed.source ?? 'human',
      book: parsed.book ?? '',
      chapter: parsed.chapter ?? '',
      tier: parsed.tier ?? '',
      ts: parsed.ts ?? '',
      id: parsed.id ?? '',
    });
  }
  return { events, bad };
}

/** 同一处的判定键：书|章|层|粒度|锚。**刻意不含文件名**。 */
export function calibrationKeyOf(e: Pick<CalibrationEvent, 'book' | 'chapter' | 'tier' | 'level' | 'word' | 'text'>): string {
  const anchor = (e.word ?? e.text ?? '').trim().toLowerCase();
  return [e.book, e.chapter, e.tier, e.level, anchor].join('\u0001');
}

/**
 * 折叠事件流 → "当前有效的校准"（键 → 最后一条 add）。
 * 语义：同一处**后一条覆盖前一条**；`remove` 撤销该处现有的校准（教师改主意是常态，得让他回得来）。
 * 折叠结果与输入顺序无关（内部按 ts 排序，同一毫秒再按事件 id 定序）——重放必须可复现。
 */
export function foldCalibrations(events: readonly CalibrationEvent[]): Map<string, CalibrationEvent> {
  const sorted = [...events].sort((a, b) => (a.ts === b.ts ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.ts < b.ts ? -1 : 1));
  const live = new Map<string, CalibrationEvent>();
  for (const e of sorted) {
    const k = calibrationKeyOf(e);
    if (e.action === 'remove') live.delete(k);
    else live.set(k, e);
  }
  return live;
}

/** 折叠 + 按范围过滤（书/章/层三级都给才生效；给空串表示"不限"）。 */
export function calibrationsFor(events: readonly CalibrationEvent[], scope: Partial<CalibrationScope>): CalibrationEvent[] {
  const live = foldCalibrations(events);
  return [...live.values()].filter((e) => (!scope.book || e.book === scope.book) && (!scope.chapter || e.chapter === scope.chapter) && (!scope.tier || e.tier === scope.tier));
}

/* ────────────────────────── 在当前文本里重新定位 ────────────────────────── */

export interface Located {
  pi: number;
  si: number;
  wi: number;
}

/**
 * 用**与 App 渲染同一套**索引定位一个词：pi=extractParas 下标、si=sentsOf 下标、wi=句内第几个词。
 * 同一套函数是硬要求——若这里自己写一套正则，重放出来的 wi 会和正文里点的那个位置错开一格，
 * 教师看到的就是"校准跑偏了"（这正是当初 `segmentList` 按标记而不按下标配对要解决的问题）。
 */
export function locateWord(md: string, word: string): Located[] {
  const target = word.trim().toLowerCase();
  if (!target) return [];
  let paras: string[];
  try {
    paras = extractParas(splitChapter(md).body);
  } catch {
    return [];
  }
  const out: Located[] = [];
  paras.forEach((p, pi) => {
    sentsOf(p, false).forEach((sent, si) => {
      const raw = sent.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
      const toks = tokenizeTxt(sent);
      for (let wi = 0; wi < raw.length; wi++) {
        const tok = (toks[wi] ?? raw[wi]!.toLowerCase()).toLowerCase();
        if (tok === target || raw[wi]!.toLowerCase() === target) out.push({ pi, si, wi });
      }
    });
  });
  return out;
}

/** 短语级锚：整段文本里找这个短语的起始词位置（返回每一处起点）。 */
export function locatePhrase(md: string, phrase: string): Located[] {
  const p = phrase.trim().toLowerCase();
  if (!p) return [];
  const first = p.match(/[A-Za-z][A-Za-z'-]*/)?.[0];
  if (!first) return [];
  const hits = locateWord(md, first);
  return hits.filter((h) => {
    const sent = sentenceAt(md, h.pi, h.si);
    return sent ? sent.toLowerCase().includes(p) : false;
  });
}

function sentenceAt(md: string, pi: number, si: number): string | null {
  try {
    const paras = extractParas(splitChapter(md).body);
    return sentsOf(paras[pi] ?? '', false)[si] ?? null;
  } catch {
    return null;
  }
}

/* ────────────────────────── 重放 ────────────────────────── */

/** 重放产出的标记：结构与 App 的 `Mark` 对齐（`id` 决定性，重复重放不会长出第二条）。 */
export interface ReplayedMark {
  id: string;
  level: CalibrationLevel;
  pi: number;
  si: number;
  wi?: number;
  word?: string;
  text?: string;
  type: string;
  note?: string;
  ts: number;
  origin?: string;
  /** 来源事件——App 据此显示"这条是校准台账重放回来的" */
  calibrationId: string;
  /** 一眼分清人定的还是机器提的 */
  source: CalibrationSource;
  /** 这条是按哪一版做的（溯源，不参与判定） */
  fromFile?: string;
}

export interface ReplayResult {
  marks: ReplayedMark[];
  /** 台账里有、但在当前文本里找不到锚的——**如实报出**，不许静默少给（项目惯例）。 */
  unmatched: CalibrationEvent[];
}

export interface ReplayInput {
  md: string;
  events: readonly CalibrationEvent[];
  scope: CalibrationScope;
  /** 已存在的标记（按 level+pi+si+wi+type 去重，避免和视图里的旧标记打架） */
  existing?: readonly { level: string; pi: number; si: number; wi?: number; type: string }[];
  /** 只要这些来源（缺省全要） */
  sources?: readonly CalibrationSource[];
}

/**
 * 把校准台账重放到**当前版本**的文本上。
 *
 * 为什么按词面而不是按 pi/si/wi 存：段落增删、拆句之后，下标全变（`segmentList` 那条教训）。
 * 词面会漂移、但**漂移是可检测的**：找不到就进 `unmatched`，教师看得见"这条没落上"，
 * 而不是像现在这样——整张表空着，人还以为自己没点过。
 */
export function replayCalibrations(input: ReplayInput): ReplayResult {
  const live = calibrationsFor(input.events, input.scope)
    /* `decision` 类事件**不参与重放**：它们不是标记，重放回来就会变成"什么都没有做却长出一条待办"。
       老账没有 kind 字段 → 按 `mark` 处理（向后兼容，那时记的都是真标记）。 */
    .filter((e) => e.kind !== 'decision')
    .filter((e) => !input.sources || input.sources.includes(e.source));
  const have = new Set((input.existing ?? []).map((m) => [m.level, m.pi, m.si, m.wi ?? -1, m.type].join('|')));
  const marks: ReplayedMark[] = [];
  const unmatched: CalibrationEvent[] = [];
  for (const e of live) {
    const anchor = (e.word ?? e.text ?? '').trim();
    const spots = e.level === 'word' ? locateWord(input.md, anchor) : e.level === 'phrase' ? locatePhrase(input.md, anchor) : locateSentence(input.md, anchor);
    if (!spots.length) {
      unmatched.push(e);
      continue;
    }
    for (const s of spots) {
      const key = [e.level, s.pi, s.si, s.wi ?? -1, e.type].join('|');
      if (have.has(key)) continue;
      have.add(key);
      marks.push({
        id: `cal:${e.id}:${s.pi}:${s.si}:${s.wi}`,
        level: e.level,
        pi: s.pi,
        si: s.si,
        wi: e.level === 'sent' ? undefined : s.wi,
        word: e.word,
        text: e.text,
        type: e.type,
        note: e.note,
        ts: Date.parse(e.ts) || Date.now(),
        origin: e.origin,
        calibrationId: e.id,
        source: e.source,
        fromFile: e.file,
      });
    }
  }
  return { marks, unmatched };
}

/**
 * 找不到锚的时候，到底该不该慌？
 *
 * **多数情况不是"账丢了"，是"办结了"**——2026-09-13 实查：
 *   教师 09-10 在 A 层给 `pellets（颗粒）` 打了「词汇简化」；
 *   09-12 工序化版里那句已经变成 `The small metal balls`——**词没了，是因为要办的事办完了**。
 *   同理 B 层的 `Presently`。
 *
 * 所以要按**标记的意图**分开：
 *   · 待办类（简/超纲/太难）= "这个词该换掉" → 词不见了 = **办结**；
 *   · 保留类（加注/释义/好词保留/复现锚点）= "这个词该留下/该标注" → 词不见了 = **要看一眼**（可能真丢了）。
 * 两类糊在一起报，教师面对的就是一片"找不到锚"，分不清哪些是完成、哪些是事故。
 */
export type UnmatchedVerdict = 'done' | 'check';

const DONE_WHEN_GONE = new Set(['simpl', 'oov', 'hard', 'cut', 'paraphrase', 'syntax', 'long', 'others']);

export function unmatchedVerdict(e: Pick<CalibrationEvent, 'type' | 'level'>): { verdict: UnmatchedVerdict; why: string } {
  if (DONE_WHEN_GONE.has(e.type)) {
    return { verdict: 'done', why: `标的是「${e.type}」——这类意图就是让这个词离开，词不在了多半是已办结` };
  }
  return { verdict: 'check', why: `标的是「${e.type}」——这类意图要这个词留下/被标注，词却没了，值得看一眼` };
}

function locateSentence(md: string, prefix: string): Located[] {
  const p = prefix.trim().toLowerCase().slice(0, 24);
  if (!p) return [];
  try {
    const paras = extractParas(splitChapter(md).body);
    const out: Located[] = [];
    paras.forEach((para, pi) => {
      sentsOf(para, false).forEach((sent, si) => {
        if (sent.toLowerCase().startsWith(p)) out.push({ pi, si, wi: 0 });
      });
    });
    return out;
  } catch {
    return [];
  }
}

/** 由 App 的 Mark 造一条校准事件（`human` = 教师点的）。删标记用 `action: 'remove'`。 */
export function calibrationFromMark(
  mark: { level: CalibrationLevel; word?: string; text?: string; type: string; note?: string; origin?: string },
  ctx: {
    teacher: string;
    book: string;
    chapter: string;
    tier: string;
    file?: string;
    action?: CalibrationAction;
    source?: CalibrationSource;
    propagation?: 'none' | 'annotate' | 'rewrite';
    kind?: 'mark' | 'decision';
    ts?: string;
  },
): CalibrationEvent {
  return makeCalibrationEvent({
    teacher: ctx.teacher,
    book: ctx.book,
    chapter: ctx.chapter,
    tier: ctx.tier,
    level: mark.level,
    word: mark.word,
    text: mark.text,
    type: mark.type,
    note: mark.note,
    origin: mark.origin,
    action: ctx.action ?? 'add',
    source: ctx.source ?? 'human',
    propagation: ctx.propagation,
    kind: ctx.kind,
    file: ctx.file,
    ts: ctx.ts,
  });
}

/* ────────────────────────── 书键：两边必须算出同一个 ────────────────────────── */

/**
 * 从章节文件路径推"书"键。
 *
 * **为什么不用项目 json 里的 `书名`**：App 侧（Tauri 前端）拿不到那个字段，
 * 而校准台账是**两边共写**的——管线 `--import` 写的账，App 打开时要能匹配上。
 * 两边各算各的，只要有一边用了不同来源，键就对不上，台账就成了"我写的你看不见"。
 * 所以统一取 `调适工作区` 的上一级目录名（如 `名著阅读工作区_AnimalFarm`）。
 */
export function bookKeyFromPath(path: string): string {
  const seg = String(path).split('/').filter(Boolean);
  const i = seg.findIndex((s) => s === '调适工作区' || s.endsWith('工作区'));
  if (i > 0) return seg[i - 1]!;
  return seg.length >= 4 ? seg[seg.length - 4]! : '';
}

/** 章节文件路径 → 校准范围（认不出就返回 null；**不猜**）。 */
export function scopeFromChapterPath(path: string): CalibrationScope | null {
  const seg = String(path).split('/').filter(Boolean);
  if (seg.length < 3) return null;
  const file = seg[seg.length - 1]!;
  const chapter = seg[seg.length - 2]!;
  if (!/^第.+章$/.test(chapter)) return null;
  const tier = file.match(/(A层85|M层75|B层60)/)?.[1];
  if (!tier) return null;
  return { book: bookKeyFromPath(path), chapter, tier };
}

/** 章节文件路径 → 台账路径（产物根 `_运行/校准台账.jsonl`）。 */
export function ledgerPathFromChapterPath(path: string): string | null {
  const seg = String(path).split('/');
  if (seg.length < 3) return null;
  const outRoot = seg[seg.length - 3]; // 重制三版（章节文件的祖父目录）
  if (!outRoot) return null;
  return [...seg.slice(0, seg.length - 2), '_运行', '校准台账.jsonl'].join('/');
}
