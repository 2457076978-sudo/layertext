/**
 * R2 第二轮修订 · App 执行器与按钮状态机（B1 批次②b，2026-09-26）
 *
 * 决策与文本的唯一实现都在 src/core/round2.ts（planRound2 / 提示词 / 报告）；
 * 本模块只做 IO 编排：读反馈/任务单/进度/R1/原文 → 组装 planRound2 输入 →
 * 逐段 AI 复写 → 写终稿/进度/调适报告。产物口径与 CLI
 * （tools/af_pipeline/LayerText_AF两轮调适.mjs --round2）一致（批次③ D 验收锁）。
 *
 * node 测试可达性纪律（与 review.ts 同一条）：静态依赖只引 state/types/core
 * 这类 node-safe 模块；ai.ts（`?raw` prompts）与 datapanel（避环）一律动态 import。
 */

import { invoke } from '@tauri-apps/api/core';
import { setStatus } from './state.js';
import type { FileSession } from './types.js';
import { buildAdaptReportMd, cleanR2Seg, planRound2, round2SegPrompt, round2SystemPrompt, type Round2Ladder } from '../../src/core/round2.js';
import { burdenFindings, fidelityFindings, introducedHardWords, type CheckFinding } from '../../src/core/adaptcheck.js';
import { hit } from '../../src/core/textpipe.js'; /* 词形判定用引擎唯一实现（与管线同尺——两套 hit 语义不同的旧坑，见 adaptcheck 注释 */

/* ────────── 目标定位（从 review.ts 移来：r2 执行与反馈框共用一份） ────────── */

const ADAPT_NAME_RE = /原文_(A层85|M层75|B层60)_/;

export interface AdaptTarget {
  tierKey: 'A' | 'M' | 'B';
  tag: string;
  chapDir: string;
  outRoot: string;
  feedbackPath: string;
  taskPath: string;
}

export function adaptTargetOf(sourcePath: string | null): AdaptTarget | null {
  const m = sourcePath?.match(ADAPT_NAME_RE);
  if (!m || !sourcePath) return null;
  const dir = sourcePath.slice(0, sourcePath.lastIndexOf('/'));
  const chapDir = dir.split('/').pop() ?? '';
  const outRoot = dir.slice(0, dir.lastIndexOf('/'));
  if (!chapDir || !outRoot) return null;
  return {
    tierKey: m[1]![0] as 'A' | 'M' | 'B',
    tag: m[1]!,
    chapDir,
    outRoot,
    feedbackPath: `${outRoot}/_运行/调适反馈_${m[1]}_${chapDir}.json`,
    taskPath: `${outRoot}/_运行/调适任务单_${m[1]}_${chapDir}.json`,
  };
}

/* ────────── 按钮状态机（三条件；纯函数，DOM 测试直锁） ────────── */

export interface R2ButtonConds {
  confirmed: boolean;
  /** 打开的必须是本层的 R1 初稿（R2 读盘上的 R1，不看会话内未存的改动） */
  isR1: boolean;
  feedbackText: string | null;
  gateOk: boolean;
  gateReason: string;
}

export function r2ButtonState(c: R2ButtonConds): { disabled: boolean; title: string; label: string } {
  if (!c.confirmed) return { disabled: true, title: '先在上方点「开始修订」确认任务单', label: '▶ 开始第二轮修订' };
  if (!c.isR1) return { disabled: true, title: '请先打开本层的 R1 初稿（文件名带 _R1）再执行第二轮', label: '▶ 开始第二轮修订' };
  if (c.feedbackText === null) return { disabled: true, title: '反馈文件不在了（_运行/调适反馈_*.json）——重新保存一次反馈', label: '▶ 开始第二轮修订' };
  if (!c.gateOk) return { disabled: true, title: c.gateReason, label: '▶ 开始第二轮修订' };
  return { disabled: false, title: '按已确认的任务单复写选定段落：只改红项段与反馈指向的段，写终稿+调适报告（R1 保留）', label: '▶ 开始第二轮修订' };
}

