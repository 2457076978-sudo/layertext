#!/usr/bin/env node
/** AF 段级风险队列：把"从第一段读到第 245 段"换成"只看机器点名的地方"
 *
 * 为什么要有它（2026-09-11 审查报告 §一）：
 *   人工校正的 7 小时里，绝大部分花在了机器早已确定性判定为没问题的段落上。
 *   报告给的判断是：数字/日期/专名只有 5–10% 需要人看，OOV 漏注 10–20%，句法 10–15%，
 *   而情节事实/因果/语气必须抽查。**按段顺序呈现 = 把预算花在低风险段上**，这是流程缺陷。
 *
 * 本脚本把段级门禁（引擎 src/core/segmentgate.ts + riskqueue.ts）跑在**已产出的书稿**上，
 * 产出一份按 风险 = 概率 × 后果 排序的清单：事实差异置顶 → 漏注与超长 → 低风险语言润色。
 * 每项都给：原句 / 改写句 / 上下文各一句 / 触发规则号 / 风险分 / 一键决策按钮所需的一切。
 *
 * 用法：
 *   node LayerText_AF风险队列.mjs --tier A                    # 全部章节（默认章数）
 *   node LayerText_AF风险队列.mjs --tier A,M --chapters 7     # 指定章节
 *   node LayerText_AF风险队列.mjs --tier A --out 试跑          # 与试跑产物同名后缀
 *   node LayerText_AF风险队列.mjs --tier A --budget 30        # 改人工预算（默认 60 分钟）
 *
 * 产物：
 *   产物目录/风险队列_<层>_<日期>.md          —— 人看的清单（勾选式）
 *   产物目录/_运行/风险队列_<层>.json         —— App 阅读器与离线汇总器读的机器格式
 *
 * 退出码：0（队列是给人看的，不是门禁）。唯一例外：连产物都读不到 → 2。
 *         "这段能不能算完成"由 LayerText_AF会话改写.mjs 的门禁负责，这里不重复判。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SHARED = await import('./LayerText_AF词表与词典.mjs');
const P = SHARED.loadProject();
const REPO = P.引擎目录;
const SRC_BASE = P.原文目录;
const OUT_BASE = P.产物目录;
const DATE = P.日期;
const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const TAGS = { A: 'A层85', M: 'M层75', B: 'B层60' };
const TIER_INFO = {
  A: { label: 'A 层（挑战）', ratio: 0.85, maxLen: 20 },
  M: { label: 'M 层（中梯）', ratio: 0.75, maxLen: 16 },
  B: { label: 'B 层（支架）', ratio: 0.6, maxLen: 14 },
};

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);
const TIERS = (arg('--tier', 'A')).split(',').map((s) => s.trim().toUpperCase()).filter((t) => TIER_INFO[t]);
const SUFFIX = arg('--out', '') ? '_' + arg('--out') : '';
const BUDGET = Number(arg('--budget', '60'));
const BASELINE = P.情节底线 ?? '调适工作区/规则与底线/全书情节底线_v0.1.md';
const CH_IDS = arg('--chapters', '')
  ? arg('--chapters').split(',').map((x) => Number(x.trim())).filter((n) => n >= 1 && n <= 10)
  : CN.slice(0, Number(P.章数 ?? 10)).map((_, i) => i + 1);

if (!TIERS.length) { console.error('✗ --tier 只能是 A / M / B 的组合'); process.exit(2); }

const { gateSegment, GATE_RULES } = await import(`${REPO}/dist/src/core/segmentgate.js`);
const { buildRiskQueue, oneHourPlan } = await import(`${REPO}/dist/src/core/riskqueue.js`);
const { parsePlotBaseline, plotLine } = await import(`${REPO}/dist/src/core/plotweight.js`);
const { actionOf } = await import(`${REPO}/dist/src/core/riskaction.js`);
const { parseDoc } = await import(`${REPO}/dist/src/core/docast.js`);
const { runQc } = await import(`${REPO}/dist/src/core/qc.js`);
const LEX = await SHARED.loadLexicon(P);
const DICT = SHARED.loadDict(P.词典路径);
const { segmentList } = SHARED;
const { makeResolver, dirOfPath } = await import(`${REPO}/dist/src/core/manifest.js`);
const wc = (t) => (t.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).length;

const warnings = [];
/** 该段应注的超纲词（与生成脚本同一口径：OOV 去重、去两字母词）。
 *  没有可切分句子的段（插图占位、纯符号行、门禁留下的占位注释）**不是错误**——
 *  但也不能静默跳过：记一条 warning 并计数（审查报告 §三第②条：不许 catch{} 吞错）。 */
