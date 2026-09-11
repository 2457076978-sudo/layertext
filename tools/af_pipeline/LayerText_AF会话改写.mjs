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
 * ★ 2026-09-11 审查报告 P0 修复：「复检不通过」现在是**不可完成状态**
 *   原实现：每段复检跑到上限后**照常落盘并标 done**，只有抛异常才进 failures
 *   → 反复不达标的段落能一路进最终书稿而不触发失败（确定性门禁形同虚设）。
 *   现实现：
 *     · 判定统一交给引擎的 `src/core/segmentgate.ts`（纯函数、可单测、有规则号）
 *     · 复检循环**每一轮产出都判定**，循环跑满后仍有一轮终检（原实现最后一次改写从未被检）
 *     · needs-review 的段：不写进正文、不进 state.done、落隔离目录 `_待复核/`、
 *       记进失败清单，**不写运行完成标记**，进程非零退出
 *     · 事实类（数字/专名）与重复注释/释义冲突是 warn：不阻塞，但进段级风险队列
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
 *       另有：产物目录/_运行/<层>.完成.json（只在全部通过时写）、
 *             产物目录/_运行/<层>.待复核.json（失败清单）、
 *             产物目录/_待复核/<层>/…（未通过段落，隔离存放）
 *
 * 自检（不调 API）：LAYERTEXT_FAKE_LLM=long|exact node … --out _t
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const SHARED = await import('./LayerText_AF词表与词典.mjs');
const P = SHARED.loadProject();
const { REVIEW_PLACEHOLDER, segmentList } = SHARED;
const REPO = P.引擎目录;
const SRC_BASE = P.原文目录;
const OUT_BASE = P.产物目录;
const DATE = P.日期;
const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const MODEL = 'deepseek-chat'; // 实测路由到 deepseek-flash（最便宜那档）
/** 提示词版本：开场措辞、复检回流措辞、冻结格式改动时**必须**递增。
 *  与段级输入哈希一起进事件日志，失败复现时能定位"是哪版提示词写的这段"。 */
const PROMPT_VERSION = 'session-v3-20260911';
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
/** 自检用假模型：long=永远超长（必不过）｜exact=按目标词数精确回放原文（必过）｜其他=字面返回。
 *  有了它，"门禁真的拦得住"这件事才能被自动化断言，而不靠人肉试。 */
const FAKE_LLM = process.env.LAYERTEXT_FAKE_LLM;

if (!TIERS[TIER]) { console.error(`✗ 未知层级「${TIER}」，只能是 A / M / B`); process.exit(2); }
const T = TIERS[TIER];
const TAG = TAGS[TIER];
const SUFFIX = OUT_SUFFIX ? '_' + OUT_SUFFIX : '';

const CFG = (() => {
  try { return JSON.parse(readFileSync(`${process.env.HOME}/.layertext.json`, 'utf-8')); }
  catch { return { baseUrl: 'https://api.deepseek.com' }; }
})();
/** API key 惰性读取：--dry、假模型、纯本地路径都不该碰钥匙串 */
let _key = null;
const apiKey = () => {
  if (_key === null) _key = execSync('security find-generic-password -s layertext.apikey -w').toString().trim();
  return _key;
};

