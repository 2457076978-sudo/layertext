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
 *
 * ── 词表正本（LexiconData）：2026-09 新增，总计划阶段 3 ────────────────────
 * 计划原话：「旧 CSV/JSON 只做一次导入，不再作为新的事实源。」
 *
 * 改造前：`LexiconSnapshot` 只是一枚**审计指纹**（路径+哈希+词数+抽样），它不含数据，
 * 于是本模块的每个 loader 仍然自己去读 CSV。后果是——有人在一本书跑到第 3 天时改了
 * `词库.csv`，第 4 天的脚本**照旧读新词表**，前三天按旧口径、第四天按新口径，
 * 中间没有任何东西会说话；`清单 --verify` 要等全部跑完才报漂移，那时两套口径已经混在一起了。
 *
 * 改造后：`清单.mjs --new`（或 `--reimport`）把词表**材料化成一份正本**写进
 * `<产物目录>/_运行/LexiconData.json`；本模块的所有 loader 优先读它。
 * 三条硬规矩：
 *   ① 导入只在**一处**发生（`importLexiconStore`），脚本不许各读一份；
 *   ② 正本与现场 CSV 对不上时**拒绝开工**（不是警告、不是自动重导入，理由见
 *      `src/core/lexiconstore.ts` 的 `decideLexiconSource`）；
 *   ③ **从没导入过的项目一字不变**：没有正本就照旧直读 CSV（legacy 路径，见
 *      `lexiconStoreState` / `decideLexiconSource` 的 `legacy` 分支），
 *      教师已有的书与脚本一个字都不用改。
 */
import { closeSync, openSync, readFileSync, writeFileSync, writeSync, existsSync, readdirSync, mkdirSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 引擎目录：本文件在 <引擎>/tools/af_pipeline/ 下，由自身位置推出，不写死绝对路径。
 *  可用环境变量 LAYERTEXT_ENGINE 或项目配置的 `引擎目录` 覆盖。 */
const HERE = dirname(fileURLToPath(import.meta.url));
export let LTR = process.env.LAYERTEXT_ENGINE ?? join(HERE, '..', '..');

/** 引擎的**编译产物**目录。默认 `<引擎>/dist`。
 *  `LAYERTEXT_DIST` 是给"把引擎编到自己的 outDir 再验证"用的逃生门——
 *  多人/多 agent 并行改同一个仓库时，谁都不许去写共享的 `dist/`，也不必等它被重建。 */
export const distOf = (engineDir = LTR) => process.env.LAYERTEXT_DIST ?? join(engineDir, 'dist');

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
    } catch {
      /* 目录不可读就往上走 */
    }
    cur = cur.replace(/\/[^/]+$/, '');
  }
  // ③ 上次用过的项目（脚本每次成功载入后写下的指针，免去每次 cd 或 export）
  try {
    if (existsSync(PROJECT_POINTER)) {
      const last = readFileSync(PROJECT_POINTER, 'utf-8').trim();
      if (last && existsSync(last)) return { path: last, sticky: false };
    }
  } catch {
    /* 指针坏了就当没有 */
  }
  return null;
}

/** 读专名表（一行一名，忽略 # 注释与空行）——
 *  **直读文件**的那一份。对外请用 `loadProper`（它会优先读词表正本）。 */
export function readProperLive(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.toLowerCase());
}

/** 最近一次载入的项目。路径型 loader（loadDict/loadKbGloss）手里只有路径，
 *  要靠它才知道"该读哪一本书的正本"。**每个脚本第一件事都是 loadProject()**，
 *  这不是巧合，是约定（也是唯一没有把 P 传遍所有 loader 的原因）。 */
let _activeProject = null;

/** 读项目配置 → 展开成脚本直接可用的常量（含专名表内容）
 *  这样脚本里不再出现任何绝对路径，也不再各自维护 PROPER。 */
