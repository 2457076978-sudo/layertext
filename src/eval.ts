#!/usr/bin/env node
/**
 * LayerText 评测（W1 · 金标准评测集 + 质量基线）
 *
 * 用法：
 *   npm run eval                       # 正式评测：QC 引擎金标准对照 + 与基线对比，报告落盘
 *   npm run eval -- --calibrate        # 标注校准：逐句打印检测明细与 OOV，用于核对/修订金标准
 *   npm run eval -- --update-baseline  # 把当前引擎指标写入 examples/evals/baseline.json（有意变更后）
 *
 * AI 初稿评测（可选）：设置环境变量 LAYERTEXT_API_KEY（OpenAI 兼容；
 * 可选 LAYERTEXT_BASE_URL 默认 https://api.deepseek.com/v1、LAYERTEXT_MODEL 默认 deepseek-chat）。
 * CI 无 key 只跑 QC 模式。
 *
 * 评测集见 examples/evals/<name>/{source.md, proper.txt, golden.json}（全部自写 CC0）。
 * 报告落盘 eval-reports/（已 gitignore）；质量基线 docs/质量基线.md 由人维护、
 * 机器基线存 examples/evals/baseline.json。
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLexicon } from './core/lexicon.js';
import { runQc, type Tier } from './core/qc.js';
import { extractParas, sentsOf, splitChapter } from './core/textpipe.js';
import { sentenceRisks } from './core/risks.js';
import { composePrompt } from './core/aiops.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EVALS_DIR = join(ROOT, 'examples', 'evals');
const REPORTS_DIR = join(ROOT, 'eval-reports');
const BASELINE_PATH = join(EVALS_DIR, 'baseline.json');
const BUNDLED_WORDLIST = join(ROOT, 'assets', 'wordlists', 'curriculum_2022_level3_1600.txt');
const AMENDMENT_WORDLIST = join(ROOT, 'assets', 'wordlists', 'curriculum_2022_amendment.txt');
const PROMPTS_DIR = join(ROOT, 'prompts');

/** 提示词与生产同源（W3）：prompts/ 目录直接读取 */
const PROMPT_BODIES: Record<string, string> = {
  system_simplify: readFileSync(join(PROMPTS_DIR, 'system_simplify.md'), 'utf-8'),
  system_draft: readFileSync(join(PROMPTS_DIR, 'system_draft.md'), 'utf-8'),
};

/** 内置课标词表 + 补录（数词/星期/月份等存档缺失块，见 amendment 文件头注释） */
function bundledWordlistTexts(): string[] {
  const texts = [readFileSync(BUNDLED_WORDLIST, 'utf-8')];
  try {
    texts.push(readFileSync(AMENDMENT_WORDLIST, 'utf-8'));
  } catch {
    /* 无补录文件则只用内置词表 */
  }
  return texts;
}

/** 层级规则（与 app/src/types.ts DEFAULT_TIER_PLANS 默认值保持一致；W3 提示词外置后统一加载） */
const TIERS: Record<Tier, { name: string; maxLen: number; passiveFromCh: number; relclFromCh: number }> = {
  B: { name: 'B（支架）', maxLen: 14, passiveFromCh: 0, relclFromCh: 0 },
  M: { name: 'M（中梯）', maxLen: 16, passiveFromCh: 0, relclFromCh: 0 },
  A: { name: 'A（挑战）', maxLen: 20, passiveFromCh: 5, relclFromCh: 8 },
};

type Cat = 'passive' | 'relcl' | 'pastperf' | 'overlong';
const CATS: Cat[] = ['passive', 'relcl', 'pastperf', 'overlong'];
const CAT_CN: Record<Cat, string> = { passive: '被动', relcl: '定从', pastperf: '过去完成', overlong: '超长(>20词)' };

