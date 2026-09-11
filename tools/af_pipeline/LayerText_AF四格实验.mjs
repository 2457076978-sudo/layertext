#!/usr/bin/env node
/** AF 四格实验：把「2%→98%」拆成可归因的单因子增益
 *
 * 审查报告 §二：「2%→98% 的实验不能归因：一次同时改变了词表注入、会话记忆、查词和复检，
 * 且只有 31 段。至少做四格实验：独立调用/会话 × 有无全词表，固定温度和同一章；
 * 报告生成覆盖率、最终覆盖率、重复注释率、人工修订率和 token 成本。」
 *
 * 总计划阶段 4 的验收标准（本脚本要为它**留下证据**）：
 *   「四格实验有可重复的输入快照和原始事件；任一质量结论都能追溯到运行 ID」
 *   「A/M 两条轴分别报告阅读负荷下降与理解支架覆盖率，**禁止综合分数替代**」
 *
 * 它做的事：同一章、同一模型、同一温度（0.3），只动两个因子，跑四遍，然后并排比。
 *   · 会话记忆：一条会话走完（`--scope tier`） vs 每段独立调用（`--scope segment`）
 *   · 全词表注入：开场给全词表（`--vocab full`） vs 只给"该注哪些词"（`--vocab lite`）
 *
 * ── 跑之前先冻输入，跑完再核一遍 ────────────────────────────────────────
 * 只留一张对照表是不够的：表里的数离开"输入是什么"就不可复核。所以本脚本
 *   ① 跑之前把输入冻成**快照**（原文逐段哈希 / 词表快照版本 / 模型+温度+响应上限 /
 *      提示词版本 / 代码版本与工作区脏指纹 / 四格定义），写进 `_运行/四格实验_<层>_快照.json`；
 *   ② 每一格跑完把**原始事件**逐行追加进 `_运行/四格实验_<层>_原始事件.jsonl`
 *      （哪一格、哪一段、模型、温度、tokens、截断事实、花费、原始结果）；
 *   ③ 跑完拿快照和"现在的输入"再比一次（含会话日志里记的 model / promptVersion），
 *      **有漂移就把状态标成"有缺口"，那批数字不当结论**——漂移被容忍一次，
 *      "同一份快照跑两次"这句话就永远只是句口号。
 * 五个指标**不在这里各算一份**：它们由 `src/core/experimentrun.ts` 从上面那批事件派生，
 * 报告与 JSON 用的是同一份派生结果（两处各算一份，迟早会变成两个数）。
 *
 * 用法：
 *   node LayerText_AF四格实验.mjs --tier A --chapters 2            # 真跑（**消耗 API 额度**：4 遍）
 *   node LayerText_AF四格实验.mjs --tier A --chapters 2 --fake exact   # 自检（不调 API，验证实验台本身）
 *   node LayerText_AF四格实验.mjs --tier A --chapters 2 --dry      # 只打印计划（不写任何文件）
 *
 * 产物：
 *   产物目录/四格实验_<层>_<日期>.md              人看的对照表与结论
 *   产物目录/_运行/四格实验_<层>.json             机器格式（论文里引用数字用这份）
 *   产物目录/_运行/四格实验_<层>_快照.json        输入快照（**跑之前**写，跑完再核）
 *   产物目录/_运行/四格实验_<层>_原始事件.jsonl   原始事件（逐行，指标的唯一起点）
 *
 * 注意：四格实验会**覆盖同名产物**，所以每格都带独立后缀（`_exp1`…`_exp4`），
 * 不碰你正在用的正式产物。跑完记得回来跑一次正式生成。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHARED = await import('./LayerText_AF词表与词典.mjs');
const { distOf } = SHARED;
const P = SHARED.loadProject();
const REPO = P.引擎目录;
const SRC_BASE = P.原文目录;
const OUT_BASE = P.产物目录;
const DATE = P.日期;
/* 章节名从共享模块取（**不再在 10 个脚本里各抄一份 `['一'…'十']`**）：
 * 那份抄写写死了"十章"，换一本 12 章的书会拼出 `第undefined章` 而**照常报成功**。
 * 现在优先级是「配置 > 原文目录 > 默认（第N章 × 章数）」，
 * 最后那层逐字符复现旧行为，所以既没配置、也没有可扫目录的老项目结果不变。 */
const CN = SHARED.chapterNames(P);
const TAGS = { A: 'A层85', M: 'M层75', B: 'B层60' };

/* ────────────────────── 命令行 ────────────────────── */
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const has = (n) => argv.includes(n);
const TIER = arg('--tier', 'A').split(',')[0].trim().toUpperCase();
if (!TAGS[TIER]) {
  console.error(`✗ 未知层级「${TIER}」`);
  process.exit(2);
}
/** 层级标签：**必须先于**下面所有用到 TAG 的地方求值。
 *  （原来这段写在 `readRunIdentity` 之后，于是 `tier: TAG` 撞在暂时性死区上——
 *   脚本在打印第一行之前就 `ReferenceError` 崩掉，"实验台能不能跑"从来没人验证过。） */
