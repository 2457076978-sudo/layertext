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
 * 而项目里到处写着的那些数——A 层第一章 SENT-01 = 19 句、阅读负荷下降 28%、
 * 理解支架覆盖率 96%、风险队列 70 条压成 19 组——**没有任何东西在守着它们**。
 * 一次重构让某个数悄悄从 96% 变成 93%，没人会发现，直到有人拿它去写论文。
 *
 * 所以这一层做的事很朴素：**把真项目的一份输入冻下来，再把从它算出来的结论冻下来**，
 * 之后每次跑测试都重算一遍、逐个对数。数变了就必须有人解释。
 *
 * ── 2026-09-12 扩到全书：只守第一章，等于没守出过事的那几章 ──────────────
 * 第一版只冻了第一章。而项目的真实事故**恰好不在第一章**：
 * A 层第七/八/九章一度只有 2%/3%/1% 的加注覆盖率，很久没人发现——
 * 因为当时的报表只统计"加了多少注"，**没有统计"本该加多少注"**。
 * 于是**出事的那三章正好是没有人守的那三章**。这不是巧合：
 * "守第一章"这种选法本身带着幸存者偏差，它守的是我们**愿意看**的那一章。
 *
 * 所以这一版把 10 章 × 3 档全部冻下来，并且**每章都单独记下**
 * `应注词型 / 已注词型 / 漏注词型 / 加注覆盖率`——
 * "本该加多少"（分母）从此和"加了多少"（分子）一起进样本，两者一起被守着。
 *
 * ── 缺失的章节必须喊出来，不许静默跳过 ──────────────────────────────────
 * 冻结时逐（章 × 层）探测输入是否齐；缺哪个、缺的是什么文件，都写进
 * `覆盖.缺失` 并且打到屏幕上。**静默跳过是最坏的一种**：
 * 样本里少一章，测试照样全绿，而"没人守那一章"这件事没有任何痕迹。
 *
 * ── 为什么仍然不做精简 ──────────────────────────────────────────────────
 * 冻结的是**完整**输入（整份词库、词典、专名表、知识库、每章原文与三档产物）：
 * 精简会引入一个"精简后是否等价"的问题，而那个问题得永远重新验证一遍。
 * 全书 10 章冻下来约 0.9MB——比第一章的 320KB 大，但仍在"一次 git clone 里无感"的量级，
 * 换的是"回放就是真的回放"。更实际的一条：**要守的东西就在正文里**
 * （漏注一个词，是"正文里少了一对括号"这件事），把正文剪掉就等于把守卫本身剪掉。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *   # 从真项目冻结**全部**章节（**只读**，一个字节都不写回项目）
 *   node tools/af_pipeline/LayerText_AF冻结回放.mjs --project /path/to/调适项目_AnimalFarm.json
 *
 *   # 只冻指定章节 / 指定层；写到自己指定的目录（测试拿它做反证）
 *   node tools/af_pipeline/LayerText_AF冻结回放.mjs --project … --chapters 1,7 --tiers A --out /tmp/x
 *
 *   # 只对账、不写文件（CI 与测试里用）；--root 指向别处的样本副本
 *   node tools/af_pipeline/LayerText_AF冻结回放.mjs --check [--root 样本目录] [--chapters 7]
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const SHARED = await import('./LayerText_AF词表与词典.mjs');
const { loadProject, distOf } = SHARED;
/* 引擎的编译产物目录**不写死** `<REPO>/dist`：多人/多 agent 并行改同一个仓库时，
 * 谁都不许去写共享的 dist/，也不必等它被重建——用 LAYERTEXT_DIST 指到自己的 outDir。
 * （这是本仓库自己的约定，见「词表与词典.mjs」里 distOf 的注释。） */
const DIST = distOf();
const { annotatableOf, gateSegment } = await import(`${DIST}/src/core/segmentgate.js`);
const { runQc } = await import(`${DIST}/src/core/qc.js`);
const { positioningOf } = await import(`${DIST}/src/core/positioning.js`);
const { parseDictCsv } = await import(`${DIST}/src/core/dictmerge.js`);
const { splitChapter } = await import(`${DIST}/src/core/textpipe.js`);
const { atomicWriteFileSync: writeAtomic } = await import(`${DIST}/src/core/files.js`);

