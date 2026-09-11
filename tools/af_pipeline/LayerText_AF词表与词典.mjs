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
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
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

/* ────────────────────── 统一词典：增量 + 显式合并（并发安全） ────────────────────── */
/**
 * 审查报告 §三 点名的第一条规模崩点：「第二本书、第二位教师或同一书多层并行时，
 * 输出路径、会话日志、**统一词典**和标记文件可能互相覆盖」。
 *
 * `appendDict` 是「读整份 → 合并 → 写回整份」：两个进程同时跑，后写的把先写的整份盖掉
 * （lost update），表现是"明明配过的词下次又问一遍"，而且**不报任何错**。
 *
 * 改法：每个运行只往自己的私有目录写**增量**（不共享、不可能撞），
 * 合并变成显式的一步（`mergeDictIntoProject`），且是**原子替换 + 基线优先 + 冲突上报**。
 */
import { renameSync, readdirSync as _readdir, rmSync as _rm } from 'node:fs';

const dictMerge = async () => await import(`${LTR}/dist/src/core/dictmerge.js`);

/** 写运行私有的词典增量（append-only；同一运行多次调用按词去重，后写的同词同义忽略） */
export function writeDictDelta(deltaPath, entries, origin) {
  mkdirFor(deltaPath);
  const cur = existsSync(deltaPath) ? JSON.parse(readFileSync(deltaPath, 'utf-8')) : { origin, entries: [] };
  const seen = new Map(cur.entries.map((e) => [e.word, e]));
  for (const [w, zh] of entries) {
    const k = String(w).toLowerCase();
    if (!k || !zh || seen.has(k)) continue;
    seen.set(k, { word: k, zh: String(zh), source: `新配（${origin}）` });
  }
  cur.entries = [...seen.values()];
  cur.origin = origin;
  writeFileSync(deltaPath, JSON.stringify(cur, null, 2), 'utf-8');
  return cur.entries.length;
}

const mkdirFor = (p) => { try { mkdirSync(dirname(p), { recursive: true }); } catch { /* 已存在 */ } };

/** 在某份文件上做"独占"操作：锁文件 + 陈旧锁可夺（进程崩了不会把词典永久锁死）。
 *  纯逻辑（锁状态三态）在引擎 src/core/dictmerge.ts 里，可单测。 */
export async function withLock(lockPath, fn) {
  const { lockState } = await dictMerge();
  mkdirFor(lockPath);
  const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const readLock = () => { try { return JSON.parse(readFileSync(lockPath, 'utf-8')); } catch { return null; } };
  for (let i = 0; i < 2; i++) {
    const st = lockState(readLock(), Date.now(), isAlive);
    if (st === 'free' || st === 'stale') break;
    await new Promise((r) => setTimeout(r, 300));
  }
  const st = lockState(readLock(), Date.now(), isAlive);
  if (st === 'held') throw new Error(`词典被另一个进程占用（${lockPath}）——等它跑完或删掉锁文件`);
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() }), 'utf-8');
  try {
    return await fn();
  } finally {
    _rm(lockPath, { force: true });
  }
}

/** 找出所有运行私有的词典增量：两种布局都要认。
 *  · run 布局：`_运行/<runId>/词典增量.json`
 *  · legacy 布局：`_运行/<层><后缀>.词典增量.json`
 *  少认一种就会出现"明明配了释义却没合并进词典"，而且不报错。 */
export function findDictDeltas(outRoot) {
  const runRoot = join(outRoot, '_运行');
  const out = [];
  if (!existsSync(runRoot)) return out;
  for (const name of _readdir(runRoot)) {
    const runScoped = join(runRoot, name, '词典增量.json');
    const flat = join(runRoot, name);
    const candidates = [];
    if (existsSync(runScoped)) candidates.push([name, runScoped]);
    if (/^.+\.词典增量\.json$/.test(name) && existsSync(flat)) candidates.push([name.replace(/\.词典增量\.json$/, ''), flat]);
    for (const [origin, f] of candidates) {
      try {
        const o = JSON.parse(readFileSync(f, 'utf-8'));
        if (Array.isArray(o.entries) && o.entries.length) out.push({ origin: o.origin ?? origin, entries: o.entries, file: f });
      } catch {
        out.push({ origin, entries: [], file: f, bad: true });
      }
    }
  }
  return out;
}

/**
 * 合并：基线词典 + 所有运行私有的增量 → 原子替换基线词典。
 * 幂等；基线优先（教师定过的释义不被自动新配覆盖）；冲突上报给人，不静默择一。
 * @returns {{added:number, unchanged:number, conflicts:number, interConflicts:number, report:string[]}}
 */
