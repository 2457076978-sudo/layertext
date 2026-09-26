/**
 * 两轮调适 · R2 修订计划（B1 批次①，2026-09-26 抽取自 LayerText_AF两轮调适.mjs）· 唯一实现
 *
 * 管三件纯决策：两轮闸门（round:2 拒绝第三轮）/ 档位折算（反馈幅度→单元回退→退学词）/
 * 复写范围选定（检查出的难度问题段 ∪ 反馈维度段 ∪ 点名词段）。CLI（两轮调适.mjs）与
 * App（B1 批次②的执行器）同一实现——同输入必同输出。IO（读进度/标记文件、AI 复写、
 * 落盘）都在调用方；本模块只做决定。
 *
 * 抽取时两处**有意纠正**的旧行为（CHANGELOG 有记录）：
 * ① `--plan` 的"预计范围"旧代码是选定逻辑的第二份拷贝，且漏了 simpl 点名词段——
 *    现与执行侧同源，预计数与实际复写段对得上；
 * ② 旧 round2 在解析进度失败时静默当没有——现保持当没有，但闸门 reason 如实带出。
 */

import { MAGNITUDE_UNITS, parseTeacherFeedback, type CheckFinding, type TeacherFeedback } from './adaptcheck.js';

/** 档位折算的梯子（教材单元库的抽象面：CLI 从项目配置装填，测试用合成梯子） */
export interface Round2Ladder {
  /** 当前进度的梯子下标（<0 表示课标基础以下，无从再退） */
  currentIndex: number;
  /** 梯子级的人话名（"九上U3" / "课标基础"） */
  labelAt: (idx: number) => string;
  /** 该级引入的词 */
  wordsAt: (idx: number) => readonly string[];
  /** ≤该级的全部已学词 */
  learnedAt: (idx: number) => Set<string>;
  /** 教师手工词库（手工收录是教师的明确判断，单元回退不动它们） */
  manualWords: ReadonlySet<string>;
}

export interface Round2PlanInput {
  /** 进度文件原文（null=文件不存在）；解析失败按不存在处理（旧行为） */
  progressText: string | null;
  /** 终稿是否已在盘上（闸门条件之一） */
  hasFinal: boolean;
  feedbackRaw: string;
  /** 正文 simpl 标记的"太难"词（已小写；与文字反馈合并） */
  simplWords?: readonly string[];
  findings: readonly CheckFinding[];
  /** 源段（含 [P##] 标记） */
  srcSegs: readonly string[];
  /** 第一轮稿的段（与 srcSegs 平行对应） */
  r1Segs: readonly string[];
  /** 教材进度已设置（区别于 ladder 完整可折算——进度在而单元库缺时不谎报"未设置"） */
  progressSet: boolean;
  ladder: Round2Ladder | null;
  isKnownWord: (w: string) => boolean;
}

export interface Round2Plan {
  /** ok=false 时不得执行第二轮（原因含人话，可直接展示给教师） */
  gate: { ok: boolean; reason: string };
  /** true = 两轮已用完的拒绝（调用方走"终稿复检+剩余问题交教师"的展示分支） */
  exhausted: boolean;
  fb: TeacherFeedback;
  /** 整篇复写（维度≥4 或反馈含"整体/全部/全篇"） */
  whole: boolean;
  /** 待复写段下标（升序；以 r1Segs 下标为准） */
  targets: number[];
  /** true = 检查与反馈都没有指向需要复写的段——第一轮稿即最终稿 */
  empty: boolean;
  boundaryNote: string;
  /** 被单元回退掉的词（本轮按"未学"处理） */
  removedByLadder: string[];
}

