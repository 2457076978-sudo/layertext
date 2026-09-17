/**
 * LayerText · 两遍制段级回炉 v2（2026-09-17 点火 · Wayne 验收 v2 标准）
 * 红项清单：①同段倒挂段（B/M 未注生词数 > A 同段）②语义警报段（专名代词化/凭空数字/否定归零 vs 源）③注释外中文段。
 * 闸序（Wayne 修正二）：锁专名/数字/否定 → 换词降红 → 段长/注释/句长；相似度向量位暂由确定性规则顶。
 * 专名规则（Wayne 修正一）：首次全名、同段后续可代词（段内至少一次全名落地）。
 * 执行顺序（漂移教训）：Phase3 锁修复(AI 最小编辑) → Phase1 确定性补注（零 API）→ Phase2 仍倒挂段 AI 换词。
 * 用法：node LayerText_AF段级回炉.mjs <A|M|B|ALL> [章号|1,2] [--dry]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, appendFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
const SHARED = await import('./LayerText_AF词表与词典.mjs');
import { keychainGet } from './keychain.mjs';
const { loadProject, loadTextbookLearned } = SHARED;

const P = loadProject('/Users/wayne/Desktop/工作文档库/01-教学工作/名著阅读工作区_AnimalFarm/调适项目_AnimalFarm.json');
const KV = '/Users/wayne/Desktop/工作文档库/01-教学工作/名著阅读工作区_AnimalFarm/知识文件';
const OUT = P.产物目录;
const RUN = join(OUT, '_运行');
const BACK = join(RUN, '回炉v2前_20260917');
const LEDGER_LOG = join(RUN, '回炉台账.jsonl');
const MODEL = P.模型 || 'ecnu-max';
const CFG = { baseUrl: 'https://chat.ecnu.edu.cn/open/api/v1' };
const KEY = () => keychainGet('layertext.ecnukey');
const { openLedger } = await import('./LayerText_AF调用台账.mjs');
const LEDGER = await openLedger(P, '段级回炉v2');

const TIERS = { A: { tag: 'A层85', lim: 17 }, M: { tag: 'M层75', lim: 15 }, B: { tag: 'B层60', lim: 14 } };

/* ── 判定器（与验收 v2 同一把尺）── */
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
const DICT = new Map();
for (const line of readFileSync(join(KV, 'AF注释词典_v1.csv'), 'utf8')
  .replace(/^\uFEFF/, '')
  .split('\n')
  .slice(1)) {
  const c = line.split(',');
  if (c[0]) DICT.set(c[0].toLowerCase(), c[1]);
}
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
const isUnk = (w) => !(K.has(w) || (IRREG[w] && K.has(IRREG[w])) || vb(w).some((b) => K.has(b)) || FUNC.has(w));
const segsOf = (md) => {
  const out = new Map();
  for (const b of md.replace(/\r/g, '').split(/\n\s*\n/)) {
    const m = b.match(/^\[P(\d+)\]\s*([\s\S]*)$/);
    if (m) out.set(`P${m[1]}`, m[2].trim());
  }
  return out;
};
const words = (t) => (clean(t).match(/[a-z]+/g) || []).length;
const maxSent = (t) =>
  Math.max(
    0,
    ...t
      .replace(/（[^）]*）/g, ' ')
      .split(/(?<=[.!?])\s+/)
      .map((s) => (s.toLowerCase().match(/[a-z]+/g) || []).length),
  );
