#!/usr/bin/env node
/** AF 运行清单（manifest）+ 词表快照 —— 静默错配的探测网
 *
 * 审查报告 §三：「只能重构一处，应先建『运行清单 + 事件日志』层，统一书籍/版本/层级/教师/
 * 运行 ID、输入哈希、词表版本、模型版本、产物状态……这样优先解决静默错配和复现问题。」
 *
 * 它防的是什么（都是"照常报告成功"的错）：
 *   · 词表/专名表/词典被换过，产物还是旧的 → 判定口径已经不同，但没人知道；
 *   · 第二本书、第二位教师、同一书多层并行 → 输出路径互相覆盖；
 *   · 上一轮的完成标记还在，这一轮其实没跑完；
 *   · 论文里的数字说不清"哪版词表、哪版提示词、哪版模型跑出来的"。
 *
 * 用法：
 *   node LayerText_AF清单.mjs --new --tier A --teacher wayne     # 建清单（含词表快照 + **词表正本导入**）
 *   node LayerText_AF清单.mjs --reimport                        # 只重新导入词表正本（CSV 改过之后）
 *   node LayerText_AF清单.mjs --teachers                        # **谁在这本书上干过活**（教师名录 × 盘上清单）
 *   node LayerText_AF清单.mjs --stamp --tier A --step 生成 --sec 12.3 --ok 1
 *   node LayerText_AF清单.mjs --verify --tier A                  # 校验；有硬问题非零退出
 *   node LayerText_AF清单.mjs                                   # 只打印当前清单摘要
 *
 * 产物（都在 产物目录/_运行/ 下）：
 *   LexiconData.json / LexiconData_<版本>.json   词表**正本**（数据本身，所有阶段只读它）
 *   LexiconDrift.json                            正本与现场对不上时的逐词差异（漂移必须留痕）
 *   LexiconSnapshot_<版本>.json   词表快照（带版本与哈希，**审计指纹**：回答"来源换过没有"）
 *   LexiconSnapshot.json          指向当前版本的指针
 *   清单_<runId>.json             运行清单
 *   清单_最新.json                指向当前清单的指针
 *
 * 快照与正本的分工（总计划阶段 3：「旧 CSV/JSON 只做一次导入，不再作为新的事实源」）：
 *   · 快照 = 指纹：来源的路径/哈希/词数/抽样，**不含数据**。它只是"换过没有"的探测网。
 *   · 正本 = 数据：已知词、待定词、专名、逐来源词表、词典释义、知识库加注。
 *     导入一次，`词表与词典.mjs` 的所有 loader 之后都读它；CSV 再被改，脚本会**拒绝开工**
 *     （判据与逐词代价见 `src/core/lexiconstore.ts` 的 `decideLexiconSource`）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const has = (n) => argv.includes(n);
/* ★ 必须在**导入共享模块之前**决定：`--reimport` 的用途就是"正本已经和现场对不上了，
 *   重新导入一次"，而共享模块在漂移时默认拒绝开工——先设好逃生门再 import，
 *   否则这条命令永远跑不起来（它会被自己设的规矩挡在门外）。
 *   显式给了 LAYERTEXT_LEXICON 就以外面的为准（不去覆盖人已经说清楚的选择）。 */
if (has('--reimport') && !process.env.LAYERTEXT_LEXICON) process.env.LAYERTEXT_LEXICON = 'reimport';

const SHARED = await import('./LayerText_AF词表与词典.mjs');
const P = SHARED.loadProject();
const REPO = P.引擎目录;
const OUT_BASE = P.产物目录;
const SRC_BASE = P.原文目录;
const DATE = P.日期;
/* 章节名从共享模块取（**不再在 10 个脚本里各抄一份 `['一'…'十']`**）：
 * 那份抄写写死了"十章"，换一本 12 章的书会拼出 `第undefined章` 而**照常报成功**。
 * 现在优先级是「配置 > 原文目录 > 默认（第N章 × 章数）」，
 * 最后那层逐字符复现旧行为，所以既没配置、也没有可扫目录的老项目结果不变。 */
const CN = SHARED.chapterNames(P);
/* 层级标签与指针命名都从引擎取——**不在脚本里再抄一份**（抄一份就会有一天改漏） */

const M = await import(`${SHARED.distOf(REPO)}/src/core/manifest.js`);
const {
  artifactIdOf,
  artifactsMissingId,
  buildLexiconSnapshot,
  refOf,
  newManifest,
  upsertArtifact,
  withArtifactIds,
  recordStep,
  verifyManifest,
  summarizeManifest,
  detectCollision,
  contentHash,
  verifyLexiconSnapshot,
  makeResolver,
  detectArtifactCollisions,
  pointerNameOf,
  TIER_TAG: TAGS,
} = M;
/* 学生版过滤规则的版本与默认过滤节——登记 `derivedFrom` 用。
 * 引擎是唯一口径，脚本里不抄（抄了就会有一天改漏一半）。 */
const SV = await import(`${SHARED.distOf(REPO)}/src/core/studentversion.js`);
const PKG_VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf-8')).version;

let TIERS = arg('--tier', '')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter((t) => TAGS[t]);
const CH_IDS = arg('--chapters', '')
  ? arg('--chapters')
      .split(',')
      .map((x) => Number(x.trim()))
      .filter((n) => n >= 1 && n <= 10)
  : CN.slice(0, Number(P.章数 ?? 10)).map((_, i) => i + 1);
