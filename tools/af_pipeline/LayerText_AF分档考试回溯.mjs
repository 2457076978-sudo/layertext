#!/usr/bin/env node
/**
 * LayerText · 分档 × 考试表现回溯（功能四项 · 项 4，2026-09-19）——论文证据线，仓外只读。
 *
 * 做什么：把三样现成数据接起来——
 *   ① 分档允许表 v0（良/中/优，AF知识文件/分档允许表_v0/）；
 *   ② 考试逐题答案（成绩数据库/试卷原卷与细目/平台侧_六次真实结构与逐题答案_*.json）；
 *   ③ 逐题 × 梯队得分（同目录 逐题_梯队得分_六次_*.json，值=[得分人数, 总人数]）；
 * 输出（考试 × 档 × 梯队）聚合表 + 人话判读 → `AF知识文件/分档×考试表现回溯_v0.md`。
 *
 * 红线（规划定案 4）：
 *   · 学生数据不进仓库、产物**零学生姓名**——输入本来就是梯队级聚合数，本脚本不碰个体数据；
 *   · 只读：对 成绩数据库 与 AF 产物目录零写，唯一写出=AF知识文件 下的新报告；
 *   · 措辞纪律：报告带引擎 EXAM_DISCLAIMER（exposure≠acquisition、回溯相关不构成因果）。
 *
 * 用法（两个环境变量缺一 exit 2）：
 *   LAYERTEXT_AF_DIR=<AF>/调适工作区 LAYERTEXT_EXAM_DIR=<成绩数据库>/试卷原卷与细目 \
 *     node tools/af_pipeline/LayerText_AF分档考试回溯.mjs
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SHARED = await import('./LayerText_AF词表与词典.mjs');
const { distOf } = SHARED;
/* join 纯函数唯一实现：src/core/tierexam.ts（本脚本只做 IO 与渲染，join 一个不自算） */
const { examWordsOf, aggregateByBand, baselineRates, bandVerdict, EXAM_DISCLAIMER } = await import(`${distOf()}/src/core/tierexam.js`);

const AF_WS = process.env.LAYERTEXT_AF_DIR;
const EXAM_DIR = process.env.LAYERTEXT_EXAM_DIR;
if (!AF_WS || !EXAM_DIR) {
  console.error('需要 LAYERTEXT_AF_DIR=<AF项目>/调适工作区 与 LAYERTEXT_EXAM_DIR=<成绩数据库>/试卷原卷与细目。用法：');
  console.error('  LAYERTEXT_AF_DIR=/path/to/名著阅读工作区_AnimalFarm/调适工作区 LAYERTEXT_EXAM_DIR=/path/to/成绩数据库/试卷原卷与细目 node tools/af_pipeline/LayerText_AF分档考试回溯.mjs');
  process.exit(2);
}
const AF = dirname(AF_WS);
const KV = join(AF, '知识文件');
const 分档表目录 = join(KV, '分档允许表_v0');
if (!existsSync(分档表目录)) {
  console.error(`✗ 找不到分档允许表目录：${分档表目录}`);
  process.exit(2);
}

/* 允许表：首列=词（BOM/表头宽容） */
const loadBandSet = (band) =>
  new Set(
    readFileSync(join(分档表目录, `允许表_${band}.csv`), 'utf8')
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .slice(1)
      .filter((l) => l.trim())
      .map((l) => l.split(',')[0].trim().toLowerCase())
      .filter(Boolean),
  );
const tables = { 良: loadBandSet('良'), 中: loadBandSet('中'), 优: loadBandSet('优') };
console.log(`分档允许表：良 ${tables.良.size} / 中 ${tables.中.size} / 优 ${tables.优.size} 词`);

/* 平台侧逐题答案 + 逐题×梯队得分 */
const platform = JSON.parse(readFileSync(join(EXAM_DIR, '平台侧_六次真实结构与逐题答案_20260907.json'), 'utf8'));
const perItem = JSON.parse(readFileSync(join(EXAM_DIR, '逐题_梯队得分_六次_20260907.json'), 'utf8'));
/* 考试映射：平台侧键 → 逐题中文前缀（六次真实数据实测口径；映射外的考试跳过并点名） */
const EXAMS = [
  { key: 'E3', cn: '区统练', label: 'E3 期末区统考（真卷逐题细目）' },
  { key: 'E5', cn: '八下期中', label: 'E5 期中大练习' },
  { key: 'E6', cn: '八下模拟', label: 'E6 期末模拟' },
];

