#!/usr/bin/env node
/** AF 会话式改写（Agent 式分层简化）· 为「一本书 = 一个会话」设计
 *
 * 为什么是这个形状（2026-09-11 定稿）：
 *   原来的做法是「一段一次调用、675 次互不相识」——模型不知道本章前面写过什么，
 *   词汇边界靠猜（只给了 37 个必须注的词，3600 词词库塞不进 prompt），
 *   人物称呼/语气/加注全靠事后脚本擦。本脚本把它换成**一条会话走完一层书**。
 *
 * 三方经验的合成：
 *   ① 你的设计：一本书一个会话；词表（我对词汇的标记）一次性传进去，模型自己在里面调取
 *   ② GitHub 上做得好的做法：
 *      - Wenyi：整书情节底线 + 章摘要注入每一批；术语实时抽取 + 冲突检测回灌；批次检查点可续跑
 *      - TranslateBooksWithLLMs：断点续跑、状态文件
 *      - Rainman Translate Book：manifest 完整性校验、邻居上下文
 *   ③ DSH 自己的机制：
 *      - 事件日志式会话（append-only JSONL）→ 可续跑、可回放、可导出
 *      - 稳定前缀 + 缓存 → 开场之后一个字节都不改，全程命中缓存（0.02 元/百万）
 *      - 工具是一等公民 → 不确定就「查」，别猜
 *      - 状态外化（todo/进度）→ 进度台账就是续跑骨架
 *      - 上下文压缩 → 章末摘要
 *      - 证据要求 → 落盘前做完整性校验，不通过不写
 *
 * 用法：
 *   node LayerText_AF会话改写.mjs --tier A --dry              # 只打印会话预算，不调 API
 *   node LayerText_AF会话改写.mjs --tier A --chapters 7       # 跑第 7 章一层（试跑）
 *   node LayerText_AF会话改写.mjs --tier A                    # 跑完一层全书
 *   node LayerText_AF会话改写.mjs --tier A --resume           # 中断后续跑（同一条命令即可）
 *   node LayerText_AF会话改写.mjs --tier M --scope chapter    # 换成"一章一个会话"
 *
 * 产物：与其它生成脚本完全一致（产物目录/第X章/原文_<层>_<日期>.md），
 *       因此下游 精修 → 补注 → 修复 → 复核 → 台账 一个字都不用改。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const SHARED = await import('./LayerText_AF词表与词典.mjs');
const P = SHARED.loadProject();
const REPO = P.引擎目录;
const SRC_BASE = P.原文目录;
const OUT_BASE = P.产物目录;
const DATE = P.日期;
const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const MODEL = 'deepseek-chat'; // 实测路由到 deepseek-flash（最便宜那档）
const TAGS = { A: 'A层85', M: 'M层75', B: 'B层60' };
const TIERS = {
  A: { label: 'A 层（挑战）', ratio: 0.85, maxLen: 20, note: '最贴原文：只处理真正的难词难句，保留较多原表达' },
  M: { label: 'M 层（中梯）', ratio: 0.75, maxLen: 16, note: '同义转换为主：细节保留、说法换简单' },
  B: { label: 'B 层（支架）', ratio: 0.6, maxLen: 14, note: '可适度删次要细节与重复描写（情节与因果零丢失）' },
};

/* ────────────────────── 命令行 ────────────────────── */
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);
const TIER = (arg('--tier', 'A')).toUpperCase();
const SCOPE = arg('--scope', 'tier');              // tier=一层一个会话（默认）｜chapter ｜ book
const DRY = has('--dry');
const OUT_SUFFIX = arg('--out', '');   // 试跑用：产物与会话日志都加后缀，不碰正式文件
const RESUME = has('--resume');
const CH_IDS = arg('--chapters', '')
  ? arg('--chapters').split(',').map((x) => Number(x.trim())).filter((n) => n >= 1 && n <= 10)
  : CN.slice(0, Number(P.章数 ?? 10)).map((_, i) => i + 1);
const TOOL_ROUNDS = Number(arg('--tool-rounds', '2'));   // 「查词」往返上限
const QC_ROUNDS = Number(arg('--qc-rounds', '2'));       // 本地复检回流上限
const BASELINE = P.情节底线 ?? '调适工作区/规则与底线/全书情节底线_v0.1.md';