/* 回放夹具**不进公开仓库**（里面是原书正文与教师的三层产物）——放在仓库外，
   用 `LAYERTEXT_REPLAY_DIR` 指过来；调用方也可以用 `--root` 显式指定。 */
const FIXTURE = (() => {
  const 外部 = process.env.LAYERTEXT_REPLAY_DIR;
  if (外部) return 外部;
  /* 默认外部位置 = 本应用的配置目录（与 ~/.layertext.json、`书架.json` 同一个家，
     不是某个人的私人路径）——这样教师本机不用配任何变量就照旧跑得到回放层。 */
  const 应用配置目录 = join(homedir(), 'Documents', 'LayerText配置', '回放夹具_真项目');
  if (existsSync(应用配置目录)) return 应用配置目录;
  return join(REPO, 'tests', 'fixtures', 'replay');
})();
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
/* 章号 → 章名。**超范围也要给出人话**：`--chapters 99` 报错时写成"第undefined章"
 * 是没法看的——报错本身要能读，否则等于没报。 */
const chName = (ci) => `第${CN[ci - 1] ?? ci}章`;
const chNum = (ch) => CN.indexOf(String(ch).replace(/^第|章$/g, '')) + 1;
/** `--partial 10` / `--partial 3,10` → 章号数组（过滤非法值并去重排序——口径输入先归一） */
const parsePartial = (raw) =>
  [...new Set(String(raw ?? '').split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n >= 1 && n <= CN.length))].sort((a, b) => a - b);
const tierArgs = (s) =>
  String(s)
    .split(',')
    .map((x) => x.trim().toUpperCase())
    .filter((t) => TIER_INFO[t]);

/** 冻结时把绝对路径从结论里抹掉：结论应当只描述"数"，不描述"这台机器上的位置" */
const scrub = (s) => String(s).replace(/(?:\/Users|\/var|\/tmp)\S*/g, '<path>');

/* ────────────────────── 项目树指纹：证明这个工具是只读的 ────────────────────── */

/** 走一遍目录，记下每个文件的 sha256。用来在冻结前后各拍一张快照。 */
function treeManifest(rootDir) {
  const m = new Map();
  const walk = (dir) => {
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; /* 读不到的目录当作不存在：指纹只覆盖读得到的东西，不猜 */
    }
    for (const e of ents) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) m.set(relative(rootDir, p), createHash('sha256').update(readFileSync(p)).digest('hex'));
    }
  };
  walk(rootDir);
  return m;
}

/** 把整棵树压成一个 16 位指纹：报告里能贴一行，人一眼看得出"没动过" */
function manifestDigest(m) {
  const h = createHash('sha256');
  for (const k of [...m.keys()].sort()) h.update(k).update(m.get(k));
  return h.digest('hex').slice(0, 16);
}

/** 对比两份快照，返回人话的差异清单（新增/删除/内容变了） */
function manifestDiff(before, after) {
  const diffs = [];
  for (const [k, v] of before) {
    if (!after.has(k)) diffs.push(`被删除：${k}`);
    else if (after.get(k) !== v) diffs.push(`被改写：${k}`);
  }
  for (const k of after.keys()) if (!before.has(k)) diffs.push(`凭空多出：${k}`);
  return diffs;
}

/* ────────────────────── 探测：哪些章 × 层真的能回放 ────────────────────── */

/**
 * 逐（章 × 层）看输入齐不齐。**缺的必须报出来**，不许静默跳过——
 * 静默跳过会让"这一章没人守"变成一件没有痕迹的事，而那正是上一轮的事故。
 *
 * 参数是"原文目录 / 产物目录 / 日期"三个量而不是一份项目配置：
 * 冻结时它们指向真项目，`--check` 时它们指向样本副本，同一套探测两处复用——
 * 于是"样本里被删掉一个文件"在 `--check` 时也会被同一套规则看见。
 */
