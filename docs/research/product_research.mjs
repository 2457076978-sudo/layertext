#!/usr/bin/env node
/** 产品体验研究（只读）：R1→R2 配对归因 + 校对反馈统计。
 *  只读 AnimalFarm 真实资产，输出 docs/research/。命名口径（与管线一致）：
 *  原文_<层>_<日期>_R1.md = R1；原文_<层>_<日期>.md（无后缀）= R2 终稿；_工序化 = 五道工序产物。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url)); // worktree 根
/* 真项目目录从环境变量取：LAYERTEXT_AF_DIR=<Animal Farm 书根>。
   公开仓库里不写作者本机的绝对路径。 */
const AF = process.env.LAYERTEXT_AF_DIR ?? '';
if (!AF) {
  console.error('需要 LAYERTEXT_AF_DIR=<Animal Farm 书根>；这个脚本分析的是真实的 Animal Farm 项目，不在公开仓库里硬编路径。');
  process.exit(2);
}
const SAN = join(AF, '调适工作区/重制三版');
const OUT_DIR = join(REPO, 'docs/research');

const { runQc } = await import(join(REPO, 'dist/src/core/qc.js'));
const { buildLexicon } = await import(join(REPO, 'dist/src/core/lexicon.js'));
const { readWordFile } = await import(join(REPO, 'dist/src/core/files.js'));
const { alignSentencePairs, lostSignals } = await import(join(REPO, 'dist/src/core/align.js'));
const { sentsOf, tokenizeTxt, splitChapter, extractParas } = await import(join(REPO, 'dist/src/core/textpipe.js'));
const { burdenProfileOf, expandForms, introducedHardWords } = await import(join(REPO, 'dist/src/core/adaptcheck.js'));

// ---------- 词库（全变体同一口径：v0.7 班级词库 ∪ 课标 1600 存档；IRR 引擎内并入） ----------
const LEX = buildLexicon({ vocabCsvTexts: [readFileSync(join(AF, '知识文件/已知词汇库_v0.7.csv'), 'utf-8')], plainWordlistTexts: [] });
for (const w of readWordFile(join(AF, '知识文件/课标2022三级词汇表_1600_存档.txt'))) LEX.known.add(w);

const TIERS = ['A层85', 'M层75', 'B层60'];
const CHAPS = ['第三章', '第七章'];
const fileOf = (ch, tier, kind) => {
  const d = join(SAN, ch);
  if (kind === 'src') return join(d, `原文_${tier}_2026-09-10.md`);
  if (kind === 'r1') return join(d, `原文_${tier}_2026-09-12_R1.md`);
  if (kind === 'r2') return join(d, `原文_${tier}_2026-09-12.md`);
  if (kind === 'staged') return join(d, `原文_${tier}_2026-09-12_工序化.md`);
  throw new Error(kind);
};

