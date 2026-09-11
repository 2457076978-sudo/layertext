#!/usr/bin/env node
/** AF 词表与注释词典 · 共享模块
 *
 * 为什么单独抽出来：PROPER / 词库路径原先在三个脚本里各写一份，2026-09-10 就是因为
 * 三份都漏了 clover/squealer/mollie 才注出"三叶草""告密者"这类错。集中一份，杜绝漂移。
 *
 * 判定口径（全部来自项目自身）：
 *   已知 = 课标2022三级1600表 ∪ 数词/星期/月份补丁 ∪ 学生词库 v0.6，做规则屈折展开
 *   教师知识库（AF审校知识库_v1.csv 加注词）= 最高优先，永远保留
 *   专名（PROPER）= 不计生词、不加注
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 引擎目录：本文件在 <引擎>/tools/af_pipeline/ 下，由自身位置推出，不写死绝对路径。
 *  可用环境变量 LAYERTEXT_ENGINE 或项目配置的 `引擎目录` 覆盖。 */
const HERE = dirname(fileURLToPath(import.meta.url));
export let LTR = process.env.LAYERTEXT_ENGINE ?? join(HERE, '..', '..');

/** 找一个项目的配置：环境变量 LAYERTEXT_PROJECT 优先；
 *  否则从当前目录向上逐级找 `调适项目_*.json`（最多 5 层）。
 *  2026-09-10 修复：原先这里写死了 Animal Farm 的绝对路径，是"换一本书第一步就断"的根源。 */
export const PROJECT_POINTER = join(process.env.HOME ?? '.', '.layertext.project');

export function findProjectFile(start = process.cwd()) {
  // ① 环境变量最优先（显式指定 → 不写指针。否则"临时跑一下别的书"会把默认项目带跑偏）
  if (process.env.LAYERTEXT_PROJECT) return { path: process.env.LAYERTEXT_PROJECT, sticky: false };
  // ② 从当前目录向上找 调适项目_*.json
  let cur = start.replace(/\/+$/, '');
  for (let i = 0; i < 5 && cur && cur !== '/'; i++) {
    try {
      const hit = readdirSync(cur).find((f) => /^调适项目_.*\.json$/.test(f));
      if (hit) return { path: join(cur, hit), sticky: true };
    } catch { /* 目录不可读就往上走 */ }
    cur = cur.replace(/\/[^/]+$/, '');
  }
  // ③ 上次用过的项目（脚本每次成功载入后写下的指针，免去每次 cd 或 export）
  try {
    if (existsSync(PROJECT_POINTER)) {
      const last = readFileSync(PROJECT_POINTER, 'utf-8').trim();
      if (last && existsSync(last)) return { path: last, sticky: false };
    }
  } catch { /* 指针坏了就当没有 */ }
  return null;
}

/** 读专名表（一行一名，忽略 # 注释与空行） */
export function loadProper(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8').split('\n')
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => l.toLowerCase());
}

/** 读项目配置 → 展开成脚本直接可用的常量（含专名表内容）
 *  这样脚本里不再出现任何绝对路径，也不再各自维护 PROPER。 */
export function loadProject(path) {
  let sticky = false;
  if (!path) {
    const found = findProjectFile();
    if (found) { path = found.path; sticky = found.sticky; }
  }
  if (!path) {
    throw new Error(
      '找不到 调适项目_*.json。三种解法任选：\n' +
      '  ① 设环境变量 LAYERTEXT_PROJECT=/绝对路径/调适项目_我的书.json\n' +
      '  ② 在工作区目录（或在它的子目录）里运行脚本\n' +
      '  ③ 传 --project /绝对路径/调适项目_我的书.json（管线脚本支持）',
    );
  }
  if (!existsSync(path)) throw new Error(`项目配置不存在：${path}`);
  // 记下"上次在目录里找到的项目"，下次在任何目录下跑都不用再设环境变量。
  // 显式传路径 / 设环境变量时不写指针——避免"临时跑一下别的项目"把默认带跑偏。
  if (sticky) { try { writeFileSync(PROJECT_POINTER, path + '\n', 'utf-8'); } catch { /* 只读环境就算了 */ } }
  const d = JSON.parse(readFileSync(path, 'utf-8'));
  const 书级 = d.书级 ?? {};
  if (d.引擎目录) LTR = d.引擎目录;
  return {
    ...d,
    配置路径: path,
    引擎目录: d.引擎目录 ?? LTR,
    专名表路径: 书级.专名表,
    知识库路径: 书级.知识库,
    词典路径: 书级.词典,
    PROPER: loadProper(书级.专名表),
  };
}

const readCsvWords = (p, col = 0) =>
  readFileSync(p, 'utf-8').replace(/^\uFEFF/, '').split('\n').slice(1)
    .map((l) => l.split(',')[col]?.trim().toLowerCase())
    .filter(Boolean);

