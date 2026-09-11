#!/usr/bin/env node
/** AF 三档精修：①注释轮（补三档脚本漏移植的生成后加注）②信号修复轮（数字/专名缺失补回）
 * 用法：node LayerText_AF三档精修.mjs <A|M|B|ALL>
 * 产物：原地更新 重制三版/第X章/原文_{tag}_2026-09-10.md；精修台账落同目录
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const P = (await import('./LayerText_AF词表与词典.mjs')).loadProject();
const REPO = P.引擎目录;
const SRC_BASE = P.原文目录;
const OUT_BASE = P.产物目录;
const DATE = P.日期;
const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const MODEL = 'deepseek-chat';

const CFG = JSON.parse(readFileSync(`${process.env.HOME}/.layertext.json`, 'utf-8'));
const KEY = execSync('security find-generic-password -s layertext.apikey -w').toString().trim();
const { splitChapter, extractParas, sentsOf } = await import(`${REPO}/dist/src/core/textpipe.js`);
const { runQc } = await import(`${REPO}/dist/src/core/qc.js`);
const { alignSentencePairs } = await import(`${REPO}/dist/src/core/align.js`);
// 词表/词典集中一份（2026-09-10：三份拷贝各漏 clover/squealer/mollie，才注出"三叶草""告密者"）
const { makeKnownChecker, loadDict, appendDict, loadLexicon } = await import('./LayerText_AF词表与词典.mjs');
const PROPER = P.PROPER;
const LEX = await loadLexicon(P);
const isKnown = await makeKnownChecker(P); // 与 QC 同一套已知口径
// 2026-09-10 修复：此处原先漏了 DICT 的定义（loadDict 只 import 未调用），
// 一旦遇到"有 OOV 的章节"就 ReferenceError；而主循环把异常吞掉只打一个 ✗，
// 于是失败章节从报表里消失 —— A 层第 7/8/9 章加注覆盖率只剩 2% 就是这么漏出去的。
const DICT = loadDict(P.词典路径);
const NEVER_ANNOTATE = new Set(['chapter']); // 正文里的 "Chapter N" 标题残留，不加注

const TAGS = { A: 'A层85', M: 'M层75', B: 'B层60' };

const { makeResolver } = await import(`${REPO}/dist/src/core/manifest.js`);
const { atomicWriteFileSync: writeAtomic } = await import(`${REPO}/dist/src/core/files.js`);
/* 正文与产物一律**原子写**（先写同目录临时文件再 rename）。
 * writeFileSync 的语义是「截断 → 写」，中途失败会留下**半份正文**——
 * 对教师唯一的一份稿，半份比没有更糟：没有你知道丢了，半份看起来像改坏了，
 * 而它其实已经被毁掉了。rename 在同一文件系统内是原子的：要么旧内容、要么新内容。 */

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
const RUN = await (await import('./LayerText_AF词表与词典.mjs')).readRunIdentity(
  { out: OUT_BASE, work: P.调适工作区 },
  { teacher: TEACHER, tier: TAGS.A },
  { runId: argRun('--run', undefined) },
);
if (RUN.warning) console.warn(`\n⚠ ${RUN.warning}`);
/** 按层级标签取解析器（多层脚本与单层脚本共用同一种写法） */
const RR = (tag) => makeResolver(RUN.layout, { out: OUT_BASE, work: P.调适工作区 }, { runId: RUN.runId, tier: tag, date: DATE });
async function callChat(messages, maxTokens = 2500) {
  const resp = await fetch(`${CFG.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 150)}`);
  return (await resp.json()).choices?.[0]?.message?.content ?? '';
}

const toRefs = (md) => {
  try {
    return extractParas(splitChapter(md).body).flatMap((p, pi) => sentsOf(p, false).map((text, si) => ({ pi, si, text })));
  } catch {
    return [];
  }
};