const ANNO_RE = /[A-Za-z][A-Za-z'-]*（[^）（]*）/g;
const familyIn = (w, tokens) => {
  const forms = new Set(expandForms(w));
  return tokens.some((t) => forms.has(t) || expandForms(t).some((f) => forms.has(f)));
};

function statsOf(path, tier) {
  const md = readFileSync(path, 'utf-8');
  const r = runQc(md, LEX, { tier: tier[0], fileName: basename(path) });
  const prof = burdenProfileOf(md);
  const body = splitChapter(md).body;
  const sents = extractParas(body).flatMap((p) => sentsOf(p, p.includes('Beasts of England')));
  const tokens = tokenizeTxt(sents.join(' '));
  const annotatedSet = new Set((md.match(ANNO_RE) ?? []).map((m) => m.split('（')[0].toLowerCase()));
  const oovSet = new Set(r.oov ?? []);
  return {
    file: basename(path),
    tier,
    tokens: tokens.length,
    sents: sents.length,
    avgLen: +(tokens.length / Math.max(1, sents.length)).toFixed(1),
    oovTypes: oovSet.size,
    oovTokens: (r.oov ?? []).length,
    newWordRate: +r.newWordRate.toFixed(4),
    annotated: r.annotated,
    annotatable: r.annotatable,
    coverage: r.annotatable ? +(r.annotated / r.annotatable).toFixed(2) : null,
    passive: r.passive,
    relcl: r.relcl,
    pastperf: r.pastperf,
    density: prof.densityPer100,
    worstWindow: prof.worstWindow?.density ?? null,
    longestSent: prof.longestSentence?.words ?? null,
    inlineAnnos: (md.match(ANNO_RE) ?? []).length,
    _tokens: tokens,
    _sents: sents,
    _md: md,
    _oovSet: oovSet,
    _annotatedSet: annotatedSet,
  };
}

// ---------- Q1：配对分析 ----------
const pairs = [];
for (const ch of CHAPS)
  for (const tier of TIERS) {
    const has = (k) => existsSync(fileOf(ch, tier, k));
    if (!has('r1')) continue; // 无 R1 不能配对（第三章 M 层）
    const S = statsOf(fileOf(ch, tier, 'src'), tier);
    const R1 = statsOf(fileOf(ch, tier, 'r1'), tier);
    const R2 = statsOf(fileOf(ch, tier, 'r2'), tier);

    // 句对齐 R1 → R2（丢句/新增/信号丢失）
    const ref = (st) => st._sents.map((t, i) => ({ text: t, id: String(i) }));
    const rows = alignSentencePairs(ref(R1), ref(R2));
    const lost = rows.filter((x) => x.kind === 'lost');
    const added = rows.filter((x) => x.kind === 'added');
    const lostSentText = lost.map((x) => x.base.text);
    const lostToks = tokenizeTxt(lostSentText.join(' '));
    const allLostSignals = lost.flatMap((x) => lostSignals(x.base.text, ''));
    const sigNum = allLostSignals.filter((s) => /^[0-9]/.test(s)).length;
    const sigName = allLostSignals.filter((s) => /^[A-Z]/.test(s)).length;

    // OOV 降幅归因（词型口径，词形家族容错）
    const removed = [...R1._oovSet].filter((w) => !familyIn(w, R2._tokens));
    const byDeletedSent = removed.filter((w) => {
      const forms = new Set(expandForms(w));
      const inLive = R1._sents.filter((s) => !lostSentText.includes(s)).some((s) => tokenizeTxt(s).some((t) => forms.has(t) || expandForms(t).some((f) => forms.has(f))));
      return !inLive; // 全部出现都在被丢弃的句子里 → 删句带走
    });
    const byRewrite = removed.filter((w) => !byDeletedSent.includes(w));
    const introduced = introducedHardWords(R1._md, R2._md, (w) => !LEX.known.has(w) && !familyIn(w, R1._tokens));

    pairs.push({
      chapter: ch,
      tier,
      src: { tokens: S.tokens, oovTypes: S.oovTypes, density: S.density, passive: S.passive, relcl: S.relcl },
      r1: {
        tokens: R1.tokens,
        oovTypes: R1.oovTypes,
        avgLen: R1.avgLen,
        annotated: R1.annotated,
        coverage: R1.coverage,
        passive: R1.passive,
        relcl: R1.relcl,
        pastperf: R1.pastperf,
        density: R1.density,
        worstWindow: R1.worstWindow,
        longest: R1.longestSent,
      },
      r2: {
        tokens: R2.tokens,
        oovTypes: R2.oovTypes,
        avgLen: R2.avgLen,
        annotated: R2.annotated,
        coverage: R2.coverage,
        passive: R2.passive,
        relcl: R2.relcl,
        pastperf: R2.pastperf,
        density: R2.density,
        worstWindow: R2.worstWindow,
        longest: R2.longestSent,
      },
      align: { match: rows.length - lost.length - added.length, lost: lost.length, added: added.length, lostWords: lostToks.length, sigNum, sigName },
      attribution: {
        oovDrop: R1.oovTypes - R2.oovTypes,
        byRewrite: byRewrite.length,
        byDeletedSent: byDeletedSent.length,
        byRewriteWords: byRewrite.slice(0, 12),
        byDeletedSentWords: byDeletedSent.slice(0, 8),
        keptAnnotated: [...R2._oovSet].filter((w) => R2._annotatedSet.has(w)).length,
        keptUnannotated: [...R2._oovSet].filter((w) => !R2._annotatedSet.has(w)).length,
        introduced: introduced.length,
        introducedWords: introduced.slice(0, 10),
      },
      sampleLost: lostSentText.slice(0, 3).map((s) => s.slice(0, 90)),
    });

    // 工序化对照（目前只有 A 层）
    if (has('staged')) {
      const ST = statsOf(fileOf(ch, tier, 'staged'), tier);
      pairs.push({
        chapter: ch,
        tier,
        kind: 'staged',
        staged: {
          tokens: ST.tokens,
          oovTypes: ST.oovTypes,
          annotated: ST.annotated,
          coverage: ST.coverage,
          density: ST.density,
          worstWindow: ST.worstWindow,
          keptAnnotated: [...ST._oovSet].filter((w) => ST._annotatedSet.has(w)).length,
          keptUnannotated: [...ST._oovSet].filter((w) => !ST._annotatedSet.has(w)).length,
        },
      });
    }
  }

// ---------- Q2：校对反馈统计 ----------
const feedbacks = [];
for (const ch of CHAPS)
  for (const tier of TIERS) {
    const p = join(SAN, '_运行', `两轮调适进度_${tier}_${ch}.json`);
    if (existsSync(p)) {
      const d = JSON.parse(readFileSync(p, 'utf-8'));
      feedbacks.push({ chapter: ch, tier, feedback: d.feedback ?? '', round: d.round, boundaryNote: d.boundaryNote ?? '' });
    }
  }
const tasks = readdirSync(join(SAN, '_运行'))
  .filter((f) => f.startsWith('调适任务单'))
  .map((f) => {
    const d = JSON.parse(readFileSync(join(SAN, '_运行', f), 'utf-8'));
    return {
      file: f,
      stages: d.task.stages.map((s) => s.stage),
      magnitude: d.task.magnitude,
      dims: d.task.parsed?.dims,
      keep: d.task.parsed?.keep,
      tooHard: d.task.parsed?.tooHardWords,
      seedWords: d.task.seedWords,
      needsHuman: d.task.needsHuman,
      confirmed: d.confirmed,
    };
  });
const decDirs = [join(AF, '_决定'), join(SAN, '_决定')];
const decisions = decDirs.flatMap((d) => (existsSync(d) ? readdirSync(d) : []));

writeFileSync(
  join(OUT_DIR, 'pairs_report.json'),
  JSON.stringify(
    { generatedAt: new Date().toISOString(), lexicon: 'v0.7 ∪ 课标1600存档', pairs, feedbacks, tasks, decisionsFiles: decisions.length },
    (k, v) => (k.startsWith('_') ? undefined : v),
    2,
  ),
);

// ---------- 摘要打印 ----------
console.log('=== Q1 R1→R2 配对 ===');
for (const p of pairs.filter((x) => !x.kind)) {
  const a = p.attribution;
  console.log(
    `${p.chapter} ${p.tier}: OOV ${p.src.oovTypes}→R1 ${p.r1.oovTypes}→R2 ${p.r2.oovTypes} | 词数 ${p.r1.tokens}→${p.r2.tokens} | 注释覆盖 ${p.r1.coverage}→${p.r2.coverage} | 丢句${p.align.lost} 新增${p.align.added}（信号: 数字${p.align.sigNum}/专名${p.align.sigName}）| 降幅归因: 换词${a.byRewrite} 删句${a.byDeletedSent} | 保留: 已注${a.keptAnnotated}/未注${a.keptUnannotated} | 引入${a.introduced}`,
  );
  console.log(
    `   被动 ${p.r1.passive}→${p.r2.passive} 定从 ${p.r1.relcl}→${p.r2.relcl} 过完 ${p.r1.pastperf}→${p.r2.pastperf} | 最长句 ${p.r1.longest}→${p.r2.longest} | 密度 ${p.r1.density}→${p.r2.density} 最密窗 ${p.r1.worstWindow}→${p.r2.worstWindow}`,
  );
}
console.log('--- 工序化对照（A 层） ---');
for (const p of pairs.filter((x) => x.kind === 'staged')) {
  const s = p.staged;
  console.log(`${p.chapter}: tokens ${s.tokens} OOV ${s.oovTypes} 覆盖 ${s.coverage} | 保留: 已注${s.keptAnnotated}/未注${s.keptUnannotated} | 密度 ${s.density} 最密窗 ${s.worstWindow}`);
}
console.log('=== Q2 反馈（N=' + feedbacks.length + '） ===');
for (const f of feedbacks) console.log(`${f.chapter} ${f.tier}: ${f.feedback} ${f.boundaryNote ? '| boundaryNote: ' + f.boundaryNote : ''}`);
console.log('=== 任务单 ===');
for (const t of tasks) console.log(`${t.file} → ${t.stages.join(',')} | 幅度${t.magnitude} | dims:${t.dims} | keep:${t.keep} | 点名:${t.seedWords} | confirmed:${t.confirmed}`);
console.log('=== 决定日志文件数 ===', decisions.length, decisions.length ? '' : '(0 = 回流闭环尚未开始记录)');
