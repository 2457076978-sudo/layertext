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
const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
/* 层级标签与指针命名都从引擎取——**不在脚本里再抄一份**（抄一份就会有一天改漏） */

const M = await import(`${SHARED.distOf(REPO)}/src/core/manifest.js`);
const {
  buildLexiconSnapshot,
  refOf,
  newManifest,
  upsertArtifact,
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

const TIERS = arg('--tier', 'A')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter((t) => TAGS[t]);
const CH_IDS = arg('--chapters', '')
  ? arg('--chapters')
      .split(',')
      .map((x) => Number(x.trim()))
      .filter((n) => n >= 1 && n <= 10)
  : CN.slice(0, Number(P.章数 ?? 10)).map((_, i) => i + 1);
const TEACHER = arg('--teacher', process.env.LAYERTEXT_TEACHER ?? process.env.USER ?? 'unknown');
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
      const ch = `第${CN[ci - 1]}章`;
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
      const ch = `第${CN[ci - 1]}章`;
      const abs = rr.any('正文', { chapter: ch, tier: tag, date: DATE });
      const rel = abs.replace(`${OUT_BASE}/`, '');
      if (!existsSync(abs)) continue;
      const text = readFileSync(abs, 'utf-8');
      out.push({ path: rel, kind: '正文', tier: t, chapter: ch, status, reason, hash: contentHash(text), bytes: text.length, updatedAt: new Date().toISOString() });
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
      out.push({ path: rel, kind, tier: t, status: 'ok', hash: contentHash(text), bytes: text.length, updatedAt: new Date().toISOString() });
    }
    // 待复核的段落数：清单的"能不能交付"由它决定
    if (review) {
      const list = JSON.parse(review).待复核明细 ?? [];
      for (const d of list) {
        out.push({
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
    teacher: TEACHER,
    model: { name: P.模型 ?? 'deepseek-chat', temperature: 0.3, promptVersion: arg('--prompt', 'session-v3-20260911') },
    // 版本仍是**快照版本**：既有运行的 --verify 不该因为这次改动凭空报一次漂移（假警报比没有警报更坏）
    lexicon: { version: snapshot.version, snapshotPath: snapPath, warnings: snapshot.warnings, storePath: imported.storePath, storeVersion: imported.store.version },
    inputs,
    owner: { pid: process.pid, host: hostname() },
    layout: LAYOUT,
  });
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
  for (const t of tierTags) writeFileSync(pointerOf(m.teacher, t), pointer, 'utf-8');
  writeFileSync(MANIFEST_POINTER, pointer, 'utf-8');
  console.log('════ AF 运行清单 · 新建 ════');
  console.log(` 运行 ID：${m.runId}`);
  console.log(` 书名：${m.book}｜版本：${m.version}｜层：${m.tiers.join('/')}｜教师：${m.teacher}`);
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

/* ────────────────────── 刷状态（每一步跑完调一次） ────────────────────── */
if (has('--stamp')) {
  const m = cur.manifest;
  for (const a of scanArtifacts()) upsertArtifact(m, a);
  m.pendingReview = pendingReviewOf();
  recordStep(m, { id: arg('--step', '（未命名）'), ok: arg('--ok', '1') !== '0', sec: Number(arg('--sec', '0')) || 0, note: arg('--note', undefined) });
  if (arg('--warning')) m.warnings.push({ kind: arg('--warning-kind', 'step'), message: arg('--warning'), at: new Date().toISOString() });
  saveManifest(m, cur.path);
  const s = summarizeManifest(m);
  console.log(`清单已更新：${m.runId}｜产物 ${s.artifactCount} 件｜待复核 ${s.pendingReview}｜步骤 ${m.steps.length}`);
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
  console.log(` 词表快照：清单 ${m.lexicon.version}｜当前 ${snapshot.version}${drift.ok ? '（一致）' : '（**已变**）'}`);
  console.log(` 路径布局：${m.layout ?? 'legacy'}｜已登记运行 ${siblings.length} 个${collide.ok ? '（无跨运行撞名）' : `（**${collide.collisions.length} 处撞名**）`}`);
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
    process.exit(0);
  }
  for (const c of collide.collisions.slice(0, 5)) {
    warns.push({ kind: 'artifact-collision', message: `产物被多次运行写过：${c.path}（${c.runs.join(' / ')}）——换 --layout run 可根治` });
  }
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

const m = cur.manifest;
const s = summarizeManifest(m);
console.log('════ AF 运行清单 ════');
console.log(` 运行 ID：${m.runId}`);
console.log(` ${m.book}｜版本 ${m.version}｜层 ${m.tiers.join('/')}｜章 ${m.chapters.join(',')}｜教师 ${m.teacher}`);
console.log(` 模型 ${m.model.name}（温度 ${m.model.temperature}）｜提示词 ${m.model.promptVersion}`);
console.log(` 词表快照 ${m.lexicon.version}｜输入 ${m.inputs.length} 项｜产物 ${s.artifactCount} 件｜待复核 ${s.pendingReview} 段`);
console.log(` 词表正本：${describeStoreState(SHARED.lexiconStoreState(P), m)}`);
console.log(` 步骤：${m.steps.map((x) => `${x.ok ? '✓' : '✗'}${x.id}`).join(' ') || '（还没跑）'}`);
console.log(s.deliverable ? ' ✓ 可交付' : ' ✗ 不可交付（有未完成段落或失败步骤）');
console.log(` 清单：${cur.path}`);
