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
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** 引擎目录：优先从项目配置读，其次环境变量，最后兜底本机默认 */
export let LTR = process.env.LAYERTEXT_ENGINE ?? '/Users/wayne/Desktop/工作文档库/05-网站与AI工作区/LayerText';
export const VWS = '/Users/wayne/Desktop/工作文档库/01-教学工作/名著阅读工作区_AnimalFarm';
export const KF = join(VWS, '知识文件');
export const KB_CSV = join(KF, 'AF审校知识库_v1.csv');
export const VOCAB_CSV = join(KF, '已知词汇库_v0.7.csv');
export const DICT_CSV = join(KF, 'AF注释词典_v1.csv');

/** 项目配置（可换书）：所有路径与书级配置的唯一入口。
 *  换一本名著只需改这个 JSON，或设环境变量 LAYERTEXT_PROJECT 指向新配置。 */
export const PROJECT_JSON = process.env.LAYERTEXT_PROJECT ?? join(VWS, '调适项目_AnimalFarm.json');

/** 读专名表（一行一名，忽略 # 注释与空行） */
export function loadProper(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8').split('\n')
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => l.toLowerCase());
}

/** 读项目配置 → 展开成脚本直接可用的常量（含专名表内容）
 *  这样脚本里不再出现任何绝对路径，也不再各自维护 PROPER。 */
export function loadProject(path = PROJECT_JSON) {
  const d = JSON.parse(readFileSync(path, 'utf-8'));
  const 书级 = d.书级 ?? {};
  if (d.引擎目录) LTR = d.引擎目录;
  return {
    ...d,
    引擎目录: d.引擎目录 ?? LTR,
    专名表路径: 书级.专名表,
    知识库路径: 书级.知识库,
    词典路径: 书级.词典,
    PROPER: loadProper(书级.专名表),
  };
}

/** AF 专名：人物/动物/地名/作品名（QC 不计 OOV，改写不加注）
 *  ⚠️ 已迁到 知识文件/专名_AnimalFarm.txt（每本书一份）；此处仅保留兜底默认值。
 *  2026-09-10 补 clover/squealer/mollie——原三份拷贝均漏，Squealer 曾注出 4 种不同意思。 */
export const PROPER = [
  'jones', 'major', 'snowball', 'napoleon', 'benjamin', 'muriel', 'bluebell', 'jessie', 'pincher',
  'boxer', 'moses', 'pilkington', 'frederick', 'minimus', 'whymper', 'manor', 'willingdon',
  'beauty', 'england', 'ireland', 'animal farm', 'clover', 'squealer', 'mollie',
];

const readCsvWords = (p, col = 0) =>
  readFileSync(p, 'utf-8').replace(/^\uFEFF/, '').split('\n').slice(1)
    .map((l) => l.split(',')[col]?.trim().toLowerCase())
    .filter(Boolean);

/** 已知词 + 规则屈折展开。正向生成而非反向剥后缀——反向剥会把 hissing→his、butting→but、manes→man。 */
export function loadKnownForms() {
  const base = new Set();
  for (const rel of ['assets/wordlists/curriculum_2022_level3_1600.txt', 'assets/wordlists/curriculum_2022_amendment.txt']) {
    const p = join(LTR, rel);
    if (!existsSync(p)) continue;
    for (const l of readFileSync(p, 'utf-8').split('\n')) {
      const w = l.trim().toLowerCase().split(/\s+/)[0];
      if (w) base.add(w);
    }
  }
  for (const w of readCsvWords(VOCAB_CSV)) base.add(w);
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
  return buildLexicon({
    plainWordlistTexts,
    vocabCsvTexts: [readFileSync(P.词库, 'utf-8')],
    properNouns: P.PROPER,
  });
}

/** 教师知识库加注词 → 释义（值含"复现/复数/比较级"者为流程标记，不是释义） */
export function loadKbGloss(path = KB_CSV) {
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
export function loadDict(path = DICT_CSV) {
  const m = new Map();
  if (!existsSync(path)) return m;
  for (const line of readFileSync(path, 'utf-8').replace(/^\uFEFF/, '').split('\n').slice(1)) {
    const [w, zh] = line.split(',');
    if (w && zh) m.set(w.trim().toLowerCase(), zh.trim());
  }
  return m;
}

/** 新词回写词典，保持跨章一致（下次遇到同词直接用既有释义） */
export function appendDict(entries, path = DICT_CSV) {
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