/** 已知词 + 规则屈折展开。正向生成而非反向剥后缀——反向剥会把 hissing→his、butting→but、manes→man。 */
export function loadKnownForms(P) {
  const base = new Set();
  for (const rel of ['assets/wordlists/curriculum_2022_level3_1600.txt', 'assets/wordlists/curriculum_2022_amendment.txt']) {
    const p = join(LTR, rel);
    if (!existsSync(p)) continue;
    for (const l of readFileSync(p, 'utf-8').split('\n')) {
      const w = l.trim().toLowerCase().split(/\s+/)[0];
      if (w) base.add(w);
    }
  }
  if (P?.词库) for (const w of readCsvWords(P.词库)) base.add(w);
  const forms = new Set(base);
  const V = 'aeiou';
  for (const w of base) {
    forms.add(w + 's').add(w + 'ed').add(w + 'd').add(w + 'ing').add(w + 'er').add(w + 'est').add(w + 'ly');
    if (w.endsWith('e')) forms.add(w.slice(0, -1) + 'ing').add(w.slice(0, -1) + 'ed');
    // 辅音双写：末位辅音 + 前一位元音（run→running / stop→stopping / hit→hitting）。
    // 会顺带生成 visit→visitting 这类非标准形，但多生成只是"更宽容"，不会误判真实词形。
    const last = w[w.length - 1];
    if (!V.includes(last) && w.length >= 3 && V.includes(w[w.length - 2])) forms.add(w + last + 'ing').add(w + last + 'ed');
    if (w.endsWith('y')) forms.add(w.slice(0, -1) + 'ies').add(w.slice(0, -1) + 'ied');
    if (/[sxz]$/.test(w) || /(ch|sh|o)$/.test(w)) forms.add(w + 'es');
  }
  return forms;
}

/** 该词形是否属于"学生已学"（课标/词库任一） */
export const isKnownForm = (word, forms) => forms.has(word.toLowerCase());

/** 统一的 QC 词表：内置课标1600 + 补录（数词/星期/月份）+ 项目词库 + 本书专名。
 *  2026-09-10 修复两处口径错误：
 *   ① 原先只喂 `vocabCsvTexts`（项目词库），**没喂内置课标词表与补录** —— 与 App/CLI 的口径不一致，
 *      于是 eighteen / three 这类数词被判成生词并加注，生词率整体虚高。
 *   ② `properNouns` 是 buildLexicon 的参数，原先却传给了 runQc（无效），Napoleon/Squealer
 *      被算成生词。现在专名一律从项目配置的专名表读。 */
export async function loadLexicon(P) {
  const { buildLexicon } = await import(`${P.引擎目录}/dist/src/core/lexicon.js`);
  const plainWordlistTexts = [
    join(LTR, 'assets/wordlists/curriculum_2022_level3_1600.txt'),
    join(LTR, 'assets/wordlists/curriculum_2022_amendment.txt'),
  ]
    .filter((p) => existsSync(p))
    .map((p) => readFileSync(p, 'utf-8'));
  // 教材进度 → 已学词，并进"已知"口径。
  // 2026-09-10 修复：loadTextbookLearned 原先只被 管线.mjs 拿去打印一行日志，
  // 生成/复核脚本根本不消费它 —— 也就是说"教材进度接入 QC 口径"这句承诺是空的。
  // 未配置 教材进度 时（默认 null）行为不变，已报出的数字不受影响。
  const learned = loadTextbookLearned(P);
  if (learned?.size) plainWordlistTexts.push([...learned].join('\n'));
  return buildLexicon({
    plainWordlistTexts,
    vocabCsvTexts: [readFileSync(P.词库, 'utf-8')],
    properNouns: P.PROPER,
  });
}

/** 引擎口径的"已知"判定（与 QC 完全同一套：不规则形 + 后缀还原）。
 *  2026-09-10 修复：修复脚本原先用 loadKnownForms 的规则展开（给每个词加 ly/s/ed…），
 *  比引擎宽 —— 于是它删掉了引擎仍判为 OOV 的词的注释（如 curiously / nightly），
 *  覆盖率随之下跌，两边规则互相打架。现在两边共用同一个判定。 */
export async function makeKnownChecker(P) {
  const { hit } = await import(`${P.引擎目录}/dist/src/core/textpipe.js`);
  const LEX = await loadLexicon(P);
  return (w) => hit(String(w).toLowerCase(), LEX.known);
}

/** 教师知识库加注词 → 释义（值含"复现/复数/比较级"者为流程标记，不是释义） */
export function loadKbGloss(path) {
  const m = new Map();
  if (!existsSync(path)) return m;
  for (const line of readFileSync(path, 'utf-8').replace(/^\uFEFF/, '').split('\n').slice(1)) {
    const [type, word, val, n] = line.split(',');
    if (type !== '加注词' || !word || !val) continue;
    if (/复现|复数|比较级/.test(val)) continue;
    const w = word.toLowerCase();
    const prev = m.get(w);
    if (!prev || (Number(n) || 0) > prev.n) m.set(w, { zh: val, n: Number(n) || 0 });
  }
  return m;
}

/** 统一注释词典（word → 中文释义）：跨章同词同义的正本 */
export function loadDict(path) {
  const m = new Map();
  if (!existsSync(path)) return m;
  for (const line of readFileSync(path, 'utf-8').replace(/^\uFEFF/, '').split('\n').slice(1)) {
    const [w, zh] = line.split(',');
    if (w && zh) m.set(w.trim().toLowerCase(), zh.trim());
  }
  return m;
}