const { gateSegment, normalizeSegmentBody } = await import(`${REPO}/dist/src/core/segmentgate.js`);
const { splitChapter } = await import(`${REPO}/dist/src/core/textpipe.js`);
const { runQc } = await import(`${REPO}/dist/src/core/qc.js`);
const LEX = await SHARED.loadLexicon(P);
const DICT = SHARED.loadDict(P.词典路径);
const KB = SHARED.loadKbGloss(P.知识库路径);
const PROPER = P.PROPER;
const wc = (t) => (t.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).length;
const sha = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 16);

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
  const baselinePath = P.工作区 ? join(P.工作区, BASELINE) : '';
  const baseline = baselinePath && existsSync(baselinePath) ? readFileSync(baselinePath, 'utf-8') : '（未提供情节底线文件）';

  const content = `你是初中英语名著分层简化的审校助手，负责把《${P.书名}》改写成**${T.label}**。

【本次任务·全程有效】
目标篇幅：全篇词数约为原文的 ${Math.round(T.ratio * 100)}%（每段 ±10 个百分点）。
定位：${T.note}
你会连续处理整本书的段落（一段一条消息），**你会记得自己前面写过什么**——人物怎么称呼、
同一个词用什么中文释义、句式偏好，全书必须自洽。

【篇幅守恒】改写＝同义转换，不是压缩删减：细节、修饰、氛围描写一律保留转述，
只换学生能懂的说法。B 层可适度删次要细节与重复描写，但情节与因果一条不能丢。
**原文里的数字、日期、专名一个都不能改、不能丢。**

【句法黑名单（直接引语内免检）】被动→主动；定语从句→拆短句或形容词前置；
过去完成→一般过去时+before/after 明示先后。本层句长上限 ${T.maxLen} 词。

【加注格式（冻结，一个字都不能改）】
- 形式：\`word（中文）\`——全角括号、词与括号之间无空格、一个词全篇只注一次（首次出现处）。
- 词的判断：只有"学生没学过"的词才注。判断依据就是下面给你的词汇表（学生学过的词）。
- 同一个词全篇必须用同一个释义（以【统一释义词典】为准）。
- 数词、星期、月份、a/the/is 这类基础词不注；人名地名不注。
- 教学上想让学生再遇到一次同一个词时，**不要再加注**（重复注释会被判不合格），
  靠正文复现即可 —— 复现提示由词卡层负责，不占正文注释。

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
const sessionFile = () => join(SESSION_DIR, `${TAG}${SCOPE === 'tier' ? '' : '_' + SCOPE}${SUFFIX}.jsonl`);
const RUN_DIR = join(OUT_BASE, '_运行');
const REVIEW_DIR = join(OUT_BASE, '_待复核', `${TAG}${SUFFIX}`);
const doneMarker = () => join(RUN_DIR, `${TAG}${SUFFIX}.完成.json`);
const reviewMarker = () => join(RUN_DIR, `${TAG}${SUFFIX}.待复核.json`);

function loadSession() {
  const f = sessionFile();
  if (!existsSync(f)) return { messages: [], done: new Set(), stats: { calls: 0, in: 0, out: 0, cached: 0 }, warnings: [] };
  const lines = readFileSync(f, 'utf-8').split('\n').filter(Boolean);
  const messages = [];
  const done = new Set();
  const warnings = [];
  let stats = { calls: 0, in: 0, out: 0, cached: 0 };
  for (const l of lines) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (o.t === 'msg') messages.push({ role: o.role, content: o.content });
    else if (o.t === 'done') { done.add(o.key); if (o.usage) { stats.calls++; stats.in += o.usage.in || 0; stats.out += o.usage.out || 0; stats.cached += o.usage.cached || 0; } }
    else if (o.t === 'warning') warnings.push(o);
    else if (o.t === 'stats') stats = o.v;
  }
  return { messages, done, stats, warnings };
}
const logLine = (o) => { mkdirSync(SESSION_DIR, { recursive: true }); appendFileSync(sessionFile(), JSON.stringify(o) + '\n', 'utf-8'); };
/** 推一条消息进会话，**同时写进事件日志**（否则 --resume 会丢上下文——首版就踩了这个坑） */
function pushMsg(messages, role, content) {
  messages.push({ role, content });
  logLine({ t: 'msg', role, content });
}
/** 吞错不许静默：warning 进事件日志并计入汇总报告（审查报告第②条） */
function warn(kind, message, extra = {}) {
  const ev = { t: 'warning', kind, message, at: new Date().toISOString(), ...extra };
  logLine(ev);
  state.warnings.push(ev);
  console.warn(`⚠ ${message}`);
}

/* ────────────────────── API（带用量记账 + 自检假模型） ────────────────────── */
/** 假模型：从最后一条 user 消息里还原原文段与目标词数，产出确定性的"响应"。
 *  long  = 一段 120 词的超长句（篇幅+句长双超标 → 必不过门禁）
 *  exact = 按目标词数精确回放原文（可通过门禁，用于验证"通过路径确实写了完成标记"） */
function fakeChat(messages) {
  // 注意：复检回流那一轮的"最后一条 user 消息"是反馈而不是原文段，
  // 所以要取**最后一条含原文段**的消息，否则重写轮会退化成无原文的瞎写。
  const segOf = (m) => m.content.match(/【原文段落】\n([\s\S]*?)\n\n请改写这一段/)?.[1];
  const withSeg = [...messages].reverse().filter((m) => m.role === 'user').map(segOf).find(Boolean);
  const seg = withSeg ?? [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const target = Math.round(wc(seg) * T.ratio);
  if (FAKE_LLM === 'long') {
    return { text: `[P01] ${Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ')}.`, usage: { in: 0, out: 0, cached: 0 } };
  }
  if (FAKE_LLM === 'exact') {
    const words = (seg.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).filter((w) => w !== 'P');
    const head = `[P01] ${words.slice(0, Math.max(1, target - 1)).join(' ')}`;
    return { text: head, usage: { in: 0, out: 0, cached: 0 } };
  }
  return { text: FAKE_LLM, usage: { in: 0, out: 0, cached: 0 } };
}

