/**
 * LayerText · 验收 v2（2026-09-17，报告版）——把质量定义成机器查得出的事实
 * 维度：结构（ID对齐/唯一/非空/无杂中文/近重复代理）｜层间梯度（同段B未注≤A、B均句长≤A、全书未注率B<M<A）
 *      语义确定性校验（数字子集/专名不丢/否定不反转）｜注释（未注生词清单）｜隔离段照抄检测｜分布尾部（P90句长/最差段）
 * 向量版相似度与语法校验为接线位（见 LayerText_验收标准v2_2026-09-17.md）。
 * 用法：node LayerText_AF验收v2.mjs [--chapter 1]   （默认全书三层）
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
/* 项目根从 LAYERTEXT_AF_DIR（=AF 调适工作区）取，取不到说清楚并退出（AGENTS 铁律 3：绝对路径不进仓库）。
 * 引擎目录由词表与词典.mjs 自身位置推出（distOf），不再写死。 */
const AF_WS = process.env.LAYERTEXT_AF_DIR;
if (!AF_WS) {
  console.error('需要 LAYERTEXT_AF_DIR=<AF项目>/调适工作区（上级目录含 调适项目_AnimalFarm.json 与 知识文件/）。用法：');
  console.error('  LAYERTEXT_AF_DIR=/path/to/名著阅读工作区_AnimalFarm/调适工作区 node LayerText_AF验收v2.mjs [--chapter 1]');
  process.exit(2);
}
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const AF = dirname(AF_WS);
const LT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const KV = `${AF}/知识文件`;
const OUT = `${AF}/调适工作区/重制三版`;
const RUN = `${OUT}/_运行`;
const CH = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const TIERS = { A: 'A层85', M: 'M层75', B: 'B层60' };

const { loadTextbookLearned, distOf } = await import(`${LT}/tools/af_pipeline/LayerText_AF词表与词典.mjs`);
/* 判定原语唯一实现：src/core/acceptance.ts（MCP layer_acceptance_v2 与本脚本同一把尺）。
 * 本文件只保留 AF 文件装配与报告渲染——同一条判定不许有两份实现。 */
const {
  cleanForAcceptance: clean,
  makeIsUnknown,
  segsOfMd: segsOf,
  norm3: norm,
  grams3: grams,
  jaccard: jac,
  annoTypesOf,
  unnotedTokensOf,
  sentLensOfSegs,
  semanticSuspectsOf,
} = await import(`${distOf()}/src/core/acceptance.js`);
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
const isUnk = makeIsUnknown(K);
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

const POEM_SEGS = (() => {
  try {
    return JSON.parse(readFileSync(join(KV, '歌词诗段表_v1.json'), 'utf-8')).段 || [];
  } catch {
    return [];
  }
})();
const POEM_SEGS_BAD = [];
for (const p of POEM_SEGS) {
  if (!p.章 || !p.段 || !(p.层 || []).length) {
    POEM_SEGS_BAD.push(`注册表格式缺字段 ${JSON.stringify(p).slice(0, 40)}`);
    continue;
  }
  for (const tk of p.层 || ['A', 'M', 'B']) {
    const fp = join(OUT, `第${p.章}章`, `原文_${TIERS[tk] || tk}_2026-09-12_工序化.md`);
    if (!existsSync(fp)) {
      POEM_SEGS_BAD.push(`${p.章}/${tk}/${p.段} 产物不存在`);
      continue;
    }
    const seg = [
      ...readFileSync(fp, 'utf-8')
        .replace(/\r/g, '')
        .split(/\n\s*\n/),
    ].find((b) => b.match(new RegExp(`^\\[${p.段}\\]`)));
    if (!seg) {
      POEM_SEGS_BAD.push(`${p.章}/${tk}/${p.段} 段不存在于产物`);
      continue;
    }
    const n = (seg.match(/（[^）]*）/g) || []).length;
    if (n > 4) POEM_SEGS_BAD.push(`${p.章}/${tk}/${p.段} 注数 ${n}>4（超歌词段上限）`);
  }
}
const isPoem = (ch, id, tk) => POEM_SEGS.some((p) => p.章 === ch && p.段 === id && (p.层 || ['A', 'M', 'B']).includes(tk));
/* 短语感知窗口（v2.2 参数化）：注覆盖其前方窗口内内容词。
 * 60 为 AF 全书拟合值（v2.1 调试所得），非推导值——变更必须跑回归用例（见 验收标准 v2.2 待办二）。 */
