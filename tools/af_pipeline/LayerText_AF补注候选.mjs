#!/usr/bin/env node
/** AF 补注候选：把「引擎筛出的生词」变成「教师只需点确认的选项卡」
 *
 * ## 分工（这是 2026-09-13 一整天实测换来的结论）
 *
 * | 步骤 | 谁做 | 为什么 |
 * |---|---|---|
 * | 筛出"学生看不懂、又还没注"的词 | **引擎**（管线已有的「未支持难词」） | 词库比对是确定性活，客观、全量、一条不漏 |
 * | 给这些词填中文候选 | **本地小模型**（带句问，一次一词） | 实测带句释义 4/5 正确；它不挑词，只填词 |
 * | 点确认、进词典/正文 | **教师** | 判据永远是人的 |
 *
 * 反面教训（同一天实测）：让模型"通读全章找问题"是**不成立**的——2B 两段起就交白卷，
 * 7.9B 有输出但把"语义一致、无实质问题"也列成 issue；让模型判生词也不成立（windmill 判成已学）。
 * 它站得住的位置只有这个：**判据（哪些词）由引擎给，模型只负责填中文**。
 *
 * ## 用法
 *
 *   node LayerText_AF补注候选.mjs --tier A --chapters 1        # 一章一层
 *   node LayerText_AF补注候选.mjs --tier A,M,B                 # 全书三层
 *   node LayerText_AF补注候选.mjs --tier A --no-model          # 只出词典已有的候选（不调模型）
 *
 * ## 产物
 *
 *   产物目录/_运行/补注候选_<层>.json   —— App 补注面板读的队列（**断点续跑**：已跑过的不再问）
 *   产物目录/补注候选_<层>_<日期>.md   —— 人看的表
 *
 * ## 纪律
 *
 * · 一次一词，绝不批量（实测多词同问会互相干扰）
 * · 词典里**已有**释义的词不问模型——直接用正本，省一次调用也少一个出错机会
 * · OCR 碎片（`england'` 这种带撇号/连字符残留的）单列，不当词处理
 * · 候选只是候选：**不写词典、不改正文**，教师在 App 里点确认才落
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SHARED = await import('./LayerText_AF词表与词典.mjs');
const P = SHARED.loadProject();
const OUT_BASE = P.产物目录;
const RUN_DIR = join(OUT_BASE, '_运行');
const DATE = P.日期;
const CN = SHARED.chapterNames(P);
const TAGS = { A: 'A层85', M: 'M层75', B: 'B层60' };

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const has = (n) => argv.includes(n);
const TIERS = String(arg('--tier', 'A'))
  .split(',')
  .map((t) =>
    t
      .trim()
      .replace(/^([AMB])层.*$/, '$1')
      .toUpperCase(),
  )
  .filter((t) => TAGS[t]);
const CH_IDS = String(arg('--chapters', ''))
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n >= 1 && n <= CN.length);
const LIMIT = Number(arg('--limit', '0')) || 0;
const USE_MODEL = !has('--no-model');

/* ── 本地模型（oMLX）── 与 Desktop 上那套试验同一条链路，key 直接读 App 的 settings.json */
const BASE_URL = (process.env.OMLX_BASE_URL ?? 'http://127.0.0.1:8000/v1').replace(/\/$/, '');
const MODEL = arg('--model', process.env.OMLX_MODEL ?? 'Ling-3.0-tiny-oQ4e:judge');
function omlxKey() {
  if (process.env.OMLX_API_KEY) return process.env.OMLX_API_KEY;
  try {
    return JSON.parse(readFileSync(join(homedir(), '.omlx', 'settings.json'), 'utf-8'))?.auth?.api_key ?? '';
  } catch {
    /* 有意兜底：没装 oMLX／没配 key＝这台机器只跑 --no-model 模式，不是错误。 */
    return '';
  }
}
const KEY = omlxKey();

