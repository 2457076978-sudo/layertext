#!/usr/bin/env node
/**
 * LayerText · 冻结真项目回放样本
 *
 * 来源：《LayerText 工程优化总计划》「最关键的代码纪律」第 5 条 ——
 *   「测试分成纯函数、事务故障、**真项目回放**三层；495 项全绿是底线，不是产品完成标准。」
 * 以及阶段 4 验收 ——「四格实验有可重复的输入快照和原始事件；**任一质量结论都能追溯到运行 ID**」。
 *
 * ── 这一层补的是什么 ────────────────────────────────────────────────────
 * 前两层（纯函数、事务故障）都在问"这段代码对不对"；
 * 它们**回答不了**"我们报给教师的那些数还对不对"。
 * 而项目里到处写着的那些数——A 层第一章 SENT-01 = 19 句、阅读负荷下降 30%、
 * 理解支架覆盖率 94%、风险队列 70 条压成 19 组——**没有任何东西在守着它们**。
 * 一次重构让某个数悄悄从 94% 变成 91%，没人会发现，直到有人拿它去写论文。
 *
 * 所以这一层做的事很朴素：**把真项目的一份输入冻下来，再把从它算出来的结论冻下来**，
 * 之后每次跑测试都重算一遍、逐个对数。数变了就必须有人解释。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *   # 从真项目冻结（**只读**，一个字节都不写回项目）
 *   node tools/af_pipeline/LayerText_AF冻结回放.mjs \
 *     --project /path/to/调适项目_AnimalFarm.json --chapters 1 --tiers A,M,B
 *
 *   # 只对账、不写文件（CI 里用）
 *   node tools/af_pipeline/LayerText_AF冻结回放.mjs --check
 *
 * 冻结的是**完整**输入（整份词库、词典、专名、知识库），不做任何"精简"：
 * 精简会引入一个"精简后是否等价"的问题，而那个问题得永远重新验证一遍。
 * 整份冻下来是几百 KB，换的是"回放就是真的回放"。
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const SHARED = await import('./LayerText_AF词表与词典.mjs');
const { loadProject } = SHARED;
const { annotatableOf } = await import(`${REPO}/dist/src/core/segmentgate.js`);
const { gateSegment } = await import(`${REPO}/dist/src/core/segmentgate.js`);
const { runQc } = await import(`${REPO}/dist/src/core/qc.js`);
const { positioningOf } = await import(`${REPO}/dist/src/core/positioning.js`);
const { parseDictCsv } = await import(`${REPO}/dist/src/core/dictmerge.js`);
const { splitChapter } = await import(`${REPO}/dist/src/core/textpipe.js`);
const { atomicWriteFileSync: writeAtomic } = await import(`${REPO}/dist/src/core/files.js`);

const FIXTURE = join(REPO, 'tests', 'fixtures', 'replay');
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const has = (n) => argv.includes(n);

const TIER_INFO = {
  A: { tag: 'A层85', ratio: 0.85, maxLen: 20 },
  M: { tag: 'M层75', ratio: 0.75, maxLen: 16 },
  B: { tag: 'B层60', ratio: 0.6, maxLen: 14 },
};
const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

/** 冻结时把绝对路径从结论里抹掉：结论应当只描述"数"，不描述"这台机器上的位置" */
const scrub = (s) => String(s).replace(/(?:\/Users|\/var|\/tmp)\S*/g, '<path>');

/* ────────────────────── 把输入抄进 fixture ────────────────────── */