/** 平台侧表格 → 逐题 {no, answer}：表头行含「题目」与「答案」两列；题目列非纯数字的行（节标题/合计）跳过 */
function parsePlatform(rows) {
  const hdr = rows.findIndex((r) => r.includes('题目') && r.includes('答案'));
  if (hdr < 0) return [];
  const qi = rows[hdr].indexOf('题目');
  const ai = rows[hdr].indexOf('答案');
  const out = [];
  for (const r of rows.slice(hdr + 1)) {
    const no = Number(String(r[qi] ?? '').trim());
    if (!Number.isInteger(no) || no < 1) continue;
    out.push({ no, answer: String(r[ai] ?? '') });
  }
  return out;
}

const report = [];
report.push('# 分档 × 考试表现回溯（v0）', '', EXAM_DISCLAIMER, '');
report.push(`生成：2026-09-19 ｜ 数据：平台侧逐题答案 + 逐题×梯队得分（六次真实数据，梯队级聚合）｜ 分档：允许表 v0（良 ${tables.良.size}/中 ${tables.中.size}/优 ${tables.优.size} 词）`, '');

for (const ex of EXAMS) {
  const rows = platform[ex.key];
  if (!Array.isArray(rows)) {
    report.push(`## ${ex.label}`, '', `平台侧没有 ${ex.key} 的导出——跳过（点名，不静默）。`, '');
    console.log(`⚠ ${ex.label}：平台侧无导出，跳过`);
    continue;
  }
  const items = parsePlatform(rows);
  const joined = items
    .map(({ no, answer }) => {
      const rates = {};
      let missTier = 0;
      for (const t of ['A', 'M', 'B']) {
        const v = perItem[`${ex.cn}|${no}|${t}`];
        if (Array.isArray(v) && v[1] > 0) rates[t] = v[0] / v[1];
        else missTier++;
      }
      return { no, words: examWordsOf(answer), rates, missTier };
    })
    .filter((it) => Object.keys(it.rates).length > 0);
  const noTier = items.length - joined.length;
  const aggs = aggregateByBand(
    joined.map(({ words, rates }) => ({ words, rates })),
    tables,
  );
  const base = baselineRates(joined.map(({ words, rates }) => ({ words, rates })));
  const pct = (x) => (x === undefined ? '—' : `${(x * 100).toFixed(1)}%`);
  report.push(`## ${ex.label}`, '');
  report.push(
    `逐题 ${items.length} 题（接入梯队数据 ${joined.length} 题${noTier > 0 ? `；${noTier} 题无梯队数据未进聚合` : ''}）｜全卷基线：A ${pct(base.A)} / M ${pct(base.M)} / B ${pct(base.B)}`,
    '',
  );
  report.push('| 档 | 题数 | A 层均得 | M 层均得 | B 层均得 | 涉及词示例 |', '|---|---|---|---|---|---|');
  for (const a of aggs) {
    report.push(
      `| ${a.band} | ${a.items} | ${a.tierRates.A ? `${pct(a.tierRates.A.mean)}（n=${a.tierRates.A.n}）` : '—'} | ${a.tierRates.M ? `${pct(a.tierRates.M.mean)}（n=${a.tierRates.M.n}）` : '—'} | ${a.tierRates.B ? `${pct(a.tierRates.B.mean)}（n=${a.tierRates.B.n}）` : '—'} | ${a.words.slice(0, 8).join(' ')}${a.words.length > 8 ? '…' : ''} |`,
    );
  }
  report.push('', `**判读**：${bandVerdict(aggs, base)}`, '');
  console.log(`${ex.label}：${items.length} 题 / ${joined.length} 接入；${bandVerdict(aggs, base)}`);
}

report.push(
  '## 读法与边界',
  '',
  '- 一题的词可命中多档（良⊂中⊂优包含结构），各档分别计数——题数之和可大于总题数；',
  '- 「词表外」=答案词不在任何一档允许表（含 hitOrigin 归并后），多为功能词/超纲扩展外的新词；',
  '- 得分率为梯队级聚合（逐题 [得分人数/总人数] 的平均），无学生个体数据；',
  '- **下一步用法**：某档词的题在某梯队持续大幅低于基线 → 该档配层的词选或复现安排的调整线索（仍需教学判断）。',
  '',
);

const outPath = join(KV, '分档×考试表现回溯_v0.md');
writeFileSync(outPath, report.join('\n'), 'utf8');
console.log(`\n报告已写：${outPath}`);
