#!/usr/bin/env node
/** AF 路径布局迁移 —— 让**已经在跑的书**也能搬进 run 布局
 *
 * 《LayerText 工程优化总计划》阶段 3 的验收标准是「两位教师同时对同一本书不同层级运行
 * 不会覆盖词典、日志或产物」。`run` 布局（产物收进 `<产物目录>/_运行/<runId>/`）已经能保证
 * 这一条，但**没人敢把默认布局翻过去**——那会静默改掉教师已有文件的位置，而"改动位置"这件事
 * 一旦静默，坏的是"教师在旧位置改的稿子从此没人读"。
 * 于是缺的从来不是开关，是**一次显式、可核对、可回滚的搬迁**：这就是本脚本。
 *
 * ── 它不是什么（先说清楚，免得被当成万能钥匙）──────────────────────────────
 *   · **不是默认行为**：不带 `--apply` 一律演练，一个字节都不写（教师的稿子只有一份）。
 *   · **默认不删**：`--move` 是另一个显式开关；不加它原件原地留着，迁移是**加法**。
 *   · **不搬 `_运行/` 下的账**：清单、指针、词表正本与快照**与布局无关**（见「布局无关」一节，
 *     它是从 `resolvePath` 与 `storeDirOf` 读出来的，不是猜的）。搬它们只会制造第二份事实源。
 *   · **不猜路径**：同一件产物在两种布局下的落点一律由 `resolvePath` 算——
 *     命名规则**一个字符都不在这里重写**（重写一份就是下一次漂移，见 manifest.ts 里
 *     `TIER_TAG` 那段"7 个脚本各抄一份"的教训）。
 *   · **不做反向迁移**：`--to legacy` 只报告"搬回去会落在哪"，不动手；理由见输出末尾。
 *     真要撤销，用 `--rollback`（它只回滚**本工具自己做过**的那次，依据是搬迁移日志）。
 *
 * ── 用法 ─────────────────────────────────────────────────────────────────
 *   node tools/af_pipeline/LayerText_AF迁移.mjs                      # 演练：打印会做什么（默认）
 *   node tools/af_pipeline/LayerText_AF迁移.mjs --apply              # 真做：复制到 run 布局（原件保留）
 *   node tools/af_pipeline/LayerText_AF迁移.mjs --apply --move       # 真做：搬过去并删原件
 *   node tools/af_pipeline/LayerText_AF迁移.mjs --to legacy          # 反向报告（只报告，不做）
 *   node tools/af_pipeline/LayerText_AF迁移.mjs --apply --rollback   # 回滚上一次迁移（默认演练）
 *
 * 退出码：0 = 正常/演练/已迁过；1 = 前置检查不过（拒绝，一个文件都没动）；2 = 用法错；3 = 搬到一半失败。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { hostname } from 'node:os';

/* ────────────────────── 命令行 ────────────────────── */

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const has = (n) => argv.includes(n);

const APPLY = has('--apply');
const MOVE = has('--move');
const ROLLBACK = has('--rollback');
const TARGET = arg('--to', 'run');
const ONLY_REGISTERED = has('--only-registered');
const ALLOW_MISSING = has('--allow-missing');
const WANT_RUN = arg('--run', undefined);
const WANT_TEACHER = arg('--teacher', process.env.LAYERTEXT_TEACHER ?? undefined);
const WANT_TIER = arg('--tier', undefined);

if (has('--help') || has('-h')) {
  console.log(
    [
      'AF 路径布局迁移 · 用法',
      '  （不加 --apply 一律演练：只打印会做什么，一个字节都不写）',
      '',
      '  --apply             真做。默认模式是**复制**：产物在 run 布局出现，legacy 原件原地保留',
      '  --move              搬完删原件（必须与 --apply 一起用；不加它迁移就是加法）',
      '  --to run|legacy     目标布局。run = 产物收进 _运行/<runId>/（默认）；',
      '                      legacy = 只报告"搬回去会落在哪"，**不动手**',
      '  --rollback          回滚本工具做过的那次迁移（依据 _运行/迁移_<runId>.json）',
      '  --run <runId>       点名迁哪一次运行（_运行/ 下有多份清单时必须给）',
      '  --teacher <名>      辅助定位分片指针（默认取清单里记的教师）',
      '  --tier <A|M|B或标签> 辅助定位分片指针',
      '  --only-registered   只搬清单里登记过的产物（不认领盘上未登记的文件）',
      '  --allow-missing     登记了但不在盘上的产物不拦路（保留登记、标 missing）',
      '  --project <路径>    指定项目配置（默认按 LAYERTEXT_PROJECT / 向上查找）',
    ].join('\n'),
  );
  process.exit(0);
}
if (!['run', 'legacy'].includes(TARGET)) {
  console.error(`✗ --to 只能是 run / legacy（给的是「${TARGET}」）`);
  process.exit(2);
}
if (MOVE && !APPLY) {
  console.log('提示：--move 只与 --apply 一起生效。这次仍是**演练**——不加 --apply，一个字节都不写。\n');
}

/* ────────────────────── 项目与引擎 ────────────────────── */

const SHARED = await import('./LayerText_AF词表与词典.mjs');
const P = SHARED.loadProject(arg('--project', undefined));
const REPO = P.引擎目录;
const OUT_BASE = P.产物目录;
const WORK = P.调适工作区;
const RUN_DIR = join(OUT_BASE, '_运行');
const ROOTS = { out: OUT_BASE, work: WORK };
/* 这里**刻意没有**「日期」「章号中文字」这类常量：产物名里的日期/后缀/章节全部从盘上真实的文件名
 * 解析出来（见下面的落点模板）。写死一个 `P.日期` 就会漏掉"上个月那批还没搬的产物"——
 * 漏掉一件的后果是：清单翻到 run 之后脚本去新落点找，那件从此没人看得见。 */