const oovOf = (seg) => {
  const md = `## Chapter One\n\n${seg}\n`;
  try {
    return [...new Set(runQc(md, LEX, { tier: 'M', fileName: 'seg.md', dict: DICT }).oov)].filter((w) => w.length > 2);
  } catch (e) {
    warnings.push(`跳过一个切不出句子的段（${(e instanceof Error ? e.message : String(e)).slice(0, 40)}）：${seg.trim().slice(0, 60)}`);
    return [];
  }
};

/** 运行身份 + 路径解析：与命令行其它脚本、App 面板共用**同一个** `readRunIdentity`
 *  （报告 §三：「都只能通过 manifest 解析路径」——谁自己拼字符串、谁自己读指针，
 *   谁就是下一个撞名点/身份被换掉的入口）。 */
const TEACHER = arg('--teacher', process.env.LAYERTEXT_TEACHER ?? process.env.USER ?? 'unknown');
const RUN = await SHARED.readRunIdentity({ out: OUT_BASE, work: P.调适工作区 }, { teacher: TEACHER, tier: TAGS[TIERS[0]] ?? TIERS[0] }, { runId: arg('--run', undefined) });
if (RUN.warning) console.warn(`\n⚠ ${RUN.warning}`);
console.log(`运行身份：${RUN.source}｜${RUN.teacher}｜${RUN.runId || '（无）'}`);
const R = makeResolver(RUN.layout, { out: OUT_BASE, work: P.调适工作区 }, { runId: RUN.runId, tier: TAGS[TIERS[0]] ?? TIERS[0], date: DATE });

console.log('════ AF 段级风险队列 ════');
console.log(`项目：${P._meta?.名称 ?? '（未命名）'}｜书名：${P.书名}`);
console.log(`层级：${TIERS.join('/')}｜章节：${CH_IDS.join(',')}｜人工预算：${BUDGET} 分钟｜路径布局：${RUN.layout}`);

const allSegments = [];
const unfinished = [];
const unreadable = [];
/** 章 → 产物绝对路径。**由生产者记下来**：App 面板要按它改稿，
 *  而面板不知道产物命名里的日期/后缀，只能猜——猜错的后果是"改到了不存在的文件"或"改错文件"。 */
const chapterArtifacts = {};

