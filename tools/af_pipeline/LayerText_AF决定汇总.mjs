#!/usr/bin/env node
/** AF 决定汇总：把教师在风险队列上的决定，变成**待人工确认的入库提议**
 *
 * 审查报告 §一：「离线汇总器再把『采纳过的释义』提议进词典、『误报』提议进词表例外、
 * 『同类改写』提议进改写模板；**任何入库都要人工确认**。」
 *
 * 这个脚本**从不改任何库**——它只写一份提议清单给人看。教师确认后，
 * 用 `--apply <提议序号>` 才真正落库（且逐条落、逐条留痕）。
 *
 * 用法：
 *   node LayerText_AF决定汇总.mjs                       # 汇总并打印提议（默认层）
 *   node LayerText_AF决定汇总.mjs --tier A --min-support 2
 *   node LayerText_AF决定汇总.mjs --apply 1,3           # 只把第 1、3 条提议落库（需人明确指定）
 *   node LayerText_AF决定汇总.mjs --dry                 # 不写文件，只看
 *   node LayerText_AF决定汇总.mjs --about windmill      # 查询「某位教师对某词的所有决定」
 *   node LayerText_AF决定汇总.mjs --about windmill --teacher wayne
 *   node LayerText_AF决定汇总.mjs --by-rule             # 按规则看采纳/误报分布
 *
 * 决定日志（append-only JSONL，一行一条不可变事件）：
 *   调适工作区/_决定/<层>.jsonl
 * 提议清单：
 *   产物目录/_运行/入库提议_<层>.md / .json
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SHARED = await import('./LayerText_AF词表与词典.mjs');
const { distOf } = SHARED;
const P = SHARED.loadProject();
const REPO = P.引擎目录;
const OUT_BASE = P.产物目录;
const TAGS = { A: 'A层85', M: 'M层75', B: 'B层60' };

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);

const { buildProposals, parseDecisionLog, summarizeDecisions, contestedItems, PROPOSAL_LABEL } =
  await import(`${distOf(REPO)}/src/core/decision.js`);
/** SQLite 决定索引：JSONL 仍是正本，索引随时可重建（报告 §四：查询"某位教师对某词的所有决定"）。
 *  拿不到 node:sqlite 时自动降级为"不可用"，查询回落 JSONL 全扫。 */
const { openDecisionStore } = await import(`${distOf(REPO)}/src/core/decisiondb.js`);
const { productMetrics } = await import(`${distOf(REPO)}/src/core/productmetrics.js`);
const { makeResolver } = await import(`${distOf(REPO)}/src/core/manifest.js`);
const { atomicWriteFileSync: writeAtomic } = await import(`${distOf(REPO)}/src/core/files.js`);
/* 正文与产物一律**原子写**（先写同目录临时文件再 rename）。
 * writeFileSync 的语义是「截断 → 写」，中途失败会留下**半份正文**——
 * 对教师唯一的一份稿，半份比没有更糟：没有你知道丢了，半份看起来像改坏了，
 * 而它其实已经被毁掉了。rename 在同一文件系统内是原子的：要么旧内容、要么新内容。 */


/* 运行身份走**共享的那一个**解析入口（与其它脚本、App 面板同一条规则）。 */
/* 身份从命令行取。**刻意不复用各脚本自己的参数助手**：它们的定义位置各不相同
 * （有的还是 `args.includes` 风格），在这一段引用会在定义之前求值。 */
const argRun = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const TEACHER = argRun('--teacher', process.env.LAYERTEXT_TEACHER ?? process.env.USER ?? 'unknown');
const RUN = await SHARED.readRunIdentity(
  { out: P.产物目录, work: P.调适工作区 },
  { teacher: TEACHER, tier: TAGS[TIERS[0]] ?? TIERS[0] },
  { runId: argRun('--run', undefined) },
);
if (RUN.warning) console.warn(`\n⚠ ${RUN.warning}`);
const resolveDecision = (tag) => makeResolver(RUN.layout, { out: P.产物目录, work: P.调适工作区 }, { runId: RUN.runId, tier: tag }).decision();
/* 本脚本也会写产物（入库提议），所以还需要一个**默认层**的解析器 */
const R = makeResolver(RUN.layout, { out: OUT_BASE, work: P.调适工作区 }, { runId: RUN.runId, tier: TAGS[TIERS[0]] ?? TIERS[0] });