/* 引擎模块走 `distOf`（与清单脚本同一口径）：多人/多 agent 并行改仓库时，谁都不去写共享 dist/，
 * 也不必等它被重建——本脚本的验证就是这么编到自己的 outDir 里跑的。 */
const M = await import(`${SHARED.distOf(REPO)}/src/core/manifest.js`);
const { resolvePath, detectCollision, contentHash, privateDirOf, TIER_TAG } = M;
const { atomicWriteFileSync } = await import(`${SHARED.distOf(REPO)}/src/core/files.js`);

const readIf = (p) => (p && existsSync(p) ? readFileSync(p, 'utf-8') : null);
const exists = (p) => existsSync(p);
const isAlivePid = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const rel = (abs) => abs.replace(`${OUT_BASE}/`, '');

/**
 * `_运行/` 根下**与布局无关**的那批文件：清单、指针、词表正本/快照/漂移、锁，以及本工具的迁移日志。
 *
 * 为什么它们一个都不搬：`resolvePath` 对 `清单` 这种类型**两种布局给的是同一个路径**
 * （`<产物目录>/_运行/清单_<runId>.json`），指针与词表正本则由清单脚本直接写在 `_运行/` 根
 * （`storeDirOf(P) = join(P.产物目录, '_运行')`）。它们本来就是"运行自己的账"，
 * 搬到 `_运行/<runId>/` 里去只会得到**两份事实源**，而两份事实源的下场是
 * "读的人不知道哪份算数"——那正是本轮要根治的东西。
 */
const RESERVED = [/^LexiconData(_[^/]*)?\.json$/, /^LexiconSnapshot(_[^/]*)?\.json$/, /^LexiconDrift\.json$/, /^清单_.*\.json$/, /^迁移_.*\.json$/, /\.lock$/];
const isReservedRunFile = (abs) => dirname(abs) === RUN_DIR && RESERVED.some((re) => re.test(basename(abs)));

/* ────────────────────── 落点模板：从 resolvePath 反推"一件产物在两种布局下各在哪" ────────────────────── */

/**
 * 占位符。**为什么要这一层**：
 * 清单里只记了 `kind / 层级 / 章节`，**没记日期、后缀与产物名**——它们全在路径字符串里。
 * 而 run 布局里有四种产物的**文件名本身就变了**（`A层85.完成.json` → `完成.json`、
 * `风险队列_A层85.json` → `风险队列.json`……见 `resolvePath` 的 run 分支）。
 * 于是"文件名照抄、只换目录"这条路是错的：它会算出 `_运行/<runId>/A层85.完成.json`，
 * 而脚本去找的是 `_运行/<runId>/完成.json`——**产物明明搬过去了，下游却一件都找不到**。
 *
 * 正确的做法是让解析器自己算：先用占位符问一次"这类产物长什么样"，
 * 拿它去对号入座地**解析出**日期/后缀/产物名，再把解析出来的字段喂回 `resolvePath` 换布局重算。
 * 命名规则于是始终只有一份（在 `resolvePath` 里），本脚本一个字符都没有重写。
 */
const SENT = { date: '\u0001D\u0001', suffix: '\u0002S\u0002', name: '\u0003N\u0003', segId: '\u0004G\u0004', chapter: '\u0005C\u0005' };
const SENT_KEY = new Map(Object.entries(SENT).map(([k, v]) => [v, k]));
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SENT_RE = new RegExp(`(${Object.values(SENT).map(escRe).join('|')})`, 'g');

/** 渲染一次"带占位符的落点"。`tier` 不占位——层级是字面量，也正是本脚本判"归属"的依据。 */
const templateOf = (layout, kind, { tier, chapter } = {}) =>
  resolvePath(layout, ROOTS, runId, {
    kind,
    tier,
    chapter,
    date: SENT.date,
    suffix: SENT.suffix,
    name: SENT.name,
    segId: SENT.segId,
  });

/** 模板 → 正则。占位符一律贪婪：`x<name>_<date>.md` 对 `台账总览_2026-09-10.md` 会切出
 *  `name=台账总览, date=2026-09-10`（尾部的字面量 `.md` 锚住了它）。切得准不准其实不影响结果——
 *  两种布局里这几段是**按同样顺序**拼的，"日期错当成后缀"算出来的路径仍然一模一样。 */
function compileTemplate(tpl) {
  const parts = tpl.split(SENT_RE);
  let src = '';
  const keys = [];
  for (const p of parts) {
    const k = SENT_KEY.get(p);
    if (k) {
      src += '([\\s\\S]*)';
      keys.push(k);
    } else src += escRe(p);
  }
  return { re: new RegExp(`^${src}$`), keys };
}

const fieldsOf = (cand, abs) => {
  const m = cand.re.exec(abs);
  if (!m) return null;
  const f = {};
  cand.keys.forEach((k, i) => (f[k] = m[i + 1]));
  return f;
};

/** 把解析出来的字段喂回解析器，换一种布局重算落点（**本脚本唯一产出路径的地方**）。 */
const pathWith = (layout, cand, f) =>
  resolvePath(layout, ROOTS, runId, {
    kind: cand.kind,
    tier: cand.tier,
    chapter: f.chapter ?? cand.chapter,
    date: f.date,
    suffix: f.suffix,
    name: f.name,
    segId: f.segId,
  });

/** 层级标签（`A` → `A层85`）。清单里登记的 `tier` 是**层键**，解析器要的是**标签**。 */
const tagOf = (t) => (t ? (TIER_TAG[t] ?? t) : t);