export function loadProject(path) {
  let sticky = false;
  if (!path) {
    const found = findProjectFile();
    if (found) {
      path = found.path;
      sticky = found.sticky;
    }
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
  if (sticky) {
    try {
      writeFileSync(PROJECT_POINTER, path + '\n', 'utf-8');
    } catch {
      /* 只读环境就算了 */
    }
  }
  const d = JSON.parse(readFileSync(path, 'utf-8'));
  const 书级 = d.书级 ?? {};
  if (d.引擎目录) LTR = d.引擎目录;
  /* PROPER 也走词表正本（见 `loadProper`），而 `loadProper` 需要先知道"当前项目是谁"
   * 才能找到那份正本——所以**先挂 P 再补 PROPER**。顺序反过来，载入配置时就会直读 CSV，
   * 而 CSV 正是这次要退出事实源位置的东西。 */
  const P = {
    ...d,
    配置路径: path,
    引擎目录: d.引擎目录 ?? LTR,
    专名表路径: 书级.专名表,
    知识库路径: 书级.知识库,
    词典路径: 书级.词典,
    PROPER: [],
  };
  _activeProject = P;
  // tolerant：漂移/坏正本只**喊出来**，不在这一行拦死——`清单 --verify` 得能在坏项目上跑起来
  P.PROPER = loadProper(书级.专名表, { tolerant: true });
  return P;
}

const readCsvWords = (p, col = 0) =>
  readFileSync(p, 'utf-8')
    .replace(/^\uFEFF/, '')
    .split('\n')
    .slice(1)
    .map((l) => l.split(',')[col]?.trim().toLowerCase())
    .filter(Boolean);

/* ────────────────────── 词表正本：预载引擎侧的模块 ────────────────────── */
/**
 * 这里为什么有一个**顶层 await**（本仓库其他工具脚本都避开的写法）：
 *
 * `loadProper` / `loadDict` / `loadKbGloss` / `loadKnownForms` 都是**同步** API，
 * 15 个管线脚本都这么调（`const DICT = loadDict(P.词典路径);`）。计划要求"只做一次导入"
 * 这条改造**只动共享模块这一处**，不许去改 15 个脚本；而 ESM 没有同步 import。
 * 判定逻辑（`src/core/lexiconstore.ts`）又必须**只写一份**——在这里用 JS 再抄一份
 * "该读正本还是读 CSV"，就是给自己埋一个"两套规则迟早不一致"的雷。
 * 所以：模块加载时把引擎侧模块预载好，同步 loader 直接用现成的引用。
 *
 * 加载不到时（dist 没编、项目指向了另一个引擎目录）**不放行**：
 *   · 项目**没有**正本 → 走 legacy，现有行为一字不变；
 *   · 项目**有**正本 → 拒绝。不许"读不到校验器就直读 CSV"——那正是这次要消灭的静默降级。
 */
const _preloadEngineDir = (() => {
  try {
    const found = findProjectFile();
    if (!found) return LTR;
    return JSON.parse(readFileSync(found.path, 'utf-8')).引擎目录 ?? LTR;
  } catch {
    return LTR;
  }
})();

const _engineMods = { manifest: null, store: null, files: null };
/** 预载失败的原因（人话，按模块分开放）。`engineModsFor` 会把它变成一句可执行的建议 */
const _engineLoadErrors = {};
for (const [key, file] of [
  ['manifest', 'manifest.js'],
  ['store', 'lexiconstore.js'],
  ['files', 'files.js'],
]) {
  try {
    _engineMods[key] = await import(`${distOf(_preloadEngineDir)}/src/core/${file}`);
  } catch (e) {
    // 只有"文件不在"才是可接受的（dist 还没编）；模块本身有语法错之类必须炸出来
    if (e?.code !== 'ERR_MODULE_NOT_FOUND' && e?.code !== 'ERR_UNSUPPORTED_DIR_IMPORT') throw e;
    _engineLoadErrors[key] = `${distOf(_preloadEngineDir)}/src/core/${file} 加载不了：${e?.message ?? e}`;
  }
}

/** 正本的接口名（与引擎侧 `LEXICON_STORE_FILE` 必须一致；不一致就当场说，不靠自觉） */
const STORE_FILE = 'LexiconData.json';

/** 项目配的是**另一个**引擎目录时，预载的这些就不是它的判定逻辑——这一条与"没编"是两回事 */
const _engineDirProblem = (P) =>
  !process.env.LAYERTEXT_DIST && P && (P.引擎目录 ?? LTR) !== _preloadEngineDir
    ? `项目配的引擎目录是 ${P.引擎目录}，而本模块预载的是 ${_preloadEngineDir}（用 LAYERTEXT_ENGINE / LAYERTEXT_DIST 显式指定可消除歧义）`
    : null;

/**
 * 取引擎模块。**分两档要求**，是为了让"缺哪一个"这句话是准的：
 *   · `core`  —— 来源哈希（`refOf`/`contentHash`）：来源列表与漂移比对要用；
 *   · `store` —— 正本判定（`lexiconstore.js`）：只有"有正本"的项目才用得上。
 * 合成一档的后果：dist 只要没编新模块，连"列出这本项目的来源"都会失败，
 * 而那句话还说不清到底缺的是什么。
 */
function engineModsFor(P, level = 'store') {
  const mods = _engineMods;
  const dirProblem = _engineDirProblem(P);
  if (dirProblem) return { mods: null, why: dirProblem };
  if (!mods.manifest) return { mods: null, why: _engineLoadErrors.manifest ?? '引擎模块未能预载' };
  if (level === 'store') {
    if (!mods.store || !mods.files) {
      const missing = [...(mods.store ? [] : [_engineLoadErrors.store ?? 'src/core/lexiconstore.js']), ...(mods.files ? [] : [_engineLoadErrors.files ?? 'src/core/files.js'])];
      return { mods: null, why: `${missing.join('；')}（引擎目录需要先 \`npx tsc -p tsconfig.json\` 才有词表正本能力）` };
    }
    if (mods.store.LEXICON_STORE_FILE !== STORE_FILE) {
      return { mods: null, why: `引擎侧的正本文件名改成了「${mods.store.LEXICON_STORE_FILE}」，本模块还在找「${STORE_FILE}」` };
    }
  }
  return { mods, why: null };
}

/* ────────────────────── 词表正本：读哪一份、什么时候拒绝 ────────────────────── */

/** 读取方式：auto（默认，有正本读正本）｜live（明知漂移也按现场 CSV 跑）｜reimport（导入步骤专用） */
const lexiconMode = () => process.env.LAYERTEXT_LEXICON ?? 'auto';
const storeDirOf = (P) => join(P.产物目录, '_运行');
export const storePathOf = (P) => join(storeDirOf(P), STORE_FILE);

/** 正本真正的出处。**与快照的 sources 不是同一份清单**：那一份里还有"情节底线"这类
 *  与词义无关的输入，拿它当漂移基准，会让"改了一句剧情底线"也拦下一次词表读取——
 *  假警报比没有警报更坏（教师看到两条就会开始忽略整个队列）。 */
function lexiconInputFiles(P) {
  const files = [];
  const add = (name, path) => {
    if (path && existsSync(path)) files.push([name, path]);
  };
  add('内置课标词表', join(LTR, 'assets/wordlists/curriculum_2022_level3_1600.txt'));
  add('内置补录', join(LTR, 'assets/wordlists/curriculum_2022_amendment.txt'));
  add('词库', P.词库);
  add('专名表', P.专名表路径);
  add('知识库', P.知识库路径);
  add('词典', P.词典路径);
  // 教材单元库**只在配了「教材进度」时参与**：没配时 loadTextbookLearned 返回 null，
  // 它变了也不会改任何一个词的判定——把它算进出处，只会得到一次凭空的拒绝。
  if (P.教材进度) add('教材单元库', P.教材单元库);
  return files;
}

/** 一趟读盘算出正本的现场哈希。**只在真的要判定时读**：legacy 项目一次都不读。 */
function hashLexiconInputs(P) {
  const { mods } = engineModsFor(P, 'core');
  return lexiconInputFiles(P).map(([name, path]) => mods.manifest.refOf(name, path, readFileSync(path, 'utf-8')));
}

/** 便宜的文件指纹（mtime+size）：判断"这一趟里文件动过没有"，不必重算哈希 */
const stampOf = (path) => {
  try {
    const s = statSync(path);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return '不存在';
  }
};
const inputStamps = (P) =>
  lexiconInputFiles(P)
    .map(([, p]) => stampOf(p))
    .join(',');

let _storeCache = null;

/**
 * 这一次到底读正本还是读 CSV——**唯一的判定入口**（判定规则本身在
 * `src/core/lexiconstore.ts` 的 `decideLexiconSource`，这里只负责读盘与缓存）。
 *
 * 缓存键里带**现场文件的 mtime+size**：同一个进程里有人边跑边改词库，下一次 loader
 * 调用就会重算，把漂移当场喊出来。缓存省的是哈希，不是"改没改"这件事。
 */
export function lexiconStoreState(P = _activeProject) {
  if (!P) return { mode: 'legacy', store: null, drift: null, notices: [], refusal: '' };
  const mode = lexiconMode();
  const storePath = storePathOf(P);
  const key = [P.产物目录, mode, storePath, stampOf(storePath), inputStamps(P)].join('|');
  if (_storeCache?.key === key) return _storeCache.state;
  const state = computeStoreState(P, mode);
  _storeCache = { key, state };
  return state;
}

function computeStoreState(P, mode) {
  const { mods, why } = engineModsFor(P);
  const storePath = storePathOf(P);
  const exists = existsSync(storePath);
  if (!mods) {
    return exists
      ? {
          mode: 'broken',
          store: null,
          drift: null,
          notices: [`✗ 有词表正本但校验它的引擎模块加载不到：${why}`],
          refusal:
            `词表正本存在（${storePath}）但**校验它的引擎模块加载不到**：${why}\n` +
            `  **不会退回直读 CSV**——"读不到校验器就直接读文件"正是这次改造要消灭的静默降级。\n` +
            `  修：在引擎目录里 \`npx tsc -p tsconfig.json\`，或用 LAYERTEXT_DIST=<已编译的产物目录> 指明一份`,
        }
      : {
          mode: 'legacy',
          store: null,
          drift: null,
          // 不提"引擎模块没加载上"：没有正本的项目根本用不到它，说了只是噪音。
          // 真需要它的时刻（有正本要校验）由上面的 broken 分支说清楚。
          // 也不在这里重复"怎么修"那句话——完整措辞在引擎侧（`decideLexiconSource`），只写一份。
          notices: [`没有词表正本（${storePath} 不存在）——走**首次导入之前**的既有行为：直读现场 CSV。`],
          refusal: '',
        };
  }
  let store = null;
  let broken = null;
  if (exists) {
    try {
      const parsed = mods.store.parseLexiconStore(readFileSync(storePath, 'utf-8'));
      if (parsed.ok) store = parsed.store;
      else broken = parsed.error;
    } catch (e) {
      broken = `读不出来：${e?.message ?? e}`;
    }
  }
  const live = store && mode !== 'live' ? hashLexiconInputs(P) : null;
  return mods.store.decideLexiconSource({ store, broken, live, override: mode, storePath });
}

const _announced = new Set();
/** 同一句话在一趟运行里重复十遍，等于没打印 */
function announce(notices) {
  for (const n of notices ?? []) {
    if (_announced.has(n)) continue;
    _announced.add(n);
    console.error(`[词表] ${n}`);
  }
}

/** 每个 loader 的第一行：**先问"这次能不能开工"**，再谈读什么。
 *  拒绝（漂移/正本坏了/校验器加载不到）在这里抛出——同步接口，抛出去脚本就停在这一行，
 *  走不到"用一套说不清的口径去生成产物"那一步。 */
function usableState(P) {
  const st = lexiconStoreState(P ?? _activeProject);
  announce(st.notices);
  if (st.refusal) throw new Error(st.refusal);
  return st;
}

/** 专名表：正本里有就用正本，否则直读文件（legacy）。
 *  路径对不上就直读——正本描述的是**它自己那份**专名表，不是随便哪个路径。
 *
 *  `tolerant` 只给 `loadProject` 用：**载入配置不该把整个脚本拦死**。
 *  理由是审计：`清单 --verify` 恰恰要在"正本已经过期/坏掉"的项目上跑起来，
 *  才能告诉你差在哪几个词、该跑哪条命令。拒绝必须发生在**真正要消费词表的那一行**
 *  （`loadLexicon` / `loadDict` / `loadKbGloss` / `loadKnownForms`），
 *  而不是"连专名表都不让人看"。即便如此，漂移也会在这里当场打印出来（见 announce）。 */
export function loadProper(path, opts = {}) {
  const st = opts.tolerant ? lexiconStoreState(_activeProject) : usableState(_activeProject);
  if (opts.tolerant) announce(st.notices);
  if (st.mode === 'store') {
    const src = st.store.inputs.find((s) => s.name === '专名表');
    if (src && src.path === path) return [...st.store.data.proper];
  }
  return readProperLive(path);
}

/** 规则屈折展开。**单独一个函数**是为了让"读正本"与"读 CSV"两条路走同一套展开——
 *  两条路各写一份展开，就会有一天只在其中一条上改了规则。 */
function expandForms(base) {
  const forms = new Set(base);
  const V = 'aeiou';
  for (const w of base) {
    forms
      .add(w + 's')
      .add(w + 'ed')
      .add(w + 'd')
      .add(w + 'ing')
      .add(w + 'er')
      .add(w + 'est')
      .add(w + 'ly');
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

/** 已知词 + 规则屈折展开。正向生成而非反向剥后缀——反向剥会把 hissing→his、butting→but、manes→man。
 *
 *  读正本时用 `data.wordlists`（内置课标表 + 补录 + 词库首列）**而不是 data.known**：
 *  两者口径历史上就不同（`known` 只收 单词/课标词/待定词 三类，wordlists.vocab 含短语与句型）。
 *  在这里"顺手统一"，就是顺手改掉一批词算不算"已学"——不予采纳。 */
export function loadKnownForms(P) {
  const st = usableState(P ?? _activeProject);
  if (st.mode === 'store') {
    const w = st.store.data.wordlists;
    return expandForms(new Set([...w.curriculum, ...w.amendment, ...w.vocab]));
  }
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
  return expandForms(base);
}

/** 该词形是否属于"学生已学"（课标/词库任一） */
export const isKnownForm = (word, forms) => forms.has(word.toLowerCase());

/** 统一的 QC 词表：内置课标1600 + 补录（数词/星期/月份）+ 项目词库 + 本书专名。
 *  2026-09-10 修复两处口径错误：
 *   ① 原先只喂 `vocabCsvTexts`（项目词库），**没喂内置课标词表与补录** —— 与 App/CLI 的口径不一致，
 *      于是 eighteen / three 这类数词被判成生词并加注，生词率整体虚高。
 *   ② `properNouns` 是 buildLexicon 的参数，原先却传给了 runQc（无效），Napoleon/Squealer
 *      被算成生词。现在专名一律从项目配置的专名表读。
 *
 *  读正本时返回的是 `data.known/pending`——**导入当天逐字冻结下来的那两个集合**。
 *  这就是"旧 CSV 只做一次导入"的落点：CSV 之后再改，也改不动这一次的判定。 */
export async function loadLexicon(P) {
  // 这里不用 `usableState`：拒绝之前要先算出现场口径，才能把**逐词代价**一并说出来
  const st = lexiconStoreState(P ?? _activeProject);
  announce(st.notices);
  if (st.mode === 'store') {
    return { known: new Set(st.store.data.known), pending: new Set(st.store.data.pending) };
  }
  const LIVE = await liveLexicon(P);
  /* 漂移/正本坏了：**先把差异算出来再抛**。
   * 只说"词表变了"是没用的——人要判断的是"变了要不要紧"：改了一个错别字的漂移，
   * 重导入一次就完事；翻了 30 个词判定的漂移，得先停下来想清楚。
   * 所以这里把现场口径也算一遍，给出逐词代价，然后才拒绝。 */
  if (st.store && st.drift && st.mode === 'drift') {
    const { mods } = engineModsFor(P);
    if (mods) throw new Error(`${st.refusal}\n  代价（逐词）：${mods.store.describeWordDiff(mods.store.diffWordSets(st.store.data.known, LIVE.known))}`);
  }
  if (st.refusal) throw new Error(st.refusal);
  return LIVE;
}

/** 现场（CSV/JSON）直读的 QC 词表。**legacy 路径的唯一实现**：
 *  没有正本的项目走的还是这一段，与 2026-09 之前逐字相同。 */
export async function liveLexicon(P) {
  const { buildLexicon } = await import(`${distOf(P.引擎目录)}/src/core/lexicon.js`);
  const plainWordlistTexts = [join(LTR, 'assets/wordlists/curriculum_2022_level3_1600.txt'), join(LTR, 'assets/wordlists/curriculum_2022_amendment.txt')]
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
    properNouns: readProperLive(P.专名表路径),
  });
}

/** 引擎口径的"已知"判定（与 QC 完全同一套：不规则形 + 后缀还原）。
 *  2026-09-10 修复：修复脚本原先用 loadKnownForms 的规则展开（给每个词加 ly/s/ed…），
 *  比引擎宽 —— 于是它删掉了引擎仍判为 OOV 的词的注释（如 curiously / nightly），
 *  覆盖率随之下跌，两边规则互相打架。现在两边共用同一个判定。 */
export async function makeKnownChecker(P) {
  const { hit } = await import(`${distOf(P.引擎目录)}/src/core/textpipe.js`);
  const LEX = await loadLexicon(P);
  return (w) => hit(String(w).toLowerCase(), LEX.known);
}

/** 教师知识库加注词 → 释义（值含"复现/复数/比较级"者为流程标记，不是释义）。
 *  **直读文件**的那一份，供导入步骤用；对外请用 `loadKbGloss`（优先读正本）。 */
export function readKbGlossLive(path) {
  const m = new Map();
  if (!existsSync(path)) return m;
  for (const line of readFileSync(path, 'utf-8')
    .replace(/^\uFEFF/, '')
    .split('\n')
    .slice(1)) {
    const [type, word, val, n] = line.split(',');
    if (type !== '加注词' || !word || !val) continue;
    if (/复现|复数|比较级/.test(val)) continue;
    const w = word.toLowerCase();
    const prev = m.get(w);
    if (!prev || (Number(n) || 0) > prev.n) m.set(w, { zh: val, n: Number(n) || 0 });
  }
  return m;
}

/** 知识库加注词：有正本读正本；路径对不上（正本描述的是**它自己那份**知识库）才直读 */
export function loadKbGloss(path) {
  const st = usableState(_activeProject);
  if (st.mode === 'store') {
    const src = st.store.inputs.find((s) => s.name === '知识库');
    if (src && src.path === path) return new Map(st.store.data.kb);
  }
  return readKbGlossLive(path);
}

/** 统一注释词典（word → 中文释义）：**直读文件**的那一份。
 *  导入步骤与 `appendDict` 必须用它——它们要改的正是 CSV 本身，
 *  拿正本当基线就会把别人在这期间配的释义整份写回去（lost update）。 */
export function readDictLive(path) {
  const m = new Map();
  if (!existsSync(path)) return m;
  for (const line of readFileSync(path, 'utf-8')
    .replace(/^\uFEFF/, '')
    .split('\n')
    .slice(1)) {
    const [w, zh] = line.split(',');
    if (w && zh) m.set(w.trim().toLowerCase(), zh.trim());
  }
  return m;
}

/** 统一注释词典：有正本读正本。**词典是"同一个词在全书里只有一个意思"的正本**，
 *  它被中途改过而不出声，正是这次要防的事（旧写法下每个脚本各读一份 CSV，谁也不知道）。 */
export function loadDict(path) {
  const st = usableState(_activeProject);
  if (st.mode === 'store') {
    const src = st.store.inputs.find((s) => s.name === '词典');
    if (src && src.path === path) return new Map(st.store.data.dict);
  }
  return readDictLive(path);
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
export const REVIEW_PLACEHOLDER = (id, dir) => `[${id}] <!-- 本段未通过复检，未收录；原文与改写见 ${dir} -->`;

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

const dictMerge = async () => await import(`${distOf(LTR)}/src/core/dictmerge.js`);

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

const mkdirFor = (p) => {
  try {
    mkdirSync(dirname(p), { recursive: true });
  } catch {
    /* 已存在 */
  }
};

/** 在某份文件上做"独占"操作：锁文件 + 陈旧锁可夺（进程崩了不会把词典永久锁死）。
 *  纯逻辑（锁状态三态）在引擎 src/core/dictmerge.ts 里，可单测。 */
/**
 * @param {string} lockPath
 * @param {() => Promise<any>} fn 临界区
 * @param {{waitMs?: number, pollMs?: number}} [opts]
 *   `waitMs`：**等活锁最多等多久**。默认 60s——真实的词典合并要跑若干秒，
 *   原来"重试 3 次 × 300ms"（合计不到 1 秒）会让第二个进程在第一个还没跑完时就报错退出，
 *   于是"有锁"反而变成了"并发一跑就失败"。等待本身不是问题，**无限等待**才是问题，
 *   所以这里给的是明确的上限而不是一个次数。
 */
export async function withLock(lockPath, fn, opts = {}) {
  const { lockState } = await dictMerge();
  mkdirFor(lockPath);
  const isAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const readLock = () => {
    try {
      return JSON.parse(readFileSync(lockPath, 'utf-8'));
    } catch {
      return null;
    }
  };

  /* ★ 用 `O_EXCL` **原子地**占锁，而不是"先看再写"。
   *
   * 原来是 `lockState(readLock())` → 判断 free → `writeFileSync`。
   * 两个进程可以同时看到 free、同时写，于是**两个都以为自己拿到了锁**——
   * 锁形同虚设，而"防止词典被并发合并写坏"正是它存在的唯一理由。
   * `wx` 的语义是"不存在才创建、存在就 EEXIST"，由内核保证这一步是原子的。
   *
   * token 是为了**只释放自己的锁**：陈旧锁会被后来者夺走，
   * 若那时原持有者才慢吞吞地走到 finally，按路径删就会把**别人的**锁删掉——
   * 于是又回到了"两个进程都以为自己持锁"。 */
  const token = randomUUID();
  const mine = JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString(), token });
  const waitMs = opts.waitMs ?? 60_000;
  const pollMs = opts.pollMs ?? 200;
  const deadline = Date.now() + waitMs;
  let acquired = false;
  while (!acquired) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeSync(fd, mine);
      } finally {
        closeSync(fd);
      }
      acquired = true;
    } catch (e) {
      // 不是"已存在"就是真错误（没权限、路径是目录…）——带上原错误再抛，别把它吞掉
      if (e?.code !== 'EEXIST') throw new Error(`占锁失败（${lockPath}）：${e?.message ?? e}`, { cause: e });
      const st = lockState(readLock(), Date.now(), isAlive);
      if (st === 'held') {
        if (Date.now() >= deadline) {
          const who = readLock();
          throw new Error(
            `等锁超时（${Math.round(waitMs / 1000)}s）：${lockPath} 被 pid ${who?.pid ?? '?'}@${who?.host ?? '?'} 占着` + `（${who?.at ?? '时间未知'}）——等它跑完，或确认它已经死了再删掉锁文件`,
            { cause: e },
          );
        }
        await new Promise((r) => setTimeout(r, pollMs));
        continue;
      }
      // 陈旧锁：删掉再抢一轮。删也可能被别人抢先删掉，所以下一轮重新 openSync 而不是直接写。
      _rm(lockPath, { force: true });
    }
  }
  try {
    return await fn();
  } finally {
    // 只释放自己的锁（见上面的 token 说明）
    const cur = readLock();
    if (cur?.token === token) _rm(lockPath, { force: true });
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
      added: 0,
      unchanged: 0,
      conflicts: 0,
      interConflicts: 0,
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
    announceDictCsvChanged(dictPath);
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
  const m = readDictLive(path);
  let added = 0;
  for (const [w, zh] of entries) {
    const k = String(w).toLowerCase();
    if (!m.has(k) && zh) {
      m.set(k, zh);
      added++;
    }
  }
  if (added) {
    /* 注意：这里历史上就是**不带参数**调用的（`loadKbGloss()` ⇒ 空表 ⇒ 来源列恒为「归一（多数票）」，
     * 即便某个释义其实来自教师知识库）。本次改造**刻意保持原样**：改它会改掉已经写出的词典字节，
     * 那是另一件事，得单独决定并单独立测试。已记入交接说明，不在这里顺手"修好"。 */
    const kb = readKbGlossLive();
    const rows = ['词,释义,来源', ...[...m].sort((a, b) => a[0].localeCompare(b[0])).map(([w, zh]) => `${w},${zh},${kb.has(w) ? '教师知识库' : '归一（多数票）'}`)];
    writeFileSync(path, '\uFEFF' + rows.join('\n') + '\n', 'utf-8');
    announceDictCsvChanged(path);
  }
  return added;
}