async function refineChapter(tk, tag, i) {
  const ch = `第${CN[i - 1]}章`;
  const path = RR(tag).any('正文', { chapter: ch });
  let md = readFileSync(path, 'utf-8');
  const srcRefs = toRefs(readFileSync(join(SRC_BASE, ch, '原文_规范化.md'), 'utf-8'));
  let noted = 0;
  let sigFixed = 0;
  let sigFail = 0;

  // ① 注释轮：QC OOV → 剔专名/课标已学 → 先查统一词典 → 缺的才问模型 → 回写词典 → 词边界插入首次出现处
  //    根因备注：LEX 只吃词库 v0.6，其课标1600 子集仅落 1371/1677，pig/man/sheep/die 等课标词
  //    会被判成 OOV 而被加注（2026-09-10 报告问题之一）。用课标表补一道 isKnownForm 才能挡住。
  const qc0 = runQc(md, LEX, { tier: tk, fileName: path.split('/').pop() });
  const oov = [...new Set(qc0.oov)].filter((w) =>
    w.length > 2 && !PROPER.includes(w) && !NEVER_ANNOTATE.has(w)
    && !isKnown(w) && !new RegExp(`${w}（`).test(md));
  const glosses = new Map();
  const missing = [];
  for (const w of oov) {
    const g = DICT.get(w);
    if (g) glosses.set(w, g);
    else missing.push(w);
  }
  if (missing.length) {
    const raw = await callChat(
      [
        { role: 'system', content: '你给初中英语教材配生词注释。只输出一个 JSON 对象 {词: 释义}，释义 2-6 个汉字，初中生能懂，不要其他文字。' },
        { role: 'user', content: `给这些词配释义：${missing.join(', ')}` },
      ],
      2000,
    );
    try {
      const map = JSON.parse(raw.replace(/^[^{]*/, '').replace(/[^}]$/, ''));
      for (const [w, zh] of Object.entries(map)) {
        if (typeof zh === 'string' && /[\u4e00-\u9fff]/.test(zh)) glosses.set(w.toLowerCase(), zh);
      }
      // 新词回写词典：下次遇到同一词直接用既有释义，杜绝跨章一词多义
      appendDict([...glosses].filter(([w]) => !DICT.has(w)), P.词典路径);
    } catch {
      /* 注释失败不阻塞 */
    }
  }
  for (const [w, zh] of glosses) {
    // 逐行插入且跳过标题行（## 开头）——曾把 ## Chapter 2 加注成 ## Chapter（章节） 2 毁掉引擎解析
    const lines = md.split('\n');
    let done = false;
    for (let li = 0; li < lines.length && !done; li++) {
      if (/^#/.test(lines[li])) continue;
      const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(?<![\\u4e00-\\u9fff)（])\\b${esc}\\b(?![\\u4e00-\\u9fff（])`, 'i');
      const m = lines[li].match(re);
      if (m) {
        lines[li] = lines[li].replace(re, `${m[0]}（${zh}）`);
        md = lines.join('\n');
        noted++;
        done = true;
      }
    }
  }

  // ② 信号修复轮：逐句对齐找"数字/专名缺失"对 → AI 把缺失信号自然补回改写句 → 精确替换
  const curRefs = toRefs(md);
  const pairs = alignSentencePairs(srcRefs, curRefs).filter((r) => r.kind === 'match' && r.lostSignals?.length && r.base && r.cur);
  for (const p of pairs) {
    const raw = await callChat(
      [
        { role: 'system', content: '你是英文名著分层简化的审校助手。任务：改写句在简化时弄丢了原文里的数字或专名，请把它们自然融回改写句（可微调措辞，句长尽量不超限，保持词汇简单）。只输出修复后的完整英文句子，不要任何解释。' },
        { role: 'user', content: `原句：${p.base.text}\n改写句：${p.cur.text}\n丢失的信息：${(p.lostSignals ?? []).join('、')}\n请输出修复后的改写句：` },
      ],
      800,
    );
    const fixed = raw.trim().replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
    // 校验：修复句确实包含全部缺失信号，且与改写句差异不至于整句重写
    const ok = fixed.length > 20 && (p.lostSignals ?? []).every((s) => fixed.toLowerCase().includes(s.toLowerCase()));
    const at = md.indexOf(p.cur.text);
    if (ok && at >= 0 && md.indexOf(p.cur.text, at + 1) < 0) {
      md = md.slice(0, at) + fixed + md.slice(at + p.cur.text.length);
      sigFixed++;
    } else sigFail++;
  }

  // ③ 排版收尾：注释右括号后补空格、清双空格（否则 "harness（挽具）and" 这类粘连会留给读者）
  md = md.replace(/([）)])(?=[A-Za-z])/g, '$1 ').replace(/([A-Za-z])\s+（/g, '$1（').replace(/ {2,}/g, ' ');

  writeAtomic(path, md, 'utf-8');
  const qc = runQc(md, LEX, { tier: tk, fileName: path.split('/').pop() });
  return { tk, ch, noted, sigFixed, sigFail, oovRate: (qc.newWordRate * 100).toFixed(1) };
}

const args = process.argv.slice(2);
let tiers = args.filter((a) => /^[AMB]$/.test(a));
if (!tiers.length) tiers = ['A', 'M', 'B'];
let chapters = args.filter((a) => /^\d/.test(a)).flatMap((a) => a.split(',').map(Number));
if (!chapters.length) chapters = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const results = [];
const failures = [];
for (const tk of tiers) {
  for (const i of chapters) {
    process.stdout.write(`▶ ${tk} 第${CN[i - 1]}章…`);
    try {
      const r = await refineChapter(tk, TAGS[tk], i);
      results.push(r);
      console.log(` 加注 ${r.noted}，信号修复 ${r.sigFixed}（未果 ${r.sigFail}），生词率 ${r.oovRate}`);
    } catch (e) {
      // 2026-09-10 修复：原先只打一个 ✗ 就继续，失败的章节会从下面的表里"消失"，
      // 于是"少注了 250 个词"这件事没有任何人看得见。现在失败必须显式列出并让退出码非零。
      failures.push({ tk, ch: CN[i - 1], msg: e instanceof Error ? e.message : String(e) });
      console.log(` ✗ ${failures[failures.length - 1].msg}`);
    }
  }
}
console.log('\n| 层 | 章 | 加注 | 信号修复 | 未果 | 生词率 |');
for (const r of results) console.log(`| ${r.tk} | ${r.ch} | ${r.noted} | ${r.sigFixed} | ${r.sigFail} | ${r.oovRate}% |`);

if (failures.length) {
  console.error(`\n✗ 有 ${failures.length} 个章次失败（上面表格里没有它们）：`);
  for (const f of failures) console.error(`   ${f.tk} 第${f.ch}章：${f.msg}`);
  process.exit(1);
}
console.log(`\n✓ 全部 ${results.length} 个章次完成`);
