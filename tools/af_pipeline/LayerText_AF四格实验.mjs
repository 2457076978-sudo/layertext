#!/usr/bin/env node
/** AF 四格实验：把「2%→98%」拆成可归因的单因子增益
 *
 * 审查报告 §二：「2%→98% 的实验不能归因：一次同时改变了词表注入、会话记忆、查词和复检，
 * 且只有 31 段。至少做四格实验：独立调用/会话 × 有无全词表，固定温度和同一章；
 * 报告生成覆盖率、最终覆盖率、重复注释率、人工修订率和 token 成本。」
 *
 * 它做的事：同一章、同一模型、同一温度（0.3），只动两个因子，跑四遍，然后并排比。
 *   · 会话记忆：一条会话走完（`--scope tier`） vs 每段独立调用（`--scope segment`）
 *   · 全词表注入：开场给全词表（`--vocab full`） vs 只给"该注哪些词"（`--vocab lite`）
 *
 * 用法：
 *   node LayerText_AF四格实验.mjs --tier A --chapters 2            # 真跑（**消耗 API 额度**：4 遍）
 *   node LayerText_AF四格实验.mjs --tier A --chapters 2 --fake exact   # 自检（不调 API，验证实验台本身）
 *   node LayerText_AF四格实验.mjs --tier A --chapters 2 --dry      # 只打印计划
 *
 * 产物：
 *   产物目录/四格实验_<层>_<日期>.md        人看的对照表与结论
 *   产物目录/_运行/四格实验_<层>.json       机器格式（论文里引用数字用这份）
 *
 * 注意：四格实验会**覆盖同名产物**，所以每格都带独立后缀（`_exp1`…`_exp4`），
 * 不碰你正在用的正式产物。跑完记得回来跑一次正式生成。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHARED = await import('./LayerText_AF词表与词典.mjs');
const P = SHARED.loadProject();
const REPO = P.引擎目录;
const SRC_BASE = P.原文目录;
const OUT_BASE = P.产物目录;
const DATE = P.日期;
const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const TAGS = { A: 'A层85', M: 'M层75', B: 'B层60' };

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);
const TIER = (arg('--tier', 'A')).split(',')[0].trim().toUpperCase();
if (!TAGS[TIER]) { console.error(`✗ 未知层级「${TIER}」`); process.exit(2); }
const { makeResolver } = await import(`${REPO}/dist/src/core/manifest.js`);
/* ── 路径一律经清单解析（总计划阶段 3「最关键的迁移」）─────────────────────
 * 「把路径解析集中到一个 `Resolver`，**禁止业务代码拼目录**」。
 * 本脚本原来用 `join(OUT_BASE, ch, `原文_${tag}_${DATE}.md`)` 这类手拼——
 * legacy 布局下逐字符正确，`--layout run` 下**写在一处、读又从另一处读**，
 * 而脚本照常报告成功（这类"不报错、结果错"正是这个规模崩点的样子）。
 * 命名规则的唯一来源是 `src/core/manifest.ts` 的 `resolvePath`。
 * 身份也走共享的那一个入口：两位教师并发时不再互相读到对方的 runId。 */
/* 身份从命令行取。**刻意不复用各脚本自己的参数助手**：它们的定义位置各不相同
 * （有的还是 `args.includes` 风格），在这一段引用会在定义之前求值。 */
const argRun = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const TEACHER = argRun('--teacher', process.env.LAYERTEXT_TEACHER ?? process.env.USER ?? 'unknown');
const RUN = await SHARED.readRunIdentity(
  { out: OUT_BASE, work: P.调适工作区 },
  { teacher: TEACHER, tier: TAG },
  { runId: argRun('--run', undefined) },
);
if (RUN.warning) console.warn(`\n⚠ ${RUN.warning}`);
/** 按层级标签取解析器（多层脚本与单层脚本共用同一种写法） */
const RR = (tag) => makeResolver(RUN.layout, { out: OUT_BASE, work: P.调适工作区 }, { runId: RUN.runId, tier: tag, date: DATE });
const R = RR(TAG);
const TAG = TAGS[TIER];
const CH = Number(arg('--chapters', '1').split(',')[0]);
const FAKE = arg('--fake', '');