function buildCandidates(layout, tiers) {
  const out = [];
  const push = (kind, extra) => {
    const tpl = templateOf(layout, kind, extra);
    const { re, keys } = compileTemplate(tpl);
    out.push({ kind, tier: extra?.tier, chapter: extra?.chapter, tpl, re, keys });
  };
  /* 顺序即优先级：登记项靠"哪个模板对得上"认领，**带层级的类型必须排在前面**——
   * 否则 `_运行/A层85.完成.json` 会被"运行中间产物"（产物名不限）抢先认领，
   * 于是它被搬成 `_运行/<runId>/A层85.完成.json`，而脚本找的是 `完成.json`。 */
  for (const tier of tiers) {
    push('正文', { tier, chapter: SENT.chapter });
    push('待复核', { tier, chapter: SENT.chapter });
    for (const kind of ['台账', '复核报告', '风险队列', '完成标记', '失败清单', '词典增量']) push(kind, { tier });
  }
  push('汇总报告');
  push('运行中间产物');
  return out;
}

/* ────────────────────── 清单定位 ────────────────────── */

/** `_运行/` 下既是指针又是清单——**按内容分**：清单有 schemaVersion 与 artifacts，指针没有。
 *  按文件名分是分不开的（指针叫 `清单_<教师>_<层>.json`，清单叫 `清单_<runId>.json`）。 */
function readManifests() {
  if (!exists(RUN_DIR)) return [];
  const out = [];
  for (const f of readdirSync(RUN_DIR)) {
    if (!/^清单_.*\.json$/.test(f)) continue;
    const text = readIf(join(RUN_DIR, f));
    if (!text) continue;
    try {
      const j = JSON.parse(text);
      if (j?.schemaVersion && Array.isArray(j.artifacts) && j.runId) out.push({ file: join(RUN_DIR, f), manifest: j });
    } catch {
      /* 坏清单跳过——它不该让迁移整个跑不起来 */
    }
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : 1));
}

const MANIFESTS = readManifests();
const failures = [];
const notes = [];
let picked = null;

if (WANT_RUN) {
  picked = MANIFESTS.find((x) => x.manifest.runId === WANT_RUN) ?? null;
  if (!picked) failures.push(`--run 指定的运行（${WANT_RUN}）在这里找不到清单。现有：${MANIFESTS.map((x) => x.manifest.runId).join('、') || '（一份都没有）'}`);
} else if (MANIFESTS.length === 1) {
  picked = MANIFESTS[0];
} else if (MANIFESTS.length > 1) {
  /* 多份清单 = 多位教师/多次运行共用一个产物目录，**正是 run 布局要服务的那个场景**。
   * 这里绝不"挑一份最近的"：挑错就是把 B 的产物登记搬进 A 的运行目录，而两边都会照常成功。
   * 所以**连 readRunIdentity 都要人先开了口才去问**——不点名就退到"最近一次"的那份，
   * 而"最近一次"是给人看的索引，不是"这次该迁谁"的答案。 */
  const hint =
    `产物目录里有 ${MANIFESTS.length} 份运行清单，不确定该迁哪一份：\n` +
    MANIFESTS.map((x) => `    · ${x.manifest.runId}（教师 ${x.manifest.teacher}｜层 ${(x.manifest.tiers ?? []).join('/')}）`).join('\n') +
    `\n  猜错就会把 A 的产物搬进 B 的运行目录（而且两边都报告成功）——用 --run <runId> 点名，或加 --teacher / --tier 让它按分片指针定位`;
  if (!WANT_TEACHER && !WANT_TIER) {
    failures.push(hint);
  } else {
    const RUN = await SHARED.readRunIdentity(ROOTS, { teacher: WANT_TEACHER, tier: WANT_TIER }, {});
    picked = MANIFESTS.find((x) => x.manifest.runId === RUN.runId) ?? null;
    if (picked) notes.push(`按共享入口 readRunIdentity 定位到运行（来源：${RUN.source}）`);
    else failures.push(hint);
  }
} else {
  failures.push(
    '还没有运行清单。迁移的意义是"让产物跟着清单走"，没有清单就没有 runId（不知道该建到哪个私有目录）：' + '先跑 node tools/af_pipeline/LayerText_AF清单.mjs --new --tier A --teacher <你>，再回来迁移',
  );
}

/* 回滚**不依赖清单**：它要的东西全在迁移日志里（逐件的 from/to）。清单被删了也得能回滚——
 * 那正是最需要回滚的时候（"--move 删了原件、清单又没了"）。所以这里放行，只在下面提示一句。 */
if (!picked && !ROLLBACK) {
  console.error('════ AF 布局迁移 · 前置检查未通过 ════');
  for (const f of failures) console.error(` ✗ ${f}`);
  console.error('\n一个文件都没有动。');
  process.exit(1);
}

const m = picked ? picked.manifest : null;
const MANIFEST_PATH = picked ? picked.file : null;
const runId = m ? m.runId : '';
const SOURCE_LAYOUT = m ? (m.layout === 'run' ? 'run' : 'legacy') : null;
const PRIVATE_DIR = m ? privateDirOf(OUT_BASE, runId) : null;

/* ────────────────────── 回滚：只回滚本工具做过的那次 ────────────────────── */

