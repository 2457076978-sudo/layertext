#!/usr/bin/env node
/** AF 三档重制生成（Wayne 拍板 2026-09-10）：三版篇幅=原文 85%/75%/60%，审校知识库注入
 * 用法：node LayerText_AF三档生成.mjs <A|M|B|ALL> [章号如1或1,2 或空=全部] [--dry]
 * 产物：调适工作区/重制三版/第X章/原文_{层}{比例}_{日期}.md
 * 知识库：知识文件/AF审校知识库_v1.csv（55 加注词对=学生不会的词须加注；36 换词倾向=优先避开/换简单说法）
 */
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const SHARED = await import('./LayerText_AF词表与词典.mjs');
const { distOf } = SHARED;
const P = SHARED.loadProject();
const { loadLexicon } = SHARED;
const REPO = P.引擎目录;
const SRC_BASE = P.原文目录; // 规范化原文（245 段）所在
const OUT_BASE = P.产物目录;
const KB = P.知识库路径;
const DATE = P.日期;

const MODEL = 'ecnu-plus'; // ChatECNU（2026-09-12 起 Wayne 指定；OpenAI 兼容端点，key 在钥匙串 layertext.ecnukey）
const CFG = { baseUrl: 'https://chat.ecnu.edu.cn/open/api/v1' }; // 不读 ~/.layertext.json：那是 App 的 AI 设置，脚本管线与 App 各用各的
const KEY = execSync('security find-generic-password -s layertext.ecnukey -w').toString().trim();
const { splitChapter } = await import(`${distOf(REPO)}/src/core/textpipe.js`);
const { runQc } = await import(`${distOf(REPO)}/src/core/qc.js`);
// 词表 + 本书专名（专名不计 OOV）——2026-09-10：原先只喂词库，Napoleon 等被算成生词
const LEX = await loadLexicon(P);

/* 章节名从共享模块取（**不再在 10 个脚本里各抄一份 `['一'…'十']`**）：
 * 那份抄写写死了"十章"，换一本 12 章的书会拼出 `第undefined章` 而**照常报成功**。
 * 现在优先级是「配置 > 原文目录 > 默认（第N章 × 章数）」，
 * 最后那层逐字符复现旧行为，所以既没配置、也没有可扫目录的老项目结果不变。 */
const CN = SHARED.chapterNames(P);
const wc = (t) => (t.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).length;

/** 三档：比例=占原文词数百分比；maxLen=分层句长（2026-09-12 Wayne"学生没有预想的强"难度下移：A20→17、M16→15）；retryLine=段级重试线 */
const TIERS = {
  A: { key: 'A', label: 'A层（挑战）', ratio: 0.85, maxLen: 17, retryLine: 0.73, clsTag: 'A层85' },
  M: { key: 'M', label: 'M层（中层）', ratio: 0.75, maxLen: 15, retryLine: 0.63, clsTag: 'M层75' },
  B: { key: 'B', label: 'B层（基础）', ratio: 0.6, maxLen: 14, retryLine: 0.48, clsTag: 'B层60' },
};

const { makeResolver, dirOfPath } = await import(`${distOf(REPO)}/src/core/manifest.js`);
const { atomicWriteFileSync: writeAtomic } = await import(`${distOf(REPO)}/src/core/files.js`);
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
const RUN = await SHARED.readRunIdentity(
  { out: OUT_BASE, work: P.调适工作区 },
  { teacher: TEACHER, tier: TIERS.A.clsTag },
  { runId: argRun('--run', undefined) },
);
if (RUN.warning) console.warn(`\n⚠ ${RUN.warning}`);
/** 按层级标签取解析器（多层脚本与单层脚本共用同一种写法） */
const RR = (tag) => makeResolver(RUN.layout, { out: OUT_BASE, work: P.调适工作区 }, { runId: RUN.runId, tier: tag, date: DATE });
const R = RR(TIERS.A.clsTag);
/* ---------- 知识库 ---------- */
const kbNotes = new Map(); // word → 释义（教师认可的加注对，过滤"复现"等非释义值）
const kbSwaps = [];
{
  const rows = readFileSync(KB, 'utf-8').replace(/^\uFEFF/, '').split('\n').slice(1);
  for (const line of rows) {
    const [type, word, val, n] = line.split(',');
    if (!word) continue;
    if (type === '加注词' && val && val !== '复现') kbNotes.set(word.toLowerCase(), { zh: val, n: Number(n) || 1 });
    else if (type === '换词倾向') kbSwaps.push([word, Number(n) || 1]);
  }
}
const NOTE_TABLE = [...kbNotes.entries()]
  .sort((a, b) => b[1].n - a[1].n)
  .slice(0, 120) // system 预算：top 120（按出现频次）
  .map(([w, v]) => `${w}（${v.zh}）`)
  .join('、');
const SWAP_TABLE = kbSwaps.slice(0, 36).map(([w]) => w).join('、');

const PROPER = P.PROPER;