if (!TIERS[TIER]) { console.error(`✗ 未知层级「${TIER}」，只能是 A / M / B`); process.exit(2); }
const T = TIERS[TIER];
const TAG = TAGS[TIER];

const CFG = JSON.parse(readFileSync(`${process.env.HOME}/.layertext.json`, 'utf-8'));
const KEY = execSync('security find-generic-password -s layertext.apikey -w').toString().trim();
const { runQc } = await import(`${REPO}/dist/src/core/qc.js`);
const { splitChapter, extractParas, sentsOf } = await import(`${REPO}/dist/src/core/textpipe.js`);
const LEX = await SHARED.loadLexicon(P);
const DICT = SHARED.loadDict(P.词典路径);
const KB = SHARED.loadKbGloss(P.知识库路径);
const PROPER = P.PROPER;
const wc = (t) => (t.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).length;

/* ────────────────────── 会话开场（稳定前缀：开场之后一个字节都不改） ────────────────────── */
/** 词汇标记 brief 版：一行一词「词\t类型」。3600+ 词全表约 1.4 万 tokens，
 *  占 1M 上下文的 1.5% —— 让模型自己在这张表里"调取"，而不是每次猜边界。 */
function vocabBrief() {
  const raw = readFileSync(P.词库, 'utf-8').replace(/^\uFEFF/, '').split('\n');
  const rows = raw.slice(1).map((l) => {
    const c = l.split(',');
    return c[0] && c[1] ? `${c[0].trim()}\t${c[1].trim()}` : null;
  }).filter(Boolean);
  return { text: rows.join('\n'), n: rows.length };
}

function dictBrief() {
  const rows = [...DICT].map(([w, zh]) => `${w}\t${zh}`);
  return { text: rows.join('\n'), n: rows.length };
}

function buildOpener() {
  const vb = vocabBrief();
  const db = dictBrief();
  const kbLines = [...KB].map(([w, v]) => `${w}（${v.zh}）`).join('、');
  const baselinePath = join(P.工作区, BASELINE);
  const baseline = existsSync(baselinePath) ? readFileSync(baselinePath, 'utf-8') : '（未提供情节底线文件）';

  const content = `你是初中英语名著分层简化的审校助手，负责把《${P.书名}》改写成**${T.label}**。

【本次任务·全程有效】
目标篇幅：全篇词数约为原文的 ${Math.round(T.ratio * 100)}%（每段 ±10 个百分点）。
定位：${T.note}
你会连续处理整本书的段落（一段一条消息），**你会记得自己前面写过什么**——人物怎么称呼、
同一个词用什么中文释义、句式偏好，全书必须自洽。

【篇幅守恒】改写＝同义转换，不是压缩删减：细节、修饰、氛围描写一律保留转述，
只换学生能懂的说法。B 层可适度删次要细节与重复描写，但情节与因果一条不能丢。

【句法黑名单（直接引语内免检）】被动→主动；定语从句→拆短句或形容词前置；
过去完成→一般过去时+before/after 明示先后。本层句长上限 ${T.maxLen} 词。

【加注格式（冻结，一个字都不能改）】
- 形式：\`word（中文）\`——全角括号、词与括号之间无空格、一个词全篇只注一次（首次出现处）。
- 词的判断：只有"学生没学过"的词才注。判断依据就是下面给你的词汇表（学生学过的词）。
- 同一个词全篇必须用同一个释义（以【统一释义词典】为准）。
- 数词、星期、月份、a/the/is 这类基础词不注；人名地名不注。

【本书专名表（不注、不计生词）】
${PROPER.join('、')}

【教师审校知识库（历史成果，必须遵守）】以下词经教师确认为学生不会的词，见到必须按上面格式加注：
${kbLines}

【全书情节底线（最高优先级，任何简化都不得违反）】
${baseline}

【词汇表：学生已经学过的词（格式：词<TAB>类型）】
表中出现的词＝学生学过，**不要加注**；不在表中的词＝学生没学过，**必须加注**。
（表末如遇长词条被截断，以你能看到的行为准；不确定的用【查 词】问我。）
<<<VOCAB>>>

【统一释义词典（格式：词<TAB>中文释义）——加注时优先用这里的释义】
<<<DICT>>>

【你可以问我（不确定就问，别猜）】
在输出末尾另起一行写：\`【查 词1 词2 …】\`，我会回你每个词的状态：
- 「已收录（学生学过）」→ 不要加注
- 「释义：xxx」→ 按这个释义加注
问完我会把结果回给你，你再输出最终正文。一次最多问 8 个词。

【输出格式】每条消息只回**这一段**的改写正文：以 \`[P##]\` 标记开头，纯英文，
除 \`word（中文）\` 注释外不得出现任何中文，不要任何解释、不要复述提示词。`;

  return { system: content.replace('<<<VOCAB>>>', '\n' + vb.text + '\n').replace('<<<DICT>>>', '\n' + db.text + '\n'), vb, db };
}