const TAG = TAGS[TIER];
const CH = Number(arg('--chapters', '1').split(',')[0]);
const FAKE = arg('--fake', '');
/** 固定项：与 `LayerText_AF会话改写.mjs` 保持一致（那边 MODEL 固定、温度 0.3、单次上限 3000）。
 *  这里是**声明**而不是权威——跑完会用会话日志里 `done` 事件记的 model / promptVersion 反向核对，
 *  对不上就按"输入漂移"报出来（见下面的 observedDrift）。 */
const MODEL = P.模型 ?? 'deepseek-chat';
const TEMPERATURE = 0.3;
const MAX_TOKENS = 3000;
const PROMPT_VERSION = arg('--prompt', 'session-v3-20260911');

const { makeResolver } = await import(`${distOf(REPO)}/src/core/manifest.js`);
/* ── 路径一律经清单解析（总计划阶段 3「最关键的迁移」）─────────────────────
 * 「把路径解析集中到一个 `Resolver`，**禁止业务代码拼目录**」。
 * 本脚本原来用 `join(OUT_BASE, ch, `原文_${tag}_${DATE}.md`)` 这类手拼——
 * legacy 布局下逐字符正确，`--layout run` 下**写在一处、读又从另一处读**，
 * 而脚本照常报告成功（这类"不报错、结果错"正是这个规模崩点的样子）。
 * 命名规则的唯一来源是 `src/core/manifest.ts` 的 `resolvePath`。
 * 身份也走共享的那一个入口：两位教师并发时不再互相读到对方的 runId。 */
/* 身份从命令行取。**刻意不复用各脚本自己的参数助手**：它们的定义位置各不相同
 * （有的还是 `args.includes` 风格），在这一段引用会在定义之前求值。 */
const argRun = (n, d) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : d;
};
const TEACHER = argRun('--teacher', process.env.LAYERTEXT_TEACHER ?? process.env.USER ?? 'unknown');
const RUN = await SHARED.readRunIdentity({ out: OUT_BASE, work: P.调适工作区 }, { teacher: TEACHER, tier: TAG }, { runId: argRun('--run', undefined) });
if (RUN.warning) console.warn(`\n⚠ ${RUN.warning}`);
/** 按层级标签取解析器（多层脚本与单层脚本共用同一种写法） */
const RR = (tag) => makeResolver(RUN.layout, { out: OUT_BASE, work: P.调适工作区 }, { runId: RUN.runId, tier: tag, date: DATE });
const R = RR(TAG);

/* ────────────────────── 引擎侧模块 ────────────────────── */
const { experimentPlan, compareCells, experimentVerdict, segmentFirstResponses } = await import(`${distOf(REPO)}/src/core/experiment.js`);
const {
  axesLines,
  assertNoComposite,
  buildExperimentSnapshot,
  cellKeyOf,
  experimentStatus,
  makeRawEvent,
  metricValue,
  snapshotChapterOf,
  snapshotDrift,
  statusLines,
  tierAxes,
  traceConclusion,
  truncationReport,
  METRIC_NAMES,
} = await import(`${distOf(REPO)}/src/core/experimentrun.js`);
const { buildLexiconSnapshot, contentHash, refOf } = await import(`${distOf(REPO)}/src/core/manifest.js`);
const { segmentList } = SHARED;
const { runQc } = await import(`${distOf(REPO)}/src/core/qc.js`);
const LEX = await SHARED.loadLexicon(P);
const DICT = SHARED.loadDict(P.词典路径);

const oovOf = (text) => {
  const md = `## Chapter One\n\n${text}\n`;
  return [...new Set(runQc(md, LEX, { tier: TIER, fileName: 'seg.md', dict: DICT }).oov)].filter((w) => w.length > 2);
};

const ch = CN[CH - 1];
const srcPath = join(SRC_BASE, ch, '原文_规范化.md');
if (!existsSync(srcPath)) {
  console.error(`✗ 缺规范化原文：${srcPath}`);
  process.exit(2);
}
const srcSegs = segmentList(readFileSync(srcPath, 'utf-8'));

console.log('════ AF 四格实验 ════');
console.log(`项目：${P._meta?.名称 ?? '（未命名）'}｜书：${P.书名}｜层：${TIER}｜章：${ch}（${srcSegs.length} 段）`);
console.log('因子：会话记忆（一条会话 / 每段独立）× 全词表注入（给全表 / 只给该注的词）');
console.log(`固定项：模型 ${MODEL}、温度 ${TEMPERATURE}、同一章、同一词表快照｜运行 ID ${RUN.runId}${FAKE ? `｜⚠ 自检假模型：${FAKE}` : ''}`);
console.log('\n计划：');
experimentPlan().forEach((c, i) => console.log(`  ${i + 1}. ${c.label}  ——  --scope ${c.scope} --vocab ${c.vocabArg}`));