async function callChat(messages, maxTokens = 3000) {
  if (FAKE_LLM !== undefined) return fakeChat(messages);
  const resp = await fetch(`${CFG.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey()}` },
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
  return runQc(md, LEX, { tier: TIER, fileName: 'seg.md', dict: DICT });
}
/** 该段"必须加注"的词：不在已知集合里、长度>2 */
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
    try { map = JSON.parse(r.text.replace(/^[^{]*/, '').replace(/[^}]*$/, '')); } catch { warn('lookup-parse', `「查词」释义 JSON 解析失败，回退为让模型自行判断：${r.text.slice(0, 80)}`); }
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

/* ────────────────────── 单段判定：交给引擎的段级门禁 ────────────────────── */
function stripLookup(text) {
  const m = text.match(/【查\s*([^】]*)】/);
  return { cleaned: text.replace(/【查[^】]*】/g, '').trim(), words: m ? m[1].trim().split(/[\s,，、]+/).filter(Boolean) : [] };
}

/** 段级判定：篇幅 / 句长 / 漏注 / 注释外中文 是 blocker（不过就不可完成）；
 *  数字专名丢失 / 重复注释 / 释义冲突是 warn（进风险队列）。
 *  应注词型 = 原文 OOV ∪ 改写后 OOV —— 改写新引入的难词同样要注。 */
function verifySegment(text, seg, target, srcOov, markerId) {
  const body = normalizeSegmentBody(text, markerId);
  const outOov = mustAnnotate(body).oov;
  const union = [...new Set([...srcOov, ...outOov])];
  const verdict = gateSegment({ text: body, source: seg, target, maxLen: T.maxLen, oov: union, dict: DICT, markerId });
  verdict.srcOov = srcOov;
  verdict.outOov = outOov;
  return verdict;
}