function probe({ srcBase, outBase, date, chapters, tiers }) {
  const 可用 = [];
  const 缺失 = [];
  for (const ci of chapters) {
    if (!(ci >= 1)) continue;
    const ch = chName(ci);
    const src = join(srcBase, ch, '原文_规范化.md');
    const srcOk = existsSync(src);
    for (const t of tiers) {
      const 产物 = `原文_${TIER_INFO[t].tag}_${date}.md`;
      const outPath = join(outBase, ch, 产物);
      const outOk = existsSync(outPath);
      if (srcOk && outOk) 可用.push({ ci, ch, t, src, out: outPath });
      else {
        const 缺 = [...(srcOk ? [] : ['原文_规范化.md']), ...(outOk ? [] : [产物])];
        缺失.push({ 章: ch, 层: t, 缺: 缺.join('、') });
      }
    }
  }
  return { 可用, 缺失 };
}

/** 一本书到底有几章：以"原文或任一档产物存在"为准，从 1 数到 10（AF 是十章的册子）。 */
function detectChapters(srcBase, outBase, date, tiers) {
  const hits = [];
  for (let ci = 1; ci <= CN.length; ci++) {
    const ch = chName(ci);
    const hasSrc = existsSync(join(srcBase, ch, '原文_规范化.md'));
    const hasOut = tiers.some((t) => existsSync(join(outBase, ch, `原文_${TIER_INFO[t].tag}_${date}.md`)));
    if (hasSrc || hasOut) hits.push(ci);
  }
  return hits;
}

/* ────────────────────── 把输入抄进 fixture ────────────────────── */

function copyInputs(P, projectPath, chapters, tiers, root, partial = []) {
  const files = [];
  const put = (rel, text) => {
    const dst = join(root, '输入', rel);
    mkdirSync(dirname(dst), { recursive: true });
    writeAtomic(dst, text);
    files.push(rel);
  };

  // 源树：归一化原文（判"篇幅偏离"和做对照都要它）
  for (const ci of chapters) {
    const ch = chName(ci);
    const p = join(P.原文目录, ch, '原文_规范化.md');
    if (existsSync(p)) put(`原文/${ch}/原文_规范化.md`, readFileSync(p, 'utf-8'));
  }
  // 产物：三档正文（**这就是要回放的对象**）
  for (const t of tiers) {
    for (const ci of chapters) {
      const ch = chName(ci);
      const p = join(P.产物目录, ch, `原文_${TIER_INFO[t].tag}_${P.日期}.md`);
      if (existsSync(p)) put(`产物/${ch}/原文_${TIER_INFO[t].tag}_${P.日期}.md`, readFileSync(p, 'utf-8'));
    }
  }
  // 词表侧的四样（全份，不精简）
  const srcs = { 词库: P.词库, 词典: P.书级?.词典, 专名表: P.书级?.专名表, 知识库: P.书级?.知识库 };
  for (const [name, p] of Object.entries(srcs)) {
    const ext = (x) => basename(x).slice(basename(x).lastIndexOf('.'));
    if (typeof p === 'string' && existsSync(p)) put(`知识文件/${name}${ext(p)}`, readFileSync(p, 'utf-8'));
  }
  const ext = (p, d) => basename(p ?? d).slice(basename(p ?? d).lastIndexOf('.'));
  const cfg = {
    _说明: '这是 tests/fixtures/replay 的输入快照：路径全部是**相对本目录**的，回放时由测试复制到临时目录并重写。',
    来源项目: basename(projectPath),
    日期: P.日期,
    /* 章列表是**冻结时**探测到的那一份，`--check` 不再重新探测：
     * 重新探测会把"样本里少了一章"这件事故自动抹平（少一章 → 少检查一章 → 依旧全绿）。 */
    章列表: chapters.map(chName),
    章数: chapters.length,
    /* partial 章声明（`--partial 10`）随样本冻下来——冻结与 --check 必须同一个口径，
     * 否则"冻结时不算第十章、对账时又算上"会把好样本错报成不一致。 */
    partialChapters: partial,
    原文目录: '原文',
    产物目录: '产物',
    调适工作区: '调适',
    词库: `知识文件/词库${ext(P.词库, 'x.csv')}`,
    书级: {
      专名表: `知识文件/专名表${ext(P.书级?.专名表, 'x.txt')}`,
      知识库: `知识文件/知识库${ext(P.书级?.知识库, 'x.csv')}`,
      词典: `知识文件/词典${ext(P.书级?.词典, 'x.csv')}`,
    },
  };
  put('调适项目_回放.json', JSON.stringify(cfg, null, 2));
  return files;
}