/* ────────────────────── ① 输入快照（跑之前冻住） ────────────────────── */
/** 代码版本：package.json + git 提交 + **与本次实验有关的源码内容指纹**。
 *
 *  为什么不是简单地"git status 有没有脏"：① 只记"变过"记不住内容——同一份文件先改 A 再改 B，
 *  状态行一模一样，跑的过程中被改过就抓不到；② 整个工作区都算进来的话，别的模块（app/**）在动
 *  也会报漂移，那是噪音。所以只对**影响本次实验的那几处**（引擎核心 / 管线脚本 / 提示词 / package.json）
 *  取内容哈希：它们变一个字节，指纹就变。 */
function codeFingerprint() {
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf-8'));
  const g = (args) => {
    const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf-8' });
    return r.status === 0 ? String(r.stdout).trim() : '';
  };
  const rel = ['package.json'];
  const walk = (dir) => {
    for (const e of readdirSync(join(REPO, dir), { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|mjs|md)$/.test(e.name)) rel.push(p);
    }
  };
  for (const d of ['src/core', 'tools/af_pipeline', 'prompts']) if (existsSync(join(REPO, d))) walk(d);
  const dirtyHash = contentHash(
    rel
      .sort()
      .map((p) => `${p}\u0000${readFileSync(join(REPO, p), 'utf-8')}`)
      .join('\n'),
  );
  const dirtyLines = g(['status', '--porcelain', '--', 'src/core', 'tools/af_pipeline', 'prompts', 'package.json']).split('\n').filter(Boolean);
  return { version: String(pkg.version ?? ''), commit: g(['rev-parse', '--short', 'HEAD']) || '(非 git 工作区)', dirtyCount: dirtyLines.length, dirtyHash };
}

/** 词表快照来源：与 `LayerText_AF清单.mjs` **同一份文件清单**（口径不许两处各写一份） */
function lexiconSnapshotOf() {
  const files = [
    ['词库', P.词库],
    ['专名表', P.专名表路径],
    ['知识库', P.知识库路径],
    ['词典', P.词典路径],
    ['情节底线', P.工作区 ? join(P.工作区, P.情节底线 ?? '调适工作区/规则与底线/全书情节底线_v0.1.md') : null],
    ['教材单元库', P.教材单元库],
  ];
  const sources = [];
  const counts = { known: 0, pending: 0, proper: 0, dict: 0, kb: 0 };
  const knownAll = [];
  const readIf = (p) => (p && existsSync(p) ? readFileSync(p, 'utf-8') : null);
  for (const [name, path] of files) {
    const text = readIf(path);
    if (text === null) continue;
    const count = text.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).length;
    sources.push({ ...refOf(name, path, text), count });
    if (name === '词库') {
      counts.known = count;
      for (const l of text.split('\n').slice(1)) {
        const w = l.split(',')[0]?.trim();
        if (w) knownAll.push(w);
      }
    }
    if (name === '专名表') counts.proper = count;
    if (name === '词典') counts.dict = count;
    if (name === '知识库') counts.kb = count;
  }
  const snap = buildLexiconSnapshot({ sources, counts, known: knownAll });
  return { version: snap.version, counts, sources: snap.sources.map((s) => ({ name: s.name, hash: s.hash, count: s.count })) };
}

const chapterSnap = snapshotChapterOf(
  ch,
  srcSegs.map((s) => ({ id: s.id, text: s.text })),
);
const lexSnap = lexiconSnapshotOf();
const codeNow = () => {
  const c = codeFingerprint();
  return { version: c.version, commit: c.commit, dirty: c.dirtyHash, dirtyCount: c.dirtyCount };
};
const SNAP = buildExperimentSnapshot({
  runId: RUN.runId,
  tier: TIER,
  chapter: chapterSnap,
  lexicon: lexSnap,
  model: { name: MODEL, temperature: TEMPERATURE, maxTokens: MAX_TOKENS },
  promptVersion: PROMPT_VERSION,
  code: codeNow(),
});
const snapshotPath = R.any('运行中间产物', { name: `四格实验_${TAG}_快照` });
const eventsPath = R.any('运行中间产物', { name: `四格实验_${TAG}_原始事件`, ext: '.jsonl' });
console.log(
  `\n输入快照指纹：${SNAP.hash}（原文 ${chapterSnap.segments.length} 段｜词表 ${lexSnap.version}｜提示词 ${PROMPT_VERSION}｜代码 ${SNAP.code.version}@${SNAP.code.commit}${SNAP.code.dirtyCount ? ` 脏 ${SNAP.code.dirtyCount} 处` : ''}）`,
);
if (has('--dry')) {
  console.log(`\n（--dry，未执行）跑之前会写：${snapshotPath}`);
  console.log(`（--dry，未执行）每格跑完会追加：${eventsPath}`);
  process.exit(0);
}
if (!FAKE) {
  console.log(`\n⚠ 这会真跑 4 遍（消耗 API 额度）。产物后缀 _exp1…_exp4，不碰正式产物。`);
}
mkdirSync(dirname(snapshotPath), { recursive: true });
writeFileSync(snapshotPath, JSON.stringify(SNAP, null, 2), 'utf-8');
mkdirSync(dirname(eventsPath), { recursive: true });
writeFileSync(eventsPath, '', 'utf-8'); // 清空上一次的原始事件：混两次运行的事件，指标就成了两件事的平均
console.log(`✓ 快照已冻（先写盘再跑）：${snapshotPath}`);

