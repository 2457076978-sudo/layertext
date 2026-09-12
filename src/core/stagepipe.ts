// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，本仓库已部署版权验证体系，细节不予公开（docs/版权与授权.md）。
/**
 * 工序化调适 · 编排核心（四方向方案 v2 方向一/批次 1）
 *
 * 把「词汇粗筛 → 句法调适 → 词汇复筛 → 连贯性 → 最终加注」这道循环做成纯函数编排：
 *   本地扫描（stagescan）→ 只把命中段送 AI（注入的 callStage）→ 解析差量 patch
 *   （stagepatch）→ 门禁 → 合并 → 检查点。AI 调用是**注入**的——本模块可在无网络、
 *   无 key 的单测里完整跑一遍编排与失败路径。
 *
 * 三条硬纪律的落点：
 *   · 无风险段零调用：scanFor 空清单的段不进任何请求；
 *   · 失败候选不传下一道：被门禁拒绝且重试用尽的段进隔离名单，后续工序跳过它；
 *   · 前一道新引入词必须进下一道筛查：vocab-secondary 以**原文全章**为差集基准，
 *     用 introducedHardWords 抓出管线任意一道引入的词表外词。
 *
 * 纯逻辑：不读文件、不调网络、不写盘。进度落盘与隔离目录由管线（tools/）管。
 */

import {
  Stage, STAGE_ORDER, STAGE_LABEL, StagePatchRequest,
  parseStagePatch, gatePatches, mergePatch, GateSegCtx,
} from './stagepatch.js';
import type { GatedPatches } from './stagepatch.js';
/** 门禁拒绝条目（stagepatch 的结构，编排里只透传） */
type GatedBlocked = GatedPatches['blocked'];
import { ScanCtx, ScanSeg, scanFor, annotationTargets } from './stagescan.js';
import { annotatableOf } from './segmentgate.js';

/* ────────────────────── 工序指令（默认文案；管线可整体覆盖） ────────────────────── */

export type StageInstructions = Record<Stage, string>;

export function defaultInstructions(): StageInstructions {
  return {
    'vocab-primary':
      '把该段里学生词库外的实词换成学生已学的说法（同义转换，不是删减）；句式保持不动；' +
      '专名、数字、否定、因果一个不能丢；此刻不要加任何中文注释。只处理给出的问题段。',
    syntax:
      '只处理句子结构：把超长句拆成短句、被动改主动、定语从句拆开、过去完成改成一般过去时并用 before/after 明示先后；' +
      '不改变词汇难度（上一道换好的词保持）；直接引语只降词不降句式；情节零丢失。只处理给出的问题段。',
    'vocab-secondary':
      '上一道工序可能引入了新的词表外词：把它们再换成学生已学的说法；其余内容保持不动。只处理给出的问题段。',
    coherence:
      '按给出的具体问题处理衔接与指代：把指代不明处补出人物名字、把断掉的因果关系接清；' +
      '数字、专名、否定、因果一个不能丢；不简化词汇、不拆并句子。只处理给出的问题段。',
    annotation:
      '给列出的待注词在本段首次出现处加注，格式 word（中文），释义用给出的建议释义；' +
      '每个词只注一次；不改动英文内容本身。text 里除 word（中文）注释外不得出现任何中文；' +
      '说明与理由只能写在 reason 字段。只处理给出的问题段。',
  };
}

/* ────────────────────── 编排 ────────────────────── */

export type StagePipeSeg = ScanSeg;

export interface StageCheckpoint {
  stage: Stage;
  called: boolean;
  /** 本章版本号：每次成功 commit +1；未调用保持上一号 */
  version: number;
  changedIds: string[];
  blockedIds: string[];
  /** 解析层与门禁层的拒绝原因（留痕：失败回放与教师可解释性） */
  problems: string[];
  /** 本道工序的候选段（零调用判定的事实依据） */
  candidateIds: string[];
}

export interface QuarantinedSeg {
  stage: Stage;
  id: string;
  reason: string;
  tries: number;
}

export interface StagePipeEvent {
  kind: 'stage-start' | 'stage-skip' | 'stage-commit' | 'stage-fail' | 'seg-quarantined';
  stage: Stage;
  detail?: string;
}