const journalPathOf = (id) => join(RUN_DIR, `迁移_${id}.json`);
const readJournals = () =>
  exists(RUN_DIR)
    ? readdirSync(RUN_DIR)
        .filter((f) => /^迁移_.*\.json$/.test(f))
        .map((f) => {
          try {
            return { file: join(RUN_DIR, f), j: JSON.parse(readFileSync(join(RUN_DIR, f), 'utf-8')) };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => (a.file < b.file ? -1 : 1))
    : [];

if (ROLLBACK) {
  /* 点名就按点名找；没点名就取**最后一份**日志——但要连"已经回滚过"的也一起看，
   * 否则第二次回滚会得到一句"找不到日志"，而那句话是错的（日志明明在，只是回滚过了）。 */
  const all = readJournals();
  const j = (WANT_RUN ? all.find((x) => x.j.runId === WANT_RUN) : all[all.length - 1]) ?? null;
  const lines = [];
  if (!j) {
    console.error('════ AF 布局迁移 · 回滚 ════');
    console.error(' ✗ 找不到迁移日志（_运行/迁移_<runId>.json）——本工具只回滚自己做过的那次，');
    console.error('   别人的迁移、手工搬过的文件都不在它的账上。多份日志时请 --run <runId> 点名。');
    process.exit(1);
  }
  const rec = j.j;
  /* 清单档案按**日志里记的 runId** 找，不按"这次命令行定位到的那份"找：
   * `--rollback --run X` 要回滚的就是 X，跟这次恰巧被选中的是哪份清单无关。 */
  const recManifest = join(RUN_DIR, `清单_${rec.runId}.json`);
  const recPriv = privateDirOf(OUT_BASE, rec.runId);
  if (rec.rolledBack) {
    console.error(` ✗ 这次迁移（${rec.runId}）已经回滚过（${rec.rolledBackAt}），不重复回滚。`);
    process.exit(1);
  }
  /* 回滚与前滚同一套规矩：先看能不能全做完，再动手。**半程回滚比不回滚更难收拾**。 */
  const conflicts = [];
  const back = [];
  for (const mv of rec.moves) {
    const from = join(OUT_BASE, mv.to);
    const to = join(OUT_BASE, mv.from);
    const a = readIf(from);
    const b = readIf(to);
    if (a === null) {
      lines.push(` ？ 已经在原位（run 里那份不在）：${mv.from}`);
      continue;
    }
    if (b !== null && b !== a) {
      conflicts.push(`  ✗ 两边都有且内容不同：${mv.from} ↔ ${mv.to}——先手工定夺，本工具不替你选`);
      continue;
    }
    back.push({ from, to, same: b !== null });
  }
  lines.unshift(` 运行：${rec.runId}｜教师：${rec.teacher}｜模式：${rec.mode === 'move' ? '搬运（原件已删）' : '复制（原件都在）'}｜日志：${rel(j.file)}`);
  if (!picked) for (const f of failures) lines.push(` ⚠ 这次没能定位到清单（回滚不依赖它）：${f.split('\n')[0]}`);
  if (rec.mode !== 'move') {
    lines.push(' · 这次迁移是**复制**模式：原件一直都在原位，所以没有文件要搬回去；');
    lines.push(`   run 布局下的那份副本留在 ${rel(recPriv)}/ 里（本工具**不删任何产物**，要清理请自己来）。`);
  }
  lines.push(` 清单 layout：${rec.layoutAfter} → ${rec.layoutBefore}；登记的落点同步改回去`);
  if (!exists(recManifest)) lines.push(` ⚠ 清单档案不在（${rel(recManifest)}）——本次只搬文件、不改档案；产物回位后请跑 清单.mjs --new 重建。`);
  console.log('════ AF 布局迁移 · 回滚 ════');
  if (!APPLY) console.log('【演练】以下是要做的事（加 --apply 才真做；一个字节都没写）\n');
  for (const l of lines) console.log(l);
  for (const c of conflicts) console.error(c);
  if (conflicts.length) {
    console.error('\n✗ 有冲突，拒绝动手（半程回滚比不回滚更难收拾）。');
    process.exit(1);
  }
  for (const b of back) {
    if (!APPLY) console.log(` ← ${rel(b.from)}\n → ${rel(b.to)}`);
  }
  if (APPLY) {
    await SHARED.withLock(join(RUN_DIR, '迁移.lock'), async () => {
      for (const b of back) {
        mkdirSync(dirname(b.to), { recursive: true });
        if (!b.same) {
          renameSync(b.from, b.to);
        } else {
          unlinkSync(b.from); // 两边同内容：删副本不丢任何东西
        }
      }
      if (exists(recManifest)) {
        const mm = JSON.parse(readFileSync(recManifest, 'utf-8'));
        mm.layout = rec.layoutBefore;
        const back2 = new Map(rec.moves.map((x) => [x.to, x.from]));
        for (const a of mm.artifacts ?? []) if (back2.has(a.path)) a.path = back2.get(a.path);
        mm.updatedAt = new Date().toISOString();
        atomicWriteFileSync(recManifest, JSON.stringify(mm, null, 2));
      }
      rec.rolledBack = true;
      rec.rolledBackAt = new Date().toISOString();
      atomicWriteFileSync(j.file, JSON.stringify(rec, null, 2));
    });
    console.log(`\n✓ 已回滚 ${back.length} 项${exists(recManifest) ? `；清单 layout=${rec.layoutBefore}` : '（清单档案不在，没改档案）'}。`);
    console.log('  请自己确认：产物回到 legacy 落点后，跑一次 清单.mjs --verify 看登记与盘上是否对得上。');
  }
  process.exit(0);
}

/* ────────────────────── 目标方向与"已迁过" ────────────────────── */

const journalPath = journalPathOf(runId);
if (TARGET === SOURCE_LAYOUT) {
  console.log('════ AF 布局迁移 ════');
  console.log(TARGET === 'run' ? ` ✓ 已经迁移过了：清单 ${runId} 的 layout 就是 run（产物在 ${rel(PRIVATE_DIR)}/ 下）。` : ' · 清单 layout 已经是 legacy —— 本来就是目标布局，没有要迁的东西。');
  if (TARGET === 'run') {
    const missingNow = (m.artifacts ?? []).filter((a) => !isReservedRunFile(join(OUT_BASE, a.path)) && !exists(join(OUT_BASE, a.path)));
    console.log(`   登记 ${(m.artifacts ?? []).length} 件，其中 ${missingNow.length} 件不在盘上${missingNow.length ? '：' : '。'}`);
    for (const a of missingNow.slice(0, 10)) console.log(`   ✗ ${a.path}`);
    if (exists(journalPath)) console.log(`   迁移日志：${rel(journalPath)}（回滚依据）`);
  }
  console.log('   重复跑不会重复搬、也不会改写清单——本工具在这条路径上一个字节都不写。');
  process.exit(0);
}

/* ────────────────────── 计划：既有产物在两种布局下的落点 ────────────────────── */

const tierList = [...new Set([...(m.tiers ?? []).map(tagOf), ...(m.artifacts ?? []).map((a) => tagOf(a.tier)).filter(Boolean)])];
const CANDIDATES = buildCandidates(SOURCE_LAYOUT, tierList);
/** 扫描只认**文件名里带层级**的类型：`汇总报告` / `运行中间产物` 的名字是不受限的，
 *  靠名字扫会把别人的东西也扫进来（"宁可少报，不可误报"——一条假认领就是一次真搬错）。 */
const SCANNABLE = new Set(['正文', '待复核', '台账', '复核报告', '风险队列', '完成标记', '失败清单', '词典增量']);
const SCAN_CANDIDATES = CANDIDATES.filter((c) => SCANNABLE.has(c.kind));

function collectFiles(root, descend, depth = 0, out = []) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = join(root, e.name);
    if (e.isDirectory()) {
      if (depth < 4 && descend(p, depth)) collectFiles(p, descend, depth + 1, out);
    } else if (e.isFile()) out.push(p);
  }
  return out;
}