const { experimentPlan, measureCell, compareCells, experimentVerdict, segmentFirstResponses } =
  await import(`${REPO}/dist/src/core/experiment.js`);
const { segmentList } = SHARED;
const { runQc } = await import(`${REPO}/dist/src/core/qc.js`);
const LEX = await SHARED.loadLexicon(P);
const DICT = SHARED.loadDict(P.词典路径);

const oovOf = (text) => {
  const md = `## Chapter One\n\n${text}\n`;
  return [...new Set(runQc(md, LEX, { tier: TIER, fileName: 'seg.md', dict: DICT }).oov)].filter((w) => w.length > 2);
};

const ch = `第${CN[CH - 1]}章`;
const srcPath = join(SRC_BASE, ch, '原文_规范化.md');
if (!existsSync(srcPath)) { console.error(`✗ 缺规范化原文：${srcPath}`); process.exit(2); }
const srcSegs = segmentList(readFileSync(srcPath, 'utf-8'));

console.log('════ AF 四格实验 ════');
console.log(`项目：${P._meta?.名称 ?? '（未命名）'}｜书：${P.书名}｜层：${TIER}｜章：${ch}（${srcSegs.length} 段）`);
console.log('因子：会话记忆（一条会话 / 每段独立）× 全词表注入（给全表 / 只给该注的词）');
console.log(`固定项：模型与温度与正式生成一致（temperature 0.3）、同一章、同一词表快照${FAKE ? `｜⚠ 自检假模型：${FAKE}` : ''}`);
console.log('\n计划：');
experimentPlan().forEach((c, i) => console.log(`  ${i + 1}. ${c.label}  ——  --scope ${c.scope} --vocab ${c.vocabArg}`));
if (has('--dry')) { console.log('\n（--dry，未执行）'); process.exit(0); }
if (!FAKE) {
  console.log(`\n⚠ 这会真跑 4 遍（消耗 API 额度）。产物后缀 _exp1…_exp4，不碰正式产物。`);
}

/* ────────────────────── 逐格跑 ────────────────────── */
const cells = [];
const cellsRaw = [];
for (const [i, spec] of experimentPlan().entries()) {
  const suffix = `exp${i + 1}`;
  console.log(`\n──────── 第 ${i + 1} 格：${spec.label} ────────`);
  const env = { ...process.env, LAYERTEXT_ENGINE: REPO };
  if (FAKE) env.LAYERTEXT_FAKE_LLM = FAKE;
  const r = spawnSync(
    process.execPath,
    [join(HERE, 'LayerText_AF会话改写.mjs'), '--tier', TIER, '--chapters', String(CH), '--scope', spec.scope, '--vocab', spec.vocabArg, '--out', suffix],
    { stdio: 'inherit', env, cwd: process.cwd() },
  );
  // 非零退出**不中止实验**：未通过门禁的段本身就是"人工修订率"要测的东西
  if (r.status !== 0) console.log(`（本格退出码 ${r.status}：有段落未过门禁，这正是要测的指标之一）`);

  const outFile = R.any('正文', { chapter: ch, suffix: `_${suffix}` });
  const finals = new Map(segmentList(existsSync(outFile) ? readFileSync(outFile, 'utf-8') : '').map((s) => [s.id, s.text]));
  const logPath = R.session({ scope: spec.scope, vocab: spec.vocabArg, suffix: `_${suffix}` });
  const firsts = existsSync(logPath) ? segmentFirstResponses(readFileSync(logPath, 'utf-8')) : new Map();
  let usage = { calls: 0, in: 0, out: 0, cached: 0 };
  let needsReview = 0;
  if (existsSync(logPath)) {
    for (const line of readFileSync(logPath, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.t === 'stats' && o.v) usage = o.v;
      if (o.t === 'review') needsReview++;
    }
  }
  const segments = srcSegs.map((s, k) => ({
    id: s.id,
    chapter: ch,
    source: s.text,
    final: finals.get(s.id),
    first: firsts.get(`${ch}#${k}`),
  }));
  const input = { spec, tier: TIER, segments, oovOf, dict: DICT, usage, needsReview };
  const metric = measureCell(input);
  cells.push(metric);
  cellsRaw.push({
    格: spec.label,
    会话: spec.session,
    词表: spec.vocab,
    段数: metric.segments,
    未过门禁: needsReview,
    输入词数: metric.words,
    生成覆盖率: metric.genCoverage,
    最终覆盖率: metric.finalCoverage,
    重复注释率: metric.duplicateRate,
    人工修订率: metric.manualRate,
    调用: metric.calls,
    tokens输入: metric.tokensIn,
    tokens输出: metric.tokensOut,
    缓存命中率: metric.cacheHit,
    花费: metric.cost,
    首轮缺失: metric.firstFallback,
  });
  console.log(`  → 生成覆盖率 ${(metric.genCoverage * 100).toFixed(1)}%｜最终覆盖率 ${(metric.finalCoverage * 100).toFixed(1)}%｜重复注释 ${(metric.duplicateRate * 100).toFixed(1)}%｜人工修订 ${(metric.manualRate * 100).toFixed(1)}%｜¥${metric.cost.toFixed(3)}`);
}

