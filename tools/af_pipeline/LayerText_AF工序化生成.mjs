#!/usr/bin/env node
/** AF 工序化生成（四方向方案 v2 批次 1 · 方向一落地）
 *
 * 与三档生成的区别（为什么另起脚本而不是改旧的）：
 *   三档生成 = 词汇+句法+篇幅一次 prompt 混做、全段送 AI、整段替换；
 *   本脚本   = 五道工序（词汇粗筛→句法→词汇复筛→连贯性→最终加注）按
 *   src/core/stagepipe 的编排跑：本地扫描决定哪些段进哪道工序（无命中零调用）、
 *   AI 只返回差量 patch、patch 过段级门禁才合并、被拒不改的段重试一次后隔离。
 *   加注严格最后执行（生成期不注，annotation 工序统一注）。
 *
 * 用法：
 *   node LayerText_AF工序化生成.mjs <A|M|B|ALL> [章号|1,2] [--dry]
 * 产物（不动三档生成的文件，suffix=_工序化）：
 *   重制三版/第X章/原文_{tag}_{日期}_工序化.md + _运行/工序化进度_*.json
 *   + _运行/章recap_{tag}_{章}.json + _待复核/（隔离段记录）
 * 台账：_运行/token台账.jsonl（批次 0 的调用台账，scene=工序化生成:工序名）
 */
import { readFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const SHARED = await import('./LayerText_AF词表与词典.mjs');
const { distOf, loadProject, loadLexicon, loadDict, loadKbGloss, chapterNames } = SHARED;
const P = loadProject();
const REPO = P.引擎目录;
const SRC_BASE = P.原文目录;
const OUT_BASE = P.产物目录;
const DATE = P.日期;
const CN = chapterNames(P);
const wc = (t) => (t.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).length;

const MODEL = 'ecnu-plus'; // ChatECNU（与三档生成/两轮调适同源）
const CFG = { baseUrl: 'https://chat.ecnu.edu.cn/open/api/v1' };
const KEY = execSync('security find-generic-password -s layertext.ecnukey -w').toString().trim();
const { openLedger } = await import('./LayerText_AF调用台账.mjs');
const LEDGER = await openLedger(P, '工序化生成');

const { splitChapter } = await import(`${distOf(REPO)}/src/core/textpipe.js`);
const { makeResolver, dirOfPath } = await import(`${distOf(REPO)}/src/core/manifest.js`);
const { atomicWriteFileSync: writeAtomic } = await import(`${distOf(REPO)}/src/core/files.js`);
const { runStagePipeline, buildChapterRecap } = await import(`${distOf(REPO)}/src/core/stagepipe.js`);
const { STAGE_LABEL } = await import(`${distOf(REPO)}/src/core/stagepatch.js`);

/* 层定义沿用两轮调适的难度下移口径（A17/M15/B14 为生成上限；检查线 A20/M17/B14 由
 * adaptcheck 自持——两把尺的关系在方案 §3.2 已声明：阈值只此一套，这里是生成参数） */
const TIERS = {
  A: { key: 'A', label: 'A层（挑战）', ratio: 0.85, maxLen: 17, clsTag: 'A层85' },
  M: { key: 'M', label: 'M层（中层）', ratio: 0.75, maxLen: 15, clsTag: 'M层75' },
  B: { key: 'B', label: 'B层（基础）', ratio: 0.6, maxLen: 14, clsTag: 'B层60' },
};

const argRun = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const TEACHER = argRun('--teacher', process.env.LAYERTEXT_TEACHER ?? process.env.USER ?? 'unknown');
const RUN = await SHARED.readRunIdentity(
  { out: OUT_BASE, work: P.调适工作区 },
  { teacher: TEACHER, tier: TIERS.A.clsTag },
  { runId: argRun('--run', undefined) },
);
if (RUN.warning) console.warn(`\n⚠ ${RUN.warning}`);
const RR = (tag) => makeResolver(RUN.layout, { out: OUT_BASE, work: P.调适工作区 }, { runId: RUN.runId, tier: tag, date: DATE });

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
let tiers = argv.filter((a) => /^[AMB]$/.test(a));
if (!tiers.length) tiers = ['A'];
let chapters = argv.filter((a) => /^\d/.test(a)).flatMap((a) => a.split(',').map(Number));
if (!chapters.length) chapters = [7];

let LEX = null;
try {
  LEX = await loadLexicon(P);
} catch (e) {
  console.error(`✗ 词汇约束不可用（词库加载失败：${String(e).slice(0, 120)}）——本次不生成。`);
  process.exit(2);
}
const DICT = loadDict(P.词典路径);
const KB = loadKbGloss(P.知识库路径);
/* 加注工序的释义建议：统一词典 → 教师知识库（两处都有以词典为准——与补注同序；
 * KB 的值是 {zh,n} 对象，取 .zh 进 prompt）。KB 键集 = 教师必注词（配额内优先）。 */
const glossHints = new Map([...[...KB].map(([w, v]) => [w, v.zh]), ...DICT]);
const mustAnnotate = new Set([...KB.keys()]);
/* 已问过的释义缓存（跨段共享：一词一释，问过不再问） */
const askedGloss = new Map();

/** 在段内首次出现处插入 word（中文）：逐行、跳过标题行、词边界、已注过的词不重注。
 *  逐字移植自补注脚本（实跑验证过的写法，含「## Chapter 行加注会毁解析」的防护）。 */
function insertAnnotation(text, word, zh) {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![\\u4e00-\\u9fff)）])\\b${esc}\\b(?![\\u4e00-\\u9fff（])`, 'i');
  const lines = text.split('\n');
  for (let li = 0; li < lines.length; li++) {
    if (/^#/.test(lines[li])) continue;
    const m = lines[li].match(re);
    if (m) {
      lines[li] = lines[li].replace(re, `${m[0]}（${zh}）`);
      return { text: lines.join('\n'), ok: true };
    }
  }
  return { text, ok: false };
}

/** 批量问模型要释义（只要词义 JSON，不让模型碰文本）；失败抛错不静默 */
async function askGlosses(words) {
  LEDGER.scene.tag = '释义询问';
  const r = await LEDGER.call(
    [
      { role: 'system', content: '你给初中英语教材配生词注释。只输出一个 JSON 对象 {词: 释义}，释义 2-6 个汉字，初中生能懂，不要其他文字。' },
      { role: 'user', content: `给这些词配释义：${words.join(', ')}` },
    ],
    { baseUrl: CFG.baseUrl, key: KEY, model: MODEL, maxTokens: 2000 },
  );
  const map = JSON.parse(r.content.replace(/^[^{]*/, '').replace(/[^}]*$/, ''));
  const out = new Map();
  for (const [w, zh] of Object.entries(map)) {
    if (typeof zh === 'string' && /[\u4e00-\u9fff]/.test(zh)) out.set(String(w).toLowerCase(), zh.trim());
  }
  return out;
}

/** 确定性加注器（注入 stagepipe，annotation 工序的本地路径）：
 *  词典/知识库有释义就地插入；缺的批量问一次模型只要词义；插不进（词不在段里）如实计数。 */
const annotate = async (draft, targets) => {
  let md = draft;
  const missing = [];
  let inserted = 0;
  for (const w of targets.need) {
    const zh = glossHints.get(w) ?? askedGloss.get(w);
    if (!zh) { missing.push(w); continue; }
    const r = insertAnnotation(md, w, zh);
    if (r.ok) { md = r.text; inserted++; }
  }
  if (missing.length) {
    const got = await askGlosses(missing);
    for (const w of missing) {
      const zh = got.get(w) ?? askedGloss.get(w);
      if (!zh) continue;
      askedGloss.set(w, zh);
      const r = insertAnnotation(md, w, zh);
      if (r.ok) { md = r.text; inserted++; }
    }
  }
  return md;
};
const PROPER = P.PROPER ?? [];

/* ── Prompt：固定前缀（本章知识切片，开场后不变，利于前缀缓存）+ 差量 patch 输出契约 ── */
function systemPrefix(t, proper) {
  return `你是面向中国初中生的英语阅读文本调适助手。当前任务层：${t.label}。