function copyInputs(P, projectPath, chapters, tiers) {
  const files = [];
  const put = (rel, text) => {
    const dst = join(FIXTURE, '输入', rel);
    mkdirSync(dirname(dst), { recursive: true });
    writeAtomic(dst, text);
    files.push(rel);
  };

  // 源树：归一化原文（判"篇幅偏离"和做对照都要它）
  for (const ci of chapters) {
    const ch = `第${CN[ci - 1]}章`;
    const p = join(P.原文目录, ch, '原文_规范化.md');
    if (existsSync(p)) put(`原文/${ch}/原文_规范化.md`, readFileSync(p, 'utf-8'));
  }
  // 产物：三档正文（**这就是要回放的对象**）
  for (const t of tiers) {
    for (const ci of chapters) {
      const ch = `第${CN[ci - 1]}章`;
      const p = join(P.产物目录, ch, `原文_${TIER_INFO[t].tag}_${P.日期}.md`);
      if (existsSync(p)) put(`产物/${ch}/原文_${TIER_INFO[t].tag}_${P.日期}.md`, readFileSync(p, 'utf-8'));
    }
  }
  // 词表侧的四样（全份，不精简）
  const srcs = { 词库: P.词库, 词典: P.书级?.词典, 专名表: P.书级?.专名表, 知识库: P.书级?.知识库 };
  for (const [name, p] of Object.entries(srcs)) {
    if (typeof p === 'string' && existsSync(p)) put(`知识文件/${name}${basename(p).slice(basename(p).lastIndexOf('.'))}`, readFileSync(p, 'utf-8'));
  }
  const cfg = {
    _说明: '这是 tests/fixtures/replay 的输入快照：路径全部是**相对本目录**的，回放时由测试复制到临时目录并重写。',
    来源项目: basename(projectPath),
    日期: P.日期,
    章数: P.章数 ?? chapters.length,
    原文目录: '原文',
    产物目录: '产物',
    调适工作区: '调适',
    词库: `知识文件/词库${basename(P.词库).slice(basename(P.词库).lastIndexOf('.'))}`,
    书级: {
      专名表: `知识文件/专名表${basename(P.书级?.专名表 ?? 'x.txt').slice(basename(P.书级?.专名表 ?? 'x.txt').lastIndexOf('.'))}`,
      知识库: `知识文件/知识库${basename(P.书级?.知识库 ?? 'x.csv').slice(basename(P.书级?.知识库 ?? 'x.csv').lastIndexOf('.'))}`,
      词典: `知识文件/词典${basename(P.书级?.词典 ?? 'x.csv').slice(basename(P.书级?.词典 ?? 'x.csv').lastIndexOf('.'))}`,
    },
  };
  put('调适项目_回放.json', JSON.stringify(cfg, null, 2));
  return files;
}

/* ────────────────────── 算结论 ────────────────────── */

