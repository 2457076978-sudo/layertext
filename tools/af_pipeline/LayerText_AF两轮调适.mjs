#!/usr/bin/env node
/** LayerText · 两轮调适制（2026-09-12 Wayne 方向文档落地）
 *
 * 目标：选择文本和层级，系统最多生成两轮，交给教师一份明显降低难度、
 * 保留情节、注释不过密的候选稿；人工修改后即可发布。
 *
 * 用法：
 *   node LayerText_AF两轮调适.mjs <A|M|B> [章号|1,2] [--dry]                 # 第一轮：初稿（_R1）
 *   node LayerText_AF两轮调适.mjs <A|M|B> [章号] --check                     # 本地检查（独立可跑）
 *   node LayerText_AF两轮调适.mjs <A|M|B> [章号] --plan [--feedback "…"]        # 生成修订任务单+预览（零 AI 调用）
 *   node LayerText_AF两轮调适.mjs <A|M|B> [章号] --confirm                      # 教师确认任务单（或 App 里点「开始修订」）
 *   node LayerText_AF两轮调适.mjs <A|M|B> [章号] --round2 [--feedback "…"]      # 第二轮：App 反馈须先过任务单确认；CLI --feedback=终端显式确认
 *                                                                             # 产出终稿+调适报告
 *   node LayerText_AF两轮调适.mjs --progress 九上U5                           # 设置教材进度（档位锚点，持久进项目配置）
 *
 * 两轮语义（不许偏）：
 *   第一轮生成初稿 + 本地分级检查 → **教师阅读后一次自然语言反馈** →
 *   第二轮按反馈维度与幅度复写 → 最终检查标出剩余问题，停止自动重试。
 *   不得跳过教师反馈自行进入第二轮；单段最多两次生成尝试；失败保留第一轮稿。
 *
 * 阈值声明：注释密度 A6/M4/B3、句长 A20/M17/B14 是**首版工程试运行阈值**，
 * 不是已验证的教学标准——先用最难、注释最拥挤的章节验证再调。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SHARED = await import('./LayerText_AF词表与词典.mjs');
import { keychainGet } from './keychain.mjs';
const { distOf } = SHARED;
const P = SHARED.loadProject();
const REPO = P.引擎目录;
const SRC_BASE = P.原文目录;
const OUT_BASE = P.产物目录;
const WORK = P.调适工作区;
const DATE = P.日期;
const CN = SHARED.chapterNames(P);
const wc = (t) => (t.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).length;

/* API：ChatECNU（OpenAI 兼容端点，key 在钥匙串 layertext.ecnukey；与 App 的 AI 设置互不相干） */
const MODEL = 'ecnu-plus';
const CFG = { baseUrl: 'https://chat.ecnu.edu.cn/open/api/v1' };
const KEY = () => keychainGet('layertext.ecnukey'); /* 惰性：Linux/CI 无 security 命令，导入期不查钥匙串 */
/* 调用台账（四方向 v2 批次 0a）：逐调用记 usage/finishReason，主力路径的 token 从此可解释 */
const { openLedger } = await import('./LayerText_AF调用台账.mjs');
const LEDGER = await openLedger(P, '两轮调适');

const { splitChapter } = await import(`${distOf(REPO)}/src/core/textpipe.js`);
const { makeResolver } = await import(`${distOf(REPO)}/src/core/manifest.js`);
const { burdenFindings, fidelityFindings, introducedHardWords, parseTeacherFeedback, MAGNITUDE_UNITS, planRevisionTask, planRevisionStages, revisionTaskPreview } = await import(
  `${distOf(REPO)}/src/core/adaptcheck.js`
);

/* ────────────────────── 层级定义（三维目标矩阵，2026-09-12 定稿；同日考试证据校准） ──────────────────────
 * 篇幅比例不再主导生成：保留篇幅与阅读难度没有稳定的一一对应关系，弱生可能需要更多解释。
 * 篇幅只作参考报告；不为压篇幅删人物提示、原因和解释。
 * 2026-09-12 校准（定性）：依据六次考试逐生逐题证据（推导过程与数字在私有报告
 *   01-教学工作/成绩数据库/报告/E3目标矩阵校准_v1.0.md，学生数据不进仓）：
 *   ① 功能词介冠连不是 A 层专利，M/B 同弱；② 词义深度反而是 A 层短板；
 *   ③ 句际衔接（六选五型）全梯队共性弱；④ 词形产出全员塌——注释带词形家族；
 *   ⑤ 整句产出（任务型）全梯队最弱——M 层整句结构模板化。 */