/** `--partial-chapter 10` / `--partial-chapter 3,10` → 章号数组（去重排序；空串 = 清空声明）。
 *  partial 是**口径声明**不是技术判定（第五轮对照表："要不要排除在全书口径外是口径决定"），
 *  所以只接受显式给的章号，不做任何"段数少就算没写完"的猜测。 */
const parsePartialChapters = (raw) =>
  [
    ...new Set(
      String(raw ?? '')
        .split(',')
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= CN.length),
    ),
  ].sort((a, b) => a - b);
/* 教师名**原样读进来，写下去之前一律归一成稳定 ID**（总计划阶段 3「Teacher 有稳定 ID」）。
 *
 * 原来这里就是一个自由字符串，于是 `--teacher wayne` / `--teacher Wayne` / `--teacher 'wayne '`
 * 是**三个人**：三个 runId、三份分片指针、三堆决定事件，而没有任何地方会说一句话。
 * 现在读的时候保留原样（要如实报告"你写的是什么"），写的时候只写 ID——
 * 具体怎么归一化、名录在哪儿、拼错怎么办，全部在 `src/core/teachers.ts` 与共享模块里，
 * 这一行只负责取原样的值。 */
const teacherArg = () => arg('--teacher', process.env.LAYERTEXT_TEACHER ?? process.env.USER ?? 'unknown');
const RUN_DIR = join(OUT_BASE, '_运行');
const SNAP_POINTER = join(RUN_DIR, 'LexiconSnapshot.json');
/* 指针**按 (教师, 层级) 分片**，另加一份"最近一次"作索引。
 *
 * 原来只有一份全局的 `清单_最新.json`。两位教师同时跑同一本书的不同层级时，
 * 后跑者把先跑者的身份覆盖掉，先跑者的进程接着去读到**对方的 runId**，
 * 于是产物写进对方的运行私有目录、或去对方目录里找产物找不到——而两边都报成功。
 * `--layout run` 挡不住这个：它挡的是"路径撞名"，不是"身份被换掉"。
 * 分片之后每个 (教师, 层级) 有自己的指针，谁也覆盖不了谁；
 * `清单_最新.json` 退化为"给人看的最近一次"，不再是任何程序的事实源。 */
const pointerOf = (teacher, tier) => join(RUN_DIR, pointerNameOf({ teacher, tier }));
/** "最近一次"的索引。**它只是索引**：给人看的"最近跑过哪一次"，不是任何程序的事实源 */
const MANIFEST_POINTER = join(RUN_DIR, '清单_最新.json');

/** 路径布局：legacy（默认，沿用既有命名）｜run（产物收进 _运行/<runId>/，跨运行不会撞名）。
 *  报告 §三 说"只能重构一处，应先建清单层……都只能通过 manifest 解析路径"——
 *  这个开关就是那句"解析路径"的落点：改成 run 之后所有脚本自动跟着走。 */
const LAYOUT = arg('--layout', 'legacy');
if (!['legacy', 'run'].includes(LAYOUT)) {
  console.error(`✗ --layout 只能是 legacy / run`);
  process.exit(2);
}
/**
 * 本脚本自己的产物路径也走同一套解析（否则它就成了唯一的例外）。
 *
 * ★ 布局**以清单为准**，不是以命令行 `--layout` 为准。
 * `--layout` 只在 `--new` 时决定"这次运行用哪种布局"；之后每一次 `--stamp` / `--verify`
 * 都该跟着**那份清单**走。原来这里读的是命令行，于是"建清单时用了 `--layout run`、
 * 刷状态时忘了再写一遍"会让扫描按 legacy 去找产物 —— **一件都扫不到、清单记 0 件、
 * 而输出照旧写「清单已更新」**。这类"不报错、结果错"正是本项目最难查的一类缺陷。
 * 命令行与清单打架时以清单为准，并且**说出来**。 */
const layoutOf = () => {
  const fromManifest = cur?.manifest?.layout;
  if (fromManifest && fromManifest !== LAYOUT) {
    console.warn(`⚠ 清单记的是 ${fromManifest} 布局，命令行给的是 ${LAYOUT}——按**清单**走（产物在哪只有清单说了算）`);
  }
  return fromManifest ?? LAYOUT;
};
const selfPaths = (runId) => makeResolver(layoutOf(), { out: OUT_BASE, work: P.调适工作区 }, { runId, tier: TAGS[TIERS[0]] ?? TIERS[0], date: DATE });

const readIf = (p) => (p && existsSync(p) ? readFileSync(p, 'utf-8') : null);

/** 本次运行的全部输入哈希：词表/专名/知识库/词典/底线/教材单元库 + 每一章原文。
 *  `--new` 与 `--verify` **必须用同一个函数**造这份清单，否则校验时会把
 *  "这次没传原文"误报成漂移（第一版就踩了这个坑）。 */
function buildInputs(sources) {
  return [
    ...sources,
    ...CH_IDS.map((ci) => {
      const ch = CN[ci - 1];
      const p = join(SRC_BASE, ch, '原文_规范化.md');
      const text = readIf(p);
      return text === null ? null : refOf(`原文/${ch}`, p, text);
    }).filter(Boolean),
  ];
}

/* ────────────────────── 词表快照（审计指纹）与词表正本（数据） ────────────────────── */
/**
 * 快照：**它不含数据**，只记来源的路径/哈希/词数与抽样——回答"来源换过没有"。
 * 来源列表在共享模块的 `projectSources`（与词表正本导入共用一份，见那里的注释：
 * 两处各写一份，只要 `count` 差一行，就会天天报一次"词表已变"的假警报）。
 */