/** 词典 CSV 被谁改过之后：**当场说出来**。
 *  有正本的项目下一趟会直接拒绝（因为正本记的哈希已经对不上），
 *  这句话就是那一刻之前唯一的提示——把它留到"下次跑脚本报错"才让人知道，太晚了。 */
function announceDictCsvChanged(path) {
  const st = lexiconStoreState(_activeProject);
  if (st.mode === 'store') {
    console.warn(`⚠ 词典 CSV 已改（${path}）——**词表正本已过期**：下一次读词表的脚本会拒绝开工。\n` + `  收尾：${'node tools/af_pipeline/LayerText_AF清单.mjs --reimport'}（重新导入后再接着跑）`);
  }
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
    if (bi < bIdx) {
      for (const c of Object.values(us)) (c.词 ?? []).forEach((w) => learned.add(w));
      continue;
    }
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

/* ────────────────────── 导入：把现场 CSV 变成词表正本（**只在这一处发生**） ────────────────────── */

/**
 * 快照口径的来源列表（词库/专名表/知识库/词典/情节底线/教材单元库）——
 * **只写一份**：`清单.mjs` 的 `buildSnapshot` 与这里的导入共用它。
 * 两处各写一份的后果很具体：两份的 `count` 只要差一行，算出来的快照版本就不同，
 * 于是每次 `--verify` 都报一次"词表已变"——**假警报**（教师看两条就会忽略整个队列）。
 */
export function projectSources(P) {
  const { mods, why } = engineModsFor(P, 'core');
  if (!mods) throw new Error(`清单的来源列表需要引擎侧的 manifest.js：${why}`);
  const files = [
    ['词库', P.词库],
    ['专名表', P.专名表路径],
    ['知识库', P.知识库路径],
    ['词典', P.词典路径],
    ['情节底线', P.工作区 ? join(P.工作区, P.情节底线 ?? '调适工作区/规则与底线/全书情节底线_v0.1.md') : null],
    ['教材单元库', P.教材单元库],
  ];
  const sources = [];
  const counts = { known: 0, pending: 0, proper: 0, dict: 0, kb: 0 };
  const knownAll = [];
  for (const [name, path] of files) {
    const text = path && existsSync(path) ? readFileSync(path, 'utf-8') : null;
    if (text === null) continue;
    const count = text.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).length;
    sources.push({ ...mods.manifest.refOf(name, path, text), count });
    if (name === '词库') {
      counts.known = count;
      for (const l of text.split('\n').slice(1)) {
        const w = l.split(',')[0]?.trim();
        if (w) knownAll.push(w);
      }
    }
    if (name === '专名表') counts.proper = count;
    if (name === '词典') counts.dict = count;
    if (name === '知识库') counts.kb = count;
  }
  return { sources, counts, knownAll };
}