/* ────────────────────── ② 逐格跑 + 采原始事件 ────────────────────── */
/** 会话日志 → 原始事件。日志是**唯一**的原始账：
 *    · 段处理顺序 = "第 N/M 段" 请求的出现顺序（与逐段 `stats` 同序）
 *    · 段级用量 = 相邻两条累计 `stats` 的差（会话脚本每段落一条）
 *    · 首轮响应 = `segmentFirstResponses`（第一次助手响应才是"生成"的样子）
 *    · 落盘正文 = 产物文件里的那一段；没有正文 = 这一段没通过（进人工队列）
 *  拿不到的事实就**空着**：会话日志没记 `finish_reason`，所以截断事实是 unknown，
 *  截断率会报"算不出来"——而不是一个看着很好看的 0%。 */
/** 未过门禁的段在正文里留的是 HTML 注释占位（刻意留的：保住后面段落的位置）。
 *  它**不是**落盘产物——把占位当成最终正文，人工修订率就会变成 0，
 *  而事实是这一段根本没交付。这类"数字看着好、事实相反"正是本实验要杜绝的。 */
const isPlaceholder = (t) => /^\[P\d+\]\s*<!--/.test(String(t).trim());

function rawEventsOfCell({ spec, finals, logPath }) {
  const out = [];
  if (!existsSync(logPath)) return { events: out, observed: null, aligned: false };
  const text = readFileSync(logPath, 'utf-8');
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* 坏行跳过；半截的 JSON 不该让整格事件消失 */
    }
  }
  const order = [];
  for (const o of rows) {
    if (o.t !== 'msg' || o.role !== 'user' || typeof o.content !== 'string') continue;
    const m = o.content.match(/(第[一二三四五六七八九十]+章)\s*·\s*第\s*(\d+)\s*\/\s*(\d+)\s*段/);
    if (!m) continue;
    const k = Number(m[2]) - 1;
    if (!order.includes(k)) order.push(k);
  }
  const stats = rows.filter((o) => o.t === 'stats').map((o) => o.v ?? { calls: 0, in: 0, out: 0, cached: 0 });
  const doneByKey = new Map(rows.filter((o) => o.t === 'done' && o.key).map((o) => [o.key, o]));
  /** 未过门禁的段由 `review` 事件记名（**这才是权威**：产物文件里只有一句占位注释） */
  const reviews = new Set(rows.filter((o) => o.t === 'review' && o.key).map((o) => o.key));
  const firsts = segmentFirstResponses(text);
  // 实际用过的模型/提示词版本：优先 `done`（有 model），退一步 `review`（只有 promptVersion）
  const fact = [...doneByKey.values()][0] ?? rows.find((o) => o.t === 'review' && o.promptVersion);
  const observed = fact ? { model: fact.model ?? null, promptVersion: fact.promptVersion ?? null } : null;
  let prev = { calls: 0, in: 0, out: 0, cached: 0 };
  let approx = stats.length !== order.length;
  for (const [i, k] of order.entries()) {
    const key = `${ch}#${k}`;
    const cur = stats[i];
    const delta = cur ? { calls: cur.calls - prev.calls, in: cur.in - prev.in, out: cur.out - prev.out, cached: cur.cached - prev.cached } : { calls: 0, in: 0, out: 0, cached: 0 };
    if (cur) prev = cur;
    // 对齐自检：`done` 事件记着本段权威用量；与增量对不上说明段序错位（某段抛异常没写 stats），
    // 那就要把"推定"标出来——推定值不该装成直接测得的。
    const done = doneByKey.get(key);
    if (done?.usage) {
      // `done.usage` 只有 in/out/cached（会话脚本累加时没带 calls），所以只比这三项：
      // 段序一旦错位，token 一定对不上；拿不存在的字段比，只会把每一格都误判成"推定"。
      const u = done.usage;
      if (u.in !== delta.in || u.out !== delta.out || u.cached !== delta.cached) approx = true;
    }
    const seg = srcSegs[k];
    if (!seg) continue;
    const first = firsts.get(key);
    const raw = finals.get(seg.id);
    const final = raw !== undefined && !isPlaceholder(raw) ? raw : undefined;
    out.push({
      spec,
      segment: seg.id,
      usage: delta,
      usageApprox: approx,
      source: seg.text,
      ...(first !== undefined ? { first } : {}),
      ...(final !== undefined ? { final } : {}),
      ...(done?.inputHash ? { inputHash: done.inputHash } : {}),
      /* ★ 截断事实：会话日志的 `done` 记录里现在带 `finishReason`（`length` = 撞上 max_tokens）。
       * 之前这里没把它转发下来，于是"截断率"永远只能报"算不出来"——
       * 而从"日志里没有"到"事件里没有"之间隔了一次转发，很容易被当成"上游没记"。 */
      ...(done?.finishReason ? { finishReason: done.finishReason } : {}),
      // 落盘了才算交出去；`review` 记名的当然算没交出去（两处都看，不信单边）
      outcome: final !== undefined && !reviews.has(key) ? 'pass' : 'needs-review',
    });
  }
  return { events: out, observed, aligned: !approx, tail: stats.length ? stats[stats.length - 1] : null };
}