/** 收集三条件（读盘；gate 复用 core.planRound2 的判定，不自算） */
export async function gatherR2ButtonConds(sourcePath: string | null, confirmed: boolean): Promise<R2ButtonConds> {
  const target = adaptTargetOf(sourcePath);
  const isR1 = !!sourcePath && /_R1\.md$/.test(sourcePath);
  let feedbackText: string | null = null;
  if (target) {
    try {
      feedbackText = JSON.parse(await invoke<string>('read_text_file', { path: target.feedbackPath })).text ?? null;
    } catch {
      /* 有意兜底：反馈文件不在=条件不满足，按钮状态机会把「反馈文件不在了」说出来 */
    }
  }
  let gateOk = true;
  let gateReason = '';
  if (target) {
    const pf = `${target.outRoot}/_运行/两轮调适进度_${target.tag}_${target.chapDir}.json`;
    const dst = `${target.outRoot}/${target.chapDir}/原文_${target.tag}_${sourcePath?.match(/原文_[A-Z]层\d+_(\d{4}-\d{2}-\d{2})/)?.[1] ?? ''}.md`;
    let progressText: string | null = null;
    try {
      progressText = await invoke<string>('read_text_file', { path: pf });
    } catch {
      /* 有意兜底：无进度文件=首轮还没跑完或没跑过——闸门放行，执行时还有任务单硬闸 */
    }
    let hasFinal = false;
    try {
      await invoke('describe_path', { path: dst });
      hasFinal = true;
    } catch {
      /* 有意兜底：describe_path 失败=终稿不在（闸门第二条件为否） */
    }
    /* 闸门判定唯一实现=core.planRound2（传空输入只为 gate；选定结果弃用） */
    const gate = planRound2({
      progressText,
      hasFinal,
      feedbackRaw: feedbackText ?? '',
      findings: [],
      srcSegs: [],
      r1Segs: [],
      progressSet: false,
      ladder: null,
      isKnownWord: () => true,
    });
    gateOk = gate.gate.ok;
    gateReason = gate.gate.reason;
  }
  return { confirmed, isR1, feedbackText, gateOk, gateReason };
}

/* ────────── 执行器 ────────── */

const SEG_RE = /\[P\d+\][\s\S]*?(?=\[P\d+\]|$)/g;
const wc = (t: string): number => (t.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).length;

async function readOptional(path: string): Promise<string | null> {
  try {
    return await invoke<string>('read_text_file', { path });
  } catch {
    /* 有意兜底：读不到=没有（调用方按缺省口径继续） */
    return null;
  }
}

/** 项目配置（datapanel 的发现逻辑；动态 import 避环——propagateui 先例） */
async function projectConfigOf(dir: string): Promise<{ 原文目录?: string; 教材单元库?: string; 教材进度?: string; 词库?: string } | null> {
  try {
    const { findProjectConfig } = await import('./datapanel.js');
    const hit = dir ? await findProjectConfig(dir) : null;
    return hit ? (hit.config as Record<string, never>) : null;
  } catch {
    /* 有意兜底：项目配置发现失败=按无配置口径（原文随后会点名读不到） */
    return null;
  }
}

/* 已学词集：项目词库 CSV 的单词/课标行首列 ∪ 内置课标1600 ∪ 内置补录——与 CLI legacy
 * 装载同口径（"已知 = 课标2022三级1600 ∪ 数词/星期/月份补丁 ∪ 学生词库"）。
 * 内置表 ?raw 动态导入：静态导入会把 ?raw 拖进 review 的 node 可测链（钩子注册前解析会炸）。 */
async function knownSetForProject(csv: string): Promise<Set<string>> {
  const s = new Set<string>();
  for (const line of csv.split('\n').slice(1)) {
    const cells = line.split(',');
    const w = (cells[0] ?? '').trim().toLowerCase();
    const kind = (cells[1] ?? '').trim();
    if (w && (kind === '单词' || kind === '课标')) s.add(w);
  }
  const bundled = await Promise.all([import('../../assets/wordlists/curriculum_2022_level3_1600.txt?raw'), import('../../assets/wordlists/curriculum_2022_amendment.txt?raw')]);
  for (const mod of bundled)
    for (const w of String((mod as { default: string }).default).split('\n')) {
      const v = w.trim().toLowerCase();
      if (v && !v.startsWith('#')) s.add(v);
    }
  return s;
}