/* ────────────────────── 算结论 ────────────────────── */

/** 一份 md 里按 [Pxx] 切出来的段落 */
const segsOf = (md) => splitChapter(md).body.match(/\[P\d+\][\s\S]*?(?=\[P\d+\]|$)/g) ?? [];
const wc = (x) => (x.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).length;

/**
 * 算一份样本的全部结论。
 *
 * `章过滤 / 层过滤` 只给 `--check` 用：改动某一章之后想快速确认"抓到了没有"，
 * 不必把全书重算一遍（重算本身不慢，但报告里指到哪一章更有用）。
 * 过滤只会让结论**少算几章**，不会改变任何一章自己的数。
 */
async function computeConclusions(root, { 章过滤 = null, 层过滤 = null, partial = null } = {}) {
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

  const 全部层 = Object.keys(TIER_INFO);
  const 层列表 = 层过滤 ? 全部层.filter((t) => 层过滤.includes(t)) : 全部层;
  const 全部章 = cfg.章列表 ?? detectChapters(P.原文目录, P.产物目录, cfg.日期, 层列表).map(chName);
  const 章列表 = 章过滤 ? 全部章.filter((c) => 章过滤.includes(c)) : 全部章.slice();
  /* partial 章（**显式声明**"这一章还没写完"，如 `--partial 10`）：进分章结论、进覆盖，
   * 但**不进全书分母**——半成品以 3/223 的权重混进"全书"数，正是"守着半成品
   * 还以为守着全书"的口径漏洞（第七轮 P2）。声明落在 cfg 里，冻结与 --check 同一口径。 */
  const partialSet = new Set((partial ?? cfg.partialChapters ?? []).map(Number));

  /* 覆盖：每章 × 每层要么有结论、要么在缺失清单里。
   * `缺失` 与冻结时**同一套算法**（probe）算出来，所以 `--check` 会重算它，
   * 样本里被删掉一个文件当场就能被看见。 */
  const 探测 = probe({
    srcBase: P.原文目录,
    outBase: P.产物目录,
    date: cfg.日期,
    chapters: 全部章.map(chNum),
    tiers: 层列表,
  });

  const out = {
    口径:
      '章节[t] = **第一章**（README 与旧用例绑定的那一条，报给教师看的数）；' +
      '分章[t][章] = 全书每一章自己的数；全书定位[t] = 全书合起来算一遍。' +
      '三者口径不同，**不许互相替代**——把"第一章的数"说成"全书的数"正是上一轮 README 栽过的坑。',
    章节: {},
    分章: {},
    定位两条轴: {},
    分章定位: {},
    全书定位: {},
    覆盖: {
      章: 全部章,
      层: 层列表,
      组合数: 0,
      段数: 0,
      缺失: 探测.缺失,
    },
  };
  let 段数计 = 0;

  for (const t of 层列表) {
    const info = TIER_INFO[t];
    const 分章记录 = {};
    const 分章轴 = {};
    const 全书源 = [];
    const 全书产物 = [];
    const 排除章 = [];

    for (const ch of 章列表) {
      const srcPath = join(P.原文目录, ch, '原文_规范化.md');
      const outPath = join(P.产物目录, ch, `原文_${info.tag}_${cfg.日期}.md`);
      if (!existsSync(srcPath) || !existsSync(outPath)) continue; // → 已在 覆盖.缺失 里报过，不静默

      const srcMd = readFileSync(srcPath, 'utf-8');
      const outMd = readFileSync(outPath, 'utf-8');
      const srcSegs = segsOf(srcMd);
      const outSegs = segsOf(outMd).map((s) => s.trim());
      const srcWords = srcSegs.reduce((n, s) => n + wc(s), 0);
      const outWords = outSegs.reduce((n, s) => n + wc(s), 0);
      const isPartial = partialSet.has(chNum(ch));
      if (isPartial) 排除章.push(ch);
      else {
        全书源.push(srcMd);
        全书产物.push(outMd);
      }

      // 段级门禁：**逐段**跑，把每条规则命中几次记下来
      const perRule = {};
      const 段 = [];
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
        段.push({ 章: ch, 段号: `P${String(k + 1).padStart(2, '0')}`, 状态: v.status, 规则: v.problems.map((p) => p.ruleId).sort() });
      }

      // 整章质检 + 定位两条轴（**这两条轴是报给教师看的，最该被守住**）
      const qOut = runQc(outMd, LEX, { tier: t, fileName: `${ch}.md`, dict: DICT });
      const qSrc = runQc(srcMd, LEX, { tier: t, fileName: `${ch}_src.md`, dict: DICT });
      const pos = positioningOf(qSrc, qOut);
      /* 质检里**必须同时有分子和分母**（已注词型 / 应注词型）：
       * 只报"加了多少注"正是上一轮事故的成因——A 层第七/八/九章覆盖率掉到 2%/3%/1%，
       * 而报表上"加注条数"照样是个不小的数，于是没人看出问题。 */
      const 质检 = {
        章: ch,
        completeness: isPartial ? 'partial' : 'complete',
        段数: srcSegs.length,
        原文词数: qSrc.words,
        产物词数: qOut.words,
        生词率: Number((qOut.newWordRate * 100).toFixed(1)),
        原文生词率: Number((qSrc.newWordRate * 100).toFixed(1)),
        应注词型: qOut.annotatable,
        已注词型: qOut.annotated,
        漏注词型: qOut.annotatable - qOut.annotated,
        加注覆盖率: Number((qOut.annotationCoverage * 100).toFixed(1)),
        平均句长: Number(qOut.avgLenNarrRaw.toFixed(1)),
        被动: qOut.passive,
        定语从句: qOut.relcl,
        过去完成: qOut.pastPerf,
        超长句: qOut.over20,
      };
      分章记录[ch] = {
        质检,
        篇幅比: Number((outWords / Math.max(1, srcWords)).toFixed(3)),
        规则命中: Object.fromEntries(Object.entries(perRule).sort()),
        超长句总数: overLenTotal,
        段,
      };
      /* 两条轴各自成轴，**不合成**（与 positioning.ts 一致）。存的是四舍五入后的整数，
       * 因为报给教师看的就是这个数——守住"教师看到的那个数"，而不是更高的精度。 */
      分章轴[ch] = {
        阅读负荷下降: Math.round(pos.load.value * 100),
        理解支架覆盖率: Math.round(pos.scaffolding.value * 100),
        原文生词率: Number((qSrc.newWordRate * 100).toFixed(1)),
        产物生词率: Number((qOut.newWordRate * 100).toFixed(1)),
        一句话: scrub(pos.headline),
      };
      段数计 += 段.length;
    }

    out.分章[t] = 分章记录;
    out.分章定位[t] = 分章轴;

    /* 兼容与 README 绑定的那一条：`章节[t]` / `定位两条轴[t]` 固定是**第一章**。
     * README 原文写的是「Animal Farm 第一章：A 层 28% / 96%」，这里的语义必须跟它一致；
     * 全书口径另存 `全书定位[t]`，**不许拿第一章的数冒充全书**（那正是上一轮 README 栽的坑）。 */
    const 首 = 分章记录[全部章[0]];
    if (首) {
      out.章节[t] = { 质检: 首.质检, 篇幅比: 首.篇幅比, 规则命中: 首.规则命中, 超长句总数: 首.超长句总数 };
      out.定位两条轴[t] = 分章轴[全部章[0]];
    }

    if (全书源.length) {
      const qSrcAll = runQc(全书源.join('\n\n'), LEX, { tier: t, fileName: '全书_src.md', dict: DICT });
      const qOutAll = runQc(全书产物.join('\n\n'), LEX, { tier: t, fileName: '全书.md', dict: DICT });
      const posAll = positioningOf(qSrcAll, qOutAll);
      out.全书定位[t] = {
        章数: 全书源.length,
        /* 排除的 partial 章**点名列出**——静默排除就是下一个口径漏洞：
         * 看到全书数的人必须同时看到"这个数不含哪几章、为什么"。 */
        ...(排除章.length ? { 排除章 } : {}),
        阅读负荷下降: Math.round(posAll.load.value * 100),
        理解支架覆盖率: Math.round(posAll.scaffolding.value * 100),
        原文生词率: Number((qSrcAll.newWordRate * 100).toFixed(1)),
        产物生词率: Number((qOutAll.newWordRate * 100).toFixed(1)),
        应注词型: qOutAll.annotatable,
        已注词型: qOutAll.annotated,
        一句话: scrub(posAll.headline),
      };
    }
  }
  out.覆盖.组合数 = Object.values(out.分章).reduce((n, m) => n + Object.keys(m).length, 0);
  out.覆盖.段数 = 段数计;
  return { out, LEX, DICT };
}