/** 按 [P##] 标记切段 → [{ id:'P07', text:'[P07] …' }]，保留原有顺序。
 *
 *  为什么按标记而不是按数组下标对齐（2026-09-11 审查报告 P0 的配套修正）：
 *   段级门禁把"未通过"的段挡在正文之外，产物里就会出现空位。
 *   若用下标配对原文与产物，空位之后的**每一段都会错位一格**——
 *   风险队列会把第 8 段的原句配到第 7 段的改写上，人看到的对照全是错的。
 *   标记是段落的稳定 ID，按它对齐才对。 */
export function segmentList(md) {
  const text = String(md);
  // ★ 必须先切掉 `## Chapter` 之前的前置说明区。
  //   实测（Animal Farm 第一章）：前置块里写着一句「[P14] 为稳定锚，改写稿沿用同ID。」——
  //   那是**在说**段号，不是段号本身。不切头部就会把它当成一个段落，
  //   于是原文/产物各多出一个幽灵段，索引整体错位，而且"14"还会被当成数字事实信号，
  //   让风险队列最前面几条全是假警报（教师看两条就会开始忽略整个队列）。
  const hm = text.match(/## Chapter \w+[^\n]*/);
  const after = hm ? text.slice((hm.index ?? 0) + hm[0].length) : text;
  const body = after.split('## 词句卡')[0];
  return [...body.matchAll(/\[(P\d+)\][\s\S]*?(?=\[P\d+\]|$)/g)].map((m) => ({ id: m[1], text: m[0] }));
}

/** 未通过门禁的段落在产物里的占位标记。
 *  写成 HTML 注释：教师打开文件能一眼看到缺口在哪，
 *  而分句/分词（textpipe）不含 2 个以上连续字母，**不会污染任何 QC 指标**。 */
export const REVIEW_PLACEHOLDER = (id, dir) =>
  `[${id}] <!-- 本段未通过复检，未收录；原文与改写见 ${dir} -->`;

/** 新词回写词典，保持跨章一致（下次遇到同词直接用既有释义）。path 必传（词典路径来自项目配置） */
export function appendDict(entries, path) {
  if (!path) throw new Error('appendDict 需要词典路径（来自项目配置的 书级.词典）');
  const m = loadDict(path);
  let added = 0;
  for (const [w, zh] of entries) {
    const k = String(w).toLowerCase();
    if (!m.has(k) && zh) { m.set(k, zh); added++; }
  }
  if (added) {
    const rows = ['词,释义,来源', ...[...m].sort((a, b) => a[0].localeCompare(b[0])).map(([w, zh]) => `${w},${zh},${loadKbGloss().has(w) ? '教师知识库' : '归一（多数票）'}`)];
    writeFileSync(path, '\uFEFF' + rows.join('\n') + '\n', 'utf-8');
  }
  return added;
}

/* ────────── 教材进度 → 已学词（2026-09-10 新增） ────────── */

/** 从教材单元知识库 + 进度，算出"该学生群体已学词"。
 *  用途：① 作为 QC 已知词口径（比整册词库更准）② 注入生成提示词
 *  project.教材单元库 指向 教材单元_人教版.json；project.教材进度 形如 "九上:U4" 或 {at:"九上:U4", half:true}
 *  未配置时返回 null（脚本沿用原口径，不改已报数字）。 */
export function loadTextbookLearned(project) {
  const 库 = project.教材单元库;
  const 进度 = project.教材进度;
  if (!库 || !进度 || !existsSync(库)) return null;
  const d = JSON.parse(readFileSync(库, 'utf-8'));
  const at = typeof 进度 === 'string' ? 进度 : 进度.at;
  const half = typeof 进度 === 'object' && 进度.half;
  const ORDER = ['七上', '七下', '八上', '八下', '九上', '九下'];
  const [book, unitRaw] = at.split(/[:：]/);
  const unum = Number((unitRaw ?? 'U1').match(/U(\d+)/i)?.[1] ?? 1);
  const learned = new Set(d.base ?? []);
  const bIdx = ORDER.indexOf(book.trim());
  for (const [b, us] of Object.entries(d.books ?? {})) {
    const bi = ORDER.indexOf(b);
    if (bi < bIdx) { for (const c of Object.values(us)) (c.词 ?? []).forEach((w) => learned.add(w)); continue; }
    if (b !== book.trim()) continue;
    for (const [u, c] of Object.entries(us)) {
      // "（未标单元）"→ 999：当前这册没学完时不计入（可能来自后面单元）；
      // 已学完的册走上面 bi < bIdx 分支，整册计入。两个分支规则一致。
      const n = Number((u.match(/U(\d+)/i) ?? [])[1] ?? 999);
      if (n < unum) (c.词 ?? []).forEach((w) => learned.add(w));
      else if (n === unum) {
        const ws = c.词 ?? [];
        (half ? ws.slice(0, Math.ceil(ws.length / 2)) : ws).forEach((w) => learned.add(w));
      }
    }
  }
  return learned;
}