async function computeConclusions(root) {
  const cfg = JSON.parse(readFileSync(join(root, '调适项目_回放.json'), 'utf-8'));
  const abs = (rel) => join(root, rel);
  /* ★ 词表构造**必须走共享模块**，不能自己 `buildLexicon({vocabCsvTexts:[…]})`。
   *
   * 第一版这里就是自己组的，结果与项目自己的复核报告对不上：
   *   · 漏了内置**课标词表**（`assets/wordlists/curriculum_2022_*`）→ 大量课标词被判成超纲；
   *   · 漏了**专名表**（`properNouns`）→ clover / squealer 这些人名地名也进了分母。
   * 于是"原文生词率"算出 21%（报告是 16.5%）、A 层应注词型 79（报告是 56）。
   *
   * 这件事值得写下来：**回放层的第一件事就是跟项目的复核报告对账**，
   * 而它第一次对账就抓到了自己的错——这正是这一层存在的意义，
   * 只不过这次被抓的是工具而不是被回放的对象。 */
  const P = {
    ...cfg,
    配置路径: join(root, '调适项目_回放.json'),
    引擎目录: REPO,
    原文目录: abs(cfg.原文目录),
    产物目录: abs(cfg.产物目录),
    调适工作区: abs(cfg.调适工作区),
    词库: abs(cfg.词库),
    专名表路径: abs(cfg.书级.专名表),
    知识库路径: abs(cfg.书级.知识库),
    词典路径: abs(cfg.书级.词典),
    PROPER: [],
  };
  P.PROPER = SHARED.loadProper(P.专名表路径, { tolerant: true });
  const LEX = await SHARED.liveLexicon(P);
  const DICT = new Map(parseDictCsv(readFileSync(P.词典路径, 'utf-8')).map((e) => [e.word, e.zh]));

  const out = { 章节: {}, 定位两条轴: {}, 风险队列: {}, 任务组: {} };

  for (const t of Object.keys(TIER_INFO)) {
    const info = TIER_INFO[t];
    const tierOut = { 段: [], 质检: null };
    for (let ci = 1; ci <= (cfg.章数 ?? 1); ci++) {
      const ch = `第${CN[ci - 1]}章`;
      const srcPath = join(P.原文目录, ch, '原文_规范化.md');
      const outPath = join(P.产物目录, ch, `原文_${info.tag}_${cfg.日期}.md`);
      if (!existsSync(srcPath) || !existsSync(outPath)) continue;

      const srcMd = readFileSync(srcPath, 'utf-8');
      const outMd = readFileSync(outPath, 'utf-8');
      const srcSegs = splitChapter(srcMd).body.match(/\[P\d+\][\s\S]*?(?=\[P\d+\]|$)/g) ?? [];
      const outSegs = (splitChapter(outMd).body.match(/\[P\d+\][\s\S]*?(?=\[P\d+\]|$)/g) ?? []).map((s) => s.trim());
      const wc = (x) => (x.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).length;
      const srcWords = srcSegs.reduce((n, s) => n + wc(s), 0);
      const outWords = outSegs.reduce((n, s) => n + wc(s), 0);

      // 段级门禁：**逐段**跑，把每条规则命中几次记下来
      const perRule = {};
      let overLenTotal = 0;
      for (let k = 0; k < srcSegs.length; k++) {
        const body = outSegs[k];
        if (!body) continue;
        const q = runQc(`## Chapter One\n\n${body}\n`, LEX, { tier: t, fileName: 'seg.md', dict: DICT });
        const v = gateSegment({
          text: body,
          source: srcSegs[k],
          target: Math.round(wc(srcSegs[k]) * info.ratio),
          maxLen: info.maxLen,
          oov: annotatableOf(q.oov),
          dict: DICT,
        });
        overLenTotal += v.overLen;
        for (const p of v.problems) perRule[p.ruleId] = (perRule[p.ruleId] ?? 0) + 1;
        tierOut.段.push({ 章: ch, 段号: `P${String(k + 1).padStart(2, '0')}`, 状态: v.status, 规则: v.problems.map((p) => p.ruleId).sort() });
      }

      // 整章质检 + 定位两条轴（**这两条轴是报给教师看的，最该被守住**）
      const qOut = runQc(outMd, LEX, { tier: t, fileName: `${ch}.md`, dict: DICT });
      const qSrc = runQc(srcMd, LEX, { tier: t, fileName: `${ch}_src.md`, dict: DICT });
      tierOut.质检 = {
        章: ch,
        原文词数: qSrc.words,
        产物词数: qOut.words,
        生词率: Number((qOut.newWordRate * 100).toFixed(1)),
        原文生词率: Number((qSrc.newWordRate * 100).toFixed(1)),
        应注词型: qOut.annotatable,
        已注词型: qOut.annotated,
        加注覆盖率: Number((qOut.annotationCoverage * 100).toFixed(1)),
        平均句长: Number(qOut.avgLenNarrRaw.toFixed(1)),
        被动: qOut.passive,
        定语从句: qOut.relcl,
        过去完成: qOut.pastPerf,
        超长句: qOut.over20,
      };
      const pos = positioningOf(qSrc, qOut);
      out.定位两条轴[t] = {
        // 两条轴各自成轴，**不合成**（与 positioning.ts 一致）。存的是四舍五入后的整数，
        // 因为报给教师看的就是这个数——守住"教师看到的那个数"，而不是更高的精度。
        阅读负荷下降: Math.round(pos.load.value * 100),
        理解支架覆盖率: Math.round(pos.scaffolding.value * 100),
        原文生词率: Number((qSrc.newWordRate * 100).toFixed(1)),
        产物生词率: Number((qOut.newWordRate * 100).toFixed(1)),
        一句话: scrub(pos.headline),
      };
      tierOut.篇幅比 = Number((outWords / Math.max(1, srcWords)).toFixed(3));
      tierOut.规则命中 = Object.fromEntries(Object.entries(perRule).sort());
      tierOut.超长句总数 = overLenTotal;
    }
    out.章节[t] = tierOut;
  }
  return { out, LEX, DICT };
}