/* ────────────────────── 对账 ────────────────────── */

/** 层 × 章逐格比，把**具体是哪一格**报出来——"某个数变了"没有用，"第七章变了"才有用 */
function reportDiff(want, got, 层列表, 章列表) {
  const lines = [];
  for (const t of 层列表) {
    for (const ch of 章列表) {
      const a = JSON.stringify(want.分章?.[t]?.[ch] ?? null);
      const b = JSON.stringify(got.分章?.[t]?.[ch] ?? null);
      if (a !== b) {
        const wa = want.分章?.[t]?.[ch]?.质检;
        const gb = got.分章?.[t]?.[ch]?.质检;
        const 变化 = wa && gb ? `（加注覆盖率 ${wa.加注覆盖率}% → ${gb.加注覆盖率}%，应注 ${wa.应注词型} → ${gb.应注词型} 词型）` : '（有一侧整章缺失）';
        lines.push(`  · ${t} 层 ${ch}${变化}`);
      }
    }
  }
  return lines;
}

async function runCheck() {
  const root = resolve(arg('--root', FIXTURE));
  const frozenPath = join(root, '期望结论.json');
  if (!existsSync(frozenPath)) {
    console.error(`✗ 还没有冻结过（${frozenPath} 不存在）。`);
    console.error('  先跑一次：node tools/af_pipeline/LayerText_AF冻结回放.mjs --project <调适项目.json>');
    process.exit(2);
  }
  const want = JSON.parse(readFileSync(frozenPath, 'utf-8'));
  const 层过滤 = has('--tiers') ? tierArgs(arg('--tiers')) : null;
  // 章过滤可以给 "1,7,8,9" 这样的列表：改动某几章后就地确认"抓到了没有"
  const 章过滤列表 = has('--chapters')
    ? String(arg('--chapters'))
        .split(',')
        .map((x) => chName(Number(x.trim())))
    : null;
  // partial 声明优先级：命令行 > 样本 cfg 里冻下来的那份
  const partial = has('--partial') ? parsePartial(arg('--partial')) : null;

  /* 指到样本里没有的章节 → **当场失败**，不返回"对上了"。
   * 不写这一条的话 `--chapters 99` 会一章都比、一章都不差，然后打印 ✓：
   * 一个空范围的对账是最像成功的一种失败。 */
  const 冻结章 = want.结论.覆盖?.章 ?? want.章;
  if (章过滤列表 && 章过滤列表.every((c) => !冻结章.includes(c))) {
    console.error(`✗ 指定的章节不在冻结样本里：${章过滤列表.join('、')}（样本里有 ${冻结章.join('、')}）`);
    process.exit(2);
  }

  const { out } = await computeConclusions(join(root, '输入'), { 章过滤: 章过滤列表, 层过滤, partial });
  const 层列表 = 层过滤 ?? want.层;
  const 章列表 = 章过滤列表 ?? 冻结章;
  const 局部 = 章过滤列表 !== null || 层过滤 !== null;

  const 结论差 = reportDiff(want.结论, out, 层列表, 章列表);
  const 全量差 = !局部 && JSON.stringify(want.结论) !== JSON.stringify(out);
  // 缺什么永远要比：它守的是"某章悄悄退出样本"这件事，与本次选了哪几章无关
  const 缺失一致 = JSON.stringify(want.结论.覆盖?.缺失 ?? null) === JSON.stringify(out.覆盖.缺失);
  const ok = 结论差.length === 0 && !全量差 && 缺失一致;

  console.log(ok ? `✓ 回放结论与冻结的一致（${章列表.length} 章 × ${层列表.join('/')}）` : '✗ 回放结论与冻结的**不一致**');
  if (!ok) {
    for (const l of 结论差) console.log(l);
    if (全量差 && !结论差.length) console.log('  · 逐章都对得上，但对账口径字段（覆盖 / 轴 / 第一章兼容块）变了');
    if (!缺失一致) {
      console.log(`  · 缺失清单变了：期望 ${JSON.stringify(want.结论.覆盖?.缺失 ?? null)}`);
      console.log(`                  实得 ${JSON.stringify(out.覆盖.缺失)}`);
    }
    if (局部) console.log(`  （本次只对了 ${章列表.join('、')}；整本对账请去掉 --chapters）`);
  }
  process.exit(ok ? 0 : 1);
}