【词汇边界】优先用学生已学的词；专名不译不改：${proper.slice(0, 24).join('、')}。
【保真铁律】保留人物关系、关键事件、数字、否定、因果与叙事顺序；不得编造。
【输出契约】只输出一个 JSON 对象：{"patches":[{"id":"P01","status":"changed","text":"[P01] 完整段落文本","reason":"一句话说明"}]}
- 只给你被点名的问题段；每个段给一条 patch；不需要改的段给 {"id":"…","status":"unchanged"}。
- text 必须是**单个段落**的完整文本，以该段 [P##] 标记开头；严禁把多个段落写进一条 patch。
- 除 JSON 外不输出任何文字。`;
}

function userBody(req, glossHintsLocal) {
  const lines = [`工序：${STAGE_LABEL[req.stage]}`, `本章版本：${req.baseVersion}`, '', req.instruction, ''];
  if (req.stage === 'annotation') {
    const hints = [...new Set(req.segments.flatMap((s) => (s.issues.join(' ').match(/[a-z]{3,}/g) ?? [])))]
      .map((w) => [w, glossHintsLocal.get(w)].filter(Boolean).join('：'))
      .filter((x) => x.includes('：'));
    if (hints.length) lines.push(`释义建议（优先采用）：${hints.slice(0, 30).join('；')}`, '');
  }
  lines.push('待处理段落：');
  for (const s of req.segments) {
    lines.push(`--- 段 ${s.id} ---`);
    lines.push(`本段问题：${s.issues.join('；')}`);
    lines.push(`当前稿：${s.draft.trim()}`);
  }
  lines.push('', '输出：按系统契约只输出 JSON patch 对象。');
  return lines.join('\n');
}

/* ── 主流程 ── */
if (dry) {
  console.log(`计划：${tiers.join('/')} 层｜章 ${chapters.join(',')}｜模型 ${MODEL}｜五道工序：词汇粗筛→句法→词汇复筛→连贯性→加注`);
  process.exit(0);
}

const results = [];
for (const tk of tiers) {
  const t = TIERS[tk];
  for (const i of chapters) {
    const ch = CN[i - 1];
    console.log(`▶ ${t.label} ${ch}`);
    LEDGER.scene = { tier: tk, chapter: ch, tag: '' };
    try {
      const srcPath = join(SRC_BASE, ch, '原文_规范化.md');
      if (!existsSync(srcPath)) throw new Error(`${ch} 缺规范化原文`);
      const md = readFileSync(srcPath, 'utf-8');
      const chLine = md.match(/^## Chapter \w+.*$/m)?.[0] ?? '';
      const header = chLine ? md.slice(0, md.indexOf(chLine)) : '';
      const segTexts = splitChapter(md).body.match(/\[P\d+\][\s\S]*?(?=\[P\d+\]|$)/g) ?? [];
      if (!segTexts.length) throw new Error(`${ch} 未找到 [P##] 段落`);
      const segs = segTexts.map((raw) => {
        const id = (raw.match(/\[P(\d+)\]/)?.[1] ?? '').padStart(2, '0');
        return { id: `P${id}`, source: raw.trim(), draft: raw.trim() };
      });

      const dst = RR(t.clsTag).any('正文', { chapter: ch, tier: t.clsTag, suffix: '_工序化' });
      if (existsSync(dst)) {
        console.log(`  已存在（产物在 ${dst}），跳过；重跑请先删该文件`);
        continue;
      }

      const run = await runStagePipeline({
        chapter: ch,
        tier: tk,
        sourceVersion: `${ch}-src-${DATE}`,
        segs,
        knownWords: LEX.known,
        properNouns: PROPER,
        maxLen: t.maxLen,
        ratio: t.ratio,
        glossary: new Map(),
        glossHints,
        mustAnnotate,
        annotate,
        annoCapPerSeg: { A: 2, M: 1, B: 3 }[tk],
        onEvent: (e) => {
          if (e.kind === 'stage-skip') console.log(`  · ${STAGE_LABEL[e.stage]}：本地扫描无命中，零调用`);
          else if (e.kind === 'stage-start') console.log(`  · ${STAGE_LABEL[e.stage]}：${e.detail}`);
          else if (e.kind === 'stage-commit') console.log(`  ✓ ${STAGE_LABEL[e.stage]}：${e.detail}`);
          else if (e.kind === 'stage-fail') console.log(`  ⚠ ${STAGE_LABEL[e.stage]}：${e.detail}`);
          else if (e.kind === 'seg-quarantined') console.log(`  ✗ 隔离 ${e.detail}`);
          if (e.kind === 'stage-start' || e.kind === 'stage-commit') LEDGER.scene.tag = STAGE_LABEL[e.stage];
        },
        callStage: async (req) => {
          LEDGER.scene.tag = STAGE_LABEL[req.stage];
          const r = await LEDGER.call(
            [
              { role: 'system', content: systemPrefix(t, PROPER) },
              { role: 'user', content: userBody(req, glossHints) },
            ],
            { baseUrl: CFG.baseUrl, key: KEY, model: MODEL, maxTokens: 3000 },
          );
          /* STAGE_DEBUG=1：转储每次原始输出（诊断协议遵循情况用，平时不开） */
          if (process.env.STAGE_DEBUG) {
            writeFileSync(`/tmp/stage_debug_${t.key}_${req.stage}_${req.segments.map((x) => x.id).join('-')}.json`, r.content, 'utf-8');
          }
          return r.content;
        },
      });

      /* 落盘：正文（原子写）+ recap + 进度 + 隔离记录 */
      const outMd = `${header}${chLine}${chLine ? '\n\n' : ''}${segs.map((s) => run.text[s.id]).join('\n\n')}\n`;
      mkdirSync(dirOfPath(dst), { recursive: true });
      writeAtomic(dst, outMd, 'utf-8');
      const recap = buildChapterRecap({ chapter: ch, tier: tk, sourceVersion: `${ch}-src-${DATE}`, segs, knownWords: LEX.known, properNouns: PROPER, maxLen: t.maxLen, ratio: t.ratio, callStage: async () => '' }, run);
      const recapPath = join(OUT_BASE, '_运行', `章recap_${t.clsTag}_${ch}.json`);
      mkdirSync(join(OUT_BASE, '_运行'), { recursive: true });
      writeFileSync(recapPath, JSON.stringify(recap, null, 1), 'utf-8');
      const progress = join(OUT_BASE, '_运行', `工序化进度_${t.clsTag}_${ch}.json`);
      writeFileSync(progress, JSON.stringify({ done: true, finalVersion: run.finalVersion, checkpoints: run.checkpoints, quarantined: run.quarantined, at: new Date().toISOString() }, null, 1), 'utf-8');
      if (run.quarantined.length) {
        const qDir = join(OUT_BASE, ch, '_待复核');
        mkdirSync(qDir, { recursive: true });
        writeFileSync(join(qDir, `工序化隔离_${t.clsTag}_${DATE}.md`),
          ['# 工序化隔离段（重试用尽，交教师处置；正文保留该段上一版）',
            ...run.quarantined.map((q) => `- ${q.id}（${STAGE_LABEL[q.stage]}，尝试 ${q.tries} 次）：${q.reason}`)].join('\n') + '\n', 'utf-8');
      }

      const srcW = wc(md.split('## 词句卡')[0]);
      const outW = wc(outMd.split('## 词句卡')[0]);
      const stageLine = run.checkpoints.map((c) => `${STAGE_LABEL[c.stage]}${c.called ? `改${c.changedIds.length}` : '跳'}`).join('｜');
      results.push({ tk, ch, srcW, outW, ratio: outW / Math.max(1, srcW), quarantined: run.quarantined.length, stageLine, dst });
      console.log(`  ✓ 产物：${dst}（${srcW}→${outW} 词，${(outW / Math.max(1, srcW) * 100).toFixed(0)}%）`);
      console.log(`  · 工序：${stageLine}${run.quarantined.length ? `｜隔离 ${run.quarantined.length} 段` : ''}`);
    } catch (e) {
      console.error(`  ✗ ${ch} 失败：${String(e).slice(0, 200)}`);
    }
  }
}

console.log('\n| 层 | 章 | 原文词数 | 产物词数 | 占比 | 工序（改N=改动段数/跳=零调用） | 隔离 |');
console.log('|---|---|---|---|---|---|---|');
for (const r of results) {
  console.log(`| ${r.tk} | ${r.ch} | ${r.srcW} | ${r.outW} | ${(r.ratio * 100).toFixed(0)}% | ${r.stageLine} | ${r.quarantined} |`);
}
const st = LEDGER.flush();
if (st.calls) console.log(`台账：调用 ${st.calls}（成功 ${st.ok}）｜入 ${st.in}${st.cached ? `（缓存命中 ${st.cached}）` : ''}｜出 ${st.out} token —— _运行/token台账.jsonl`);