/** 本次要扫的盘面。**legacy 下不进 `_运行/` 的子目录**：那里的子目录属于某次 run 布局的运行，
 *  不是本次的账；进错门就会把别人的产物登记成自己的。
 *  但 `_运行/` **自己的文件**必须扫到——legacy 布局里"完成标记/机器风险队列/词典增量"就平铺在那里，
 *  漏掉它们的后果是：清单翻到 run 之后，脚本去 `_运行/<runId>/完成.json` 找，一件都找不到，
 *  于是这次运行被判成 stale（不报错，结果错）。 */
const walkSourceFiles = () => (SOURCE_LAYOUT === 'run' ? collectFiles(PRIVATE_DIR, () => true) : collectFiles(OUT_BASE, (dir) => dirname(dir) !== RUN_DIR));

const items = [];
const byPath = new Map();
const notMoved = [];
const unrouted = [];
const missing = [];
const mismatched = [];
const stray = [];

const addItem = (src, cand, f, registered) => {
  const hit = byPath.get(src);
  if (hit) {
    if (registered) hit.registered = true;
    return;
  }
  const dest = pathWith(TARGET, cand, f);
  const it = { src, dest, kind: cand.kind, tier: cand.tier, chapter: f.chapter ?? cand.chapter, registered, fields: f };
  byPath.set(src, it);
  items.push(it);
};

/* ① 盘上扫出来的（含清单没登记的——教师生成完可能没刷状态）。 */
for (const abs of walkSourceFiles()) {
  if (isReservedRunFile(abs)) continue;
  const cand = SCAN_CANDIDATES.find((c) => c.re.test(abs));
  if (!cand) {
    stray.push(abs);
    continue;
  }
  addItem(abs, cand, fieldsOf(cand, abs), false);
}

/* ② 清单登记过的：保证一件不漏（`汇总报告` 这类扫不出来的就靠这里认领）。 */
for (const a of m.artifacts ?? []) {
  const abs = join(OUT_BASE, a.path);
  if (isReservedRunFile(abs)) {
    notMoved.push({ path: a.path, why: '布局无关（清单/指针/词表正本一类的"账"）' });
    continue;
  }
  const cand = CANDIDATES.find((c) => c.re.test(abs));
  if (!cand) {
    unrouted.push(a.path);
    continue;
  }
  const f = fieldsOf(cand, abs);
  /* 自检：登记项说的落点，与解析器算出来的落点必须一致。
   * 不一致 = 盘上那件东西**不是解析器会去找的那件**（正是"静默错位"的样子）；
   * 不拦路（它确实在那儿），但一定要说出来——搬完之后下游会不会找到它，取决于这一点。 */
  const expect = pathWith(SOURCE_LAYOUT, cand, f);
  if (expect !== abs) mismatched.push(`${a.path}（解析器按 ${SOURCE_LAYOUT} 算出来是 ${rel(expect)}）`);
  if (!exists(abs)) {
    missing.push({ path: a.path, kind: a.kind, status: a.status });
    continue;
  }
  addItem(abs, cand, f, true);
}

/* ③ `--only-registered`：没登记的**不认领**（同层还有另一位教师在跑时用得上——
 * 盘上那些未登记的文件，归属只能按"层级"推断，推断不出"教师"）。 */
if (ONLY_REGISTERED) {
  for (let i = items.length - 1; i >= 0; i--) {
    if (!items[i].registered) {
      byPath.delete(items[i].src);
      stray.push(items[i].src);
      items.splice(i, 1);
    }
  }
}

/* ────────────────────── 前置检查 ────────────────────── */

const destOf = new Map();
const collisions = [];
const already = [];
for (const it of items) {
  const seen = destOf.get(it.dest);
  if (seen) collisions.push(`两件产物会落到同一个地方：${rel(seen.src)} 与 ${rel(it.src)} → ${rel(it.dest)}`);
  else destOf.set(it.dest, it);
  const dstText = readIf(it.dest);
  it.destState = 'new';
  if (dstText !== null) {
    if (dstText === readIf(it.src)) {
      it.destState = 'same';
      already.push(it);
    } else {
      it.destState = 'diff';
      collisions.push(`目标已存在且内容不同（搬过去就是覆盖）：${rel(it.dest)}（源 ${rel(it.src)}）`);
    }
  }
  /* 目标必须在本次运行自己的私有目录里。解析器将来若把某类产物挪出 `_运行/<runId>/`，
   * 这条会先炸——比"迁移成功、下游找不到"好得多。 */
  const inside = it.dest.startsWith(`${PRIVATE_DIR}/`);
  if (TARGET === 'run' ? !inside : inside && it.dest !== it.src) {
    collisions.push(`落点不在 ${TARGET === 'run' ? `运行私有目录（${rel(PRIVATE_DIR)}）` : '共享落点'} 里，拒绝猜：${rel(it.src)} → ${rel(it.dest)}`);
  }
}