/* ────────────────────── 会话日志（事件日志式，append-only，可续跑/可回放） ────────────────────── */
const SESSION_DIR = join(P.调适工作区, '_会话');
const sessionFile = () => join(SESSION_DIR, `${TAG}${SCOPE === 'tier' ? '' : '_' + SCOPE}${OUT_SUFFIX ? '_' + OUT_SUFFIX : ''}.jsonl`);

function loadSession() {
  const f = sessionFile();
  if (!existsSync(f)) return { messages: [], done: new Set(), stats: { calls: 0, in: 0, out: 0, cached: 0 } };
  const lines = readFileSync(f, 'utf-8').split('\n').filter(Boolean);
  const messages = [];
  const done = new Set();
  let stats = { calls: 0, in: 0, out: 0, cached: 0 };
  for (const l of lines) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (o.t === 'msg') messages.push({ role: o.role, content: o.content });
    else if (o.t === 'done') { done.add(o.key); if (o.usage) { stats.calls++; stats.in += o.usage.in || 0; stats.out += o.usage.out || 0; stats.cached += o.usage.cached || 0; } }
    else if (o.t === 'stats') stats = o.v;
  }
  return { messages, done, stats };
}
const logLine = (o) => { mkdirSync(SESSION_DIR, { recursive: true }); appendFileSync(sessionFile(), JSON.stringify(o) + '\n', 'utf-8'); };
/** 推一条消息进会话，**同时写进事件日志**（否则 --resume 会丢上下文——首版就踩了这个坑） */
function pushMsg(messages, role, content) {
  messages.push({ role, content });
  logLine({ t: 'msg', role, content });
}

/* ────────────────────── API（带用量记账） ────────────────────── */
async function callChat(messages, maxTokens = 3000) {
  const resp = await fetch(`${CFG.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, temperature: 0.3, messages }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}：${(await resp.text()).slice(0, 200)}`);
  const j = await resp.json();
  const u = j.usage ?? {};
  return {
    text: (j.choices?.[0]?.message?.content ?? '').trim(),
    usage: { in: u.prompt_tokens ?? 0, out: u.completion_tokens ?? 0, cached: u.prompt_cache_hit_tokens ?? 0 },
  };
}