/* ────────────────────── 单段处理：注入 → 生成 → 复检回流 → 查词往返 ────────────────────── */
async function rewriteSegment(messages, seg, chLabel, k, total, annotatedSoFar, markerId) {
  const { oov: srcOov } = mustAnnotate(seg);
  const srcW = wc(seg);
  const target = Math.round(srcW * T.ratio);
  const kbMust = srcOov.filter((w) => KB.has(w));
  const facts = [
    `【本段事实（本地体检，确定性）】`,
    `原文 ${srcW} 词 → 目标约 ${target} 词（±10%）。本层句长上限 ${T.maxLen} 词。`,
    kbMust.length ? `本段含教师知识库要求加注的词：${kbMust.join('、')}` : `本段不含教师知识库指定词。`,
    srcOov.length ? `本段超出学生词汇表的词共 ${srcOov.length} 个（首次出现处都要按冻结格式加注，用统一词典的释义）：${srcOov.slice(0, 60).join('、')}${srcOov.length > 60 ? ' …' : ''}` : `本段全部词都在学生词汇表内，不必加注。`,
    // 外部记忆（agent 的做法：把"我已经做过什么"告诉模型，而不是让它自己记）
    (() => {
      const dup = srcOov.filter((w) => annotatedSoFar.has(w));
      return dup.length
        ? `⚠ 你在这本书里**已经注过**这些词了，本段**绝对不要**再加注（全篇一个词只注一次）：${dup.slice(0, 80).join('、')}`
        : '';
    })(),
  ].filter(Boolean).join('\n');

  const inputHash = sha(`${PROMPT_VERSION}|${seg}|${target}|${T.maxLen}`);
  pushMsg(messages, 'user', `${chLabel} · 第 ${k + 1}/${total} 段\n\n${facts}\n\n【原文段落】\n${seg.trim()}\n\n请改写这一段。`);
  let { text, usage } = await callChat(messages);
  const callUsage = [usage];

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

  /* 本地复检回流：不达标就让模型自己改（最多 QC_ROUNDS 轮）。
   * ★ 与原实现的两处差别（都是 P0）：
   *   ① 每一轮的产出都判定（原来只在"下一轮开始时"判定，最后一次改写从未被检）
   *   ② 循环跑满仍不过 → status='needs-review'，由调用方按"不可完成"处理 */
  const attempts = [];
  let verdict = verifySegment(text, seg, target, srcOov, markerId);
  while (verdict.status !== 'pass' && attempts.length < QC_ROUNDS) {
    attempts.push({ problems: verdict.problems.map((p) => p.ruleId), words: verdict.words });
    pushMsg(messages, 'assistant', text);
    pushMsg(
      messages,
      'user',
      `【本地复检】本段未达标：\n- ${verdict.blockers.map((p) => p.message).join('\n- ')}\n请重写这一段（只输出该段正文，保持 [P##] 开头）。`,
    );
    const r = await callChat(messages);
    text = r.text; callUsage.push(r.usage);
    verdict = verifySegment(text, seg, target, srcOov, markerId);
  }

  const body = normalizeSegmentBody(text, markerId);
  if (verdict.status === 'pass') {
    // 通过的段也要写进事件日志：否则 --resume 重建的会话缺助手回合，
    // 模型看到的是一串连续 user 消息（首版就踩过这个坑）。
    pushMsg(messages, 'assistant', body);
  } else {
    pushMsg(messages, 'assistant', body);
    pushMsg(
      messages,
      'user',
      `【未通过】本段复检未通过（规则 ${verdict.blockers.map((p) => p.ruleId).join('、')}），` +
        `已移出正文、转人工复核队列。请继续后面的段落，但不要以为本段已定稿。`,
    );
  }
  return { status: verdict.status, body, verdict, attempts, qcRounds: attempts.length, usage: callUsage, inputHash };
}

/* ────────────────────── 主流程 ────────────────────── */
console.log('════ AF 会话式改写 ════');
console.log(`书名：${P.书名}｜层级：${TIER}（${T.label}）｜会话粒度：${SCOPE}｜章节：${CH_IDS.join(',')}`);
console.log(`提示词版本：${PROMPT_VERSION}${FAKE_LLM !== undefined ? `｜⚠ 自检假模型：${FAKE_LLM}（不调 API）` : ''}`);

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

const state = RESUME ? loadSession() : { messages: [], done: new Set(), stats: { calls: 0, in: 0, out: 0, cached: 0 }, warnings: [] };
if (!state.warnings) state.warnings = [];
const messages = state.messages.length ? state.messages : [{ role: 'system', content: system }];
if (!state.messages.length) logLine({ t: 'msg', role: 'system', content: system });