const annoOf = (md) => new Set([...md.matchAll(/([a-z][a-z-]*)（[^）]*）/g)].map((m) => m[1].toLowerCase()));
function unnotedIn(text, ann) {
  let n = 0;
  const u = [];
  for (const w of clean(text).match(/[a-z]+/g) || []) {
    if (w.length < 2 && w !== 'a' && w !== 'i') continue;
    if (isUnk(w) && !ann.has(w)) {
      n++;
      u.push(w);
    }
  }
  return { n, u };
}
function sourceOf(ch) {
  const dir = `${P.原文目录}/第${ch}章`;
  if (!existsSync(dir)) return null;
  for (const f of readdirSync(dir))
    if (/原文_规范化.*\.md$/.test(f) && !f.includes('坏头')) {
      const md = readFileSync(`${dir}/${f}`, 'utf-8');
      if (md.includes('[P')) return segsOf(md);
    }
  return null;
}
async function pool(items, n, fn) {
  const ret = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        ret[k] = await fn(items[k]);
      }
    }),
  );
  return ret;
}
async function callAI(sys, user) {
  const r = await LEDGER.call(
    [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
    { baseUrl: CFG.baseUrl, key: KEY(), model: MODEL, maxTokens: 2000 },
  );
  return r.content.trim();
}
/* 锁：专名首现全名（段内≥1 次）/数字子集/否定不归零 */
function locksOf(srcSeg) {
  const s = clean(srcSeg);
  const props = [...new Set([...(s.match(/[a-z]+/g) || [])].filter((w) => afProper.has(w)))];
  const nums = [...new Set([...(srcSeg.match(/\b\d+\b/g) || [])])];
  const neg = (s.match(/\b(not|never|no|cannot)\b/g) || []).length;
  return { props, nums, neg };
}
const lockPass = (rev, L) => {
  const c = clean(rev);
  const missProps = L.props.filter((pr) => !c.includes(pr));
  const fakeNums = [...(rev.match(/\b\d+\b/g) || [])].filter((n) => !L.nums.includes(n));
  const negP = (c.match(/\b(not|never|no|cannot)\b/g) || []).length;
  const negOk = !(L.neg >= 2 && negP === 0);
  return { ok: missProps.length === 0 && fakeNums.length === 0 && negOk, missProps, fakeNums, negOk };
};

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const tierArg = (argv.find((a) => /^[AMB]|^ALL$/.test(a)) || 'ALL').toUpperCase();
const chArg = argv.find((a) => /^\d+(,\d+)*$/.test(a));
const CHN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const chapters = CHN.filter((c, i) => !chArg || chArg.split(',').includes(String(i + 1)));
const tiersToRun = tierArg === 'ALL' ? ['A', 'M', 'B'] : [tierArg];
const st = { lock3: 0, anno1: 0, ai2: 0, pend: 0 };

for (const ch of chapters) {
  const src = sourceOf(ch);
  const prods = {};
  for (const [tk, t] of Object.entries(TIERS)) {
    const p = join(OUT, `第${ch}章`, `原文_${t.tag}_2026-09-12_工序化.md`);
    if (existsSync(p)) {
      const md = readFileSync(p, 'utf-8');
      prods[tk] = { path: p, md, segs: segsOf(md) };
    }
  }
  if (!prods.A || !prods.B || !src) continue;
  const ensureBak = (tk) => {
    if (!existsSync(BACK)) mkdirSync(BACK, { recursive: true });
    const b = join(BACK, `${ch}_${TIERS[tk].tag}.md`);
    if (!existsSync(b)) copyFileSync(prods[tk].path, b);
  };

  /* ── Phase 3：锁修复（AI 最小编辑；A 也跑）── */
  const lockSegs = [];
  for (const tk of tiersToRun) {
    for (const [id, t] of prods[tk].segs) {
      const s = src.get(id);
      if (!s) continue;
      const L = locksOf(s);
      const v = lockPass(t, L);
      const zh = /[\u4e00-\u9fff]/.test(t.replace(/（[^）]*）/g, ''));
      if (!v.ok || zh) lockSegs.push({ tk, id, t, L, v, zh });
    }
  }
  if (lockSegs.length && !dry) {
    for (const tk of new Set(lockSegs.map((x) => x.tk))) ensureBak(tk);
    const outs = await pool(lockSegs, 3, async (r) => {
      const fix = [];
      if (r.v.missProps.length) fix.push(`把指代 ${r.v.missProps.join('、')} 的代词在其首次出现处改回全名（同段后续可用代词）`);
      if (r.v.fakeNums.length) fix.push(`删除或改正凭空数字 ${r.v.fakeNums.join('、')}（本段只能出现这些数字：${r.L.nums.join('、') || '无'}）`);
      if (!r.v.negOk) fix.push('源段有多个否定表达，修订稿一个否定都不能丢');
      if (r.zh) fix.push('删除中文字符（word（中文）注释格式除外）');
      const sys = '你是分层读物的段级修订器。做最小修改：只修列出的问题，其余一字不动。';
      const user = `只修以下问题，输出修订后的整段（保留 [P${r.id}] 标记与已有中文注释）：\n- ${fix.join('\n- ')}\n\n段落：\n${r.t}`;
      let verdict = '挂起';
      let reason = '';
      for (let a = 0; a < 2; a++) {
        const rev = await callAI(sys, user).catch(() => null);
        if (!rev) {
          reason = '调用失败';
          break;
        }
        let out = rev;
        if (!out.includes(`[P${r.id}]`)) out = `[P${r.id}] ` + out.replace(/^\[P\d+\]\s*/, '');
        const v2 = lockPass(out, r.L);
        const zh2 = /[\u4e00-\u9fff]/.test(out.replace(/（[^）]*）/g, ''));
        if (v2.ok && !zh2 && words(out) >= 0.7 * words(r.t) && words(out) <= 1.4 * words(r.t) && (out.match(/（/g) || []).length >= (r.t.match(/（/g) || []).length) {
          verdict = '✓锁修复';
          reason = `${r.v.missProps.length ? '专名 ' : ''}${r.v.fakeNums.length ? '数字 ' : ''}${!r.v.negOk ? '否定 ' : ''}${r.zh ? '杂中文' : ''}已修`;
          st.lock3++;
          appendFileSync(LEDGER_LOG, JSON.stringify({ tier: r.tk, chapter: ch, seg: r.id, verdict, reason }) + '\n');
          console.log(`  ${verdict} ${r.tk} ${ch} ${r.id}（${reason}）`);
          return out;
        }
        reason = `未过锁闸（缺${v2.missProps.join(',') || '无'} 数字${v2.fakeNums.join(',') || '无'}${v2.negOk ? '' : ' 否定'}）`;
      }
      st.pend++;
      appendFileSync(LEDGER_LOG, JSON.stringify({ tier: r.tk, chapter: ch, seg: r.id, verdict, reason }) + '\n');
      console.log(`  挂起 ${r.tk} ${ch} ${r.id}（${reason}）`);
      return r.t;
    });
    for (const tk of new Set(lockSegs.map((x) => x.tk))) {
      let md = prods[tk].md;
      let any = false;
      for (let i = 0; i < lockSegs.length; i++)
        if (lockSegs[i].tk === tk) {
          md = md.replace(lockSegs[i].t, outs[i]);
          any = true;
        }
      if (any) {
        writeFileSync(prods[tk].path, md, 'utf-8');
        prods[tk] = { path: prods[tk].path, md, segs: segsOf(md) };
      }
    }
  }
  if (dry && lockSegs.length) console.log(`${ch} 锁修复段 ${lockSegs.length}`);

  /* ── A 参考未注（锁修复后重算）── */
  const annA = annoOf(prods.A.md);
  const refA = new Map([...prods.A.segs].map(([id, t]) => [id, unnotedIn(t, annA).n]));

  /* ── Phase 1：确定性补注（倒挂段、词典有义、零 API）── */
  for (const tk of tiersToRun.filter((x) => x !== 'A')) {
    const ann = annoOf(prods[tk].md);
    let md = prods[tk].md;
    let nAnno = 0;
    for (const [id, t] of prods[tk].segs) {
      if (unnotedIn(t, ann).n <= (refA.get(id) ?? 0)) continue;
      let seg = t;
      let added = 0;
      for (const w of new Set(unnotedIn(seg, ann).u)) {
        if (added >= 5) break;
        const g = DICT.get(w) || DICT.get(w.replace(/s$/, ''));
        if (!g) continue;
        seg = seg.replace(new RegExp(`\\b${w}\\b(?!（)`), `${w}（${g}）`);
        added++;
        ann.add(w);
      }
      if (added) {
        md = md.replace(t, seg);
        nAnno += added;
      }
    }
    if (nAnno) {
      ensureBak(tk);
      writeFileSync(prods[tk].path, md, 'utf-8');
      prods[tk] = { path: prods[tk].path, md, segs: segsOf(md) };
      st.anno1 += nAnno;
      console.log(`  ✓补注 ${tk} ${ch}（${nAnno} 处，确定性）`);
    }
  }

  /* ── Phase 2：仍倒挂段 → AI 换词（锁先行）── */
  const aiSegs = [];
  for (const tk of tiersToRun.filter((x) => x !== 'A')) {
    const ann = annoOf(prods[tk].md);
    for (const [id, t] of prods[tk].segs) {
      const u = unnotedIn(t, ann);
      if (u.n > (refA.get(id) ?? 0)) aiSegs.push({ tk, id, t, u, target: refA.get(id) ?? 0 });
    }
  }
  if (aiSegs.length && !dry) {
    for (const tk of new Set(aiSegs.map((x) => x.tk))) ensureBak(tk);
    const outs = await pool(aiSegs, 3, async (r) => {
      const L = locksOf(src.get(r.id) || r.t);
      const sys = '你是分层读物的段级修订器。按顺序执行：先保锁，再降红词。';
      const user = `修订这段${TIERS[r.tk].tag}英语读物，按顺序满足：
1. 【锁·最先】专名必须保留且本段至少一次全名出现：${L.props.join('、') || '无'}；只可出现这些数字：${L.nums.join('、') || '无'}；否定表达一个都不能丢（源段 ${L.neg} 个）。
2. 【降红】把下面这些未注释的生词换成课标内常见词（或删去冗余）：${[...new Set(r.u.u)].join('、')}——修完后未注生词数必须 ≤ ${r.target}。
3. 保留已有中文注释（word（中文））、情节事实；段落词数变化 ±25% 内；每句不超过 ${TIERS[r.tk].lim} 词。
只输出修订后的整段（保留 [P${r.id}] 标记）。

段落：
${r.t}`;
      let verdict = '挂起';
      let reason = '';
      for (let a = 0; a < 2; a++) {
        const rev = await callAI(sys, user).catch(() => null);
        if (!rev) {
          reason = '调用失败';
          break;
        }
        let out = rev;
        if (!out.includes(`[P${r.id}]`)) out = `[P${r.id}] ` + out.replace(/^\[P\d+\]\s*/, '');
        const lp = lockPass(out, L);
        const u2 = unnotedIn(out, annoOf(out));
        const w0 = words(r.t);
        const w1 = words(out);
        if (lp.ok && u2.n <= r.target && w1 >= 0.7 * w0 && w1 <= 1.4 * w0 && (out.match(/（/g) || []).length >= (r.t.match(/（/g) || []).length && maxSent(out) <= TIERS[r.tk].lim + 2) {
          verdict = '✓换词降红';
          reason = `未注 ${r.u.n}→${u2.n}(≤A${r.target})`;
          st.ai2++;
          appendFileSync(LEDGER_LOG, JSON.stringify({ tier: r.tk, chapter: ch, seg: r.id, verdict, reason }) + '\n');
          console.log(`  ${verdict} ${r.tk} ${ch} ${r.id}（${reason}）`);
          return out;
        }
        reason = `未过闸（锁${lp.ok ? '✓' : '✗'} 未注${u2.n}>${r.target} 长${w0}→${w1}）`;
      }
      st.pend++;
      appendFileSync(LEDGER_LOG, JSON.stringify({ tier: r.tk, chapter: ch, seg: r.id, verdict, reason }) + '\n');
      console.log(`  挂起 ${r.tk} ${ch} ${r.id}（${reason}）`);
      return r.t;
    });
    for (const tk of new Set(aiSegs.map((x) => x.tk))) {
      let md = prods[tk].md;
      let any = false;
      for (let i = 0; i < aiSegs.length; i++)
        if (aiSegs[i].tk === tk) {
          md = md.replace(aiSegs[i].t, outs[i]);
          any = true;
        }
      if (any) writeFileSync(prods[tk].path, md, 'utf-8');
    }
  }
  if (dry && aiSegs.length) console.log(`${ch} 仍倒挂待AI段 ${aiSegs.length}`);
}
if (!dry) console.log(`回炉 v2：锁修复 ${st.lock3}｜确定性补注 ${st.anno1}｜AI 换词 ${st.ai2}｜挂起 ${st.pend}`);