const TIERS = {
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

/* ────────────────────── CLI ────────────────────── */
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const has = (n) => argv.includes(n);
const dry = has('--dry');
let tiers = argv.filter((a) => /^[AMB]$/.test(a));
if (!tiers.length) tiers = ['A'];
let chapters = argv.filter((a) => /^\d/.test(a)).flatMap((a) => a.split(',').map(Number));
if (!chapters.length) chapters = [7]; // 默认最难章（试运行口径：先拿最难的验证）

/* ────────────────────── 词库与教材档位 ────────────────────── */
let LEX = null;
try {
  LEX = await SHARED.loadLexicon(P);
} catch (e) {
  console.error(`✗ 词汇约束不可用（词库加载失败：${String(e).slice(0, 120)}）——本次不生成。`);
  console.error('  生成的前提是"优先用学生熟悉的词"，词库读不到这句话就是假的。先修词库再跑。');
  process.exit(2);
}
/* 已学判定必须与 QC 同一套（不规则形 + 后缀还原）——自算一套宽了窄了都会两边打架
 * （2026-09-10 修复脚本的历史教训，见 词表与词典.mjs makeKnownChecker 注释）。 */
const isKnownWord = await SHARED.makeKnownChecker(P);

/** 教材单元库：books={八上:{U1..U8},八下:…,九上:…}，base=课标1600。档位序=学年序。 */
const UNIT_LIB = (() => {
  const p = P.教材单元库 ?? P.书级?.教材单元库;
  if (!p || !existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, 'utf-8'));
    const bookOrder = ['七上', '七下', '八上', '八下', '九上', '九下'].filter((b) => j.books?.[b]);
    const ladder = []; // [{book, unit, words}]
    for (const b of bookOrder)
      for (const [u, v] of Object.entries(j.books[b])) {
        if (u === '（未标单元）') continue;
        ladder.push({ book: b, unit: u, words: (v?.词 ?? []).map((w) => String(w).toLowerCase()) });
      }
    return { base: (j.base ?? []).map((w) => String(w).toLowerCase()), ladder };
  } catch {
    return null;
  }
})();
/** 教材进度（档位锚点）。回退幅度→单元数：轻度1/明显2/大幅4（档位折算，不是精确换算）。 */
const progressOf = () => {
  const s = P.教材进度;
  if (!s || typeof s !== 'string') return null;
  const m = /^(七上|七下|八上|八下|九上|九下)U(\d)$/i.exec(s.trim());
  return m ? { book: m[1], unit: Number(m[2]) } : null;
};
const ladderIndex = (p) => (UNIT_LIB ? UNIT_LIB.ladder.findIndex((x) => x.book === p.book && x.unit === `U${p.unit}`) : -1);
/** 当前边界内的"已学"单元词集合（教材边界是生成参考，不是 OOV 判定锚——判定锚永远是词库） */
const textbookLearned = (uptoIdx) => {
  if (!UNIT_LIB) return new Set();
  const s = new Set(UNIT_LIB.base);
  for (let i = 0; i <= uptoIdx && i < UNIT_LIB.ladder.length; i++) for (const w of UNIT_LIB.ladder[i].words) s.add(w);
  return s;
};

/* --progress 九上U5：设置教材进度（持久写回项目配置） */
if (has('--progress')) {
  const v = arg('--progress', '');
  if (!/^(七上|七下|八上|八下|九上|九下)U\d$/i.test(v)) {
    console.error(`✗ 进度写法应为 册+单元，如 九上U5（实得「${v}」）`);
    process.exit(2);
  }
  const cfgPath = process.env.LAYERTEXT_PROJECT;
  const j = JSON.parse(readFileSync(cfgPath, 'utf-8'));
  j.教材进度 = v;
  writeFileSync(cfgPath, JSON.stringify(j, null, 2) + '\n', 'utf-8');
  console.log(`✓ 教材进度已设为 ${v}（档位锚点；"超前一学期"将回退 2 单元的词汇边界）`);
  process.exit(0);
}

