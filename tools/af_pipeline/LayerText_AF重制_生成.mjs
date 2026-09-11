#!/usr/bin/env node
/** AF 原文重制·第二步：逐段生成（同义转换守恒 + 章级 ≥50% 下限）+ QC 复核 + 汇总报告
 * 用法：node LayerText_AF重制_生成.mjs [章号如1或1,2 或空=全部] [--dry]
 * 与 App「AI 简化本章」同口径：逐段、前文衔接、段标记补回；另加段级守恒重试（App 第二十四批同款）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const P = (await import('./LayerText_AF词表与词典.mjs')).loadProject();
const REPO = P.引擎目录;
const BASE = P.原文目录;
/* ── 为什么本脚本**不**走 `Resolver` ──────────────────────────────────────
 * `Resolver` 建模的是**产物目录**（`产物目录` + `调适工作区`）：正文/台账/报告/队列/日志。
 * 本脚本读写的是**原文目录**（`原文重制_M50/第X章/…`）——那是源树，不是产物树：
 * 它产出的是"供其它脚本当输入用"的规范化原文，从不参与运行私有目录那套隔离。
 * 把它硬塞进 `Resolver` 只会给源树编一套并不存在的 ArtifactKind。
 * 真正需要经 `Resolver` 的是**产物**那几类，那几类别的脚本已经全部改过去了。 */
const VOCAB = P.词库;
const DATE = P.日期;
const MIN_CHAPTER_RATIO = 0.5; // 章级下限：产物 ≥ 原文 50%
const SEG_KEEP = 0.85; // 段级守恒线：单段 < 原段 85% 触发重试

const CFG = JSON.parse(readFileSync(`${process.env.HOME}/.layertext.json`, 'utf-8'));
const MODEL = 'deepseek-chat'; // 非思考型（v4-flash 思考型在复杂指令下会把推理/续写混入正文——09-09 与本次第一章实跑双重实证）
const KEY = execSync('security find-generic-password -s layertext.apikey -w').toString().trim();
const { splitChapter } = await import(`${REPO}/dist/src/core/textpipe.js`);
const { buildLexicon } = await import(`${REPO}/dist/src/core/lexicon.js`);
const { runQc } = await import(`${REPO}/dist/src/core/qc.js`);
const LEX = buildLexicon({ vocabCsvTexts: [readFileSync(VOCAB, 'utf-8')] });
const RULES = readFileSync(join(BASE, '校正规则_v1.md'), 'utf-8');

const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

/** AF 专名（人物/动物/地名/作品名）——QC 口径不计 OOV（与教师专名表机制同语义） */
const PROPER = P.PROPER;
const wc = (t) => (t.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).length;

const SYSTEM = `你是初中英语原著分层简化的审校助手。词汇边界：优先用《义务教育英语课程标准》三级（约1600词）；专有名词与既定术语不变。
同义转换优先、篇幅守恒：改写=换学生能懂的说法（词汇与句式），不是压缩或删减——细节、修饰、氛围描写一律保留转述；每段输出词数与该段原文相当（±15% 内），不得明显变短。
句法黑名单（引语内原话除外）：被动→主动；定语从句→拆短句或形容词前置；过去完成→一般过去时+before/after。
直接引语只降词不降句式（引号原样保留）。情节零丢失。

教师校正规则（从既有审校成果提取，遵守）：
${RULES}`;

const USER_TAIL = `输出要求：保持输入段落的 [P##] 标记原样开头，直接输出该段简化文本（纯英文）。确需保留的超纲词一律紧跟 word（中文）格式加注（如 rebellion（起义）），第一次出现时加。不要任何解释。`;