const cellSpecs = experimentPlan();
const allEvents = [];
const observedFacts = [];
/** 没跑起来的格（子进程崩了/没写日志）：它们是"缺口"，不是"跑出来是 0" */
const cellFailures = [];
for (const [i, spec] of cellSpecs.entries()) {
  const suffix = `exp${i + 1}`;
  console.log(`\n──────── 第 ${i + 1} 格：${spec.label} ────────`);
  const env = { ...process.env, LAYERTEXT_ENGINE: REPO };
  if (FAKE) env.LAYERTEXT_FAKE_LLM = FAKE;
  const r = spawnSync(process.execPath, [join(HERE, 'LayerText_AF会话改写.mjs'), '--tier', TIER, '--chapters', String(CH), '--scope', spec.scope, '--vocab', spec.vocabArg, '--out', suffix], {
    stdio: 'inherit',
    env,
    cwd: process.cwd(),
  });
  // 非零退出**不中止实验**：未通过门禁的段本身就是"人工修订率"要测的东西
  if (r.status !== 0) console.log(`（本格退出码 ${r.status}：未落盘正文的段要人管——这正是"人工修订率"要测的东西）`);

  const outFile = R.any('正文', { chapter: ch, suffix: `_${suffix}` });
  const finals = new Map(segmentList(existsSync(outFile) ? readFileSync(outFile, 'utf-8') : '').map((s) => [s.id, s.text]));
  const logPath = R.session({ scope: spec.scope, vocab: spec.vocabArg, suffix: `_${suffix}` });
  const { events, observed, tail } = rawEventsOfCell({ spec, finals, logPath });
  /* ★ 一条事件都没有 = 这一格**根本没跑起来**（子进程崩了、会话日志没写）。
   *   它和"跑了但每段都没过门禁"是两件完全不同的事：后者有原始事件、有人工修订率，
   *   前者什么都没有。**没有事件就不写事件、也不写格级事件**——
   *   写一条 usage 全 0 的格级事件，会让这一格在报告里看起来"跑过且花费为 0"，
   *   而缺格本该由 `experimentStatus` 明说"四格还缺这一格"。 */
  if (!events.length && !tail) {
    cellFailures.push(`「${spec.label}」没跑起来（子进程退出码 ${r.status}，没有任何原始事件）：这一格不是"跑了没过门禁"，是**根本没跑**`);
    console.log('  ✗ 这一格没有产生任何原始事件——按"没跑"处理，缺格会写进结论。');
    continue;
  }
  const cellUsage = tail ?? { calls: 0, in: 0, out: 0, cached: 0 };
  for (const e of events) {
    allEvents.push(makeRawEvent({ runId: RUN.runId, tier: TIER, model: MODEL, temperature: TEMPERATURE, promptVersion: PROMPT_VERSION, ...e }));
  }
  // 格级事件：调用次数与 token 的**权威合计**（段级增量只是推定）
  const cellEv = makeRawEvent({ runId: RUN.runId, spec, tier: TIER, segment: null, model: MODEL, temperature: TEMPERATURE, promptVersion: PROMPT_VERSION, usage: cellUsage });
  allEvents.push(cellEv);
  // 原始事件**当场追加落盘**：中途崩了也留下已经跑过的那部分（而不是什么都收不到）
  appendFileSync(
    eventsPath,
    allEvents
      .slice(-events.length - 1)
      .map((e) => JSON.stringify(e))
      .join('\n') + '\n',
    'utf-8',
  );
  if (observed) observedFacts.push({ cell: cellKeyOf(spec), label: spec.label, ...observed });
  const segs = segmentList(existsSync(outFile) ? readFileSync(outFile, 'utf-8') : '');
  console.log(`  原始事件 ${events.length} 条（落盘正文 ${segs.filter((s) => !isPlaceholder(s.text)).length}/${srcSegs.length} 段）→ 指标由事件派生，见报告`);
}