function buildSnapshot() {
  const { sources, counts, knownAll } = SHARED.projectSources(P);
  return { snapshot: buildLexiconSnapshot({ sources, counts, known: knownAll }), sources };
}

function writeSnapshot(snap) {
  mkdirSync(RUN_DIR, { recursive: true });
  const p = join(RUN_DIR, `LexiconSnapshot_${snap.version}.json`);
  if (!existsSync(p)) writeFileSync(p, JSON.stringify(snap, null, 2), 'utf-8');
  writeFileSync(SNAP_POINTER, JSON.stringify(snap, null, 2), 'utf-8');
  return p;
}

/** 导入词表正本。**--new 与 --reimport 共用一份实现**，报告的句子也共用（`lines`）
 *  ——命令行的措辞写两遍，就会有一天两边说法不一致。 */
async function importStore(snapshotSources, snapshotCounts) {
  const r = await SHARED.importLexiconStore(P, { snapshotSources, snapshotCounts });
  const c = r.store.counts;
  const lines = [` 词表正本：${r.store.version}（已知 ${c.known} 词、待定 ${c.pending}、专名 ${c.proper}、词典 ${c.dict} 条、知识库 ${c.kb} 条）`];
  if (r.previous) {
    lines.push(` 上一份正本：${r.previous.version}（${r.previous.createdAt}）→ 本次换成新版本`);
    lines.push(` 逐词代价：${r.wordDiffText ?? '（无法比对）'}`);
  } else {
    lines.push(' 上一份正本：无（**首次导入**：从这一版起，CSV 不再是对判定的事实源）');
  }
  for (const w of r.store.warnings) lines.push(` ⚠ 正本自检：${w}`);
  if (r.clearedDrift) lines.push(' （旧的 LexiconDrift.json 已清掉：那种"对不上"已收进这份新正本；旧正本仍按版本归档，随时能逐词比）');
  lines.push(` ✓ ${r.storePath}`, `   归档：${r.versionPath}`);
  return { ...r, lines };
}