export async function mergeDictIntoProject(P) {
  const { parseDictCsv, toDictCsv, mergeDict, describeMerge } = await dictMerge();
  const dictPath = P.词典路径;
  if (!dictPath) throw new Error('mergeDictIntoProject 需要词典路径（来自项目配置 书级.词典）');
  const found = findDictDeltas(P.产物目录);
  const deltas = found.filter((d) => !d.bad);
  const bad = found.filter((d) => d.bad);
  if (!deltas.length) {
    return {
      added: 0, unchanged: 0, conflicts: 0, interConflicts: 0,
      report: ['词典合并：没有增量，未改动', ...(bad.length ? [`⚠ ${bad.length} 份增量读不出来（已跳过）：${bad.map((b) => b.file).join('、')}`] : [])],
    };
  }
  const base = existsSync(dictPath) ? parseDictCsv(readFileSync(dictPath, 'utf-8')) : [];
  const merged = mergeDict(base, deltas);
  const next = toDictCsv(merged.entries);
  const prev = existsSync(dictPath) ? readFileSync(dictPath, 'utf-8') : '';
  if (next !== prev) {
    // 原子替换：先写临时文件再 rename（rename 在同一文件系统上是原子的），
    // 别人不会读到"写了一半的词典"
    const tmp = `${dictPath}.tmp-${process.pid}`;
    writeFileSync(tmp, next, 'utf-8');
    renameSync(tmp, dictPath);
  }
  return {
    added: merged.added,
    unchanged: merged.unchanged,
    conflicts: merged.conflicts.length,
    interConflicts: merged.interConflicts.length,
    report: describeMerge(merged),
  };
}

/** 新词回写词典，保持跨章一致（下次遇到同词直接用既有释义）。path 必传（词典路径来自项目配置）
 *  ⚠ 并发不安全（读整份→写回整份）。会话脚本已改为写运行私有增量 + `mergeDictIntoProject`；
 *  这个函数保留给单进程的维护脚本用。 */
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

/* ────────────────────── 运行身份：**唯一**的解析入口 ────────────────────── */

/**
 * 读运行身份。**所有脚本与 App 都从这里拿**，谁也不再自己读指针。
 *
 * 为什么要有这一个函数：原来 `会话改写.mjs` / `风险队列.mjs` / `决定汇总.mjs` / App 面板
 * 各自写了一遍"读 清单_最新.json → 再读它指的那份清单"。四份实现读的是**同一个全局指针**，
 * 于是两位教师同时跑同一本书的不同层级时，后跑者覆盖先跑者，先跑者的进程接着读到
 * **对方的 runId**，把产物写进对方的运行私有目录——而两边都报告成功。
 *
 * 现在：先读按 (教师, 层级) 分片的那份指针；全局"最近一次"只在教师与层级都对得上时才用；
 * 对不上就**拒绝采用**并响亮说明。判断逻辑在引擎的 `chooseIdentity`（有单测），
 * 这里只负责读盘。
 *
 * @param {{out:string, work:string}} roots
 * @param {{teacher?:string, tier?:string}} want  我这次是谁、跑哪一层
 * @param {{runId?:string}} [opts]              显式指定（`--run` / `LAYERTEXT_RUN`）
 */
export async function readRunIdentity(roots, want = {}, opts = {}) {
  const M = await import(`${LTR}/dist/src/core/manifest.js`);
  const runDir = join(roots.out, '_运行');
  const readPtr = (name) => {
    try {
      const raw = JSON.parse(readFileSync(join(runDir, name), 'utf-8'));
      if (!raw?.path) return null;
      // 指针只记"指向谁"；layout/teacher/tier 以**清单本身**为准。
      // 清单读不到 → 整份指针视为读不到：坏指针不许半途生效，半生效比彻底失效更危险。
      const m = JSON.parse(readFileSync(raw.path, 'utf-8'));
      return {
        path: raw.path,
        runId: m.runId ?? raw.runId ?? '',
        layout: m.layout ?? raw.layout ?? 'legacy',
        teacher: m.teacher ?? raw.teacher ?? 'unknown',
        tier: m.tier ?? raw.tier,
        updatedAt: raw.updatedAt,
      };
    } catch {
      return null;
    }
  };
  /* 层级名统一成**标签**（`A` → `A层85`）再算指针文件名。
   * 清单里记的是层键（`A`），而脚本与面板手里的是标签（`A层85`）——
   * 不归一就会出现"写的时候叫 清单_wayne_A.json、读的时候找 清单_wayne_A层85.json"，
   * 表现是**分片指针明明写了却永远读不到**，于是静默退回"最近一次"，
   * 而这次修复的全部意义恰恰是不再依赖"最近一次"。 */
  const tierTag = want.tier ? M.tierTagOf(want.tier) : undefined;
  const wantNorm = { ...want, tier: tierTag };
  const fallbackRunId = `${tierTag ?? 'unknown'}-${want.teacher ?? process.env.USER ?? 'unknown'}`;
  const choice = M.chooseIdentity({
    want: wantNorm,
    explicitRunId: opts.runId ?? process.env.LAYERTEXT_RUN,
    scoped: want.teacher || tierTag ? readPtr(M.pointerNameOf({ teacher: want.teacher ?? 'unknown', tier: tierTag })) : null,
    latest: readPtr(M.LATEST_POINTER_NAME),
    fallbackRunId,
  });
  return { ...choice.identity, source: choice.source, warning: choice.warning };
}