for (const tier of TIERS) {
  const info = TIER_INFO[tier];
  const tag = TAGS[tier];
  for (const ci of CH_IDS) {
    const ch = `第${CN[ci - 1]}章`;
    const srcPath = join(SRC_BASE, ch, '原文_规范化.md');
    const outPath = makeResolver(RUN.layout, { out: OUT_BASE, work: P.调适工作区 }, { runId: RUN.runId, tier: tag, date: DATE, suffix: SUFFIX }).any('正文', { chapter: ch });
    if (!existsSync(srcPath)) { unreadable.push(`${ch}：缺规范化原文`); continue; }
    if (!existsSync(outPath)) { unreadable.push(`${ch}：缺 ${tag} 产物（先去生成）`); continue; }
    const srcSegs = segmentList(readFileSync(srcPath, 'utf-8'));
    const outMd = readFileSync(outPath, 'utf-8');
    const outById = new Map(segmentList(outMd).map((s) => [s.id, s.text]));

    /* 结构类检查（报告 §四：内部转 AST，避免正则在连字符/多义词/嵌套标记上失真）。
     * 放在逐段门禁之前：段标记一旦缺失/重复/跳号，**这一章所有按标记配对的对照都是错的**，
     * 先把它顶到队列最前面，人才不会拿着错位的对照白看一遍。 */
    const ast = parseDoc(outMd);
    const AST_RULE = { 'marker-missing': 'AST-01', 'marker-duplicate': 'AST-01', 'marker-gap': 'AST-01', 'sense-conflict': 'AST-02', 'annotation-unclosed': 'AST-03', 'annotation-nested': 'AST-03' };
    for (const issue of ast.issues) {
      const ruleId = AST_RULE[issue.kind];
      if (!ruleId) continue;
      const segIdx = Math.max(0, ast.segments.findIndex((x) => x.id === issue.segId));
      allSegments.push({
        book: P.书名, tier, chapter: ch, segIndex: segIdx,
        source: ast.segments[segIdx]?.raw ?? '',
        rewritten: ast.segments[segIdx]?.raw ?? '',
        problems: [{
          ruleId,
          category: GATE_RULES[ruleId].category,
          severity: GATE_RULES[ruleId].severity,
          weight: GATE_RULES[ruleId].weight,
          risk: Number((GATE_RULES[ruleId].weight * GATE_RULES[ruleId].probability).toFixed(2)),
          message: issue.message,
          detail: { ...(issue.detail ?? {}), kind: issue.kind, needsHuman: issue.needsHuman },
        }],
      });
    }
    srcSegs.forEach((s, k) => {
      const rewritten = outById.get(s.id);
      // 产物里没有这一段 = 生成时门禁未通过、被隔离了。它不是"待判定"，是"未完成"。
      if (!rewritten || /<!--\s*本段未通过复检/.test(rewritten)) {
        unfinished.push({ tier, chapter: ch, segId: s.id, segIndex: k, source: s.text.trim() });
        return;
      }
      const target = Math.round(wc(s.text) * info.ratio);
      const oov = [...new Set([...oovOf(s.text), ...oovOf(rewritten)])];
      const v = gateSegment({ text: rewritten, source: s.text, target, maxLen: info.maxLen, oov, dict: DICT });
      chapterArtifacts[ch] = outPath;
      allSegments.push({
        book: P.书名, tier, chapter: ch, segIndex: k,
        source: s.text, rewritten, problems: v.problems,
      });
    });
  }
}

/* 情节先验（审查报告 v4_方向）：**只做同风险档内的 tie-breaker，不能升级为 blocker**。
 * 底线文件里的英文引用（教师写了"这几句必须原样保留"的那些）+ 专名表 = 可逐字对齐的素材；
 * 教师还能在底线里写一行 `锚点：windmill、gun` 补上机器猜不到的东西（象征物通常不在专名表里）。 */
const baselinePath = P.工作区 ? join(P.工作区, BASELINE) : '';
let plot;
if (baselinePath && existsSync(baselinePath)) {
  const baseline = parsePlotBaseline(readFileSync(baselinePath, 'utf-8'), P.PROPER, baselinePath);
  const segCounts = {};
  for (const s of allSegments) segCounts[s.chapter] = Math.max(segCounts[s.chapter] ?? 0, s.segIndex + 1);
  plot = { baseline, segCountOf: (ch) => segCounts[ch] ?? 1 };
  console.log(`情节先验：底线锚点 ${baseline.anchors.length} 个、专名 ${baseline.names.length} 个（只做同风险档内的排序，不拦截）`);
} else {
  console.log('情节先验：未找到情节底线文件 —— 信号缺席（**没算**，不是低）');
}
const queue = buildRiskQueue(allSegments, plot);
const plan = oneHourPlan(queue, BUDGET);