const PHRASE_WINDOW = 60;
const R = { 结构: [], 梯度: [], 语义: [], 注释: [], 照抄: [], 尾部: {} };
const unnotedWords = {};
const unnotedRate = { A: { tok: 0, unk: 0 }, M: { tok: 0, unk: 0 }, B: { tok: 0, unk: 0 } };
const sentLens = { A: [], M: [], B: [] };
const annoTypes = (t) => annoTypesOf(t, PHRASE_WINDOW);

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
    const words = new Map();
    const ann = annoTypes(tiers[tk].md);
    for (const [id, t] of tiers[tk].segs) {
      const u = unnotedTokensOf(t, ann, isUnk);
      m.set(id, u.n);
      words.set(id, u.words);
    }
    unnotedWords[tk] = words;
    return m;
  };
  const uB = unnotedSeg('B'),
    uA = unnotedSeg('A');
  let bOver = [];
  for (const id of ids.B) if (!isPoem(ch, id, 'B') && ids.A.includes(id) && (uB.get(id) || 0) > (uA.get(id) || 0)) bOver.push(`${id}(B${uB.get(id)}/A${uA.get(id)})`);
  if (bOver.length) {
    const wlist = bOver
      .slice(0, 4)
      .map((x) => `${x.split('(')[0]}:${(unnotedWords.B.get(x.split('(')[0]) || []).join(',')}`)
      .join(' | ');
    R.梯度.push(`${ch} 同段B未注>A：${bOver.slice(0, 6).join(' ')}${bOver.length > 6 ? ` 等${bOver.length}段` : ''} ｜词：${wlist}`);
  }
  const avgSent = (tk) => {
    const ls = sentLensOfSegs(tiers[tk].segs.values());
    return ls.length ? ls.reduce((a, b) => a + b, 0) / ls.length : 0;
  };
  if (avgSent('B') > avgSent('A') * 1.15) R.梯度.push(`${ch} B均句长${avgSent('B').toFixed(1)} > A均句长${(avgSent('A') * 1.15).toFixed(1)}（比值${(avgSent('B') / avgSent('A')).toFixed(2)}）`);
  // ③ 语义确定性校验（vs 源）：数字子集/专名不丢/否定不反转
  if (src)
    for (const tk of Object.keys(tiers))
      for (const [id, t] of tiers[tk].segs) {
        const s = src.get(id);
        if (!s) continue;
        const v = semanticSuspectsOf(s, t, afProper);
        if (v.fakeNums.length) R.语义.push(`${ch}/${tk}/${id} 凭空数字 ${v.fakeNums.join(',')}`);
        if (v.lostProps.length) R.语义.push(`${ch}/${tk}/${id} 专名丢失 ${v.lostProps[0]}`);
        if (v.negSuspect) R.语义.push(`${ch}/${tk}/${id} 否定疑似反转 ${v.negSource}→0`);
      }
  // ⑤ 照抄检测（隔离难度残留段）
  if (src)
    for (const tk of Object.keys(tiers)) {
      const recap = `${RUN}/章recap_${TIERS[tk]}_第${ch}章.json`;
      if (!existsSync(recap)) continue;
      const q = JSON.parse(readFileSync(recap, 'utf-8')).quarantined || [];
      for (const { segment: id } of q.filter((x) => x.class === '难度残留')) {
        const prod = tiers[tk].segs.get(id);
        const s = src.get(id);
        if (prod && s && norm(prod) === norm(s)) R.照抄.push(`${ch}/${tk}/${id}`);
      }
    }
  // 累计未注率/句长分布
  for (const tk of Object.keys(tiers)) {
    const ann = annoTypes(tiers[tk].md);
    for (const t of tiers[tk].segs.values()) {
      const u = unnotedTokensOf(t, ann, isUnk);
      unnotedRate[tk].tok += u.tokens;
      unnotedRate[tk].unk += u.n;
      sentLens[tk].push(...sentLensOfSegs([t]));
    }
  }
}
// ⑥ 尾部
for (const tk of ['A', 'M', 'B']) {
  const s = [...sentLens[tk]].sort((a, b) => a - b);
  R.尾部[tk] = { P90: s[Math.floor(s.length * 0.9)], 均值: (s.reduce((a, b) => a + b, 0) / s.length).toFixed(1) };
}
const rate = (tk) => ((100 * unnotedRate[tk].unk) / unnotedRate[tk].tok).toFixed(2);
const dens = {};
for (const tk of ['A', 'M', 'B']) {
  let notes = 0,
    words2 = 0,
    worst = { d: 0, at: '' };
  for (const ch of CH) {
    const p = join(OUT, `第${ch}章`, `原文_${TIERS[tk]}_2026-09-12_工序化.md`);
    if (!existsSync(p)) continue;
    const md = readFileSync(p, 'utf-8');
    notes += (md.match(/（[^）]*）/g) || []).length;
    words2 += (clean(md).match(/[a-z]+/g) || []).length;
    for (const b of md.replace(/\r/g, '').split(/\n\s*\n/)) {
      const m = b.match(/^\[P(\d+)\]/);
      if (!m) continue;
      const d = (100 * (b.match(/（[^）]*）/g) || []).length) / Math.max(1, (clean(b).match(/[a-z]+/g) || []).length);
      if (d > worst.d) worst = { d: d, at: `${ch}/${m[1]}` };
    }
  }
  dens[tk] = { per100: ((100 * notes) / words2).toFixed(1), worst };
}
const dupAnno = [];
for (const ch of CH)
  for (const tk of ['A', 'M', 'B']) {
    const p = join(OUT, `第${ch}章`, `原文_${TIERS[tk]}_2026-09-12_工序化.md`);
    if (!existsSync(p)) continue;
    for (const b of readFileSync(p, 'utf-8')
      .replace(/\r/g, '')
      .split(/\n\s*\n/)) {
      const m = b.match(/^\[P(\d+)\]/);
      if (!m) continue;
      const ws = [...b.matchAll(/([A-Za-z][A-Za-z-]*)（[^）]*）/g)].map((x) => x[1].toLowerCase());
      const seen = new Set();
      for (const w of ws) {
        if (seen.has(w)) dupAnno.push(`${ch}/${tk}/${m[1]} 重复注 ${w}`);
        seen.add(w);
      }
    }
  }