/* ────────────────────── ③ 跑完再核一遍输入 ────────────────────── */
/** 会话日志里记着真正用过的 model / promptVersion —— 这是**事实**，不是我们的声明。
 *  和快照对不上，就说明"声明与实跑"之间有缝，必须报出来。 */
function observedDrift() {
  const drift = [];
  for (const o of observedFacts) {
    if (o.model && o.model !== SNAP.model.name) drift.push(`「${o.label}」实际用的模型是 ${o.model}，快照记的是 ${SNAP.model.name}`);
    if (o.promptVersion && o.promptVersion !== SNAP.promptVersion) drift.push(`「${o.label}」实际用的提示词版本是 ${o.promptVersion}，快照记的是 ${SNAP.promptVersion}`);
  }
  return [...new Set(drift)];
}
const driftNow = snapshotDrift(SNAP, {
  chapter: snapshotChapterOf(
    ch,
    srcSegs.map((s) => ({ id: s.id, text: s.text })),
  ),
  lexiconVersion: lexiconSnapshotOf().version,
  model: { name: MODEL, temperature: TEMPERATURE, maxTokens: MAX_TOKENS },
  promptVersion: PROMPT_VERSION,
  code: codeNow(),
});
/* 自检假模型跑出来的数不是"模型的表现"，与漂移并列按"不能当结论"处理（同一条机制，不加特例） */
const fakeNote = FAKE ? [`本次是自检假模型（LAYERTEXT_FAKE_LLM=${FAKE}）：数字来自假模型，不是模型跑出来的——不能当实验结论`] : [];
const allDrift = [...driftNow.drift, ...observedDrift(), ...fakeNote, ...cellFailures];
const drift = { ok: allDrift.length === 0, drift: allDrift, blocksConclusion: allDrift.length > 0 };

const opt = { oovOf, dict: DICT, chapter: ch };
const status = experimentStatus({ snapshot: SNAP, events: allEvents, drift, opt });
const metrics = status.metrics;

/* ────────────────────── ④ 两条轴分开算（禁止综合分） ────────────────────── */
/** 轴的定义来自 `positioning.ts`，本脚本只负责喂 QC。
 *  **每个格各出一组两轴**，谁也不合成一个数：合成出来的那个数没人能用它做判断。 */
function axesOfCell(label, finalText) {
  const qcOf = (t) => {
    try {
      return runQc(`## Chapter One\n\n${t}\n`, LEX, { tier: TIER, fileName: 'seg.md', dict: DICT });
    } catch {
      return null;
    }
  };
  const srcQc = qcOf(srcSegs.map((s) => s.text).join('\n\n'));
  const outQc = qcOf(finalText);
  if (!srcQc || !outQc) return null;
  return tierAxes(`${TAG}｜${label}`, srcQc, outQc);
}
const axes = [];
const axesSkipped = [];
for (const [i, spec] of cellSpecs.entries()) {
  const outFile = R.any('正文', { chapter: ch, suffix: `_exp${i + 1}` });
  // 只拿**真正落盘**的段算两轴：占位注释不是产物，拿它算出来的"阅读负荷"是凭空产生的
  const delivered = existsSync(outFile)
    ? segmentList(readFileSync(outFile, 'utf-8'))
        .filter((s) => !isPlaceholder(s.text))
        .map((s) => s.text)
        .join('\n\n')
    : '';
  if (!delivered.trim()) {
    axesSkipped.push(spec.label);
    continue;
  }
  const a = axesOfCell(spec.label, delivered);
  if (a) axes.push(a);
  else axesSkipped.push(spec.label);
}
assertNoComposite({ 两轴: axes }, '四格实验结果'); // 谁往结果里塞"综合得分"，这里就炸——别等它进了销售文案

/* ────────────────────── ⑤ 追溯：每个结论指回运行 ID 与事件行 ────────────────────── */
/** 每个格 × 每个指标都过一遍追溯。**追不到的照样列出来**（标成"不可追溯"），
 *  而不是从报告里消失——消失的结论看起来像"没有这条"，其实是"这条说不清来历"。 */
const traces = cellSpecs.flatMap((spec) =>
  METRIC_NAMES.map((metric) => {
    const t = traceConclusion({ metric, cell: cellKeyOf(spec) }, allEvents);
    return { ...t, label: spec.label };
  }),
);