const DECISION_DIR = join(P.调适工作区, '_决定');   // 索引与落库留痕仍在调适工作区（跟运行无关）
const INDEX_PATH = join(DECISION_DIR, '决定索引.db');

/* ────────────────────── 读取全部决定（跨层合并统计） ────────────────────── */
const TIERS = (arg('--tier', 'A')).split(',').map((s) => s.trim().toUpperCase()).filter((t) => TAGS[t]);
const allEvents = [];
const perTier = {};
let badLines = 0;
for (const t of TIERS) {
  const f = resolveDecision(TAGS[t]);
  if (!existsSync(f)) { perTier[TAGS[t]] = { events: 0, file: f, missing: true }; continue; }
  const r = parseDecisionLog(readFileSync(f, 'utf-8'));
  badLines += r.badLines;
  perTier[TAGS[t]] = { events: r.events.length, file: f, missing: false };
  allEvents.push(...r.events);
}

/** 把 JSONL 正本灌进索引（幂等）。日志永远优先——索引可以随时删掉重建。 */
function refreshIndex(events) {
  const store = openDecisionStore(INDEX_PATH);
  if (!store.available) return null;
  store.ingest(events);
  return store;
}

/* ────────────────────── 查询模式（报告点名的那一句） ────────────────────── */
const ABOUT = arg('--about', '');
const BY_RULE = has('--by-rule');
if (ABOUT || BY_RULE) {
  const store = refreshIndex(allEvents);
  if (!store) {
    console.error('✗ 拿不到 node:sqlite（需要 Node 22.5+），索引不可用。');
    console.error('  功能不缺席：用 --about 时脚本会回落到"JSONL 全扫"。');
  }
  console.log('════ AF 决定查询 ════');
  console.log(`索引：${INDEX_PATH}${store ? '' : '（不可用，回落 JSONL 全扫）'}｜正本：${allEvents.length} 条事件`);
  const who = arg('--teacher', '');
  if (ABOUT) {
    const rows = store ? store.decisionsAbout(ABOUT, who || undefined) : allEvents.filter((e) => (e.subject?.value ?? '').toLowerCase() === ABOUT.toLowerCase() && (!who || e.teacherId === who));
    console.log(`\n「${ABOUT}」的全部决定${who ? `（教师 ${who}）` : ''}：${rows.length} 条`);
    if (!rows.length) console.log('  （没有——这个词还没被决定过）');
    for (const r of rows.slice(0, 50)) {
      console.log(`  ${r.timestamp.slice(0, 16).replace('T', ' ')} ${r.teacherId} [${r.ruleIds}] ${r.decision}`);
      console.log(`     ${r.before.slice(0, 70)} → ${r.after.slice(0, 70)}`);
    }
    const byWord = store ? store.decisionsAbout(ABOUT) : [];
    const teachers = [...new Set((store ? byWord : allEvents).map((r) => r.teacherId))];
    if (teachers.length > 1) console.log(`  （${teachers.length} 位教师对这个词做过决定：${teachers.join('、')}）`);
  }
  if (BY_RULE) {
    const rows = store ? store.byRule() : [];
    console.log('\n按规则：');
    for (const r of rows) console.log(`  ${r.ruleId}：${r.total} 条，其中误报 ${r.falsePositive}（${r.total ? ((r.falsePositive / r.total) * 100).toFixed(0) : 0}%）`);
    if (!rows.length) console.log('  （还没有决定）');
  }
  console.log('\n索引是派生视图：删掉它不影响任何事实，下次跑本脚本会自动重建。');
  process.exit(0);
}