/* ────────────────────── 主流程 ────────────────────── */

const projectPath = arg('--project', '');
const chapters = (arg('--chapters', '1') || '1')
  .split(',')
  .map((x) => Number(x.trim()))
  .filter((n) => n >= 1 && n <= 10);
const tiers = (arg('--tiers', 'A,M,B') || 'A,M,B')
  .split(',')
  .map((x) => x.trim().toUpperCase())
  .filter((t) => TIER_INFO[t]);

if (has('--check') || !projectPath) {
  // 只对账：拿已冻的输入重算一遍，与已冻的结论比
  if (!existsSync(join(FIXTURE, '期望结论.json'))) {
    console.error('✗ 还没有冻结过（tests/fixtures/replay/期望结论.json 不存在）。');
    console.error('  先跑一次：node tools/af_pipeline/LayerText_AF冻结回放.mjs --project <调适项目.json>');
    process.exit(2);
  }
  const want = JSON.parse(readFileSync(join(FIXTURE, '期望结论.json'), 'utf-8'));
  const { out } = await computeConclusions(join(FIXTURE, '输入'));
  const same = JSON.stringify(want.结论) === JSON.stringify(out);
  console.log(same ? '✓ 回放结论与冻结的一致' : '✗ 回放结论与冻结的**不一致**');
  if (!same) {
    for (const t of Object.keys(out.章节)) {
      const a = JSON.stringify(want.结论.章节[t]);
      const b = JSON.stringify(out.章节[t]);
      if (a !== b) console.log(`  · ${t} 层：期望 ${a.slice(0, 200)}…\n            实得 ${b.slice(0, 200)}…`);
    }
  }
  process.exit(same ? 0 : 1);
}

console.log('════ 冻结真项目回放样本 ════');
const P = loadProject(projectPath);
if (!P.产物目录 || !P.原文目录) {
  console.error('✗ 项目配置里缺 原文目录 / 产物目录');
  process.exit(2);
}
console.log(` 项目：${P._meta?.名称 ?? basename(projectPath)}｜章：${chapters.join(',')}｜层：${tiers.join(',')}`);

mkdirSync(FIXTURE, { recursive: true });
const files = copyInputs(P, projectPath, chapters, tiers);
console.log(` 输入快照 ${files.length} 个文件（**全份**，不做精简——精简会引入一个要永远重新验证的等价性问题）`);
for (const f of files) console.log(`   · ${f}`);

const { out, LEX } = await computeConclusions(join(FIXTURE, '输入'));
const meta = {
  schemaVersion: 1,
  说明:
    '真项目回放层的冻结结论。**这些数就是项目报给教师的那些数**（SENT-01 命中数、阅读负荷下降、理解支架覆盖率、风险队列构成）。' +
    '它们此前没有任何东西在守：一次重构让某个数悄悄变一点点，没人会发现，直到有人拿它去写论文。',
  冻结自: basename(projectPath),
  章: chapters,
  层: tiers,
  词表规模: { 已知: LEX.known.size },
  结论: out,
};
writeAtomic(join(FIXTURE, '期望结论.json'), JSON.stringify(meta, null, 2));
console.log(`\n 结论已冻结：${join(FIXTURE, '期望结论.json')}`);
for (const t of tiers) {
  const c = out.章节[t];
  if (!c?.质检) continue;
  console.log(` ${t} 层：篇幅 ${c.篇幅比}｜超长句 ${c.超长句总数} 句｜加注覆盖率 ${c.质检.加注覆盖率}%｜生词率 ${c.质检.原文生词率}% → ${c.质检.生词率}%`);
  console.log(`        定位两条轴：阅读负荷下降 ${out.定位两条轴[t].阅读负荷下降}%｜理解支架覆盖率 ${out.定位两条轴[t].理解支架覆盖率}%`);
  console.log(`        规则命中：${JSON.stringify(c.规则命中)}`);
}