/* ────────────────────── 报告 ────────────────────── */
const verdict = [...status.verdict, ...(metrics && metrics.length >= 2 ? experimentVerdict(metrics) : [])];
const trunc = truncationReport(allEvents);
const traceable = traces.filter((t) => t.ok);
const untraceable = traces.filter((t) => !t.ok);
const mdPath = R.any('汇总报告', { name: `四格实验_${TAG}` });
const lines = [
  `# ${P.书名} · 四格实验（${TIER} 层 ${ch}）`,
  '',
  `生成：${new Date().toLocaleString('zh-CN')}｜段数：${srcSegs.length}｜模型：${MODEL}（温度 ${TEMPERATURE}）｜运行 ID：\`${RUN.runId}\``,
  '',
  '## 这批数算不算数',
  '',
  ...statusLines(status),
  '',
  `**输入快照指纹**：\`${SNAP.hash}\`（原文逐段哈希 + 词表 ${lexSnap.version} + 模型温度 + 提示词 ${PROMPT_VERSION} + 代码 ${SNAP.code.version}@${SNAP.code.commit}${SNAP.code.dirtyCount ? ` + 脏指纹 ${SNAP.code.dirtyCount} 处` : ''} + 四格定义）`,
  `快照落盘：\`${snapshotPath}\`｜原始事件：\`${eventsPath}\``,
  '',
  '> 两个人拿同一个快照跑，输入才是同一批；输入跑完再核一遍，**有漂移就不当结论**（`snapshotDrift`）。',
  ...(drift.drift.length ? ['', '### 检出的漂移', '', ...drift.drift.map((d) => `- ⚠ ${d}`)] : []),
  '',
  '## 为什么要四格',
  '',
  '「2%→98%」这类数字如果一次同时改了词表注入、会话记忆、查词与复检，就没法归因——',
  '换个条件就复现不出来。这里**只动两个因子**，固定模型、温度与章节，逐格对照。',
  '',
  '## 对照表',
  '',
  compareCells(metrics ?? []),
  '',
  '> 生成覆盖率 = 模型**第一次**写出来的正文里该注的词注出比例；',
  '> 最终覆盖率 = 过门禁落盘产物里的加注覆盖率（含复检回流与本地去重）。',
  '> 两者的差 = 流水线（复检回流 + 去重 + 补注）的贡献，不是提示词的贡献。',
  '',
  '## 两条轴（分开报，不合成一个数）',
  '',
  ...(axes.length ? axes.flatMap((a) => [...axesLines(a), '']) : ['（这一层还没有落盘正文，两条轴都算不出来——**不是 0**）', '']),
  ...(axesSkipped.length ? [`> 下面这几格没有落盘正文，两轴**不出数**：${axesSkipped.join('、')}（占位注释不是产物，拿它算出来的"阅读负荷下降"是凭空产生的数字）`, ''] : []),
  '> 阅读负荷下降管的是"难词变少了没有"，理解支架覆盖率管的是"该配的拐杖配上没有"。',
  '> **加注不减少阅读负荷**——学生仍要解码那个词。两件事分开报，验收标准明令禁止用综合分数替代。',
  `> 本次只跑了 ${TIER} 一层；A/M 两层的两轴对照，需要 A、M 各跑一次再并排（本报告不替另一层编数）。`,
  '',
  '## 五个指标怎么来的（原始事件 → 指标）',
  '',
  `- 指标由 \`experimentrun.cellRecords\` 从 ${allEvents.length} 条原始事件派生（脚本不另算一份）。`,
  `- 花费与调用次数取**格级事件**（会话日志最后一条累计 stats），段级用量是相邻 stats 的增量。`,
  `- 截断率：${trunc.rate === null ? `**算不出来**（${trunc.why}）` : `${(trunc.rate * 100).toFixed(1)}%（${trunc.yes}/${trunc.yes + trunc.no}）`}`,
  `- 疑似截断（**代理指标**，不是截断率本身）：${trunc.suspected} 段响应没有句终标点。`,
  '- ⚠ 截断事实为什么不可得：本次的会话日志里没有 `finish_reason`（老日志、或调用方没记）。',
  '  正常路径下 `LayerText_AF会话改写.mjs` 会把 `finish_reason` 写进每条 done/review 记录，',
  '  也不拿"响应末尾没有句号"当截断率（那是代理指标，已在上面单独报）。',
  '',
  '## 结论',
  '',
  ...(status.state === '可出结论' ? [] : ['> 先看上面「这批数算不算数」：状态不是「可出结论」，下面这些**只能在内部看**。', '']),
  ...experimentVerdict(metrics ?? []).map((v) => `- ${v}`),
  '',
  '## 每一格的一句话',
  '',
  ...(status.cells.length
    ? status.cells.map((c) => {
        const m = c.metric;
        return `- **${m.label}**：${m.segments} 段，生成 ${(m.genCoverage * 100).toFixed(1)}% → 最终 ${(m.finalCoverage * 100).toFixed(1)}%（提升 ${m.coverageGain}pp），重复注释 ${(m.duplicateRate * 100).toFixed(1)}%，人工修订 ${(m.manualRate * 100).toFixed(1)}%，${m.calls} 次调用 ¥${m.cost.toFixed(3)}｜事件 ${c.eventIds.length} 条`;
      })
    : ['（没有实验结果）']),
  '',
  '## 追溯：结论 → 运行 ID → 事件行',
  '',
  `可追溯 ${traceable.length} 条，不可追溯 ${untraceable.length} 条。不可追溯的**不能当发现**，只能报"不可追溯"。`,
  '',
  ...(untraceable.length ? ['不能追溯的：', '', ...untraceable.map((t) => `- 「${t.label}」${t.metric}：${t.why}`), ''] : []),
  '| 指标 | 格 | 运行 ID | 事件行 | 说明 |',
  '|---|---|---|---:|---|',
  ...traces.map((t) => `| ${t.metric} | ${t.label} | ${t.ok ? t.runIds.join('、') : '—'} | ${t.ok ? t.eventIds.length : '—'} | ${t.ok ? t.why : `⚠ ${t.why}`} |`),
  '',
  '## 怎么用这份结果',
  '',
  '- 只引用**单因子**那一行：会话记忆或全词表注入各自的增益，另一因子在两种水平上各测了一次。',
  '- 报告抬头说"有缺口"时，这批数字**只能在内部看**，别写进论文或宣传。',
  '- 人工修订率 > 20% 时，先修规则或词库再扩量——否则每本书都要花这么多人工。',
  '- 数字要进论文时，标注**快照指纹**（而不是只标"日期"）：换了词表或提示词的两次跑不是同一批。',
  '',
];
mkdirSync(OUT_BASE, { recursive: true });
writeFileSync(mdPath, lines.join('\n'), 'utf-8');