/* ────────────────────── 人看的清单（Markdown） ────────────────────── */
const CAT_ORDER = ['事实', '格式', '加注', '语言'];
const lines = [
  `# ${P.书名} · 段级风险队列`,
  '',
  `生成：${new Date().toLocaleString('zh-CN')}｜层级：${TIERS.map((t) => TIER_INFO[t].label).join(' / ')}｜章节：${CH_IDS.join(',')}`,
  `排序口径：**风险 = 概率 × 后果**（${Object.values(GATE_RULES).map((r) => `${r.label} ${(r.weight * r.probability).toFixed(1)}`).join('，')}）`,
  '',
  '> 「级别」是**规则级别**（约束"生成时能不能算完成"）；本层权威的"没做完"信号是上面那张未完成段落表。',
  '> 拿旧流水线的产物用新门禁重扫时，长度类规则会成片命中——那是**待判断**的偏差，不是废弃。',
  '',
  '## 先看这里',
  '',
  `- 队列共 **${queue.summary.total}** 条（其中不可完成 ${queue.summary.blockers} 条），估时 **${queue.summary.estimatedMinutes} 分钟**`,
  `- 分类：${Object.entries(queue.summary.byCategory).map(([k, v]) => `${k} ${v}`).join('，')}`,
  `- ${plan.advice}`,
  '',
  '### 一小时最短路径',
  '',
  '| 阶段 | 分钟 | 条数 | 做什么 |',
  '|---|---:|---:|---|',
  ...plan.phases.map((p) => `| ${p.title} | ${p.budget} | ${p.items.length} | ${p.note} |`),
  '',
];

if (unfinished.length) {
  lines.push(
    `## ⚠ 未完成段落 ${unfinished.length} 段（生成时门禁未通过、已隔离，不在正文里）`,
    '',
    '这些不是"待判断"，是**必须重跑或人工补写**的段落——本项目不把它们算作完成。',
    '',
    '| 位置 | 原文开头 |',
    '|---|---|',
    ...unfinished.slice(0, 60).map((u) => `| ${u.chapter} ${u.segId}（第${u.segIndex + 1}段） | ${u.source.replace(/^\[P\d+\]\s*/, '').slice(0, 60)}… |`),
    '',
    `重跑：同一条生成命令加 \`--resume\`（未通过的段不在 done 里，会被重跑）。隔离副本在 \`产物目录/_待复核/${TAGS[TIERS[0]]}${SUFFIX}/\`。`,
    '',
  );
}

for (const cat of CAT_ORDER) {
  const items = queue.items.filter((i) => i.category === cat);
  if (!items.length) continue;
  lines.push(`## ${cat}类 ${items.length} 条`, '');
  for (const [n, it] of items.entries()) {
    lines.push(
      `### ${n + 1}. [${it.ruleId}·${it.severity === 'blocker' ? '不可完成' : '待判断'}·风险 ${it.risk}] ${it.title}`,
      '',
      `- 位置：${it.segLabel}${it.tier ? `（${it.tier} 层）` : ''}`,
      `- 原文：${it.sourceSentence || '（未定位到原句）'}`,
      `- 改写：${it.rewrittenSentence || '（改写里找不到）'}`,
      `- 上下文：上「${it.context.prev || '—'}」／下「${it.context.next || '—'}」`,
      `- ${plotLine(it.plot)}`,   // 情节先验：给等级也给依据（只影响排序，不拦任何东西）
      // 决策栏的文案**跟着规则走**（报告 v4_方向第 2 条：十条规则不能共用三个统一键）
      `- 决策：☐ ${actionOf(it.ruleId).label}  ☐ 退回重写  ☐ 标记误报    理由：________________`,
      `  （${actionOf(it.ruleId).effect}）`,
      '',
    );
  }
}
if (!queue.items.length && !unfinished.length) lines.push('## ✓ 队列为空', '', '本层没有任何机器能点出来的风险，可直接抽样阅读。', '');
if (unreadable.length) {
  lines.push('## 读不到的文件', '', ...unreadable.map((u) => `- ${u}`), '');
}