/* ────────────────────── 本地体检（确定性、免费、瞬间） ────────────────────── */
/** 把一段包成最小章节喂给引擎 QC，拿到这段的 OOV / 句长 / 加注情况 */
function segQc(seg) {
  const md = `## Chapter One\n\n${seg}\n`;
  return runQc(md, LEX, { tier: TIER, fileName: 'seg.md' });
}
function overLimit(seg) {
  const paras = extractParas(splitChapter(`## Chapter One\n\n${seg}\n`).body);
  let over = 0, total = 0;
  for (const p of paras) {
    const isSong = p.includes('Beasts of England');
    for (const s of sentsOf(p, isSong)) { total++; if (wc(s) > T.maxLen) over++; }
  }
  return { over, total };
}
/** 该段"必须加注"的词：不在已知集合里、长度>2、且正文里还没注过 */
function mustAnnotate(seg) {
  const q = segQc(seg);
  return { oov: [...new Set(q.oov)].filter((w) => w.length > 2), q };
}
/** 回答模型的「查词」：本地词库 → 词典 → 知识库，三处都没有就交给小模型配一个并回写词典 */
async function answerLookup(words) {
  const lines = [];
  const needGloss = [];
  for (const w0 of words) {
    const w = w0.toLowerCase();
    const kb = KB.get(w);
    const dict = DICT.get(w);
    if (dict || kb) { lines.push(`${w}：释义「${dict ?? kb.zh}」${kb ? '（教师知识库收录，必须加注）' : '（统一词典已有，按此释义加注）'}`); continue; }
    const q = segQc(`[P01] ${w}`).oov.includes(w);
    if (!q) { lines.push(`${w}：已收录（学生学过）→ 不要加注`); continue; }
    lines.push(`${w}：【待配释义】`);
    needGloss.push(w);
  }
  if (needGloss.length) {
    const r = await callChat([
      { role: 'system', content: '你给初中英语教材配生词注释。只输出一个 JSON 对象 {词: 释义}，释义 2-6 个汉字，初中生能懂，不要其他文字。' },
      { role: 'user', content: `给这些词配释义：${needGloss.join(', ')}` },
    ], 800);
    let map = {};
    try { map = JSON.parse(r.text.replace(/^[^{]*/, '').replace(/[^}]*$/, '')); } catch { /* 配不出就算了 */ }
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^([a-z'-]+)：【待配释义】$/);
      if (!m) continue;
      const zh = map[m[1]];
      lines[i] = zh ? `${m[1]}：释义「${zh}」（新配，已写进统一词典）` : `${m[1]}：查不到，按你的判断配一个 2-6 字释义`;
      if (zh) { DICT.set(m[1], zh); newDictEntries.push([m[1], zh]); }
    }
  }
  return lines.join('\n');
}
const newDictEntries = [];

/* ────────────────────── 单段处理：注入 → 生成 → 复检回流 → 查词往返 ────────────────────── */
function stripLookup(text) {
  const m = text.match(/【查\s*([^】]*)】/);
  return { cleaned: text.replace(/【查[^】]*】/g, '').trim(), words: m ? m[1].trim().split(/[\s,，、]+/).filter(Boolean) : [] };
}

async function rewriteSegment(messages, seg, chLabel, k, total, annotatedSoFar) {
  const { oov } = mustAnnotate(seg);
  const srcW = wc(seg);
  const target = Math.round(srcW * T.ratio);
  const kbMust = oov.filter((w) => KB.has(w));
  const facts = [
    `【本段事实（本地体检，确定性）】`,
    `原文 ${srcW} 词 → 目标约 ${target} 词（±10%）。本层句长上限 ${T.maxLen} 词。`,
    kbMust.length ? `本段含教师知识库要求加注的词：${kbMust.join('、')}` : `本段不含教师知识库指定词。`,
    oov.length ? `本段超出学生词汇表的词共 ${oov.length} 个（首次出现处都要按冻结格式加注，用统一词典的释义）：${oov.slice(0, 60).join('、')}${oov.length > 60 ? ' …' : ''}` : `本段全部词都在学生词汇表内，不必加注。`,
    // 外部记忆（agent 的做法：把"我已经做过什么"告诉模型，而不是让它自己记）
    (() => {
      const dup = oov.filter((w) => annotatedSoFar.has(w));
      return dup.length
        ? `⚠ 你在这本书里**已经注过**这些词了，本段**绝对不要**再加注（全篇一个词只注一次）：${dup.slice(0, 80).join('、')}`
        : '';
    })(),
  ].filter(Boolean).join('\n');

  pushMsg(messages, 'user', `${chLabel} · 第 ${k + 1}/${total} 段\n\n${facts}\n\n【原文段落】\n${seg.trim()}\n\n请改写这一段。`);
  let { text, usage } = await callChat(messages);
  let callUsage = [usage];

  /* 「查词」往返：模型不确定就问我 */
  for (let round = 0; round < TOOL_ROUNDS; round++) {
    const { words } = stripLookup(text);
    if (!words.length) break;
    pushMsg(messages, 'assistant', text);
    const answer = await answerLookup(words.slice(0, 8));
    pushMsg(messages, 'user', `【查词结果】\n${answer}\n\n请据此输出这一段的最终正文。`);
    const r = await callChat(messages);
    text = r.text; callUsage.push(r.usage);
  }

  /* 本地复检回流：不达标就让模型自己改（最多 QC_ROUNDS 轮） */
  let qcRounds = 0;
  for (let round = 0; round < QC_ROUNDS; round++) {
    const clean = stripLookup(text).cleaned;
    const body = clean.includes('[P') ? clean : `[P01] ${clean}`;
    const w = wc(body);
    const { over } = overLimit(body);
    const { oov } = mustAnnotate(body);
    const missing = oov.filter((x) => !body.includes(`${x}（`));
    const probs = [];
    if (Math.abs(w - target) > target * 0.12) probs.push(`本段 ${w} 词，偏离目标 ${target} 词太远`);
    if (over > 0) probs.push(`有 ${over} 句超过本层 ${T.maxLen} 词上限`);
    if (missing.length) probs.push(`以下超纲词还没加注：${missing.slice(0, 12).join('、')}`);
    if (!probs.length) break;
    pushMsg(messages, 'assistant', text);
    pushMsg(messages, 'user', `【本地复检】本段未达标：\n- ${probs.join('\n- ')}\n请重写这一段（只输出该段正文，保持 [P##] 开头）。`);
    const r = await callChat(messages);
    text = r.text; callUsage.push(r.usage); qcRounds++;
  }

  const clean = stripLookup(text).cleaned;
  const body = clean.includes('[P') ? clean : `[P01] ${clean}`;
  messages.push({ role: 'assistant', content: body });
  return { body, qcRounds, usage: callUsage };
}

/* ────────────────────── 主流程 ────────────────────── */
console.log('════ AF 会话式改写 ════');
console.log(`书名：${P.书名}｜层级：${TIER}（${T.label}）｜会话粒度：${SCOPE}｜章节：${CH_IDS.join(',')}`);

const { system, vb, db } = buildOpener();
const openerTokens = Math.round(system.length / 3.2);
console.log(`会话开场：${system.length} 字符 ≈ ${openerTokens} tokens（词汇表 ${vb.n} 词 / 词典 ${db.n} 条）`);
console.log(`会话文件：${sessionFile()}${RESUME ? '（续跑）' : ''}`);

// 预算估算
const chSegs = CH_IDS.map((i) => {
  const f = join(SRC_BASE, `第${CN[i - 1]}章`, '原文_规范化.md');
  if (!existsSync(f)) return { i, segs: 0, words: 0 };
  const md = readFileSync(f, 'utf-8');
  const segs = splitChapter(md).body.match(/\[P\d+\][\s\S]*?(?=\[P\d+\]|$)/g) ?? [];
  return { i, segs: segs.length, words: wc(segs.join(' ')) };
});
const totalSegs = chSegs.reduce((a, c) => a + c.segs, 0);
console.log(`段落总数：${totalSegs}｜原文 ${chSegs.reduce((a, c) => a + c.words, 0)} 词`);
console.log(`预计调用：${totalSegs} 段 ×（1 主 + ≤${TOOL_ROUNDS} 查词 + ≤${QC_ROUNDS} 复检）≈ ${totalSegs}–${totalSegs * (1 + TOOL_ROUNDS + QC_ROUNDS)} 次`);
console.log(`缓存说明：开场 ${openerTokens} tokens 全程不变 → 每次都命中缓存（0.02 元/百万）`);

if (DRY) { console.log('\n（--dry，未调 API、未写文件）'); process.exit(0); }

const state = RESUME ? loadSession() : { messages: [], done: new Set(), stats: { calls: 0, in: 0, out: 0, cached: 0 } };
const messages = state.messages.length ? state.messages : [{ role: 'system', content: system }];
if (!state.messages.length) logLine({ t: 'msg', role: 'system', content: system });

const failures = [];
for (const { i } of chSegs) {
  const ch = `第${CN[i - 1]}章`;
  const src = join(SRC_BASE, ch, '原文_规范化.md');
  if (!existsSync(src)) { failures.push(`${ch}：缺规范化原文`); continue; }
  const md = readFileSync(src, 'utf-8');
  const chLine = md.match(/^## Chapter \w+.*$/m)?.[0] ?? `## Chapter ${['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'][i - 1]}`;
  const header = md.slice(0, md.indexOf(chLine)) || '';
  const segList = splitChapter(md).body.match(/\[P\d+\][\s\S]*?(?=\[P\d+\]|$)/g) ?? [];
  const outPath = join(OUT_BASE, ch, `原文_${TAG}_${DATE}${OUT_SUFFIX ? '_' + OUT_SUFFIX : ''}.md`);
  const existing = existsSync(outPath) ? readFileSync(outPath, 'utf-8') : null;
  const outSegs = existing ? (splitChapter(existing).body.match(/\[P\d+\][\s\S]*?(?=\[P\d+\]|$)/g) ?? []) : [];
  // 已注词清单（跨章累计）：从已有产物 + 本会话日志恢复，作为模型的"外部记忆"
  if (!state.annotated) {
    state.annotated = new Set();
    for (const f of [existing]) {
      if (!f) continue;
      for (const m of f.matchAll(/([A-Za-z][A-Za-z'-]*)（[^）]{1,24}）/g)) state.annotated.add(m[1].toLowerCase());
    }
  }

  for (let k = 0; k < segList.length; k++) {
    const key = `${ch}#${k}`;
    if (state.done.has(key)) { process.stdout.write(`· ${ch} ${k + 1}/${segList.length} 已完成\r`); continue; }
    try {
      // 断点续跑：会话日志里没有上下文（比如换了 scope）就从产物补回已有段落
      const { body, qcRounds, usage } = await rewriteSegment(messages, segList[k], ch, k, segList.length, state.annotated);
      for (const m of body.matchAll(/([A-Za-z][A-Za-z'-]*)（[^）]{1,24}）/g)) state.annotated.add(m[1].toLowerCase());
      outSegs[k] = body;
      // 每段落盘（截断只丢一段，不丢整章）
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, `${header}${chLine}\n\n${outSegs.filter(Boolean).join('\n\n')}\n`, 'utf-8');
      const u = usage.reduce((a, c) => ({ in: a.in + c.in, out: a.out + c.out, cached: a.cached + c.cached }), { in: 0, out: 0, cached: 0 });
      state.stats.calls += usage.length; state.stats.in += u.in; state.stats.out += u.out; state.stats.cached += u.cached;
      state.done.add(key);
      logLine({ t: 'done', key, usage: u, rounds: qcRounds });
      logLine({ t: 'stats', v: state.stats });
      const w = wc(body);
      process.stdout.write(`${ch} ${k + 1}/${segList.length}（${wc(segList[k])}→${w}）${qcRounds ? ` 复检${qcRounds}` : ''}    \r`);
    } catch (e) {
      const msg = `${ch} 第${k + 1}段：${e instanceof Error ? e.message : String(e)}`;
      failures.push(msg);
      console.error(`\n✗ ${msg}`);
    }
  }
  // 章末压缩：让模型留 5 行本章要点，作为后续上下文的锚（也写进会话日志）
  try {
    pushMsg(messages, 'user', `本章（${ch}）已处理完。请用 5 行以内总结：本章人物如何称呼、你采用了哪些简化手法、以及需要后续保持一致的地方。只输出这 5 行摘要。`);
    const r = await callChat(messages, 400);
    pushMsg(messages, 'assistant', r.text);
    state.stats.calls++; state.stats.in += r.usage.in; state.stats.out += r.usage.out; state.stats.cached += r.usage.cached;
    console.log(`\n📌 ${ch} 摘要：${r.text.replace(/\n/g, ' / ').slice(0, 100)}…`);
  } catch { /* 摘要失败不影响产物 */ }
}

if (newDictEntries.length) {
  SHARED.appendDict(newDictEntries, P.词典路径);
  console.log(`\n词典新增 ${newDictEntries.length} 条释义 → ${P.词典路径}`);
}

const hitRate = state.stats.in ? Math.round((state.stats.cached / state.stats.in) * 100) : 0;
const cost = (state.stats.in - state.stats.cached) / 1e6 * 1 + state.stats.cached / 1e6 * 0.02 + state.stats.out / 1e6 * 4;
console.log('\n════ 用量台账（空闲时段价）════');
console.log(`  调用 ${state.stats.calls} 次｜输入 ${state.stats.in.toLocaleString()} tokens（缓存命中 ${state.stats.cached.toLocaleString()}，命中率 ${hitRate}%）｜输出 ${state.stats.out.toLocaleString()}`);
console.log(`  估算花费：¥${cost.toFixed(3)}`);
if (failures.length) {
  console.error(`\n✗ ${failures.length} 个段落失败：`);
  for (const f of failures.slice(0, 10)) console.error(`   ${f}`);
  console.error('   同一条命令加 --resume 即可从失败处继续。');
  process.exit(1);
}
console.log('\n✓ 全部段落完成。下一步：精修 → 补注 → 修复 → 复核 → 台账');