/** 当前产物状态的扫描：产物的"能不能当完成品"只由完成标记决定，不看文件在不在 */
function scanArtifacts() {
  const out = [];
  /** 登记一项：**路径是"在哪儿"，身份是"是什么"**（见 `src/core/manifest.ts` 的「产物身份」）。
   *  扫描时两样一起写：只写路径的话，这件产物换个目录/换个布局就成了"另一件"，
   *  而"两位教师各写了一份同一件产物"这件事会永远比不出来（阶段 3 要拦的正是它）。 */
  const push = (rec) => out.push({ ...rec, id: artifactIdOf(rec) });

  /* 校准台账（`_运行/校准台账.jsonl`）：**书级一件**，所以登记在层循环之外。
     它是"教师做过哪些词/句级人工校准"的正本——论文素材与发布包要的正是它，
     不登记就永远进不了包（发布包只搬清单登记过的产物）。 */
  {
    const ledgerAbs = join(OUT_BASE, '_运行', '校准台账.jsonl');
    if (existsSync(ledgerAbs)) {
      const text = readFileSync(ledgerAbs, 'utf-8');
      push({
        path: join('_运行', '校准台账.jsonl'),
        kind: '台账',
        status: 'ok',
        hash: contentHash(text),
        bytes: text.length,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  for (const t of TIERS) {
    const tag = TAGS[t];
    const rrx = selfPaths(cur?.manifest?.runId ?? '');
    const donePath = rrx.any('完成标记', { tier: tag });
    const reviewPath = rrx.any('失败清单', { tier: tag });
    const done = readIf(donePath);
    const review = readIf(reviewPath);
    const status = done ? 'ok' : review ? 'needs-review' : 'stale';
    const reason = review
      ? (JSON.parse(review).待复核明细 ?? [])
          .map((d) => (d.规则 ?? []).join('/'))
          .slice(0, 3)
          .join('；')
      : undefined;
    const rr = selfPaths(cur?.manifest?.runId ?? '');
    for (const ci of CH_IDS) {
      const ch = CN[ci - 1];
      const abs = rr.any('正文', { chapter: ch, tier: tag, date: DATE });
      const rel = abs.replace(`${OUT_BASE}/`, '');
      if (!existsSync(abs)) continue;
      const text = readFileSync(abs, 'utf-8');
      push({ path: rel, kind: '正文', tier: t, chapter: ch, status, reason, hash: contentHash(text), bytes: text.length, updatedAt: new Date().toISOString() });

      /* ★ 学生版也要登记。它是发布包里**真正要交到学生手上**的那一件，
       * 而在此之前扫描**只认正文**——于是"发布学生版"与"发布包"是断开的：
       * 学生版生成得再对，也不会进清单、不会进包，而导出照常报成功。
       * 状态跟着正文走：正文是 `needs-review`，学生版也不该被当成完成品
       * （它本来就是从那份稿减出来的）。 */
      const stuAbs = rr.any('学生版', { chapter: ch, tier: tag, date: DATE });
      if (existsSync(stuAbs)) {
        const stuText = readFileSync(stuAbs, 'utf-8');
        push({
          path: stuAbs.replace(`${OUT_BASE}/`, ''),
          kind: '学生版',
          tier: t,
          chapter: ch,
          status,
          reason,
          hash: contentHash(stuText),
          bytes: stuText.length,
          updatedAt: new Date().toISOString(),
          /* 派生关系随登记写下（第七轮 P1-⑥）：另一团队拿到包，能回答
           * "这份读物是从哪一份工作稿、按哪版规则减出来的"——只说"谁生成"不说"从哪减"，半句答案。 */
          derivedFrom: {
            sourceId: artifactIdOf({ kind: '正文', tier: t, chapter: ch }) ?? rel,
            sourcePath: rel,
            transformer: `LayerText_AF学生版@${PKG_VERSION}`,
            ruleVersion: SV.STUDENT_VERSION_SCHEMA_VERSION,
            dropSections: SV.DEFAULT_DROP_SECTIONS,
          },
        });
      }
    }
    /* 台账与人读的风险队列报告：两条也经解析器取路径。
     * 清单记的是**相对产物目录**的路径（`rel`），所以这里减掉前缀即可——
     * 两种布局下 `rel` 自然不同（run 布局会带上 `_运行/<runId>/`），下游按它复原也在同一套规则里。 */
    for (const [kind, abs] of [
      ['台账', rr.any('台账', { tier: tag, date: DATE })],
      ['风险队列', rr.any('汇总报告', { name: `风险队列_${tag}`, date: DATE })],
    ]) {
      const rel = abs.replace(`${OUT_BASE}/`, '');
      if (!existsSync(abs)) continue;
      const text = readFileSync(abs, 'utf-8');
      push({ path: rel, kind, tier: t, status: 'ok', hash: contentHash(text), bytes: text.length, updatedAt: new Date().toISOString() });
    }
    // 待复核的段落数：清单的"能不能交付"由它决定
    if (review) {
      const list = JSON.parse(review).待复核明细 ?? [];
      for (const d of list) {
        push({
          path: join('_待复核', `${tag}`, `${d.位置.split(' ')[0]}_第${Number(d.位置.match(/第(\d+)段/)?.[1] ?? 0)}段.md`),
          kind: '其他',
          tier: t,
          status: 'needs-review',
          reason: (d.规则 ?? []).join('/'),
          updatedAt: new Date().toISOString(),
        });
      }
    }
  }
  return out;
}

const pendingReviewOf = () => {
  let n = 0;
  for (const t of TIERS) {
    const r = readIf(selfPaths(cur?.manifest?.runId ?? '').any('失败清单', { tier: TAGS[t] }));
    if (r) n += JSON.parse(r).待复核 ?? 0;
  }
  return n;
};

/* ────────────────────── 建清单 ────────────────────── */
if (has('--new')) {
  /* --new 必须有起点层（不给就 A）；能从清单继承范围的是后面那些动作（--stamp 等） */
  if (!TIERS.length) TIERS = ['A'];
  /* 教师先过名录：`Wayne` / `wayne ` / `Ｗａｙｎｅ` 归一成同一个 ID，并**当场说出来**；
   * 名录里没有的名字**登记**（否则"谁在这本书上干过活"永远答不出来），
   * 同时把"疑似拼错"这类要留档的说明写进本次运行的 `warnings`——
   * 一行 stderr 跑过去就没了，而清单会一直留着它（`--verify` 每次都会摆到眼前）。
   * 名录本身读不出来时**拒绝开工**：那份名册里的别名与显示名是人工信息，覆盖掉就补不回来。 */
  const tr = await SHARED.registerTeacher(P, teacherArg());
  if (!tr.ok) {
    console.error(`✗ 教师身份没定下来，本次不建清单：${tr.refusal ?? '（原因不明）'}`);
    process.exit(2);
  }
  const TEACHER = tr.id;
  const { snapshot, sources } = buildSnapshot();
  const snapPath = writeSnapshot(snapshot);
  // 导入是 --new 的一部分：**"建清单"这件事的含义就是把这次的输入冻下来**。
  // 只冻指纹不冻数据，等于把"三天后有人改了词库"这件事留到跑完才发现。
  const imported = await importStore(sources, snapshot.counts);
  if (imported.store.snapshotVersion !== snapshot.version) {
    console.warn(`⚠ 快照版本（${snapshot.version}）与正本记的快照版本（${imported.store.snapshotVersion}）对不上——` + `引擎里这两处算版本的地方出现了分歧，请把这两行连同 ${snapPath} 一起报上来`);
  }
  const inputs = buildInputs(sources);
  const m = newManifest({
    book: P.书名,
    version: arg('--version', P.版本 ?? 'v1'),
    tiers: TIERS,
    chapters: CH_IDS,
    // 记的是**稳定 ID**（不是命令行上那个原样写法）：runId 的哈希、指针文件名、决定事件三处同源
    teacher: TEACHER,
    model: { name: P.模型 ?? 'deepseek-chat', temperature: 0.3, promptVersion: arg('--prompt', 'session-v3-20260911') },
    // 版本仍是**快照版本**：既有运行的 --verify 不该因为这次改动凭空报一次漂移（假警报比没有警报更坏）
    lexicon: { version: snapshot.version, snapshotPath: snapPath, warnings: snapshot.warnings, storePath: imported.storePath, storeVersion: imported.store.version },
    inputs,
    owner: { pid: process.pid, host: hostname() },
    layout: LAYOUT,
  });
  /* partial 章可以在建清单时一并声明（也可以事后 --partial-chapter 单独改） */
  if (has('--partial-chapter')) m.partialChapters = parsePartialChapters(arg('--partial-chapter'));
  /* 教师身份这件事里"值得留档"的部分进清单的账（`verifyManifest` 会把它们逐条报出来）：
   * 归一化改过写法、名录里没有这个名字、以及与名录里某个人**只差一两个字符**（疑似拼错）。
   * 只打印不落账，等于把"这本书上悄悄出现了第二个教师"留到对不上账的那天。 */
  for (const w of tr.warnings ?? []) m.warnings.push({ kind: w.kind, message: w.message, at: new Date().toISOString() });
  const existingPath = join(RUN_DIR, `清单_${m.runId}.json`);
  const existing = readIf(existingPath);
  if (existing) {
    const warn = detectCollision(JSON.parse(existing), m, (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (warn) console.warn(`\n⚠ ${warn}`);
  }
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(existingPath, JSON.stringify(m, null, 2), 'utf-8');
  /* 分片指针：**这次运行自己的**，并发跑谁也覆盖不了谁。
   * 层级取清单里记的那一层（同一次运行可以带多层，指针挂在第一层上——与命令行的 --tier 同序）。 */
  /* 指针的层级名用**标签**（`A层85`）而不是层键（`A`）——读的那一侧手里是标签。
   * 两边不统一，分片指针会写了却读不到，然后静默退回"最近一次"。 */
  const tierTags = m.tiers.map((t) => TAGS[t] ?? t);
  const pointer = JSON.stringify({ runId: m.runId, path: existingPath, teacher: m.teacher, tier: tierTags[0], layout: LAYOUT, updatedAt: new Date().toISOString() }, null, 2);
  // 每层各写一份，免得"跑 A 层的人"和"跑 M 层的人"抢同一份指针
  /* ★ 这里的 `m.teacher` 是**稳定 ID**（上面 registerTeacher 归一化过的），指针名也因此按人分片：
   * 之前 `teacher` 是一个自由字符串，于是 `Wayne` 与 `wayne` 各写各的指针——
   * `readRunIdentity` 那套「按 (教师, 层级) 分片」实际是按**字符串**分片，
   * 而"两位教师不会互相覆盖"这条保证就漏在了拼写上（拼错一个字母 = 多一个分片 = 多一个人）。 */
  for (const t of tierTags) writeFileSync(pointerOf(m.teacher, t), pointer, 'utf-8');
  writeFileSync(MANIFEST_POINTER, pointer, 'utf-8');
  console.log('════ AF 运行清单 · 新建 ════');
  console.log(` 运行 ID：${m.runId}`);
  console.log(` 书名：${m.book}｜版本：${m.version}｜层：${m.tiers.join('/')}｜教师：${m.teacher}（${tr.resolution?.status ?? '—'}）`);
  for (const l of tr.notes ?? []) console.log(l);
  for (const a of tr.droppedAliases ?? []) console.log(` · 别名「${a}」没有记进名录：它与 ID「${tr.id}」归一化之后相同（记了只会让人以为两者有区别）`);
  console.log(` 教师名录：${tr.path}${tr.registered ? '（本次新登记）' : '（已在册）'}`);
  console.log(` 路径布局：${LAYOUT}${LAYOUT === 'legacy' ? '（沿用既有命名，教师已有工作流不受影响）' : '（产物收进 _运行/<运行 ID>/，跨运行不会互相覆盖）'}`);
  console.log(` 词表快照：${snapshot.version}（${snapshot.sources.length} 个来源）→ ${snapPath}`);
  for (const l of imported.lines) console.log(l);
  if (snapshot.warnings.length) for (const w of snapshot.warnings) console.warn(` ⚠ ${w}`);
  console.log(` 输入哈希：${inputs.length} 项已锁定（词表/专名/知识库/词典/底线/原文）`);
  console.log(` ✓ ${existingPath}`);
  process.exit(0);
}

/* ────────────────────── 只重新导入词表正本 ──────────────────────
 * 为什么单独给一条命令：CSV 改过之后，脚本会**拒绝开工**并把差异说出来（这是有意的）。
 * 那条拒绝必须有一个"下一步动作"可执行，否则规矩就只是挡路。
 * 它**不动清单**：已登记的运行仍记着旧快照版本，`--verify` 之后会把它们判为 blocked——
 * 那是对的，它们确实是用旧口径跑出来的。要接着往下跑，重新 `--new` 开一次运行。 */
if (has('--reimport')) {
  console.log('════ AF 词表正本 · 重新导入 ════');
  console.log(` 项目：${P.书名}｜产物目录：${OUT_BASE}`);
  const { sources, counts } = SHARED.projectSources(P);
  const r = await importStore(sources, counts);
  for (const l of r.lines) console.log(l);
  if (r.previous && r.previous.version !== r.store.version) {
    console.warn(' ⚠ 正本版本已变：已登记的运行仍记着旧快照版本，--verify 会把它们判为 blocked（它们确实是用旧口径跑出来的）');
  }
  process.exit(0);
}

/* ────────────────────── 谁在这本书上干过活 ──────────────────────
 * 总计划阶段 3 的「多教师」要问的第一句话，也是这一轮 Teacher 稳定 ID 的**验收动作**：
 * 「谁在这本书上干过活」原来答不出来——教师只是一个自由字符串，散在各自的运行里。
 *
 * 答案来自**两边**，谁也不取代谁：
 *   · 名录（`_运行/教师名录.json`）：这个 ID 还有哪些写法（别名）、显示名叫什么；
 *   · 盘上每一次运行的清单：谁**真的**跑过、跑了几次、哪一层。
 * 名录里**刻意没有运行计数**——记了就会漂移（删掉一次运行，名录还记着 3 次）；
 * 这里的次数是**当场**从清单数出来的，所以两个数字永远不会对不上。
 *
 * 只读：列名录绝不写盘（"看一眼"不该改盘上的东西）。
 */
if (has('--teachers') || has('--list-teachers')) {
  const t = await SHARED.listTeachers(P);
  console.log('════ 教师名录 · 谁在这本书上干过活 ════');
  console.log(` 项目：${P.书名}｜产物目录：${OUT_BASE}`);
  for (const l of t.lines) console.log(l);
  console.log(` 名录文件：${t.path}${t.exists ? '' : '（还没有——跑一次 --new 会自动建立；旧运行照常可用，不需要迁移）'}`);
  if (!t.available) {
    console.error('✗ 列不出来：引擎里读不到 teachers.js（先 npx tsc -p tsconfig.json 重建引擎）。');
    process.exit(1);
  }
  process.exit(0);
}

/* ────────────────────── 声明未写完的章（partial） ──────────────────────
 * `--partial-chapter 10`：第十章还没写完。它**仍被登记、仍被回放**——半成品也要有人守——
 * 但不进"全书完成率"分母；发布学生版默认拒绝 partial 章，除非显式放行（第七轮 P2）。
 * 语义是**整组替换**：这次给了什么，清单上记的就是什么（声明式口径，幂等，可清空）。 */
if (has('--partial-chapter')) {
  const cur2 = loadManifest();
  if (!cur2) {
    console.error('✗ 还没有运行清单，partial 声明无处可写。先 `--new` 建清单（--new 时也可一并给 --partial-chapter）。');
    process.exit(2);
  }
  const list = parsePartialChapters(arg('--partial-chapter'));
  cur2.manifest.partialChapters = list;
  cur2.manifest.updatedAt = new Date().toISOString();
  writeFileSync(cur2.path, JSON.stringify(cur2.manifest, null, 2), 'utf-8');
  console.log('════ AF 运行清单 · partial 章声明 ════');
  console.log(` 运行 ID：${cur2.manifest.runId}`);
  console.log(list.length ? ` partial 章：${list.map((n) => CN[n - 1] ?? `第${n}章`).join('、')}——仍登记、仍回放，不进全书分母；发布学生版默认拒绝` : ' 已清空 partial 声明（所有章按完成口径计）');
  console.log(` ✓ ${cur2.path}`);
  process.exit(0);
}

/* ────────────────────── 读当前清单 ────────────────────── */
function loadManifest() {
  const ptr = readIf(MANIFEST_POINTER);
  if (!ptr) return null;
  const { path } = JSON.parse(ptr);
  const t = readIf(path);
  return t ? { manifest: JSON.parse(t), path } : null;
}
function saveManifest(m, path) {
  writeFileSync(path, JSON.stringify(m, null, 2), 'utf-8');
}

const cur = loadManifest();
if (!cur) {
  console.error('✗ 还没有运行清单。先建：node LayerText_AF清单.mjs --new --tier A --teacher <你>');
  process.exit(2);
}
/* 扫描范围：命令行 > **清单记的层** > A。清单明明记着 A/M/B 而 `--stamp` 不带 `--tier`
 * 就只扫 A——"少扫两层还报成功"正是这套清单要防的那类错；范围的答案就在清单上
 * （第五轮「删除缓存不影响从 manifest 重建」同一条纪律）。 */
if (!TIERS.length) TIERS = [...new Set([...(cur.manifest.tiers ?? []), 'A'])].filter((t) => TAGS[t]);

/* ────────────────────── 刷状态（每一步跑完调一次） ────────────────────── */
if (has('--stamp')) {
  const m = cur.manifest;
  /* 先数、再补：`upsertArtifact` 自己也会给**这次扫到的**登记项补身份，
   * 于是"盘上有多少条还没有身份"必须在扫描之前数，否则这句报告会偏小。 */
  const backfilled = artifactsMissingId(m).length;
  for (const a of scanArtifacts()) upsertArtifact(m, a);
  /* 自愈：旧清单（登记项只有 path/kind/…，没有 id）**在这一步拿到身份**。
   * 只加 id 一个字段，别的账一个字都不动——身份是算出来的，所以补上去与"从来就有"等价，
   * 也就不需要任何迁移脚本、更不需要"升级清单格式"这件事。 */
  withArtifactIds(m);
  m.pendingReview = pendingReviewOf();
  recordStep(m, { id: arg('--step', '（未命名）'), ok: arg('--ok', '1') !== '0', sec: Number(arg('--sec', '0')) || 0, note: arg('--note', undefined) });
  if (arg('--warning')) m.warnings.push({ kind: arg('--warning-kind', 'step'), message: arg('--warning'), at: new Date().toISOString() });
  saveManifest(m, cur.path);
  const s = summarizeManifest(m);
  console.log(`清单已更新：${m.runId}｜产物 ${s.artifactCount} 件｜待复核 ${s.pendingReview}｜步骤 ${m.steps.length}`);
  if (backfilled) console.log(` 产物身份：补齐 ${backfilled} 件旧登记项（身份是算出来的：种类+层级+章节，与路径无关）`);
  process.exit(0);
}

/* ────────────────────── 校验 ────────────────────── */
if (has('--verify')) {
  const m = cur.manifest;
  const { snapshot, sources } = buildSnapshot();
  const drift = verifyLexiconSnapshot(snapshot, sources);
  const r = verifyManifest(m, {
    inputs: buildInputs(sources),
    lexiconVersion: snapshot.version,
    exists: (rel) => existsSync(join(OUT_BASE, rel)),
    hashOf: (rel) => {
      const t = readIf(join(OUT_BASE, rel));
      return t === null ? '' : contentHash(t);
    },
  });
  // 快照本身也留档，便于事后比对
  writeSnapshot(snapshot);

  // 跨运行撞名探测（报告 §三："第二本书/第二位教师/同书多层并行会互相覆盖"）
  const siblings = [];
  if (existsSync(RUN_DIR)) {
    for (const f of readdirSync(RUN_DIR)) {
      if (!/^清单_.*\.json$/.test(f)) continue;
      const t = readIf(join(RUN_DIR, f));
      if (!t) continue;
      try {
        siblings.push(JSON.parse(t));
      } catch {
        /* 坏清单跳过 */
      }
    }
  }
  const collide = detectArtifactCollisions(siblings.map((x) => ({ runId: x.runId, artifacts: x.artifacts ?? [] })));

  console.log('════ AF 运行清单 · 校验 ════');
  console.log(` 运行 ID：${m.runId}｜书：${m.book} ${m.version}｜层：${m.tiers.join('/')}｜教师：${m.teacher}`);
  /* 教师身份在**校验**里也要有一行：清单里记的可能是归一化之前的写法（`Wayne`），
   * 而它算的是 `wayne`——不写清楚，同一本书上的同一个人会被当成两个人。
   * 只读解析（不登记）：校验不该改盘上的东西。 */
  const tinfo = await SHARED.resolveTeacher(P, m.teacher);
  console.log(` 教师身份：${tinfo.id}（${tinfo.resolution?.status ?? tinfo.why}）${tinfo.id !== m.teacher ? `——清单里记的是「${m.teacher}」` : ''}`);
  console.log(` 词表快照：清单 ${m.lexicon.version}｜当前 ${snapshot.version}${drift.ok ? '（一致）' : '（**已变**）'}`);
  /* 撞名按**产物身份**报，所以"两位教师各写一份同一件产物、路径还不一样"也看得见（旧口径只比路径）。
   * 两种性质分开说：`覆盖` 是谁把谁盖掉了（最坏），`分叉` 是同一件产物有了两份副本（谁作数要人定）。 */
  const overCount = collide.collisions.filter((c) => c.kind === '覆盖').length;
  const forkCount = collide.collisions.length - overCount;
  console.log(
    ` 路径布局：${m.layout ?? 'legacy'}｜已登记运行 ${siblings.length} 个` +
      (collide.ok ? '（无跨运行撞名）' : `（**${collide.collisions.length} 处撞名**：覆盖 ${overCount} 件、分叉 ${forkCount} 件）`),
  );
  console.log(` 产物身份：${describeIdentities(m)}`);
  const blocked = r.problems.filter((p) => p.severity === 'blocked');
  const warns = r.problems.filter((p) => p.severity === 'warn');

  /* 词表正本：与快照**不是同一件事**。快照回答"来源换过没有"（上面那行），
   * 正本回答"判定用的那批词是哪一版、现在还作不作数"。这里把它的状态一并报出来，
   * 有漂移就**留痕**（LexiconDrift.json）并判 blocked——漂移只在 stderr 上喊一声，
   * 三个月后没人能回答"那一天到底差的是哪些词"。 */
  const storeState = SHARED.lexiconStoreState(P);
  console.log(` 词表正本：${describeStoreState(storeState, m)}`);
  if (storeState.mode === 'drift' || storeState.mode === 'broken') {
    const live = await SHARED.liveLexicon(P).catch(() => null);
    const rec = await SHARED.recordLexiconDrift(P, { state: storeState, liveKnown: live?.known ?? null });
    const diffLine = rec?.payload.wordDiffNote;
    blocked.push({
      kind: 'lexicon-drift',
      message:
        `词表正本与现场对不上（${storeState.mode}）：${(storeState.drift?.drift ?? [storeState.notices[0] ?? '']).join('；')}` +
        (diffLine ? `｜${diffLine}` : '') +
        `｜已留痕：${rec?.path ?? '（记录失败）'}。修：node tools/af_pipeline/LayerText_AF清单.mjs --reimport`,
    });
  } else {
    for (const n of storeState.notices) console.log(`   ${n}`);
  }

  if (!blocked.length && !warns.length) {
    console.log(`\n✓ 清单一致：${m.artifacts.length} 件产物、输入哈希全部未变、无未完成段落。`);
    console.log('  这次运行可以当作完成品引用（论文里的数字可以标注本运行 ID）。');
    // 撞名是**另一本账**上的事（跨运行），不改变"这次运行自己一致"这个结论——但绝不能不说
    for (const c of collide.collisions.slice(0, 5)) console.log(`  ⚠ ${collisionLine(c)}`);
    if (collide.collisions.length > 5) console.log(`  · 另有 ${collide.collisions.length - 5} 处撞名未列出（上面只印了前 5 处，不静默略过）`);
    process.exit(0);
  }
  for (const c of collide.collisions.slice(0, 5)) {
    warns.push({
      kind: c.kind === '覆盖' ? 'artifact-collision' : 'artifact-fork',
      message: collisionLine(c),
    });
  }
  if (collide.collisions.length > 5) warns.push({ kind: 'artifact-collision', message: `另有 ${collide.collisions.length - 5} 处撞名未列出（不静默略过：上面只印了前 5 处）` });
  for (const p of blocked) console.error(` ✗ [${p.kind}] ${p.message}`);
  for (const p of warns) console.warn(` ⚠ [${p.kind}] ${p.message}`);
  if (blocked.length) {
    console.error(`\n✗ ${blocked.length} 个硬问题：这份产物**不能当作完成品**。`);
    console.error('  最常见的解法：按原命令重跑（词表变过就必须重跑，否则新旧口径混在一本书里）。');
    process.exit(1);
  }
  console.log('\n⚠ 只有告警，没有硬问题。');
  process.exit(0);
}

/* ────────────────────── 摘要（默认） ────────────────────── */
/** 一行说清"这次读的是什么口径"：正本 / legacy 直读 CSV / 拒绝。 */
function describeStoreState(st, m) {
  const recorded = m.lexicon.storeVersion ? `清单记 ${m.lexicon.storeVersion}｜` : '';
  switch (st.mode) {
    case 'store':
      return `${recorded}当前 ${st.store.version}（已知 ${st.store.counts.known} 词、导入于 ${st.store.createdAt}）——现场一致，读正本`;
    case 'drift':
    case 'broken':
      return `${recorded}**${st.mode === 'drift' ? '已与现场不一致' : '读不出来'}**：${(st.drift?.drift ?? st.notices).join('；')}`;
    case 'reimport':
      return `${recorded}导入模式（按现场 CSV 读，导入会覆盖正本）`;
    default:
      return '**没有正本（legacy）**：直读现场 CSV——这是首次导入之前的既有行为，跑一次 --reimport 即可冻结';
  }
}

/**
 * 产物身份的覆盖情况：**盘上写没写 id** 是事实，"读的时候算不算得出来"是另一回事——
 * 两件事分开说，免得有人以为"清单里没有 id 就不能用"。
 * 旧清单照常工作（身份是算出来的），跑一次 `--stamp` 才会把它写进盘上。
 */
function describeIdentities(m) {
  const list = m.artifacts ?? [];
  if (!list.length) return '清单里还没有产物——没有东西可以标识（跑生成/管线会自动盖章）';
  const ids = new Set(list.map((a) => a.id || artifactIdOf(a)));
  const missing = artifactsMissingId(m).length;
  const counted = `${list.length} 件产物、${ids.size} 个身份`;
  return missing
    ? `${counted}，其中 ${missing} 件盘上还没写身份（旧清单形状：读取时按 种类+层级+章节 算得出来，跑一次 --stamp 就补齐）`
    : `${counted}（身份与路径无关：同一件产物换个目录/换布局仍是同一个 ID）`;
}

/** 一条撞名的说明：**先说哪一件产物，再说它在哪儿**。
 *  路径只回答"在哪儿"，身份才回答得了"这是两件不同的东西，还是同一件被写了两次"。 */
function collisionLine(c) {
  const runs = c.runs.join(' / ');
  return c.kind === '覆盖'
    ? `产物「${c.label}」（${c.id}）被多次运行写到**同一个路径**（${c.overwritten.join('、')}；${runs}）——后写的盖掉了先写的，换 --layout run 可根治`
    : `产物「${c.label}」（${c.id}）被多次运行各写了一份、落在不同路径（${c.paths.join('、')}；${runs}）——没有互相覆盖，但两份谁作数要人定`;
}

const m = cur.manifest;
const s = summarizeManifest(m);
console.log('════ AF 运行清单 ════');
console.log(` 运行 ID：${m.runId}`);
console.log(` ${m.book}｜版本 ${m.version}｜层 ${m.tiers.join('/')}｜章 ${m.chapters.join(',')}｜教师 ${m.teacher}`);
/* 教师这一行要能回答"这个名字在名录里算谁"：
 * 旧清单里可能记着**归一化之前**的写法（`Wayne`），而它算的是 `wayne`——
 * 不说清楚，看报表的人会以为这本书上有两个教师。只读解析，不登记。 */
const tinfo = await SHARED.resolveTeacher(P, m.teacher);
console.log(` 教师身份：${tinfo.id}（${tinfo.resolution?.status ?? tinfo.why}）${tinfo.id !== m.teacher ? `——清单里记的是「${m.teacher}」，按稳定 ID 算作「${tinfo.id}」` : ''}`);
if (!tinfo.available) console.warn(` ⚠ ${tinfo.notes?.[0] ?? '教师身份无法归一化'}`);
console.log(` 模型 ${m.model.name}（温度 ${m.model.temperature}）｜提示词 ${m.model.promptVersion}`);
if (m.partialChapters?.length) console.log(` ⚠ partial 章（未写完，不进全书分母，学生版默认拒发）：${m.partialChapters.map((n) => CN[n - 1] ?? `第${n}章`).join('、')}`);
console.log(` 词表快照 ${m.lexicon.version}｜输入 ${m.inputs.length} 项｜产物 ${s.artifactCount} 件｜待复核 ${s.pendingReview} 段`);
console.log(` 词表正本：${describeStoreState(SHARED.lexiconStoreState(P), m)}`);
console.log(` 步骤：${m.steps.map((x) => `${x.ok ? '✓' : '✗'}${x.id}`).join(' ') || '（还没跑）'}`);
console.log(s.deliverable ? ' ✓ 可交付' : ' ✗ 不可交付（有未完成段落或失败步骤）');
console.log(` 清单：${cur.path}`);