/** 档位折算梯子（core.Round2Ladder 的 IO 装填；缺进度或缺单元库=null） */
async function ladderOf(cfg: { 教材单元库?: string; 教材进度?: string; 词库?: string } | null): Promise<Round2Ladder | null> {
  if (!cfg?.教材进度 || !cfg.教材单元库) return null;
  const libText = await readOptional(cfg.教材单元库);
  if (!libText) return null;
  let lib: { ladder?: Array<{ book: string; unit: string; words: string[] }>; base?: string[] };
  try {
    lib = JSON.parse(libText);
  } catch {
    /* 有意兜底：单元库 JSON 坏=不可折算（ladder=null，折算分支如实跳过） */
    return null;
  }
  if (!Array.isArray(lib.ladder)) return null;
  const m = /^(七上|七下|八上|八下|九上|九下)U(\d)$/i.exec(cfg.教材进度.trim());
  if (!m) return null;
  const cur = lib.ladder.findIndex((x) => x.book === m[1] && x.unit === `U${m[2]}`);
  const learnedAt = (idx: number): Set<string> => {
    const s = new Set(lib.base ?? []);
    for (let i = 0; i <= idx; i++) for (const w of lib.ladder![i]!.words) s.add(w);
    return s;
  };
  const manualWords = new Set<string>();
  const csv = cfg.词库 ? await readOptional(cfg.词库) : null;
  if (csv) for (const line of csv.split('\n').slice(1)) manualWords.add((line.split(',')[0] ?? '').trim().toLowerCase());
  return {
    currentIndex: cur,
    labelAt: (idx) => (idx >= 0 ? `${lib.ladder![idx]!.book}${lib.ladder![idx]!.unit}` : '课标基础'),
    wordsAt: (idx) => (idx >= 0 ? lib.ladder![idx]!.words : []),
    learnedAt,
    manualWords,
  };
}

export interface R2RunResult {
  ok: boolean;
  finalPath?: string;
  reportPath?: string;
  changed?: number;
}