/* 并发生成检查。两个来源，两条不同的话：
 *   · 同一 runId 还有进程在跑 → 它正往这批路径上写，复制的可能是半份（用仓库里那个 `detectCollision`）；
 *   · 另一位教师、另一个 runId，但**层级与我们重叠** → 在 legacy 布局下我们两家的产物就是同一批文件名，
 *     她写我们搬，谁都想不到。这正是阶段 3 验收要拦的那一幕。 */
const aliveProblems = [];
for (const other of MANIFESTS) {
  if (other.manifest.runId === runId) {
    const warn = detectCollision(other.manifest, m, isAlivePid);
    if (warn) aliveProblems.push(warn);
    continue;
  }
  const owner = other.manifest.owner ?? {};
  if (!owner.pid || !isAlivePid(owner.pid)) continue;
  const share = (other.manifest.tiers ?? []).filter((t) => (m.tiers ?? []).includes(t));
  if (share.length)
    aliveProblems.push(
      `另一位教师（${other.manifest.teacher}）的运行 ${other.manifest.runId} 还在跑（pid ${owner.pid}@${owner.host || '?'}），` +
        `而且层级重叠（${share.join('/')}）——legacy 布局下两家的产物就是**同一批文件名**，现在搬会把对方正在写的算成我们的`,
    );
}
if (exists(join(RUN_DIR, '迁移.lock'))) aliveProblems.push(`有另一场迁移正在进行（${rel(join(RUN_DIR, '迁移.lock'))}）——等它跑完，或确认它已经死了再删锁文件`);

failures.push(...collisions);
failures.push(...aliveProblems);
if (missing.length && !ALLOW_MISSING)
  failures.push(
    `清单登记了但盘上不在的产物 ${missing.length} 件（先跑 node tools/af_pipeline/LayerText_AF清单.mjs --stamp 刷状态，或加 --allow-missing 承认它们缺失）：\n` +
      missing.map((x) => `    · ${x.path}（${x.kind}）`).join('\n'),
  );
if (unrouted.length)
  failures.push(
    `有 ${unrouted.length} 条登记项的落点本工具认不出来（不是已知的任何一类产物落点）。` +
      `为免"迁了一半"，先拒绝：\n` +
      unrouted.map((p) => `    · ${p}`).join('\n') +
      `\n  请把这几行报上来（大概率是新增了一种产物类型，迁移表还没跟上）`,
  );

/* ────────────────────── 输出：计划本身 ────────────────────── */

const mode = MOVE ? '**搬运**（搬完删原件；执行前会逐件校验目标）' : '**复制**（原件原地保留，迁移是加法）';
console.log('════ AF 布局迁移 ════');
console.log(` 项目：${P.书名 ?? '（未命名）'}｜产物目录：${OUT_BASE}`);
console.log(` 运行：${runId}｜教师：${m.teacher}｜层：${(m.tiers ?? []).map(tagOf).join('/')}｜章：${(m.chapters ?? []).join(',')}`);
console.log(` 清单：${rel(MANIFEST_PATH)}（登记 ${(m.artifacts ?? []).length} 件产物）`);
console.log(` 布局：${SOURCE_LAYOUT} → ${TARGET}`);
for (const n of notes) console.log(` · ${n}`);

/* 反向（run → legacy）模式下**这几条不拦路**：它们本来就是那份报告要说的事——
 * "搬回去会覆盖谁"正是 run 布局要根治的那个问题，把它藏起来反倒是骗人。
 * 前向（legacy → run）模式下它们是硬拦：一个都不能放过。 */
const blocking = TARGET === 'run';
if (failures.length && blocking) {
  console.log('\n【前置检查】');
  for (const f of failures) console.error(` ✗ ${f}`);
  console.error('\n✗ 拒绝迁移：**一个文件都没有动**（半程迁移比不迁移难收拾得多）。');
  process.exit(1);
}

console.log('\n【前置检查】');
console.log(` ✓ 清单在：${rel(MANIFEST_PATH)}`);
console.log(` ✓ 当前布局：${SOURCE_LAYOUT}（教师已有的文件就在它现在待的地方）`);
console.log(' ✓ 没有并发的运行在写同一批路径（同 runId 的进程都已退出，也没有同层级的另一位教师在跑）');
console.log(` ✓ 待搬 ${items.length} 件，逐一确认在盘上${missing.length ? `（另有 ${missing.length} 件已按 --allow-missing 承认缺失）` : ''}`);
if (failures.length) {
  console.log(' ⚠ 反向报告模式下，下面这些**只列出、不拦路**（它们正是这份报告要说的事）：');
  for (const f of failures) console.log(`   ⚠ ${f}`);
}

if (TARGET === 'legacy') {
  console.log('\n【反向报告】只报告，**不动手**');
  console.log(' 理由：legacy 是**共享命名**。搬回去时"两件产物落到同一个文件名"不是假设而是常态');
  console.log(' （这恰恰是 run 布局要根治的那件事），而本工具无从判断该让谁赢。');
  console.log(' 要回 legacy，请用 --rollback 撤销本工具做过的那次迁移（它的落点是逐件记账的）；');
  console.log(' 或者人工挑一件先改名再搬。');
}
if (TARGET === 'run' && !APPLY) console.log('\n【演练】以上为前置检查结果。下面是要做的事；加 --apply 才真做，**一个字节都没写**。');
if (TARGET === 'run' && APPLY) console.log(`\n【执行】模式：${mode}`);

console.log('\n【计划】');
console.log(` 模式：${mode}`);
for (const it of items.sort((a, b) => (a.src < b.src ? -1 : 1))) {
  const flags = [it.registered ? '已登记' : '未登记（按层级推断归属）'];
  if (it.destState === 'same') flags.push('目标已有同内容副本');
  if (it.destState === 'diff') flags.push('**目标已存在且内容不同：搬过去就是覆盖**');
  console.log(` ${rel(it.src)}\n   → ${rel(it.dest)}   [${it.kind}｜${it.tier ?? '—'}｜${it.chapter ?? '—'}｜${flags.join('／')}]`);
}
if (!items.length) console.log(' （没有要搬的产物）');