/* ────────────────────── 报告 ────────────────────── */
const verdict = experimentVerdict(cells);
const lines = [
  `# ${P.书名} · 四格实验（${TIER} 层 ${ch}）`,
  '',
  `生成：${new Date().toLocaleString('zh-CN')}｜段数：${srcSegs.length}｜模型：${P.模型 ?? 'deepseek-chat'}（温度 0.3）｜词表快照见产物目录/_运行/LexiconSnapshot.json`,
  '',
  '## 为什么要四格',
  '',
  '「2%→98%」这类数字如果一次同时改了词表注入、会话记忆、查词与复检，就没法归因——',
  '换个条件就复现不出来。这里**只动两个因子**，固定模型、温度与章节，逐格对照。',
  '',
  '## 对照表',
  '',
  compareCells(cells),
  '',
  '> 生成覆盖率 = 模型**第一次**写出来的正文里该注的词注出比例；',
  '> 最终覆盖率 = 过门禁落盘产物里的加注覆盖率（含复检回流与本地去重）。',
  '> 两者的差 = 流水线（复检回流 + 去重 + 补注）的贡献，不是提示词的贡献。',
  '',
  '## 结论',
  '',
  ...verdict.map((v) => `- ${v}`),
  '',
  '## 每一格的一句话',
  '',
  ...cells.map((c) => `- **${c.label}**：${c.segments} 段，生成 ${(c.genCoverage * 100).toFixed(1)}% → 最终 ${(c.finalCoverage * 100).toFixed(1)}%（提升 ${c.coverageGain}pp），重复注释 ${(c.duplicateRate * 100).toFixed(1)}%，人工修订 ${(c.manualRate * 100).toFixed(1)}%，${c.calls} 次调用 ¥${c.cost.toFixed(3)}`),
  '',
  '## 怎么用这份结果',
  '',
  '- 只引用**单因子**那一行：会话记忆或全词表注入各自的增益，另一因子在两种水平上各测了一次。',
  '- 人工修订率 > 20% 时，先修规则或词库再扩量——否则每本书都要花这么多人工。',
  '- 数字要进论文时，标注词表快照版本与提示词版本（运行清单里有）。',
  '',
];

mkdirSync(OUT_BASE, { recursive: true });
const mdPath = R.any('汇总报告', { name: `四格实验_${TAG}` });
writeFileSync(mdPath, lines.join('\n'), 'utf-8');
mkdirSync(R.dir('运行中间产物'), { recursive: true });
const jsonPath = R.any('运行中间产物', { name: `四格实验_${TAG}` });
writeFileSync(
  jsonPath,
  JSON.stringify({ schemaVersion: 1, 书名: P.书名, 层级: TIER, 章: CH, 段数: srcSegs.length, 假模型: FAKE || null, 生成时间: new Date().toISOString(), 结论: verdict, 四格: cellsRaw }, null, 2),
  'utf-8',
);

console.log('\n════ 结论 ════');
for (const v of verdict) console.log(`  ${v}`);
console.log(`\n✓ ${mdPath}`);
console.log(`✓ ${jsonPath}`);
console.log('\n提醒：实验产物用了 _exp1…_exp4 后缀，正式产物没被动；回到正经生成命令即可。');