/** 第二轮修订主流程：读盘 → planRound2 决策 → 逐段复写 → 终稿/进度/报告落盘 */
export async function runRound2ForSession(s: FileSession): Promise<R2RunResult> {
  const sourcePath = s.sourcePath;
  const target = adaptTargetOf(sourcePath);
  if (!target || !sourcePath || !/_R1\.md$/.test(sourcePath)) {
    setStatus('第二轮要在本层的 R1 初稿上执行（打开文件名带 _R1 的初稿）', 'err');
    return { ok: false };
  }
  const dateM = sourcePath.match(/原文_[A-Z]层\d+_(\d{4}-\d{2}-\d{2})_R1\.md$/);
  const date = dateM?.[1] ?? '';
  const finalPath = `${target.outRoot}/${target.chapDir}/原文_${target.tag}${date ? `_${date}` : ''}.md`;
  const progressPath = `${target.outRoot}/_运行/两轮调适进度_${target.tag}_${target.chapDir}.json`;
  const reportPath = `${target.outRoot}/调适报告_${target.tag}_${target.chapDir}${date ? `_${date}` : ''}.md`;

  /* 任务单（确认态由按钮状态机保证；这里再硬闸一次——不得跳过确认自行进第二轮） */
  const taskText = await readOptional(target.taskPath);
  let task: { protectedDimensions?: string[]; needsHuman?: string[] } | null;
  try {
    task = taskText ? JSON.parse(taskText).task : null;
  } catch {
    /* 有意兜底：任务单 JSON 坏=按无任务单处理（下面的硬闸会拦） */
    task = null;
  }
  if (!taskText || !JSON.parse(taskText).confirmed) {
    setStatus('反馈还没有经教师确认的任务单——先在反馈框生成并点「开始修订」确认', 'err');
    return { ok: false };
  }
  if (task?.needsHuman?.length) {
    setStatus(`任务单有待人工处理项：${task.needsHuman.join('；')}`, 'err');
    return { ok: false };
  }

  /* 反馈（含正文 simpl 标记合并——与 CLI readFeedback 同源） */
  let feedbackRaw: string;
  try {
    feedbackRaw = JSON.parse(await invoke<string>('read_text_file', { path: target.feedbackPath })).text ?? '';
  } catch {
    setStatus('反馈文件读不到（_运行/调适反馈_*.json）——重新保存一次反馈再执行', 'err');
    return { ok: false };
  }
  const simplWords: string[] = [];
  const markText = await readOptional(sourcePath.replace(/\.md$/, '').replace(/_R1(?=[^/]*$)/, '') + '_审校标记.json');
  if (markText) {
    try {
      for (const m of JSON.parse(markText).marks ?? []) if (m.type === 'simpl' && m.word) simplWords.push(String(m.word).toLowerCase());
    } catch {
      /* 有意兜底：标记文件读不了就只用文字反馈——如实，不阻断（CLI readFeedback 同款） */
    }
  }

  /* R1 / 原文 / 已学词 */
  const r1Md = await readOptional(sourcePath);
  if (r1Md === null) {
    setStatus('R1 初稿读不到：' + sourcePath, 'err');
    return { ok: false };
  }
  const cfg = await projectConfigOf(sourcePath.slice(0, sourcePath.lastIndexOf('/')));
  const srcMd = cfg?.原文目录 ? await readOptional(`${cfg.原文目录}/${target.chapDir}/原文_规范化.md`) : null;
  if (srcMd === null) {
    setStatus(`原文读不到（${cfg?.原文目录 ?? '（项目配置没找到）'}/${target.chapDir}/原文_规范化.md）`, 'err');
    return { ok: false };
  }
  const csv = cfg?.词库 ? await readOptional(cfg.词库) : null;
  const known = await knownSetForProject(csv ?? '');
  const isKnownWord = (w: string) => hit(w.toLowerCase(), known);

  /* 检查（与 CLI localCheck 同件套） */
  const segs = srcMd.match(SEG_RE) ?? [];
  const r1Segs = r1Md.match(SEG_RE) ?? [];
  const checked = burdenFindings(r1Md, { tier: target.tierKey, properNouns: [] });
  const findings: CheckFinding[] = [...checked.findings, ...fidelityFindings(srcMd, r1Md)];
  const intro = introducedHardWords(srcMd, r1Md, (w) => !isKnownWord(w));
  if (intro.length)
    findings.push({
      level: '难度',
      note: `引入了原文没有的词表外词 ${intro.length} 个：${intro.slice(0, 12).join(', ')}——其中可能有词库漏收的课标词（blame 类）：在 App 报告页点「学生会（入库）」补录后自动消失；确属超纲的交第二轮换写`,
    });
  for (let k = 0; k < segs.length; k++) {
    const segId = segs[k]!.match(/\[P\d+\]/)?.[0];
    if (!r1Segs[k]) findings.push({ level: '结构', segId, note: `段落缺失：原文第 ${k + 1} 段（${segId}）在初稿里没有对应段` });
    else if (wc(r1Segs[k]!) < 3) findings.push({ level: '结构', segId, note: `空段：${segId} 改写后几乎没有内容` });
  }
  const ratio = wc(r1Md) / Math.max(1, wc(srcMd));

  /* 决策（唯一实现=core.planRound2） */
  const progressText = await readOptional(progressPath);
  let hasFinal = false;
  try {
    await invoke('describe_path', { path: finalPath });
    hasFinal = true;
  } catch {
    /* 有意兜底：describe_path 失败=终稿不在（闸门第二条件为否） */
  }
  const plan = planRound2({
    progressText,
    hasFinal,
    feedbackRaw,
    simplWords,
    findings,
    srcSegs: segs,
    r1Segs,
    progressSet: !!cfg?.教材进度,
    ladder: await ladderOf(cfg),
    isKnownWord,
  });
  if (!plan.gate.ok) {
    /* 与 CLI 一致：两轮已用时对终稿复检并出报告（剩余问题交教师），不是只报错 */
    const finalMd = await readOptional(finalPath);
    if (finalMd === null) {
      setStatus(`${plan.gate.reason}（但终稿读不到：${finalPath}）`, 'err');
      return { ok: false };
    }
    const re = burdenFindings(finalMd, { tier: target.tierKey, properNouns: [] });
    re.findings.push(...fidelityFindings(srcMd, finalMd));
    const introG = introducedHardWords(srcMd, finalMd, (w) => !isKnownWord(w));
    if (introG.length)
      re.findings.push({ level: '难度', note: `终稿仍引入原文没有的词表外词 ${introG.length} 个：${introG.slice(0, 12).join(', ')}——先核对是否词库漏收（入库即消）；确属超纲的剩余项交教师换写` });
    let jNote = '';
    if (progressText) {
      try {
        jNote = JSON.parse(progressText).boundaryNote ?? '';
      } catch {
        /* 有意兜底：进度坏了当没有（与 core.planRound2 同口径） */
      }
    }
    const repG = buildAdaptReportMd({
      ch: target.chapDir,
      tierKey: target.tierKey,
      profile: re.profile,
      findings: re.findings,
      ratio,
      isFinal: true,
      fb: { raw: plan.fb.raw, dims: plan.fb.dims, keep: plan.fb.keep, magnitude: plan.fb.magnitude },
      boundaryNote: jNote,
    });
    await invoke('write_text_file', { path: reportPath, content: repG });
    setStatus(`${plan.gate.reason}（终稿复检报告已更新：${reportPath}）`, 'err');
    return { ok: false, reportPath };
  }
  if (plan.empty) {
    await invoke('write_text_file', { path: finalPath, content: r1Md });
    /* CLI 主流程在空选定后同样写报告（finalMd 未置→按"初稿"口径）——保持一致 */
    const repE = buildAdaptReportMd({
      ch: target.chapDir,
      tierKey: target.tierKey,
      profile: checked.profile,
      findings,
      ratio,
      isFinal: false,
      fb: { raw: plan.fb.raw, dims: plan.fb.dims, keep: plan.fb.keep, magnitude: plan.fb.magnitude },
      boundaryNote: plan.boundaryNote,
    });
    await invoke('write_text_file', { path: reportPath, content: repE });
    setStatus(`检查与反馈都没有指向需要复写的段——第一轮稿即最终稿（已写出：${finalPath}；报告：${reportPath}）`, 'saved');
    return { ok: true, finalPath, reportPath, changed: 0 };
  }

  /* 逐段复写（ai.ts 动态 import：?raw prompts 不进 node 编译面——main.ts 同款纪律）。
   * callChat=非流式补全（chatUntilJson 同底座），maxTokens 3000 对齐 CLI callChat 缺省。 */
  const { callChat } = await import('./ai.js');
  const system = round2SystemPrompt(target.tierKey, plan.fb.magnitude === '大幅' ? 1 : target.tierKey === 'A' ? 2 : 1);
  const out = [...r1Segs];
  const changedNotes: string[] = [];
  let n = 0;
  for (const k of plan.targets) {
    n++;
    const marker = segs[k]!.match(/\[P\d+\]/)?.[0] ?? '';
    const reasons = findings
      .filter((f) => f.segId === marker.replace(/[[\]]/g, '') || (f.level === '难度' && !f.segId))
      .map((f) => f.note)
      .slice(0, 3);
    setStatus(`第二轮修订：第 ${n}/${plan.targets.length} 段…`);
    const user = round2SegPrompt({
      fbRaw: plan.fb.raw,
      boundaryNote: plan.boundaryNote,
      removedByLadder: plan.removedByLadder,
      reasons,
      srcSeg: segs[k]!,
      r1Seg: r1Segs[k]!,
      marker,
      protectedDimensions: task?.protectedDimensions ?? null,
    });
    /* 第二轮不自动重试：采纳与否交给最终检查与教师（与 CLI 同纪律） */
    const r = await callChat(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      3000,
      undefined,
      '第二轮修订',
    );
    const revised = cleanR2Seg(r.content, marker);
    out[k] = revised;
    changedNotes.push(`${marker}（${wc(r1Segs[k]!)}→${wc(revised)} 词）`);
  }

  /* 终稿拼装：header + 章标题行 + 段落（缺 `## Chapter` 会让 QC/对齐全线失败——2026-09-12 实测） */
  const chLine = r1Md.match(/^## Chapter .*$/m)?.[0] ?? '';
  const newMd = `${r1Md.slice(0, chLine ? r1Md.indexOf(chLine) : 0)}${chLine}${chLine ? '\n\n' : ''}${out.join('\n\n')}\n`;
  await invoke('write_text_file', { path: finalPath, content: newMd });
  await invoke('write_text_file', {
    path: progressPath,
    content: JSON.stringify({ round: 2, done: [...Array(segs.length).keys()], feedback: plan.fb.raw, boundaryNote: plan.boundaryNote, at: new Date().toISOString() }, null, 1),
  });
  /* 终稿重查：报告里的剖面与清单必须是终稿的剩余问题，不是第一轮的旧账 */
  const recheck = burdenFindings(newMd, { tier: target.tierKey, properNouns: [] });
  recheck.findings.push(...fidelityFindings(srcMd, newMd));
  const intro2 = introducedHardWords(srcMd, newMd, (w) => !isKnownWord(w));
  if (intro2.length)
    recheck.findings.push({ level: '难度', note: `终稿仍引入原文没有的词表外词 ${intro2.length} 个：${intro2.slice(0, 12).join(', ')}——先核对是否词库漏收（入库即消）；确属超纲的剩余项交教师换写` });
  /* CLI 的 writeReport 沿用 c.ratio（R1 口径）——终稿标题下篇幅行是 R1 的比值，
   * 属既有口径；App 保持一致（批次③ D 验收要 byte-equal），修正另立账不混批。 */
  const report = buildAdaptReportMd({
    ch: target.chapDir,
    tierKey: target.tierKey,
    profile: recheck.profile,
    findings: recheck.findings,
    ratio,
    isFinal: true,
    fb: { raw: plan.fb.raw, dims: plan.fb.dims, keep: plan.fb.keep, magnitude: plan.fb.magnitude },
    boundaryNote: plan.boundaryNote,
    changed: plan.targets.length,
    changedNotes,
  });
  await invoke('write_text_file', { path: reportPath, content: report });
  setStatus(`✓ 终稿已写（复写 ${plan.targets.length}/${segs.length} 段；R1 保留）：${finalPath}｜报告：${reportPath}——建议打开终稿过目后再发学生`, 'saved');
  return { ok: true, finalPath, reportPath, changed: plan.targets.length };
}
