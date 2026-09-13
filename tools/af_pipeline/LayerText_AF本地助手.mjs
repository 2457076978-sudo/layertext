#!/usr/bin/env node
/** AF 本地助手：把本机小模型（oMLX 上的 MiniCPM5-2B）**只**用在它实测扛得住的三件事上。
 *
 * 为什么要写死边界（2026-09-13 实测，见 Desktop/LayerText_本地裁判_试验/能力边界实测.md）：
 *   同一个 2B 模型，1 段输入时能报对问题、2 段起就一条不报；让它补全空字段会直接编；
 *   让它给段落分类会一律答"叙述"；让它判卷能挑出错但给分不可信。
 *   结论：**输入短 + 任务单一 + 判据明确 + 输出可机检** 四条同时成立才用它，缺一条就交回确定性脚本或人。
 *   所以本脚本不做"整章扫描""自动打分""补全台账"这些事——那些要么有确定性解法（正本核对），要么必须人定。
 *
 * 四个子命令 —— 但**只有两个真的在调模型**，别把它们当成一类（2026-09-13 自我更正）：
 *   释词  【调模型】带语境的词义判断（实测 4/5 正确），与项目词典对账 → 一致/不一致都如实说
 *   改写  【调模型】句级拆句候选（**不是段级**：段级实测会整段抄回原文）
 *   文案  【默认不调模型】给「正本核对」候选出选项卡；确定性模板够用，
 *          模型草稿实测 3 条里 2 条是废话，想试加 --model-text（带自检）
 *   格式  【不调模型】纯代码的 CSV↔JSON。**这条跟本地模型毫无关系**——
 *          它列在这里只是因为"人懒得写正则"时顺手；任何模型做格式转换都是负收益：
 *          慢、贵、会被 max_tokens 截断，而且逐字复制 1262 行它必然抄错，
 *          而 writeFileSync 一行就干完且 100% 可复现。
 *
 * 三条纪律写死在代码里，不靠人记：
 *   ① 一次一段：改写/文案每次只喂一段；多段自己循环（`--para all`），绝不塞进一次调用
 *   ② 只出候选：产物落 `产物目录/本地助手_*.md` 与 `_运行/`，**正本（词库/词典/知识库/产物正文）一律不自动改**
 *   ③ 记账：每次调用都进项目台账（复用 LayerText_AF调用台账.mjs），本地模型 cost=0 也照记
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SHARED = await import('./LayerText_AF词表与词典.mjs');
const { loadProject, segmentList, loadDict, loadKbGloss } = SHARED;
const { openLedger } = await import('./LayerText_AF调用台账.mjs');

const P = loadProject();
const SRC_BASE = P.原文目录;
const OUT_BASE = P.产物目录;
const RUN_DIR = join(OUT_BASE, '_运行');
const DATE = P.日期;
const CN = SHARED.chapterNames(P);
const TAGS = { A: 'A层85', M: 'M层75', B: 'B层60' };

const argv = process.argv.slice(2);
const CMD = argv[0];
const arg = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const has = (n) => argv.includes(n);

/** oMLX 地址与钥匙：默认读本机 App 的 settings.json，省得每次 export。 */
const BASE_URL = (process.env.OMLX_BASE_URL ?? 'http://127.0.0.1:8000/v1').replace(/\/$/, '');
function omlxKey() {
  if (process.env.OMLX_API_KEY) return process.env.OMLX_API_KEY;
  try {
    const s = JSON.parse(readFileSync(join(process.env.HOME ?? '.', '.omlx', 'settings.json'), 'utf-8'));
    return s?.auth?.api_key ?? '';
  } catch {
    return '';
  }
}
const KEY = omlxKey();
const MODEL = arg('--model', process.env.OMLX_MODEL ?? 'Ling-3.0-tiny-oQ4e:judge');
const DICT = loadDict(P.书级?.词典 ?? P.词典);
const KB = loadKbGloss(P.书级?.知识库 ?? P.知识库);