function systemPrompt(t) {
  return `你是初中英语原著分层简化的审校助手（${t.label}）。词汇边界：优先用《义务教育英语课程标准》三级（约1600词）；专有名词不变。

【篇幅守恒（本次任务核心）】改写=同义转换，不是压缩删减：细节、修饰、氛围描写一律保留转述，只换学生能懂的说法。本档目标：全篇词数约为原文的 ${Math.round(t.ratio * 100)}%——每段输出词数应约为该段原文的 ${Math.round(t.ratio * 100)}%（允差 ±10 个百分点）。
${t.key === 'B' ? '- B 档允许适度删减次要细节与重复描写（情节与因果零丢失），词汇换成最基础的说法，优先压低生词率。\n' : ''}${t.key === 'A' ? '- A 档贴原文**转述**（篇幅与情节贴原文），但词汇向课标换写：超出课标的实词**优先换成课标词或常见说法**，只在换掉会损失关键语义时才保留并加注，且每段保留的加注词不超过 2 个。（2026-09-12 定：学生没有预想的强，A 档不再是"保留难词靠注释"。）\n' : ''}${t.key === 'M' ? '- M 档词汇**全部落在课标内**（专有名词除外）：超纲实词一律换写；确属无法替换的关键词才保留并加注，每段最多 1 个。\n' : ''}
【句法黑名单（引语内原话除外）】被动→主动；定语从句→拆短句或形容词前置；过去完成→一般过去时+before/after 明示先后。直接引语只降词不降句式（引号原样保留）。情节零丢失。

【教师审校知识库（历史成果，必须遵守）】
1. 以下词经教师确认为学生不会的词——若在改写中保留，必须紧跟 word（中文）格式加注，释义沿用：
${NOTE_TABLE}
2. 以下词教师曾多次换掉——改写时优先换简单说法或删减改述，不要原样保留：${SWAP_TABLE}

【加注要求（2026-09-10 补：加注必须是"检测驱动"的，不能只注上面那张白名单）】
3. 凡是**超出初中生已学范围**的实词（名词/动词/形容词/副词），在**首次出现处**紧跟 word（中文）加注；
   常见的基础词（数词、星期、月份、a/the/is/have 这类）不要注，人名地名不加注。
4. 同一个词全篇只注一次（首次出现处），同一个词只用同一个释义。
5. 后续还有一道"补注"工序会按质检结果补齐漏注，所以你宁可多注几个，也不要为了省事漏注。

输出：保持输入段落的 [P##] 标记原样开头，直接输出该段简化文本（纯英文），除 word（中文）注释外禁止任何中文。不要任何解释。`;
}