/** 内置一行一词词表的读法。**逐字复刻 `loadKnownForms` 的历史口径**：按空白取第一段、
 *  不过滤 `#` 注释行（于是注释行会产出一个词 `"#"`）。
 *  这里"顺手修干净"= 改掉 loadKnownForms 的结果 = 换掉一批词的判定——不许顺手。 */
const readAssetWords = (text) =>
  String(text)
    .split('\n')
    .map((l) => l.trim().toLowerCase().split(/\s+/)[0])
    .filter(Boolean);

/**
 * **一次性导入**：读现场 CSV/JSON → 材料化成词表正本 → 原子写盘。
 *
 * `清单.mjs --new` 与 `清单.mjs --reimport` 共用这一份实现（不许各写一份：
 * 两份导入实现 = 两份"什么算已知"的答案）。
 *
 * 这里刻意**不**复用 `loadLexicon` 的合并逻辑去"另算一套导入口径"，而是调
 * `buildLexicon` 本身——与 `loadLexicon` 用**同一个函数、同一批输入**，
 * 这样"正本里的 known"和"legacy 路径算出来的 known"逐词相同：
 * 换句话说，导入**不改变任何判定**，它只是把判定结果冻起来。
 */
export async function importLexiconStore(P, opts = {}) {
  const { mods, why } = engineModsFor(P);
  if (!mods) throw new Error(`导入词表正本需要引擎侧的模块：${why}`);
  const { buildLexicon } = await import(`${distOf(P.引擎目录)}/src/core/lexicon.js`);

  const files = lexiconInputFiles(P);
  const textOf = new Map(files.map(([, path]) => [path, readFileSync(path, 'utf-8')]));
  const inputs = files.map(([name, path]) => mods.manifest.refOf(name, path, textOf.get(path)));

  const asset = (rel) => textOf.get(join(LTR, rel)) ?? '';
  const curriculum = readAssetWords(asset('assets/wordlists/curriculum_2022_level3_1600.txt'));
  const amendment = readAssetWords(asset('assets/wordlists/curriculum_2022_amendment.txt'));
  const textbook = [...(loadTextbookLearned(P) ?? [])];
  const proper = readProperLive(P.专名表路径);

  // 与 loadLexicon 完全同一套输入与合并函数（见上面注释）
  const lex = buildLexicon({
    plainWordlistTexts: [join(LTR, 'assets/wordlists/curriculum_2022_level3_1600.txt'), join(LTR, 'assets/wordlists/curriculum_2022_amendment.txt')]
      .filter((p) => existsSync(p))
      .map((p) => readFileSync(p, 'utf-8'))
      .concat(textbook.length ? [textbook.join('\n')] : []),
    vocabCsvTexts: [readFileSync(P.词库, 'utf-8')],
    properNouns: proper,
  });

  const data = {
    known: [...lex.known].sort(),
    pending: [...lex.pending].sort(),
    proper,
    wordlists: { curriculum, amendment, textbook, vocab: readCsvWords(P.词库), proper },
    dict: [...readDictLive(P.词典路径)],
    kb: [...readKbGlossLive(P.知识库路径)],
  };

  const ps = opts.snapshotSources ? { sources: opts.snapshotSources, counts: opts.snapshotCounts } : projectSources(P);
  const store = mods.store.buildLexiconStore({ data, inputs, snapshotSources: ps.sources, snapshotCounts: ps.counts });

  // 上一份正本（可能是坏的）：导出的报告要说清"这次换了什么"
  const previous = (() => {
    try {
      const parsed = mods.store.parseLexiconStore(readFileSync(storePathOf(P), 'utf-8'));
      return parsed.ok ? parsed.store : null;
    } catch {
      return null;
    }
  })();

  // 原子写：半份词表正本 = 下一趟直接读不出词表，正是本项目要消灭的那种损坏。
  // 先写版本归档，再写指针（指针后写：读的人要么看到旧的完好正本，要么看到新的完好正本）。
  const dir = storeDirOf(P);
  const text = mods.store.serializeLexiconStore(store);
  const versionPath = join(dir, mods.store.storeFileNameFor(store.version));
  mkdirSync(dir, { recursive: true });
  mods.files.atomicWriteFileSync(versionPath, text);
  mods.files.atomicWriteFileSync(join(dir, STORE_FILE), text);
  _storeCache = null; // 同一个进程里导入完接着读，必须读到新的

  /* 漂移记录到此作废：正本刚刚按现场重写，`LexiconDrift.json` 描述的那种"对不上"
   * 已经不存在了。留着一份旧的漂移报告，正是本项目点名要防的那类状态
   * （`清单.mjs` 头部那句"上一轮的完成标记还在，这一轮其实没跑完"）。
   * 漂移的**内容**不会丢：旧正本按版本归档在 `LexiconData_<旧版本>.json`，
   * 与新正本一比就是当时的逐词差异。 */
  const driftPath = join(dir, mods.store.LEXICON_DRIFT_FILE);
  const clearedDrift = existsSync(driftPath);
  if (clearedDrift) _rm(driftPath, { force: true });

  const diff = previous ? mods.store.diffWordSets(previous.data.known, store.data.known) : null;
  return {
    store,
    storePath: join(dir, STORE_FILE),
    versionPath,
    previous,
    clearedDrift,
    wordDiff: diff,
    /** 人读的一句话（唯一一份措辞，命令行与报告共用） */
    wordDiffText: diff ? mods.store.describeWordDiff(diff) : null,
  };
}