/** 读一章一层的「未支持难词」（管线自己报的缺口）。 */
function gapsOf(chapter, tag) {
  const f = join(OUT_BASE, chapter, '_待复核', `工序化待人工_${tag}_${DATE}.md`);
  if (!existsSync(f)) return null;
  const m = readFileSync(f, 'utf-8').match(/## 未支持难词[^\n]*\n([\s\S]*?)(?=\n## |\n*$)/);
  if (!m) return [];
  const out = [];
  for (const line of m[1].split('\n')) {
    const hit = line.match(/^- (P\d+)：(.+)$/);
    if (!hit) continue;
    for (const w of hit[2].split('、')) {
      const word = w.trim();
      if (word) out.push({ para: hit[1], word });
    }
  }
  return out;
}

/** 该词在产物里的出处句——**带句**是这套东西能用的前提（裸问只会拿到词典第一义项，项目踩过 perches=鲈鱼）。 */
function sentenceOf(md, word, para) {
  const seg = md.match(new RegExp(`\\[${para}\\]([\\s\\S]*?)(?=\\[P\\d+\\]|$)`))?.[1] ?? md;
  const clean = seg.replace(/（[^）]*）/g, '');
  for (const s of clean.split(/(?<=[.!?])\s+/)) {
    if (new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(s)) return s.replace(/\s+/g, ' ').trim().slice(0, 220);
  }
  return clean.replace(/\s+/g, ' ').trim().slice(0, 220);
}

function productOf(chapter, tag) {
  const dir = join(OUT_BASE, chapter);
  if (!existsSync(dir)) return null;
  return join(dir, `原文_${tag}_${DATE}_工序化.md`);
}

async function askModel(word, sentence, LEDGER) {
  const msgs = [
    { role: 'system', content: '你是英语词典编辑。只看句子判断该词在句中的意思，输出 2-6 个汉字，不要解释、不要拼音、不要多个选项。若无法判断就只输出：不确定' },
    { role: 'user', content: `句子：${sentence}\n问：${word} 在这个句子里的中文意思是什么？` },
  ];
  const { content } = await LEDGER.call(msgs, { baseUrl: BASE_URL, key: KEY, model: MODEL, maxTokens: 40 });
  return String(content ?? '')
    .trim()
    .split('\n')[0]
    .slice(0, 24);
}

/** OCR 碎片：`england'`、`again--seven` 这类——**不是词**，单列出来别浪费教师眼神。 */
const FRAGMENT = /['\u2019]|\d|--/;

const DICT = SHARED.loadDict(P.书级?.词典 ?? P.词典);
const { openLedger } = await import('./LayerText_AF调用台账.mjs');
const LEDGER = USE_MODEL ? await openLedger(P, '补注候选') : null;

mkdirSync(RUN_DIR, { recursive: true });
let asked = 0;
let fromDict = 0;

for (const tier of TIERS) {
  const tag = TAGS[tier];
  const queuePath = join(RUN_DIR, `补注候选_${tag}.json`);
  const queue = existsSync(queuePath) ? JSON.parse(readFileSync(queuePath, 'utf-8')) : { tier: tag, items: [], fragments: [], updatedAt: '' };
  const done = new Set(queue.items.map((i) => i.word));
  const doneFrag = new Set(queue.fragments.map((i) => i.word));
  const ids = CH_IDS.length ? CH_IDS : CN.map((_, i) => i + 1);
  console.log(`════ 补注候选 · ${tag} ════`);
  for (const ci of ids) {
    const chapter = CN[ci - 1];
    const gaps = gapsOf(chapter, tag);
    if (!gaps) {
      console.log(`  ${chapter}：没有待人工报告，跳过`);
      continue;
    }
    const prodPath = productOf(chapter, tag);
    if (!prodPath || !existsSync(prodPath)) {
      console.log(`  ${chapter}：缺产物，跳过`);
      continue;
    }
    const md = readFileSync(prodPath, 'utf-8');
    let n = 0;
    for (const g of gaps) {
      if (LIMIT && queue.items.length >= LIMIT) break;
      if (FRAGMENT.test(g.word)) {
        if (!doneFrag.has(g.word)) {
          queue.fragments.push({ word: g.word, chapter, tier: tag, para: g.para, why: '形如 OCR 残留/非单词，需人工确认是否采词' });
          doneFrag.add(g.word);
        }
        continue;
      }
      if (done.has(g.word)) continue;
      const sentence = sentenceOf(md, g.word, g.para);
      const dictZh = DICT.get(g.word.toLowerCase());
      let gloss = dictZh ?? '';
      /* 三态要分清楚：词典正本命中 / 模型填的 / 谁都没填上。
         一开始把空值也算成 dict 是错的——那会让教师以为"正本里就是这么写的"。 */
      let source = dictZh ? 'dict' : 'missing';
      if (!gloss && USE_MODEL && KEY) {
        LEDGER.scene = { tier, chapter, tag: g.para };
        gloss = await askModel(g.word, sentence, LEDGER);
        source = gloss && gloss !== '不确定' ? 'model' : 'missing';
        asked += 1;
      }
      if (source === 'dict') fromDict += 1;
      queue.items.push({
        word: g.word,
        chapter,
        tier: tag,
        para: g.para,
        sentence,
        gloss: gloss || '（未取到）',
        source,
        /** App 面板据此决定默认选哪个：词典已有释义＝照正本，模型候选＝需人过目 */
        needsReview: source === 'model',
      });
      done.add(g.word);
      n += 1;
    }
    console.log(`  ${chapter}：新增 ${n} 条（累计 ${queue.items.length}）`);
  }
  queue.updatedAt = new Date().toISOString();
  writeFileSync(queuePath, `${JSON.stringify(queue, null, 1)}\n`, 'utf-8');

  /* 人看的表 */
  const L = [
    `# 补注候选 · ${tag} · ${DATE}`,
    '',
    `> 引擎筛词（未支持难词）＋ ${USE_MODEL ? `本地模型 \`${MODEL}\` 带句填中文` : '仅词典正本'}。`,
    `> **不自动写词典、不改正文**——教师在 App 里点确认才落（source: human）。`,
    '',
  ];
  L.push('| # | 章 | 段 | 词 | 中文候选 | 来源 | 出处句 |', '|---|---|---|---|---|---|---|');
  queue.items.forEach((it, i) => L.push(`| ${i + 1} | ${it.chapter} | ${it.para} | **${it.word}** | ${it.gloss} | ${it.source === 'dict' ? '词典正本' : '模型'} | ${it.sentence.slice(0, 70)} |`));
  if (queue.fragments.length) {
    L.push('', '## ⚠ OCR 碎片（不是词，单独确认）', '');
    for (const f of queue.fragments) L.push(`- ${f.chapter} ${f.para}：\`${f.word}\``);
  }
  writeFileSync(join(OUT_BASE, `补注候选_${tag}_${DATE}.md`), `${L.join('\n')}\n`, 'utf-8');
  console.log(`\n队列：${queuePath}`);
  console.log(`表：  ${join(OUT_BASE, `补注候选_${tag}_${DATE}.md`)}`);
}

if (LEDGER) {
  const st = LEDGER.flush();
  console.log(`\n模型调用 ${st.calls} 次（in ${st.in} / out ${st.out} tokens，本地 cost 0）｜词典直接命中 ${fromDict} 条免问｜本次新问 ${asked} 词`);
}