async function callChat(messages, maxTokens = 2500) {
  const body = (extra) => JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages, ...extra });
  const resp = await fetch(`${CFG.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: body({}),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  return (data.choices?.[0]?.message?.content ?? '').trim();
}

const cleanSeg = (text, marker) => {
  let t = text.trim().replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '');
  if (!t.includes('[P')) t = marker + ' ' + t;
  return t.trim();
};

async function runChapter(i, t) {
  const ch = CN[i - 1];
  const src = join(SRC_BASE, ch, '原文_规范化.md');
  if (!existsSync(src)) throw new Error(`${ch} 缺规范化原文`);
  const md = readFileSync(src, 'utf-8');
  const chLine = md.match(/^## Chapter \w+.*$/m)?.[0] ?? `## Chapter ${['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'][i - 1]}`;
  const header = md.slice(0, md.indexOf(chLine)) || '';
  const segs = splitChapter(md).body.match(/\[P\d+\][\s\S]*?(?=\[P\d+\]|$)/g) ?? [];
  if (!segs.length) throw new Error(`${ch} 未找到 [P##] 段落`);
  const system = systemPrompt(t);
  const out = [];
  let retried = 0;
  for (let k = 0; k < segs.length; k++) {
    const srcW = wc(segs[k]);
    const prevTail = out.length ? out[out.length - 1].slice(-500) : '（本章开头）';
    const userMsg = `前文（已简化，供语气与指代衔接参考）：\n…${prevTail}\n\n请把以下段落改写为${t.label}版本（本段原文 ${srcW} 词，目标输出约 ${Math.round((srcW * t.ratio) / 5) * 5} 词，±10%）：\n${segs[k].trim()}\n输出：保持 [P##] 标记开头，直接输出改写文本。`;
    const marker = segs[k].match(/\[P\d+\]/)[0];
    const content = await callChat([{ role: 'system', content: system }, { role: 'user', content: userMsg }]);
    let revised = cleanSeg(content, marker);
    // 修剪轮：改写模型有"删减阻抗"（实测三档全高于目标 12-20pp）——超标的段做一次纯删减任务
    const targetW = Math.round(srcW * t.ratio);
    if (srcW >= 20 && wc(revised) > srcW * (t.ratio + 0.08)) {
      const c2 = await callChat([
        { role: 'system', content: system },
        {
          role: 'user',
          content: `下面是一段${t.label}改写稿（${wc(revised)} 词），超出篇幅目标。请修剪到约 ${targetW} 词（原文 ${srcW} 词）：删掉次要细节、重复描写、可从上下文推出的信息；情节、因果、人物动作一条不能丢；保留的词汇与句式要求不变（词库边界/黑名单/注释格式）。只输出修剪后的段落（保持 [P##] 标记开头）：\n\n${revised}`,
        },
      ]);
      const trimmed = cleanSeg(c2, marker);
      // 采纳离目标更近的一版
      if (Math.abs(wc(trimmed) - targetW) < Math.abs(wc(revised) - targetW)) revised = trimmed;
      retried++;
    }
    if (srcW >= 20 && wc(revised) < srcW * t.retryLine) {
      const c2 = await callChat([
        { role: 'system', content: system },
        { role: 'user', content: userMsg },
        { role: 'assistant', content },
        { role: 'user', content: `你上一版只有 ${wc(revised)} 词，偏离目标（约 ${Math.round(srcW * t.ratio)} 词）太远。${t.key === 'B' ? '只删次要细节，情节因果必须完整' : '同义转换不是压缩，保留全部细节只换说法'}。重写这一段。输出：保持 [P##] 标记开头，直接输出改写文本。` },
      ]);
      const revised2 = cleanSeg(c2, marker);
      // 采纳离目标更近的一版
      const d1 = Math.abs(wc(revised) - srcW * t.ratio);
      const d2 = Math.abs(wc(revised2) - srcW * t.ratio);
      if (d2 < d1) revised = revised2;
      retried++;
    }
    out.push(revised);
    process.stdout.write(`  ${ch}${t.key} 段 ${k + 1}/${segs.length}（${srcW}→${wc(revised)}）\r`);
  }
  // 产物路径只从 Resolver 来（legacy 下与手拼逐字符相同，run 下才落进运行私有目录）
  const outPath = RR(t.clsTag).any('正文', { chapter: ch });
  mkdirSync(dirOfPath(outPath), { recursive: true });
  const newMd = `${header}${chLine}\n\n${out.join('\n\n')}\n`;
  writeAtomic(outPath, newMd, 'utf-8');
  const srcWords = wc(md.split('## 词句卡')[0]);
  const outWords = wc(newMd.split('## 词句卡')[0]);
  const qc = runQc(newMd, LEX, { tier: 'M', fileName: outPath.split('/').pop(), properNouns: PROPER });
  return { tier: t.key, ch, srcWords, outWords, ratio: outWords / srcWords, retried, segs: segs.length, qc, outPath };
}

/* ---------- 主流程 ---------- */
const args = process.argv.slice(2);
const dry = args.includes('--dry');
let tiers = args.filter((a) => /^[AMB]$/.test(a));
if (!tiers.length) tiers = ['A', 'M', 'B'];
let chapters = args.filter((a) => /^\d/.test(a)).flatMap((a) => a.split(',').map(Number));
if (!chapters.length) chapters = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
if (dry) {
  console.log('计划：', tiers.join('/'), '章', chapters.join(','));
  process.exit(0);
}
const results = [];
for (const tk of tiers) {
  for (const i of chapters) {
    console.log(`▶ ${tk} ${CN[i - 1]}`);
    try {
      results.push(await runChapter(i, TIERS[tk]));
    } catch (e) {
      console.error(`  ✗ ${e.message}`);
    }
  }
}
const lines = ['# AF 三档重制（85/75/60）· 汇总报告', '', `知识库：加注词 ${kbNotes.size} 对（top120 注入）/ 换词倾向 ${kbSwaps.length} 词`, '', '| 层 | 章 | 原文词数 | 产物词数 | 占比 | 目标 | 守恒重试 | 生词率 | 均长 | 被动/定从/过去完成/超长 |', '|---|---|---|---|---|---|---|---|---|---|'];
for (const r of results) {
  const target = TIERS[r.tier].ratio;
  const off = Math.abs(r.ratio - target) > 0.12 ? ' ⚠偏' : '';
  lines.push(`| ${r.tier} | ${r.ch} | ${r.srcWords} | ${r.outWords} | ${(r.ratio * 100).toFixed(0)}%${off} | ${Math.round(target * 100)}% | ${r.retried}/${r.segs} | ${(r.qc.newWordRate * 100).toFixed(1)}% | ${r.qc.avgLenNarrRaw.toFixed(1)} | ${r.qc.passive}/${r.qc.relcl}/${r.qc.pastperf}/${r.qc.over20} |`);
}
const byT = {};
for (const r of results) {
  (byT[r.tier] ??= { s: 0, o: 0 });
  byT[r.tier].s += r.srcWords;
  byT[r.tier].o += r.outWords;
}
lines.push('');
for (const [k, v] of Object.entries(byT)) lines.push(`${k} 层合计：${v.s} → ${v.o}（${((v.o / v.s) * 100).toFixed(0)}%）`);
writeAtomic(R.any('汇总报告', { name: '三档汇总' }), lines.join('\n'), 'utf-8');
console.log('\n' + lines.join('\n'));