export interface StagePipeOpts {
  chapter: string;
  tier: 'A' | 'M' | 'B';
  /** 稿本身份（进 recap；协议只透传） */
  sourceVersion: string;
  segs: StagePipeSeg[];
  knownWords: Set<string>;
  properNouns: string[];
  /** 层句长上限（门禁 SENT-01 用；生成口径由调用方定，本模块不查表） */
  maxLen: number;
  /** 篇幅比例（LEN-01 的目标 = 原文词数 × ratio） */
  ratio: number;
  /** 注入的 AI 调用：收请求、回模型原始文本（本模块负责解析与校验） */
  callStage: (req: StagePatchRequest) => Promise<string>;
  /** 书级已注词账本（跨章一词一注的种子）；默认空 */
  glossary?: Map<string, string>;
  instructions?: StageInstructions;
  /** 单段每道工序的最大尝试次数（默认 2：首次 + 带失败原因的重试） */
  maxStageTries?: number;
  /** 每次请求的段数上限（默认 8：防一次请求的 patch 输出被 max_tokens 截断） */
  chunkSize?: number;
  /** 加注配额：每段必注词上限（A2/M1/B3，层定义决定；不传=全量必注） */
  annoCapPerSeg?: number;
  /** 教师知识库必注词（配额内优先） */
  mustAnnotate?: Set<string>;
  /** 注入的确定性加注器：本段文本 + 必注清单 → 注好释的段文本。给了它，
   *  annotation 工序完全本地化（能本地确定性解决绝不引 AI——方案 §4.2）：
   *  词典有释义就地插入；缺释义由注入方自己批量问模型**只要词义**，不让模型重写段落。
   *  模型"返回插好注释的整段"实测随机漏注/混中文/顺手改写（2026-09-12 A7 五轮实跑），此路封死。 */
  annotate?: (draft: string, targets: { need: string[]; extra: number }, segId: string) => Promise<string>;
  /** 释义建议（加注工序 prompt 用；词→中文），默认空——管线通常传统一词典命中部分 */
  glossHints?: Map<string, string>;
  onEvent?: (e: StagePipeEvent) => void;
}

export interface StagePipeResult {
  text: Record<string, string>;
  checkpoints: StageCheckpoint[];
  quarantined: QuarantinedSeg[];
  /** 每道工序的候选段（验收：无风险段零调用的事实依据） */
  scans: Record<string, string[]>;
  finalVersion: number;
}