/* 人读的 Markdown 报告也走解析器。它是**另一个产物**（队列 JSON 在 `_运行/`，报告在产物根），
 * 所以按 `汇总报告` 取；带 `--out` 后缀时同样带上，否则两次试跑会互相覆盖。 */
const mdPath = makeResolver(RUN.layout, { out: OUT_BASE, work: P.调适工作区 }, {
  runId: RUN.runId,
  tier: TAGS[TIERS[0]] ?? TIERS[0],
  date: DATE,
  suffix: SUFFIX,
}).any('汇总报告', { name: `风险队列_${TAGS[TIERS[0]]}${TIERS.length > 1 ? '_等' : ''}` });
mkdirSync(dirOfPath(mdPath), { recursive: true });
writeFileSync(mdPath, lines.join('\n'), 'utf-8');

/* ────────────────────── 机器看的格式（App 阅读器 / 离线汇总器） ────────────────────── */
const jsonPath = R.any('风险队列', { ext: '.json' });
mkdirSync(dirname(jsonPath), { recursive: true });
writeFileSync(
  jsonPath,
  JSON.stringify(
    {
      schemaVersion: 1,
      书名: P.书名,
      层级: TIERS,
      章节: CH_IDS,
      生成时间: new Date().toISOString(),
      规则表: GATE_RULES,
      摘要: queue.summary,
      一小时路径: { 预算: BUDGET, 超预算: plan.overBudget, 建议: plan.advice, 阶段: plan.phases.map((p) => ({ id: p.id, title: p.title, budget: p.budget, count: p.items.length, note: p.note })) },
      未完成段落: unfinished,
      章节产物: chapterArtifacts,
      队列: queue.items,
    },
    null,
    2,
  ),
  'utf-8',
);

/* 队列构成：先说清楚"不可完成"是什么意思，免得教师被一个大数字吓到。
 * 严重度是**规则级别**——它约束的是"生成这一层时能不能算完成"；
 * 而"未完成段落"（生成时门禁真的拦下来的那些）才是权威的"没做完"信号。
 * 把旧流水线产出的稿子拿新门禁重扫，LEN-01 会成片命中（它是**待判断**的长度偏差），
 * 不解释清楚就会被误读成"这本书全是废的"。 */
if (queue.summary.total) {
  console.log('\n队列构成（按规则）：');
  for (const [rule, n] of Object.entries(queue.summary.byRule).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${rule} ${GATE_RULES[rule]?.label ?? ''}：${n} 条（级别：${GATE_RULES[rule]?.severity === 'blocker' ? '不可完成' : '待判断'}）`);
  }
  console.log('  说明：「不可完成」是**规则级别**（约束生成时能否算完成）；权威的"没做完"信号是上面的「未完成段落」。');
  console.log('        拿旧流水线的产物用新门禁重扫时，长度类规则会成片命中——那是待判断的偏差，不是废弃。');
}

if (warnings.length) {
  console.warn(`\n⚠ ${warnings.length} 个段落切不出句子（已跳过，不计入覆盖率）：`);
  for (const w of warnings.slice(0, 5)) console.warn(`   ${w}`);
}
console.log(`\n队列 ${queue.summary.total} 条（不可完成 ${queue.summary.blockers}）｜未完成段落 ${unfinished.length} 段｜估时 ${queue.summary.estimatedMinutes} 分钟`);
if (queue.summary.total) {
  console.log('排在最前面的 5 条：');
  for (const it of queue.items.slice(0, 5)) console.log(`  [${it.risk}] ${it.segLabel} ${it.title}`);
}
if (has('--strict') && (unfinished.length || queue.summary.total)) process.exit(1);
console.log(`\n✓ ${mdPath}`);
console.log(`✓ ${jsonPath}`);
if (unreadable.length) {
  console.error(`\n✗ ${unreadable.length} 个文件读不到：`);
  for (const u of unreadable.slice(0, 10)) console.error(`   ${u}`);
  process.exit(2);
}
