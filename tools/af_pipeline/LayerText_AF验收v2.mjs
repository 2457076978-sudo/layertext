/**
 * LayerText · 验收 v2（2026-09-17，报告版）——把质量定义成机器查得出的事实
 * 维度：结构（ID对齐/唯一/非空/无杂中文/近重复代理）｜层间梯度（同段B未注≤A、B均句长≤A、全书未注率B<M<A）
 *      语义确定性校验（数字子集/专名不丢/否定不反转）｜注释（未注生词清单）｜隔离段照抄检测｜分布尾部（P90句长/最差段）
 * 向量版相似度与语法校验为接线位（见 LayerText_验收标准v2_2026-09-17.md）。
 * 用法：node LayerText_AF验收v2.mjs [--chapter 1]   （默认全书三层）
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const AF = '/Users/wayne/Desktop/工作文档库/01-教学工作/名著阅读工作区_AnimalFarm';
const LT = '/Users/wayne/Desktop/工作文档库/05-网站与AI工作区/LayerText';
const KV = `${AF}/知识文件`;
const OUT = `${AF}/调适工作区/重制三版`;
const RUN = `${OUT}/_运行`;
const CH = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const TIERS = { A: 'A层85', M: 'M层75', B: 'B层60' };

const { loadTextbookLearned } = await import(`${LT}/tools/af_pipeline/LayerText_AF词表与词典.mjs`);
const P = JSON.parse(readFileSync(`${AF}/调适项目_AnimalFarm.json`, 'utf-8'));
const engineKnown = new Set([...loadTextbookLearned(P)].map((w) => w.toLowerCase()));
const afProper = new Set(
  readFileSync(`${KV}/专名_AnimalFarm.txt`, 'utf8')
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
  ...readFileSync(`${KV}/分档允许表_v0/允许表_良.csv`, 'utf8')
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
const isUnk = (w) => !(K.has(w) || (IRREG[w] && K.has(IRREG[w])) || vb(w).some((b) => K.has(b)) || FUNC.has(w));
function segsOf(md) {
  const out = new Map();
  for (const b of md.replace(/\r/g, '').split(/\n\s*\n/)) {
    const m = b.match(/^\[P(\d+)\]\s*([\s\S]*)$/);
    if (m) out.set(`P${m[1]}`, m[2].trim());
  }
  return out;
}
const norm = (t) =>
  clean(t)
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const grams = (t, n = 3) => {
  const w = t.split(' ');
  const s = new Set();
  for (let i = 0; i + n <= w.length; i++) s.add(w.slice(i, i + n).join(' '));
  return s;
};
const jac = (a, b) => {
  let i = 0;
  for (const x of a) if (b.has(x)) i++;
  return i / (a.size + b.size - i || 1);
};

// 源文件（[P##] 段）
function sourceOf(ch) {
  const dir = `${AF}/调适工作区/原文重制_M50/第${ch}章`;
  if (!existsSync(dir)) return null;
  for (const f of readdirSync(dir)) {
    if (/原文_规范化.*\.md$/.test(f) && !f.includes('坏头')) {
      const md = readFileSync(`${dir}/${f}`, 'utf8');
      if (md.includes('[P')) return segsOf(md);
    }
  }
  return null;
}

const R = { 结构: [], 梯度: [], 语义: [], 注释: [], 照抄: [], 尾部: {} };
const unnotedRate = { A: { tok: 0, unk: 0 }, M: { tok: 0, unk: 0 }, B: { tok: 0, unk: 0 } };
const sentLens = { A: [], M: [], B: [] };
const annoTypes = (t) => new Set([...t.matchAll(/([a-z][a-z-]*)（[^）]*）/g)].map((m) => m[1].toLowerCase()));

for (const ch of CH) {
  const src = sourceOf(ch);
  const tiers = {};
  for (const [tk, tag] of Object.entries(TIERS)) {
    const p = `${OUT}/第${ch}章/原文_${tag}_2026-09-12_工序化.md`;
    if (!existsSync(p)) continue;
    const md = readFileSync(p, 'utf8');
    tiers[tk] = { md, segs: segsOf(md) };
  }
  if (!tiers.A || !tiers.B) continue;
  // ① 结构：ID 对齐/唯一/非空/杂中文/近重复
  const ids = {};
  for (const tk of Object.keys(tiers)) ids[tk] = [...tiers[tk].segs.keys()];
  for (const tk of Object.keys(tiers)) {
    if (new Set(ids[tk]).size !== ids[tk].length) R.结构.push(`${ch}/${tk} 段ID重复`);
    for (const [id, t] of tiers[tk].segs) {
      if (!t.trim()) R.结构.push(`${ch}/${tk}/${id} 空段`);
      if (/[\u4e00-\u9fff]/.test(t.replace(/（[^）]*）/g, ''))) R.结构.push(`${ch}/${tk}/${id} 注释外中文`);
    }
    const gs = [...tiers[tk].segs].map(([id, t]) => ({ id, g: grams(norm(t)) }));
    for (let i = 0; i < gs.length; i++)
      for (let jx = i + 1; jx < gs.length; jx++) {
        const s = jac(gs[i].g, gs[jx].g);
        if (s > 0.55) R.结构.push(`${ch}/${tk} 近重复 ${gs[i].id}~${gs[jx].id}（3gram J=${s.toFixed(2)}）`);
      }
  }
  const align = new Set([...ids.A, ...ids.M, ...ids.B]);
  if (!(ids.A.length === ids.M.length && ids.M.length === ids.B.length && new Set(ids.A).size === align.size))
    R.结构.push(`${ch} 三层段ID不对齐 A:${ids.A.length}/M:${ids.M.length}/B:${ids.B.length}`);
  // ② 梯度：同段 B 未注 ≤ A；B 均句长 ≤ A
  const unnotedSeg = (tk) => {
    const m = new Map();
    const ann = annoTypes(tiers[tk].md);
    for (const [id, t] of tiers[tk].segs) {
      let n = 0;
      for (const w of clean(t).match(/[a-z]+/g) || []) {
        if (w.length < 2 && w !== 'a' && w !== 'i') continue;
        if (isUnk(w) && !ann.has(w)) n++;
      }
      m.set(id, n);
    }
    return m;
  };
  const uB = unnotedSeg('B'),
    uA = unnotedSeg('A');
  let bOver = [];
  for (const id of ids.B) if (ids.A.includes(id) && (uB.get(id) || 0) > (uA.get(id) || 0)) bOver.push(`${id}(B${uB.get(id)}/A${uA.get(id)})`);
  if (bOver.length) R.梯度.push(`${ch} 同段B未注>A：${bOver.slice(0, 6).join(' ')}${bOver.length > 6 ? ` 等${bOver.length}段` : ''}`);
  const avgSent = (tk) => {
    const ls = [];
    for (const t of tiers[tk].segs.values())
      for (const s of t.split(/(?<=[.!?])\s+/)) {
        const n = (s.toLowerCase().match(/[a-z]+/g) || []).length;
        if (n >= 2) ls.push(n);
      }
    return ls.reduce((a, b) => a + b, 0) / ls.length;
  };
  if (avgSent('B') > avgSent('A')) R.梯度.push(`${ch} B均句长${avgSent('B').toFixed(1)} > A均句长${avgSent('A').toFixed(1)}`);
  // ③ 语义确定性校验（vs 源）：数字子集/专名不丢/否定不反转
  if (src)
    for (const tk of Object.keys(tiers))
      for (const [id, t] of tiers[tk].segs) {
        const s = src.get(id);
        if (!s) continue;
        const numsP = [...clean(t).matchAll(/\b\d+\b/g)].map((m) => m[0]);
        const numsS = new Set([...clean(s).matchAll(/\b\d+\b/g)].map((m) => m[0]));
        if (numsP.some((n) => !numsS.has(n))) R.语义.push(`${ch}/${tk}/${id} 凭空数字 ${numsP.filter((n) => !numsS.has(n)).join(',')}`);
        const propS = [...clean(s).match(/[a-z]+/g)].filter((w) => afProper.has(w));
        const txtP = clean(t);
        for (const pr of new Set(propS))
          if (!txtP.includes(pr)) {
            R.语义.push(`${ch}/${tk}/${id} 专名丢失 ${pr}`);
            break;
          }
        const negP = (clean(t).match(/\b(not|never|no|cannot)\b/g) || []).length;
        const negS = (clean(s).match(/\b(not|never|no|cannot)\b/g) || []).length;
        if (src && negP < negS && negS >= 2 && negP === 0) R.语义.push(`${ch}/${tk}/${id} 否定疑似反转 ${negS}→0`);
      }
  // ⑤ 照抄检测（隔离难度残留段）
  if (src)
    for (const tk of Object.keys(tiers)) {
      const recap = `${RUN}/章recap_${TIERS[tk]}_第${ch}章.json`;
      if (!existsSync(recap)) continue;
      const q = JSON.parse(readFileSync(recap, 'utf-8')).quarantined || [];
      for (const { segment: id, class: cls } of q.filter((x) => x.class === '难度残留')) {
        const prod = tiers[tk].segs.get(id);
        const s = src.get(id);
        if (prod && s && norm(prod) === norm(s)) R.照抄.push(`${ch}/${tk}/${id}`);
      }
    }
  // 累计未注率/句长分布
  for (const tk of Object.keys(tiers)) {
    const ann = annoTypes(tiers[tk].md);
    for (const t of tiers[tk].segs.values()) {
      for (const w of clean(t).match(/[a-z]+/g) || []) {
        if (w.length < 2 && w !== 'a' && w !== 'i') continue;
        unnotedRate[tk].tok++;
        if (isUnk(w) && !ann.has(w)) unnotedRate[tk].unk++;
      }
      for (const s of t.split(/(?<=[.!?])\s+/)) {
        const n = (s.toLowerCase().match(/[a-z]+/g) || []).length;
        if (n >= 2) sentLens[tk].push(n);
      }
    }
  }
}
// ⑥ 尾部
for (const tk of ['A', 'M', 'B']) {
  const s = [...sentLens[tk]].sort((a, b) => a - b);
  R.尾部[tk] = { P90: s[Math.floor(s.length * 0.9)], 均值: (s.reduce((a, b) => a + b, 0) / s.length).toFixed(1) };
}
const rate = (tk) => ((100 * unnotedRate[tk].unk) / unnotedRate[tk].tok).toFixed(2);
console.log('=== 验收 v2 · 倒挂报告（现有稿） ===');
console.log(`全书未注生词率: A ${rate('A')}% / M ${rate('M')}% / B ${rate('B')}%  → 排序要求 B<M<A: ${rate('B') < rate('M') && rate('M') < rate('A') ? 'PASS' : 'FAIL（倒挂）'}`);
console.log(`句长尾部: ${['A', 'M', 'B'].map((tk) => `${tk} 均${R.尾部[tk].均值}/P90=${R.尾部[tk].P90}`).join('  ')}`);
console.log(
  `结构问题 ${R.结构.length} 条｜同段倒挂 ${R.梯度.filter((x) => x.includes('B未注')).length} 章｜句长倒挂 ${R.梯度.filter((x) => x.includes('句长')).length} 章｜语义 ${R.语义.length} 条｜照抄 ${R.照抄.length} 段`,
);
R.结构.slice(0, 8).forEach((x) => console.log('  [结构]', x));
R.梯度.slice(0, 6).forEach((x) => console.log('  [梯度]', x));
R.语义.slice(0, 10).forEach((x) => console.log('  [语义]', x));
writeFileSync(
  `${OUT}/验收v2_倒挂报告_2026-09-17.md`,
  `# 验收 v2 · 倒挂报告（现有稿，2026-09-17）\n\n全书未注生词率：A ${rate('A')}% / M ${rate('M')}% / B ${rate('B')}%（要求 B<M<A：${rate('B') < rate('M') && rate('M') < rate('A') ? 'PASS' : 'FAIL'}）\n\n句长：${['A', 'M', 'B'].map((tk) => `${tk} 均${R.尾部[tk].均值}/P90=${R.尾部[tk].P90}`).join('　')}\n\n## 结构（${R.结构.length}）\n${R.结构.join('\n') || '无'}\n\n## 层间梯度（${R.梯度.length}）\n${R.梯度.join('\n') || '无'}\n\n## 语义确定性校验（${R.语义.length}）\n${R.语义.join('\n') || '无'}\n\n## 隔离段原文照抄（${R.照抄.length}）\n${R.照抄.join('、') || '无'}\n`,
);
console.log('报告已写: 验收v2_倒挂报告_2026-09-17.md');