const failures = [];   // 读取/异常类失败
const reviews = [];    // 门禁未通过（needs-review）——**不可完成**
for (const { i } of chSegs) {
  const ch = `第${CN[i - 1]}章`;
  const src = join(SRC_BASE, ch, '原文_规范化.md');
  if (!existsSync(src)) { failures.push(`${ch}：缺规范化原文`); continue; }
  const md = readFileSync(src, 'utf-8');
  const chLine = md.match(/^## Chapter \w+.*$/m)?.[0] ?? `## Chapter ${['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'][i - 1]}`;
  const header = md.slice(0, md.indexOf(chLine)) || '';
  const segList = segmentList(md);   // [{id:'P07', text:'[P07] …'}]——段号是稳定 ID
  const srcText = (k) => segList[k].text;
  const outPath = join(OUT_BASE, ch, `原文_${TAG}_${DATE}${SUFFIX}.md`);
  const existing = existsSync(outPath) ? readFileSync(outPath, 'utf-8') : null;
  const outSegs = existing ? (splitChapter(existing).body.match(/\[P\d+\][\s\S]*?(?=\[P\d+\]|$)/g) ?? []) : [];
  // 已注词清单（跨章累计）：从已有产物恢复，作为模型的"外部记忆"
  if (!state.annotated) {
    state.annotated = new Set();
    if (existing) for (const m of existing.matchAll(/([A-Za-z][A-Za-z'-]*)（[^）]{1,24}）/g)) state.annotated.add(m[1].toLowerCase());
  }

  for (let k = 0; k < segList.length; k++) {
    const key = `${ch}#${k}`;
    if (state.done.has(key)) { process.stdout.write(`· ${ch} ${k + 1}/${segList.length} 已完成\r`); continue; }
    try {
      const { status, body, verdict, attempts, qcRounds, usage, inputHash } = await rewriteSegment(
        messages, srcText(k), ch, k, segList.length, state.annotated, segList[k].id,
      );
      const u = usage.reduce((a, c) => ({ in: a.in + c.in, out: a.out + c.out, cached: a.cached + c.cached }), { in: 0, out: 0, cached: 0 });
      state.stats.calls += usage.length; state.stats.in += u.in; state.stats.out += u.out; state.stats.cached += u.cached;
      logLine({ t: 'stats', v: state.stats });

      if (status === 'needs-review') {
        // ★ 不可完成状态：不进正文、不进 done、写隔离目录、进失败清单
        //   正文里留一个 HTML 注释占位：人打开文件能看见缺口，QC 分句不会把它算成内容，
        //   且**保住后面段落的位置**（否则第 8 段的原句会对到第 7 段的改写上，风险队列全错）。
        outSegs[k] = REVIEW_PLACEHOLDER(segList[k].id, `_待复核/${TAG}${SUFFIX}/`);
        const rec = {
          chapter: ch, segIndex: k, segLabel: `${ch} 第${k + 1}段`, key,
          source: srcText(k).trim(), body, status,
          blockers: verdict.blockers, warns: verdict.warns, attempts,
          inputHash, promptVersion: PROMPT_VERSION, model: MODEL,
          annotation: verdict.annotation, words: verdict.words, target: verdict.target,
        };
        mkdirSync(REVIEW_DIR, { recursive: true });
        writeFileSync(join(REVIEW_DIR, `${ch}_第${k + 1}段.md`), `[P${String(k + 1).padStart(2, '0')}] ${body.replace(/^\[P\d+\]\s*/, '')}\n`, 'utf-8');
        writeFileSync(join(REVIEW_DIR, `${ch}_第${k + 1}段.json`), JSON.stringify(rec, null, 2), 'utf-8');
        logLine({ t: 'review', key, rules: verdict.blockers.map((p) => p.ruleId), problems: verdict.blockers, inputHash, promptVersion: PROMPT_VERSION });
        reviews.push(rec);
        console.error(`\n✗ ${ch} 第${k + 1}段 复检未通过（${verdict.blockers.map((p) => p.ruleId).join('、')}）→ 已隔离，未写入正文`);
      } else {
        for (const m of body.matchAll(/([A-Za-z][A-Za-z'-]*)（[^）]{1,24}）/g)) state.annotated.add(m[1].toLowerCase());
        outSegs[k] = body;
        state.done.add(key);
        logLine({ t: 'done', key, usage: u, rounds: qcRounds, status, inputHash, promptVersion: PROMPT_VERSION, rules: verdict.warns.map((p) => p.ruleId) });
      }
      // 每段落盘（截断只丢一段，不丢整章）。未通过的段留空位——空位是可见的，
      // 而"把没过的段写进去"是不可见的，后者正是 P0 要杜绝的。
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, `${header}${chLine}\n\n${outSegs.filter(Boolean).join('\n\n')}\n`, 'utf-8');
      const mark = status === 'pass' ? '' : '  ✗待复核';
      process.stdout.write(`${ch} ${k + 1}/${segList.length}（${wc(srcText(k))}→${verdict.words}）${qcRounds ? ` 复检${qcRounds}` : ''}${mark}    \r`);
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
  } catch (e) {
    // 原来这里是 catch {}：摘要失败会让后续一致性下降却显示成功。降级为 warning 并计数。
    warn('chapter-summary', `${ch} 章末摘要失败（后续上下文锚缺失，一致性可能下降）：${e instanceof Error ? e.message : String(e)}`, { chapter: ch });
  }
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

/* ────────────────────── 收尾：完成标记 / 失败清单 / 退出码 ────────────────────── */
mkdirSync(RUN_DIR, { recursive: true });
const incomplete = reviews.length + failures.length;
// 上一次跑成功留下的完成标记，必须在本轮不完整时**作废**——否则旧标记会掩盖新失败
if (incomplete && existsSync(doneMarker())) {
  rmSync(doneMarker());
  console.log('（上一轮的完成标记已作废：本轮有未完成段落）');
}
const runSummary = {
  层级: TIER, 会话粒度: SCOPE, 日期: DATE, 模型: MODEL, 提示词版本: PROMPT_VERSION,
  书名: P.书名, 章节: CH_IDS, 段落总数: totalSegs,
  已完成: state.done.size, 待复核: reviews.length, 失败: failures.length,
  用量: state.stats, 缓存命中率: hitRate, 估算花费: Number(cost.toFixed(4)),
  warnings: state.warnings.map((w) => ({ kind: w.kind, message: w.message })),
};
if (incomplete) {
  writeFileSync(reviewMarker(), JSON.stringify({ ...runSummary, 待复核明细: reviews.map((r) => ({ 位置: r.segLabel, 规则: r.blockers.map((p) => p.ruleId), 问题: r.blockers.map((p) => p.message) })), 失败明细: failures }, null, 2), 'utf-8');
  console.error(`\n✗ 本层未完成：待复核 ${reviews.length} 段｜异常失败 ${failures.length} 段`);
  for (const r of reviews.slice(0, 10)) console.error(`   ${r.segLabel}：${r.blockers.map((p) => p.ruleId).join('、')} — ${r.blockers[0]?.message ?? ''}`);
  for (const f of failures.slice(0, 10)) console.error(`   ${f}`);
  console.error(`   隔离目录：${REVIEW_DIR}`);
  console.error(`   失败清单：${reviewMarker()}`);
  console.error('   未写完成标记。同一条命令加 --resume 即可从失败处继续（未通过的段不在 done 里，会被重跑）。');
  process.exit(1);
}
if (state.warnings.length) console.warn(`\n⚠ 本轮有 ${state.warnings.length} 条 warning（详见运行清单与事件日志），不阻塞完成。`);
writeFileSync(doneMarker(), JSON.stringify({ ...runSummary, 完成时间: new Date().toISOString() }, null, 2), 'utf-8');
if (existsSync(reviewMarker())) rmSync(reviewMarker());
console.log(`\n✓ 全部段落通过门禁。完成标记：${doneMarker()}`);
console.log('下一步：精修 → 补注 → 修复 → 复核 → 台账');