/* ────────────────────── 主流程 ────────────────────── */

const projectPath = arg('--project', '');
if (has('--check') || !projectPath) await runCheck();

console.log('════ 冻结真项目回放样本 ════');
const P = loadProject(projectPath);
if (!P.产物目录 || !P.原文目录) {
  console.error('✗ 项目配置里缺 原文目录 / 产物目录');
  process.exit(2);
}
const tiers = has('--tiers') ? tierArgs(arg('--tiers')) : Object.keys(TIER_INFO);
const OUT_ROOT = resolve(arg('--out', FIXTURE));

/* ── 只读保证：冻结**前**给整棵项目树拍一张指纹 ──
 * 这个工具唯一的对外承诺就是"不碰真项目"，所以承诺要**当场验**，不能靠"我没写"。
 * 指纹覆盖整棵树（含产物、日志、论文稿），任何一处被改写都会被抓到。 */
const 项目根 = P.工作区 ?? dirname(resolve(projectPath));
const 冻结前 = treeManifest(项目根);

const 指定章 =
  has('--chapters') && arg('--chapters') !== 'all'
    ? String(arg('--chapters'))
        .split(',')
        .map((x) => Number(x.trim()))
    : null;
const 候选章 = 指定章 ?? detectChapters(P.原文目录, P.产物目录, P.日期, tiers);
const 探测 = probe({ srcBase: P.原文目录, outBase: P.产物目录, date: P.日期, chapters: 候选章, tiers });
const chapters = [...new Set(探测.可用.map((x) => x.ci))].sort((a, b) => a - b);