const SEG_WORD_RE = /[A-Za-z][A-Za-z'-]*/g;
const segWords = (t: string): number => (t.match(SEG_WORD_RE) ?? []).length;

/** 重试池条目：段 + 本地扫描出的问题清单；重试时附上一次被拒的原因 */
interface PoolItem {
  seg: StagePipeSeg;
  issues: string[];
  rejectReason?: string;
}

export async function runStagePipeline(opts: StagePipeOpts): Promise<StagePipeResult> {
  const maxTries = opts.maxStageTries ?? 2;
  const instructions = opts.instructions ?? defaultInstructions();
  const glossary = new Map(opts.glossary ?? []);
  const emit = (e: StagePipeEvent): void => opts.onEvent?.(e);

  let text: Record<string, string> = Object.fromEntries(opts.segs.map((s) => [s.id, s.source]));
  let version = 0;
  const checkpoints: StageCheckpoint[] = [];
  const quarantined: QuarantinedSeg[] = [];
  const quarantinedIds = new Set<string>();
  const scans: Record<string, string[]> = {};
  /* 词汇复筛的差集基准 = 原文全章（与 adaptcheck 引入词口径一致：对原文取差，
   * 不是对上一道产稿取差——产稿自己引入的词在产稿里，差集恒空）。 */
  const prevStageText: string | undefined = opts.segs.map((s) => s.source).join('\n\n');

  for (const stage of STAGE_ORDER) {
    const ctx: ScanCtx = {
      tier: opts.tier, knownWords: opts.knownWords, properNouns: opts.properNouns,
      glossary, prevStageText,
      annoCap: stage === 'annotation' ? opts.annoCapPerSeg : undefined,
      mustAnnotate: opts.mustAnnotate,
    };
    const active = opts.segs.filter((s) => !quarantinedIds.has(s.id));
    const candidates: PoolItem[] = active
      .map((s) => ({ seg: s, issues: scanFor(stage, { ...s, draft: text[s.id] }, ctx) }))
      .filter((x) => x.issues.length > 0);
    scans[stage] = candidates.map((x) => x.seg.id);

    if (!candidates.length) {
      checkpoints.push({ stage, called: false, version, changedIds: [], blockedIds: [], problems: [], candidateIds: [] });
      emit({ kind: 'stage-skip', stage, detail: '本地扫描无命中，零调用' });
      continue;
    }

    /* 加注工序的确定性路径：词典优先就地插入，不经 patch 协议（见 opts.annotate 注释） */
    if (stage === 'annotation' && opts.annotate) {
      const changedIds: string[] = [];
      const problems: string[] = [];
      for (const x of candidates) {
        const before = text[x.seg.id];
        let after: string;
        try {
          after = await opts.annotate(before, annotationTargets(before, ctx), x.seg.id);
        } catch (e) {
          problems.push(`${x.seg.id} 加注失败：${String(e).slice(0, 120)}`);
          continue;
        }
        if (after !== before) {
          text[x.seg.id] = after;
          changedIds.push(x.seg.id);
        }
      }
      if (changedIds.length) version++;
      checkpoints.push({ stage, called: changedIds.length > 0, version, changedIds, blockedIds: [], problems, candidateIds: candidates.map((x) => x.seg.id) });
      emit({ kind: changedIds.length ? 'stage-commit' : 'stage-fail', stage, detail: changedIds.length ? `v${version}：注 ${changedIds.length} 段（确定性插入）` : '加注零段落盘' });
      continue;
    }

    emit({ kind: 'stage-start', stage, detail: `${candidates.length}/${active.length} 段命中` });
    const problems: string[] = [];
    let pool: PoolItem[] = candidates;
    let attempt = 0;
    const changedAll = new Set<string>();
    let committed = false;
    /* 候选段分批：一章几十段塞一个请求会被输出上限截断（截断的 JSON 只能整批作废）。
     * 分批只影响调用形状，不影响协议——每批仍是独立请求+解析+门禁+合并。 */
    const chunkSize = opts.chunkSize ?? 8;
    const chunksOf = (items: PoolItem[]): PoolItem[][] => {
      const out: PoolItem[][] = [];
      for (let i = 0; i < items.length; i += chunkSize) out.push(items.slice(i, i + chunkSize));
      return out;
    };

    while (pool.length && attempt < maxTries) {
      attempt++;
      const blockedThisAttempt: GatedBlocked = [];
      let callFailed = false;

      for (const chunk of chunksOf(pool)) {
        const targetOf = (x: PoolItem): number => Math.round(segWords(x.seg.source) * opts.ratio);
        const req: StagePatchRequest = {
          stage,
          baseVersion: `v${version}`,
          segments: chunk.map((x) => ({
            id: x.seg.id,
            source: x.seg.source,
            draft: text[x.seg.id],
            issues: [
              /* 每段目标词数给到所有改写工序：守恒从第一道就开始，别等终检才发现跑偏 */
              `本段输出目标约 ${targetOf(x)} 词（±10%）`,
              ...x.issues,
              ...(x.rejectReason ? [`上一次尝试被拒绝的原因（必须解决）：${x.rejectReason}`] : []),
            ],
          })),
          protectedFacts: [],
          instruction: instructions[stage],
        };
        const gateCtx: GateSegCtx[] = chunk.map((x) => ({
          id: x.seg.id,
          source: x.seg.source,
          /* LEN-01 只在句法/加注两道生效（STAGE_BLOCK_RULES），目标 = 原文词数 × 层比例 */
          target: stage === 'syntax' || stage === 'annotation' ? Math.round(segWords(x.seg.source) * opts.ratio) : 0,
          maxLen: opts.maxLen,
          /* ANNO-01 只在加注工序点生效：应注集 = annotationTargets（教师知识库优先、
           * 层配额封顶）——与写进 prompt 的是同一份清单（scanFor 也引它）。 */
          oov: stage === 'annotation' ? annotatableOf(annotationTargets(text[x.seg.id], ctx).need) : [],
        }));
        /* 事实守卫不在这里自动抽取：signalsOf 的子串口径比 gateSegment 用的 lostSignals
         * 粗糙（句首大写词、1st→first 都会被误判丢失——2026-09-12 A 层第七章实跑误杀 20 段）。
         * 事实判定的唯一口径是 lostSignals（FACT-01/02，连贯性工序点拦截）；
         * protectedFacts 留给调用方显式传入教师点名的保护词（方向二任务单）。 */
        const protectedFacts: Record<string, string[]> = {};

        let parsed: ReturnType<typeof parseStagePatch>;
        try {
          const raw = await opts.callStage(req);
          parsed = parseStagePatch(raw, chunk.map((x) => x.seg.id));
        } catch (e) {
          /* 调用层失败（网络/HTTP）：本批作废，段保持上一版；如实记录，不伪造 patch */
          problems.push(`第 ${attempt} 次调用失败（${chunk.map((x) => x.seg.id).join(',')}）：${String(e).slice(0, 160)}`);
          callFailed = true;
          continue;
        }
        problems.push(...parsed.problems.map((p) => `[${STAGE_LABEL[stage]} 尝试${attempt}] ${p}`));
        if (!parsed.ok || !parsed.result) continue;

        const gated = gatePatches(parsed.result, gateCtx, { stage, protectedFacts });
        const merged = mergePatch(text, { patches: gated.items, baseVersion: '' });
        text = merged.text;
        merged.changedIds.forEach((id) => changedAll.add(id));
        committed = true;
        blockedThisAttempt.push(...gated.blocked);
      }

      if (callFailed && attempt >= maxTries) break;
      const retryables = attempt < maxTries ? blockedThisAttempt : [];
      if (retryables.length) {
        /* 只重试被拒的段，把拒绝原因带进 issues（第二次尝试的模型看得见自己错在哪） */
        const rbMap = new Map(retryables.map((b) => [b.id, b.reason]));
        pool = pool
          .filter((x) => rbMap.has(x.seg.id))
          .map((x) => ({ ...x, rejectReason: rbMap.get(x.seg.id) ?? '' }));
        continue;
      }
      for (const b of blockedThisAttempt) {
        quarantined.push({ stage, id: b.id, reason: b.reason, tries: attempt });
        quarantinedIds.add(b.id);
        emit({ kind: 'seg-quarantined', stage, detail: `${b.id}：${b.reason}` });
      }
      break;
    }

    if (committed) version++;
    checkpoints.push({
      stage, called: committed, version,
      changedIds: [...changedAll],
      blockedIds: quarantined.filter((q) => q.stage === stage).map((q) => q.id),
      problems, candidateIds: candidates.map((x) => x.seg.id),
    });
    if (committed) emit({ kind: 'stage-commit', stage, detail: `v${version}：改 ${changedAll.size} 段` });
    else if (problems.length) emit({ kind: 'stage-fail', stage, detail: problems[0] });
  }

  /* 加注账本回填：从终稿提取 word（中文）对，供跨章一词一注与 recap */
  for (const t of Object.values(text)) {
    for (const m of t.matchAll(/([A-Za-z][A-Za-z'-]*)（([^）（]*)）/gu)) {
      const w = m[1]!.toLowerCase();
      if (!glossary.has(w)) glossary.set(w, m[2]!);
    }
  }

  return { text, checkpoints, quarantined, scans, finalVersion: version };
}

/* ────────────────────── ChapterRecap（批次 3 · 本地确定性构建） ────────────────────── */

/**
 * 章末 recap：**从本地结构化数据构建**，不调模型（方案 §7.2：本地确定性优先）。
 * recap 是给下一次会话/下一章读的缓存，不是事实源——事实源是版本节点、检查点、
 * 词库快照与隔离记录本身。摘要与本地事实冲突时，本地优先（recap 由本地派生，
 * 构造上就不会冲突；模型另写的 recap 必须过 isChapterRecap 校验）。
 */
export interface ChapterRecap {
  chapter: string;
  tier: 'A' | 'M' | 'B';
  sourceVersion: string;
  draftVersion: string;
  stageResults: Array<{ stage: Stage; version: number; changed: number; blocked: number; called: boolean }>;
  /** 本章终稿的加注对（word→释义）：下一章的一词一注种子 */
  acceptedTerms: Array<{ word: string; action: string; gloss?: string }>;
  /** 未解决的开口问题：隔离段（终稿复扫的注释缺口由管线追加） */
  openIssues: Array<{ segment: string; kind: string }>;
  quarantined: Array<{ segment: string; stage: Stage; reason: string }>;
}

export function buildChapterRecap(opts: StagePipeOpts, run: StagePipeResult): ChapterRecap {
  const acceptedTerms: ChapterRecap['acceptedTerms'] = [];
  const seen = new Set<string>();
  for (const t of Object.values(run.text)) {
    for (const m of t.matchAll(/([A-Za-z][A-Za-z'-]*)（([^）（]*)）/gu)) {
      const w = m[1]!.toLowerCase();
      if (!seen.has(w)) {
        seen.add(w);
        acceptedTerms.push({ word: w, action: 'keep', gloss: m[2] });
      }
    }
  }
  return {
    chapter: opts.chapter,
    tier: opts.tier,
    sourceVersion: opts.sourceVersion,
    draftVersion: `v${run.finalVersion}`,
    stageResults: run.checkpoints.map((c) => ({
      stage: c.stage, version: c.version, changed: c.changedIds.length, blocked: c.blockedIds.length, called: c.called,
    })),
    acceptedTerms,
    openIssues: run.quarantined.map((q) => ({ segment: q.id, kind: `quarantined@${q.stage}` })),
    quarantined: run.quarantined.map((q) => ({ segment: q.id, stage: q.stage, reason: q.reason })),
  };
}

/** 模型写的 recap 必须过 schema 校验才能用（会话改写章末摘要升级的入口；本地优先的执行点） */
export function isChapterRecap(obj: unknown): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const o = obj as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return { ok: false, problems: ['recap 不是对象'] };
  for (const k of ['chapter', 'sourceVersion', 'draftVersion']) {
    if (typeof o[k] !== 'string' || !(o[k] as string)) problems.push(`${k} 缺失或不是非空字符串`);
  }
  if (o.tier !== 'A' && o.tier !== 'M' && o.tier !== 'B') problems.push('tier 必须是 A/M/B');
  if (!Array.isArray(o.stageResults)) problems.push('stageResults 缺失或不是数组');
  return { ok: problems.length === 0, problems };
}