/**
 * 把漂移**记下来**。漂移的可见性不能只靠一行 stderr：
 * 报告、论文、三个月后的复盘都要能翻到"那一天词表和正本对不上，差的是这些词"。
 * 写进 `<产物目录>/_运行/LexiconDrift.json`（原子写，覆盖上一份——它描述的是**当下的**关系）。
 */
export async function recordLexiconDrift(P, { state, liveKnown } = {}) {
  const { mods } = engineModsFor(P);
  if (!mods) return null;
  const st = state ?? lexiconStoreState(P);
  const live = await liveLexicon(P).catch(() => null);
  const known = liveKnown ?? live?.known ?? null;
  const payload = {
    at: new Date().toISOString(),
    storePath: storePathOf(P),
    mode: st.mode,
    storeVersion: st.store?.version ?? null,
    snapshotVersion: st.store?.snapshotVersion ?? null,
    storeCreatedAt: st.store?.createdAt ?? null,
    drift: st.drift?.drift ?? [],
    changed: st.drift?.changed ?? [],
    removed: st.drift?.removed ?? [],
    added: st.drift?.added ?? [],
    wordDiff: st.store && known ? mods.store.diffWordSets(st.store.data.known, known) : null,
    wordDiffNote: st.store && known ? mods.store.describeWordDiff(mods.store.diffWordSets(st.store.data.known, known)) : null,
    refusal: st.refusal || null,
  };
  const path = join(storeDirOf(P), mods.store.LEXICON_DRIFT_FILE);
  mkdirSync(storeDirOf(P), { recursive: true });
  mods.files.atomicWriteFileSync(path, JSON.stringify(payload, null, 2) + '\n');
  return { path, payload };
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
  const M = await import(`${distOf(LTR)}/src/core/manifest.js`);
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