console.log('════ AF 决定汇总 ════');
console.log(`项目：${P._meta?.名称 ?? '（未命名）'}｜书名：${P.书名}`);
for (const [tag, s] of Object.entries(perTier)) {
  console.log(`  ${tag}：${s.missing ? '暂无决定日志' : `${s.events} 条决定`}  ${s.file}`);
}
if (badLines) console.warn(`⚠ 决定日志里有 ${badLines} 行读不出来（已跳过，不静默丢弃计数）`);
if (!allEvents.length) {
  console.log('\n还没有任何教师决定——先在 App 的风险队列里做几条，再回来汇总。');
  process.exit(0);
}

const stat = summarizeDecisions(allEvents);
const proposalStore = refreshIndex(allEvents);
if (proposalStore) console.log(`决定索引已更新：${proposalStore.count()} 行 → ${INDEX_PATH}`);
const proposals = buildProposals(allEvents, { minSupport: Number(arg('--min-support', '2')) });
const contested = contestedItems(allEvents);

console.log(`\n决定 ${stat.total} 条｜误报率 ${(stat.falsePositiveRate * 100).toFixed(1)}%（规则噪音水平的直接度量）｜教师：${stat.teachers.join('、')}`);
console.log('分布：' + Object.entries(stat.byDecision).map(([k, v]) => `${k} ${v}`).join('，'));
/* 可观测产品指标（v4 报告「系统性偏差」）：不要只报"机器做了什么"，还要报"教师那边结果如何" */
const pm = productMetrics(allEvents);
console.log('\n──── 产品指标（量教师那边）────');
for (const n of pm.notes) console.log(`  ${n}`);
console.log('按规则：' + Object.entries(stat.byRule).map(([k, v]) => `${k} ${v}`).join('，'));
if (contested.length) console.log(`⚠ ${contested.length} 个项目被反复改主意（说明规则或词条本身有问题）：${contested.slice(0, 5).map((c) => c.itemId).join('、')}`);

/* ────────────────────── 提议清单 ────────────────────── */
const lines = [
  `# ${P.书名} · 入库提议（待人工确认）`,
  '',
  `生成：${new Date().toLocaleString('zh-CN')}｜层级：${TIERS.join('/')}｜依据 ${stat.total} 条教师决定`,
  '',
  `误报率 **${(stat.falsePositiveRate * 100).toFixed(1)}%**（规则噪音水平的直接度量）｜被反复改主意的项 ${contested.length} 个`,
  '',
  '## 产品指标（量教师那边，不是量机器）',
  '',
  ...pm.notes.map((n) => `- ${n}`),
  '',
  '',
  '> **本清单只提议、不入库。** 确认后才执行：`node LayerText_AF决定汇总.mjs --apply <序号>`。',
  '> 原因是报告 §一 的明文要求：任何入库都要人工确认——否则一次误判就会被固化成全书的规则。',
  '',
];

if (!proposals.length) {
  lines.push('## 暂无提议', '', '同类决定还不够多（默认至少 2 条才提议）。继续在风险队列里做决定即可。', '');
} else {
  for (const [i, p] of proposals.entries()) {
    lines.push(
      `## ${i + 1}. [${PROPOSAL_LABEL[p.kind]}] ${p.key}${p.value ? ` → ${p.value}` : ''}`,
      '',
      `- 依据：${p.reason}`,
      `- 支持度：${p.count} 条｜相关规则：${p.ruleIds.join('、') || '—'}`,
      '- 证据：',
      ...p.evidence.map((e) => `  - ${e.timestamp.slice(0, 16).replace('T', ' ')} ${e.teacherId}：${e.before.trim().slice(0, 60)} → ${e.after.trim().slice(0, 60)}`),
      `- 确认：☐ 入库  ☐ 暂不  ☐ 需要改（改成：____________）`,
      '',
    );
  }
}
if (contested.length) {
  lines.push('## ⚠ 被反复改主意的项（建议先修规则或词条，而不是继续人工判）', '', '| 项 | 改过几种决定 |', '|---|---:|', ...contested.slice(0, 40).map((c) => `| ${c.itemId} | ${c.flips} |`), '');
}

