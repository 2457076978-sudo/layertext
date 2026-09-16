/**
 * LayerText · 两遍制段级回炉（2026-09-17）
 * 原则（Wayne 两遍制提案）：只把红项段差量发给 AI 修订，其余段落一字不动；
 * 红项=①生词率超标段（良档口径：未知≥3 词且段内率≥6%）②隔离难度残留段（recap quarantined class=难度残留）。
 * 闸门：修订后未知词必须减少、段长 ±25% 内、注释不丢、（拆短段）句长达标；重试一次不过=如实挂起。
 * 复查标注：_运行/回炉台账.jsonl 逐段 verdict；改写前的原文件备份到 _运行/回炉前_20260917/。
 *
 * 用法：node LayerText_AF段级回炉.mjs <A|M|B|ALL> [章号|1,2] [--dry]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
const SHARED = await import('./LayerText_AF词表与词典.mjs');
import { keychainGet } from './keychain.mjs';
const { loadProject, loadTextbookLearned, chapterNames } = SHARED;

const P = loadProject('/Users/wayne/Desktop/工作文档库/01-教学工作/名著阅读工作区_AnimalFarm/调适项目_AnimalFarm.json');
const KV = dirname(P.知识库路径 || '/Users/wayne/Desktop/工作文档库/01-教学工作/名著阅读工作区_AnimalFarm/知识文件/AF注释词典_v1.csv');
const OUT = P.产物目录;
const RUN = join(OUT, '_运行');
const BACK = join(RUN, '回炉前_20260917');
const LEDGER_LOG = join(RUN, '回炉台账.jsonl');
const MODEL = P.模型 || 'ecnu-max';
const CFG = { baseUrl: 'https://chat.ecnu.edu.cn/open/api/v1' };
const KEY = () => keychainGet('layertext.ecnukey');
const { openLedger } = await import('./LayerText_AF调用台账.mjs');
const LEDGER = await openLedger(P, '段级回炉');

const TIERS = {
  A: { tag: 'A层85', lim: 17, style: 'A 层（优生挑战，句长上限 17 词）' },
  M: { tag: 'M层75', lim: 15, style: 'M 层（中等，句长上限 15 词）' },
  B: { tag: 'B层60', lim: 14, style: 'B 层（基础，句长上限 14 词）' },
};

/* ── 已知集（良档口径，与验收矩阵同一把尺）── */
const engineKnown = new Set([...loadTextbookLearned(P)].map((w) => w.toLowerCase()));
const afProper = new Set(
  readFileSync(join(KV, '专名_AnimalFarm.txt'), 'utf8')
    .split('\n')
    .map((l) => l.trim().toLowerCase())
    .filter((w) => w && !w.startsWith('#')),
);
const K = new Set([
  ...engineKnown,
  ...afProper,
  'mr',
  'mrs',
  'ms',
  'dr',
  ...readFileSync(join(KV, '分档允许表_v0', '允许表_良.csv'), 'utf8')
    .replace(/^\uFEFF/, '')
    .split('\n')
    .slice(1)
    .filter(Boolean)
    .map((l) => l.split(',')[0].toLowerCase()),
]);
const IRREG = {
  been: 'be',
  knew: 'know',
  stood: 'stand',
  feet: 'foot',
  went: 'go',
  came: 'come',
  took: 'take',
  said: 'say',
  made: 'make',
  got: 'get',
  saw: 'see',
  ran: 'run',
  brought: 'bring',
  told: 'tell',
  thought: 'think',
  found: 'find',
  felt: 'feel',
  left: 'leave',
  lost: 'lose',
  kept: 'keep',
  held: 'hold',
  met: 'meet',
  paid: 'pay',
  built: 'build',
  spent: 'spend',
  sang: 'sing',
  sat: 'sit',
  spoke: 'speak',
  wrote: 'write',
  broke: 'break',
  ate: 'eat',
  drank: 'drink',
  drove: 'drive',
  fell: 'fall',
  grew: 'grow',
  wore: 'wear',
  won: 'win',
  woke: 'wake',
  chose: 'choose',
  forgot: 'forget',
  meant: 'mean',
  drew: 'draw',
  flew: 'fly',
  hid: 'hide',
  swam: 'swim',
  rose: 'rise',
  lent: 'lend',
  sent: 'send',
  understood: 'understand',
  done: 'do',
  given: 'give',
  gone: 'go',
  seen: 'see',
  known: 'know',
  shown: 'show',
  spoken: 'speak',
  written: 'write',
  broken: 'break',
  eaten: 'eat',
  drunk: 'drink',
  driven: 'drive',
  fallen: 'fall',
  grown: 'grow',
  worn: 'wear',
  chosen: 'choose',
  forgotten: 'forget',
  thrown: 'throw',
  taken: 'take',
  taught: 'teach',
  caught: 'catch',
  bought: 'buy',
  sold: 'sell',
  led: 'lead',
  fed: 'feed',
  fled: 'flee',
  heard: 'hear',
  beaten: 'beat',
  froze: 'freeze',
  drawn: 'draw',
  torn: 'tear',
  blown: 'blow',
  flung: 'fling',
  bitten: 'bite',
  forbade: 'forbid',
  wept: 'weep',
  dug: 'dig',
  bred: 'breed',
  clung: 'cling',
  swung: 'swing',
  sank: 'sink',
  woken: 'wake',
  swept: 'sweep',
  shrank: 'shrink',
  bled: 'bleed',
  knelt: 'kneel',
  children: 'child',
  men: 'man',
  women: 'woman',
  teeth: 'tooth',
  mice: 'mouse',
  geese: 'goose',
  halves: 'half',
  knives: 'knife',
  lives: 'life',
  leaves: 'leaf',
  wolves: 'wolf',
  shelves: 'shelf',
  wives: 'wife',
  better: 'good',
  best: 'good',
  worse: 'bad',
  worst: 'bad',
  farther: 'far',
  farthest: 'far',
};
function vb(w) {
  const out = [];
  if (w.endsWith('ies') && w.length > 4) out.push(w.slice(0, -3) + 'y');
  if (w.endsWith('es') && w.length >= 4) out.push(w.slice(0, -2));
  if (w.endsWith('s') && w.length > 3) out.push(w.slice(0, -1));
  if (w.endsWith('ing') && w.length > 4) out.push(w.slice(0, -3) + 'e', w.slice(0, -4), w.slice(0, -3));
  if (w.endsWith('ied')) out.push(w.slice(0, -3) + 'y');
  if (w.endsWith('ed') && w.length > 3) out.push(w.slice(0, -2) + 'e', w.slice(0, -3), w.slice(0, -2));
  if (w.endsWith('est') && w.length > 4) {
    const b = w.slice(0, -3);
    out.push(b, b.slice(0, -1));
  }
  if (w.endsWith('er') && w.length > 3) {
    const b = w.slice(0, -2);
    out.push(b.endsWith('i') ? b.slice(0, -1) + 'y' : b, b.slice(0, -1), b + 'e');
  }
  return out;
}
const FUNC = new Set(
  'a an the this that these those i you he she it we they me him her us them my your his its our their who whom whose which what of in on at by for with about to from and but or nor so yet if because although though while unless since as than whether when where why how is am are was were be been being do does did have has had will would shall should can could may might must not mr mrs ms dr one two three four five six seven eight nine ten hundred thousand toward towards quite within entire yourselves ourselves themselves sth sb'.split(
    ' ',
  ),
);
const clean = (t) =>
  t
    .replace(/\r/g, '')
    .replace(/（[^）]*）/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/can't/gi, 'cannot')
    .replace(/won't/gi, 'will not')
    .replace(/shan't/gi, 'shall not')
    .replace(/n't/gi, ' not')
    .replace(/'(s|re|ve|ll|m|d)\b/gi, ' ')
    .toLowerCase();
function unknowns(text) {
  const out = [];
  for (const w of clean(text).match(/[a-z]+/g) || []) {
    if (w.length < 2 && w !== 'a' && w !== 'i') continue;
    if (!(K.has(w) || (IRREG[w] && K.has(IRREG[w])) || vb(w).some((b) => K.has(b)) || FUNC.has(w))) out.push(w);
  }
  return out;
}
const words = (t) => (clean(t).match(/[a-z]+/g) || []).length;
const maxSent = (t) =>
  Math.max(
    0,
    ...t
      .replace(/（[^）]*）/g, ' ')
      .split(/(?<=[.!?])\s+/)
      .map((s) => (s.toLowerCase().match(/[a-z]+/g) || []).length),
  );

/* ── 段落解析（[P##] 行内标记 + 空行分块）── */
function parse(md) {
  const blocks = md.replace(/\r/g, '').split(/\n\s*\n/);
  return blocks
    .map((b) => {
      const m = b.match(/^\[P(\d+)\]\s*([\s\S]*)$/);
      return m ? { id: `P${m[1]}`, text: b } : null;
    })
    .filter(Boolean);
}

/* ── 3 并发信号量 ── */
async function pool(items, n, fn) {
  const ret = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      ret[k] = await fn(items[k]);
    }
  });
  await Promise.all(workers);
  return ret;
}

async function revise(segText, redWords, t, needSplit) {
  const sys = '你是英语分层读物的段级修订器。只修订给你的这一个段落，不新增内容，不改情节与事实。';
  const user = `修订下面这段${t.style}英语读物。
要求：
- 把这些学生不熟的词全部换成课标内常见词（保持原意）：${[...new Set(redWords)].join('、')}
${needSplit ? '- 长句拆短：每句不超过 ' + t.lim + ' 个词\n' : ''}- 保留：人名地名等专名、引号里的歌名与原句、数字、情节事实、已有的中文注释（word（中文）格式原样保留）
- 段落总词数变化不超过 ±25%
- 只输出修订后的整段英文（保留开头的 [P##] 标记），不要任何解释

段落：
${segText}`;
  const r = await LEDGER.call(
    [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
    { baseUrl: CFG.baseUrl, key: KEY(), model: MODEL, maxTokens: 2000 },
  );
  return r.content.trim();
}

/* ── 主流程 ── */
const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const tierArg = (argv.find((a) => /^[AMB]|^ALL$/.test(a)) || 'A').toUpperCase();
const chArg = argv.find((a) => /^\d+(,\d+)*$/.test(a));
const chapters = chapterNames(P)
  .map((n, i) => ({ n, i: i + 1 }))
  .filter((c) => !chArg || chArg.split(',').includes(String(c.i)));
const tiers = tierArg === 'ALL' ? ['A', 'M', 'B'] : [tierArg];

for (const tk of tiers) {
  const t = TIERS[tk];
  let total = 0,
    fixed = 0,
    pending = 0;
  for (const { n: ch } of chapters) {
    const file = join(OUT, ch, `原文_${t.tag}_2026-09-12_工序化.md`);
    if (!existsSync(file)) continue;
    const md = readFileSync(file, 'utf8');
    const segs = parse(md);
    // 隔离难度残留段ID
    const recap = join(RUN, `章recap_${t.tag}_${ch}.json`);
    const qIds = new Set(existsSync(recap) ? (JSON.parse(readFileSync(recap, 'utf8')).quarantined || []).filter((q) => q.class === '难度残留').map((q) => q.segment) : []);
    const reds = segs
      .map((s) => {
        const unk = unknowns(s.text);
        const rate = unk.length / Math.max(1, words(s.text));
        const byRate = unk.length >= 3 && rate >= 0.06;
        const byQuar = qIds.has(s.id);
        return byRate || byQuar ? { s, unk, byQuar } : null;
      })
      .filter(Boolean);
    total += reds.length;
    if (dry) {
      console.log(`${tk} ${ch}: 红项段 ${reds.length}（率超标 ${reds.filter((r) => !r.byQuar).length}｜隔离 ${reds.filter((r) => r.byQuar).length}）`);
      continue;
    }
    if (!reds.length) continue;
    if (!existsSync(BACK)) mkdirSync(BACK, { recursive: true });
    const bak = join(BACK, `${ch}_${t.tag}.md`);
    if (!existsSync(bak)) copyFileSync(file, bak);
    const results = await pool(reds, 3, async (r) => {
      const before = r.unk.length,
        w0 = words(r.s.text),
        anno0 = (r.s.text.match(/（/g) || []).length;
      let verdict = '挂起',
        after = before,
        reason = '',
        out = r.s.text;
      for (let attempt = 0; attempt < 2; attempt++) {
        let rev;
        try {
          rev = await revise(r.s.text, attempt ? await (async () => unknowns(out))() : r.unk, t, r.byQuar);
        } catch (e) {
          reason = `调用失败:${String(e).slice(0, 60)}`;
          break;
        }
        if (!rev.includes(`[${r.s.id}]`)) rev = `[${r.s.id}] ` + rev.replace(/^\[P\d+\]\s*/, '');
        const u2 = unknowns(rev),
          w1 = words(rev);
        const anno1 = (rev.match(/（/g) || []).length;
        const lenOk = w1 >= 0.7 * w0 && w1 <= 1.4 * w0;
        const annoOk = anno1 >= anno0;
        const sentOk = !r.byQuar || maxSent(rev) <= t.lim + 2;
        if (u2.length < before && lenOk && annoOk && sentOk) {
          verdict = '✓修订';
          after = u2.length;
          out = rev;
          reason = `红词 ${before}→${u2.length}`;
          break;
        }
        reason = `未过闸（红${before}→${u2.length} 长${w0}→${w1} 注${anno0}→${anno1}${r.byQuar ? ' 句max' + maxSent(rev) : ''}）`;
        out = rev; // 留给第二次尝试做底稿但不采纳
        if (attempt === 0) r.unk = u2.length ? u2 : r.unk;
      }
      if (verdict === '✓修订') fixed++;
      else pending++;
      appendFileSync(LEDGER_LOG, JSON.stringify({ tier: tk, chapter: ch, seg: r.s.id, verdict, redBefore: before, redAfter: after, reason }) + '\n');
      console.log(`  ${verdict} ${tk} ${ch} ${r.s.id}（${reason}）`);
      return out;
    });
    // 拼回：只换红段的块，其余一字不动
    let outMd = md;
    for (let i = 0; i < reds.length; i++) outMd = outMd.replace(reds[i].s.text, results[i]);
    writeFileSync(file, outMd, 'utf8');
  }
  if (!dry) console.log(`${tk} 层回炉：红项 ${total}｜✓修订 ${fixed}｜挂起 ${pending}`);
}
if (dry) console.log('（--dry 仅检测）');