export function planRound2(input: Round2PlanInput): Round2Plan {
  const fb = parseTeacherFeedback(input.feedbackRaw);
  /* 教师在正文里点的「要简化」标记 = 词级"太难"反馈，与文字反馈合并——
   * 点名几个词，第二轮举一反三处理同类难度表达，不只换点名词。 */
  const simpl = (input.simplWords ?? []).map((w) => w.toLowerCase());
  if (simpl.length) {
    for (const w of simpl) if (!fb.tooHardWords.includes(w)) fb.tooHardWords.push(w);
    fb.raw += `（正文标记太难：${[...new Set(simpl)].slice(0, 20).join(', ')}）`;
  }

  /* 两轮制闸门：两轮已用完就停止自动重试——剩余问题交教师修改，这是方向文档的硬规矩 */
  let gate = { ok: true, reason: '' };
  let exhausted = false;
  if (input.progressText !== null) {
    try {
      const j = JSON.parse(input.progressText);
      if (j.round >= 2 && input.hasFinal) {
        gate = { ok: false, reason: '两轮已用完——剩余问题交教师修改或说明保留，不再自动重试。' };
        exhausted = true;
      }
    } catch {
      /* 进度文件坏了当没有：往下走正常流程（旧行为） */
    }
  }

  /* 档位折算：有教材进度才回退；没有就按幅度收紧注释限额（如实报告，不假装精确）。
   * 退学词 = 被回退掉的单元里、不在更早边界、也不在教师手工词库里的词。 */
  let boundaryNote = '';
  const removedByLadder = new Set<string>();
  if (fb.magnitude && input.ladder) {
    const back = MAGNITUDE_UNITS[fb.magnitude];
    const idx = input.ladder.currentIndex;
    const newIdx = Math.max(-1, idx - back);
    const from = input.ladder.labelAt(idx);
    const to = input.ladder.labelAt(newIdx);
    const earlier = input.ladder.learnedAt(newIdx);
    for (let i2 = newIdx + 1; i2 <= idx; i2++)
      for (const w of input.ladder.wordsAt(i2)) {
        if (!earlier.has(w) && !input.ladder.manualWords.has(w)) removedByLadder.add(w);
      }
    boundaryNote = `词汇边界从 ${from} 回退到 ${to}（按你的反馈折算 ${back} 个单元——档位折算，不是精确换算）`;
  } else if (fb.magnitude && !input.progressSet) {
    boundaryNote = `未设置教材进度——"超前${fb.magnitude}"按注释限额收紧处理（跑 --progress 九上U5 可获得精确的单元回退）`;
  }

  /* 复写范围：检查出的难度级问题段 ∪ 反馈维度涉及的段（词汇→含超纲词段；句法→长句段；整体→全篇） */
  const whole = fb.dims.length >= 4 || /整体|全部|全篇/.test(fb.raw);
  const target = new Set<number>();
  if (whole) {
    input.srcSegs.forEach((_, k) => target.add(k));
  } else {
    for (let k = 0; k < input.r1Segs.length; k++) {
      const seg = input.r1Segs[k];
      /* 段号**去掉方括号**再比：引擎（adaptcheck）给的 segId 是 P03 形态，
       * 而 match(/\[P\d+\]/) 得到的是 [P03]。2026-09-14 之前直接拿带括号的去比，
       * 段级难度 finding 永远匹配不到自己的段；而注释拥挤/最长句/归因是整篇级
       * （没有 segId），对每一段都成立——两个错叠起来全篇密度问题会把每一段都标进。 */
      const segId = (seg.match(/\[P\d+\]/)?.[0] ?? '').replace(/[[\]]/g, '');
      const segFindings = input.findings.filter((f) => f.level === '难度' && (f.segId === segId || !f.segId || f.note.includes('注释拥挤') || f.note.includes('最长句') || f.note.startsWith('归因')));
      if (segFindings.length) target.add(k);
      if (fb.dims.includes('词汇')) {
        const hard = [...seg.matchAll(/[A-Za-z][A-Za-z'-]*/g)].map((m) => m[0].toLowerCase()).filter((w) => !input.isKnownWord(w) || removedByLadder.has(w));
        if (hard.length >= 2) target.add(k);
      }
    }
    /* 教师点名的词：含这些词的段必进 */
    for (let k = 0; k < input.r1Segs.length; k++) {
      const low = input.r1Segs[k].toLowerCase();
      if (fb.tooHardWords.some((w) => low.includes(w))) target.add(k);
    }
  }
  const targets = [...target].sort((a, b) => a - b);

  return { gate, exhausted, fb, whole, targets, empty: targets.length === 0, boundaryNote, removedByLadder: [...removedByLadder] };
}

/* ────────── ②a（2026-09-26）：R2 提示词与报告的共享端口——CLI 与 App 同一文本 ──────────
 * 批次③的 D 验收（App 路径与 CLI 路径产物 byte-equal）依赖这些函数是唯一实现；
 * 从 LayerText_AF两轮调适.mjs 逐字搬移，改这里必须同步核 mjs 侧已改为消费本实现。 */

/** 三维目标矩阵（2026-09-12 定稿；同日考试证据校准）——与 mjs 的 TIERS 同一数据 */
export interface R2Tier {
  key: 'A' | 'M' | 'B';
  label: string;
  clsTag: string;
  ratioRef: number;
  goal: string;
  words: string;
  syntax: string;
  reference: string;
  anno: string;
}

export const R2_TIERS: Record<'A' | 'M' | 'B', R2Tier> = {
  A: {
    key: 'A',
    label: 'A层（挑战）',
    clsTag: 'A层85',
    ratioRef: 0.85,
    goal: '独立读通，保留少量原文表达',
    words: '熟词优先；必要难词少量保留（每段最多 2 个加注词）；近义词保留其一并让上下文把词义衬出（词义深度是本层短板，保留≠默认已懂）',
    syntax: '简单句为主',
    reference: '有歧义就补出人物名字；衔接词（however/so/because/then 等）保留，句际转折因果不省',
    anno: '支持少量必要词；注释带词形家族（care→cared→caring 同注）',
  },
  M: {
    key: 'M',
    label: 'M层（中层）',
    clsTag: 'M层75',
    ratioRef: 0.75,
    goal: '更直接、少推断',
    words: '非必要难词原则上替换（词汇尽量全落在课标内，每段最多 1 个加注词）；功能词（介词/冠词/连词/代词）显性保留——本层功能词证据同样偏弱',
    syntax: '拆开嵌套关系；整句结构模板化：主谓宾完整句优先，避免碎片化短句串',
    reference: '人物切换时明确名字；衔接词显性化，禁连续代词指代',
    anno: '更少引入新词；允许补解释；注释带词形家族',
  },
  B: {
    key: 'B',
    label: 'B层（基础）',
    clsTag: 'B层60',
    ratioRef: 0.6,
    goal: '明确人物、动作和因果（读懂为主；核心词的形式认得即可，形式产出靠课堂专项不靠文本）',
    words: '尽量用核心常用词；核心词的词形家族同段复现（读到原形也读到变形）',
    syntax: '一句主要表达一件事',
    reference: '避免连续多句依靠代词；衔接词显性化（so/because/then 写出来，不靠读者脑补）',
    anno: '必要概念可集中预教；允许比 M 层更长；注释带词形家族，注释词即跟读/听写候选',
  },
};

/** R2 系统提示词（与 mjs systemPrompt 同一文本） */
export function round2SystemPrompt(tierKey: 'A' | 'M' | 'B', annoCap?: number): string {
  const t = R2_TIERS[tierKey];
  return `你是面向中国初中生的英语阅读文本调适助手。目标是让指定学生读通英文、理解情节，同时保留必要的学习空间。
本档定位——${t.goal}。
【词汇】${t.words}。超出学生词库的实词：能换则换成熟词；必要概念用简单英文解释；最后才加注，且每段注释不超过 ${annoCap ?? (t.key === 'A' ? 2 : 1)} 处。不以密集注释补救整体过难的英文。
【句式】${t.syntax}；说清必要的时间顺序和因果关系，避免一句承载过多信息。
【指代】${t.reference}。
【篇幅】参考原文的约 ${Math.round(t.ratioRef * 100)}%，这只是参考：不为缩短删掉人物提示、原因和解释；允许用更多短句讲清一件事；B 层允许比 M 层更长。
【保真】保留人物关系、关键事件、数字、否定、因果与叙事顺序。可以补清原文已支持的关系，不得编造背景、动机或事件。专名不译不改，人物称谓前后一致。
【教师审校知识库（历史成果，必须遵守）】教师确认学生不会的词若保留必须紧跟 word（中文）加注；教师多次换掉的词优先换简单说法。
输出：保持 [P##] 标记开头，直接输出改写文本（纯英文，除注释外无中文），不解释。`;
}

const DIM_WORD: Record<string, string> = {
  plot: '情节顺序与事件',
  characters: '人物关系与称谓',
  syntax: '句式结构',
  vocabulary: '已定稿的词汇选择',
  coherence: '已清楚的衔接与指代',
  background: '背景交代',
  support: '注释安排',
};

/** 把"保护维度"翻译进第二轮 prompt 的硬约束（facts 恒在，不再单列） */
export function protectionLine(protectedDimensions: readonly string[]): string {
  const dims = protectedDimensions.filter((d) => d !== 'facts');
  return dims.length ? `教师明确认可的方面（本轮禁改）：${dims.map((d) => DIM_WORD[d] ?? d).join('、')}。数字、否定与因果关系任何情况下不得改变。` : '数字、否定与因果关系任何情况下不得改变。';
}

/** R2 单段复写的 user prompt（与 mjs round2 内联模板同一文本） */
export function round2SegPrompt(a: {
  fbRaw: string;
  boundaryNote: string;
  removedByLadder: readonly string[];
  reasons: readonly string[];
  srcSeg: string;
  r1Seg: string;
  marker: string;
  protectedDimensions: readonly string[] | null;
}): string {
  return `教师读了第一轮稿后反馈（原话）：「${a.fbRaw}」
${a.boundaryNote ? `词汇边界调整：${a.boundaryNote}。` : ''}${a.removedByLadder.length ? `\n以下 ${a.removedByLadder.length} 个词本轮按"未学"处理（教材回退），换成熟词或用简单英文解释：${a.removedByLadder.slice(0, 40).join(', ')}${a.removedByLadder.length > 40 ? ' …' : ''}` : ''}
本段的具体问题：${a.reasons.length ? a.reasons.join('；') : '（按反馈维度整体处理）'}
请复写下面这一段，要求：优先替换非必要难词；拆清动作和关系；${a.protectedDimensions ? protectionLine(a.protectedDimensions) : '保留人物、事件、数字、否定与因果'}（${a.srcSeg.includes(' not ') || /never|no /i.test(a.srcSeg) ? '本段含否定表达，方向不能反' : ''}）；不得只删中文注释而英文不变容易；从教师点名的词举一反三，同类难度的表达一并处理。
第一轮稿（待复写）：
${a.r1Seg.trim()}
输出：保持 ${a.marker} 标记开头，直接输出复写文本。`;
}

/** 清洗模型返回的单段（与 mjs cleanSeg 同一逻辑）：剥代码围栏；丢标记则补回 */
export function cleanR2Seg(text: string, marker: string): string {
  let t = text
    .trim()
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/```\s*$/, '');
  if (!t.includes('[P')) t = marker + ' ' + t;
  return t.trim();
}

/** 调适报告 md（与 mjs writeReport 的正文同一文本；写盘与摘要归调用方） */
export function buildAdaptReportMd(r: {
  ch: string;
  tierKey: 'A' | 'M' | 'B';
  profile: { words: number; annos: number; densityPer100: number | string; worstWindow?: { density: number; head?: string } | null; longestSentence?: { words: number } | null };
  findings: readonly CheckFinding[];
  ratio: number;
  isFinal: boolean;
  fb?: { raw: string; dims: string[]; keep: string[]; magnitude: string | null } | null;
  boundaryNote?: string;
  changed?: number;
  changedNotes?: readonly string[];
}): string {
  const t = R2_TIERS[r.tierKey];
  const structural = r.findings.filter((f) => f.level === '结构');
  const info = r.findings.filter((f) => f.level === '信息变化');
  const hard = r.findings.filter((f) => f.level === '难度');
  const status = structural.length ? '待处理（结构问题阻止发布）' : '可发布（供人工校对）';
  const L = [
    `# 调适报告 · ${r.ch} · ${t.label}`,
    '',
    `> 状态：**${status}**。语言检查通过≠学生一定读得懂、情节完全正确；数字与专名检查不能代替情节保真。`,
    `> 阈值为工程试运行阈值（注释密度 ${{ A: 6, M: 4, B: 3 }[r.tierKey]}、句长 ${{ A: 20, M: 17, B: 14 }[r.tierKey]}），非教学标准。`,
    '',
    `## 负担剖面（${r.isFinal ? '终稿' : '初稿'}）`,
    `- 英文词数 ${r.profile.words}｜注释 ${r.profile.annos} 处｜全文每百词 ${r.profile.densityPer100} 处`,
    `- 最拥挤窗口：每百词 ${r.profile.worstWindow?.density ?? '—'} 处（起于「${r.profile.worstWindow?.head ?? '—'}…」）`,
    `- 最长句 ${r.profile.longestSentence?.words ?? 0} 词`,
    `- 篇幅/原文：${(r.ratio * 100).toFixed(0)}%（参考项）`,
  ];
  if (r.fb) {
    L.push(
      '',
      '## 教师反馈与折算',
      `- 反馈原话：「${r.fb.raw}」`,
      `- 解析：处理维度 ${r.fb.dims.join('/') || '（未识别，按原话整体参考）'}；保留维度 ${r.fb.keep.join('/') || '—'}；幅度 ${r.fb.magnitude ?? '—'}`,
    );
    if (r.boundaryNote) L.push(`- ${r.boundaryNote}`);
    if (r.changedNotes?.length) L.push('', `## 第二轮修改（${r.changed} 段，单段最多两次尝试，无自动重试）`, ...r.changedNotes.slice(0, 20).map((n) => `- ${n}`));
  }
  L.push('', '## 分级清单');
  if (structural.length) L.push('### 结构（阻止发布）', ...structural.map((f) => `- ✗ ${f.note}`));
  if (info.length) L.push('### 信息变化（请人工确认，不当场判错）', ...info.map((f) => `- ⚠ ${f.note}`));
  L.push('### 难度（已交第二轮；仍存在允许教师修改或说明保留）', ...(hard.length ? hard.map((f) => `- · ${f.note}`) : ['- 无']));
  return L.join('\n') + '\n';
}
