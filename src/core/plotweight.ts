// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，本仓库已部署版权验证体系，细节不予公开（docs/版权与授权.md）。
/**
 * LayerText · 情节权重（plotSignalScore）
 *
 * 来源：《LayerText 审查报告 v4_方向》——
 *   「可以部分估算，但不能冒充事实判断。用全书底线中的人物、地点、事件动词和数字做句子对齐，
 *     得到 `plotSignalScore`；再以『事件数、角色数、因果连接词、章节转折位置』加权，
 *     作为排序的 tie-breaker，**不能升级为 blocker**。卡片必须显示『机器估计：高/中/低』
 *     和命中的底线条目，教师仍作最终判断。」
 *
 * 这一段最要紧的两个字是"**先验**"：它是给排序用的提示，不是判定。
 * 所以本模块有三条自我约束，写在代码里而不是靠自觉：
 *   ① 它**只产出分数与命中项**，没有任何阻止流程的能力（`SegmentVerdict` 里根本没有它的位置）；
 *   ② 命中项必须是**能贴给人看的原文片段**——"机器估计：高"而不给依据，等于让人信一个黑盒；
 *   ③ 底线条目拿不到时**信号缺席**，不是"低"。"没算出来"与"算出来是低"是两件事。
 *
 * ── 为什么用"底线里的原文锚点 + 专名表"而不是去解析中文散文 ──────────────
 * 情节底线是教师写的中文散文（`全书情节底线_v0.1.md`），机器从里面抽"角色/地点/事件动词"
 * 只能靠猜。但这份文件里有一样东西是**机器可以逐字对齐**的：被引用的原文片段——
 * `"All animals are equal"`、`《Beasts of England》`、`Manor Farm`、
 * `Four legs good, two legs bad`、`I will work harder`。教师写这些进去，
 * 意思正是"这几句必须原样保留"。那就不猜，直接拿它们对齐。
 * 角色与地名同样不猜：项目的**专名表**本来就是机器可读的名单。
 *
 * ── 这个先验**盲在哪儿**（实测，写下来免得有人当成全知）──────────────────
 * 拿 Animal Farm 真底线跑："Boxer said, \"I will work harder!\"" → 高；
 * "All animals are equal." → 中；但 **"The windmill fell down in the storm." → 低**。
 * 风车明明是全书最重的劳役象征，可它既不是"可引用的原文锚点"、也不在专名表里
 * （专名表收的是人名），于是这项先验对它视而不见。
 * 不猜"中文象征名 ↔ 英文词"的对应（那是猜），而是给教师一个**显式出口**：
 * 在底线文件里写一行 `锚点：windmill、gun、the wind`，这些词就按锚点算。
 * 教师知道而机器不知道的东西，就该由教师直接写下来。
 */

export const PLOT_LEVELS = ['高', '中', '低'] as const;
export type PlotLevel = (typeof PLOT_LEVELS)[number];

/** 分项权重：底线的原文锚点最重（教师点名"不可降质"的就是它），角色次之 */
export const PLOT_WEIGHTS = {
  /** 命中底线的原文锚点——这是教师明确点名要保的东西 */
  anchor: 3,
  /** 句子里的角色名（专名表） */
  name: 1.2,
  /** 数字：情节里的量（九只鸡、七诫、1911…） */
  number: 1,
  /** 因果连接词：情节因果链的显式标记 */
  causal: 0.8,
  /** 章节转折位置（章首/章尾） */
  position: 0.6,
} as const;

/** 归一化分母：约等于"两个原文锚点 + 一个角色"就到顶（避免满分通胀） */
export const PLOT_NORM = 7.2;

/** 因果连接词（英文叙事里承载因果的显式词） */
export const CAUSAL_MARKERS = [
  'because', 'therefore', 'so that', 'as a result', 'thus', 'hence',
  'in order to', 'so as to', 'if ', 'unless', 'otherwise', 'consequently',
  'for this reason', 'that is why', 'which meant', 'which made',
];