async function callChat(messages, maxTokens = 2500) {
  const body = (extra) => JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages, ...extra });
  let resp = await fetch(`${CFG.baseUrl}/chat/completions`, {
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

async function runChapter(i) {
  const ch = `第${CN[i - 1]}章`;
  const src = join(BASE, ch, '原文_规范化.md');
  const md = readFileSync(src, 'utf-8');
  const chLine = md.match(/^## Chapter \w+.*$/m)?.[0] ?? '## Chapter One';
  const header = md.slice(0, md.indexOf(chLine)) || '';
  const segs = splitChapter(md).body.match(/\[P\d+\][\s\S]*?(?=\[P\d+\]|$)/g) ?? [];
  if (!segs.length) throw new Error(`${ch} 未找到 [P##] 段落`);
  const out = [];
  let retried = 0;
  for (let k = 0; k < segs.length; k++) {
    const srcW = wc(segs[k]);
    const prevTail = out.length ? out[out.length - 1].slice(-500) : '（本章开头）';
    const userMsg = `前文（已简化，供语气与指代衔接参考）：\n…${prevTail}\n\n请简化以下段落（本章原文 ${wc(md.split('## 词句卡')[0])} 词，全章产出不得少于其 50%）：\n${segs[k].trim()}\n${USER_TAIL}`;
    const marker = segs[k].match(/\[P\d+\]/)[0];
    const content = await callChat([{ role: 'system', content: SYSTEM }, { role: 'user', content: userMsg }]);
    let revised = cleanSeg(content, marker);
    if (srcW >= 20 && wc(revised) < srcW * SEG_KEEP) {
      const c2 = await callChat([
        { role: 'system', content: SYSTEM },
        { role: 'user', content: userMsg },
        { role: 'assistant', content },
        { role: 'user', content: `你上一版只有 ${wc(revised)} 词，比原文（${srcW} 词）短了 ${Math.round((1 - wc(revised) / srcW) * 100)}%。同义转换不是压缩：保留全部细节、修饰与氛围，只换说法，重写这一段（词数与原文相当 ±15%）。${USER_TAIL}` },
      ]);
      const revised2 = cleanSeg(c2, marker);
      if (wc(revised2) > wc(revised)) revised = revised2;
      retried++;
    }
    out.push(revised);
    process.stdout.write(`  ${ch} 段 ${k + 1}/${segs.length}（${srcW}→${wc(revised)}）${retried ? '' : ''}\r`);
  }
  // 2026-09-10 修复：原为 `const newMd`，但下面注释轮要对它赋值——运行时必然 TypeError
  let newMd = `${header}${chLine}\n\n${out.join('\n\n')}\n`;
  const outPath = join(BASE, ch, `原文_M层重制_${DATE}.md`);
  writeFileSync(outPath, newMd, 'utf-8');
  const srcWords = wc(md.split('## 词句卡')[0]);
  const outWords = wc(newMd.split('## 词句卡')[0]);
  const qc0 = runQc(newMd, LEX, { tier: 'M', fileName: outPath.split('/').pop(), properNouns: PROPER });
  // 生成后注释轮：QC 出的 OOV（专名已除）一次性出 词→初中释义 映射，脚本内确定性插入（与 App 加注管线同思路）
  const oov = [...new Set(qc0.oov)].filter((w) => w.length > 2 && !PROPER.includes(w));
  let noted = 0;
  if (oov.length) {
    const raw = await callChat(
      [
        { role: 'system', content: '你给初中英语教材配生词注释。只输出一个 JSON 对象 {词: 释义}，释义 2-6 个汉字，初中生能懂，不要其他文字。' },
        { role: 'user', content: `给这些词配释义：${oov.join(', ')}` },
      ],
      2000,
    );
    try {
      const map = JSON.parse(raw.replace(/^[^{]*/, '').replace(/[^}]$/, ''));
      let body = newMd;
      for (const [w, zh] of Object.entries(map)) {
        if (typeof zh !== 'string' || !/[\u4e00-\u9fff]/.test(zh)) continue;
        // 词边界插入首次出现处（大小写不敏感；已带注跳过）
        const re = new RegExp(`(?<![\u4e00-\u9fff)（])\\b${w}\\b(?![\u4e00-\u9fff（])`, 'i');
        const m = body.match(re);
        if (m) {
          body = body.replace(re, `${m[0]}（${zh}）`);
          noted++;
        }
      }
      newMd = body;
      writeFileSync(outPath, newMd, 'utf-8');
    } catch {
      /* 注释轮失败不影响产物 */
    }
  }
  const qc = runQc(newMd, LEX, { tier: 'M', fileName: outPath.split('/').pop(), properNouns: PROPER });
  return { ch, srcWords, outWords, ratio: outWords / srcWords, retried, segs: segs.length, noted, oovLeft: [...new Set(qc.oov)].filter((w) => !PROPER.includes(w)).length, qc, outPath };
}

const args = process.argv.slice(2);
const dry = args.includes('--dry');
let chapters = args.filter((a) => /^\d/.test(a)).flatMap((a) => a.split(',').map(Number));
if (!chapters.length) chapters = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
if (dry) {
  console.log('计划章：', chapters.join(','));
  process.exit(0);
}
const results = [];
for (const i of chapters) {
  console.log(`▶ 第${CN[i - 1]}章`);
  try {
    results.push(await runChapter(i));
  } catch (e) {
    console.error(`  ✗ ${e.message}`);
  }
}
const lines = ['# AF 原文重制 M 层（≥50% 篇幅）· 汇总报告', '', '| 章 | 原文词数 | 产物词数 | 保留 | 守恒重试段 | 加注 | 剩余OOV | 生词率 | 均长 | 被动/定从/过去完成/超长 |', '|---|---|---|---|---|---|---|---|---|---|'];
for (const r of results) {
  lines.push(`| ${r.ch} | ${r.srcWords} | ${r.outWords} | ${(r.ratio * 100).toFixed(0)}%${r.ratio < MIN_CHAPTER_RATIO ? ' ⚠低于50%' : ''} | ${r.retried}/${r.segs} | ${r.noted} | ${r.oovLeft} | ${(r.qc.newWordRate * 100).toFixed(1)}% | ${r.qc.avgLenNarrRaw.toFixed(1)} | ${r.qc.passive}/${r.qc.relcl}/${r.qc.pastperf}/${r.qc.over20} |`);
}
const totS = results.reduce((n, r) => n + r.srcWords, 0);
const totO = results.reduce((n, r) => n + r.outWords, 0);
lines.push('', `全书：${totS} → ${totO}（保留 ${((totO / totS) * 100).toFixed(0)}%）`, '');
writeFileSync(join(BASE, `重制汇总_${DATE}.md`), lines.join('\n'), 'utf-8');
console.log('\n' + lines.join('\n'));