const USAGE = `AF 本地助手（本机 oMLX 小模型，只做实测扛得住的事）

  node LayerText_AF本地助手.mjs 释词 --word perches --sentence "The birds jumped on to their perches."
  node LayerText_AF本地助手.mjs 改写 --tier A --chapter 1 --para P04 [--n 2]
  node LayerText_AF本地助手.mjs 改写 --tier A --chapter 1 --para all        # 逐段循环（一次一段）
  node LayerText_AF本地助手.mjs 文案 --from 正本核对_${DATE}.json [--star-only] [--limit 20]
  node LayerText_AF本地助手.mjs 格式 --in foo.csv --to json [--out bar.json]   # 纯代码，不调模型

公共参数：--model <id>（默认 ${MODEL}）｜ --out <后缀>
注：只有 释词 / 改写 会调本地模型；文案默认也是确定性模板；格式与模型无关。`;

/** 剥掉模型爱加的 markdown 围栏，再解析 JSON。 */
function parseJson(text) {
  const t = String(text)
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  try {
    return JSON.parse(t);
  } catch {
    const m = t.match(/[[{][\s\S]*[\]}]/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function findProduct(dir, tag) {
  if (!existsSync(dir)) return null;
  const hit = readdirSync(dir)
    .filter((f) => f.startsWith(`原文_${tag}_`) && f.endsWith('_工序化.md'))
    .sort()
    .pop();
  return hit ? join(dir, hit) : null;
}

function readParas(path) {
  return new Map(segmentList(readFileSync(path, 'utf-8')).map((s) => [s.id, s.text.replace(/^\[P\d+\]\s*/, '')]));
}

/* ────────────────────────── 释词 ────────────────────────── */
async function cmdExplain() {
  const word = arg('--word');
  const sentence = arg('--sentence');
  if (!word || !sentence) {
    console.error('✗ 需要 --word 与 --sentence（**必须带句**：批量裸问词义只会拿到第一义项，项目踩过 perches=鲈鱼）');
    process.exit(2);
  }
  const LEDGER = await openLedger(P, '本地助手·释词');
  const msgs = [
    { role: 'system', content: '你是英语词典编辑。只看给定的句子判断该词在这句话里的意思，输出 2-6 个汉字的词义，不要解释、不要音标、不要多个选项。' },
    { role: 'user', content: `句子：${sentence}\n问：${word} 在这个句子里的中文意思是什么？` },
  ];
  const { content, usage } = await LEDGER.call(msgs, { baseUrl: BASE_URL, key: KEY, model: MODEL, maxTokens: 40 });
  const got = content.trim().split(/\s|\n/)[0];
  const zh = DICT.get(word.toLowerCase());
  const same = zh ? got.includes(zh) || zh.includes(got) : null;
  console.log(`词：${word}`);
  console.log(`模型（带句）：${got}`);
  console.log(zh ? `项目词典：${zh} → ${same ? '✅ 一致' : '⚠️ 不一致（以词典正本为准，模型结果只当第二意见）'}` : '项目词典：无此词（不会写进正本）');
  console.log(`台账：in ${usage.in} / out ${usage.out} tokens`);
  LEDGER.flush();
}

function keepWords(text) {
  const out = [];
  const seen = new Set();
  for (const w of text.toLowerCase().match(/[a-z][a-z'-]*/g) ?? []) {
    if (seen.has(w)) continue;
    seen.add(w);
    const zh = DICT.get(w);
    const star = KB.get(w);
    if (zh || star) out.push(`${w}（${zh ?? star?.zh}）${star ? '★' : ''}`);
  }
  return out;
}

/** 候选与原文的改动量：词频多重集交集。项目的既有纪律是"声明-实效守卫：原样返回按被拒处理"
 *  （src/core/stagepipe.ts），这里把同一条纪律机检出来——实测模型被"正本词必须保留"约束后，
 *  会整段抄回原文当候选，而它自己还写"完全保留原文所有事实"。 */
function changeRatio(srcText, candText) {
  const bag = (t) => {
    const m = new Map();
    for (const w of t.toLowerCase().match(/[a-z][a-z'-]*/g) ?? []) m.set(w, (m.get(w) ?? 0) + 1);
    return m;
  };
  const a = bag(srcText);
  const b = bag(candText);
  let common = 0;
  for (const [w, n] of a) common += Math.min(n, b.get(w) ?? 0);
  const total =
    Math.max(
      [...a.values()].reduce((x, y) => x + y, 0),
      [...b.values()].reduce((x, y) => x + y, 0),
    ) || 1;
  return 1 - common / total;
}

/** 结构化调用：先用提示词里的 JSON 模板，解析不出来就**重试一次**并明确要求"只输出 JSON"。
 *  为什么不直接用 response_format 的 json_schema 约束解码：那条要绕开项目台账的 call()，
 *  而台账纪律（每次调用都记账）优先于格式便利——本地模型返回的 JSON 我们已经会剥围栏、会兜底解析。 */
async function callJson(LEDGER, msgs, opts) {
  const first = await LEDGER.call(msgs, opts);
  const js = parseJson(first.content);
  if (js !== null) return js;
  const retry = [...msgs, { role: 'assistant', content: first.content }, { role: 'user', content: '上次输出不是合法 JSON。只输出 JSON 本身，不要围栏、不要解释。' }];
  const second = await LEDGER.call(retry, opts);
  return parseJson(second.content);
}

const wc = (t) => (t.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).length;
const SENT_LINE = { A: 20, M: 16, B: 14 };

/** 一段切成句子（保留原样，不做归一）。 */
const sentencesOf = (para) =>
  para
    .split(/(?<=[.!?])\s+/)
    .map((x) => x.trim())
    .filter((x) => wc(x) >= 3);

async function rewriteOne(LEDGER, tier, pid, sentence, n) {
  const limit = SENT_LINE[tier] ?? 20;
  const keep = keepWords(sentence);
  const msgs = [
    {
      role: 'system',
      content: `你在拆写《Animal Farm》${tier} 层的长句。硬约束：
- 把这一句拆短：每句 ≤ ${limit} 词，一句一个事件；可以拆成 2-3 句，但**不许增删事实**。
- 数字、专名（人名/地名）一律不动。
- 下面这些词是教师正本词，必须原样保留、一个字母都不许换：
  ${keep.length ? keep.join('、') : '（本句没有正本词）'}
- 其余超纲词可以换课标词、可删冗余修饰。**原样抄回原句不算候选。**
- 只输出 JSON：{"candidates":[{"text":"拆写后的英文","why":"中文一句话理由"}]}，不要解释。`,
    },
    { role: 'user', content: `原句（${wc(sentence)} 词）：${sentence}\n\n给 ${n} 个拆写候选。` },
  ];
  const js = await callJson(LEDGER, msgs, { baseUrl: BASE_URL, key: KEY, model: MODEL, maxTokens: 700 });
  return js?.candidates ?? [];
}

/* ────────────────────────── 改写 ──────────────────────────
 * ★ 为什么是**句级**而不是段级（2026-09-13 实测两次翻车）：
 *   段级改写时模型要么整段抄回原文（改动量 0%，被机检打回），要么把 comrades 换成 friends。
 *   句级正好落在实测通过的那一档（输入短、任务单一），而且和项目的判定线同粒度
 *   （SENT_LEN_CHECK A20/M16/B14、隔离段 SENT-01 二次重拆）。
 *   默认只挑"超过本层句长线"的句子——那正是引擎已经判红、要人处理的那批。 */
async function cmdRewrite() {
  const tier = String(arg('--tier', 'A')).toUpperCase();
  const tag = TAGS[tier];
  const ci = Number(arg('--chapter', '1'));
  const ch = CN[ci - 1];
  if (!tag || !ch) {
    console.error('✗ --tier 只能是 A/M/B，--chapter 是章节序号');
    process.exit(2);
  }
  const srcPath = join(SRC_BASE, ch, '原文_规范化.md');
  const prodPath = findProduct(join(OUT_BASE, ch), tag);
  if (!existsSync(srcPath) || !prodPath) {
    console.error(`✗ 缺文件：${existsSync(srcPath) ? '' : srcPath} ${prodPath ? '' : `（缺 ${tag} 产物）`}`);
    process.exit(2);
  }
  const src = readParas(srcPath);
  const prod = readParas(prodPath);
  const want = arg('--para', 'all');
  const ids = want === 'all' ? [...src.keys()] : want.split(',').map((x) => x.trim());
  const n = Number(arg('--n', '2')) || 2;
  const allSent = has('--all-sentences');
  const line = SENT_LINE[tier] ?? 20;
  const LEDGER = await openLedger(P, '本地助手·改写');
  const lines = [
    `# 本地拆句候选 · ${ch} · ${tag} · ${DATE}`,
    '',
    `> 模型 \`${MODEL}\`（本机 oMLX，cost 0）｜**一句一次调用**（实测段级会抄回原文或多段弃答）`,
    `> 目标句：本层句长线 > ${line} 词的句子${allSent ? '（--all-sentences：全部句子）' : ''}｜候选不是正稿，确认后才落盘`,
    '',
  ];
  let calls = 0;
  for (const pid of ids) {
    if (!src.has(pid)) {
      lines.push(`## ${pid} · ⚠ 原文没有这一段，跳过`);
      continue;
    }
    const sents = sentencesOf(src.get(pid));
    const targets = allSent ? sents : sents.filter((x) => wc(x) > line);
    lines.push(`## ${pid}${targets.length ? '' : ' · ✅ 没有超线句'}`, '');
    if (!targets.length) continue;
    lines.push(`现有产物：${(prod.get(pid) ?? '（产物缺此段）').slice(0, 160)}`, '');
    for (const sent of targets) {
      LEDGER.scene = { tier, chapter: ch, tag: pid };
      const cands = await rewriteOne(LEDGER, tier, pid, sent, n);
      calls += 1;
      lines.push(`**原句（${wc(sent)} 词，超线 ${wc(sent) - line}）**：${sent}`, '');
      if (!cands.length) lines.push('- （模型没给候选——按实测它会弃答，人看原句即可）', '');
      const keep = keepWords(sent);
      cands.forEach((c, i) => {
        const ratio = changeRatio(sent, c.text ?? '');
        const len = wc(c.text ?? '');
        const verdict = ratio < 0.05 ? '❌ **原样返回（按被拒）**' : len > line ? `⚠️ 仍超线（${len} 词）` : '✅ 达标';
        lines.push(`- **候选${i + 1}**（${len} 词，改动量 ${(ratio * 100).toFixed(0)}%）${verdict}：${c.text ?? ''}`);
        lines.push(`  - 理由：${c.why ?? ''}`);
      });
      if (keep.length) {
        const ok = cands.filter((c) => keep.every((k) => new RegExp(`\\b${k.split('（')[0]}\\b`, 'i').test(c.text ?? '')));
        lines.push(`  - 机检正本词（${keep.map((k) => k.split('（')[0]).join('、')}）：${cands.length ? `${ok.length}/${cands.length} 个候选全保住` : '无候选'}`);
      }
      lines.push('');
    }
  }
  mkdirSync(RUN_DIR, { recursive: true });
  const out = join(OUT_BASE, `本地助手_拆句_${tag}_${ch}_${DATE}.md`);
  writeFileSync(out, `${lines.join('\n')}\n`, 'utf-8');
  const st = LEDGER.flush();
  console.log(`目标句 ${calls} 句｜调用 ${st.calls} 次（in ${st.in} / out ${st.out} tokens，本地 cost 0）`);
  console.log(`产物：${out}`);
}

/* ────────────────────────── 文案 ────────────────────────── */
async function cmdWording() {
  const from = arg('--from', `正本核对_${DATE}.json`);
  const path = existsSync(from) ? from : join(RUN_DIR, from);
  if (!existsSync(path)) {
    console.error(`✗ 找不到正本核对结果：${path}\n  先跑：node LayerText_AF正本核对.mjs`);
    process.exit(2);
  }
  const data = JSON.parse(readFileSync(path, 'utf-8'));
  const limit = Number(arg('--limit', '20')) || 20;
  const starOnly = has('--star-only');
  /* ★ 默认**不叫模型写**（2026-09-13 实测：让它写选项卡，3 条里 2 条是废话——
   *   "原文中'labour'的释义是'劳作'"、把 platform 说成 windmill）。
   *   确定性文案本来就够用：选项①保留原词＋加注（教师释义）／选项②确认有意替换。
   *   想看看模型怎么说，加 --model-text；它胡说的会被下面两道自检直接丢掉。 */
  const withModel = has('--model-text');
  const words = (data.words ?? []).filter((w) => !starOnly || w.star).slice(0, limit);
  if (!words.length) {
    console.error('✗ 这份核对结果里没有可写的候选');
    process.exit(2);
  }
  const cache = new Map();
  const prodOf = (tier, chapter) => {
    const k = `${tier}/${chapter}`;
    if (!cache.has(k)) {
      const p = findProduct(join(OUT_BASE, chapter), TAGS[tier]);
      cache.set(k, p ? readParas(p) : new Map());
    }
    return cache.get(k);
  };
  const LEDGER = withModel ? await openLedger(P, '本地助手·文案') : null;
  const lines = [
    `# 候选选项卡 · ${DATE}`,
    '',
    '> 每条：一句话理由 + 两个互斥选项。**这是给人确认的候选，不自动改任何正本。**',
    `> 文案来源：${withModel ? `确定性模板 + 模型草稿（\`${MODEL}\`，带自检）` : '确定性模板（模型不参与；要它写加 --model-text）'}`,
    `> 来源 \`${path.split('/').pop()}\`｜共 ${words.length} 条`,
    '',
  ];
  let kept = 0;
  for (const w of words) {
    const hit = (w.hits ?? [])[0];
    const prodText = hit ? (prodOf(hit.tier, hit.chapter).get(hit.para) ?? '') : '';
    let draft = null;
    if (withModel && LEDGER) {
      LEDGER.scene = { tier: hit?.tier ?? '', chapter: hit?.chapter ?? '', tag: hit?.para ?? '' };
      const msgs = [
        {
          role: 'system',
          content:
            '你在为分级读物审校写"选项卡"。只输出 JSON：{"why":"中文一句话说明为什么该保留这个词","option_keep":"选项①的具体文案","option_drop":"选项②的具体文案"}。选项要写具体做法，不要只写一个单词。',
        },
        { role: 'user', content: `教师正本里 "${w.word}" 的释义是"${w.zh}"。这一段的产物正文是：\n${prodText.slice(0, 600)}\n\n这个词在产物里已经找不到（疑似被换掉）。按上面格式给选项卡。` },
      ];
      try {
        const c = await callJson(LEDGER, msgs, { baseUrl: BASE_URL, key: KEY, model: MODEL, maxTokens: 260 });
        // 两道自检：① 必须提到这个词本身 ② 选项不能只是一个单词（实测它爱这么干）
        const mentions = c && `${c.why ?? ''}${c.option_keep ?? ''}`.toLowerCase().includes(w.word.toLowerCase());
        const realOptions = c && [c.option_keep, c.option_drop].every((x) => typeof x === 'string' && x.trim().split(/\s+/).length >= 3);
        if (mentions && realOptions) {
          draft = c;
          kept += 1;
        }
      } catch (e) {
        console.warn(`⚠ ${w.word}：调用失败（${String(e).slice(0, 60)}）`);
      }
    }
    lines.push(
      `### ${w.word}（${w.zh}）${w.star ? ' ★' : ''} — 丢 ${w.paras} 段：${(w.hits ?? [])
        .map((h) => `${h.tier}${h.chapter}${h.para}`)
        .slice(0, 8)
        .join(' ')}`,
    );
    lines.push(`- 理由：${draft?.why ?? `教师正本登记过这个词（${w.zh}），产物里已找不到——按 R02 / 标注政策 v0.2 应保留原词并加注。`}`);
    lines.push(`- 选项① ${draft?.option_keep ?? `保留原词 \`${w.word}\` 并在首次出现处加注（${w.zh}）`}`);
    lines.push(`- 选项② ${draft?.option_drop ?? '确认是有意替换（请写理由，写入决定事件）'}`);
    if (withModel && !draft) lines.push('  - （模型草稿未通过自检，已丢弃）');
    lines.push('');
  }
  mkdirSync(RUN_DIR, { recursive: true });
  const out = join(OUT_BASE, `本地助手_选项卡_${DATE}.md`);
  writeFileSync(out, `${lines.join('\n')}\n`, 'utf-8');
  const st = LEDGER?.flush();
  console.log(`选项卡 ${words.length} 条${withModel ? `（模型草稿通过自检 ${kept}/${words.length}）` : ''}`);
  if (st) console.log(`调用 ${st.calls} 次（in ${st.in} / out ${st.out} tokens，本地 cost 0）`);
  console.log(`产物：${out}`);
}

/* ────────────────────────── 格式（纯转换，不做补全） ────────────────────────── */
function splitCsvLine(line) {
  return line.split(',').map((s) => s.trim());
}

async function cmdFormat() {
  const input = arg('--in');
  const to = arg('--to', 'json').toLowerCase();
  if (!input || !existsSync(input)) {
    console.error('✗ --in 指定的文件不存在');
    process.exit(2);
  }
  const raw = readFileSync(input, 'utf-8')
    .replace(/^\uFEFF/, '')
    .trim();
  const rows = raw.split('\n').map(splitCsvLine);
  const header = rows.shift() ?? [];
  const empties = [];
  const objs = rows.map((cells, i) => {
    const o = {};
    header.forEach((h, j) => {
      o[h] = cells[j] ?? '';
      if (!o[h]) empties.push(`${i + 1} 行的「${h}」`);
    });
    return o;
  });
  const out = arg('--out', to === 'json' ? input.replace(/\.csv$/i, '.json') : input.replace(/\.json$/i, '.csv'));
  const text = to === 'json' ? `${JSON.stringify(objs, null, 1)}\n` : `${[header.join(','), ...rows.map((r) => r.join(','))].join('\n')}\n`;
  writeFileSync(out, text, 'utf-8');
  console.log(`已转换：${input} → ${out}（${objs.length} 行）`);
  if (empties.length) {
    // ★ 空字段**绝不交给模型补**：实测它被明确要求"不要编造"也照编（能力边界实测 5b）。
    console.log(`\n⚠ 有 ${empties.length} 处空字段，按纪律留空未补：`);
    for (const e of empties.slice(0, 20)) console.log(`  · ${e}`);
    if (empties.length > 20) console.log(`  · …其余 ${empties.length - 20} 处`);
    console.log('  要补这些字段得走人/正式管线——本脚本不做补全。');
  }
}

/* ────────────────────────── 入口 ────────────────────────── */
if (!KEY) {
  console.error('✗ 读不到 oMLX 的 API Key：设置环境变量 OMLX_API_KEY，或确认 ~/.omlx/settings.json 里有 auth.api_key');
  process.exit(2);
}

try {
  if (CMD === '释词') await cmdExplain();
  else if (CMD === '改写') await cmdRewrite();
  else if (CMD === '文案') await cmdWording();
  else if (CMD === '格式') await cmdFormat();
  else {
    console.log(USAGE);
    process.exit(CMD ? 2 : 0);
  }
} catch (e) {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