const jsonPath = R.any('运行中间产物', { name: `四格实验_${TAG}` });
writeFileSync(
  jsonPath,
  JSON.stringify(
    {
      schemaVersion: 2,
      书名: P.书名,
      层级: TIER,
      章: CH,
      段数: srcSegs.length,
      运行ID: RUN.runId,
      快照指纹: SNAP.hash,
      快照: snapshotPath,
      原始事件: eventsPath,
      假模型: FAKE || null,
      生成时间: new Date().toISOString(),
      状态: status.state,
      状态原因: status.why,
      结论可用: status.state === '可出结论',
      漂移: drift.drift,
      截断: trunc,
      两轴: axes,
      两轴未出数: axesSkipped,
      追溯: {
        可追溯: traceable.length,
        不可追溯: untraceable.map((t) => ({ 格: t.cell, 指标: t.metric, 原因: t.why })),
        明细: traces.map((t) => ({ 指标: t.metric, 格: t.cell, 运行ID: t.runIds, 事件行: t.eventIds, 可追溯: t.ok })),
      },
      结论: verdict,
      四格: (status.cells ?? []).map((c) => ({
        格: c.metric.label,
        会话: c.metric.session,
        词表: c.metric.vocab,
        段数: c.metric.segments,
        未过门禁: c.needsReview,
        输入词数: c.metric.words,
        生成覆盖率: c.metric.genCoverage,
        最终覆盖率: c.metric.finalCoverage,
        重复注释率: c.metric.duplicateRate,
        人工修订率: c.metric.manualRate,
        调用: c.metric.calls,
        tokens输入: c.metric.tokensIn,
        tokens输出: c.metric.tokensOut,
        缓存命中率: c.metric.cacheHit,
        花费: c.metric.cost,
        首轮缺失: c.metric.firstFallback,
        截断率: c.truncation.rate,
        疑似截断: c.truncation.suspected,
        用量来源: c.usageSource,
        事件行: c.eventIds.length,
      })),
    },
    null,
    2,
  ),
  'utf-8',
);

console.log('\n════ 结论 ════');
console.log(`  状态：${status.state}（${status.why}）`);
for (const v of verdict) console.log(`  ${v}`);
/** 终端只印短原因：完整原因在报告里；刷屏会让人跳过那行最关键的话 */
const brief = (s, n = 100) => (s.length > n ? `${s.slice(0, n)}…` : s);
const show = (metric) => {
  const v = metricValue(status, cellKeyOf(cellSpecs[0]), metric);
  return v.available ? `${(Number(v.value) * 100).toFixed(1)}%` : '不可用';
};
/** 不可用时**只说一次原因**：同一句话印三遍，人就只看第一遍 */
const sample = metricValue(status, cellKeyOf(cellSpecs[0]), '最终覆盖率');
console.log(`  会话+全词表：生成覆盖率 ${show('生成覆盖率')}｜最终覆盖率 ${show('最终覆盖率')}｜截断率 ${show('截断率')}`);
if (!sample.available) console.log(`  ↑ 不可用的原因：${brief(sample.why)}（完整原因见报告）`);
if (trunc.rate === null) console.log('  ⚠ 截断率目前只能报"算不出来"：会话脚本没把 finish_reason 写进日志（见报告里的说明）。');
console.log(`\n✓ ${mdPath}\n✓ ${jsonPath}\n✓ ${snapshotPath}\n✓ ${eventsPath}`);
console.log('\n提醒：实验产物用了 _exp1…_exp4 后缀，正式产物没被动；回到正经生成命令即可。');