console.log('=== 验收 v2 · 倒挂报告（现有稿） ===');
console.log(`全书未注生词率: A ${rate('A')}% / M ${rate('M')}% / B ${rate('B')}%  → 排序要求 B<M<A: ${rate('B') < rate('M') && rate('M') < rate('A') ? 'PASS' : 'FAIL（倒挂）'}`);
console.log(`注释密度(注/百词): ${['A', 'M', 'B'].map((tk) => `${tk} ${dens[tk].per100}（最差段 ${dens[tk].worst.at}=${dens[tk].worst.d.toFixed(1)}）`).join('　')}`);
console.log(`句长尾部: ${['A', 'M', 'B'].map((tk) => `${tk} 均${R.尾部[tk].均值}/P90=${R.尾部[tk].P90}`).join('  ')}`);
console.log(
  `结构问题 ${R.结构.length} 条｜同段倒挂 ${R.梯度.filter((x) => x.includes('B未注')).length} 章｜句长倒挂 ${R.梯度.filter((x) => x.includes('句长')).length} 章｜语义 ${R.语义.length} 条｜照抄 ${R.照抄.length} 段`,
);
R.结构.slice(0, 8).forEach((x) => console.log('  [结构]', x));
R.梯度.slice(0, 6).forEach((x) => console.log('  [梯度]', x));
R.语义.slice(0, 10).forEach((x) => console.log('  [语义]', x));
if (dupAnno.length) dupAnno.slice(0, 8).forEach((x) => console.log('  [重复注]', x));
const posAudit = [];
for (const ch of CH) {
  const ap = join(OUT, `第${ch}章`, '注位审计.json');
  if (existsSync(ap)) {
    const a = JSON.parse(readFileSync(ap, 'utf-8'));
    for (const d of a.detail || []) posAudit.push(`${ch} ${d.tag} ${d.reason}`);
  }
}
const hasPosAudit = posAudit.length > 0 || existsSync(join(OUT, '第一章', '注位审计.json'));
const posBad = [];
for (const ch of CH)
  for (const tk of ['A', 'M', 'B']) {
    const p = join(OUT, `第${ch}章`, `原文_${TIERS[tk]}_2026-09-12_工序化.md`);
    if (!existsSync(p)) continue;
    for (const m of readFileSync(p, 'utf-8').matchAll(/\b(in|to|at|and|that|be|about|of|for|or|but|was|is|the)（[^）]*）/g)) posBad.push(`${ch}/${tk} 注位 ${m[0].slice(0, 24)}`);
  }
if (posBad.length) posBad.slice(0, 8).forEach((x) => console.log('  [注位]', x));
if (hasPosAudit) {
  if (posAudit.length) {
    console.log(`注位（句法解析主路径）：挂起 ${posAudit.length}`);
    posAudit.slice(0, 6).forEach((x) => console.log('  [注位·挂起]', x));
  }
} else {
  console.log('⚠ 注位审计.json 缺失——退化为 PHRASE_WINDOW 兜底（v2.2 待办：主路径必须句法）');
}
if (POEM_SEGS_BAD.length) {
  console.log(`注册表校验 FAIL（${POEM_SEGS_BAD.length}）:`);
  POEM_SEGS_BAD.forEach((x) => console.log('  [注册表]', x));
}
writeFileSync(
  `${OUT}/验收v2_倒挂报告_2026-09-17.md`,
  `# 验收 v2 · 倒挂报告（现有稿，2026-09-17）\n\n全书未注生词率：A ${rate('A')}% / M ${rate('M')}% / B ${rate('B')}%（要求 B<M<A：${rate('B') < rate('M') && rate('M') < rate('A') ? 'PASS' : 'FAIL'}）\n\n句长：${['A', 'M', 'B'].map((tk) => `${tk} 均${R.尾部[tk].均值}/P90=${R.尾部[tk].P90}`).join('　')}\n\n## 结构（${R.结构.length}）\n${R.结构.join('\n') || '无'}\n\n## 层间梯度（${R.梯度.length}）\n${R.梯度.join('\n') || '无'}\n\n## 语义确定性校验（${R.语义.length}）\n${R.语义.join('\n') || '无'}\n\n## 隔离段原文照抄（${R.照抄.length}）\n${R.照抄.join('、') || '无'}\n`,
);
console.log('报告已写: 验收v2_倒挂报告_2026-09-17.md');