console.log(` 项目：${P._meta?.名称 ?? basename(projectPath)}｜章：${chapters.map((c) => chName(c)).join('、')}｜层：${tiers.join(',')}`);
if (探测.缺失.length) {
  /* 缺了就要**喊出来**：静默跳过会让"这一章没人守"变成一件没有痕迹的事 */
  console.log(` ⚠ 有 ${探测.缺失.length} 个（章 × 层）组合的输入不齐，**没有被冻进样本**（不是"跑通了"，是"没跑"）：`);
  for (const m of 探测.缺失) console.log(`   · ${m.章} / ${m.层} 层：缺 ${m.缺}`);
} else {
  console.log(` 输入齐全：${chapters.length} 章 × ${tiers.length} 层 = ${探测.可用.length} 组，**没有缺失**`);
}

mkdirSync(join(OUT_ROOT, '输入'), { recursive: true });
/* partial 章**显式声明**（如 `--partial 10`）：这一章还没写完，仍进样本、仍被守，
 * 但不进全书分母，也不会被当成"完成了的一章"（第七轮 P2 的口径决定）。 */
const partial = has('--partial') ? parsePartial(arg('--partial')) : [];
if (partial.length) console.log(` partial 章（显式声明未写完）：${partial.map(chName).join('、')}——进分章与覆盖，不进全书分母`);
const files = copyInputs(P, projectPath, chapters, tiers, OUT_ROOT, partial);
const 字节 = files.reduce((n, f) => n + Buffer.byteLength(readFileSync(join(OUT_ROOT, '输入', f), 'utf-8')), 0);
console.log(` 输入快照 ${files.length} 个文件 / ${(字节 / 1024).toFixed(0)}KB（**全份**，不做精简——精简会引入一个要永远重新验证的等价性问题）`);