if (!has('--dry')) {
  mkdirSync(R.dir('运行中间产物'), { recursive: true });
  const proposeName = `入库提议_${TAGS[TIERS[0]]}`;
  writeAtomic(R.any('运行中间产物', { name: proposeName, ext: '.md' }), lines.join('\n'), 'utf-8');
  writeFileSync(
    R.any('运行中间产物', { name: proposeName }),
    JSON.stringify({ schemaVersion: 1, 生成时间: new Date().toISOString(), 决定统计: stat, 产品指标: pm, 反复改主意: contested, 提议: proposals }, null, 2),
    'utf-8',
  );
  console.log(`\n✓ ${R.any('运行中间产物', { name: proposeName, ext: '.md' })}`);
}

/* ────────────────────── 落库（必须显式指定序号） ────────────────────── */
const apply = arg('--apply', '');
if (!apply) {
  if (proposals.length) console.log(`\n有 ${proposals.length} 条提议待确认。确认后：--apply 1,2（逐条落库、逐条留痕）`);
  process.exit(0);
}

const picked = apply.split(',').map((x) => Number(x.trim())).filter((n) => n >= 1 && n <= proposals.length);
if (!picked.length) { console.error(`✗ --apply 给不出有效序号（本层共 ${proposals.length} 条提议）`); process.exit(2); }
if (!has('--yes')) {
  console.error(`\n即将落库 ${picked.length} 条提议：`);
  for (const i of picked) console.error(`  ${i}. [${PROPOSAL_LABEL[proposals[i - 1].kind]}] ${proposals[i - 1].key} → ${proposals[i - 1].value}`);
  console.error('\n这会改动项目词库/词典，属于不可自动回滚的操作。确认无误请加 --yes 重跑。');
  process.exit(2);
}

const teacher = arg('--teacher', process.env.LAYERTEXT_TEACHER ?? process.env.USER ?? 'unknown');
const applied = [];
for (const i of picked) {
  const p = proposals[i - 1];
  if (p.kind === 'dict-entry') {
    const added = SHARED.appendDict([[p.key, p.value]], P.词典路径);
    applied.push(`${p.key} → ${p.value}（词典${added ? '新增' : '已存在'}）`);
  } else if (p.kind === 'kb-exception') {
    // 词表例外：写进专名表同级的例外文件（不碰知识库本体，避免一次误判改正文口径）
    const exPath = join(P.调适工作区, '规则与底线', '词表例外.txt');
    mkdirSync(join(P.调适工作区, '规则与底线'), { recursive: true });
    appendFileSync(exPath, `${p.key}\t${new Date().toISOString().slice(0, 10)}\t${teacher}\t误报×${p.count}\n`, 'utf-8');
    applied.push(`${p.key}（词表例外 → ${exPath}）`);
  } else {
    // 改写模板：只写进待并入模板的清单，提示词由人确认后改
    const tplPath = join(P.调适工作区, '规则与底线', '改写模板_待并入.md');
    mkdirSync(join(P.调适工作区, '规则与底线'), { recursive: true });
    appendFileSync(tplPath, `\n## ${p.key}（教师直改 ×${p.count}）\n${p.value}\n`, 'utf-8');
    applied.push(`模板 ${p.key}（→ ${tplPath}，提示词需人工并入）`);
  }
  // 落库本身也留痕：谁在什么时候把哪条提议写进了哪里
  mkdirSync(DECISION_DIR, { recursive: true });
  appendFileSync(
    join(DECISION_DIR, '_入库.jsonl'),
    JSON.stringify({ schemaVersion: 1, proposalIndex: i, kind: p.kind, key: p.key, value: p.value, teacherId: teacher, timestamp: new Date().toISOString() }) + '\n',
    'utf-8',
  );
}
console.log('\n✓ 已落库：');
for (const a of applied) console.log(`   ${a}`);
console.log('  （落库留痕：调适工作区/_决定/_入库.jsonl）');