console.log('\n【不搬】');
console.log(' 这些是**运行自己的账**，搬它们只会得到第二份事实源（都在 `_运行/` 根下）：');
const keptInRunDir = exists(RUN_DIR)
  ? readdirSync(RUN_DIR)
      .map((f) => join(RUN_DIR, f))
      .filter(isReservedRunFile)
      .sort()
  : [];
for (const p of keptInRunDir.slice(0, 10)) console.log(`   · ${rel(p)}`);
if (keptInRunDir.length > 10) console.log(`   · ……另有 ${keptInRunDir.length - 10} 个`);
console.log('   理由：清单/指针/词表正本的落点本来就**与布局无关**（清单类两种布局给的是同一个路径，');
console.log('   词表正本由清单脚本直接写 _运行/ 根）——搬进去就是第二份事实源。');
for (const n of notMoved) console.log(`   · ${n.path} —— ${n.why}`);
if (stray.length) {
  console.log('\n【不认领】');
  console.log(' 盘上还有这些文件，但本工具认不出它们属于哪一类产物（也就不知道它们该去哪儿）——');
  console.log(' **留在原处**，一个都不动：');
  for (const s of stray.slice(0, 15)) console.log(`   · ${rel(s)}`);
  if (stray.length > 15) console.log(`   · ……另有 ${stray.length - 15} 个`);
}
if (mismatched.length) {
  console.log('\n【对不上】（不拦路，但请你看一眼）');
  console.log(' 清单登记的落点，与解析器算出来的落点不一致——这正是"静默错位"的样子：');
  for (const x of mismatched) console.log(`   ⚠ ${x}`);
}
if (already.length) console.log(`\n【已就位】${already.length} 件在目标已经有一份**内容相同**的副本（跳过拷贝，不重复写）`);

/* 会话/决定/版本日志在**调适工作区**（`<调适工作区>/_会话` 等），不在产物目录里——本工具**不搬它们**，
 * 而且这件事必须说出来，不然"迁移完成"会让人以为旧日志也跟着走了。
 * 不搬的理由是**归属**：这些文件名里只有层级、没有教师（见 `logTail`），同层两位教师写的是同一批
 * 文件名；把整批扫进自己的运行目录，等于把对方的日志算成自己的。新布局下脚本会把新日志写进
 * `_运行/<runId>/{会话,决定,版本}`，旧日志留在原处（要归档请手工搬，本工具不替你认领）。 */
const legacyLogDirs = ['_会话', '_决定', '_版本'].map((d) => join(WORK, d)).filter(exists);
if (legacyLogDirs.length) {
  console.log('\n【不搬·旧日志】');
  console.log(' 会话/决定/版本日志在调适工作区（不在产物目录里），文件名里只有层级、没有教师，');
  console.log(' 同层两位教师写的就是同一批文件名——本工具**不认领**它们（认领就是替别人做主）：');
  for (const d of legacyLogDirs) console.log(`   · ${d}（${(readdirSync(d) ?? []).length} 个文件，留在原处）`);
  console.log(`   新布局下新日志会写进 ${rel(PRIVATE_DIR)}/{会话,决定,版本}/；旧日志要一起搬请手工来。`);
}

/* ────────────────────── 执行 ────────────────────── */

/* 反向（run → legacy）**一律不做**，连 `--apply` 也不做。理由见上面「反向报告」那段：
 * 目标布局那一侧是共享命名，两件产物撞同一个文件名不是假设而是常态，
 * 本工具无从判断该让谁赢——而"猜一个赢家"正是这份工程一路在删的东西。
 * 真要退回 legacy：用 --rollback（它按逐件记账搬回本工具自己搬过的那批）。 */
if (TARGET === 'legacy') {
  console.log(`\n${APPLY ? '✗' : '·'} 反向迁移本工具不做（${APPLY ? '--apply 在这里不生效，退出码 2' : '本次是报告'}）。`);
  console.log(' 要退回 legacy：node tools/af_pipeline/LayerText_AF迁移.mjs --apply --rollback');
  process.exit(APPLY ? 2 : 0);
}

if (!APPLY) {
  console.log('\n【迁移后你要自己确认】');
  console.log(' 1) 跑一次上游脚本（如 LayerText_AF对照台账.mjs --tier A --chapters 1）——它现在应当去');
  console.log(`    ${rel(PRIVATE_DIR)}/ 里找产物；这一条过不了，就别继续往下跑。`);
  console.log(' 2) node tools/af_pipeline/LayerText_AF清单.mjs --verify —— 登记与盘上应当对得上。');
  if (!MOVE) console.log(' 3) 原件仍在原位（复制模式）：确认新落点没问题之后，再决定要不要清理旧的那份。');
  console.log('\n 演练结束，**一个字节都没写**。加 --apply 才真做。');
  process.exit(0);
}

const moved = [];
const failed = [];
const now = new Date().toISOString();