/** 教师手工词库（CSV 第一列）——手工收录是教师的明确判断，单元回退不动它们 */
const manualLexiconWords = () => {
  const s = new Set();
  try {
    for (const line of readFileSync(P.词库, 'utf-8').split('\n').slice(1)) {
      const w = (line.split(',')[0] ?? '').trim().toLowerCase();
      if (w) s.add(w);
    }
  } catch {
    /* 读不到就当空集：回退只按单元算，保守 */
  }
  return s;
};

/* ────────────────────── Prompt ────────────────────── */
function systemPrompt(t, { annoCap } = {}) {
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

async function callChat(messages, maxTokens = 3000) {
  const r = await LEDGER.call(messages, { baseUrl: CFG.baseUrl, key: KEY(), model: MODEL, maxTokens });
  return r.content.trim();
}
const cleanSeg = (text, marker) => {
  let t = text
    .trim()
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/```\s*$/, '');
  if (!t.includes('[P')) t = marker + ' ' + t;
  return t.trim();
};

/* 产物与中间产物路径（一律经 Resolver） */
const RR = (tag) => makeResolver('legacy', { out: OUT_BASE, work: WORK }, { date: DATE, tier: tag });
const r1PathOf = (t, ch) => RR(t.clsTag).any('正文', { chapter: ch, tier: t.clsTag, suffix: '_R1' });
const finalPathOf = (t, ch) => RR(t.clsTag).any('正文', { chapter: ch, tier: t.clsTag });
const reportPathOf = (t, ch) => RR(t.clsTag).any('汇总报告', { name: `调适报告_${t.clsTag}_${ch}`, chapter: ch });
const feedbackPathOf = (t, ch) => join(OUT_BASE, '_运行', `调适反馈_${t.clsTag}_${ch}.json`);
const progressFile = (t, ch) => join(OUT_BASE, '_运行', `两轮调适进度_${t.clsTag}_${ch}.json`);
const taskPathOf = (t, ch) => join(OUT_BASE, '_运行', `调适任务单_${t.clsTag}_${ch}.json`);
/** 读教师反馈的统一入口：CLI --feedback 优先，否则读 App 反馈框落盘文件；顺带合并正文 simpl 标记 */
function readFeedback(t, ch, cliFeedback) {
  const raw =
    cliFeedback ??
    (() => {
      const fp = feedbackPathOf(t, ch);
      return existsSync(fp) ? (JSON.parse(readFileSync(fp, 'utf-8')).text ?? null) : null;
    })();
  if (!raw) return null;
  let marked = [];
  try {
    const markPath = `${r1PathOf(t, ch).replace(/\.md$/, '')}_审校标记.json`.replace(/_R1(?=[^/]*$)/, '');
    if (existsSync(markPath)) {
      marked = (JSON.parse(readFileSync(markPath, 'utf-8')).marks ?? []).filter((m) => m.type === 'simpl' && m.word).map((m) => String(m.word).toLowerCase());
    }
  } catch {
    /* 标记文件读不了就只用文字反馈——如实，不阻断 */
  }
  return { raw, marked };
}
/** 把"保护维度"翻译进第二轮 prompt 的硬约束（facts 恒在，不再单列） */
const DIM_WORD = {
  plot: '情节顺序与事件',
  characters: '人物关系与称谓',
  syntax: '句式结构',
  vocabulary: '已定稿的词汇选择',
  coherence: '已清楚的衔接与指代',
  background: '背景交代',
  support: '注释安排',
};
const protectionLineOf = (task) => {
  const dims = task.protectedDimensions.filter((d) => d !== 'facts');
  return dims.length ? `教师明确认可的方面（本轮禁改）：${dims.map((d) => DIM_WORD[d] ?? d).join('、')}。数字、否定与因果关系任何情况下不得改变。` : '数字、否定与因果关系任何情况下不得改变。';
};

const readSegs = (i) => {
  const ch = CN[i - 1];
  const md = readFileSync(join(SRC_BASE, ch, '原文_规范化.md'), 'utf-8');
  const chLine = md.match(/^## Chapter \w+.*$/m)?.[0] ?? '';
  const header = chLine ? md.slice(0, md.indexOf(chLine)) : '';
  const segs = splitChapter(md).body.match(/\[P\d+\][\s\S]*?(?=\[P\d+\]|$)/g) ?? [];
  if (!segs.length) throw new Error(`${ch} 未找到 [P##] 段落`);
  return { ch, header, chLine, segs, srcMd: md };
};

/* ────────────────────── 第一轮：初稿 ────────────────────── */
async function round1(i, t) {
  const { ch, header, chLine, segs, srcMd } = readSegs(i);
  LEDGER.scene = { tier: t.key, chapter: ch, tag: 'R1' };
  const dst = r1PathOf(t, ch);
  const pf = progressFile(t, ch);
  let done = [];
  if (existsSync(pf)) {
    try {
      done = JSON.parse(readFileSync(pf, 'utf-8')).done ?? [];
    } catch {
      done = [];
    }
  }
  if (done.length === segs.length && existsSync(dst)) {
    console.log(`  ${ch} 第一轮已完成（${done.length} 段，中断恢复跳过）`);
    return;
  }
  mkdirSync(dirname(pf), { recursive: true });
  const system = systemPrompt(t);
  const out = [...segs];
  for (let k = 0; k < segs.length; k++) {
    if (done.includes(k)) continue;
    const srcW = wc(segs[k]);
    const prevTail = k > 0 ? out[k - 1].slice(-500) : '（本章开头）';
    const user = `前文（已简化，供语气与指代衔接参考）：\n…${prevTail}\n\n请把以下段落改写为${t.label}（原文 ${srcW} 词）：\n${segs[k].trim()}\n输出：保持 [P##] 标记开头，直接输出改写文本。`;
    const marker = segs[k].match(/\[P\d+\]/)[0];
    const revised = cleanSeg(
      await callChat([
        { role: 'system', content: system },
        { role: 'user', content: user },
      ]),
      marker,
    );
    out[k] = revised;
    done.push(k);
    writeFileSync(pf, JSON.stringify({ done, round: 1, at: new Date().toISOString() }, null, 1), 'utf-8');
    process.stdout.write(`  ${ch} R1 段 ${k + 1}/${segs.length}（${srcW}→${wc(revised)}）\r`);
  }
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, `${header}${chLine}\n\n${out.join('\n\n')}\n`, 'utf-8');
  console.log(`  ✓ 初稿：${dst}`);
  void srcMd;
}

/* ────────────────────── 本地检查（第一轮后、教师反馈前） ────────────────────── */
function localCheck(t, i) {
  const { ch, segs, srcMd } = readSegs(i);
  const r1 = r1PathOf(t, ch);
  if (!existsSync(r1)) {
    console.error(`✗ ${ch} 还没有初稿（先跑第一轮）`);
    process.exit(2);
  }
  const r1Md = readFileSync(r1, 'utf-8');
  const { profile, findings } = burdenFindings(r1Md, { tier: t.key, properNouns: P.PROPER ?? [] });
  findings.push(...fidelityFindings(srcMd, r1Md));
  const introduced = introducedHardWords(srcMd, r1Md, (w) => !isKnownWord(w));
  if (introduced.length)
    findings.push({
      level: '难度',
      note: `引入了原文没有的词表外词 ${introduced.length} 个：${introduced.slice(0, 12).join(', ')}——其中可能有词库漏收的课标词（blame 类）：在 App 报告页点「学生会（入库）」补录后自动消失；确属超纲的交第二轮换写`,
    });
  /* 结构级：占位段/空段（阻止发布的那一类） */
  const r1Segs = r1Md.match(/\[P\d+\][\s\S]*?(?=\[P\d+\]|$)/g) ?? [];
  for (let k = 0; k < segs.length; k++) {
    if (!r1Segs[k]) findings.push({ level: '结构', segId: segs[k].match(/\[P\d+\]/)?.[0], note: `段落缺失：原文第 ${k + 1} 段（${segs[k].match(/\[P\d+\]/)?.[0]}）在初稿里没有对应段` });
    else if (wc(r1Segs[k]) < 3) findings.push({ level: '结构', segId: segs[k].match(/\[P\d+\]/)?.[0], note: `空段：${segs[k].match(/\[P\d+\]/)?.[0]} 改写后几乎没有内容` });
  }
  const ratio = wc(r1Md) / Math.max(1, wc(srcMd));
  return { ch, profile, findings, ratio, srcMd, r1Md, r1Segs, segs, introduced };
}

/* ────────────────────── 第二轮：按教师反馈复写 ────────────────────── */
async function round2(t, i, feedbackRaw, task = null) {
  LEDGER.scene = { tier: t.key, chapter: CN[i - 1], tag: 'R2' };
  const fb = parseTeacherFeedback(feedbackRaw);
  /* 教师在正文里点的「要简化」标记（simpl）= 词级"太难"反馈，与文字反馈合并——
   * 点名几个词，第二轮举一反三处理同类难度表达，不只换点名词。 */
  try {
    const markPath = `${r1PathOf(t, CN[i - 1]).replace(/\.md$/, '')}_审校标记.json`.replace(/_R1(?=[^/]*$)/, '');
    if (existsSync(markPath)) {
      const marks = JSON.parse(readFileSync(markPath, 'utf-8')).marks ?? [];
      const simpl = marks.filter((m) => m.type === 'simpl' && m.word).map((m) => String(m.word).toLowerCase());
      if (simpl.length) fb.tooHardWords.push(...simpl.filter((w) => !fb.tooHardWords.includes(w)));
      if (simpl.length) fb.raw += `（正文标记太难：${[...new Set(simpl)].slice(0, 20).join(', ')}）`;
    }
  } catch {
    /* 标记文件读不了就只用文字反馈——如实，不阻断 */
  }
  const c = localCheck(t, i);
  const { ch, segs, srcMd, r1Md, r1Segs } = c;
  const r1 = r1PathOf(t, ch);
  const dst = finalPathOf(t, ch);

  /* 两轮制闸门：两轮已用完就停止自动重试——剩余问题交教师修改，这是方向文档的硬规矩 */
  const pf = progressFile(t, ch);
  if (existsSync(pf)) {
    try {
      const j = JSON.parse(readFileSync(pf, 'utf-8'));
      if (j.round >= 2 && existsSync(dst)) {
        console.log(`  ${ch}：两轮已用完（终稿在 ${dst}）——剩余问题交教师修改或说明保留，不再自动重试。`);
        const finalMd = readFileSync(dst, 'utf-8');
        const re = burdenFindings(finalMd, { tier: t.key, properNouns: P.PROPER ?? [] });
        re.findings.push(...fidelityFindings(srcMd, finalMd));
        const intro = introducedHardWords(srcMd, finalMd, (w) => !isKnownWord(w));
        if (intro.length)
          re.findings.push({ level: '难度', note: `终稿仍引入原文没有的词表外词 ${intro.length} 个：${intro.slice(0, 12).join(', ')}——先核对是否词库漏收（入库即消）；确属超纲的剩余项交教师换写` });
        return { ...c, profile: re.profile, findings: re.findings, changed: 0, fb, boundaryNote: j.boundaryNote ?? '', finalMd };
      }
    } catch {
      /* 进度文件坏了当没有：往下走正常流程 */
    }
  }

  /* 档位折算：有教材进度才回退；没有就按幅度收紧注释限额（如实报告，不假装精确）。
   * 退学词 = 被回退掉的单元里、不在更早边界、也不在教师手工词库里的词——
   * 手工收录是教师的明确判断，优先于单元回退。 */
  const prog = progressOf();
  let boundaryNote = '';
  const removedByLadder = new Set();
  if (fb.magnitude && prog && UNIT_LIB) {
    const idx = ladderIndex(prog);
    const back = MAGNITUDE_UNITS[fb.magnitude];
    const newIdx = Math.max(-1, idx - back);
    const from = idx >= 0 ? `${UNIT_LIB.ladder[idx].book}${UNIT_LIB.ladder[idx].unit}` : '课标基础';
    const to = newIdx >= 0 ? `${UNIT_LIB.ladder[newIdx].book}${UNIT_LIB.ladder[newIdx].unit}` : '课标基础';
    const earlier = textbookLearned(newIdx);
    const manual = manualLexiconWords();
    for (let i2 = newIdx + 1; i2 <= idx; i2++)
      for (const w of UNIT_LIB.ladder[i2].words) {
        if (!earlier.has(w) && !manual.has(w)) removedByLadder.add(w);
      }
    boundaryNote = `词汇边界从 ${from} 回退到 ${to}（按你的反馈折算 ${back} 个单元——档位折算，不是精确换算）`;
  } else if (fb.magnitude) {
    boundaryNote = prog ? '' : `未设置教材进度——"超前${fb.magnitude}"按注释限额收紧处理（跑 --progress 九上U5 可获得精确的单元回退）`;
  }

  /* 复写范围：检查出的难度级问题段 ∪ 反馈维度涉及的段（词汇→含超纲词段；句法→长句段；整体→全篇） */
  const whole = fb.dims.length >= 4 || /整体|全部|全篇/.test(fb.raw);
  const target = new Set();
  if (whole) segs.forEach((_, k) => target.add(k));
  else {
    for (let k = 0; k < r1Segs.length; k++) {
      const seg = r1Segs[k];
      const segId = seg.match(/\[P\d+\]/)?.[0] ?? '';
      const segFindings = c.findings.filter((f) => f.level === '难度' && (f.segId === segId || f.note.includes('注释拥挤') || f.note.includes('最长句') || f.note.startsWith('归因')));
      if (segFindings.length) target.add(k);
      if (fb.dims.includes('词汇')) {
        const hard = [...seg.matchAll(/[A-Za-z][A-Za-z'-]*/g)].map((m) => m[0].toLowerCase()).filter((w) => !isKnownWord(w) || removedByLadder.has(w));
        if (hard.length >= 2) target.add(k);
      }
    }
    /* 教师点名的词：含这些词的段必进 */
    for (let k = 0; k < r1Segs.length; k++) {
      const low = r1Segs[k].toLowerCase();
      if (fb.tooHardWords.some((w) => low.includes(w))) target.add(k);
    }
  }
  const targets = [...target].sort((a, b) => a - b);
  if (!targets.length) {
    console.log(`  ${ch}：检查与反馈都没有指向需要复写的段——第一轮稿即最终稿。`);
    writeFileSync(dst, r1Md, 'utf-8');
    return { ...c, changed: 0, fb, boundaryNote };
  }

  const system = systemPrompt(t, { annoCap: fb.magnitude === '大幅' ? 1 : t.key === 'A' ? 2 : 1 });
  const out = [...r1Segs];
  const changedNotes = [];
  for (const k of targets) {
    const marker = segs[k].match(/\[P\d+\]/)?.[0] ?? '';
    const reasons = c.findings
      .filter((f) => f.segId === marker.replace(/[[\]]/g, '') || (f.level === '难度' && !f.segId))
      .map((f) => f.note)
      .slice(0, 3);
    const user = `教师读了第一轮稿后反馈（原话）：「${fb.raw}」
${boundaryNote ? `词汇边界调整：${boundaryNote}。` : ''}${removedByLadder.size ? `\n以下 ${removedByLadder.size} 个词本轮按"未学"处理（教材回退），换成熟词或用简单英文解释：${[...removedByLadder].slice(0, 40).join(', ')}${removedByLadder.size > 40 ? ' …' : ''}` : ''}
本段的具体问题：${reasons.length ? reasons.join('；') : '（按反馈维度整体处理）'}
请复写下面这一段，要求：优先替换非必要难词；拆清动作和关系；${task ? protectionLineOf(task) : '保留人物、事件、数字、否定与因果'}（${segs[k].includes(' not ') || /never|no /i.test(segs[k]) ? '本段含否定表达，方向不能反' : ''}）；不得只删中文注释而英文不变容易；从教师点名的词举一反三，同类难度的表达一并处理。
第一轮稿（待复写）：
${r1Segs[k].trim()}
输出：保持 ${marker} 标记开头，直接输出复写文本。`;
    const revised = cleanSeg(
      await callChat([
        { role: 'system', content: system },
        { role: 'user', content: user },
      ]),
      marker,
    );
    /* 第二轮不再自动重试：采纳与否交给最终检查与教师 */
    out[k] = revised;
    changedNotes.push(`${marker}（${wc(r1Segs[k])}→${wc(revised)} 词）`);
    process.stdout.write(`  ${ch} R2 段 ${targets.indexOf(k) + 1}/${targets.length}\r`);
  }
  /* 终稿拼装：header + 章标题行本身 + 段落（slice 到 chLine 为止会把它丢掉——
   * 终稿缺 `## Chapter` 会让 QC/对齐全线解析失败，2026-09-12 第七章实测踩过） */
  const chLine = r1Md.match(/^## Chapter .*$/m)?.[0] ?? '';
  const newMd = `${r1Md.slice(0, chLine ? r1Md.indexOf(chLine) : 0)}${chLine}${chLine ? '\n\n' : ''}${out.join('\n\n')}\n`;
  writeFileSync(dst, newMd, 'utf-8');
  writeFileSync(pf, JSON.stringify({ round: 2, done: [...Array(segs.length).keys()], feedback: fb.raw, boundaryNote, at: new Date().toISOString() }, null, 1), 'utf-8');
  console.log(`  ✓ 终稿：${dst}（复写 ${targets.length}/${segs.length} 段；初稿保留在 ${r1}）`);
  /* 终稿重查：报告里的剖面与清单必须是**终稿**的剩余问题，不是第一轮的旧账
   * （第二轮失败保留 R1 与原因；成功也要如实说清还剩什么）。 */
  const recheck = burdenFindings(newMd, { tier: t.key, properNouns: P.PROPER ?? [] });
  recheck.findings.push(...fidelityFindings(srcMd, newMd));
  const intro2 = introducedHardWords(srcMd, newMd, (w) => !isKnownWord(w));
  if (intro2.length)
    recheck.findings.push({ level: '难度', note: `终稿仍引入原文没有的词表外词 ${intro2.length} 个：${intro2.slice(0, 12).join(', ')}——先核对是否词库漏收（入库即消）；确属超纲的剩余项交教师换写` });
  return { ...c, profile: recheck.profile, findings: recheck.findings, changed: targets.length, changedNotes, fb, boundaryNote, finalMd: newMd };
}

/* ────────────────────── 调适报告 ────────────────────── */
function writeReport(t, r) {
  const structural = r.findings.filter((f) => f.level === '结构');
  const info = r.findings.filter((f) => f.level === '信息变化');
  const hard = r.findings.filter((f) => f.level === '难度');
  const status = structural.length ? '待处理（结构问题阻止发布）' : '可发布（供人工校对）';
  const L = [
    `# 调适报告 · ${r.ch} · ${t.label}`,
    '',
    `> 状态：**${status}**。语言检查通过≠学生一定读得懂、情节完全正确；数字与专名检查不能代替情节保真。`,
    `> 阈值为工程试运行阈值（注释密度 ${{ A: 6, M: 4, B: 3 }[t.key]}、句长 ${{ A: 20, M: 17, B: 14 }[t.key]}），非教学标准。`,
    '',
    `## 负担剖面（${r.finalMd ? '终稿' : '初稿'}）`,
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
  const p = reportPathOf(t, r.ch);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, L.join('\n') + '\n', 'utf-8');
  console.log(`  ✓ 报告：${p}`);
  return { status, structural: structural.length, info: info.length, hard: hard.length };
}

/* ────────────────────── 主流程 ────────────────────── */
if (dry) {
  console.log(`计划：${tiers.join('/')} 层｜章 ${chapters.join(',')}｜模型 ${MODEL}｜教材进度 ${P.教材进度 ?? '（未设置）'}`);
  process.exit(0);
}
if (!LEX) process.exit(2); // loadLexicon 失败已在上面显式退出；此行防守
const summary = [];
for (const tk of tiers) {
  const t = TIERS[tk];
  for (const i of chapters) {
    console.log(`▶ ${t.label} ${CN[i - 1]}`);
    try {
      const chName = CN[i - 1];
      if (has('--plan')) {
        /* 任务单模式：解析反馈 → 本地检查圈定预计范围 → 落任务单 → 预览 → 退出（零 AI 调用） */
        const fbInfo = readFeedback(t, chName, arg('--feedback', null));
        if (!fbInfo) {
          console.error(`✗ ${chName} 没有教师反馈（--feedback "…" 或 App 反馈框落盘）——任务单无从谈起。`);
          process.exit(2);
        }
        const task = planRevisionTask(chName, 'R1', fbInfo.raw, { markedTooHard: fbInfo.marked });
        let expected = null;
        try {
          const c = localCheck(t, i);
          const fb = parseTeacherFeedback(fbInfo.raw);
          const whole = fb.dims.length >= 4 || /整体|全部|全篇/.test(fb.raw);
          const target = new Set();
          if (whole) c.segs.forEach((_, k) => target.add(k));
          else
            for (let k = 0; k < c.r1Segs.length; k++) {
              const seg = c.r1Segs[k];
              const segId = seg.match(/\[P\d+\]/)?.[0] ?? '';
              if (c.findings.some((f) => f.level === '难度' && (f.segId === segId || f.note.includes('注释拥挤') || f.note.includes('最长句') || f.note.startsWith('归因')))) target.add(k);
              if (fb.dims.includes('词汇')) {
                const hard = [...seg.matchAll(/[A-Za-z][A-Za-z'-]*/g)].map((m) => m[0].toLowerCase()).filter((w) => !isKnownWord(w));
                if (hard.length >= 2) target.add(k);
              }
            }
          for (let k = 0; k < c.r1Segs.length; k++) {
            if (fb.tooHardWords.some((w) => c.r1Segs[k].toLowerCase().includes(w))) target.add(k);
          }
          expected = target.size;
        } catch (e) {
          console.log(`  ⚠ 预计范围算不出（${String(e).slice(0, 80)}）——任务单照写，执行时按检查结果圈定`);
        }
        const tp = taskPathOf(t, chName);
        mkdirSync(dirname(tp), { recursive: true });
        writeFileSync(tp, JSON.stringify({ task, expectedSegments: expected, confirmed: false, createdAt: new Date().toISOString() }, null, 2), 'utf-8');
        console.log(`  ✓ 任务单：${tp}`);
        for (const line of revisionTaskPreview(task)) console.log(`  · ${line}`);
        if (expected !== null) console.log(`  · 预计影响：${expected} 个段落（本地检查圈定，执行时复核）`);
        console.log(`  下一步：教师确认（--confirm 或 App 任务单预览的「开始修订」）后才执行 --round2。`);
      } else if (has('--confirm')) {
        const tp = taskPathOf(t, chName);
        if (!existsSync(tp)) {
          console.error(`✗ ${chName} 没有任务单（先跑 --plan）。`);
          process.exit(2);
        }
        const j = JSON.parse(readFileSync(tp, 'utf-8'));
        j.confirmed = true;
        j.confirmedAt = new Date().toISOString();
        writeFileSync(tp, JSON.stringify(j, null, 2), 'utf-8');
        console.log(
          `  ✓ ${chName} 任务单已确认（${
            planRevisionStages(j.task)
              .map((x) => x)
              .join(' → ') || '无工序'
          }）——可跑 --round2`,
        );
      } else if (has('--round2')) {
        const cliFb = arg('--feedback', null);
        const fbInfo = readFeedback(t, chName, cliFb);
        if (!fbInfo) {
          console.error('✗ 第二轮必须先有教师反馈（--feedback "…" 或 App 反馈框落盘）。不得跳过教师反馈自行进入第二轮。');
          process.exit(2);
        }
        let task = null;
        if (cliFb) {
          /* CLI 直接给反馈 = 教师在终端的显式确认，自动生成已确认任务单（留痕） */
          task = planRevisionTask(chName, 'R1', fbInfo.raw, { markedTooHard: fbInfo.marked });
          const tp = taskPathOf(t, chName);
          mkdirSync(dirname(tp), { recursive: true });
          writeFileSync(tp, JSON.stringify({ task, expectedSegments: null, confirmed: true, confirmedAt: new Date().toISOString(), via: 'CLI --feedback（终端显式确认）' }, null, 2), 'utf-8');
        } else {
          const tp = taskPathOf(t, chName);
          if (!existsSync(tp) || !JSON.parse(readFileSync(tp, 'utf-8')).confirmed) {
            console.error(`✗ ${chName} 的反馈还没有经教师确认的任务单（先跑 --plan 生成预览，再 --confirm 或在 App 里点「开始修订」）。不得跳过确认自行进入第二轮。`);
            process.exit(2);
          }
          task = JSON.parse(readFileSync(tp, 'utf-8')).task;
        }
        if (task?.needsHuman?.length) {
          for (const n of task.needsHuman) console.error(`✗ ${n}`);
          process.exit(2);
        }
        const r = await round2(t, i, fbInfo.raw, task);
        const rep = writeReport(t, r);
        summary.push({ tier: tk, ch: chName, ...rep });
      } else if (has('--check')) {
        const c = localCheck(t, i);
        const rep = writeReport(t, c);
        summary.push({ tier: tk, ch: CN[i - 1], ...rep });
      } else {
        await round1(i, t);
      }
    } catch (e) {
      console.error(`  ✗ ${CN[i - 1]} 失败：${String(e).slice(0, 200)}`);
    }
  }
}
if (summary.length) {
  console.log('═══ 小结 ═══');
  for (const s of summary) console.log(` ${s.tier} ${s.ch}：${s.status}｜结构 ${s.structural}｜待确认 ${s.info}｜难度 ${s.hard}`);
}
const st = LEDGER.flush();
if (st.calls) console.log(`台账：调用 ${st.calls}（成功 ${st.ok}）｜入 ${st.in}${st.cached ? `（缓存命中 ${st.cached}）` : ''}｜出 ${st.out} token —— _运行/token台账.jsonl`);
