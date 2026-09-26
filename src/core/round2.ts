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
