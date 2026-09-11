#!/usr/bin/env node
/** AF 加注补齐（把"检测 → 加注"闭环真正闭上）
 *
 * 为什么需要：
 *   2026-09-10 复核发现，产物里的加注**不是检测驱动**的——生成脚本只认"教师知识库 55 个加注词，
 *   见到必须注"，引擎算出的生词率从来不回流。后果是 A 层第 7/8/9 章加注覆盖率只剩 2%：
 *   第七章 255 个生词注了 5 个、第八章 289 注 9、第九章 250 注 3，其余章 62–78%。
 *   报表当时只有"注了多少处"，没有"该注多少"，缺口完全隐形。
 *
 * 本脚本做的事（确定性 + 最少 API）：
 *   QC 逐章算出 annotMissing（该注没注的词型）→ 先查统一词典 → 缺的批量问模型 →
 *   回写词典（跨章同义）→ 在正文首次出现处按 `word（中文）` 插入 → 复算覆盖率。
 *
 * 用法：
 *   node LayerText_AF补注.mjs                      # 三档全章，补到目标覆盖率
 *   node LayerText_AF补注.mjs --tier A --chapters 7,8,9
 *   node LayerText_AF补注.mjs --dry                # 只报告缺口，不调 API、不写文件
 *   node LayerText_AF补注.mjs --target A=85,M=82,B=80 --density 90
 *
 * 目标覆盖率：A 85% / M 82% / B 80%（分层不同：越难的层越要多注）
 * 密度上限：每千词最多注多少词型（默认 90），防止把正文注成花脸。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const SHARED = await import('./LayerText_AF词表与词典.mjs');
const { loadProject, loadLexicon, loadDict, appendDict, loadKbGloss } = SHARED;
const P = loadProject();
const REPO = P.引擎目录;
const OUT_BASE = P.产物目录;
const DATE = P.日期;
const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const MODEL = 'deepseek-chat';
const TAGS = { A: 'A层85', M: 'M层75', B: 'B层60' };

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
  { teacher: TEACHER, tier: TAGS.A },
  { runId: argRun('--run', undefined) },
);
if (RUN.warning) console.warn(`\n⚠ ${RUN.warning}`);
/** 按层级标签取解析器（多层脚本与单层脚本共用同一种写法） */
const RR = (tag) => makeResolver(RUN.layout, { out: OUT_BASE, work: P.调适工作区 }, { runId: RUN.runId, tier: tag, date: DATE });
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);

const tiers = (arg('--tier', 'A,M,B')).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const chapters = arg('--chapters', '')
  ? arg('--chapters').split(',').map(Number)
  : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const DRY = has('--dry');
const DENSITY = Number(arg('--density', '90')); // 每千词最多注多少个词型
/** 候补缓冲：多取这么多个候选词，用来顶替“注不进去”的词 */
const SKIP_BUFFER = 40;
/** 目标覆盖率（已注词型 / 应注词型） */
const TARGET = (() => {
  const def = { A: 0.85, M: 0.82, B: 0.8 };
  const s = arg('--target', '');
  if (!s) return def;
  for (const kv of s.split(',')) {
    const [k, v] = kv.split('=');
    if (TAGS[k]) def[k] = Number(v) / 100;
  }
  return def;
})();

const { runQc } = await import(`${REPO}/dist/src/core/qc.js`);
const LEX = await loadLexicon(P);
const DICT = loadDict(P.词典路径);
const KB = loadKbGloss(P.知识库路径);
const NEVER_ANNOTATE = new Set(['chapter']);
const wc = (t) => (t.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).length;

const CFG = JSON.parse(readFileSync(`${process.env.HOME}/.layertext.json`, 'utf-8'));
const KEY = execSync('security find-generic-password -s layertext.apikey -w').toString().trim();

async function callChat(messages, maxTokens = 2500) {
  const resp = await fetch(`${CFG.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}：${(await resp.text()).slice(0, 200)}`);
  return (await resp.json()).choices?.[0]?.message?.content ?? '';
}

/** 问模型要释义；失败抛错（绝不静默跳过——2026-09-10 的教训） */
async function askGlosses(words) {
  const out = new Map();
  for (let i = 0; i < words.length; i += 60) {
    const chunk = words.slice(i, i + 60);
    const raw = await callChat(
      [
        {
          role: 'system',
          content:
            '你给初中英语教材配生词注释。只输出一个 JSON 对象 {词: 释义}，' +
            '释义 2-6 个汉字，初中生能懂，不要拼音、不要词性标注、不要其他文字。',
        },
        { role: 'user', content: `给这些词配释义：${chunk.join(', ')}` },
      ],
      2000,
    );
    let map;
    try {
      map = JSON.parse(raw.replace(/^[^{]*/, '').replace(/[^}]*$/, ''));
    } catch {
      throw new Error(`模型返回不是合法 JSON（前 120 字）：${raw.slice(0, 120)}`);
    }
    for (const [w, zh] of Object.entries(map)) {
      if (typeof zh === 'string' && /[\u4e00-\u9fff]/.test(zh)) out.set(String(w).toLowerCase(), zh.trim());
    }
  }
  return out;
}

