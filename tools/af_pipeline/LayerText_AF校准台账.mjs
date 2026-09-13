#!/usr/bin/env node
/** AF 校准台账：把"人工校准"从**按文件名**的标记文件，搬进**按稳定身份**的不可变台账
 *
 * ## 为什么（2026-09-13 查出来的真事故）
 *
 * `_审校标记.json` 按文件名落盘，管线每重新生成一版产物就换文件名。教师看到的症状是
 * **"我点了确认，下次进来校准怎么没了"**。实测证据（Animal Farm 第一章）：
 *
 *   原文_A层85_2026-09-10_审校标记.json        1 条（pellets / 词汇简化，教师 09-10 点的）
 *   原文_A层85_2026-09-12_工序化_审校标记.json  0 条（教师后来打开的是这一版，读的是它自己那张空表）
 *
 * 校准没丢，它躺在旧文件名名下。全书十章里只有第一章留下过标记文件——同一个根因的另一面。
 *
 * ## 三个子命令
 *
 *   --import            把书里所有 `*_审校标记.json` 转成台账事件（**幂等**，重复跑不会重复记账）
 *   --status            台账概览：多少条、按章/层/教师/来源分布、有没有坏行
 *   --replay <md 文件>  预演：这份台账放到**这一版**稿子上，能落上几条、几条找不到锚
 *
 * ## 纪律
 *
 * · 台账是 **append-only 正本**：只追加，不改写历史（与 decision.ts 同一条哲学）。
 * · 每条事件带 `source`：`human` = 教师在 App 点的，`ai` = 模型提的候选。**混在一起就再也分不出来了。**
 * · 找不到锚的事件**如实报**（`--replay` 会列出来），不许静默少给。
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';

const SHARED = await import('./LayerText_AF词表与词典.mjs');
const P = SHARED.loadProject();
const OUT_BASE = P.产物目录;
const LEDGER = join(OUT_BASE, '_运行', '校准台账.jsonl');
const CN = SHARED.chapterNames(P);

const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const arg = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const TEACHER = arg('--teacher', process.env.LAYERTEXT_TEACHER ?? process.env.USER ?? 'unknown');

/** 目录里所有标记文件（递归两层：章目录在产物目录下一层）。 */
function markFiles(root) {
  const out = [];
  if (!existsSync(root)) return out;
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      for (const f of readdirSync(p)) if (f.endsWith('_审校标记.json')) out.push(join(p, f));
    } else if (name.endsWith('_审校标记.json')) out.push(p);
  }
  return out;
}

/** 从标记文件路径推出范围：章 = 所在目录名（第一章），层 = 文件名里的 A层85/M层75/B层60。 */
function scopeOfPath(path) {
  const dir = dirname(path);
  const chapter = basename(dir);
  const file = basename(path).replace(/_审校标记\.json$/, '');
  const tier = file.match(/(A层85|M层75|B层60)/)?.[1] ?? '';
  const ok = CN.includes(chapter) && tier;
  return { chapter, tier, file, ok };
}

function readLines(path) {
  const map = new Map();
  if (!existsSync(path)) return map;
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t);
      if (e && e.id) map.set(e.id, e);
    } catch {
      /* 坏行在 --status 里单独报；这里只要 id 去重 */
    }
  }
  return map;
}