const { out, LEX } = await computeConclusions(join(OUT_ROOT, '输入'), { partial });
const meta = {
  schemaVersion: 2,
  说明:
    '真项目回放层的冻结结论。**这些数就是项目报给教师的那些数**（SENT-01 命中数、阅读负荷下降、理解支架覆盖率、每章加注覆盖率、风险队列构成）。' +
    '它们此前没有任何东西在守：一次重构让某个数悄悄变一点点，没人会发现，直到有人拿它去写论文。' +
    'schemaVersion 2 把覆盖面从"第一章"扩到"全书每一章"——上一轮出事的是第七/八/九章，恰好是当时没有守的那三章。' +
    '第七轮起每章质检带 completeness（partial = 显式声明"这章还没写完"，不进全书分母但仍在覆盖里）。',
  冻结自: basename(projectPath),
  章: chapters.map(chName),
  层: tiers,
  /* 冻结**当刻**真项目里输入不齐的（章 × 层）——这是"样本为什么只有这几章"的出处记录。
   * 与 `结论.覆盖.缺失` 分工不同：那个是**可重算**的（守"样本里的文件被人删了"），
   * 这个是**一次性事实**（守"当时就少"）。两个都写下来，"样本里少一章"才不会变成
   * 一件没有痕迹的事——静默跳过是最坏的一种。 */
  缺输入: 探测.缺失,
  词表规模: { 已知: LEX.known.size },
  项目树指纹: { 文件数: 冻结前.size, 指纹: manifestDigest(冻结前) },
  结论: out,
};
writeAtomic(join(OUT_ROOT, '期望结论.json'), JSON.stringify(meta, null, 2));
console.log(`\n 结论已冻结：${join(OUT_ROOT, '期望结论.json')}`);

for (const t of tiers) {
  const c = out.章节[t];
  const w = out.全书定位[t];
  if (c?.质检) console.log(` ${t} 层（第一章）：篇幅 ${c.篇幅比}｜超长句 ${c.超长句总数} 句｜加注覆盖率 ${c.质检.加注覆盖率}%｜生词率 ${c.质检.原文生词率}% → ${c.质检.生词率}%`);
  if (out.定位两条轴[t]) console.log(`        第一章两条轴：阅读负荷下降 ${out.定位两条轴[t].阅读负荷下降}%｜理解支架覆盖率 ${out.定位两条轴[t].理解支架覆盖率}%`);
  if (w) console.log(`        全书两条轴（${w.章数} 章${w.排除章?.length ? `，partial 未计入：${w.排除章.join('、')}` : ''}）：阅读负荷下降 ${w.阅读负荷下降}%｜理解支架覆盖率 ${w.理解支架覆盖率}%（${w.已注词型}/${w.应注词型} 词型）`);
  const 每章 = Object.entries(out.分章[t]).map(([ch, r]) => `${ch} ${r.质检.加注覆盖率}%(${r.质检.已注词型}/${r.质检.应注词型})`);
  if (每章.length) console.log(`        每章加注覆盖率：${每章.join('｜')}`);
}

/* ── 只读保证：冻结**后**再拍一张，两张必须一模一样 ──
 * 不一致就**报错退出**（退出码 3）：这一条不是"顺便检查"，是这个工具的硬约束。 */
const 冻结后 = treeManifest(项目根);
const 差异 = manifestDiff(冻结前, 冻结后);
console.log(`\n 只读校验：项目树 ${项目根}`);
console.log(`   ${冻结后.size} 个文件，指纹 ${manifestDigest(冻结前)} → ${manifestDigest(冻结后)}`);
if (差异.length) {
  console.error(`✗ 冻结过程**动了真项目**（${差异.length} 处），这是本工具的硬约束被破坏：`);
  for (const d of 差异.slice(0, 20)) console.error(`   · ${d}`);
  process.exit(3);
}
console.log(' ✓ 一个字节都没写回真项目（冻结前后整棵树指纹一致）');