export interface PlotBaseline {
  /** 来源文件（人要知道这份先验是从哪来的） */
  source: string;
  /** 可直接逐字对齐的原文锚点（底线里被引用的英文片段） */
  anchors: string[];
  /** 角色/地名（来自项目专名表） */
  names: string[];
}

/** 纯功能词：以它开头或结尾的片段不是"可引用的锚点"（`and slavery` 这种） */
const FUNCTION_WORDS = new Set([
  'and', 'or', 'of', 'the', 'a', 'an', 'to', 'in', 'on', 'at', 'by', 'from', 'with', 'for',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'that', 'this', 'it', 'as', 'but', 'if',
]);

/**
 * 抽取底线里被引用的英文片段：引号内的、书名号内的、以及连续两个以上的拉丁词。
 *
 * 抽出来的是**可逐字对齐**的原文锚点——教师把这些写进底线，意思正是"这几句必须原样保留"。
 * 两个清洗规则都是为了"命中项要能贴给人看"：
 *   · 掐头去尾是功能词的片段丢掉（`of the`、`and slavery` 这类命中了对教师也没意义）；
 *   · 被更长锚点包含的短片段丢掉（`i have no wish to take life` 是长引文的子串，留着只是噪音）。
 */
export function extractAnchors(text: string): string[] {
  const out = new Set<string>();
  const add = (s: string): void => {
    for (const piece of s.split(/[/／|]/)) {
      const t = piece.trim().replace(/^[（(【《"“']+|[）)】》"”'，。、；：]+$/g, '');
      if (t.length < 5 || !/[A-Za-z]/.test(t)) continue;
      const words = t.split(/\s+/).filter(Boolean);
      if (words.length < 2) continue;
      const head = words[0]!.toLowerCase().replace(/[^a-z']/g, '');
      const tail = words[words.length - 1]!.toLowerCase().replace(/[^a-z']/g, '');
      if (FUNCTION_WORDS.has(head) || FUNCTION_WORDS.has(tail)) continue;
      out.add(t.toLowerCase());
    }
  };
  for (const m of text.matchAll(/["“]([^"”\n]{3,80})["”]/g)) add(m[1]!);
  for (const m of text.matchAll(/[《【]([^》】\n]{3,80})[》】]/g)) add(m[1]!);
  // 连续 2–7 个拉丁词（Manor Farm / Beasts of England / Four legs good, two legs bad）
  for (const m of text.matchAll(/\b[A-Za-z][A-Za-z'’-]*(?:\s+[A-Za-z'’-]+){1,6}\b/g)) add(m[0]);
  const all = [...out];
  // 丢掉被更长锚点包含的短片段
  return all.filter((a) => !all.some((b) => b !== a && b.includes(a))).sort();
}

/**
 * 显式锚点：底线里写 `锚点：windmill、gun`（或 `锚点: windmill, gun`）的行。
 * 这是给"教师知道、机器猜不到"的东西留的出口——**单词也收**（自动抽取那条路要求 ≥2 个词）。
 */
export function extractExplicitAnchors(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:[-*]\s*)?锚点\s*[:：]\s*(.+)$/);
    if (!m) continue;
    for (const piece of m[1]!.split(/[、,，;；|]/)) {
      const t = piece.trim().toLowerCase();
      if (t && /[A-Za-z]/.test(t)) out.add(t);
    }
  }
  return [...out];
}

export function parsePlotBaseline(text: string, properNames: Iterable<string>, source = ''): PlotBaseline {
  const explicit = extractExplicitAnchors(text);
  const auto = extractAnchors(text);
  return {
    source,
    // 显式锚点原样收（不参与"被更长锚点包含就丢掉"的清洗：那是教师亲手写的）
    anchors: [...new Set([...explicit, ...auto])].sort(),
    names: [...new Set([...properNames].map((n) => String(n).trim().toLowerCase()).filter(Boolean))],
  };
}

export interface PlotPart {
  label: string;
  /** 命中的条目（人话；空数组 = 这一项没命中） */
  hits: string[];
  weight: number;
}

export interface PlotSignal {
  /** 0–1。**只用于排序，不能升级为 blocker** */
  score: number;
  level: PlotLevel;
  /** 命中的底线条目（直接进卡片：教师要看得到"凭什么说高"） */
  hits: string[];
  /** 分项明细（可解释） */
  parts: PlotPart[];
}

const levelOf = (score: number): PlotLevel => (score >= 0.55 ? '高' : score >= 0.25 ? '中' : '低');

/**
 * 给一句话打情节先验分。
 *
 * `ctx` 只用于"章节转折位置"这一项：章首/章尾各两段是转折最常发生的地方。
 * **位置项是这里最弱的一项**，所以权重给得最低——它只是"值得多看一眼"的提示。
 */
export function plotSignalOf(
  sentence: string,
  baseline: PlotBaseline,
  ctx: { segIndex?: number; segCount?: number } = {},
): PlotSignal {
  const low = sentence.toLowerCase();
  const parts: PlotPart[] = [];

  const anchorHits = baseline.anchors.filter((a) => low.includes(a));
  parts.push({ label: '底线原文锚点', hits: anchorHits, weight: PLOT_WEIGHTS.anchor });

  const nameHits = baseline.names.filter((n) => new RegExp(String.raw`\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\b`).test(low));
  parts.push({ label: '角色/地名', hits: nameHits, weight: PLOT_WEIGHTS.name });

  const numHits = sentence.match(/\b\d+\b/g) ?? [];
  parts.push({ label: '数字', hits: [...new Set(numHits)], weight: PLOT_WEIGHTS.number });

  const causalHits = CAUSAL_MARKERS.filter((c) => low.includes(c.trim().toLowerCase()) && low.includes(c.toLowerCase()));
  parts.push({ label: '因果连接词', hits: [...new Set(causalHits.map((c) => c.trim()))], weight: PLOT_WEIGHTS.causal });

  const { segIndex, segCount } = ctx;
  const nearEdge = segIndex !== undefined && segCount !== undefined && (segIndex <= 1 || segIndex >= segCount - 2);
  parts.push({ label: '章节转折位置', hits: nearEdge ? ['章首/章尾'] : [], weight: PLOT_WEIGHTS.position });

  const raw = parts.reduce((n, p) => n + p.hits.length * p.weight, 0);
  const score = Math.max(0, Math.min(1, raw / PLOT_NORM));
  const hits = parts.flatMap((p) => p.hits.map((h) => `${p.label}：${h}`));
  return { score: Number(score.toFixed(3)), level: levelOf(score), hits, parts };
}

/** 卡片上那一行：机器估计 + 凭什么 */
export function plotLine(s: PlotSignal | undefined): string {
  if (!s) return '情节估计：未提供底线（**没算**，不是低）';
  if (!s.hits.length) return `情节估计：${s.level}（未命中底线元素）`;
  return `情节估计：${s.level}｜命中 ${s.hits.slice(0, 4).join('、')}${s.hits.length > 4 ? ` 等 ${s.hits.length} 项` : ''}`;
}

/* ────────────────────── 排序：只做 tie-breaker ────────────────────── */

/**
 * 把情节分作为**同风险档内的排序依据**。
 *
 * 明确写死在这里的规则（报告要求"不能升级为 blocker"）：
 *   · 它**不改变** `risk`（概率 × 后果），只在前者相等时起作用；
 *   · 它**不产生**任何拦截项——本函数返回的是排序键，不是判定。
 */
export function plotTieBreak(a: { risk: number; plot?: PlotSignal }, b: { risk: number; plot?: PlotSignal }): number {
  if (b.risk !== a.risk) return b.risk - a.risk;
  return (b.plot?.score ?? -1) - (a.plot?.score ?? -1);
}