async function cmdImport() {
  const { makeCalibrationEvent, toCalibrationLine, parseCalibrationLog } = await import(`${SHARED.distOf(P.引擎目录)}/src/core/calibration.js`);
  const { bookKeyFromPath } = await import(`${SHARED.distOf(P.引擎目录)}/src/core/calibration.js`);
  /* 书键必须与 App 侧算出来的一致——App 拿不到项目 json 的 `书名`，所以两边统一按路径推。 */
  const BOOK = bookKeyFromPath(join(OUT_BASE, 'x', '第一章', 'x.md'));
  const known = readLines(LEDGER);
  const parsed = existsSync(LEDGER) ? parseCalibrationLog(readFileSync(LEDGER, 'utf-8')) : { events: [], bad: [] };
  const liveKeys = new Set(parsed.events.map((e) => e.id));

  let added = 0;
  let scanned = 0;
  const skipped = [];
  const files = markFiles(OUT_BASE);
  console.log(`════ AF 校准台账 · 导入 ════`);
  console.log(`书名：${P.书名 ?? '（未命名）'}｜扫到标记文件 ${files.length} 个｜台账现有 ${known.size} 条`);

  for (const f of files) {
    const sc = scopeOfPath(f);
    if (!sc.ok) {
      skipped.push(`${f}（认不出章/层）`);
      continue;
    }
    let review;
    try {
      review = JSON.parse(readFileSync(f, 'utf-8'));
    } catch (e) {
      skipped.push(`${f}（JSON 坏了：${String(e).slice(0, 40)}）`);
      continue;
    }
    const marks = Array.isArray(review?.marks) ? review.marks : [];
    scanned += marks.length;
    for (const m of marks) {
      const anchor = m?.word ?? m?.text;
      if (!anchor || !m?.type || !m?.level) {
        skipped.push(`${sc.chapter}/${basename(f)} 里一条标记缺 word/text/type/level`);
        continue;
      }
      let e;
      try {
        e = makeCalibrationEvent({
          teacher: TEACHER,
          book: BOOK,
          chapter: sc.chapter,
          tier: sc.tier,
          level: m.level,
          word: m.word,
          text: m.text,
          type: m.type,
          note: m.note,
          origin: m.origin,
          action: 'add',
          source: 'human',
          file: sc.file,
          ts: m.ts ? new Date(Number(m.ts)).toISOString() : new Date(statSync(f).mtimeMs).toISOString(),
        });
      } catch (err) {
        skipped.push(`${sc.chapter}/${m.word ?? m.text}：${String(err).slice(0, 50)}`);
        continue;
      }
      if (known.has(e.id) || liveKeys.has(e.id)) continue; // 幂等：同一条账只记一次
      known.set(e.id, e);
      liveKeys.add(e.id);
      appendFileSync(LEDGER, toCalibrationLine(e), 'utf-8');
      added += 1;
    }
  }
  mkdirSync(dirname(LEDGER), { recursive: true });
  console.log(`\n扫过标记 ${scanned} 条 → **新增台账事件 ${added} 条**（已有 ${known.size - added} 条不动，重复导入不会重复记账）`);
  if (skipped.length) {
    console.log(`\n⚠ 跳过 ${skipped.length} 处（不静默吞）：`);
    for (const s of skipped.slice(0, 20)) console.log(`  · ${s}`);
  }
  console.log(`\n台账：${LEDGER}`);
}

async function cmdStatus() {
  const { parseCalibrationLog, foldCalibrations } = await import(`${SHARED.distOf(P.引擎目录)}/src/core/calibration.js`);
  if (!existsSync(LEDGER)) {
    console.log(`台账还不存在：${LEDGER}\n先跑：node LayerText_AF校准台账.mjs --import`);
    return;
  }
  const { events, bad } = parseCalibrationLog(readFileSync(LEDGER, 'utf-8'));
  const live = foldCalibrations(events);
  const by = (f) => events.reduce((m, e) => ((m[f(e)] = (m[f(e)] ?? 0) + 1), m), {});
  console.log(`════ AF 校准台账 · 概览 ════`);
  console.log(`台账：${LEDGER}`);
  console.log(`事件 ${events.length} 条｜折叠后有效 ${live.size} 处｜坏行 ${bad.length}${bad.length ? `（首条：${bad[0].reason}）` : ''}`);
  console.log(
    `\n按来源：`,
    by((e) => e.source),
  );
  console.log(
    `按教师：`,
    by((e) => e.teacher),
  );
  console.log(
    `按层：  `,
    by((e) => e.tier),
  );
  const ch = by((e) => e.chapter);
  console.log(`\n按章（共 ${Object.keys(ch).length} 章）：`);
  for (const k of Object.keys(ch).sort()) console.log(`  ${k}：${ch[k]} 条`);
  const zero = CN.filter((c) => !ch[c]);
  if (zero.length) console.log(`\n⚠ 一条校准都没有的章：${zero.join('、')}——不是"没审"，是**没记账**（旧机制按文件名落盘，换版本就断）`);
}