await SHARED.withLock(join(RUN_DIR, '迁移.lock'), async () => {
  for (const it of items.sort((a, b) => (a.src < b.src ? -1 : 1))) {
    try {
      const srcText = readFileSync(it.src, 'utf-8');
      if (readIf(it.dest) !== srcText) {
        mkdirSync(dirname(it.dest), { recursive: true });
        /* 先写同目录的临时文件再 rename（`atomicWriteFileSync` 的同一套道理）：
         * 中途失败留下的必须是"没有目标文件"，而不是"半份正文"。 */
        const tmp = join(dirname(it.dest), `.${basename(it.dest)}.mig-${process.pid}`);
        copyFileSync(it.src, tmp);
        renameSync(tmp, it.dest);
      }
      /* 删原件之前**逐件验**：目标读回来的内容必须与源一致。不验就删，
       * 一次磁盘满/一次读错就会把教师唯一的一份稿删掉。 */
      if (MOVE) {
        if (readFileSync(it.dest, 'utf-8') !== srcText) throw new Error('目标内容与源不一致，未删原件');
        unlinkSync(it.src);
      }
      moved.push({ from: rel(it.src), to: rel(it.dest), kind: it.kind, registered: it.registered, bytes: srcText.length, hash: contentHash(srcText) });
    } catch (e) {
      failed.push(`${it.src} → ${it.dest}：${e?.message ?? e}`);
    }
  }

  if (failed.length) return; // 搬到一半就失败：**清单一个字都不改**（改了才会真的半程）

  /* 清单是**改写**，不是重建（阶段 3：「文件产物存对象目录，SQLite 存索引和事件；导入导出通过 manifest」）。
   * 只动两处：`layout` 换向，以及登记项的 `path` 指向新落点。
   * · `id` 一个字不动：产物身份是"种类+层级+章节"，**与位置无关**（manifest.ts 里 `artifactIdOf`
   *   那一大段就是在讲这件事）——搬一次家就换一次身份的话，决定日志与版本节点全会变成孤儿。
   * · `hash/bytes` 顺手按搬过去的实际内容刷新（它们是"盘上事实"，不是"上次的结论"）。
   * 这一段刻意**不用** `upsertArtifact`：它按 path 当主键，搬家会给同一件产物留下"新的一条 + 旧的
   * 一条"，而旧的那条从此对不上盘上任何文件、也没人会去删。manifest.ts 是别处的文件，
   * 不好为这一处加"改 path 的助手"，所以这里就地做 JSON 改写，并把理由写在这儿。 */
  const mm = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
  const map = new Map(moved.map((x) => [x.from, x]));
  const nowMissing = new Set(missing.map((x) => x.path));
  for (const a of mm.artifacts ?? []) {
    const mv = map.get(a.path);
    if (mv) {
      a.path = mv.to;
      a.hash = mv.hash;
      a.bytes = mv.bytes;
      a.updatedAt = now;
      continue;
    }
    if (nowMissing.has(a.path)) {
      /* --allow-missing：盘上根本没有这件产物。它的**落点仍然要跟着布局走**——
       * 留着 legacy 的路径，等于告诉下游"去老地方找"，而老地方在新布局里已经不作数了。 */
      const cand = CANDIDATES.find((c) => c.re.test(join(OUT_BASE, a.path)));
      if (cand) a.path = rel(pathWith(TARGET, cand, fieldsOf(cand, join(OUT_BASE, a.path))));
      a.status = 'missing';
      a.updatedAt = now;
    }
  }
  mm.layout = TARGET;
  mm.updatedAt = now;
  atomicWriteFileSync(MANIFEST_PATH, JSON.stringify(mm, null, 2));

  /* 迁移日志：**回滚的唯一依据**。它记的是"这一件从哪儿来到哪儿去"，
   * 而不是"现在的布局是什么"——布局反着改回去只是两行 JSON，产物搬回来才是真本事。 */
  atomicWriteFileSync(
    journalPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        tool: 'LayerText_AF迁移.mjs',
        at: now,
        host: hostname(),
        runId,
        book: m.book,
        teacher: m.teacher,
        layoutBefore: SOURCE_LAYOUT,
        layoutAfter: TARGET,
        mode: MOVE ? 'move' : 'copy',
        moves: moved,
        rolledBack: false,
      },
      null,
      2,
    ),
  );
});

if (failed.length) {
  console.error('\n✗ 搬到一半失败（清单**没有改动**，改动过的文件列在下面）：');
  for (const f of failed) console.error(`   ✗ ${f}`);
  console.error(' 已搬成功的件：');
  for (const x of moved) console.error(`   · ${x.from} → ${x.to}`);
  console.error(' 修好之后重跑同一条命令即可（已就位的那几件会被跳过，不会重复搬）。');
  process.exit(3);
}

console.log('\n【结果】');
for (const x of moved) console.log(` ✓ ${x.from} → ${x.to}`);
console.log(`\n✓ 已迁移 ${moved.length} 件｜模式：${MOVE ? '搬运（原件已删）' : '复制（原件全部保留）'}｜清单 layout → ${TARGET}`);
console.log(` 迁移日志：${rel(journalPath)}（逐件记着从哪儿来到哪儿去）`);

console.log('\n【迁移后你要自己确认】（本工具的结论不等于你的稿子没问题）');
console.log(' 1) 跑一次上游脚本（如 LayerText_AF对照台账.mjs --tier A --chapters 1）——它现在应当去');
console.log(`    ${rel(PRIVATE_DIR)}/ 里找产物；这一条过不了，就别继续往下跑。`);
console.log(' 2) node tools/af_pipeline/LayerText_AF清单.mjs --verify —— 登记与盘上应当对得上。');
if (!MOVE) console.log(` 3) 原件**仍在原位**（复制模式）。确认新落点没问题之后，再自己决定要不要清理旧的那份——本工具不删任何东西。`);
else console.log(' 3) 原件已删（--move）。空目录（如各章节目录、_待复核/<层>/）会留在原处，删不删随你。');

console.log('\n【回滚】');
console.log(` 回滚到迁移前：node tools/af_pipeline/LayerText_AF迁移.mjs --apply --rollback（依据 ${rel(journalPath)}；先不加 --apply 跑一次是演练）`);
console.log(` 它会把上面 ${moved.length} 件逐件搬回原位，并把清单 layout 改回 ${SOURCE_LAYOUT}、登记落点同步改回去。`);
if (MOVE) console.log(' 提醒：--move 模式删掉的原件**只能靠它搬回来**，所以那个日志别删。');
else console.log(' 提醒：复制模式下原件没动过，就算不用回滚，产物也还在 legacy 落点上。');