interface Golden {
  name: string;
  source: string;
  license: string;
  chno?: number;
  desc?: string;
  annotations: Partial<Record<Cat, string[]>>;
  /** 人工核定的 OOV 词型全集（小写去重；相对 内置课标1600 ∪ IRR ∪ proper ∪ 词句卡） */
  oovExpected: string[];
  targets?: Record<
    string,
    {
      avgLenMax: number;
      maxLenMax: number;
      newWordRateMax: number;
      blacklistZero: boolean;
      mustKeep?: string[];
    }
  >;
}

/** 与 sentsOf 相同的归一化（破折号→空格、空白折叠），金标准句子按此对齐 */
function normSent(s: string): string {
  return s
    .replace(/[>—-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

function loadWordFile(p: string): string[] {
  return readFileSync(p, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

interface EvalCase {
  dir: string;
  golden: Golden;
  md: string;
}

function loadCases(): EvalCase[] {
  const cases: EvalCase[] = [];
  for (const ent of readdirSync(EVALS_DIR, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const dir = join(EVALS_DIR, ent.name);
    let golden: Golden;
    try {
      golden = JSON.parse(readFileSync(join(dir, 'golden.json'), 'utf-8')) as Golden;
    } catch {
      continue; // 无金标准的目录（如 baseline.json 所在层）不参与
    }
    cases.push({ dir, golden, md: readFileSync(join(dir, golden.source ?? 'source.md'), 'utf-8') });
  }
  return cases.sort((a, b) => a.dir.localeCompare(b.dir));
}

/* ---------- 引擎金标准对照 ---------- */

interface CatStat {
  annotated: number;
  hits: number;
  misses: string[];
  falsePositives: string[];
}
interface TextStat {
  name: string;
  sentCount: number;
  cats: Record<Cat, CatStat>;
  oov: { expected: string[]; actual: string[]; missed: string[]; extra: string[] };
}

function evalEngineText(c: EvalCase): TextStat {
  const proper = loadWordFile(join(c.dir, 'proper.txt'));
  const lex = buildLexicon({
    plainWordlistTexts: bundledWordlistTexts(),
    properNouns: proper.map((p) => p.toLowerCase()),
  });
  const r = runQc(c.md, lex, {
    tier: 'M',
    chno: c.golden.chno ?? 1,
    ...(proper.length ? { propCheckList: proper } : {}),
    fileName: c.golden.name,
  });

  // 逐句检测（与 qc.ts 共用 sentenceRisks 正则族；overlong 阈值 20 与指标④一致）
  const body = splitChapter(c.md).body;
  const sentences: string[] = [];
  for (const p of extractParas(body)) sentences.push(...sentsOf(p, false));

  const cats = {} as Record<Cat, CatStat>;
  for (const cat of CATS) {
    const annotated = new Set((c.golden.annotations[cat] ?? []).map(normSent));
    const stat: CatStat = { annotated: annotated.size, hits: 0, misses: [], falsePositives: [] };
    for (const sent of sentences) {
      const n = normSent(sent);
      const flagged = sentenceRisks(sent, 20)[cat];
      if (annotated.has(n)) {
        if (flagged) stat.hits++;
        else stat.misses.push(n);
      } else if (flagged) {
        stat.falsePositives.push(n);
      }
    }
    cats[cat] = stat;
  }

  const actual = [...new Set(r.oov)].sort();
  const expected = [...new Set(c.golden.oovExpected.map((w) => w.toLowerCase()))].sort();
  return {
    name: c.golden.name,
    sentCount: sentences.length,
    cats,
    oov: {
      expected,
      actual,
      missed: expected.filter((w) => !actual.includes(w)),
      extra: actual.filter((w) => !expected.includes(w)),
    },
  };
}

/* ---------- AI 初稿评测（可选，需 key）---------- */

function tierRuleLine(tier: Tier, chno: number): string {
  const p = TIERS[tier];
  const passiveOk = tier === 'A' && chno >= p.passiveFromCh;
  const relclOk = tier === 'A' && chno >= p.relclFromCh;
  return `${p.name} 层：平均句长 ≤${p.maxLen} 词；被动语态${passiveOk ? `第 ${p.passiveFromCh} 章起已解禁（本章章号 ${chno}，可少量使用）` : '禁用'}；定语从句${relclOk ? `第 ${p.relclFromCh} 章起已解禁（本章章号 ${chno}，可少量使用）` : '禁用'}；过去完成时一律改写。`;
}

/** 与桌面应用 buildDraftSystemPrompt 同构：system_simplify 规则 + system_draft 任务模板（提示词集 v 见 prompts/manifest.json） */
function buildDraftSystem(tier: Tier, chno: number): string {
  return (
    PROMPT_BODIES.system_simplify.trim() +
    '\n\n' +
    composePrompt(PROMPT_BODIES.system_draft, {
      tierRule: tierRuleLine(tier, chno),
      chnoNote: `（本章章号 ${chno}）`,
      instructions: '',
    })
  );
}

interface AiCall {
  post: (body: unknown) => Promise<{ content: string; promptTokens?: number; completionTokens?: number }>;
}

function makeAiCall(): AiCall | null {
  const key = process.env.LAYERTEXT_API_KEY;
  if (!key) return null;
  const base = (process.env.LAYERTEXT_BASE_URL ?? 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  const model = process.env.LAYERTEXT_MODEL ?? 'deepseek-chat';
  return {
    async post(body) {
      const resp = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, temperature: 0.3, max_tokens: 2500, messages: body }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      const data = (await resp.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      return {
        content: data.choices?.[0]?.message?.content ?? '',
        promptTokens: data.usage?.prompt_tokens,
        completionTokens: data.usage?.completion_tokens,
      };
    },
  };
}

interface AiTextResult {
  name: string;
  tier: Tier;
  metrics: { avgLen: number; maxLen: number; passive: number; relcl: number; pastperf: number; newWordRate: number; mustKeepMissing: string[] };
  checks: Record<string, boolean>;
  allPass: boolean;
}

async function evalAiText(c: EvalCase, tier: Tier, ai: AiCall): Promise<AiTextResult> {
  const proper = loadWordFile(join(c.dir, 'proper.txt'));
  const chno = c.golden.chno ?? 1;
  const system = buildDraftSystem(tier, chno);
  const body = splitChapter(c.md).body;
  const segs = body.match(/\[P\d+\][\s\S]*?(?=\[P\d+\]|$)/g) ?? [];
  const out: string[] = [];
  for (const seg of segs) {
    const { content } = await ai.post([
      { role: 'system', content: system },
      { role: 'user', content: `请简化以下段落：\n${seg.trim()}` },
    ]);
    let t = content
      .trim()
      .replace(/^```[a-z]*\s*/i, '')
      .replace(/```\s*$/, '');
    if (!t.includes('[P')) t = (seg.match(/\[P\d+\]/)?.[0] ?? '') + ' ' + t;
    out.push(t.trim());
  }
  const newMd = `# ${c.golden.name}\n\n## Chapter One\n\n${out.join('\n\n')}\n`;
  const r = runQc(
    newMd,
    buildLexicon({
      plainWordlistTexts: bundledWordlistTexts(),
      properNouns: proper.map((p) => p.toLowerCase()),
    }),
    { tier, chno, fileName: `${c.golden.name}_${tier}` },
  );

  const target = c.golden.targets?.[tier];
  const mustKeep = target?.mustKeep ?? [];
  const text = splitChapter(newMd).body;
  const mustKeepMissing = mustKeep.filter((w) => !text.includes(w));
  const metrics = {
    avgLen: Number(r.avgLenNarrRaw.toFixed(1)),
    maxLen: r.maxLen,
    passive: r.passive,
    relcl: r.relcl,
    pastperf: r.pastperf,
    newWordRate: Number((r.newWordRate * 100).toFixed(1)),
    mustKeepMissing,
  };
  const checks: Record<string, boolean> = target
    ? {
        平均句长: metrics.avgLen <= target.avgLenMax,
        单句最长: metrics.maxLen <= target.maxLenMax,
        黑名单清零: !target.blacklistZero || r.passive + r.relcl + r.pastperf === 0,
        生词率: r.newWordRate <= target.newWordRateMax,
        情节词保留: mustKeep.length === 0 || mustKeepMissing.length === 0,
      }
    : {};
  return { name: c.golden.name, tier, metrics, checks, allPass: Object.values(checks).every(Boolean) };
}

/* ---------- 主流程 ---------- */

interface EngineSummary {
  blacklistAnnotated: number;
  blacklistHits: number;
  missCount: number;
  falsePositiveCount: number;
  hitRate: number;
  oovMissCount: number;
  oovExtraCount: number;
  oovExactTexts: number;
  textCount: number;
}

function summarizeEngine(stats: TextStat[]): EngineSummary {
  const s: EngineSummary = {
    blacklistAnnotated: 0,
    blacklistHits: 0,
    missCount: 0,
    falsePositiveCount: 0,
    hitRate: 0,
    oovMissCount: 0,
    oovExtraCount: 0,
    oovExactTexts: 0,
    textCount: stats.length,
  };
  for (const t of stats) {
    for (const cat of CATS) {
      s.blacklistAnnotated += t.cats[cat].annotated;
      s.blacklistHits += t.cats[cat].hits;
      s.missCount += t.cats[cat].misses.length;
      s.falsePositiveCount += t.cats[cat].falsePositives.length;
    }
    s.oovMissCount += t.oov.missed.length;
    s.oovExtraCount += t.oov.extra.length;
    if (t.oov.missed.length === 0 && t.oov.extra.length === 0) s.oovExactTexts++;
  }
  s.hitRate = s.blacklistAnnotated ? s.blacklistHits / s.blacklistAnnotated : 1;
  return s;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const calibrate = args.includes('--calibrate');
  const updateBaseline = args.includes('--update-baseline');
  const cases = loadCases();
  if (cases.length === 0) {
    console.error('未找到评测集（examples/evals/*/golden.json）');
    process.exit(2);
  }

  const stats = cases.map(evalEngineText);

  if (calibrate) {
    for (const t of stats) {
      console.log(`\n===== ${t.name}（${t.sentCount} 句）=====`);
      for (const cat of CATS) {
        const c = t.cats[cat];
        console.log(`[${CAT_CN[cat]}] 标注 ${c.annotated} · 命中 ${c.hits} · 漏报 ${c.misses.length} · 误报 ${c.falsePositives.length}`);
        for (const m of c.misses) console.log(`  漏报: ${m}`);
        for (const f of c.falsePositives) console.log(`  误报: ${f}`);
      }
      console.log(`[OOV] 期望 ${t.oov.expected.length} · 实际 ${t.oov.actual.length}`);
      for (const m of t.oov.missed) console.log(`  漏报(期望有未测出): ${m}`);
      for (const e of t.oov.extra) console.log(`  多报(未标注却测出): ${e}`);
    }
    return;
  }

  const engine = summarizeEngine(stats);
  const report: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    mode: 'qc',
    engine: { summary: engine, perText: stats },
  };

  // ---- 可选 AI 初稿评测 ----
  const ai = makeAiCall();
  if (ai) {
    console.log('检测到 LAYERTEXT_API_KEY，加跑 AI 初稿评测（3 篇 × 3 层，每层逐段改写）…');
    const aiResults: AiTextResult[] = [];
    for (const c of cases) {
      for (const tier of ['B', 'M', 'A'] as Tier[]) {
        if (!c.golden.targets?.[tier]) continue;
        try {
          aiResults.push(await evalAiText(c, tier, ai));
          console.log(`  ✓ ${c.golden.name} · ${tier} 层完成`);
        } catch (e) {
          console.error(`  ✗ ${c.golden.name} · ${tier} 层失败：${e}`);
        }
      }
    }
    report.mode = 'qc+ai';
    report.ai = {
      perText: aiResults,
      summary: {
        total: aiResults.length,
        allPass: aiResults.filter((x) => x.allPass).length,
      },
    };
  }

  // ---- 基线对比 ----
  let baseline: { generatedAt: string; engine: EngineSummary } | null = null;
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'));
  } catch {
    /* 首次运行无基线 */
  }

  console.log('\n========== 评测汇总（QC 引擎 · 金标准对照）==========');
  for (const t of stats) {
    const catStr = CATS.map((cat) => {
      const c = t.cats[cat];
      return `${CAT_CN[cat]} ${c.hits}/${c.annotated}${c.misses.length || c.falsePositives.length ? `（漏${c.misses.length}/误${c.falsePositives.length}）` : ''}`;
    }).join('  ');
    console.log(`${t.name}：${catStr}  OOV ${t.oov.actual.length} 词（漏${t.oov.missed.length}/多${t.oov.extra.length}）`);
  }
  console.log(
    `黑名单命中率 ${(engine.hitRate * 100).toFixed(1)}%（${engine.blacklistHits}/${engine.blacklistAnnotated}）· 漏报 ${engine.missCount} · 误报 ${engine.falsePositiveCount} · OOV 完全一致 ${engine.oovExactTexts}/${engine.textCount} 篇`,
  );

  if (report.ai) {
    const s = (report.ai as { summary: { total: number; allPass: number } }).summary;
    console.log(`AI 初稿：${s.allPass}/${s.total} 项全达标`);
    for (const r of (report.ai as { perText: AiTextResult[] }).perText) {
      console.log(
        `  ${r.name} · ${r.tier}：${r.allPass ? '✓' : '✗'} 平均${r.metrics.avgLen}词/最长${r.metrics.maxLen}/被${r.metrics.passive}从${r.metrics.relcl}完${r.metrics.pastperf}/生词率${r.metrics.newWordRate}%${r.metrics.mustKeepMissing.length ? `/缺情节词:${r.metrics.mustKeepMissing.join(',')}` : ''}`,
      );
    }
  }

  if (baseline) {
    const b = baseline.engine;
    const deltas: string[] = [];
    if (engine.blacklistHits < b.blacklistHits) deltas.push(`命中率下降 ${engine.blacklistHits}<-${b.blacklistHits}`);
    if (engine.missCount > b.missCount) deltas.push(`漏报上升 ${engine.missCount}>${b.missCount}`);
    if (engine.falsePositiveCount > b.falsePositiveCount) deltas.push(`误报上升 ${engine.falsePositiveCount}>${b.falsePositiveCount}`);
    if (engine.oovMissCount + engine.oovExtraCount > b.oovMissCount + b.oovExtraCount) deltas.push(`OOV 偏差上升`);
    if (deltas.length) {
      console.log(`\n✗ 低于质量基线（${baseline.generatedAt}）：${deltas.join('；')}——详见 --calibrate 明细`);
    } else {
      console.log(`\n✓ 不低于质量基线（${baseline.generatedAt}）`);
    }
    (report as { baselineComparison?: unknown }).baselineComparison = { baselineAt: baseline.generatedAt, regressions: deltas };
  } else {
    console.log('\n（尚无基线——用 npm run eval -- --update-baseline 生成）');
  }

  if (updateBaseline) {
    writeFileSync(BASELINE_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), engine }, null, 1));
    console.log(`基线已更新：${BASELINE_PATH}（记得同步 docs/质量基线.md）`);
  }

  mkdirSync(REPORTS_DIR, { recursive: true });
  const outPath = join(REPORTS_DIR, `评测报告_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 1), 'utf-8');
  console.log(`评测报告已落盘: ${outPath}`);

  if (baseline && !updateBaseline) {
    const reg = (report as { baselineComparison?: { regressions: string[] } }).baselineComparison?.regressions ?? [];
    if (reg.length) process.exit(1);
  }
}

void main();