async function cmdReplay() {
  const file = arg('--replay');
  if (!file || !existsSync(file)) {
    console.error('✗ --replay 需要一个存在的 md 文件');
    process.exit(2);
  }
  const { parseCalibrationLog, replayCalibrations, unmatchedVerdict, bookKeyFromPath } = await import(`${SHARED.distOf(P.引擎目录)}/src/core/calibration.js`);
  const BOOK = bookKeyFromPath(file);
  const sc = scopeOfPath(join(dirname(file), `${basename(file).replace(/\.md$/, '')}_审校标记.json`));
  if (!sc.ok) {
    console.error(`✗ 从路径认不出章/层：${file}`);
    process.exit(2);
  }
  const { events } = parseCalibrationLog(readFileSync(LEDGER, 'utf-8'));
  const md = readFileSync(file, 'utf-8');
  const r = replayCalibrations({ md, events, scope: { book: BOOK, chapter: sc.chapter, tier: sc.tier } });
  console.log(`════ 重放预演 ════`);
  console.log(`稿子：${basename(file)}（${sc.chapter} / ${sc.tier}）`);
  console.log(`台账里这一章这一层共有事件 ${events.filter((e) => e.chapter === sc.chapter && e.tier === sc.tier).length} 条`);
  console.log(`\n✅ 能落上 ${r.marks.length} 条；❌ 找不到锚 ${r.unmatched.length} 条`);
  for (const m of r.marks.slice(0, 15)) console.log(`  · ${m.word ?? m.text}（${m.type}）→ P${String(m.pi + 1).padStart(2, '0')} 第${m.si + 1}句 第${(m.wi ?? 0) + 1}词｜来源 ${m.source}`);
  if (r.unmatched.length) {
    /* ★ 分开报：待办类词不见了=**已办结**；保留类词不见了=**要看一眼**。
     *   糊在一起报，教师面对的就是一片"找不到锚"，分不清哪些是完成、哪些是事故。 */
    const done = r.unmatched.filter((e) => unmatchedVerdict(e).verdict === 'done');
    const check = r.unmatched.filter((e) => unmatchedVerdict(e).verdict === 'check');
    if (done.length) {
      console.log(`\n✅ 大概率**已办结** ${done.length} 条（标的是"该换掉"，词在新版里确实没了）：`);
      for (const e of done.slice(0, 15)) console.log(`  · ${e.word ?? e.text}（${e.type}，${e.ts.slice(0, 10)} 记于 ${e.file ?? '?'}）`);
    }
    if (check.length) {
      console.log(`\n⚠️ **要看一眼** ${check.length} 条（标的是"该留下/该标注"，词却没了）：`);
      for (const e of check.slice(0, 15)) console.log(`  · ${e.word ?? e.text}（${e.type}，${e.ts.slice(0, 10)} 记于 ${e.file ?? '?'}）`);
    }
  }
}

if (has('--import')) await cmdImport();
else if (has('--status')) await cmdStatus();
else if (has('--replay')) await cmdReplay();
else {
  console.log(`AF 校准台账

  node LayerText_AF校准台账.mjs --import             把 *_审校标记.json 搬进台账（幂等）
  node LayerText_AF校准台账.mjs --status             台账概览
  node LayerText_AF校准台账.mjs --replay <md 文件>   预演：台账能在这版稿子上落几条

  --teacher <名字>   教师身份（默认取 $USER；多教师并行时必填）
`);
}