/** 在正文首次出现处插入 `word（中文）`；跳过标题行、已在括号内的词、以及已经注过的词 */
function insertAnnotation(md, word, zh) {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![\\u4e00-\\u9fff)）])\\b${esc}\\b(?![\\u4e00-\\u9fff（])`, 'i');
  const lines = md.split('\n');
  for (let li = 0; li < lines.length; li++) {
    if (/^#/.test(lines[li])) continue;
    const m = lines[li].match(re);
    if (m) {
      lines[li] = lines[li].replace(re, `${m[0]}（${zh}）`);
      return { md: lines.join('\n'), ok: true };
    }
  }
  return { md, ok: false };
}

const results = [];
const failures = [];

for (const tk of tiers) {
  const tag = TAGS[tk];
  for (const i of chapters) {
    const ch = `第${CN[i - 1]}章`;
    const path = RR(tag).any('正文', { chapter: ch });
    try {
      if (!existsSync(path)) throw new Error(`缺产物文件：${path}`);
      let md = readFileSync(path, 'utf-8');
      const before = runQc(md, LEX, { tier: tk, fileName: path.split('/').pop() });
      const words = wc(md.split('## 词句卡')[0]);
      const maxByDensity = Math.floor((words / 1000) * DENSITY);
      const needForTarget = Math.ceil(before.annotatable * TARGET[tk]) - before.annotated;
      const budget = Math.max(0, Math.min(needForTarget, maxByDensity - before.annotated));

      const freq = new Map();
      for (const w of before.oov) freq.set(w, (freq.get(w) ?? 0) + 1);
      const ranked = before.annotMissing
        .filter((w) => !NEVER_ANNOTATE.has(w))
        // 知识库白名单（教师已确认学生不会）最优先；其余按文中出现频次降序——先注最常见的
        .sort((a, b) => {
          const ka = KB.has(a) ? 1 : 0;
          const kb = KB.has(b) ? 1 : 0;
          if (ka !== kb) return kb - ka;
          const f = (freq.get(b) ?? 0) - (freq.get(a) ?? 0);
          return f !== 0 ? f : a.localeCompare(b);
        });
      const picked = ranked.slice(0, budget + SKIP_BUFFER);

      const fromDict = new Map();
      const needAsk = [];
      for (const w of picked) {
        const g = DICT.get(w) ?? KB.get(w)?.zh;
        if (g) fromDict.set(w, g);
        else needAsk.push(w);
      }

      let asked = new Map();
      if (needAsk.length && !DRY) asked = await askGlosses(needAsk);

      let added = 0;
      const newEntries = [];
      for (const [w, zh] of [...fromDict, ...asked]) {
        if (DRY) break;
        const r = insertAnnotation(md, w, zh);
        if (r.ok) {
          md = r.md;
          added++;
          if (!DICT.has(w)) newEntries.push([w, zh]);
        }
      }
      if (added) {
        // 注释右括号后补空格，否则 "sleet（雨夹雪)and" 这类粘连会留给读者
        md = md.replace(/([）)])(?=[A-Za-z])/g, '$1 ').replace(/ {2,}/g, ' ');
        writeFileSync(path, md, 'utf-8');
        appendDict(newEntries, P.词典路径);
        for (const [w, zh] of newEntries) DICT.set(w, zh);
      }

      const after = runQc(md, LEX, { tier: tk, fileName: path.split('/').pop() });
      results.push({
        tk, ch, before, after, words,
        picked: picked.length, fromDict: fromDict.size, asked: asked.size, added,
        budget, capped: needForTarget > budget,
      });
      console.log(
        `${tk} ${ch}  覆盖率 ${(before.annotationCoverage * 100).toFixed(0)}% → ${(after.annotationCoverage * 100).toFixed(0)}%` +
        `（${after.annotated}/${after.annotatable}）  本次注 ${added}` +
        `（词典 ${fromDict.size} + 模型 ${asked.size}）${DRY ? '  [--dry]' : ''}`,
      );
    } catch (e) {
      failures.push({ tk, ch, msg: e instanceof Error ? e.message : String(e) });
      console.error(`✗ ${tk} ${ch}：${failures[failures.length - 1].msg}`);
    }
  }
}

console.log('\n| 层 | 章 | 应注 | 已注(前) | 已注(后) | 覆盖率(前→后) | 本次注 | 词典命中 | 问模型 | 受密度限 |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
for (const r of results) {
  console.log(
    `| ${r.tk} | ${r.ch} | ${r.after.annotatable} | ${r.before.annotated} | ${r.after.annotated} | ` +
    `${(r.before.annotationCoverage * 100).toFixed(0)}% → ${(r.after.annotationCoverage * 100).toFixed(0)}% | ` +
    `${r.added} | ${r.fromDict} | ${r.asked} | ${r.capped ? '是' : ''} |`,
  );
}

const low = results.filter((r) => r.after.annotationCoverage < TARGET[r.tk] - 0.02);
if (low.length) {
  console.log(`\n⚠ 仍有 ${low.length} 个章次未达目标（受密度上限 ${DENSITY}/千词 限制）：`);
  for (const r of low) console.log(`   ${r.tk} ${r.ch}：${(r.after.annotationCoverage * 100).toFixed(0)}% < ${(TARGET[r.tk] * 100).toFixed(0)}%`);
}
if (failures.length) {
  console.error(`\n✗ ${failures.length} 个章次失败：`);
  for (const f of failures) console.error(`   ${f.tk} ${f.ch}：${f.msg}`);
  process.exit(1);
}
console.log(`\n✓ ${results.length} 个章次处理完成${DRY ? '（--dry，未写文件、未调 API）' : ''}`);
